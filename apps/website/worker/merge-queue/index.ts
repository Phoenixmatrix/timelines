import { Hono, type Context } from "hono";
import {
  queueSourceBranch,
  queueCandidateBranch,
  type QueueEntry,
  type QueueResolution,
  type QueueStatus,
} from "../../shared/merge-queue.ts";
import type { AppEnv } from "../auth.ts";
import { errorDetails, fail, requireActor } from "../api/http.ts";
import { forgetUpstreamTokens } from "../artifacts.ts";
import { loadRepo } from "../api/repos.ts";
import { queueMergeJob } from "../ci/queue-auth.ts";
import { db } from "../schema.ts";
import {
  captureWorkAuthority,
  resolveWorkAuthority,
  WorkAuthorizationError,
} from "../ci/admission.ts";
import { repoAiSnapshot } from "../settings/ai.ts";
import { queueDeps } from "./deps.ts";
import { validateQueueIssues } from "./remediation.ts";
import { resolveQueueConflicts, validateConflictFiles } from "./ai.ts";
import {
  admitQueue,
  cancelCombined,
  decode,
  getQueue,
  saveQueue,
  type QueueState,
} from "./store.ts";
import { progressQueue } from "./scheduler.ts";
export { afterQueueRun, sweepQueue } from "./scheduler.ts";
export const queueApi = new Hono<AppEnv>();
queueApi.onError((error, c) => {
  if (error instanceof WorkAuthorizationError) return fail(c, 403, error.message);
  if (error.message === "migration_epoch_mismatch" || error.message === "space_cutover_fenced")
    return fail(c, 409, error.message);
  throw error;
});
const statuses: QueueStatus[] = [
  "queued",
  "merging",
  "testing",
  "advancing",
  "landed",
  "failed",
  "cancelled",
  "covered",
];
const oid = /^[0-9a-f]{40}$/;

/** Bound actual streamed bytes, not the caller's optional Content-Length. */
async function input(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        return null;
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
queueApi.get("/", async (c) => {
  const repo = await loadRepo(c);
  if (repo instanceof Response) return repo;
  const status = c.req.query("status");
  if (status && !statuses.includes(status as QueueStatus))
    return fail(c, 400, "Unknown queue status.");
  let query = db(c.env.DB).selectFrom("merge_queue").selectAll().where("repo_id", "=", repo.row.id);
  if (status) query = query.where("status", "=", status as QueueStatus);
  const rows = await query.orderBy("created_at", "desc").orderBy("id", "desc").limit(100).execute();
  return c.json({ entries: rows.map((row) => decode(row).entry) });
});
queueApi.get("/:id", async (c) => {
  const repo = await loadRepo(c);
  if (repo instanceof Response) return repo;
  if (!oid.test(c.req.param("id")))
    return fail(c, 400, "Queue ID must be a full lowercase commit ID.");
  const state = await getQueue(c.env.DB, repo.row.id, c.req.param("id"));
  return state ? c.json({ entry: state.entry }) : fail(c, 404, "Queue entry not found.");
});
queueApi.post("/", async (c) => {
  const repo = await loadRepo(c, "write");
  if (repo instanceof Response) return repo;
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await input(c);
  if (
    !body ||
    Object.keys(body).some((key) => key !== "commit" && key !== "issues") ||
    typeof body.commit !== "string" ||
    !oid.test(body.commit) ||
    (body.issues !== undefined &&
      (!Array.isArray(body.issues) ||
        body.issues.length > 50 ||
        body.issues.some((id) => typeof id !== "string" || id.length > 128)))
  )
    return fail(c, 400, "Expected {commit: lowercase 40-hex ID, issues?: string[]}.");
  let issueIds: string[];
  try {
    issueIds = await validateQueueIssues(c.env, {
      spaceId: repo.row.space_id,
      repoId: repo.row.id,
      actorId: actor.id,
      agentId: actor.agent?.id ?? null,
      credential: actor.credential,
      issueIds: (body.issues ?? []) as string[],
    });
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number(error.status) : 503;
    return fail(
      c,
      status === 403 ? 403 : status === 404 ? 404 : status === 400 ? 400 : 503,
      "Linked issues could not be validated.",
    );
  }
  const existing = await getQueue(c.env.DB, repo.row.id, body.commit);
  if (existing) {
    if (JSON.stringify(existing.entry.issueIds) !== JSON.stringify(issueIds))
      return fail(c, 409, "This commit was admitted with different linked issues.");
    c.executionCtx.waitUntil(
      progressQueue(c.env, repo.row.id, (work) => c.executionCtx.waitUntil(work)),
    );
    return c.json({ entry: existing.entry });
  }
  // Admission follows the source push at once, and a storage token or ref read
  // can fail there for a moment (CORE-309): read again with fresh tokens, then
  // answer with a retryable 503 rather than an opaque 500.
  const deps = queueDeps(c.env, (work) => c.executionCtx.waitUntil(work));
  let refs: Map<string, string>;
  try {
    refs = await deps.refs(repo.row).catch(() => {
      forgetUpstreamTokens(repo.row.artifacts_name);
      return deps.refs(repo.row);
    });
  } catch (error) {
    console.error(
      "Queue admission: the queue source branch could not be read",
      errorDetails(error),
    );
    return fail(
      c,
      503,
      "Couldn't read the queue source branch from storage. Admission is safe to retry.",
    );
  }
  if (refs.get(`refs/heads/${queueSourceBranch(body.commit)}`) !== body.commit)
    return fail(c, 409, "Push the exact commit to its queue source branch before admission.");
  const now = new Date().toISOString();
  const entry: QueueEntry = {
    id: body.commit,
    repo: { id: repo.row.id, space: repo.row.space_slug, name: repo.row.name },
    commit: body.commit,
    branch: repo.row.default_branch,
    sourceBranch: queueSourceBranch(body.commit),
    candidateBranch: queueCandidateBranch(body.commit),
    status: "queued",
    base: null,
    candidate: null,
    mergeRun: null,
    gateRun: null,
    deployRun: null,
    deployStatus: null,
    coveredBy: null,
    issueIds,
    remediationIssueId: null,
    failure: null,
    decision: null,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  const state: QueueState = {
    entry,
    authority: await captureWorkAuthority(c.env, repo.row.id, actor),
    actor: { id: actor.id, ...(actor.agent ? { agent: actor.agent } : {}) },
    snapshot: await repoAiSnapshot(c.env.DB, repo.row.id),
    mergeSource: body.commit,
    combinedIds: [],
    rebaseAttempts: 0,
    mergeRunId: null,
    gateRunId: null,
    deployRunId: null,
    resolution: null,
    resolutionInput: null,
    resolutionClaimed: false,
    classificationClaimed: false,
    effectsPending: false,
    remediationPending: false,
    history: [],
  };
  const inserted = await admitQueue(c.env.DB, state);
  const saved = await getQueue(c.env.DB, repo.row.id, body.commit);
  if (!saved || JSON.stringify(saved.entry.issueIds) !== JSON.stringify(issueIds))
    return fail(c, 409, "This commit was concurrently admitted with different linked issues.");
  c.executionCtx.waitUntil(
    progressQueue(c.env, repo.row.id, (work) => c.executionCtx.waitUntil(work)),
  );
  return c.json({ entry: saved.entry }, inserted ? 201 : 200);
});
for (const action of ["cancel", "retry"] as const)
  queueApi.post(`/:id/${action}`, async (c) => {
    const repo = await loadRepo(c, "write");
    if (repo instanceof Response) return repo;
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const id = c.req.param("id")!;
    if (!oid.test(id)) return fail(c, 400, "Queue ID must be a full lowercase commit ID.");
    for (let tries = 0; tries < 8; tries++) {
      const s = await getQueue(c.env.DB, repo.row.id, id);
      if (!s) return fail(c, 404, "Queue entry not found.");
      if (action === "cancel" && s.entry.status === "cancelled") return c.json({ entry: s.entry });
      if (
        action === "cancel"
          ? !["queued", "merging", "testing"].includes(s.entry.status)
          : !["failed", "cancelled"].includes(s.entry.status)
      )
        return fail(c, 409, `Cannot ${action} an entry that is ${s.entry.status}.`);
      if (action === "cancel" && s.entry.coveredBy) {
        const covering = await getQueue(c.env.DB, repo.row.id, s.entry.coveredBy);
        if (covering && ["advancing", "landed", "covered"].includes(covering.entry.status))
          return fail(c, 409, "This submission's combined candidate is already advancing.");
        if (covering && ["merging", "testing"].includes(covering.entry.status)) {
          if (!(await cancelCombined(c.env.DB, s, covering))) continue;
          const deps = queueDeps(c.env, (work) => c.executionCtx.waitUntil(work));
          for (const run of [covering.mergeRunId, covering.gateRunId])
            if (run)
              c.executionCtx.waitUntil(
                deps
                  .cancel(run)
                  .catch((error) => console.error("Queue combined cancellation", error)),
              );
          c.executionCtx.waitUntil(
            progressQueue(c.env, repo.row.id, (work) => c.executionCtx.waitUntil(work)),
          );
          const cancelled = await getQueue(c.env.DB, repo.row.id, id);
          return c.json({ entry: cancelled!.entry });
        }
      }
      if (action === "retry" && s.remediationPending) {
        // Retrying cannot discard a durable outbox item. Record it first, without
        // reacquiring the scheduling slot, or ask the client to retry later.
        const deps = queueDeps(c.env, (work) => c.executionCtx.waitUntil(work));
        try {
          if (s.entry.failure) await deps.remediate(repo.row, s, s.entry.failure);
        } catch {
          return fail(c, 503, "Failure evidence is pending; retry once Tracker is available.");
        }
      }
      const next =
        action === "cancel"
          ? { ...s, entry: { ...s.entry, status: "cancelled" as const } }
          : {
              ...s,
              authority: await captureWorkAuthority(c.env, repo.row.id, actor),
              actor: { id: actor.id, ...(actor.agent ? { agent: actor.agent } : {}) },
              mergeSource: s.entry.commit,
              combinedIds: [],
              rebaseAttempts: 0,
              mergeRunId: null,
              gateRunId: null,
              deployRunId: null,
              resolution: null,
              resolutionInput: null,
              resolutionClaimed: false,
              classificationClaimed: false,
              effectsPending: false,
              remediationPending: false,
              history: [...s.history, s.entry],
              entry: {
                ...s.entry,
                status: "queued" as const,
                base: null,
                candidate: null,
                mergeRun: null,
                gateRun: null,
                deployRun: null,
                deployStatus: null,
                coveredBy: null,
                remediationIssueId: null,
                failure: null,
                decision: null,
              },
            };
      const saved = await saveQueue(c.env.DB, s, next);
      if (!saved) continue;
      const deps = queueDeps(c.env, (work) => c.executionCtx.waitUntil(work));
      // The persisted status/run fence revokes authority even if CI cleanup fails.
      for (const run of [s.mergeRunId, s.gateRunId])
        if (run)
          c.executionCtx.waitUntil(
            deps.cancel(run).catch((error) => console.error("Queue cancellation cleanup", error)),
          );
      c.executionCtx.waitUntil(
        progressQueue(c.env, repo.row.id, (work) => c.executionCtx.waitUntil(work)),
      );
      return c.json({ entry: saved.entry });
    }
    return fail(c, 409, "Queue entry changed; reload and try again.");
  });
queueApi.post("/:id/resolve", async (c) => {
  const id = c.req.param("id");
  if (!oid.test(id)) return fail(c, 400, "Queue ID must be a full lowercase commit ID.");
  const header = c.req.header("authorization") ?? "";
  const token = /^Bearer (gmj_[^\s]+)$/i.exec(header)?.[1];
  if (!token) return fail(c, 401, "A running queue merge job credential is required.");
  const access = await queueMergeJob(
    c.env,
    token,
    c.req.param("space") ?? "",
    c.req.param("name") ?? "",
    id,
  );
  if (!access.ok) return fail(c, access.status, access.error);
  const body = await input(c);
  if (
    !body ||
    Object.keys(body).some((key) => key !== "files") ||
    !validateConflictFiles(body.files)
  )
    return fail(c, 400, "Conflict payload is outside the permitted bounded text repair scope.");
  const fingerprint = JSON.stringify(body.files);
  const s = await getQueue(c.env.DB, access.repo.id, id);
  if (
    !s ||
    s.entry.status !== "merging" ||
    s.entry.attempts !== access.attempt ||
    s.mergeRunId !== access.runId
  )
    return fail(c, 409, "Queue attempt changed.");
  await resolveWorkAuthority(c.env, s.authority, access.repo.id);
  if (s.resolutionInput && s.resolutionInput !== fingerprint)
    return fail(c, 409, "This attempt already supplied different conflict files.");
  if (s.resolution) return c.json({ resolution: s.resolution });
  if (s.resolutionClaimed)
    return fail(
      c,
      409,
      "The bounded resolution attempt was already claimed; it will not be replayed.",
    );
  const claimed = await saveQueue(c.env.DB, s, {
    ...s,
    resolutionClaimed: true,
    resolutionInput: fingerprint,
  });
  if (!claimed) return fail(c, 409, "Queue attempt changed.");
  let resolution: QueueResolution;
  try {
    resolution = await resolveQueueConflicts(c.env, s.snapshot, {
      repoId: access.repo.id,
      files: body.files,
    });
  } catch {
    resolution = {
      decision: {
        action: "manual",
        reason: "Conflict inference was unavailable; manual resolution is required.",
        model: null,
        confidence: null,
      },
      files: [],
      repairModel: null,
    };
  }
  // A cancellation or retry during inference cannot publish into the new attempt.
  for (let tries = 0; tries < 8; tries++) {
    const current = await getQueue(c.env.DB, access.repo.id, id);
    if (
      !current ||
      current.entry.status !== "merging" ||
      current.entry.attempts !== access.attempt ||
      current.mergeRunId !== access.runId ||
      current.resolutionInput !== fingerprint
    )
      return fail(c, 409, "Queue attempt changed during resolution.");
    await resolveWorkAuthority(c.env, current.authority, access.repo.id);
    if (current.resolution) return c.json({ resolution: current.resolution });
    const saved = await saveQueue(c.env.DB, current, {
      ...current,
      resolution,
      entry: { ...current.entry, decision: resolution.decision },
    });
    if (saved) return c.json({ resolution });
  }
  return fail(c, 409, "Queue state kept changing; the paid resolution will not be replayed.");
});
