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
import { resolveTimelineSource } from "./sources.ts";
import {
  admittedReceipts,
  RevisionMetadata,
  revisionClosure,
  validateMergeEdges,
} from "./integration.ts";
import type { SourceDependency } from "../../shared/code-source.ts";
import { pinSourceRoot } from "../retention/work-sources.ts";

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
  syncMain = false,
): Promise<CheckpointRepo[]> {
  const ids = timeline.repos.map((repo) => repo.id);
  const rows = ids.length
    ? await selectRepos(env.DB, actor.id).where("r.id", "in", ids).execute()
    : [];
  if (timeline.migrationState === "frozen")
    fail("migration_required", "Migration is in progress.", 409);
  return Promise.all(
    timeline.repos.map(async (repo): Promise<CheckpointRepo> => {
      const row = rows.find((r) => r.id === repo.id);
      const role = row ? roleFor(row, actor) : "none";
      if (!row || !atLeast(role, "read"))
        fail("not_found", `No repository ${repo.space}/${repo.name}.`, 404);
      if (!atLeast(role, "write"))
        fail("forbidden", `A checkpoint needs write access to ${row.space_slug}/${row.name}.`, 403);
      const physical = await resolveTimelineSource(env, row, repo);
      const bookmark = physical.source.ref;
      const refs = await lsRefs(env, physical.repo.artifacts_name, physical.repo.artifacts_remote);
      const commit = refs.find((ref) => ref.name === bookmark)?.oid;
      if (!commit) fail("no_bookmark", `${row.space_slug}/${row.name} has no ${bookmark}.`, 409);
      const canonicalRefs = await lsRefs(env, row.artifacts_name, row.artifacts_remote);
      const base =
        canonicalRefs.find((ref) => ref.name === `refs/heads/${row.default_branch}`)?.oid ?? null;
      using objects = await env.ARTIFACTS.get(physical.repo.artifacts_name);
      const metadata = new RevisionMetadata();
      const readCommit = metadata.reader(physical.repo.artifacts_name, objects);
      const readParents = async (oid: string) => (await readCommit(oid))?.parents ?? null;
      const snapshot = await readCommit(commit);
      if (!snapshot || !repo.logicalBase)
        fail("invalid_source", "The source snapshot or logical base is unavailable.", 409);
      const dependencies: SourceDependency[] = [...(repo.dependencies ?? [])];
      const baseMembers = await revisionClosure(repo.logicalBase.commit, readParents);
      using canonicalObjects = base ? await env.ARTIFACTS.get(row.artifacts_name) : null;
      const readCanonical = canonicalObjects
        ? metadata.reader(row.artifacts_name, canonicalObjects)
        : null;
      const canonical =
        base && readCanonical
          ? await revisionClosure(base, async (oid) => (await readCanonical(oid))?.parents ?? null)
          : new Set<string>();
      const visited = new Set<string>();
      const pending = [commit];
      let containsMain = false;
      while (pending.length) {
        const oid = pending.pop()!;
        if (syncMain && oid === base) containsMain = true;
        if (visited.has(oid) || baseMembers.has(oid)) continue;
        visited.add(oid);
        const value = await readCommit(oid);
        if (!value) fail("blocked_dependency", "A source ancestor is unavailable.", 409);
        pending.push(...value.parents);
        // Origins record first observation, not exclusive ownership. An exact
        // current-canonical ancestor is not an inferred foreign dependency.
        if (canonical.has(oid)) continue;
        const owner = await db(env.DB)
          .selectFrom("source_revision_origins as origin")
          .innerJoin("timeline_work_sources as s", "s.source_id", "origin.source_id")
          .selectAll("s")
          .where("origin.repo_id", "=", row.id)
          .where("s.repo_id", "=", row.id)
          .where("origin.commit_oid", "=", oid)
          .where("origin.source_id", "!=", physical.source.sourceId)
          .executeTakeFirst();
        if (!owner) continue;
        if (
          !dependencies.some(
            (dependency) =>
              dependency.source.sourceId === owner.source_id && dependency.source.commit === oid,
          )
        )
          dependencies.push({
            source: {
              sourceId: owner.source_id,
              repoId: row.id,
              kind: "timeline-work",
              timelineId: owner.timeline_id,
              ref: owner.work_ref,
              commit: oid,
              tree: value.treeHash,
            },
            base: {
              sourceId: owner.fork_source_id,
              repoId: row.id,
              kind: owner.fork_source_id === "canonical" ? "canonical" : "timeline-work",
              timelineId: null,
              ref: owner.fork_ref,
              commit: owner.fork_commit,
              tree: owner.fork_tree,
            },
          });
        // This exact imported snapshot covers its full ancestry, including
        // older foreign revisions. Provenance outlives the source's objects.
        for (const member of await revisionClosure(oid, readParents)) visited.add(member);
      }
      // Select only from snapshots actually imported into this source, never
      // from a parent's newer landing tip. Persist this choice in the checkpoint.
      let logicalBase = repo.logicalBase;
      if (syncMain) {
        if (logicalBase.kind !== "canonical" || dependencies.length)
          fail(
            "blocked_dependency",
            "Explicit main synchronization needs a canonical-rooted source without dependencies.",
            409,
          );
        if (!base || !readCanonical || !canonical.has(logicalBase.commit) || !containsMain)
          fail(
            "blocked_dependency",
            "Merge and push current main before explicitly renewing the checkpoint base.",
            409,
          );
        const main = await readCanonical(base);
        if (!main) fail("invalid_source", "The canonical snapshot is unavailable.", 409);
        logicalBase = {
          sourceId: "canonical",
          repoId: row.id,
          kind: "canonical",
          timelineId: null,
          ref: `refs/heads/${row.default_branch}`,
          commit: base,
          tree: main.treeHash,
        };
      } else if (
        base &&
        dependencies.some((dependency) => !baseMembers.has(dependency.source.commit))
      ) {
        const snapshots = [logicalBase, ...dependencies.map((dependency) => dependency.source)];
        const foreign = snapshots.filter(
          (source) =>
            source.kind === "timeline-work" && source.sourceId !== physical.source.sourceId,
        );
        let uniquelyAdmitted = true;
        for (const source of foreign)
          if ((await admittedReceipts(env, source, canonical)).length !== 1)
            uniquelyAdmitted = false;
        const candidates = new Map<string, typeof logicalBase>();
        for (const source of foreign) {
          const closure = await revisionClosure(source.commit, readParents);
          if (snapshots.every((snapshot) => closure.has(snapshot.commit)))
            candidates.set(`${source.sourceId}:${source.commit}`, source);
        }
        // Unproved imports still belong in the checkpoint's dependency record.
        // Preserve B so landing can report its admission/closure blocker; only a
        // fresh checkpoint after proof exists may select a different baseline.
        if (uniquelyAdmitted && candidates.size === 1)
          logicalBase = candidates.values().next().value!;
      }
      try {
        await validateMergeEdges(
          env,
          physical.source,
          commit,
          logicalBase.commit,
          dependencies.map((dependency) => dependency.source.commit),
          readParents,
          canonical,
        );
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("blocked_dependency:"))
          throw error;
        fail("blocked_dependency", error.message, 409);
      }
      for (const dependency of dependencies)
        if (dependency.source.sourceId !== physical.source.sourceId)
          await pinSourceRoot(env, {
            repoId: row.id,
            sourceId: dependency.source.sourceId,
            consumerKind: "dependency",
            consumerId: timeline.id,
            commit: dependency.source.commit,
          });
      const changes = await db(env.DB)
        .selectFrom("change_refs")
        .select(["change_id", "last_commit_oid"])
        .where("repo_id", "=", row.id)
        .where("source_id", "=", physical.source.sourceId)
        .where("ref", "=", bookmark)
        .orderBy("last_seen_at", "desc")
        .orderBy("change_id")
        .limit(CHECKPOINT_CHANGES)
        .execute();
      return {
        id: row.id,
        space: row.space_slug,
        name: row.name,
        commit,
        base,
        source: { ...physical.source, commit, tree: snapshot.treeHash },
        logicalBase,
        dependencies,
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
      fail("not_found", `No repository ${repo.space}/${repo.name}.`, 404);
    if (!atLeast(role, "write"))
      fail(
        "forbidden",
        `Reviving a preview needs write access to ${row.space_slug}/${row.name}.`,
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
          .where("source_id", "=", repo.source?.sourceId ?? "canonical")
          .where("commit_oid", "=", repo.commit)
          .where("step", "=", 0)
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
      status: timeline.status,
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

/** Repositories in a Space the actor may write to: who may approve a checkpoint there. */
export async function writableRepoIds(
  d1: D1Database,
  actor: Actor,
  ownerId: string,
): Promise<string[]> {
  const rows = await selectRepos(d1, actor.id).where("r.space_id", "=", ownerId).execute();
  return rows.filter((row) => atLeast(roleFor(row, actor), "write")).map((row) => row.id);
}
