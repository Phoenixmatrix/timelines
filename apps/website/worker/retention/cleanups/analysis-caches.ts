// Analysis caches (Instance category "analysis-caches", CORE-201): cached file
// analyses (kg_blob_analysis) and syntheses (kg_synthesis) no build has used
// for `days` before the run's moment. Both caches are keyed by content, not
// repository, so this is an Instance category.
//
// "Used" is `used_at`, which builds record cheaply (worker/knowledge/
// cache-use.ts: at most once a day per entry; null counts as USED_SINCE).
// Never, whatever `used_at` says:
// - an analysis of a file in any repository's current build or a running
//   build (kg_files, any snapshot) under the current analyzer: the next
//   build reads it;
// - a synthesis used at or after the start of the oldest current (or
//   running) build, less a day for the refresh granularity: every build reads
//   all of its syntheses through `cached`, so an entry a current build
//   references was stamped no earlier than that. While a repository has a
//   graph without a known current build, no synthesis is removed.
// A removed entry is analyzed or synthesized again when a build next needs
// it; the rest are reused as before.
//
// Analyses first, then syntheses: the cursor is "a <blob> <analyzer>" or
// "s <key>". Each table's predicate serves both its select and its remove.

import { ANALYZER } from "../../knowledge/analyze.ts";
import { USE_REFRESH_MS, USED_SINCE } from "../../knowledge/cache-use.ts";
import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";

type Item =
  | { table: "analysis"; blob: string; analyzer: string; bytes: number }
  | { table: "synthesis"; key: string; bytes: number };

/** Parameters: USED_SINCE, cutoff, ANALYZER. `a` is the analysis. */
const ANALYSIS = `coalesce(a.used_at, ?) < ?
  AND NOT (a.analyzer = ? AND a.blob_oid IN (SELECT blob_oid FROM kg_files))`;

/** Parameters: USED_SINCE, the earlier of the cutoff and the floor. `s` is the synthesis. */
const SYNTHESIS = `coalesce(s.used_at, ?) < ?`;

function cutoff(ctx: CleanupContext): string {
  if (ctx.target.kind !== "instance") throw new Error("analysis-caches is an Instance category.");
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error("analysis-caches needs its days threshold.");
  return daysBefore(ctx.now, days);
}

/**
 * The time before which no current or running build can have used a
 * synthesis: the oldest such build's start, less the refresh granularity.
 * "" (nothing is older) while a repository's graph has no known build.
 */
export async function synthesisFloor(d1: D1Database): Promise<string> {
  const row = await d1
    .prepare(
      `SELECT
         (SELECT count(*) FROM kg_state s
          WHERE s.indexed_commit IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM kg_builds b WHERE b.id = s.last_build_id)) AS unknown,
         (SELECT min(b.started_at) FROM kg_state s JOIN kg_builds b ON b.id = s.last_build_id
          WHERE s.indexed_commit IS NOT NULL) AS current,
         (SELECT min(started_at) FROM kg_builds WHERE status = 'running') AS running`,
    )
    .first<{ unknown: number; current: string | null; running: string | null }>();
  if (!row || row.unknown > 0) return "";
  const oldest = [row.current, row.running].filter((t): t is string => t !== null).sort()[0];
  if (!oldest) return "￿"; // No builds at all: nothing to protect.
  return new Date(Date.parse(oldest) - USE_REFRESH_MS).toISOString();
}

async function synthesisCutoff(ctx: CleanupContext): Promise<string> {
  const days = cutoff(ctx);
  const floor = await synthesisFloor(ctx.env.DB);
  return floor < days ? floor : days;
}

const analysisBytes = `(100 + length(a.blob_oid) + length(a.data))`;
const synthesisBytes = `(100 + length(s.key) + length(s.data))`;

export const analysisCaches: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const before = cutoff(ctx);
    if (cursor === null || cursor.startsWith("a ")) {
      const [, blob = "", analyzer = ""] = cursor?.split(" ") ?? [];
      const { results } = await ctx.env.DB.prepare(
        `SELECT a.blob_oid AS blob, a.analyzer, ${analysisBytes} AS bytes FROM kg_blob_analysis a
         WHERE ${ANALYSIS} AND (a.blob_oid, a.analyzer) > (?, ?)
         ORDER BY a.blob_oid, a.analyzer LIMIT ?`,
      )
        .bind(USED_SINCE, before, ANALYZER, blob, analyzer, ctx.limit)
        .all<{ blob: string; analyzer: string; bytes: number }>();
      const last = results.at(-1);
      return {
        items: results.map((r) => ({ table: "analysis" as const, ...r })),
        // The analyses done, syntheses next.
        next: results.length < ctx.limit || !last ? "s " : `a ${last.blob} ${last.analyzer}`,
        bytes: results.reduce((sum, r) => sum + r.bytes, 0),
      };
    }
    const after = cursor.slice(2);
    const { results } = await ctx.env.DB.prepare(
      `SELECT s.key, ${synthesisBytes} AS bytes FROM kg_synthesis s
       WHERE ${SYNTHESIS} AND s.key > ? ORDER BY s.key LIMIT ?`,
    )
      .bind(USED_SINCE, await synthesisCutoff(ctx), after, ctx.limit)
      .all<{ key: string; bytes: number }>();
    return {
      items: results.map((r) => ({ table: "synthesis" as const, ...r })),
      next: results.length < ctx.limit ? null : `s ${results.at(-1)!.key}`,
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const analyses = items.flatMap((i) => (i.table === "analysis" ? [[i.blob, i.analyzer]] : []));
    const syntheses = items.flatMap((i) => (i.table === "synthesis" ? [i.key] : []));
    const rows: { bytes: number }[] = [];
    if (analyses.length) {
      const { results } = await ctx.env.DB.prepare(
        `DELETE FROM kg_blob_analysis AS a
         WHERE (a.blob_oid, a.analyzer) IN
               (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]') FROM json_each(?))
           AND ${ANALYSIS}
         RETURNING 100 + length(blob_oid) + length(data) AS bytes`,
      )
        .bind(JSON.stringify(analyses), USED_SINCE, cutoff(ctx), ANALYZER)
        .all<{ bytes: number }>();
      rows.push(...results);
    }
    if (syntheses.length) {
      const { results } = await ctx.env.DB.prepare(
        `DELETE FROM kg_synthesis AS s
         WHERE s.key IN (SELECT value FROM json_each(?)) AND ${SYNTHESIS}
         RETURNING 100 + length(key) + length(data) AS bytes`,
      )
        .bind(JSON.stringify(syntheses), USED_SINCE, await synthesisCutoff(ctx))
        .all<{ bytes: number }>();
      rows.push(...results);
    }
    return { count: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0) };
  },
};
