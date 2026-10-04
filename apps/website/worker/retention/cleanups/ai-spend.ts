// AI spend records (site category "ai-spend", CORE-201): per-call Atlas spend
// rows (atlas_spend) of UTC days that ended more than `days` before the run's
// moment, rolled up into one atlas_spend_daily row per account and day.
//
// Budget checks add a day's atlas_spend_daily row to that day's atlas_spend
// rows (worker/knowledge/budget.ts), so a rolled-up day answers exactly as it
// did: same cost, and a released call still counts as no call. Never: rows of
// the days inside the period (per-run caps read those), reservations still in
// flight (`reserved`), and the daily totals themselves. A build's own spend
// (atlasRunSpend) reads per-call rows, so a rolled-up run shows no detail.
//
// An item is one account's day; its count is the per-call rows it folds into
// one. Removing re-checks the predicate, adds the rows to the day's total
// (creating it, or adding to it if part of the day was rolled up earlier) and
// deletes them, in one transaction: run twice, the second finds nothing.
// Cursor: "<account id> <day>".

import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";

interface Item {
  account: string;
  day: string;
  rows: number;
  bytes: number;
}

/** Parameter: the first day kept (YYYY-MM-DD). `s` is the spend row. */
const MATCHES = `s.day < ? AND s.status <> 'reserved'`;

/** A spend row's estimated stored size (`p`: the row's qualifier, if any). */
const rowBytes = (p = "") => `(160 + length(${p}id) + length(${p}account_id) + length(${p}run_id)
  + coalesce(length(${p}repo_id), 0) + length(${p}purpose) + length(${p}model))`;

function firstKept(ctx: CleanupContext): string {
  if (ctx.target.scope !== "site") throw new Error("ai-spend is a site category.");
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error("ai-spend needs its days threshold.");
  // Whole days only: the day the cutoff falls in keeps its per-call rows.
  return daysBefore(ctx.now, days).slice(0, 10);
}

/** The items as a subquery's (account, day) pairs. */
const CHOSEN = `(s.account_id, s.day) IN
  (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))`;

export const aiSpend: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const day = firstKept(ctx);
    const space = cursor?.indexOf(" ") ?? -1;
    const [account, after] =
      cursor && space > 0 ? [cursor.slice(0, space), cursor.slice(space + 1)] : ["", ""];
    const { results } = await ctx.env.DB.prepare(
      `SELECT s.account_id AS account, s.day, count(*) AS rows, sum(${rowBytes("s.")}) AS bytes
       FROM atlas_spend s
       WHERE ${MATCHES} AND (s.account_id, s.day) > (?, ?)
       GROUP BY s.account_id, s.day ORDER BY s.account_id, s.day LIMIT ?`,
    )
      .bind(day, account, after, ctx.limit)
      .all<Item>();
    const last = results.at(-1);
    return {
      items: results,
      next: results.length < ctx.limit || !last ? null : `${last.account} ${last.day}`,
      count: results.reduce((sum, r) => sum + r.rows, 0),
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    if (!items.length) return { count: 0, bytes: 0 };
    const day = firstKept(ctx);
    const keys = JSON.stringify(items.map((i) => [i.account, i.day]));
    const [, deleted] = await ctx.env.DB.batch<{ bytes: number }>([
      ctx.env.DB.prepare(
        `INSERT INTO atlas_spend_daily
           (account_id, day, calls, input_tokens, output_tokens, cost_micro_usd, rolled_up_at)
         SELECT s.account_id, s.day, sum(s.status <> 'released'), sum(s.input_tokens),
                sum(s.output_tokens), sum(s.cost_micro_usd), ?
         FROM atlas_spend s WHERE ${CHOSEN} AND ${MATCHES}
         GROUP BY s.account_id, s.day
         ON CONFLICT (account_id, day) DO UPDATE SET
           calls = calls + excluded.calls,
           input_tokens = input_tokens + excluded.input_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           cost_micro_usd = cost_micro_usd + excluded.cost_micro_usd,
           rolled_up_at = excluded.rolled_up_at`,
      ).bind(ctx.now.toISOString(), keys, day),
      ctx.env.DB.prepare(
        `DELETE FROM atlas_spend AS s WHERE ${CHOSEN} AND ${MATCHES}
         RETURNING ${rowBytes()} AS bytes`,
      ).bind(keys, day),
    ]);
    const rows = deleted?.results ?? [];
    return { count: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0) };
  },
};
