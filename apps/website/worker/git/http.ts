import { Hono, type Context } from "hono";
import { sql } from "kysely";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { forgetUpstreamTokens, upstreamToken } from "../artifacts.ts";
import { landingJob } from "../ci/landing.ts";
import { queueMergeJob } from "../ci/queue-auth.ts";
import { findRepo, roleFor, sqlNow } from "../db.ts";
import { jobSecret } from "../deployments/job.ts";
import { invalidateRefs } from "../objects.ts";
import { atLeast } from "../permissions.ts";
import { db } from "../schema.ts";
import { landingBranch } from "../../shared/timelines.ts";
import { isQueueSourceBranch } from "../../shared/merge-queue.ts";
import { afterPush } from "./effects.ts";
import { recordPush } from "../ref-log/record.ts";
import { readReceivePackCommands, receivePackReport, type ReceiveCommand } from "./receive-pack.ts";
import { resolveSource, getWorkSource, workGitPath } from "../timelines/sources.ts";
import { trackerObject } from "../tracker/stub.ts";
import { retainProgress, reconcileSourcePushes } from "./source-push.ts";
import { sourcePushFixtureBoundary } from "./source-push-fixture.ts";
import { lsRefs } from "../artifacts.ts";
import { jobCaller } from "../deployments/job.ts";
import { ciSource } from "../ci/source.ts";
import type { Actor, RepoRow } from "../db.ts";
import { uploadCommand, workAdvertisement, protocolBytes } from "./source-protocol.ts";
import { pkt, FLUSH } from "./pktline.ts";
import { TrackerError } from "../tracker/store.ts";
import { errorDetails } from "../api/http.ts";

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
gitHttp.onError((error, c) => {
  if (error instanceof TrackerError) return c.text(`${error.message}\n`, error.status);
  // Provider exceptions may contain private remotes or credentials: log only
  // their scrubbed kind and message, enough to tell what failed (CORE-308).
  console.error(`Git storage request failed: ${scrubbedError(error)}`);
  return c.text("Storage operation failed.\n", 500);
});

/** An error's name and message without URLs or anything shaped like a credential. */
export function scrubbedError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[url]")
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, "[redacted]")
    .slice(0, 300);
}

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
  const address = (c.req.param("repo") ?? "").replace(/\.git$/, "");
  const separator = address.indexOf("@");
  const name = separator < 0 ? address : address.slice(0, separator);
  const timelineSlug = separator < 0 ? null : address.slice(separator + 1);
  if (
    timelineSlug !== null &&
    (timelineSlug === "main" ||
      timelineSlug.length > 64 ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(timelineSlug))
  )
    return c.text("Repository not found.\n", 404);
  const needed = service === "git-receive-pack" ? "write" : "read";

  // A CI job's credential: only a landing's merge job, scoped to its landing branch.
  const jobToken = jobSecret(c.req.header("authorization"));
  if (jobToken) {
    if (timelineSlug !== null) {
      const job = await jobCaller(c.env.DB, jobToken);
      if (!job || job.sourceId === "canonical" || service !== "git-upload-pack")
        return c.text("This job cannot access this source.\n", 403);
      const source = await getWorkSource(c.env, job.repoId, job.sourceId);
      if (!source || source.timeline_slug !== timelineSlug)
        return c.text("This job cannot access this source.\n", 403);
      const resolved = await ciSource(c.env, job.repoId, job.sourceId, { runId: job.runId });
      if (resolved.owner_slug !== owner || resolved.name !== name)
        return c.text("Repository not found.\n", 404);
      return workRead(c, resolved, service, endpoint);
    }
    return landingProxy(c, service, endpoint, owner, name, jobToken);
  }

  const credential = await tokenCredential(c);
  if (credential.kind === "invalid") {
    return challenge("Invalid credentials. Use a personal access token as the password.\n");
  }
  const actor = credential.kind === "token" ? credential.actor : null;
  const repo =
    (await findRepo(c.env.DB, actor, owner, name)) ??
    (service === "git-upload-pack" && actor
      ? await teardownCheckout(c.env.DB, actor, owner, name)
      : null);
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
  if (timelineSlug !== null) {
    const source = await db(c.env.DB)
      .selectFrom("timeline_work_sources")
      .selectAll()
      .where("repo_id", "=", repo.id)
      .where("owner_id", "=", repo.owner_id)
      .where("timeline_slug", "=", timelineSlug)
      .executeTakeFirst();
    if (!source) return c.text("Timeline work source not found; migrate legacy work first.\n", 404);
    const resolved = await resolveSource(c.env, repo, source.source_id);
    if (service === "git-upload-pack") return workRead(c, resolved.repo, service, endpoint);
    if (source.state !== "ready")
      return c.text("This source is read-only; select a new timeline or main.\n", 409);
    if (endpoint === "info/refs") return workRead(c, resolved.repo, service, endpoint);
    return workPush(c, resolved.repo, source.timeline_id, actor!);
  }

  // Inspect only a bounded command prefix while the original body streams upstream.
  // Signed pushes keep ordinary effects; queue source-only pushes stage objects.
  let body = c.req.raw.body;
  let sourceOnly = Promise.resolve(false);
  if (service === "git-receive-pack" && c.req.method === "POST" && body) {
    const encoding = c.req.header("content-encoding")?.toLowerCase();
    if (encoding && encoding !== "identity" && encoding !== "gzip")
      return c.text("Unsupported content encoding.\n", 415);
    if (!encoding || encoding === "identity" || encoding === "gzip") {
      const [forwarded, inspection] = body.tee();
      body = forwarded;
      const inspected =
        encoding === "gzip"
          ? inspection.pipeThrough(
              new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>,
            )
          : inspection;
      const request = await readReceivePackCommands(inspected);
      void request.body.cancel().catch(() => {});
      for (const command of request.commands) {
        const match = /^refs\/heads\/timeline\/(.+)$/.exec(command.ref);
        if (!match) continue;
        void body.cancel().catch(() => {});
        return c.text(
          `Canonical timeline branches are read-only; use ${new URL(c.req.url).origin}${workGitPath(repo, match[1]!)} instead. Legacy timelines must be migrated first.\n`,
          409,
        );
      }
      sourceOnly = Promise.resolve(
        !request.pushCert &&
          request.commands.length > 0 &&
          request.commands.every(
            (command) =>
              command.ref.startsWith("refs/heads/") &&
              isQueueSourceBranch(command.ref.slice("refs/heads/".length)),
          ),
      );
    }
  }
  const pack =
    service === "git-receive-pack" && c.req.method === "POST" && body
      ? meterPack(body, c.req.header("content-length"))
      : null;
  const upstream = await forward(c, repo, service, endpoint, pack?.body ?? body);
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
    if (service === "git-receive-pack" && endpoint !== "info/refs" && upstream.ok) {
      const finishPush = async () => {
        if (!(await sourceOnly))
          afterPush(c.env, repo, actor, (work) => c.executionCtx.waitUntil(work));
        else {
          invalidateRefs(repo.artifacts_name);
          // Staging skips CI/AI/preview work, not provenance. Finish this bounded
          // metadata read before the CLI uploads context for the staged commits.
          await recordPush(c.env, repo, actor).catch((error) =>
            console.error("Queue source push log: recording failed", errorDetails(error)),
          );
        }
      };
      if (pack) c.executionCtx.waitUntil(recordPushedBytes(c.env, repo.id, pack.done));
      if (upstream.body) {
        // Headers can precede the ref transaction. Keep the response streaming,
        // but hold its final EOF until source-stage provenance has been recorded.
        const { readable, writable } = new TransformStream<Uint8Array>();
        c.executionCtx.waitUntil(
          upstream.body.pipeTo(writable, { preventClose: true }).then(async () => {
            try {
              await finishPush();
            } finally {
              await writable.close();
            }
          }),
        );
        return respond(upstream, readable);
      }
      await finishPush();
    }
  }
  return respond(upstream);
}

async function workRead(c: Context<AppEnv>, repo: RepoRow, service: Service, endpoint: string) {
  const ref = `refs/heads/${repo.default_branch}`;
  if (endpoint === "info/refs") {
    const response = respond(await forward(c, repo, service, endpoint, null));
    if (!response.ok) return response;
    const tip = (await lsRefs(c.env, repo.artifacts_name, repo.artifacts_remote, [ref])).find(
      (entry) => entry.name === ref,
    )?.oid;
    if (!tip) return c.text("Source work ref is unavailable.\n", 409);
    return new Response(workAdvertisement(await protocolBytes(response), tip, ref), {
      status: response.status,
      headers: response.headers,
    });
  }
  if (!c.req.raw.body) return c.text("Git request body is required.\n", 400);
  const encoding = c.req.header("content-encoding")?.toLowerCase();
  if (encoding && encoding !== "identity" && encoding !== "gzip")
    return c.text("Unsupported content encoding.\n", 415);
  const body =
    encoding === "gzip"
      ? c.req.raw.body.pipeThrough(
          new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>,
        )
      : c.req.raw.body;
  const request = await uploadCommand(body);
  if (request.command === "command=ls-refs") {
    void request.body.cancel().catch(() => {});
    const tip = (await lsRefs(c.env, repo.artifacts_name, repo.artifacts_remote, [ref])).find(
      (entry) => entry.name === ref,
    )?.oid;
    if (!tip) return c.text("Source work ref is unavailable.\n", 409);
    return new Response(
      pkt(`${tip} HEAD symref-target:${ref}\n`) + pkt(`${tip} ${ref}\n`) + FLUSH,
      {
        headers: {
          "content-type": "application/x-git-upload-pack-result",
          "cache-control": "no-cache",
        },
      },
    );
  }
  return respond(await forward(c, repo, service, endpoint, request.body, encoding === "gzip"));
}

async function workPush(
  c: Context<AppEnv>,
  repo: RepoRow & { source_id: string },
  timelineId: string,
  actor: Actor,
) {
  const encoding = c.req.header("content-encoding")?.toLowerCase();
  if (encoding && encoding !== "identity" && encoding !== "gzip")
    return c.text("Unsupported content encoding.\n", 415);
  let body = c.req.raw.body ?? new Response("").body!;
  if (encoding === "gzip")
    body = body.pipeThrough(
      new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  const request = await readReceivePackCommands(body);
  if (
    request.pushCert ||
    request.commands.length > 1 ||
    request.commands.some(
      (command) => command.ref !== "refs/heads/work" || /^0+$/.test(command.new),
    )
  ) {
    void request.body.cancel();
    return c.text("Work pushes may only update refs/heads/work.\n", 403);
  }
  if (!request.commands.length)
    return respond(
      await forward(c, repo, "git-receive-pack", "git-receive-pack", request.body, true),
    );
  const operationId = crypto.randomUUID();
  const tracker = trackerObject(c.env, repo.owner_id);
  if ((await reconcileSourcePushes(c.env, repo.id, repo.source_id)).length) {
    await recordPush(c.env, repo, null);
    afterPush(c.env, repo, null, (work) => c.executionCtx.waitUntil(work));
  }
  const commands = request.commands.map((command) => ({
    ...command,
    old: /^0+$/.test(command.old) ? null : command.old,
    new: command.new,
  }));
  const admitted = await tracker.beginSourcePush({
    operationId,
    timelineId,
    repoId: repo.id,
    sourceId: repo.source_id,
    commands,
    actorId: actor.agent?.id ?? actor.id,
    accountableId: actor.id,
  });
  if (!admitted.ok) {
    void request.body.cancel();
    return c.text(`${admitted.error}\n`, admitted.status);
  }
  let forwarding = false;
  try {
    for (const command of commands)
      if (command.old) await retainProgress(c.env, repo, operationId, command.old);
    const upstream = await forward(
      c,
      repo,
      "git-receive-pack",
      "git-receive-pack",
      request.body,
      true,
      async () => {
        await sourcePushFixtureBoundary(
          c.env,
          repo.id,
          repo.source_id,
          operationId,
          "before-provider",
        );
        forwarding = true;
        await sourcePushFixtureBoundary(
          c.env,
          repo.id,
          repo.source_id,
          operationId,
          "before-forward",
        );
      },
    );
    // Consume the response before checking durable state. A 200 is not a Git acknowledgement.
    const response = respond(upstream);
    const bytes = await protocolBytes(response);
    if (!response.ok) throw new Error("Ambiguous source push HTTP outcome.");
    const report = receivePackReport(bytes, request);
    const refs = await lsRefs(c.env, repo.artifacts_name, repo.artifacts_remote, [
      "refs/heads/work",
    ]);
    const tip = refs.find((ref) => ref.name === "refs/heads/work")?.oid;
    const accepted = commands.every(
      (command) => report.get(command.ref) === "ok" && command.new === tip,
    );
    const rejected = commands.every(
      (command) => report.get(command.ref) === "ng" && command.old === (tip ?? null),
    );
    if (!accepted && !rejected) throw new Error("Ambiguous source push outcome.");
    if (accepted) {
      await sourcePushFixtureBoundary(
        c.env,
        repo.id,
        repo.source_id,
        operationId,
        "after-provider",
      );
      for (const command of commands) await retainProgress(c.env, repo, operationId, command.new);
      await recordPush(c.env, repo, actor);
    }
    const finished = await tracker.finishSourcePush(
      operationId,
      accepted ? "accepted" : "rejected",
    );
    if (!finished.ok) throw new Error(finished.error);
    if (accepted) afterPush(c.env, repo, actor, (work) => c.executionCtx.waitUntil(work));
    return new Response(bytes, { status: response.status, headers: response.headers });
  } catch (error) {
    await tracker.finishSourcePush(operationId, forwarding ? "ambiguous" : "rejected");
    throw error;
  }
}

/**
 * A repository being deleted is missing to everyone (CORE-199) except a local
 * runner checking out its preview teardown: the purge waits for that run
 * before the repository goes. Only the runner's person, holding write access,
 * while one of their runners has such a job running, and only to read.
 */
async function teardownCheckout(
  d1: D1Database,
  actor: NonNullable<Parameters<typeof findRepo>[1]>,
  owner: string,
  name: string,
) {
  const repo = await findRepo(d1, actor, owner, name, { deleting: true });
  if (!repo?.deleted_at || !atLeast(roleFor(repo, actor), "write")) return null;
  const running = await db(d1)
    .selectFrom("ci_jobs as j")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .select("j.id")
    .where("j.repo_id", "=", repo.id)
    .where("j.runner", "=", "local")
    .where("j.status", "=", "running")
    .where(sql<string>`substr(j.claimed_by, 1, ${actor.slug.length + 1})`, "=", `${actor.slug}/`)
    .where("r.preview_action", "=", "teardown")
    .executeTakeFirst();
  return running ? repo : null;
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
  const landing = await landingJob(c.env.DB, secret, owner, name);
  const access = landing.ok ? landing : await queueMergeJob(c.env.DB, secret, owner, name);
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
  const refusal =
    "slug" in access
      ? landingPushRefusal(request, access.slug)
      : queuePushRefusal(request, access.branch);
  if (refusal) {
    await request.body.cancel().catch(() => {});
    return c.text(`${refusal}\n`, 403);
  }
  if (!("slug" in access)) {
    const current = await queueMergeJob(c.env.DB, secret, owner, name, access.queueId);
    if (!current.ok || current.runId !== access.runId || current.attempt !== access.attempt) {
      await request.body.cancel().catch(() => {});
      return c.text("This queue merge attempt is no longer current.\n", 403);
    }
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

/** Queue credentials may publish only their current attempt's candidate. */
export function queuePushRefusal(
  request: { commands: ReceiveCommand[]; pushCert: boolean },
  branch: string,
): string | null {
  const allowed = `refs/heads/${branch}`;
  if (request.pushCert) return "A queue merge job can't make a signed push.";
  if (request.commands.length > 1)
    return `A queue merge job pushes one ref, ${allowed}; this push updates ${request.commands.length}.`;
  const command = request.commands[0];
  if (!command) return null; // git's empty probe before a large push
  if (command.ref !== allowed)
    return `A queue merge job may push only to ${allowed}, not ${command.ref}.`;
  if (/^0+$/.test(command.new)) return `A queue merge job can't delete ${allowed}.`;
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
  onForward?: () => Promise<void>,
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
    // Token acquisition cannot write the ref; fetch invocation can.
    await onForward?.();
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
      status: upstream.status,
    });
    return { refused: c.text("The storage backend refused this request.\n", 502) };
  }
  return upstream;
}

function respond(upstream: Response | { refused: Response }, body?: ReadableStream<Uint8Array>) {
  if (!(upstream instanceof Response)) return upstream.refused;
  const responseHeaders = new Headers();
  for (const header of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(header);
    if (value) responseHeaders.set(header, value);
  }
  return new Response(body ?? upstream.body, { status: upstream.status, headers: responseHeaders });
}

/**
 * A push body and its size: one of known length goes on untouched (and is
 * that long); a chunked one is counted as it streams through.
 */
function meterPack(body: ReadableStream<Uint8Array>, contentLength: string | undefined) {
  const length = Number(contentLength ?? Number.NaN);
  if (Number.isSafeInteger(length) && length >= 0) return { body, done: Promise.resolve(length) };
  return countBytes(body);
}

/** The stream, passed through unchanged, and its byte count once it ends. */
function countBytes(body: ReadableStream<Uint8Array>) {
  let bytes = 0;
  const { promise: done, resolve } = Promise.withResolvers<number>();
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      resolve(bytes);
    },
  });
  return { body: body.pipeThrough(counter), done };
}

/** Add a push's pack bytes to its repository (never fails the push). */
async function recordPushedBytes(env: Env, repoId: string, done: Promise<number>) {
  try {
    // A pack the client abandoned never ends; don't wait on it for long.
    const bytes = await Promise.race([
      done,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000)),
    ]);
    if (!bytes) return;
    await db(env.DB)
      .updateTable("repos")
      .set((eb) => ({ pushed_bytes: eb("pushed_bytes", "+", bytes) }))
      .where("id", "=", repoId)
      .execute();
  } catch (error) {
    console.warn("Usage: recording pushed bytes failed", error);
  }
}
