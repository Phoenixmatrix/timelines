// Release notes regenerate off the request path. A change (push, tag, tracker
// update) marks the repository dirty and enqueues it after a short delay, so
// bursts coalesce; a D1 lease keeps one run per repository at a time, and a
// change during a run schedules another.

import type { MutationResult } from "../../shared/tracker.ts";
import type { AiSnapshot } from "../../shared/ai.ts";
import type { RepoRefs } from "../artifacts.ts";
import { repoAiSnapshot } from "../settings/ai.ts";
import { semanticFeed } from "../semantic/feed.ts";
import { semanticCache } from "../semantic/api.ts";
import { RepoReader } from "../objects.ts";
import { productionOnly } from "../preview.ts";
import { db } from "../schema.ts";
import { Timing } from "../timing.ts";
import { generateReleaseNotes, type GeneratorSource } from "./generate.ts";
import { landedTimelines, spaceTimelines } from "./timelines.ts";
import { affectedRepos, repoIssues } from "./trackers.ts";
import { aiWork } from "../usage/ai.ts";
import { selectRepos, roleFor, type Actor } from "../db.ts";
import { atLeast } from "../permissions.ts";
import { captureWorkAuthority, resolveWorkAuthority, type WorkAuthority } from "../ci/admission.ts";
import { resolveSpaceAccess } from "../spaces/access.ts";
import { isActorCredentialLive } from "../auth.ts";

/** A queued identity is evidence, never cached authorization. */
async function authorize(env: Env, repoId: string, authority: WorkAuthority) {
  const current = await resolveWorkAuthority(env, authority, repoId);
  if (current.repo.deleted_at) throw new Error("release_source_deleted");
  if (!(await resolveSpaceAccess(env.DB, current.actor, authority.spaceId)))
    throw new Error("release_authority_revoked: an explicit current Space grant is required.");
  return current;
}

export interface ReleaseNotesJob {
  type: "release-notes";
  repoId: string;
  authority: WorkAuthority;
}

const DEBOUNCE_SECONDS = 20;
const LEASE_MS = 14 * 60_000;

/** Lazily rebuild old derived data; the dirty mark coalesces concurrent reads. */
export async function ensureReleaseNotes(
  env: Env,
  repoId: string,
  actor: Actor | null,
): Promise<void> {
  if (!env.AI || !productionOnly(env, "queue", "release notes")) return;
  if (!actor) return;
  if (!(await isActorCredentialLive(env.DB, actor, "write"))) return;
  const repo = await selectRepos(env.DB, actor.id).where("r.id", "=", repoId).executeTakeFirst();
  if (
    !repo ||
    !atLeast(roleFor(repo, actor), "write") ||
    !(await resolveSpaceAccess(env.DB, actor, repo.space_id))
  )
    return;
  const authority = await captureWorkAuthority(env, repoId, actor);
  await authorize(env, repoId, authority);
  const binding = JSON.stringify(authority);
  if (!(await repoAiSnapshot(env.DB, repoId)).features.releaseNotes) return;
  const claimed = await db(env.DB)
    .insertInto("release_note_state")
    .values({ repo_id: repoId, dirty: 1, dirty_binding: binding, status: "generating" })
    .onConflict((oc) =>
      oc
        .column("repo_id")
        .doUpdateSet({ dirty: 1, dirty_binding: binding, status: "generating" })
        .where("format_version", "<", 1)
        .where("dirty", "=", 0)
        .where("lease_until", "<", Date.now())
        .where("ai_snapshot", "is", null)
        .where("status", "!=", "failed"),
    )
    .returning("repo_id")
    .executeTakeFirst();
  if (!claimed) return;
  try {
    await env.JOBS.send({ type: "release-notes", repoId, authority } satisfies ReleaseNotesJob, {
      delaySeconds: DEBOUNCE_SECONDS,
    });
  } catch (error) {
    await db(env.DB)
      .updateTable("release_note_state")
      .set({ dirty: 0, status: "idle" })
      .where("repo_id", "=", repoId)
      .execute();
    throw error;
  }
}
/** Something a repository's release notes depend on changed. */
export async function notifyReleaseNotes(
  env: Env,
  repoId: string,
  initiator: Actor | WorkAuthority,
): Promise<void> {
  // Automatic non-AI agent environments omit provider bindings altogether.
  if (!env.AI || !productionOnly(env, "queue", "release notes")) return;
  const authority =
    "personId" in initiator ? initiator : await captureWorkAuthority(env, repoId, initiator);
  const current = await resolveWorkAuthority(env, authority, repoId);
  // Repository-only writers may push, but that does not grant use of Space providers.
  if (
    current.repo.deleted_at ||
    !(await resolveSpaceAccess(env.DB, current.actor, authority.spaceId))
  )
    return;
  const binding = JSON.stringify(authority);
  if (!(await repoAiSnapshot(env.DB, repoId)).features.releaseNotes) return;
  await db(env.DB)
    .insertInto("release_note_state")
    .values({ repo_id: repoId, dirty: 1, dirty_binding: binding })
    .onConflict((oc) => oc.column("repo_id").doUpdateSet({ dirty: 1, dirty_binding: binding }))
    .execute();
  await env.JOBS.send({ type: "release-notes", repoId, authority } satisfies ReleaseNotesJob, {
    delaySeconds: DEBOUNCE_SECONDS,
  });
}

/** After a tracker mutation: refresh the repositories it touches. */
export async function refreshAfterTrackerMutation(
  env: Env,
  spaceId: string,
  result: MutationResult,
  removedRepoIds: string[],
  actor: Actor,
): Promise<void> {
  try {
    for (const repoId of await affectedRepos(env, spaceId, result, removedRepoIds, actor))
      await notifyReleaseNotes(env, repoId, actor);
  } catch (error) {
    console.error("Release notes: tracker refresh failed", error);
  }
}

async function source(
  env: Env,
  repoId: string,
  waitUntil: (work: Promise<unknown>) => void,
  authority: WorkAuthority,
): Promise<{ source: GeneratorSource; close(): Promise<void> } | null> {
  const row = await db(env.DB)
    .selectFrom("repos as r")
    .innerJoin("spaces as a", "a.id", "r.space_id")
    .select(["r.id", "r.space_id", "r.name", "r.artifacts_name", "r.artifacts_remote", "a.slug"])
    .where("r.id", "=", repoId)
    .where("r.space_id", "=", authority.spaceId)
    .where("r.deleted_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  const reader = new RepoReader(
    env,
    row.artifacts_name,
    row.artifacts_remote,
    new Timing(),
    waitUntil,
  );
  const cache = semanticCache();
  const base = `/${encodeURIComponent(row.slug)}/${encodeURIComponent(row.name)}`;
  return {
    source: {
      authorize: async () => {
        await authorize(env, repoId, authority);
      },
      refs: () => reader.refs(),
      log: (oid, limit, offset) => reader.log(oid, limit, offset),
      commit: (oid) => reader.commit(oid),
      timelines: async (merges) =>
        landedTimelines(
          env.DB,
          row.id,
          (await reader.refs()).headBranch,
          merges,
          spaceTimelines(env, row.space_id, (await authorize(env, repoId, authority)).actor),
        ),
      issues: async (keys) =>
        repoIssues(env, row, keys, (await authorize(env, repoId, authority)).actor),
      async changes(oid) {
        try {
          const feed = await semanticFeed(reader, cache, row.id, base, {
            ref: oid,
            path: "",
            kind: "",
            language: "",
            limit: 30,
          });
          return feed.entries
            .filter((entry) => entry.commit.oid === oid)
            .map((entry) => ({
              kind: entry.kind,
              name: entry.name,
              path: entry.after?.path ?? entry.before?.path ?? "",
              summary: entry.summary,
            }));
        } catch (error) {
          // Code changes enrich an entry; their absence must not block it.
          console.error("Release notes: semantic changes failed", oid, error);
          return [];
        }
      },
    },
    close: () => reader.close(),
  };
}

/** Queue consumer for one repository. */
export function runReleaseNotesJob(
  env: Env,
  message: Message<ReleaseNotesJob>,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<void> {
  // Metering resolves the repository's immutable Space independently of authority.
  return aiWork({ feature: "release_notes", repo: message.body.repoId }, () =>
    releaseNotesJob(env, message, waitUntil),
  );
}

async function releaseNotesJob(
  env: Env,
  message: Message<ReleaseNotesJob>,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<void> {
  const { repoId, authority } = message.body;
  if (!env.AI || !productionOnly(env, "queue", "release notes")) return message.ack();
  const d = db(env.DB);
  const now = Date.now();
  const previous = await d
    .selectFrom("release_note_state")
    .selectAll()
    .where("repo_id", "=", repoId)
    .executeTakeFirst();
  if (
    !previous ||
    previous.lease_until >= now ||
    (!previous.ai_snapshot && !previous.dirty && previous.format_version >= 1)
  )
    return message.ack();
  const binding = previous.ai_snapshot ? previous.generation_binding : previous.dirty_binding;
  if (!binding) {
    // Unbound legacy work cannot be attributed by inference; retain its frozen inputs.
    await d
      .updateTable("release_note_state")
      .set({
        status: "failed",
        error: "client_upgrade_required: release generation authority requires reconciliation",
      })
      .where("repo_id", "=", repoId)
      .where("lease_until", "<", now)
      .where(previous.ai_snapshot ? "generation_binding" : "dirty_binding", "is", null)
      .execute();
    return message.ack();
  }
  if (binding !== JSON.stringify(authority)) return message.ack();
  try {
    await authorize(env, repoId, authority);
  } catch {
    // Preserve materialized history; discard only this rejected pending generation.
    const rejected = await d
      .updateTable("release_note_state")
      .set({
        ai_snapshot: null,
        generation_refs: null,
        generation_binding: null,
        status: "failed",
        error: "release_authority_revoked",
      })
      .where("repo_id", "=", repoId)
      .where("lease_until", "<", now)
      .where(previous.ai_snapshot ? "generation_binding" : "dirty_binding", "=", binding)
      .returning(["dirty", "dirty_binding"])
      .executeTakeFirst();
    if (rejected?.dirty && rejected.dirty_binding && rejected.dirty_binding !== binding)
      await env.JOBS.send({
        type: "release-notes",
        repoId,
        authority: JSON.parse(rejected.dirty_binding),
      } satisfies ReleaseNotesJob);
    return message.ack();
  }

  // A non-null snapshot is the generation, not the delivery. Retries, expired
  // leases and budget continuations all resume it; dirty only signals a successor.
  const snapshot: AiSnapshot = previous.ai_snapshot
    ? JSON.parse(previous.ai_snapshot)
    : await repoAiSnapshot(env.DB, repoId);
  if (!snapshot.features.releaseNotes) {
    await d
      .updateTable("release_note_state")
      .set({ dirty: 0, status: previous.format_version >= 1 ? "ready" : "idle" })
      .where("repo_id", "=", repoId)
      .where("lease_until", "<", now)
      .where("ai_snapshot", "is", null)
      .execute();
    return message.ack();
  }
  const leaseId = crypto.randomUUID();
  const leased = await d
    .updateTable("release_note_state")
    .set((eb) => ({
      lease_until: now + LEASE_MS,
      lease_id: leaseId,
      dirty: previous.ai_snapshot ? eb.ref("dirty") : 0,
      status: "generating",
    }))
    .where("repo_id", "=", repoId)
    .where("lease_until", "<", now)
    .where("ai_snapshot", previous.ai_snapshot ? "=" : "is", previous.ai_snapshot)
    .where((eb) =>
      eb.or([eb("dirty", "=", 1), eb("ai_snapshot", "is not", null), eb("format_version", "<", 1)]),
    )
    .executeTakeFirst();
  if (!leased.numUpdatedRows) return message.ack();

  let again = false;
  try {
    const opened = await source(env, repoId, waitUntil, authority);
    if (opened) {
      try {
        // Keep a push during this generation out of its continuation. The next
        // generation reads new refs together with its freshly selected models.
        const refs: RepoRefs = previous.generation_refs
          ? JSON.parse(previous.generation_refs)
          : await opened.source.refs();
        const saved = await d
          .updateTable("release_note_state")
          .set({
            generation_refs: JSON.stringify(refs),
            ai_snapshot: JSON.stringify(snapshot),
            generation_binding: binding,
          })
          .where("repo_id", "=", repoId)
          .where("lease_id", "=", leaseId)
          .executeTakeFirst();
        if (!saved.numUpdatedRows) return message.ack();
        const result = await generateReleaseNotes(
          env,
          repoId,
          { ...opened.source, refs: async () => refs },
          snapshot.models,
        );
        again = result.more;
      } finally {
        await opened.close();
      }
    }
    await authorize(env, repoId, authority);
    const state = await d
      .updateTable("release_note_state")
      .set((eb) => ({
        lease_until: 0,
        lease_id: null,
        ai_snapshot: again ? JSON.stringify(snapshot) : null,
        generation_refs: again ? eb.ref("generation_refs") : null,
        generation_binding: again ? binding : null,
        status: eb
          .case()
          .when("dirty", "=", 1)
          .then("generating" as const)
          .else(again ? ("generating" as const) : ("ready" as const))
          .end(),
        format_version: again ? eb.ref("format_version") : 1,
        error: null,
        generated_at: again ? eb.ref("generated_at") : new Date().toISOString(),
      }))
      .where("repo_id", "=", repoId)
      .where("lease_id", "=", leaseId)
      .returning(["dirty", "dirty_binding"])
      .executeTakeFirst();
    if (!state) return message.ack();
    if (again || state.dirty)
      await env.JOBS.send(
        {
          type: "release-notes",
          repoId,
          authority: again ? authority : JSON.parse(state.dirty_binding!),
        } satisfies ReleaseNotesJob,
        {
          delaySeconds: 5,
        },
      );
    message.ack();
  } catch (error) {
    // Logs keep an error's stack but not always its message: name it (CORE-310).
    console.error(
      "Release notes: generation failed",
      repoId,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      error,
    );
    const failed = await d
      .updateTable("release_note_state")
      .set((eb) => ({
        lease_until: 0,
        lease_id: null,
        status: "failed",
        error: String(error).slice(0, 500),
        // No frozen refs means no admitted AI work. A retry must reconsider
        // current policy rather than apply an old policy to a newly fetched HEAD.
        dirty: eb.case().when("ai_snapshot", "is", null).then(1).else(eb.ref("dirty")).end(),
      }))
      .where("repo_id", "=", repoId)
      .where("lease_id", "=", leaseId)
      .executeTakeFirst();
    if (!failed.numUpdatedRows) {
      // Completion can succeed before the follow-up send fails. Retry delivery
      // to pick up its persisted successor/continuation, without reviving it.
      message.retry({ delaySeconds: 5 });
      return;
    }
    message.retry({ delaySeconds: Math.min(600, 30 * 2 ** Math.max(0, message.attempts - 1)) });
  }
}
