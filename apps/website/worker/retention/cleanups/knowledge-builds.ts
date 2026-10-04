// Knowledge build history (category "knowledge-builds", CORE-201): an
// account's knowledge build records (kg_builds) older than `days` before the
// run's moment, with their change lists (kg_changes), keeping the latest
// `keepLatest` builds of each repository.
//
// Never: the build behind a repository's current graph and wiki
// (kg_state.last_build_id) or any Atlas snapshot still kept (its vector names
// the build); running builds; the latest `keepLatest` builds of each
// repository. Graph, wiki and Atlas rows are never touched: only the history
// of how they were built. A build's age is when it finished, else started.
//
// One SQL predicate serves both select and remove. Cursor: the last build id.

import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";

interface Item {
  id: string;
  rows: number;
  bytes: number;
}

/** Builds per batch at most: each carries its change list. */
const MAX_BUILDS = 50;

/** Parameters: account id, cutoff, keepLatest - 1. `b` is the build. */
const MATCHES = `b.repo_id IN (SELECT id FROM repos WHERE owner_id = ?)
  AND b.status <> 'running'
  AND coalesce(b.finished_at, b.started_at) < ?
  AND (SELECT n.id FROM kg_builds n
       WHERE n.repo_id = b.repo_id AND n.started_at > b.started_at
       ORDER BY n.started_at LIMIT 1 OFFSET ?) IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM kg_state s WHERE s.repo_id = b.repo_id AND s.last_build_id = b.id)
  AND NOT EXISTS (SELECT 1 FROM atlas_snapshots a, json_each(a.vector) v
                  WHERE a.scope = 'repo:' || b.repo_id AND a.status <> 'expired'
                    AND json_extract(v.value, '$.buildId') = b.id)`;

/** A build's rows (itself and its changes) and their estimated bytes. */
const SIZE = `1 + (SELECT count(*) FROM kg_changes c WHERE c.repo_id = b.repo_id AND c.build_id = b.id)
    AS rows,
  160 + length(b.stats) + coalesce(length(b.error), 0)
    + coalesce((SELECT sum(60 + length(c.node_id) + length(c.kind)) FROM kg_changes c
                WHERE c.repo_id = b.repo_id AND c.build_id = b.id), 0)
    AS bytes`;

function scope(ctx: CleanupContext): [string, string, number] {
  if (ctx.target.scope !== "account") throw new Error("knowledge-builds is an account category.");
  const { days, keepLatest } = ctx.thresholds;
  if (days === undefined || keepLatest === undefined)
    throw new Error("knowledge-builds needs its days and keepLatest thresholds.");
  return [ctx.target.accountId, daysBefore(ctx.now, days), keepLatest - 1];
}

export const knowledgeBuilds: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [account, cutoff, offset] = scope(ctx);
    const limit = Math.min(ctx.limit, MAX_BUILDS);
    const { results } = await ctx.env.DB.prepare(
      `SELECT b.id, ${SIZE} FROM kg_builds b
       WHERE ${MATCHES} AND b.id > ? ORDER BY b.id LIMIT ?`,
    )
      .bind(account, cutoff, offset, cursor ?? "", limit)
      .all<Item>();
    return {
      items: results,
      next: results.length < limit ? null : results.at(-1)!.id,
      count: results.reduce((sum, r) => sum + r.rows, 0),
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const [account, cutoff, offset] = scope(ctx);
    const ids = JSON.stringify(items.map((i) => i.id));
    const matching = `SELECT b.id FROM kg_builds b
      WHERE b.id IN (SELECT value FROM json_each(?)) AND ${MATCHES}`;
    // One transaction: measure what still matches, delete its changes, then
    // the builds (re-checked once more).
    const [sizes, , deleted] = await ctx.env.DB.batch<{ id: string; rows: number; bytes: number }>([
      ctx.env.DB.prepare(
        `SELECT b.id, ${SIZE} FROM kg_builds b
         WHERE b.id IN (SELECT value FROM json_each(?)) AND ${MATCHES}`,
      ).bind(ids, account, cutoff, offset),
      ctx.env.DB.prepare(
        `DELETE FROM kg_changes WHERE build_id IN (${matching})
           AND repo_id IN (SELECT id FROM repos WHERE owner_id = ?)`,
      ).bind(ids, account, cutoff, offset, account),
      ctx.env.DB.prepare(
        `DELETE FROM kg_builds AS b
         WHERE b.id IN (SELECT value FROM json_each(?)) AND ${MATCHES}
         RETURNING id`,
      ).bind(ids, account, cutoff, offset),
    ]);
    const gone = new Set((deleted?.results ?? []).map((r) => r.id));
    const removed = (sizes?.results ?? []).filter((r) => gone.has(r.id));
    return {
      count: removed.reduce((sum, r) => sum + r.rows, 0),
      bytes: removed.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
};
