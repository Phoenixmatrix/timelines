// Snapshot comparisons (CORE-175): what changed between two retained snapshots
// of one scope, `from` (sequence S) and `to` (T > S), as change records over
// capabilities, areas and files (types and classes in shared/atlas.ts).
//
// Snapshots share rows (projection.ts): a row is valid for [from_seq, to_seq).
// So the entities that differ between S and T are exactly those with a row
// opened in (S, T] or closed in (S, T], both indexed (atlas_entities_opened,
// atlas_entities_open). A comparison reads those rows and each one's version
// at S and at T, never a whole snapshot; one whose two versions hash the same
// (changed and changed back) isn't a change. Retention keeps every row a
// retained snapshot sees, so with S and T retained, both versions are there.
//
// Each record is classed in SQL, so a class filter pages and counts exactly:
//
//   source      file: added, removed, or another blob. Region: member files
//               added or removed (the code changed what it holds).
//   regrouping  file: its parent, capability or area moved with both
//               versions present. Region: appeared or was retired, moved to
//               another parent, or had files move in or out.
//   summary     only words: a file's summary with the same blob; a region's
//               name, summary or description state with the same members
//               and parent (summary-only).
//   other       none of those: `fields` says what was recorded differently.
//
// A region's member movement comes from the changed files themselves (their
// capability and area at S and at T), aggregated per region. Everything is
// deterministic (ordered by kind, then id), runs no model, and pages by
// keyset. Callers resolve and authorize both snapshots first.

import {
  ATLAS_CATALOGUE_SUMMARY_CHARS,
  type AtlasChange,
  type AtlasChangeClass,
  type AtlasChangeField,
  type AtlasChangeRef,
  type AtlasChangeSide,
  type AtlasComparisonSummary,
  type AtlasDescriptionStatus,
  type AtlasUnavailableReason,
} from "../../shared/atlas.ts";

/** Kinds a comparison itemizes; the rest are counted (`others`). */
export const ITEMIZED = ["capability", "area", "file"] as const;
const ITEMIZED_SQL = `(${ITEMIZED.map((k) => `'${k}'`).join(", ")})`;

/** Keyset position: kind rank (capability, area, file), then id. */
export type CompareKey = [number, string];

export interface CompareFilter {
  /** Only this capability or area, its areas and its files (at either side). */
  within: string | null;
  class: AtlasChangeClass | null;
}

const CHARS = ATLAS_CATALOGUE_SUMMARY_CHARS;

/** Rows valid in snapshot `?n` for alias `t`. */
const at = (t: string, n: number) =>
  `${t}.scope = ?1 AND ${t}.from_seq <= ?${n} AND (${t}.to_seq IS NULL OR ${t}.to_seq > ?${n})`;

const side = (t: "a" | "b") => `
      ${t}.parent_id AS ${t}_parent, ${t}.capability AS ${t}_cap,
      json_extract(${t}.data, '$.membership.area') AS ${t}_area,
      json_extract(${t}.data, '$.blob') AS ${t}_blob,
      ${t}.name AS ${t}_name, ${t}.path AS ${t}_path,
      substr(${t}.summary, 1, ${CHARS + 1}) AS ${t}_summary,
      json_extract(${t}.data, '$.description.status') AS ${t}_status,
      json_extract(${t}.data, '$.description.reason') AS ${t}_reason,
      json_extract(${t}.data, '$.counts.files') AS ${t}_files`;

const differs = (path: string) =>
  `(json_extract(a.data, '${path}') IS NOT json_extract(b.data, '${path}'))`;
const ANALYSIS = (t: string) =>
  `json_array(${["pending", "skipped", "language", "role", "lines", "responsibilities"]
    .map((k) => `json_extract(${t}.data, '$.${k}')`)
    .join(", ")})`;

/**
 * The comparison as CTEs, ending in `records`: one row per changed
 * capability, area or file with its two sides, flags and classes.
 * Binds ?1 scope, ?2 from seq, ?3 to seq.
 */
const RECORDS = `
  changed(id) AS (
    SELECT entity_id FROM atlas_entities
    WHERE scope = ?1 AND from_seq > ?2 AND from_seq <= ?3 AND kind IN ${ITEMIZED_SQL}
    UNION
    SELECT entity_id FROM atlas_entities
    WHERE scope = ?1 AND to_seq > ?2 AND to_seq <= ?3 AND kind IN ${ITEMIZED_SQL}
  ),
  pairs AS (
    SELECT c.id, coalesce(b.kind, a.kind) AS kind,
      a.entity_id IS NOT NULL AS had, b.entity_id IS NOT NULL AS has,
      ${side("a")},
      ${side("b")},
      json_extract(b.data, '$.lineage') AS b_lineage,
      (a.name IS NOT b.name) AS f_name,
      (a.summary IS NOT b.summary) AS f_summary,
      ${differs("$.description")} AS f_description,
      ${differs("$.counts")} AS f_counts,
      ${differs("$.membership")} AS f_membership,
      (${ANALYSIS("a")} IS NOT ${ANALYSIS("b")}) AS f_analysis,
      ${differs("$.concepts")} AS f_concepts,
      ${differs("$.layout")} AS f_layout,
      ${differs("$.lineage")} AS f_lineage,
      ${differs("$.provenance")} AS f_provenance
    FROM changed c
    LEFT JOIN atlas_entities a ON a.entity_id = c.id AND ${at("a", 2)}
    LEFT JOIN atlas_entities b ON b.entity_id = c.id AND ${at("b", 3)}
    WHERE a.content_hash IS NOT b.content_hash
  ),
  moves AS (
    SELECT region,
      sum(inward AND moved) AS moved_in, sum(NOT inward AND moved) AS moved_out,
      sum(inward AND NOT had) AS added, sum(NOT inward AND NOT has) AS removed
    FROM (
      SELECT a_cap AS region, 0 AS inward, had, has, (had AND has AND a_cap IS NOT b_cap) AS moved
        FROM pairs WHERE kind = 'file' AND a_cap IS NOT NULL
      UNION ALL
      SELECT b_cap, 1, had, has, (had AND has AND a_cap IS NOT b_cap)
        FROM pairs WHERE kind = 'file' AND b_cap IS NOT NULL
      UNION ALL
      SELECT a_area, 0, had, has, (had AND has AND a_area IS NOT b_area)
        FROM pairs WHERE kind = 'file' AND a_area IS NOT NULL
      UNION ALL
      SELECT b_area, 1, had, has, (had AND has AND a_area IS NOT b_area)
        FROM pairs WHERE kind = 'file' AND b_area IS NOT NULL
    ) GROUP BY region
  ),
  classed AS (
    SELECT p.*,
      CASE p.kind WHEN 'capability' THEN 0 WHEN 'area' THEN 1 ELSE 2 END AS rank,
      coalesce(m.moved_in, 0) AS moved_in, coalesce(m.moved_out, 0) AS moved_out,
      coalesce(m.added, 0) AS m_added, coalesce(m.removed, 0) AS m_removed,
      CASE WHEN p.kind = 'file' THEN (NOT p.had OR NOT p.has OR p.a_blob IS NOT p.b_blob)
        ELSE (coalesce(m.added, 0) + coalesce(m.removed, 0) > 0) END AS c_source,
      CASE WHEN p.kind = 'file'
        THEN (p.had AND p.has AND (p.a_parent IS NOT p.b_parent OR p.a_cap IS NOT p.b_cap OR p.a_area IS NOT p.b_area))
        ELSE (NOT p.had OR NOT p.has OR p.a_parent IS NOT p.b_parent
              OR coalesce(m.moved_in, 0) + coalesce(m.moved_out, 0) > 0) END AS c_regrouping,
      (p.had AND p.has AND (p.f_name OR p.f_summary OR p.f_description) AND
        CASE WHEN p.kind = 'file' THEN p.a_blob IS p.b_blob
          ELSE p.a_parent IS p.b_parent AND coalesce(m.moved_in, 0) + coalesce(m.moved_out, 0)
               + coalesce(m.added, 0) + coalesce(m.removed, 0) = 0 END) AS c_summary
    FROM pairs p LEFT JOIN moves m ON m.region = p.id
  ),
  records AS (
    SELECT *, NOT (c_source OR c_regrouping OR c_summary) AS c_other FROM classed
  )`;

/** Records within ?4 (null: all): the region itself, its areas and its files at either side. */
const WITHIN = `(?4 IS NULL OR id = ?4 OR a_parent = ?4 OR b_parent = ?4 OR a_cap = ?4 OR b_cap = ?4
  OR a_area = ?4 OR b_area = ?4)`;
/** Records of class ?5 (null: all). */
const OF_CLASS = `(?5 IS NULL OR (?5 = 'source' AND c_source) OR (?5 = 'regrouping' AND c_regrouping)
  OR (?5 = 'summary' AND c_summary) OR (?5 = 'other' AND c_other))`;

interface RecordRow {
  id: string;
  kind: "capability" | "area" | "file";
  had: number;
  has: number;
  rank: number;
  a_parent: string | null;
  b_parent: string | null;
  a_cap: string | null;
  b_cap: string | null;
  a_area: string | null;
  b_area: string | null;
  a_blob: string | null;
  b_blob: string | null;
  a_name: string | null;
  b_name: string | null;
  a_path: string | null;
  b_path: string | null;
  a_summary: string | null;
  b_summary: string | null;
  a_status: string | null;
  b_status: string | null;
  a_reason: string | null;
  b_reason: string | null;
  a_files: number | null;
  b_files: number | null;
  b_lineage: string | null;
  moved_in: number;
  moved_out: number;
  m_added: number;
  m_removed: number;
  c_source: number;
  c_regrouping: number;
  c_summary: number;
  c_other: number;
  [flag: `f_${string}`]: number;
}

const FIELDS: [AtlasChangeField, (r: RecordRow) => boolean][] = [
  ["placement", (r) => r.a_parent !== r.b_parent || r.a_cap !== r.b_cap || r.a_area !== r.b_area],
  ["source", (r) => r.kind === "file" && r.a_blob !== r.b_blob],
  ["name", (r) => Boolean(r.f_name)],
  ["summary", (r) => Boolean(r.f_summary)],
  ["description", (r) => Boolean(r.f_description)],
  ["counts", (r) => Boolean(r.f_counts)],
  ["membership", (r) => Boolean(r.f_membership)],
  ["analysis", (r) => Boolean(r.f_analysis)],
  ["concepts", (r) => Boolean(r.f_concepts)],
  ["layout", (r) => Boolean(r.f_layout)],
  ["lineage", (r) => Boolean(r.f_lineage)],
  ["provenance", (r) => Boolean(r.f_provenance)],
];

function sideOf(r: RecordRow, t: "a" | "b"): AtlasChangeSide | null {
  if (!(t === "a" ? r.had : r.has)) return null;
  const summary = r[`${t}_summary`] ?? "";
  const status = r[`${t}_status`] as AtlasDescriptionStatus | null;
  const reason = r[`${t}_reason`] as AtlasUnavailableReason | null;
  const files = r[`${t}_files`];
  return {
    name: r[`${t}_name`] ?? "",
    path: r[`${t}_path`],
    parentId: r[`${t}_parent`],
    capability: r[`${t}_cap`],
    area: r[`${t}_area`],
    blob: r[`${t}_blob`],
    summary: summary.slice(0, CHARS),
    summaryTruncated: summary.length > CHARS,
    ...(status ? { summaryState: reason ? { status, reason } : { status } } : {}),
    files: files === null || files === undefined ? null : Number(files),
  };
}

function classesOf(r: RecordRow): AtlasChangeClass[] {
  const classes: AtlasChangeClass[] = [];
  if (r.c_source) classes.push("source");
  if (r.c_regrouping) classes.push("regrouping");
  if (r.c_summary) classes.push("summary");
  if (r.c_other) classes.push("other");
  return classes;
}

/** Names of `ids` as snapshot `seq` has them. */
async function namesAt(
  d1: D1Database,
  scope: string,
  seq: number,
  ids: Iterable<string>,
): Promise<Map<string, string>> {
  const list = [...new Set(ids)];
  if (!list.length) return new Map();
  const rows = await d1
    .prepare(
      `SELECT entity_id, name FROM atlas_entities e
       WHERE e.entity_id IN (SELECT value FROM json_each(?2)) AND ${at("e", 3)}`,
    )
    .bind(scope, JSON.stringify(list), seq)
    .all<{ entity_id: string; name: string }>();
  return new Map(rows.results.map((r) => [r.entity_id, r.name]));
}

interface Origin {
  change: "split" | "merge" | "new";
  since?: number;
  predecessors?: { id: string; share: number }[];
}

/**
 * A page of change records between snapshots `fromSeq` < `toSeq` of `scope`,
 * after `after`, at most `limit`. `next` continues it.
 */
export async function comparePage(
  d1: D1Database,
  scope: string,
  fromSeq: number,
  toSeq: number,
  filter: CompareFilter,
  after: CompareKey | null,
  limit: number,
): Promise<{ changes: AtlasChange[]; next: CompareKey | null }> {
  const rows = await d1
    .prepare(
      `WITH ${RECORDS}
       SELECT * FROM records
       WHERE ${WITHIN} AND ${OF_CLASS} AND (rank, id) > (?6, ?7)
       ORDER BY rank, id LIMIT ?8`,
    )
    .bind(
      scope,
      fromSeq,
      toSeq,
      filter.within,
      filter.class,
      after?.[0] ?? -1,
      after?.[1] ?? "",
      limit + 1,
    )
    .all<RecordRow>();
  const page = rows.results.slice(0, limit);

  // Where removed regions went: their retirement between the two snapshots.
  const removed = page.filter((r) => r.kind !== "file" && !r.has).map((r) => r.id);
  const retirements = new Map<
    string,
    {
      seq: number;
      change: "split" | "merged" | "removed";
      successors: { id: string; share: number }[];
    }
  >();
  if (removed.length) {
    const lineage = await d1
      .prepare(
        `SELECT entity_id, retired_seq, change, successors FROM atlas_lineage
         WHERE scope = ?1 AND entity_id IN (SELECT value FROM json_each(?4))
           AND retired_seq > ?2 AND retired_seq <= ?3
         ORDER BY entity_id, retired_seq DESC`,
      )
      .bind(scope, fromSeq, toSeq, JSON.stringify(removed))
      .all<{ entity_id: string; retired_seq: number; change: string; successors: string }>();
    for (const row of lineage.results)
      if (!retirements.has(row.entity_id))
        retirements.set(row.entity_id, {
          seq: Number(row.retired_seq),
          change: row.change as "split" | "merged" | "removed",
          successors: JSON.parse(row.successors) as { id: string; share: number }[],
        });
  }
  const origins = new Map<string, Origin | null>();
  for (const r of page)
    if (r.kind !== "file" && !r.had)
      origins.set(r.id, r.b_lineage ? (JSON.parse(r.b_lineage) as Origin) : null);

  // Names, each from the snapshot that mentions it.
  const fromIds: string[] = [];
  const toIds: string[] = [];
  for (const r of page) {
    for (const id of [r.a_parent, r.a_cap, r.a_area]) if (id) fromIds.push(id);
    for (const id of [r.b_parent, r.b_cap, r.b_area]) if (id) toIds.push(id);
    for (const p of origins.get(r.id)?.predecessors ?? []) fromIds.push(p.id);
    for (const s of retirements.get(r.id)?.successors ?? []) toIds.push(s.id);
  }
  const [fromNames, toNames] = await Promise.all([
    namesAt(d1, scope, fromSeq, fromIds),
    namesAt(d1, scope, toSeq, toIds),
  ]);

  const changes = page.map((r): AtlasChange => {
    const names: Record<string, string> = {};
    for (const id of [r.a_parent, r.a_cap, r.a_area]) {
      const name = id ? fromNames.get(id) : undefined;
      if (id && name !== undefined) names[id] = name;
    }
    for (const id of [r.b_parent, r.b_cap, r.b_area]) {
      const name = id ? toNames.get(id) : undefined;
      if (id && name !== undefined) names[id] = name;
    }
    const origin = origins.get(r.id);
    const retired = retirements.get(r.id);
    const ref = (names: Map<string, string>) => (x: { id: string; share: number }) =>
      ({ id: x.id, share: x.share, name: names.get(x.id) ?? null }) satisfies AtlasChangeRef;
    const region = r.kind !== "file";
    return {
      id: r.id,
      kind: r.kind,
      presence: !r.had ? "added" : !r.has ? "removed" : "changed",
      classes: classesOf(r),
      fields: r.had && r.has ? FIELDS.filter(([, test]) => test(r)).map(([field]) => field) : [],
      from: sideOf(r, "a"),
      to: sideOf(r, "b"),
      names,
      origin:
        region && !r.had
          ? {
              change: origin?.change ?? "new",
              since: origin?.since ?? null,
              predecessors: (origin?.predecessors ?? []).map(ref(fromNames)),
            }
          : null,
      retired:
        region && !r.has && retired
          ? {
              seq: retired.seq,
              change: retired.change,
              successors: retired.successors.map(ref(toNames)),
            }
          : null,
      members: region
        ? {
            movedIn: Number(r.moved_in),
            movedOut: Number(r.moved_out),
            added: Number(r.m_added),
            removed: Number(r.m_removed),
          }
        : null,
    };
  });
  const last = page.at(-1);
  return {
    changes,
    next: rows.results.length > limit && last ? [Number(last.rank), last.id] : null,
  };
}

/** Counts over the whole comparison within `within` (every class). */
export async function compareSummary(
  d1: D1Database,
  scope: string,
  fromSeq: number,
  toSeq: number,
  within: string | null,
): Promise<AtlasComparisonSummary> {
  const [grouped, others] = await Promise.all([
    d1
      .prepare(
        `WITH ${RECORDS}
         SELECT kind, count(*) AS n, sum(c_source) AS source, sum(c_regrouping) AS regrouping,
           sum(c_summary) AS summary, sum(c_other) AS other,
           sum(kind = 'file' AND NOT had) AS added, sum(kind = 'file' AND NOT has) AS removed,
           sum(kind = 'file' AND had AND has AND a_blob IS NOT b_blob) AS modified
         FROM records WHERE ${WITHIN} GROUP BY kind`,
      )
      .bind(scope, fromSeq, toSeq, within)
      .all<{
        kind: string;
        n: number;
        source: number;
        regrouping: number;
        summary: number;
        other: number;
        added: number;
        removed: number;
        modified: number;
      }>(),
    within
      ? null
      : d1
          .prepare(
            `SELECT count(*) AS n FROM (
               SELECT entity_id FROM atlas_entities
               WHERE scope = ?1 AND from_seq > ?2 AND from_seq <= ?3 AND kind NOT IN ${ITEMIZED_SQL}
               UNION
               SELECT entity_id FROM atlas_entities
               WHERE scope = ?1 AND to_seq > ?2 AND to_seq <= ?3 AND kind NOT IN ${ITEMIZED_SQL})`,
          )
          .bind(scope, fromSeq, toSeq)
          .first<{ n: number }>(),
  ]);
  const summary: AtlasComparisonSummary = {
    classes: { source: 0, regrouping: 0, summary: 0, other: 0 },
    total: 0,
    kinds: { capability: 0, area: 0, file: 0 },
    files: { added: 0, removed: 0, modified: 0 },
    others: others ? Number(others.n) : null,
  };
  for (const row of grouped.results) {
    summary.total += Number(row.n);
    if (row.kind === "capability" || row.kind === "area" || row.kind === "file")
      summary.kinds[row.kind] += Number(row.n);
    summary.classes.source += Number(row.source);
    summary.classes.regrouping += Number(row.regrouping);
    summary.classes.summary += Number(row.summary);
    summary.classes.other += Number(row.other);
    summary.files.added += Number(row.added);
    summary.files.removed += Number(row.removed);
    summary.files.modified += Number(row.modified);
  }
  return summary;
}
