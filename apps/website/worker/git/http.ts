import { Hono, type Context } from "hono";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { forgetUpstreamTokens, upstreamToken } from "../artifacts.ts";
import { onPush } from "../ci/trigger.ts";
import { queueMirror } from "../mirror/queue.ts";
import { findRepo, roleFor, sqlNow } from "../db.ts";
import { notifyReleaseNotes } from "../release-notes/queue.ts";
import { notifyKnowledge } from "../knowledge/coordinator.ts";
import { invalidateRefs } from "../objects.ts";
import { atLeast } from "../permissions.ts";
import { db } from "../schema.ts";

// Git smart HTTP: https://git-scm.com/docs/http-protocol
//   GET  /:owner/:repo.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /:owner/:repo.git/git-upload-pack    (clone, fetch)
//   POST /:owner/:repo.git/git-receive-pack   (push)
// Each request is authorized here, then streamed to the repository's
// Artifacts remote with a short-lived repo token the client never sees.

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

async function proxy(c: Context<AppEnv>, service: Service, endpoint: string) {
  const owner = c.req.param("owner") ?? "";
  const name = (c.req.param("repo") ?? "").replace(/\.git$/, "");
  const needed = service === "git-receive-pack" ? "write" : "read";

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

  const headers = new Headers();
  for (const header of FORWARDED_REQUEST_HEADERS) {
    const value = c.req.header(header);
    if (value) headers.set(header, value);
  }
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
      body: c.req.method === "POST" ? c.req.raw.body : undefined,
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
    return c.text("The storage backend refused this request.\n", 502);
  }

  if (credential.kind === "token") {
    c.executionCtx.waitUntil(
      db(c.env.DB)
        .updateTable("access_tokens")
        .set({ last_used_at: sqlNow })
        .where("id", "=", credential.tokenId)
        .execute(),
    );
  }
  if (service === "git-receive-pack" && endpoint !== "info/refs" && upstream.ok) {
    invalidateRefs(repo.artifacts_name);
    c.executionCtx.waitUntil(notifyKnowledge(c.env, repo.id));
    c.executionCtx.waitUntil(
      notifyReleaseNotes(c.env, repo.id).catch((error) =>
        console.error("Release notes: enqueue failed", error),
      ),
    );
    c.executionCtx.waitUntil(
      queueMirror(c.env, repo.id).catch((error) => console.error("Mirror: enqueue failed", error)),
    );
    c.executionCtx.waitUntil(
      onPush(c.env, repo, actor, (work) => c.executionCtx.waitUntil(work)).catch((error) =>
        console.error("CI: push trigger failed", error),
      ),
    );
    c.executionCtx.waitUntil(
      db(c.env.DB)
        .updateTable("repos")
        .set({ pushed_at: sqlNow })
        .where("id", "=", repo.id)
        .execute(),
    );
  }

  const responseHeaders = new Headers();
  for (const header of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
