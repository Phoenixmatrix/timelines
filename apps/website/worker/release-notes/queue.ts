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
import { landedTimelines, ownerTimelines } from "./timelines.ts";
import { affectedRepos, issuesFrom, subscribedOwners } from "./trackers.ts";
import { aiWork } from "../usage/ai.ts";

export interface ReleaseNotesJob {
  type: "release-notes";
  repoId: string;
}

const DEBOUNCE_SECONDS = 20;
const LEASE_MS = 14 * 60_000;

/** Lazily rebuild old derived data; the dirty mark coalesces concurrent reads. */
export async function ensureReleaseNotes(env: Env, repoId: string): Promise<void> {
  if (!env.AI || !productionOnly(env, "queue", "release notes")) return;
  if (!(await repoAiSnapshot(env.DB, repoId)).features.releaseNotes) return;
  const claimed = await db(env.DB)
    .insertInto("release_note_state")
    .values({ repo_id: repoId, dirty: 1, status: "generating" })
    .onConflict((oc) =>
      oc
        .column("repo_id")
        .doUpdateSet({ dirty: 1, status: "generating" })
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
    await env.JOBS.send({ type: "release-notes", repoId } satisfies ReleaseNotesJob, {
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
export async function notifyReleaseNotes(env: Env, repoId: string): Promise<void> {
  // Automatic non-AI agent environments omit provider bindings altogether.
  if (!env.AI || !productionOnly(env, "queue", "release notes")) return;
  if (!(await repoAiSnapshot(env.DB, repoId)).features.releaseNotes) return;
  await db(env.DB)
    .insertInto("release_note_state")
    .values({ repo_id: repoId, dirty: 1 })
    .onConflict((oc) => oc.column("repo_id").doUpdateSet({ dirty: 1 }))
    .execute();
  await env.JOBS.send({ type: "release-notes", repoId } satisfies ReleaseNotesJob, {
    delaySeconds: DEBOUNCE_SECONDS,
  });
}

/** After a tracker mutation: refresh the repositories it touches. */
export async function refreshAfterTrackerMutation(
  env: Env,
  ownerId: string,
  result: MutationResult,
  removedRepoIds: string[],
): Promise<void> {
  try {
    for (const repoId of await affectedRepos(env, ownerId, result, removedRepoIds))
      await notifyReleaseNotes(env, repoId);
  } catch (error) {
    console.error("Release notes: tracker refresh failed", error);
  }
}

async function source(
  env: Env,
  repoId: string,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<{ source: GeneratorSource; close(): Promise<void> } | null> {
  const row = await db(env.DB)
    .selectFrom("repos as r")
    .innerJoin("accounts as a", "a.id", "r.owner_id")
    .select(["r.id", "r.owner_id", "r.name", "r.artifacts_name", "r.artifacts_remote", "a.slug"])
    .where("r.id", "=", repoId)
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
      refs: () => reader.refs(),
      log: (oid, limit, offset) => reader.log(oid, limit, offset),
      commit: (oid) => reader.commit(oid),
      timelines: async (merges) =>
        landedTimelines(
          env.DB,
          row.id,
          (await reader.refs()).headBranch,
          merges,
          ownerTimelines(env, row.owner_id),
        ),
      issues: async (keys) => issuesFrom(env, await subscribedOwners(env, row), row.id, keys),
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
  // Metering (CORE-207): the model calls are the repository owner's.
  return aiWork({ feature: "release_notes", repo: message.body.repoId }, () =>
    releaseNotesJob(env, message, waitUntil),
  );
}

async function releaseNotesJob(
  env: Env,
  message: Message<ReleaseNotesJob>,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<void> {
  const { repoId } = message.body;
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
    const opened = await source(env, repoId, waitUntil);
    if (opened) {
      try {
        // Keep a push during this generation out of its continuation. The next
        // generation reads new refs together with its freshly selected models.
        const refs: RepoRefs = previous.generation_refs
          ? JSON.parse(previous.generation_refs)
          : await opened.source.refs();
        const saved = await d
          .updateTable("release_note_state")
          .set({ generation_refs: JSON.stringify(refs), ai_snapshot: JSON.stringify(snapshot) })
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
    const state = await d
      .updateTable("release_note_state")
      .set((eb) => ({
        lease_until: 0,
        lease_id: null,
        ai_snapshot: again ? JSON.stringify(snapshot) : null,
        generation_refs: again ? eb.ref("generation_refs") : null,
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
      .returning("dirty")
      .executeTakeFirst();
    if (!state) return message.ack();
    if (again || state.dirty)
      await env.JOBS.send({ type: "release-notes", repoId } satisfies ReleaseNotesJob, {
        delaySeconds: 5,
      });
    message.ack();
  } catch (error) {
    console.error("Release notes: generation failed", repoId, error);
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
