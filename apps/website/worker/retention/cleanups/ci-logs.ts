// CI logs (category "ci-logs", CORE-200): the log text of an account's CI
// jobs that finished more than `days` before the run's moment.
//
// An item is a job with log chunks left; its count is its chunks and its
// bytes their text. Removing deletes the chunks and marks the job
// (`ci_jobs.logs_removed_at`), so the run page and `gm runs logs` say the log
// was removed by retention instead of showing it empty. Never: logs of
// pending, queued or running jobs, and the run, job and step records (the
// "ci-runs" category removes those).
//
// One SQL predicate serves both select and remove. Cursor: the last job id.

import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";

interface Item {
  id: string;
  chunks: number;
  bytes: number;
}

/** Jobs per batch at most: a job's log can run to many 64 KiB chunks. */
const MAX_JOBS = 50;

/** Parameters: account id, cutoff. `j` is the job. */
const FINISHED = `j.repo_id IN (SELECT id FROM repos WHERE owner_id = ?)
  AND j.status NOT IN ('pending', 'queued', 'running')
  AND j.finished_at IS NOT NULL AND j.finished_at < ?`;

const MATCHES = `${FINISHED} AND EXISTS (SELECT 1 FROM ci_logs l WHERE l.job_id = j.id)`;

function scope(ctx: CleanupContext): [string, string] {
  if (ctx.target.scope !== "account") throw new Error("ci-logs is an account category.");
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error("ci-logs needs its days threshold.");
  return [ctx.target.accountId, daysBefore(ctx.now, days)];
}

export const ciLogs: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [account, cutoff] = scope(ctx);
    const limit = Math.min(ctx.limit, MAX_JOBS);
    const { results } = await ctx.env.DB.prepare(
      `SELECT j.id,
              (SELECT count(*) FROM ci_logs l WHERE l.job_id = j.id) AS chunks,
              (SELECT coalesce(sum(length(CAST(l.text AS BLOB))), 0)
                 FROM ci_logs l WHERE l.job_id = j.id) AS bytes
       FROM ci_jobs j
       WHERE ${MATCHES} AND j.id > ? ORDER BY j.id LIMIT ?`,
    )
      .bind(account, cutoff, cursor ?? "", limit)
      .all<Item>();
    return {
      items: results,
      next: results.length < limit ? null : results.at(-1)!.id,
      count: results.reduce((sum, r) => sum + r.chunks, 0),
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const [account, cutoff] = scope(ctx);
    const ids = JSON.stringify(items.map((i) => i.id));
    // One transaction: mark the jobs that still match, then delete their
    // chunks. Run again, it finds nothing left to mark or delete.
    const [, deleted] = await ctx.env.DB.batch<{ bytes: number }>([
      ctx.env.DB.prepare(
        `UPDATE ci_jobs AS j SET logs_removed_at = ?
         WHERE j.id IN (SELECT value FROM json_each(?)) AND ${MATCHES}`,
      ).bind(ctx.now.toISOString(), ids, account, cutoff),
      ctx.env.DB.prepare(
        `DELETE FROM ci_logs
         WHERE job_id IN (SELECT j.id FROM ci_jobs j
                          WHERE j.id IN (SELECT value FROM json_each(?))
                            AND j.logs_removed_at IS NOT NULL AND ${FINISHED})
         RETURNING length(CAST(text AS BLOB)) AS bytes`,
      ).bind(ids, account, cutoff),
    ]);
    const rows = deleted?.results ?? [];
    return { count: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0) };
  },
};
