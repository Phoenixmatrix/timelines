// Instance categories over what metering (CORE-207) and the Durable Object
// registry (CORE-197) keep (CORE-225).
//
// "usage-history" (`days`, `months`), in two phases:
// - "m": monthly figures (`usage_monthly`) of months more than `months` ago.
// - "s": daily figures (`usage_snapshots`) older than `days`, each rolled up
//   into its month's row (sums and day counts, so totals over whole months
//   stay exactly the same; worker/usage/history.ts reads both), or dropped
//   when its month is itself past `months`. Never the latest day of a
//   (scope kind, scope ID, construct): the report's current figures.
//   Monthly rows go first, so what this run rolls up waits for a later run.
// - "ai-usage" (`days`): daily AI records (`ai_usage`) older than `days`
//   rolled up into `ai_usage_monthly` per scope kind, scope ID, feature and model.
// - "durable-registry" (`days`): `do_instances` rows of instances purged more
//   than `days` ago and not used since (a use clears `purged_at`).
//
// A roll-up and the delete of its daily rows run in one transaction, with
// the same predicate, so a batch is never counted twice and a second run
// finds nothing. Items are `<phase>:<rowid>`; cursors the last item of a
// phase, or `<next phase>:`.

import type { CategoryCleanup, CleanupContext, Selection } from "../engine.ts";
import { daysBefore } from "../engine.ts";

type Item = string;

function site(ctx: CleanupContext, id: string, ...keys: string[]): number[] {
  if (ctx.target.kind !== "instance") throw new Error(`${id} is an Instance category.`);
  return keys.map((key) => {
    const value = ctx.thresholds[key];
    if (value === undefined) throw new Error(`${id} needs its ${key} threshold.`);
    return value;
  });
}

/** The UTC day `days` before the run (YYYY-MM-DD): days before it are past the policy. */
const dayCutoff = (now: Date, days: number) => daysBefore(now, days).slice(0, 10);

/** The UTC month `months` before the run's month (YYYY-MM). */
function monthCutoff(now: Date, months: number): string {
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1));
  return month.toISOString().slice(0, 7);
}

function parse(cursor: string | null, phases: string[]): [string, number] {
  if (cursor === null) return [phases[0]!, 0];
  const [name, position] = cursor.split(":");
  if (!name || !phases.includes(name) || position === undefined)
    throw new Error(`Bad cursor: ${cursor}`);
  return [name, Number(position || 0)];
}

/** One page of rows of `table` (as `t`) matching `where`, after a rowid. */
async function page(
  ctx: CleanupContext,
  table: string,
  where: string,
  bytes: string,
  bindings: (string | number)[],
  [name, after]: [string, number],
  phases: string[],
): Promise<Selection<Item>> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT t.rowid AS id, ${bytes} AS bytes FROM ${table} t
     WHERE ${where} AND t.rowid > ? ORDER BY t.rowid LIMIT ?`,
  )
    .bind(...bindings, after, ctx.limit)
    .all<{ id: number; bytes: number }>();
  const next = phases[phases.indexOf(name) + 1];
  return {
    items: results.map((row) => `${name}:${row.id}`),
    next: results.length === ctx.limit ? `${name}:${results.at(-1)!.id}` : next ? `${next}:` : null,
    bytes: results.reduce((sum, row) => sum + row.bytes, 0),
  };
}

function ids(items: Item[], name: string): string {
  return JSON.stringify(
    items.filter((item) => item.startsWith(`${name}:`)).map((item) => Number(item.slice(2))),
  );
}

const total = (results: { bytes: number }[]) => ({
  count: results.length,
  bytes: results.reduce((sum, row) => sum + row.bytes, 0),
});

// ---- usage-history ---------------------------------------------------------------

const HISTORY = ["m", "s"];
const SNAPSHOT_BYTES = (t: string) =>
  `(64 + length(${t}day) + length(${t}scope_kind) + length(${t}scope_id) + length(${t}construct) + length(${t}item)
    + length(${t}metric) + length(${t}method) + length(${t}collected_at))`;
const MONTHLY_BYTES = (t: string) =>
  `(72 + length(${t}month) + length(${t}scope_kind) + length(${t}scope_id) + length(${t}construct) + length(${t}item)
    + length(${t}metric) + length(${t}method))`;
/** Daily figures past ?1, but never a scope kind, scope ID and construct's latest day. */
const PAST_DAILY = `t.day < ?1 AND t.day < (
  SELECT max(l.day) FROM usage_snapshots l
  WHERE l.scope_kind = t.scope_kind AND l.scope_id = t.scope_id AND l.construct = t.construct)`;

export const usageHistory: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [days, months] = site(ctx, "usage-history", "days", "months");
    const position = parse(cursor, HISTORY);
    if (position[0] === "m")
      return page(
        ctx,
        "usage_monthly",
        "t.month < ?",
        MONTHLY_BYTES("t."),
        [monthCutoff(ctx.now, months!)],
        position,
        HISTORY,
      );
    return page(
      ctx,
      "usage_snapshots",
      PAST_DAILY.replaceAll("?1", "?"),
      SNAPSHOT_BYTES("t."),
      [dayCutoff(ctx.now, days!)],
      position,
      HISTORY,
    );
  },
  async remove(ctx, items) {
    const [days, months] = site(ctx, "usage-history", "days", "months");
    const d1 = ctx.env.DB;
    const oldMonth = monthCutoff(ctx.now, months!);
    const monthly = await d1
      .prepare(
        `DELETE FROM usage_monthly AS t WHERE t.rowid IN (SELECT value FROM json_each(?2))
           AND t.month < ?1 RETURNING ${MONTHLY_BYTES("")} AS bytes`,
      )
      .bind(oldMonth, ids(items, "m"))
      .all<{ bytes: number }>();
    const daily = ids(items, "s");
    const matching = `t.rowid IN (SELECT value FROM json_each(?2)) AND ${PAST_DAILY}`;
    const [, removed] = await d1.batch<{ bytes: number }>([
      // Into its month (bare columns of a max() aggregate come from that latest day's row).
      d1
        .prepare(
          `INSERT INTO usage_monthly (month, scope_kind, scope_id, construct, item, metric, kind, quantity,
             days, last_day, last_quantity, estimated, method)
           SELECT substr(t.day, 1, 7), t.scope_kind, t.scope_id, t.construct, t.item, t.metric, t.kind,
             sum(t.quantity), count(*), max(t.day), t.quantity,
             CASE WHEN sum(t.estimated) > 0 THEN 1 ELSE 0 END, t.method
           FROM usage_snapshots t WHERE ${matching} AND substr(t.day, 1, 7) >= ?3
           GROUP BY substr(t.day, 1, 7), t.scope_kind, t.scope_id, t.construct, t.item, t.metric
           ON CONFLICT (month, scope_kind, scope_id, construct, item, metric) DO UPDATE SET
             quantity = usage_monthly.quantity + excluded.quantity,
             days = usage_monthly.days + excluded.days,
             last_quantity = CASE WHEN excluded.last_day > usage_monthly.last_day
               THEN excluded.last_quantity ELSE usage_monthly.last_quantity END,
             last_day = max(usage_monthly.last_day, excluded.last_day),
             estimated = max(usage_monthly.estimated, excluded.estimated)`,
        )
        .bind(dayCutoff(ctx.now, days!), daily, oldMonth),
      d1
        .prepare(
          `DELETE FROM usage_snapshots AS t WHERE ${matching}
           RETURNING ${SNAPSHOT_BYTES("")} AS bytes`,
        )
        .bind(dayCutoff(ctx.now, days!), daily),
    ]);
    const a = total(monthly.results);
    const b = total(removed!.results);
    return { count: a.count + b.count, bytes: a.bytes + b.bytes };
  },
};

// ---- ai-usage ---------------------------------------------------------------------

const AI_BYTES = (t: string) =>
  `(56 + length(${t}day) + length(${t}scope_kind) + length(${t}scope_id) + length(${t}feature) + length(${t}model))`;

export const aiUsage: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [days] = site(ctx, "ai-usage", "days");
    return page(
      ctx,
      "ai_usage",
      "t.day < ?",
      AI_BYTES("t."),
      [dayCutoff(ctx.now, days!)],
      parse(cursor, ["a"]),
      ["a"],
    );
  },
  async remove(ctx, items) {
    const [days] = site(ctx, "ai-usage", "days");
    const d1 = ctx.env.DB;
    const matching = `t.rowid IN (SELECT value FROM json_each(?2)) AND t.day < ?1`;
    const cutoff = dayCutoff(ctx.now, days!);
    const list = ids(items, "a");
    const [, removed] = await d1.batch<{ bytes: number }>([
      d1
        .prepare(
          `INSERT INTO ai_usage_monthly (month, scope_kind, scope_id, feature, model, calls, input_tokens,
             output_tokens, total_tokens, failed_calls, days)
           SELECT substr(t.day, 1, 7), t.scope_kind, t.scope_id, t.feature, t.model, sum(t.calls),
             sum(t.input_tokens), sum(t.output_tokens), sum(t.total_tokens), sum(t.failed_calls),
             count(DISTINCT t.day)
           FROM ai_usage t WHERE ${matching}
           GROUP BY substr(t.day, 1, 7), t.scope_kind, t.scope_id, t.feature, t.model
           ON CONFLICT (month, scope_kind, scope_id, feature, model) DO UPDATE SET
             calls = ai_usage_monthly.calls + excluded.calls,
             input_tokens = ai_usage_monthly.input_tokens + excluded.input_tokens,
             output_tokens = ai_usage_monthly.output_tokens + excluded.output_tokens,
             total_tokens = ai_usage_monthly.total_tokens + excluded.total_tokens,
             failed_calls = ai_usage_monthly.failed_calls + excluded.failed_calls,
             days = ai_usage_monthly.days + excluded.days`,
        )
        .bind(cutoff, list),
      d1
        .prepare(`DELETE FROM ai_usage AS t WHERE ${matching} RETURNING ${AI_BYTES("")} AS bytes`)
        .bind(cutoff, list),
    ]);
    return total(removed!.results);
  },
};

// ---- durable-registry -------------------------------------------------------------

const INSTANCE_BYTES = (t: string) =>
  `(96 + length(${t}class) + length(${t}name) + coalesce(length(${t}purge_reason), 0))`;

export const durableRegistry: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [days] = site(ctx, "durable-registry", "days");
    return page(
      ctx,
      "do_instances",
      "t.purged_at IS NOT NULL AND t.purged_at < ?",
      INSTANCE_BYTES("t."),
      [daysBefore(ctx.now, days!)],
      parse(cursor, ["r"]),
      ["r"],
    );
  },
  async remove(ctx, items) {
    const [days] = site(ctx, "durable-registry", "days");
    const { results } = await ctx.env.DB.prepare(
      `DELETE FROM do_instances AS t WHERE t.rowid IN (SELECT value FROM json_each(?2))
         AND t.purged_at IS NOT NULL AND t.purged_at < ?1
       RETURNING ${INSTANCE_BYTES("")} AS bytes`,
    )
      .bind(daysBefore(ctx.now, days!), ids(items, "r"))
      .all<{ bytes: number }>();
    return total(results);
  },
};
