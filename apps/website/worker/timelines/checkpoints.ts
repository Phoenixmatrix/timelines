// Checkpoints, the Worker's half (CORE-76): measuring a timeline's bookmarks
// for a new checkpoint, and showing a checkpoint with what's known about it
// now. The record itself lives in the tracker (tracker/timelines.ts) and never
// changes; its CI runs, previews and approval are found by its commits and id
// whenever it's shown, since those keep changing after it's made.

import { lsRefs } from "../artifacts.ts";
import { roleFor, selectRepos, type Actor } from "../db.ts";
import { atLeast } from "../permissions.ts";
import { db } from "../schema.ts";
import {
  CHECKPOINT_CHANGES,
  timelineBookmark,
  type Checkpoint,
  type CheckpointRepo,
  type CheckpointState,
  type CheckpointView,
  type Timeline,
} from "../../shared/timelines.ts";
import { fail } from "../tracker/store.ts";
import { checkpointSets } from "../knowledge/pages.ts";

/** CI runs shown per commit: the newest. */
const RUNS_PER_COMMIT = 3;
/** Previews shown per checkpoint. */
const PREVIEWS = 20;

/**
 * Each repository's bookmark tip and main's tip now, and the changes the
 * bookmark has reached (CORE-68's change log, newest first). Measuring needs
 * write access to every repository, as forking does.
 */
export async function measure(
  env: Env,
  actor: Actor,
  timeline: Timeline,
): Promise<CheckpointRepo[]> {
  const ids = timeline.repos.map((repo) => repo.id);
  const rows = ids.length
    ? await selectRepos(env.DB, actor.id).where("r.id", "in", ids).execute()
    : [];
  const bookmark = `refs/heads/${timelineBookmark(timeline.slug)}`;
  return Promise.all(
    timeline.repos.map(async (repo): Promise<CheckpointRepo> => {
      const row = rows.find((r) => r.id === repo.id);
      const role = row ? roleFor(row, actor) : "none";
      if (!row || !atLeast(role, "read"))
        fail("not_found", `No repository ${repo.owner}/${repo.name}.`, 404);
      if (!atLeast(role, "write"))
        fail("forbidden", `A checkpoint needs write access to ${row.owner_slug}/${row.name}.`, 403);
      const refs = await lsRefs(env, row.artifacts_name, row.artifacts_remote);
      const commit = refs.find((ref) => ref.name === bookmark)?.oid;
      if (!commit) fail("no_bookmark", `${row.owner_slug}/${row.name} has no ${bookmark}.`, 409);
      const base = refs.find((ref) => ref.name === `refs/heads/${row.default_branch}`)?.oid ?? null;
      const changes = await db(env.DB)
        .selectFrom("change_refs")
        .select(["change_id", "last_commit_oid"])
        .where("repo_id", "=", row.id)
        .where("ref", "=", bookmark)
        .orderBy("last_seen_at", "desc")
        .orderBy("change_id")
        .limit(CHECKPOINT_CHANGES)
        .execute();
      return {
        id: row.id,
        owner: row.owner_slug,
        name: row.name,
        commit,
        base,
        changes: changes.map((c) => ({ changeId: c.change_id, commit: c.last_commit_oid })),
      };
    }),
  );
}

/**
 * Whether the actor may start runs in every repository of a checkpoint (to
 * revive its preview, CORE-79): write access, as making a checkpoint needs.
 */
export async function mayWriteAll(env: Env, actor: Actor, checkpoint: Checkpoint): Promise<void> {
  const ids = checkpoint.repos.map((repo) => repo.id);
  const rows = ids.length
    ? await selectRepos(env.DB, actor.id).where("r.id", "in", ids).execute()
    : [];
  for (const repo of checkpoint.repos) {
    const row = rows.find((r) => r.id === repo.id);
    const role = row ? roleFor(row, actor) : "none";
    if (!row || !atLeast(role, "read"))
      fail("not_found", `No repository ${repo.owner}/${repo.name}.`, 404);
    if (!atLeast(role, "write"))
      fail(
        "forbidden",
        `Reviving a preview needs write access to ${row.owner_slug}/${row.name}.`,
        403,
      );
  }
}

/**
 * A checkpoint with its commits' CI runs, its previews and the timeline's wiki
 * pages written for it (CORE-84), as they are now.
 */
export async function view(
  env: Env,
  state: CheckpointState,
  timeline: Timeline,
): Promise<CheckpointView> {
  const kdb = db(env.DB);
  const { checkpoint } = state;
  const runs = (
    await Promise.all(
      checkpoint.repos.map((repo) =>
        kdb
          .selectFrom("ci_runs")
          .select(["repo_id", "number", "status", "commit_oid", "created_at", "preview_action"])
          .where("repo_id", "=", repo.id)
          .where("commit_oid", "=", repo.commit)
          .orderBy("number", "desc")
          .limit(RUNS_PER_COMMIT)
          .execute(),
      ),
    )
  )
    .flat()
    .map((run) => ({
      repoId: run.repo_id,
      number: run.number,
      status: run.status,
      commit: run.commit_oid,
      createdAt: run.created_at,
      preview: run.preview_action,
    }));
  // Recorded for this checkpoint, or for one of its commits in the timeline's
  // environment before checkpoints were named (the preview contract, CORE-79).
  const commits = checkpoint.repos.map((repo) => repo.commit);
  const previews = await kdb
    .selectFrom("deployments")
    .select([
      "id",
      "repo_id",
      "environment",
      "url",
      "status",
      "commit_oid",
      "revived",
      "rebuilt_from",
      "expires_at",
      "torn_down_at",
      "created_at",
    ])
    .where((eb) =>
      eb.or([
        eb("checkpoint_id", "=", checkpoint.id),
        eb.and([
          eb("timeline_id", "=", timeline.id),
          eb("checkpoint_id", "is", null),
          eb("commit_oid", "in", commits),
        ]),
      ]),
    )
    .orderBy("id", "desc")
    .limit(PREVIEWS)
    .execute();
  const knowledge = await checkpointSets(
    env.DB,
    checkpoint.id,
    checkpoint.repos.map((repo) => repo.id),
    `refs/heads/${timelineBookmark(timeline.slug)}`,
  );
  return {
    ...state,
    timeline: {
      id: timeline.id,
      slug: timeline.slug,
      name: timeline.name,
      policy: timeline.policy,
    },
    runs,
    previews: previews.map((p) => ({
      repoId: p.repo_id,
      id: p.id,
      environment: p.environment,
      url: p.url,
      status: p.status,
      commit: p.commit_oid,
      revived: p.revived === 1,
      rebuiltFrom: p.rebuilt_from,
      expiresAt: p.expires_at,
      tornDownAt: p.torn_down_at,
      createdAt: p.created_at,
    })),
    knowledge,
  };
}

/** Repositories in an account the actor may write to: who may approve a checkpoint there. */
export async function writableRepoIds(
  d1: D1Database,
  actor: Actor,
  ownerId: string,
): Promise<string[]> {
  const rows = await selectRepos(d1, actor.id).where("r.owner_id", "=", ownerId).execute();
  return rows.filter((row) => atLeast(roleFor(row, actor), "write")).map((row) => row.id);
}
