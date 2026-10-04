// Ended timeline data (category "ended-timeline-data", CORE-201): for each of
// an account's timelines that ended (its bookmark went: landed, abandoned or
// deleted; CORE-139) more than `days` before the run's moment, the knowledge
// overlay's changes (kg_overlay_changes), its Atlas regrouping
// (atlas_timeline_regroupings) and its wiki page sets (kg_page_sets,
// kg_page_set_pages).
//
// The overlay's row stays, emptied and marked (`kg_overlays.removed_at`), so
// the timeline view says the ended overlay was removed by retention instead
// of showing nothing. Never: data of open timelines (no `ended_at`; a
// bookmark that comes back reopens its overlay, which a new computation then
// fills), and anything of main (kg_nodes, wiki_pages, Atlas snapshots).
//
// One SQL predicate serves both select and remove. Cursor: the last
// (repository id, ref), as "<repo id> <ref>" (refs contain no spaces).

import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { daysBefore } from "../engine.ts";

interface Item {
  repo: string;
  source: string;
  ref: string;
  rows: number;
  bytes: number;
}

/** Ended timelines per batch at most: each carries its changes and pages. */
const MAX_TIMELINES = 25;

/** Parameters: account id, cutoff. `o` is the overlay row. */
const MATCHES = `o.repo_id IN (SELECT id FROM repos WHERE owner_id = ?)
  AND o.ended_at IS NOT NULL AND o.ended_at < ?
  AND o.removed_at IS NULL`;

// Pages can be requested before an overlay exists. Their archived source
// supplies the end date, so such roots do not retain a fork forever.
const OVERLAYS = `(SELECT repo_id,source_id,ref,overlay_id,stats,ended_at,removed_at FROM kg_overlays
  UNION ALL SELECT p.repo_id,p.source_id,p.ref,'','{}',s.archived_at,NULL
    FROM kg_page_sets p JOIN timeline_work_sources s ON s.source_id=p.source_id AND s.repo_id=p.repo_id
    WHERE s.state IN ('archived','purging','purged') AND s.archived_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM kg_overlays o WHERE o.repo_id=p.repo_id AND o.source_id=p.source_id AND o.ref=p.ref)
    GROUP BY p.repo_id,p.source_id,p.ref,s.archived_at)`;

const CHANGES = `FROM kg_overlay_changes c WHERE c.repo_id = o.repo_id AND c.overlay_id = o.overlay_id`;
const REGROUPING = `FROM atlas_timeline_regroupings g WHERE g.repo_id = o.repo_id AND g.overlay_id = o.overlay_id`;
const SETS = `FROM kg_page_sets p WHERE p.repo_id = o.repo_id AND p.source_id = o.source_id AND p.ref = o.ref`;
const PAGES = `FROM kg_page_set_pages p WHERE p.repo_id = o.repo_id AND p.source_id = o.source_id AND p.ref = o.ref`;

/** An ended timeline's rows (overlay changes, regrouping, page sets and pages) and their bytes. */
const SIZE = `(SELECT count(*) ${CHANGES}) + (SELECT count(*) ${REGROUPING})
    + (SELECT count(*) ${SETS}) + (SELECT count(*) ${PAGES}) AS rows,
  length(o.stats)
    + coalesce((SELECT sum(80 + length(c.node_id) + length(c.name) + coalesce(length(c.path), 0)
                           + length(c.summary) + length(c.detail)) ${CHANGES}), 0)
    + coalesce((SELECT sum(120 + coalesce(length(g.data), 0)) ${REGROUPING}), 0)
    + coalesce((SELECT sum(160 + length(p.stats) + coalesce(length(p.error), 0)) ${SETS}), 0)
    + coalesce((SELECT sum(120 + length(p.title) + length(p.body) + length(p.diagram)
                           + length(p.sources)) ${PAGES}), 0)
  AS bytes`;

function scope(ctx: CleanupContext): [string, string] {
  if (ctx.target.scope !== "account")
    throw new Error("ended-timeline-data is an account category.");
  const days = ctx.thresholds.days;
  if (days === undefined) throw new Error("ended-timeline-data needs its days threshold.");
  return [ctx.target.accountId, daysBefore(ctx.now, days)];
}

export const endedTimelineData: CategoryCleanup<Item> = {
  async select(ctx, cursor) {
    const [account, cutoff] = scope(ctx);
    const limit = Math.min(ctx.limit, MAX_TIMELINES);
    const after: string[] = cursor ? (JSON.parse(cursor) as string[]) : ["", "", ""];
    const { results } = await ctx.env.DB.prepare(
      `SELECT o.repo_id AS repo, o.source_id AS source, o.ref, ${SIZE} FROM ${OVERLAYS} o
       WHERE ${MATCHES} AND (o.repo_id, o.source_id, o.ref) > (?, ?, ?)
       ORDER BY o.repo_id, o.source_id, o.ref LIMIT ?`,
    )
      .bind(account, cutoff, after[0], after[1], after[2], limit)
      .all<Item>();
    const last = results.at(-1);
    return {
      items: results,
      next:
        results.length < limit || !last ? null : JSON.stringify([last.repo, last.source, last.ref]),
      count: results.reduce((sum, r) => sum + r.rows, 0),
      bytes: results.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
  async remove(ctx, items) {
    const [account, cutoff] = scope(ctx);
    const keys = JSON.stringify(items.map((i) => [i.repo, i.source, i.ref]));
    // The overlays of these items that still match, as a subquery over `o`.
    const chosen = `FROM ${OVERLAYS} o
      WHERE (o.repo_id, o.source_id, o.ref) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?))
        AND ${MATCHES}`;
    const bind = [keys, account, cutoff] as const;
    // One transaction: measure, delete what hangs off each overlay, then mark
    // the overlays (which takes them out of the predicate: run twice, the
    // second finds nothing).
    const [sizes] = await ctx.env.DB.batch<{
      repo: string;
      source: string;
      ref: string;
      rows: number;
      bytes: number;
    }>([
      ctx.env.DB.prepare(
        `SELECT o.repo_id AS repo, o.source_id AS source, o.ref, ${SIZE} ${chosen}`,
      ).bind(...bind),
      ctx.env.DB.prepare(`DELETE FROM timeline_source_roots WHERE
        (consumer_kind = 'knowledge-overlay' AND consumer_id IN
          (SELECT o.repo_id || ':' || o.source_id || ':' || o.overlay_id ${chosen}))
        OR (consumer_kind = 'knowledge-pages' AND consumer_id IN
          (SELECT p.repo_id || ':' || p.source_id || ':' || p.ref || ':' || p.set_key
           FROM kg_page_sets p JOIN ${OVERLAYS} o ON p.repo_id=o.repo_id AND p.source_id=o.source_id AND p.ref=o.ref
           WHERE (o.repo_id,o.source_id,o.ref) IN
             (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?))
             AND ${MATCHES}))`).bind(...bind, ...bind),
      ctx.env.DB.prepare(
        `DELETE FROM kg_overlay_changes
         WHERE (repo_id, overlay_id) IN (SELECT o.repo_id, o.overlay_id ${chosen})`,
      ).bind(...bind),
      ctx.env.DB.prepare(
        `DELETE FROM atlas_timeline_regroupings
         WHERE (repo_id, overlay_id) IN (SELECT o.repo_id, o.overlay_id ${chosen})`,
      ).bind(...bind),
      ctx.env.DB.prepare(
        `DELETE FROM kg_page_set_pages
         WHERE (repo_id, source_id, ref) IN (SELECT o.repo_id, o.source_id, o.ref ${chosen})`,
      ).bind(...bind),
      ctx.env.DB.prepare(
        `DELETE FROM kg_page_sets
         WHERE (repo_id, source_id, ref) IN (SELECT o.repo_id, o.source_id, o.ref ${chosen})`,
      ).bind(...bind),
      ctx.env.DB.prepare(
        `UPDATE kg_overlays AS o SET removed_at = ?, stats = '{}'
         WHERE (o.repo_id, o.source_id, o.ref) IN (SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?))
           AND ${MATCHES}
         RETURNING repo_id AS repo, source_id AS source, ref`,
      ).bind(ctx.now.toISOString(), ...bind),
    ]);
    const removed = sizes?.results ?? [];
    return {
      count: removed.reduce((sum, r) => sum + r.rows, 0),
      bytes: removed.reduce((sum, r) => sum + r.bytes, 0),
    };
  },
};
