import { Hono, type Context } from "hono";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { forgetUpstreamTokens, upstreamToken } from "../artifacts.ts";
import { landingJob } from "../ci/landing.ts";
import { findRepo, roleFor, sqlNow } from "../db.ts";
import { jobSecret } from "../deployments/job.ts";
import { invalidateRefs } from "../objects.ts";
import { atLeast } from "../permissions.ts";
import { db } from "../schema.ts";
import { landingBranch } from "../../shared/timelines.ts";
import { afterPush } from "./effects.ts";
import { readReceivePackCommands, type ReceiveCommand } from "./receive-pack.ts";

// Git smart HTTP: https://git-scm.com/docs/http-protocol
//   GET  /:owner/:repo.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /:owner/:repo.git/git-upload-pack    (clone, fetch)
//   POST /:owner/:repo.git/git-receive-pack   (push)
// Each request is authorized here, then streamed to the repository's
// Artifacts remote with a short-lived repo token the client never sees.
// Personal and agent tokens (gmx_…) act as their account; a CI job's
// credential (gmj_…) only as a landing's merge job (landingProxy).

type Service = "git-upload-pack" | "git-receive-pack";

const SERVICES = new Set<string>(["git-upload-pack", "git-receive-pack"]);
const FORWARDED_REQUEST_HEADERS = ["content-type", "content-encoding", "accept", "git-protocol"];
const FORWARDED_RESPONSE_HEADERS = ["content-type", "cache-control", "expires", "pragma"];

export const gitHttp = new Hono<AppEnv>();

gitHttp.get("/:owner/:repo{[^/]+\\.git}/info/refs", async (c) => {
  const service = c.req.query("service");
  if (!service || !SERVICES.has(service)) {
    // The "dumb" protocol is not offered.
    return c.text("Only smart HTTP is supported; upgrade git.\n", 403);
  }
  return proxy(c, service as Service, "info/refs");
});

gitHttp.post("/:owner/:repo{[^/]+\\.git}/:service{git-(?:upload|receive)-pack}", (c) => {
  const service = c.req.param("service") as Service;
  return proxy(c, service, service);
});

function challenge(message: string) {
  return new Response(message, {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="gitmatrix"', "content-type": "text/plain" },
  });
}

type UpstreamRepo = { artifacts_name: string; artifacts_remote: string };

async function proxy(c: Context<AppEnv>, service: Service, endpoint: string) {
  const owner = c.req.param("owner") ?? "";
  const name = (c.req.param("repo") ?? "").replace(/\.git$/, "");
  const needed = service === "git-receive-pack" ? "write" : "read";

  // A CI job's credential: only a landing's merge job, scoped to its landing branch.
  const jobToken = jobSecret(c.req.header("authorization"));
  if (jobToken) return landingProxy(c, service, endpoint, owner, name, jobToken);

  const credential = await tokenCredential(c);
  if (credential.kind === "invalid") {
    return challenge("Invalid credentials. Use a personal access token as the password.\n");
  }
  const actor = credential.kind === "token" ? credential.actor : null;
  const repo = await findRepo(c.env.DB, actor, owner, name);
  const role = repo ? roleFor(repo, actor) : "none";

  if (!repo || !atLeast(role, "read")) {
    // Ask anonymous clients for credentials; tell signed-in ones nothing exists.
    return actor ? c.text("Repository not found.\n", 404) : challenge("Authentication required.\n");
  }
  if (!atLeast(role, needed)) {
    return actor
      ? c.text(`${actor.slug} does not have write access to ${owner}/${name}.\n`, 403)
      : challenge("Authentication required to push.\n");
  }
  if (needed === "write" && credential.kind === "token" && credential.scope !== "write") {
    return c.text("This token is read-only. Create a token with write scope to push.\n", 403);
  }

  const upstream = await forward(c, repo, service, endpoint, c.req.raw.body);
  if (upstream instanceof Response) {
    if (credential.kind === "token") {
      c.executionCtx.waitUntil(
        db(c.env.DB)
          .updateTable("access_tokens")
          .set({ last_used_at: sqlNow })
          .where("id", "=", credential.tokenId)
          .execute(),
      );
    }
    if (service === "git-receive-pack" && endpoint !== "info/refs" && upstream.ok)
      afterPush(c.env, repo, actor, (work) => c.executionCtx.waitUntil(work));
  }
  return respond(upstream);
}

/**
 * A landing's merge job (ci/landing.ts), with its own credential: it reads
 * its repository, and its pushes may update only
 * refs/heads/gitmatrix/landing/<its slug>, each command checked before the
 * pack streams on (CORE-157). Nothing else takes a job credential here.
 */
async function landingProxy(
  c: Context<AppEnv>,
  service: Service,
  endpoint: string,
  owner: string,
  name: string,
  secret: string,
) {
  const access = await landingJob(c.env.DB, secret, owner, name);
  if (!access.ok) return c.text(`${access.error}\n`, access.status);
  if (service === "git-upload-pack" || endpoint === "info/refs")
    return respond(await forward(c, access.repo, service, endpoint, c.req.raw.body));

  const encoding = c.req.header("content-encoding")?.toLowerCase();
  if (encoding && encoding !== "gzip" && encoding !== "identity")
    return c.text(`Unsupported content encoding ${encoding}.\n`, 415);
  let stream = c.req.raw.body ?? new Response("").body!;
  if (encoding === "gzip")
    stream = stream.pipeThrough(
      new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  let request: Awaited<ReturnType<typeof readReceivePackCommands>>;
  try {
    request = await readReceivePackCommands(stream);
  } catch (error) {
    return c.text(`Couldn't read the push: ${(error as Error).message}.\n`, 400);
  }
  const refusal = landingPushRefusal(request, access.slug);
  if (refusal) {
    await request.body.cancel().catch(() => {});
    return c.text(`${refusal}\n`, 403);
  }
  // The body goes on decompressed, so without its encoding.
  const upstream = await forward(c, access.repo, service, endpoint, request.body, true);
  // Like the Worker's own ref writes (timelines/bookmarks.ts): a landing branch
  // is the landing's, so what follows a push (git/effects.ts) doesn't.
  if (upstream instanceof Response && upstream.ok) invalidateRefs(access.repo.artifacts_name);
  return respond(upstream);
}

/** Why a landing's merge job may not make this push, or null when it may. */
export function landingPushRefusal(
  request: { commands: ReceiveCommand[]; pushCert: boolean },
  slug: string,
): string | null {
  const allowed = `refs/heads/${landingBranch(slug)}`;
  if (request.pushCert) return "A landing's merge job can't make a signed push.";
  if (request.commands.length > 1)
    return `A landing's merge job pushes one ref, ${allowed}; this push updates ${request.commands.length}.`;
  const command = request.commands[0];
  if (!command) return null; // git's empty probe before a large push
  if (command.ref !== allowed)
    return `A landing's merge job may push only to ${allowed}, not ${command.ref}.`;
  if (/^0+$/.test(command.new)) return `A landing's merge job can't delete ${allowed}.`;
  return null;
}

/**
 * Send a request on to the repository's Artifacts remote with a short-lived
 * token, or answer 502 when Artifacts refuses the token itself.
 */
async function forward(
  c: Context<AppEnv>,
  repo: UpstreamRepo,
  service: Service,
  endpoint: string,
  body: ReadableStream<Uint8Array> | null,
  decoded = false,
): Promise<Response | { refused: Response }> {
  const needed = service === "git-receive-pack" ? "write" : "read";
  const headers = new Headers();
  for (const header of FORWARDED_REQUEST_HEADERS) {
    const value = c.req.header(header);
    if (value) headers.set(header, value);
  }
  if (decoded) headers.delete("content-encoding");
  // Artifacts only speaks protocol v2 for fetches; a v2 header on a push makes it
  // advertise v2 capabilities the client cannot use for receive-pack.
  if (service === "git-receive-pack") headers.delete("git-protocol");

  const upstreamUrl = new URL(`${repo.artifacts_remote}/${endpoint}`);
  if (endpoint === "info/refs") upstreamUrl.searchParams.set("service", service);

  const send = async () => {
    headers.set(
      "authorization",
      `Bearer ${await upstreamToken(c.env, repo.artifacts_name, needed)}`,
    );
    return fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body: c.req.method === "POST" ? body : undefined,
    });
  };

  let upstream = await send();
  if ((upstream.status === 401 || upstream.status === 403) && c.req.method === "GET") {
    // A cached token may have been revoked; mint a fresh one and retry once.
    // (POST bodies are streams and cannot be replayed.)
    forgetUpstreamTokens(repo.artifacts_name);
    upstream = await send();
  }
  if (upstream.status === 401 || upstream.status === 403) {
    console.error("Artifacts rejected the proxy's token", {
      repo: repo.artifacts_name,
      status: upstream.status,
    });
    return { refused: c.text("The storage backend refused this request.\n", 502) };
  }
  return upstream;
}

function respond(upstream: Response | { refused: Response }) {
  if (!(upstream instanceof Response)) return upstream.refused;
  const responseHeaders = new Headers();
  for (const header of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
