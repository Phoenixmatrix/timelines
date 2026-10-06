import type { Timeline, TimelineRepo } from "../../shared/timelines.ts";
import type { SourceSnapshot, SourceDependency } from "../../shared/code-source.ts";
import { selectRepos, type RepoRow } from "../db.ts";
import { lsRefs } from "../artifacts.ts";
import { trackerObject } from "../tracker/stub.ts";
import type { TrackerReply } from "../tracker/object.ts";
import { TrackerError } from "../tracker/store.ts";
import { canonicalSource, ensureWorkSource } from "./sources.ts";
import { writeRefs } from "./bookmarks.ts";
import { pinSourceRoot } from "../retention/work-sources.ts";

interface FrozenRepo {
  entry: TimelineRepo;
  head: SourceSnapshot;
  base: SourceSnapshot;
  dependencies: SourceDependency[];
}
interface MigrationRow {
  state: "frozen" | "ready" | "cleaned";
  input: string;
  output: string | null;
}
function unwrap<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new TrackerError(reply.status, reply.code, reply.error);
  return reply.value;
}
async function repository(env: Env, id: string): Promise<RepoRow> {
  const row = await selectRepos(env.DB, "").where("r.id", "=", id).executeTakeFirst();
  if (!row)
    throw new TrackerError(
      404,
      "not_found",
      "Migration repository was deleted; it cannot be resurrected.",
    );
  return row;
}
async function snapshot(
  env: Env,
  repo: RepoRow,
  commit: string,
  ref: string,
): Promise<SourceSnapshot> {
  const provider = await env.ARTIFACTS.get(repo.artifacts_name);
  try {
    const value = await provider.readCommit(commit);
    if (!value)
      throw new TrackerError(
        409,
        "migration_required",
        `Migration commit ${commit} is unavailable.`,
      );
    return {
      ...canonicalSource(repo),
      kind: "canonical-historical",
      ref,
      commit,
      tree: value.treeHash,
    };
  } finally {
    provider[Symbol.dispose]();
  }
}

/** One finite, resumable cutover. There is never an active legacy write mode. */
export async function migrateLegacyTimeline(
  env: Env,
  ownerId: string,
  timelineId: string,
): Promise<Timeline> {
  const tracker = trackerObject(env, ownerId);
  let row = await env.DB.prepare(
    "SELECT state, input, output FROM timeline_source_migrations WHERE owner_id = ? AND timeline_id = ?",
  )
    .bind(ownerId, timelineId)
    .first<MigrationRow>();
  if (!row) {
    const current = unwrap(await tracker.timelineById(timelineId));
    if (current.repos.every((entry) => entry.source)) return current;
  }
  if (row?.state === "cleaned") return unwrap(await tracker.timelineById(timelineId));
  const timeline = unwrap(await tracker.beginLegacyMigration(timelineId));
  const ended = timeline.status === "landed" || timeline.status === "abandoned";
  if (!row) {
    const frozen: FrozenRepo[] = [];
    const parent =
      !ended && timeline.parentId ? unwrap(await tracker.timelineById(timeline.parentId)) : null;
    for (const entry of timeline.repos) {
      if (entry.source) continue;
      const repo = await repository(env, entry.id);
      const ref = `refs/heads/${entry.bookmark}`;
      const baseOid = timeline.forkPoint.commits[entry.id];
      if (!baseOid)
        throw new TrackerError(
          409,
          "migration_required",
          "Legacy timeline has no exact fork point; explicit resolution is required.",
        );
      const headOid = ended
        ? baseOid
        : (await lsRefs(env, repo.artifacts_name, repo.artifacts_remote)).find(
            (candidate) => candidate.name === ref,
          )?.oid;
      if (!headOid)
        throw new TrackerError(
          409,
          "migration_required",
          "Legacy work head is missing; explicit resolution is required.",
        );
      let base = await snapshot(env, repo, baseOid, ref);
      const dependencies: SourceDependency[] = [];
      if (parent) {
        const parentRepo = parent.repos.find((candidate) => candidate.id === entry.id);
        if (
          !parentRepo?.source ||
          parentRepo.source.kind !== "timeline-work" ||
          !parentRepo.logicalBase
        )
          throw new TrackerError(
            409,
            "blocked_dependency",
            "Migrate the parent first, or explicitly resolve the historical dependency before migration.",
          );
        base = { ...parentRepo.source, commit: baseOid, tree: base.tree };
        dependencies.push(
          { source: base, base: parentRepo.logicalBase },
          ...(parentRepo.dependencies ?? []),
        );
        await pinSourceRoot(env, {
          repoId: repo.id,
          sourceId: base.sourceId,
          consumerKind: "dependency",
          consumerId: timelineId,
          commit: base.commit,
        });
      }
      frozen.push({ entry, head: await snapshot(env, repo, headOid, ref), base, dependencies });
    }
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO timeline_source_migrations
      (owner_id,timeline_id,state,input,created_at,updated_at) VALUES (?,?,'frozen',?,?,?)
      ON CONFLICT(owner_id,timeline_id) DO NOTHING`)
      .bind(ownerId, timelineId, JSON.stringify(frozen), now, now)
      .run();
    row = await env.DB.prepare(
      "SELECT state,input,output FROM timeline_source_migrations WHERE owner_id=? AND timeline_id=?",
    )
      .bind(ownerId, timelineId)
      .first<MigrationRow>();
    if (!row) throw new Error("Migration input was not durably recorded.");
  }
  const frozen = JSON.parse(row.input) as FrozenRepo[];
  let repos = row.output ? (JSON.parse(row.output) as TimelineRepo[]) : timeline.repos;
  if (row.state === "frozen") {
    repos = [...timeline.repos];
    for (const input of frozen) {
      const repo = await repository(env, input.entry.id);
      const source = ended
        ? input.head
        : (
            await ensureWorkSource(env, repo, {
              timelineId,
              timelineSlug: timeline.slug,
              base: input.base,
              initialHead: input.head,
            })
          ).source;
      repos = repos.map((entry) =>
        entry.id === input.entry.id
          ? {
              ...entry,
              source,
              bookmark: ended ? entry.bookmark : "work",
              logicalBase: input.base,
              dependencies: input.dependencies,
            }
          : entry,
      );
    }
    // The allocator roots the exact work head before ready. Only then publish routing.
    await env.DB.prepare(
      "UPDATE timeline_source_migrations SET state='ready',output=?,updated_at=? WHERE owner_id=? AND timeline_id=? AND state='frozen'",
    )
      .bind(JSON.stringify(repos), new Date().toISOString(), ownerId, timelineId)
      .run();
  }
  const migrated = unwrap(await tracker.completeLegacyMigration(timelineId, repos));
  if (!ended)
    for (const input of frozen) {
      const at = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(`UPDATE kg_overlays SET ended_at=coalesce(ended_at,?),ended_reason='ended'
        WHERE repo_id=? AND source_id='canonical' AND ref=?`).bind(
          at,
          input.entry.id,
          input.head.ref,
        ),
        env.DB.prepare(`UPDATE kg_page_sets SET status='ended'
        WHERE repo_id=? AND source_id='canonical' AND ref=? AND status IN ('queued','writing')`).bind(
          input.entry.id,
          input.head.ref,
        ),
      ]);
    }
  // Never clean up ended historical refs. CAS cannot erase concurrently changed work.
  if (!ended)
    for (const input of frozen) {
      const repo = await repository(env, input.entry.id);
      const current = (await lsRefs(env, repo.artifacts_name, repo.artifacts_remote)).find(
        (candidate) => candidate.name === input.head.ref,
      )?.oid;
      if (!current) continue;
      if (current !== input.head.commit)
        throw new TrackerError(
          409,
          "migration_required",
          "Legacy head changed while frozen; resolve before cleanup.",
        );
      const result = await writeRefs(env, repo, [
        { ref: input.head.ref, old: input.head.commit, new: null },
      ]);
      if (!result[0]?.ok) throw new Error("Legacy ref cleanup did not complete; retry migration.");
    }
  await env.DB.prepare(
    "UPDATE timeline_source_migrations SET state='cleaned',updated_at=? WHERE owner_id=? AND timeline_id=?",
  )
    .bind(new Date().toISOString(), ownerId, timelineId)
    .run();
  return migrated;
}
