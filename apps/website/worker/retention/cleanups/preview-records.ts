// Expired preview deployment records (category "preview-records"): the
// engine's reference cleanup (CORE-198); copy its shape for new categories.
//
// Selects, in an Space's repositories, deployment records the preview sweep
// expired more than `days` before the run's moment (by when it was torn down,
// else its expiry, else its last change). Never: live, sleeping or failed
// records (production's included; only previews expire), a record a live
// revived preview was rebuilt from, or one a queued or running preview run
// rebuilds from.
//
// One SQL predicate serves both select and remove, so removal re-checks it:
// a record revived or changed since select stays. Cursor: the last id.

import type { CategoryCleanup } from "../engine.ts";
import { daysBefore } from "../engine.ts";

interface Item {
  id: number;
  bytes: number;
}

/** A row's estimated size: its text, plus a fixed allowance for the row and its indexes. */
const bytes = (d: string) => `(160 + length(${d}environment) + length(${d}commit_oid)
  + coalesce(length(${d}timeline_slug), 0) + coalesce(length(${d}timeline_id), 0)
  + coalesce(length(${d}checkpoint_id), 0) + coalesce(length(${d}url), 0)
  + coalesce(length(${d}run_id), 0) + coalesce(length(${d}job_id), 0))`;

/** Parameters: account id, cutoff. */
const MATCHES = `d.status = 'expired'
  AND d.repo_id IN (SELECT id FROM repos WHERE space_id = ?)
  AND coalesce(d.torn_down_at, d.expires_at, d.updated_at) < ?
  AND NOT EXISTS (SELECT 1 FROM deployments l
                  WHERE l.rebuilt_from = d.id AND l.status IN ('active', 'sleeping'))
  AND NOT EXISTS (SELECT 1 FROM ci_runs r
                  WHERE r.preview_rebuilt_from = d.id AND r.status IN ('queued', 'running'))`;

function scope(ctx: Parameters<CategoryCleanup["select"]>[0]): [string, string] {
  if (ctx.target.kind !== "space") throw new Error("preview-records is a Space category.");
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error("preview-records needs its days threshold.");
  return [ctx.target.id, daysBefore(ctx.now, days)];
}

export const previewRecords: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [account, cutoff] = scope(ctx);
    const { results } = await ctx.env.DB.prepare(
      `SELECT d.id, ${bytes("d.")} AS bytes FROM deployments d
       WHERE ${MATCHES} AND d.id > ? ORDER BY d.id LIMIT ?`,
    )
      .bind(account, cutoff, cursor === null ? 0 : Number(cursor), ctx.limit)
      .all<Item>();
    return {
      items: results,
      next: results.length < ctx.limit ? null : String(results.at(-1)!.id),
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const [account, cutoff] = scope(ctx);
    const { results } = await ctx.env.DB.prepare(
      `DELETE FROM deployments AS d
       WHERE d.id IN (SELECT value FROM json_each(?)) AND ${MATCHES}
       RETURNING ${bytes("")} AS bytes`,
    )
      .bind(JSON.stringify(items.map((i) => i.id)), account, cutoff)
      .all<{ bytes: number }>();
    return { count: results.length, bytes: results.reduce((sum, r) => sum + r.bytes, 0) };
  },
};
