// CI run history (category "ci-runs", CORE-200): an Space's CI runs older
// than `days` before the run's moment, with their jobs, steps and logs (the
// schema cascades them), keeping the latest `keepLatest` runs of each ref.
//
// Never: queued or running runs, or runs with a job still pending, queued or
// running; the latest `keepLatest` runs of each ref; landing runs (a landing
// in the tracker names its gate and merge runs); runs a deployment record
// names (recorded by, or torn down by); runs a registry publish names as its
// provenance (REGISTRY_DB, checked after the D1 predicate). A run's age is
// when it finished, else when it was created.
//
// Removing a run leaves a gap in its repository's run numbers; the run API
// reports such a number as removed by retention (worker/ci/api.ts).
//
// One SQL predicate serves both select and remove. Cursor: the last run id.

import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";

interface Item {
  id: string;
  rows: number;
  bytes: number;
}

/** Runs per batch at most: each carries its jobs, steps and log chunks. */
const MAX_RUNS = 50;

/** Parameters: account id, cutoff, keepLatest - 1. `r` is the run. */
const MATCHES = `r.repo_id IN (SELECT id FROM repos WHERE space_id = ?)
  AND r.status NOT IN ('queued', 'running')
  AND coalesce(r.finished_at, r.created_at) < ?
  AND (SELECT n.number FROM ci_runs n
       WHERE n.repo_id = r.repo_id AND n.source_id = r.source_id AND n.ref = r.ref AND n.number > r.number
       ORDER BY n.number LIMIT 1 OFFSET ?) IS NOT NULL
  AND r.landing_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM ci_jobs j
                  WHERE j.run_id = r.id
                    AND (j.status IN ('pending', 'queued', 'running') OR j.source_completion_pending = 1))
  AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.run_id = r.id)
  AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.teardown_run_id = r.id)`;

/** A run's rows (itself, jobs, steps, log chunks) and their estimated bytes. */
const SIZE = `
  1 + (SELECT count(*) FROM ci_jobs j WHERE j.run_id = r.id)
    + (SELECT count(*) FROM ci_steps s JOIN ci_jobs j ON j.id = s.job_id WHERE j.run_id = r.id)
    + (SELECT count(*) FROM ci_logs l JOIN ci_jobs j ON j.id = l.job_id WHERE j.run_id = r.id)
  AS rows,
  200 + length(r.title) + coalesce(length(r.config_error), 0)
    + coalesce((SELECT sum(200 + length(j.spec) + coalesce(length(j.error), 0))
                FROM ci_jobs j WHERE j.run_id = r.id), 0)
    + coalesce((SELECT sum(80 + length(s.name))
                FROM ci_steps s JOIN ci_jobs j ON j.id = s.job_id WHERE j.run_id = r.id), 0)
    + coalesce((SELECT sum(length(CAST(l.text AS BLOB)))
                FROM ci_logs l JOIN ci_jobs j ON j.id = l.job_id WHERE j.run_id = r.id), 0)
  AS bytes`;

function scope(ctx: CleanupContext): [string, string, number] {
  if (ctx.target.kind !== "space") throw new Error("ci-runs is a Space category.");
  const { days, keepLatest } = ctx.thresholds;
  if (days === undefined || keepLatest === undefined)
    throw new Error("ci-runs needs its days and keepLatest thresholds.");
  return [ctx.target.id, daysBefore(ctx.now, days), keepLatest - 1];
}

/** Those of `ids` a registry publish names as the run it came from. */
async function published(env: Env, ids: string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { results } = await env.REGISTRY_DB.prepare(
    `SELECT DISTINCT ci_run_id FROM publishes
     WHERE ci_run_id IN (SELECT value FROM json_each(?))`,
  )
    .bind(JSON.stringify(ids))
    .all<{ ci_run_id: string }>();
  return new Set(results.map((r) => r.ci_run_id));
}

export const ciRuns: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [account, cutoff, offset] = scope(ctx);
    const limit = Math.min(ctx.limit, MAX_RUNS);
    const { results } = await ctx.env.DB.prepare(
      `SELECT r.id, ${SIZE} FROM ci_runs r
       WHERE ${MATCHES} AND r.id > ? ORDER BY r.id LIMIT ?`,
    )
      .bind(account, cutoff, offset, cursor ?? "", limit)
      .all<Item>();
    const kept = await published(
      ctx.env,
      results.map((r) => r.id),
    );
    const items = results.filter((r) => !kept.has(r.id));
    return {
      items,
      next: results.length < limit ? null : results.at(-1)!.id,
      count: items.reduce((sum, r) => sum + r.rows, 0),
      bytes: items.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const [account, cutoff, offset] = scope(ctx);
    const kept = await published(
      ctx.env,
      items.map((i) => i.id),
    );
    const ids = JSON.stringify(items.map((i) => i.id).filter((id) => !kept.has(id)));
    // One transaction: measure the runs that still match, then delete them
    // (jobs, steps and logs cascade).
    const [sizes, , deleted] = await ctx.env.DB.batch<{ id: string; rows: number; bytes: number }>([
      ctx.env.DB.prepare(
        `SELECT r.id, ${SIZE} FROM ci_runs r
         WHERE r.id IN (SELECT value FROM json_each(?)) AND ${MATCHES}`,
      ).bind(ids, account, cutoff, offset),
      ctx.env.DB.prepare(`DELETE FROM timeline_source_roots WHERE consumer_kind = 'ci'
        AND consumer_id IN (SELECT r.id FROM ci_runs r
          WHERE r.id IN (SELECT value FROM json_each(?)) AND ${MATCHES})`).bind(
        ids,
        account,
        cutoff,
        offset,
      ),
      ctx.env.DB.prepare(
        `DELETE FROM ci_runs AS r
         WHERE r.id IN (SELECT value FROM json_each(?)) AND ${MATCHES}
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
