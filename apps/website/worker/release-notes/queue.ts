// Release notes regenerate off the request path. A change (push, tag, tracker
// update) marks the repository dirty and enqueues it after a short delay, so
// bursts coalesce; a D1 lease keeps one run per repository at a time, and a
// change during a run schedules another.

import type { MutationResult } from "../../shared/tracker.ts";
import { semanticFeed } from "../semantic/feed.ts";
import { semanticCache } from "../semantic/api.ts";
import { RepoReader } from "../objects.ts";
import { db } from "../schema.ts";
import { Timing } from "../timing.ts";
import { generateReleaseNotes, type GeneratorSource } from "./generate.ts";
import { affectedRepos, issuesFrom, subscribedOwners } from "./trackers.ts";

export interface ReleaseNotesJob {
  type: "release-notes";
  repoId: string;
}

const DEBOUNCE_SECONDS = 20;
const LEASE_MS = 14 * 60_000;

/** Something a repository's release notes depend on changed. */
export async function notifyReleaseNotes(env: Env, repoId: string): Promise<void> {
  // Automatic non-AI agent environments omit provider bindings altogether.
  if (!env.AI) return;
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
export async function runReleaseNotesJob(
  env: Env,
  message: Message<ReleaseNotesJob>,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<void> {
  const { repoId } = message.body;
  if (!env.AI) return message.ack();
  const d = db(env.DB);
  const now = Date.now();
  const leased = await d
    .updateTable("release_note_state")
    .set({ lease_until: now + LEASE_MS, dirty: 0, status: "generating" })
    .where("repo_id", "=", repoId)
    .where("lease_until", "<", now)
    .executeTakeFirst();
  // Another run holds it; that run sees the dirty mark and follows up.
  if (!leased.numUpdatedRows) return message.ack();

  let again = false;
  try {
    const opened = await source(env, repoId, waitUntil);
    if (opened) {
      try {
        const result = await generateReleaseNotes(env, repoId, opened.source);
        again = result.more;
      } finally {
        await opened.close();
      }
    }
    const state = await d
      .updateTable("release_note_state")
      .set({ lease_until: 0, status: "ready", error: null, generated_at: new Date().toISOString() })
      .where("repo_id", "=", repoId)
      .returning("dirty")
      .executeTakeFirst();
    again ||= Boolean(state?.dirty);
    if (again)
      await env.JOBS.send({ type: "release-notes", repoId } satisfies ReleaseNotesJob, {
        delaySeconds: 5,
      });
    message.ack();
  } catch (error) {
    console.error("Release notes: generation failed", repoId, error);
    await d
      .updateTable("release_note_state")
      .set({ lease_until: 0, status: "failed", error: String(error).slice(0, 500), dirty: 1 })
      .where("repo_id", "=", repoId)
      .execute();
    message.retry({ delaySeconds: Math.min(600, 30 * 2 ** Math.max(0, message.attempts - 1)) });
  }
}
