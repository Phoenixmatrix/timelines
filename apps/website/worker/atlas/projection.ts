// Atlas projections (CORE-158): immutable, snapshot-pinned materializations of
// the knowledge graph that every Atlas view reads from.
//
// A scope ("repo:<id>"; workspace scopes later) has numbered snapshots. Entity
// and edge rows are valid for the snapshots in [from_seq, to_seq): writing
// snapshot S opens rows for what changed (from_seq = S) and closes the rows
// they replace (to_seq = S). Unchanged entities are stored once however many
// snapshots share them, and a published snapshot keeps reading exactly what it
// published, because later writes only touch rows at sequence numbers it can't
// see. Readers follow `atlas_current`, which moves in one statement once a
// snapshot is complete; an interrupted build is rolled back before the next.
//
// The projection is read from the stored graph (`kg_nodes`/`kg_edges`), which
// is complete once a build's `graph-final` step has run, in keyset batches of
// at most ENTITY_BATCH entities or EDGE_BATCH edges per Workflow step. Every
// batch is idempotent, so a retried step converges on the same rows.
//
// Incremental projection (CORE-166). When the published snapshot was built by
// this projection and grouping version and the change feed (feed.ts) lists
// what changed since, a snapshot reads only that: the changed nodes, the
// endpoints of changed edges (their parents and counts derive from those
// edges) and the files whose placement grouping changed. Grouping itself runs
// only when its inputs (imports between files, mentions, which files are
// analyzed, concept names) changed, and then records only placements that
// differ from the published ones. Everything else stays in the rows the
// snapshots share, so the result equals a full pass over the same graph.

import { batch, db, nowIso } from "../schema.ts";
import { sha256 } from "../knowledge/util.ts";
import { groupCapabilities, GROUPING_VERSION, type Grouping } from "./grouping.ts";
import { cell, GRID_WIDTH, reconcile, type PriorGroup, type Reconciled } from "./identity.ts";
import { FEED_LIMIT } from "./feed.ts";

/** Bump when the projected shape changes: snapshots record which one built them. */
export const PROJECTION_VERSION = 3;
export const ENTITY_BATCH = 10_000;
export const EDGE_BATCH = 50_000;
/** Rows per write statement: one JSON parameter each, well inside D1's limits. */
const ROWS_PER_STATEMENT = 200;

/** Structural groups that hold what has no semantic home yet. */
export const GROUPS = {
  unclassified: "group:unclassified",
  concepts: "group:concepts",
  dependencies: "group:dependencies",
  folders: "group:folders",
} as const;

const GROUP_NAMES: Record<string, string> = {
  [GROUPS.unclassified]: "Unclassified",
  [GROUPS.concepts]: "Concepts",
  [GROUPS.dependencies]: "Dependencies",
  [GROUPS.folders]: "Folders",
};

export const repoScope = (repoId: string) => `repo:${repoId}`;

/**
 * Entities written by passes other than the graph batches (structural groups,
 * capabilities, areas). Graph batches never close them; each pass owns its own.
 */
const isSynthetic = (id: string) =>
  id.startsWith("group:") || id.startsWith("cap:") || id.startsWith("area:");

export interface VectorEntry {
  repoId: string;
  commit: string;
  buildId: string;
}

export interface AtlasSnapshot {
  id: string;
  scope: string;
  seq: number;
  status: "building" | "published" | "failed" | "expired";
  partial: boolean;
  projectionVersion: number;
  vector: VectorEntry[];
  entities: number;
  edges: number;
  bytes: number;
  publishedAt: string | null;
  /**
   * When a prior snapshot expires (or, once `expired`, when it did); null while
   * current. See worker/atlas/retention.ts.
   */
  expiresAt: string | null;
  /** Why an `expired` snapshot expired: age, count or storage. */
  expiredReason: "age" | "count" | "storage" | null;
}

export interface AtlasEntity {
  id: string;
  kind: string;
  parentId: string | null;
  name: string;
  path: string | null;
  summary: string;
  data: Record<string, unknown>;
  /** The snapshot this entity's row was written in (reads only). */
  since?: number;
}

type Statement = { compile(): { sql: string; parameters: readonly unknown[] } };
const raw = (sql: string, ...parameters: unknown[]): Statement => ({
  compile: () => ({ sql, parameters }),
});

/**
 * Estimated stored size of a row, for retention's storage caps (CORE-159): the
 * UTF-8 length of every text column plus a fixed overhead for the scope, keys,
 * sequence numbers and index entries. A snapshot's `bytes` is the sum over the
 * rows it opened that still exist, so a scope's storage is the sum of its
 * snapshots' `bytes`. The JS and SQL forms must agree: retention subtracts the
 * SQL form for every row it deletes.
 */
export const ENTITY_ROW_OVERHEAD = 160;
export const EDGE_ROW_OVERHEAD = 96;
const utf8 = new TextEncoder();
const len = (s: string | null) => (s === null ? 0 : utf8.encode(s).length);
const sqlLen = (column: string) => `coalesce(length(CAST(${column} AS BLOB)), 0)`;
export const ENTITY_BYTES_SQL = `(${[
  "entity_id",
  "kind",
  "parent_id",
  "sort_key",
  "name",
  "path",
  "summary",
  "data",
  "content_hash",
]
  .map(sqlLen)
  .join(" + ")} + ${ENTITY_ROW_OVERHEAD})`;
export const EDGE_BYTES_SQL = `(${["src", "dst", "kind"].map(sqlLen).join(" + ")} + ${EDGE_ROW_OVERHEAD})`;

/** Rows valid in snapshot `seq`. */
const VISIBLE = "from_seq <= ? AND (to_seq IS NULL OR to_seq > ?)";

// ---- lifecycle ---------------------------------------------------------------

async function publishedSeq(d1: D1Database, scope: string): Promise<number> {
  const row = await db(d1)
    .selectFrom("atlas_current")
    .select("seq")
    .where("scope", "=", scope)
    .executeTakeFirst();
  return row?.seq ?? 0;
}

/**
 * Undo whatever an unpublished snapshot wrote: rows it opened go, rows it
 * closed reopen. Safe to repeat; leaves the published snapshot untouched.
 */
async function rollBackUnpublished(d1: D1Database, scope: string) {
  const published = await publishedSeq(d1, scope);
  await batch(d1, [
    raw("DELETE FROM atlas_entities WHERE scope = ? AND from_seq > ?", scope, published),
    raw("UPDATE atlas_entities SET to_seq = NULL WHERE scope = ? AND to_seq > ?", scope, published),
    raw("DELETE FROM atlas_edges WHERE scope = ? AND from_seq > ?", scope, published),
    raw("UPDATE atlas_edges SET to_seq = NULL WHERE scope = ? AND to_seq > ?", scope, published),
    raw("DELETE FROM atlas_assignments WHERE scope = ? AND seq > ?", scope, published),
    raw(
      "UPDATE atlas_snapshots SET status = 'failed', error = coalesce(error, 'Superseded before publication.') WHERE scope = ? AND seq > ? AND status = 'building'",
      scope,
      published,
    ),
    // Their rows are gone, so they no longer count toward storage.
    raw(
      "UPDATE atlas_snapshots SET bytes = 0 WHERE scope = ? AND seq > ? AND status = 'failed'",
      scope,
      published,
    ),
  ]);
}

/** A started snapshot, and whether it reads only the change feed since the published one. */
export interface ProjectionStart {
  snapshotId: string;
  seq: number;
  incremental: boolean;
  /** Feed rows it reads (incremental only). */
  feedRows: number;
}

/**
 * Start a snapshot for a repository's projection, after rolling back any
 * unpublished one. It is incremental when the published snapshot was built by
 * this projection and grouping version from a known feed position and the
 * feed since lists every change; otherwise (or with `full`) it reads the
 * whole graph.
 */
export async function beginRepoProjection(
  d1: D1Database,
  repoId: string,
  vector: VectorEntry[],
  options: { full?: boolean } = {},
): Promise<ProjectionStart> {
  const scope = repoScope(repoId);
  await db(d1)
    .insertInto("atlas_scopes")
    .values({ scope, kind: "repo", repo_id: repoId })
    .onConflict((oc) => oc.column("scope").doNothing())
    .execute();
  await rollBackUnpublished(d1, scope);
  const last = await db(d1)
    .selectFrom("atlas_snapshots")
    .select((eb) => eb.fn.max("seq").as("seq"))
    .where("scope", "=", scope)
    .executeTakeFirst();
  const seq = Number(last?.seq ?? 0) + 1;
  const published = await d1
    .prepare(
      `SELECT s.projection_version, s.grouping_version, s.feed_mark FROM atlas_current c
       JOIN atlas_snapshots s ON s.id = c.snapshot_id WHERE c.scope = ?`,
    )
    .bind(scope)
    .first<{
      projection_version: number;
      grouping_version: number | null;
      feed_mark: number | null;
    }>();
  const base = published?.feed_mark ?? null;
  const feed = await d1
    .prepare(
      `SELECT max(id) AS mark, count(*) AS n, coalesce(max(kind = 'full'), 0) AS full
       FROM atlas_feed WHERE repo_id = ? AND id > ?`,
    )
    .bind(repoId, base ?? -1)
    .first<{ mark: number | null; n: number; full: number }>();
  // The position this snapshot will reflect: unknown until the feed has recorded something.
  const marks = [base, feed?.mark ?? null].filter((m): m is number => m !== null);
  const mark = marks.length ? Math.max(...marks) : null;
  const incremental =
    !options.full &&
    published !== null &&
    published.projection_version === PROJECTION_VERSION &&
    published.grouping_version === GROUPING_VERSION &&
    base !== null &&
    !Number(feed?.full ?? 0) &&
    Number(feed?.n ?? 0) <= FEED_LIMIT;
  const snapshotId = crypto.randomUUID();
  await db(d1)
    .insertInto("atlas_snapshots")
    .values({
      id: snapshotId,
      scope,
      seq,
      projection_version: PROJECTION_VERSION,
      grouping_version: null,
      vector: JSON.stringify(vector),
      error: null,
      published_at: null,
      expires_at: null,
      feed_mark: mark,
      feed_base: incremental ? base : null,
    })
    .execute();
  return { snapshotId, seq, incremental, feedRows: incremental ? Number(feed?.n ?? 0) : 0 };
}

/** What an incremental snapshot reads: the feed in (base, mark] against published `baseSeq`. */
interface Increment {
  repoId: string;
  scope: string;
  seq: number;
  base: number;
  mark: number;
  baseSeq: number;
}

/** The increment snapshot `snapshotId` projects, or null when it reads the whole graph. */
async function incrementOf(d1: D1Database, snapshotId: string): Promise<Increment | null> {
  const row = await d1
    .prepare(
      `SELECT s.scope, s.seq, s.feed_base, s.feed_mark, sc.repo_id, c.seq AS base_seq
       FROM atlas_snapshots s JOIN atlas_scopes sc ON sc.scope = s.scope
       LEFT JOIN atlas_current c ON c.scope = s.scope
       WHERE s.id = ?`,
    )
    .bind(snapshotId)
    .first<{
      scope: string;
      seq: number;
      feed_base: number | null;
      feed_mark: number | null;
      repo_id: string | null;
      base_seq: number | null;
    }>();
  if (!row || row.feed_base === null || row.feed_mark === null || row.base_seq === null)
    return null;
  if (!row.repo_id) return null;
  return {
    repoId: row.repo_id,
    scope: row.scope,
    seq: row.seq,
    base: row.feed_base,
    mark: row.feed_mark,
    baseSeq: row.base_seq,
  };
}

/** Feed rows of an increment; binds ?1 repo, ?2 base, ?3 mark. */
const FEED = (kind: "node" | "edge") =>
  `SELECT * FROM atlas_feed WHERE repo_id = ?1 AND kind = '${kind}' AND id > ?2 AND id <= ?3`;
/**
 * Entities an increment re-projects: changed nodes, both ends of changed
 * edges, and files whose placement changed; binds ?1-?3 and ?4 scope, ?5 seq.
 */
const DIRTY_IDS = `SELECT src AS id FROM (${FEED("node")})
  UNION SELECT src FROM (${FEED("edge")})
  UNION SELECT dst FROM (${FEED("edge")})
  UNION SELECT entity_id FROM atlas_assignments WHERE scope = ?4 AND seq = ?5`;

/** Mark a snapshot failed and undo its writes; the published one stays current. */
export async function failProjection(
  d1: D1Database,
  scope: string,
  snapshotId: string,
  error: string,
) {
  await db(d1)
    .updateTable("atlas_snapshots")
    .set({ status: "failed", error: error.slice(0, 2000) })
    .where("id", "=", snapshotId)
    .where("status", "=", "building")
    .execute();
  await rollBackUnpublished(d1, scope);
}

/**
 * Complete a snapshot: write the structural groups and their deduplicated
 * counts, record its size, then move the current pointer to it in one batch.
 */
export async function publishProjection(
  d1: D1Database,
  scope: string,
  snapshotId: string,
  seq: number,
) {
  // Groups hold whatever has no semantic home yet; empty ones aren't shown.
  const counts = await d1
    .prepare(
      `SELECT parent_id AS id, count(*) AS n FROM atlas_entities
       WHERE scope = ? AND to_seq IS NULL AND parent_id IN (SELECT value FROM json_each(?))
       GROUP BY parent_id`,
    )
    .bind(scope, JSON.stringify(Object.values(GROUPS)))
    .all<{ id: string; n: number }>();
  const byGroup = new Map(counts.results.map((r) => [r.id, Number(r.n)]));
  const groups: AtlasEntity[] = Object.values(GROUPS)
    .filter((id) => byGroup.get(id))
    .map((id) => ({
      id,
      kind: "group",
      parentId: "repo",
      name: GROUP_NAMES[id] ?? id,
      path: null,
      summary: "",
      data: { members: byGroup.get(id) ?? 0, structural: true },
    }));
  const groupIds = new Set<string>(Object.values(GROUPS));
  const groupBytes = await writeEntities(d1, scope, seq, groups, ["group:", "group:~"], {
    final: false,
    owns: (id) => groupIds.has(id),
  });

  const totals = await d1
    .prepare(
      `SELECT
         (SELECT count(*) FROM atlas_entities WHERE scope = ?1 AND to_seq IS NULL) AS entities,
         (SELECT count(*) FROM atlas_edges WHERE scope = ?1 AND to_seq IS NULL) AS edges`,
    )
    .bind(scope)
    .first<{ entities: number; edges: number }>();
  const now = nowIso();
  await batch(d1, [
    raw(
      `UPDATE atlas_snapshots SET status = 'published', published_at = ?, entities = ?, edges = ?, bytes = bytes + ?
       WHERE id = ? AND status = 'building'`,
      now,
      Number(totals?.entities ?? 0),
      Number(totals?.edges ?? 0),
      groupBytes,
      snapshotId,
    ),
    raw("DELETE FROM atlas_assignments WHERE scope = ? AND seq = ?", scope, seq),
    // The feed up to what this snapshot reflects is consumed (CORE-166).
    raw(
      `DELETE FROM atlas_feed WHERE repo_id = (SELECT repo_id FROM atlas_scopes WHERE scope = ?)
       AND id <= coalesce((SELECT feed_mark FROM atlas_snapshots WHERE id = ? AND status = 'published'), -1)`,
      scope,
      snapshotId,
    ),
    raw(
      `INSERT INTO atlas_current (scope, snapshot_id, seq, published_at)
       SELECT scope, id, seq, ? FROM atlas_snapshots WHERE id = ? AND status = 'published'
       ON CONFLICT (scope) DO UPDATE SET snapshot_id = excluded.snapshot_id, seq = excluded.seq, published_at = excluded.published_at`,
      now,
      snapshotId,
    ),
  ]);
}

// ---- entities ----------------------------------------------------------------

/** What placing an entity needs beyond itself. */
export interface Placement {
  componentOf: Map<string, string>;
  broaderOf: Map<string, string>;
  /** File placements from capability grouping, when it ran for this snapshot. */
  assigned: Map<string, string> | null;
}

/** Where an entity sits in the primary tree. Each source unit has exactly one parent. */
export function parentOf(
  node: { id: string; kind: string; path: string | null; data: Record<string, unknown> },
  placement: Placement,
): string | null {
  const { id, kind, path } = node;
  switch (kind) {
    case "repository":
      return null;
    case "component": {
      // With capabilities, components are directory-shaped inputs: they live
      // with their folder, not at the top.
      if (!placement.assigned) return "repo";
      const dir = typeof node.data.dir === "string" ? node.data.dir : "";
      return dir && dir !== "." ? `dir:${dir}` : GROUPS.folders;
    }
    case "file":
      if (placement.assigned) return placement.assigned.get(id) ?? GROUPS.unclassified;
      return placement.componentOf.get(id) ?? GROUPS.unclassified;
    case "symbol": {
      const hash = id.lastIndexOf("#");
      return hash > 4 ? `file:${id.slice(4, hash)}` : GROUPS.unclassified;
    }
    case "concept":
      return placement.broaderOf.get(id) ?? GROUPS.concepts;
    case "package":
      return GROUPS.dependencies;
    case "directory": {
      const dir = path ?? "";
      const slash = dir.lastIndexOf("/");
      return slash > 0 ? `dir:${dir.slice(0, slash)}` : GROUPS.folders;
    }
    default:
      return GROUPS.unclassified;
  }
}

const sortKey = (name: string, id: string) => `${name.toLowerCase()}\u0000${id}`;

async function entityHash(e: AtlasEntity): Promise<string> {
  return sha256(JSON.stringify([e.kind, e.parentId, e.name, e.path, e.summary, e.data]));
}

/**
 * Open rows for entities that are new or changed in `seq`, close the ones they
 * replace, and close entities in the batch's id range that no longer exist.
 * `range` is [after, upTo] (upTo null: to the end). Returns bytes written.
 */
async function writeEntities(
  d1: D1Database,
  scope: string,
  seq: number,
  entities: AtlasEntity[],
  range: [string | null, string | null],
  options: {
    final: boolean;
    owns?: (id: string) => boolean;
    /** Only these ids' open rows are considered (a pass revising some entities). */
    only?: string[];
    /** The open rows to compare with, already read by the caller (an increment's). */
    open?: OpenEntity[];
  },
): Promise<number> {
  const [after, upTo] = range;
  const bounded = upTo !== null && !options.final;
  // `+to_seq`: walk the id range by primary key, not every open row by to_seq.
  const open =
    options.open ??
    (
      await d1
        .prepare(
          `SELECT entity_id, from_seq, content_hash, ${ENTITY_BYTES_SQL} AS size FROM atlas_entities
           WHERE scope = ? AND +to_seq IS NULL AND entity_id > ? ${bounded ? "AND entity_id <= ?" : ""}
           ${options.only ? "AND entity_id IN (SELECT value FROM json_each(?))" : ""}`,
        )
        .bind(
          scope,
          after ?? "",
          ...(bounded ? [upTo] : []),
          ...(options.only ? [JSON.stringify(options.only)] : []),
        )
        .all<OpenEntity>()
    ).results;
  const existing = new Map(open.map((r) => [r.entity_id, r]));

  const rows: Record<string, unknown>[] = [];
  const close: string[] = [];
  let bytes = 0;
  const wanted = new Set<string>();
  for (const entity of entities) {
    wanted.add(entity.id);
    const hash = await entityHash(entity);
    const before = existing.get(entity.id);
    if (before?.content_hash === hash) continue;
    // A row this snapshot already opened (a retried step, or a later pass
    // revising it) is replaced in place: its old size no longer counts.
    if (before && before.from_seq !== seq) close.push(entity.id);
    if (before && before.from_seq === seq) bytes -= Number(before.size);
    const data = JSON.stringify(entity.data);
    const sort = sortKey(entity.name, entity.id);
    bytes +=
      len(entity.id) +
      len(entity.kind) +
      len(entity.parentId) +
      len(sort) +
      len(entity.name) +
      len(entity.path) +
      len(entity.summary) +
      len(data) +
      len(hash) +
      ENTITY_ROW_OVERHEAD;
    rows.push({
      id: entity.id,
      kind: entity.kind,
      parent: entity.parentId,
      sort,
      name: entity.name,
      path: entity.path,
      summary: entity.summary,
      data,
      hash,
    });
  }
  for (const id of existing.keys()) {
    if (wanted.has(id)) continue;
    // Graph batches never close groups (written at publication), and the
    // group pass touches nothing else.
    if (options.owns ? !options.owns(id) : isSynthetic(id)) continue;
    close.push(id);
    // Rows this snapshot opened are deleted, not closed.
    const before = existing.get(id);
    if (before && before.from_seq === seq) bytes -= Number(before.size);
  }

  const statements: Statement[] = [];
  for (let i = 0; i < close.length; i += ROWS_PER_STATEMENT) {
    const ids = JSON.stringify(close.slice(i, i + ROWS_PER_STATEMENT));
    // Rows opened by this snapshot (retries) go; older ones close at `seq`.
    statements.push(
      raw(
        `DELETE FROM atlas_entities WHERE scope = ? AND from_seq = ? AND entity_id IN (SELECT value FROM json_each(?))`,
        scope,
        seq,
        ids,
      ),
      raw(
        `UPDATE atlas_entities SET to_seq = ? WHERE scope = ? AND to_seq IS NULL AND entity_id IN (SELECT value FROM json_each(?))`,
        seq,
        scope,
        ids,
      ),
    );
  }
  for (let i = 0; i < rows.length; i += ROWS_PER_STATEMENT) {
    statements.push(
      raw(
        `INSERT INTO atlas_entities (scope, entity_id, from_seq, to_seq, kind, parent_id, sort_key, name, path, summary, data, content_hash)
         SELECT ?, json_extract(value, '$.id'), ?, NULL, json_extract(value, '$.kind'), json_extract(value, '$.parent'),
                json_extract(value, '$.sort'), json_extract(value, '$.name'), json_extract(value, '$.path'),
                json_extract(value, '$.summary'), json_extract(value, '$.data'), json_extract(value, '$.hash')
         FROM json_each(?) WHERE true
         ON CONFLICT (scope, entity_id, from_seq) DO UPDATE SET
           kind = excluded.kind, parent_id = excluded.parent_id, sort_key = excluded.sort_key, name = excluded.name,
           path = excluded.path, summary = excluded.summary, data = excluded.data, content_hash = excluded.content_hash, to_seq = NULL`,
        scope,
        seq,
        JSON.stringify(rows.slice(i, i + ROWS_PER_STATEMENT)),
      ),
    );
  }
  for (let i = 0; i < statements.length; i += 50) await batch(d1, statements.slice(i, i + 50));
  return bytes;
}

interface OpenEntity {
  entity_id: string;
  from_seq: number;
  content_hash: string;
  size: number;
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  path: string | null;
  summary: string;
  data: string;
}

/** What placing and counting a batch of nodes reads from the graph's edges. */
interface Derived {
  componentOf: Map<string, string>;
  broaderOf: Map<string, string>;
  symbols: Map<string, number>;
  componentFiles: Map<string, number>;
  mentions: Map<string, number>;
}

function derived(rows: {
  containers: { src: string; dst: string }[];
  broader: { src: string; dst: string }[];
  defines: { src: string; n: number }[];
  members: { src: string; n: number }[];
  mentioned: { dst: string; n: number }[];
}): Derived {
  const out: Derived = {
    componentOf: new Map(),
    broaderOf: new Map(),
    symbols: new Map(),
    componentFiles: new Map(),
    mentions: new Map(),
  };
  // A file in two components (it can't be, but be deterministic) takes the first.
  for (const row of rows.containers.sort((a, b) => a.src.localeCompare(b.src)))
    if (!out.componentOf.has(row.dst)) out.componentOf.set(row.dst, row.src);
  for (const row of rows.broader) out.broaderOf.set(row.src, row.dst);
  for (const row of rows.defines) out.symbols.set(row.src, Number(row.n));
  for (const row of rows.members) out.componentFiles.set(row.src, Number(row.n));
  for (const row of rows.mentioned) out.mentions.set(row.dst, Number(row.n));
  return out;
}

/** Graph nodes as Atlas entities, placed and counted. */
function toEntities(
  nodes: NodeRow[],
  edges: Derived,
  assigned: Map<string, string> | null,
  membership: Map<string, unknown>,
): { entities: AtlasEntity[]; partial: boolean } {
  let partial = false;
  const entities = nodes.map((node) => {
    const data = JSON.parse(node.data) as Record<string, unknown>;
    if (node.kind === "file" && (data.pending || data.skipped)) partial ||= Boolean(data.pending);
    // Deduplicated counts: each source unit counts once, at its primary place.
    const counts: Record<string, number> = {};
    if (node.kind === "file") counts.symbols = edges.symbols.get(node.id) ?? 0;
    if (node.kind === "component") counts.files = edges.componentFiles.get(node.id) ?? 0;
    if (node.kind === "concept") counts.files = edges.mentions.get(node.id) ?? 0;
    return {
      id: node.id,
      kind: node.kind,
      parentId: parentOf(
        { id: node.id, kind: node.kind, path: node.path, data },
        { componentOf: edges.componentOf, broaderOf: edges.broaderOf, assigned },
      ),
      name: node.name,
      path: node.path,
      summary: node.summary,
      data: membership.has(node.id)
        ? { ...data, counts, membership: membership.get(node.id) }
        : { ...data, counts },
    };
  });
  return { entities, partial };
}

/**
 * Project the next batch of a repository's graph nodes into snapshot `seq`.
 * Returns the cursor for the next batch (null when done).
 */
export async function projectEntities(
  d1: D1Database,
  repoId: string,
  snapshotId: string,
  seq: number,
  after: string | null,
  limit = ENTITY_BATCH,
): Promise<{ next: string | null; written: number }> {
  const increment = await incrementOf(d1, snapshotId);
  if (increment) return projectChangedEntities(d1, increment, snapshotId, after, limit);
  const scope = repoScope(repoId);
  const nodes = await d1
    .prepare(
      `SELECT id, kind, name, path, summary, data FROM kg_nodes
       WHERE repo_id = ? AND id > ? ORDER BY id LIMIT ?`,
    )
    .bind(repoId, after ?? "", limit)
    .all<NodeRow>();
  const batchNodes = nodes.results;
  const final = batchNodes.length < limit;
  const first = batchNodes[0]?.id ?? null;
  const last = batchNodes.at(-1)?.id ?? null;

  const grouped = await db(d1)
    .selectFrom("atlas_snapshots")
    .select("grouping_version")
    .where("id", "=", snapshotId)
    .executeTakeFirst();
  const assigned = grouped?.grouping_version ? new Map<string, string>() : null;
  const membership = new Map<string, unknown>();
  if (assigned && first !== null && last !== null) {
    const rows = await d1
      .prepare(
        `SELECT entity_id, parent_id, data FROM atlas_assignments
         WHERE scope = ? AND seq = ? AND entity_id >= ? AND entity_id <= ?`,
      )
      .bind(scope, seq, first, last)
      .all<{ entity_id: string; parent_id: string; data: string }>();
    for (const row of rows.results) {
      assigned.set(row.entity_id, row.parent_id);
      membership.set(row.entity_id, JSON.parse(row.data));
    }
  }
  let edges = derived({ containers: [], broader: [], defines: [], members: [], mentioned: [] });
  if (first !== null && last !== null) {
    const [containers, broader, defines, members, mentioned] = await Promise.all([
      d1
        .prepare(
          `SELECT src, dst FROM kg_edges WHERE repo_id = ? AND kind = 'contains'
           AND dst >= ? AND dst <= ? AND src LIKE 'component:%'`,
        )
        .bind(repoId, first, last)
        .all<{ src: string; dst: string }>(),
      d1
        .prepare(
          `SELECT src, min(dst) AS dst FROM kg_edges WHERE repo_id = ? AND kind = 'part_of'
           AND src >= ? AND src <= ? GROUP BY src`,
        )
        .bind(repoId, first, last)
        .all<{ src: string; dst: string }>(),
      d1
        .prepare(
          `SELECT src, count(*) AS n FROM kg_edges WHERE repo_id = ? AND kind = 'defines'
           AND src >= ? AND src <= ? GROUP BY src`,
        )
        .bind(repoId, first, last)
        .all<{ src: string; n: number }>(),
      d1
        .prepare(
          `SELECT src, count(*) AS n FROM kg_edges WHERE repo_id = ? AND kind = 'contains'
           AND src >= ? AND src <= ? AND src LIKE 'component:%' GROUP BY src`,
        )
        .bind(repoId, first, last)
        .all<{ src: string; n: number }>(),
      d1
        .prepare(
          `SELECT dst, count(*) AS n FROM kg_edges WHERE repo_id = ? AND kind = 'mentions'
           AND dst >= ? AND dst <= ? GROUP BY dst`,
        )
        .bind(repoId, first, last)
        .all<{ dst: string; n: number }>(),
    ]);
    edges = derived({
      containers: containers.results,
      broader: broader.results,
      defines: defines.results,
      members: members.results,
      mentioned: mentioned.results,
    });
  }

  const { entities, partial } = toEntities(batchNodes, edges, assigned, membership);
  const bytes = await writeEntities(d1, scope, seq, entities, [after, last], { final });
  await db(d1)
    .updateTable("atlas_snapshots")
    .set((eb) => ({
      bytes: eb("bytes", "+", bytes),
      ...(partial ? { partial: 1 } : {}),
    }))
    .where("id", "=", snapshotId)
    .execute();
  return { next: final ? null : last, written: entities.length };
}

/**
 * An increment's entity batch: the next `limit` changed entity ids after
 * `after` (see DIRTY_IDS), re-projected from the graph, or closed when their
 * node is gone. A file grouping didn't move keeps its published placement.
 */
async function projectChangedEntities(
  d1: D1Database,
  inc: Increment,
  snapshotId: string,
  after: string | null,
  limit: number,
): Promise<{ next: string | null; written: number }> {
  const { repoId, scope, seq } = inc;
  const ids = await d1
    .prepare(`SELECT id FROM (${DIRTY_IDS}) WHERE id > ?6 ORDER BY id LIMIT ?7`)
    .bind(repoId, inc.base, inc.mark, scope, seq, after ?? "", limit)
    .all<{ id: string }>();
  const final = ids.results.length < limit;
  const last = ids.results.at(-1)?.id ?? null;
  // Whether any file still waits for analysis: once per snapshot, over every file.
  const partial =
    after === null &&
    Boolean(
      (
        await d1
          .prepare(
            `SELECT EXISTS (SELECT 1 FROM kg_nodes WHERE repo_id = ? AND kind = 'file'
               AND json_extract(data, '$.pending')) AS p`,
          )
          .bind(repoId)
          .first<{ p: number }>()
      )?.p,
    );
  if (last === null) {
    if (partial)
      await db(d1)
        .updateTable("atlas_snapshots")
        .set({ partial: 1 })
        .where("id", "=", snapshotId)
        .execute();
    return { next: null, written: 0 };
  }
  // Every query below reads this batch's ids: ?1-?5 as in DIRTY_IDS, (?6, ?7].
  const batch = `WITH batch(id) AS (SELECT id FROM (${DIRTY_IDS}) WHERE id > ?6 AND id <= ?7)`;
  const read = <T>(sql: string, ...more: unknown[]) =>
    d1
      .prepare(`${batch} ${sql}`)
      .bind(repoId, inc.base, inc.mark, scope, seq, after ?? "", last, ...more)
      .all<T>()
      .then((r) => r.results);
  const [nodes, containers, broader, defines, members, mentioned, assignments, published, open] =
    await Promise.all([
      read<NodeRow>(
        `SELECT id, kind, name, path, summary, data FROM kg_nodes
         WHERE repo_id = ?1 AND id IN (SELECT id FROM batch) ORDER BY id`,
      ),
      read<{ src: string; dst: string }>(
        `SELECT src, dst FROM kg_edges WHERE repo_id = ?1 AND kind = 'contains'
         AND dst IN (SELECT id FROM batch) AND src LIKE 'component:%'`,
      ),
      read<{ src: string; dst: string }>(
        `SELECT src, min(dst) AS dst FROM kg_edges WHERE repo_id = ?1 AND kind = 'part_of'
         AND src IN (SELECT id FROM batch) GROUP BY src`,
      ),
      read<{ src: string; n: number }>(
        `SELECT src, count(*) AS n FROM kg_edges WHERE repo_id = ?1 AND kind = 'defines'
         AND src IN (SELECT id FROM batch) GROUP BY src`,
      ),
      read<{ src: string; n: number }>(
        `SELECT src, count(*) AS n FROM kg_edges WHERE repo_id = ?1 AND kind = 'contains'
         AND src IN (SELECT id FROM batch) AND src LIKE 'component:%' GROUP BY src`,
      ),
      read<{ dst: string; n: number }>(
        `SELECT dst, count(*) AS n FROM kg_edges WHERE repo_id = ?1 AND kind = 'mentions'
         AND dst IN (SELECT id FROM batch) GROUP BY dst`,
      ),
      read<{ entity_id: string; parent_id: string; data: string }>(
        `SELECT entity_id, parent_id, data FROM atlas_assignments
         WHERE scope = ?4 AND seq = ?5 AND entity_id IN (SELECT id FROM batch)`,
      ),
      // Placements of files grouping didn't move, as published.
      read<{ entity_id: string; parent_id: string | null; membership: string | null }>(
        `SELECT entity_id, parent_id, json_extract(data, '$.membership') AS membership
         FROM atlas_entities WHERE scope = ?4 AND kind = 'file' AND entity_id IN (SELECT id FROM batch)
         AND from_seq <= ?8 AND (to_seq IS NULL OR to_seq > ?8)`,
        inc.baseSeq,
      ),
      read<OpenEntity>(
        `SELECT entity_id, from_seq, content_hash, ${ENTITY_BYTES_SQL} AS size FROM atlas_entities
         WHERE scope = ?4 AND to_seq IS NULL AND entity_id IN (SELECT id FROM batch)`,
      ),
    ]);
  const assigned = new Map<string, string>();
  const membership = new Map<string, unknown>();
  for (const row of published) {
    if (row.parent_id) assigned.set(row.entity_id, row.parent_id);
    if (row.membership !== null) membership.set(row.entity_id, JSON.parse(row.membership));
  }
  for (const row of assignments) {
    assigned.set(row.entity_id, row.parent_id);
    const data = JSON.parse(row.data) as unknown;
    // `null`: grouping no longer places it (removed, or no longer analyzed).
    if (data === null) membership.delete(row.entity_id);
    else membership.set(row.entity_id, data);
  }
  const { entities } = toEntities(
    nodes,
    derived({ containers, broader, defines, members, mentioned }),
    assigned,
    membership,
  );
  const bytes = await writeEntities(d1, scope, seq, entities, [null, null], {
    final: true,
    open,
  });
  await db(d1)
    .updateTable("atlas_snapshots")
    .set((eb) => ({ bytes: eb("bytes", "+", bytes), ...(partial ? { partial: 1 } : {}) }))
    .where("id", "=", snapshotId)
    .execute();
  return { next: final ? null : last, written: entities.length };
}

/**
 * Replace some of snapshot `seq`'s entities by id: a later pass revising what
 * an earlier one wrote in the same snapshot (capability names and summaries,
 * CORE-164). Touches no other entity. An entity revised back to exactly the
 * row the snapshot closed (a capability described as before) reopens that row
 * instead, so unchanged entities stay stored once.
 */
export async function reviseEntities(
  d1: D1Database,
  scope: string,
  snapshotId: string,
  seq: number,
  entities: AtlasEntity[],
): Promise<void> {
  if (!entities.length) return;
  const ids = JSON.stringify(entities.map((e) => e.id));
  const closed = await d1
    .prepare(
      `SELECT entity_id, content_hash FROM atlas_entities
       WHERE scope = ? AND to_seq = ? AND entity_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(scope, seq, ids)
    .all<{ entity_id: string; content_hash: string }>();
  const closedHash = new Map(closed.results.map((r) => [r.entity_id, r.content_hash]));
  const restore: string[] = [];
  const write: AtlasEntity[] = [];
  for (const entity of entities) {
    if (closedHash.get(entity.id) === (await entityHash(entity))) restore.push(entity.id);
    else write.push(entity);
  }
  let bytes = 0;
  if (restore.length) {
    const list = JSON.stringify(restore);
    const opened = await d1
      .prepare(
        `SELECT coalesce(sum(${ENTITY_BYTES_SQL}), 0) AS size FROM atlas_entities
         WHERE scope = ? AND from_seq = ? AND entity_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(scope, seq, list)
      .first<{ size: number }>();
    bytes -= Number(opened?.size ?? 0);
    await batch(d1, [
      raw(
        `DELETE FROM atlas_entities WHERE scope = ? AND from_seq = ? AND entity_id IN (SELECT value FROM json_each(?))`,
        scope,
        seq,
        list,
      ),
      raw(
        `UPDATE atlas_entities SET to_seq = NULL WHERE scope = ? AND to_seq = ? AND entity_id IN (SELECT value FROM json_each(?))`,
        scope,
        seq,
        list,
      ),
    ]);
  }
  if (write.length)
    bytes += await writeEntities(d1, scope, seq, write, [null, null], {
      final: true,
      owns: () => false,
      only: write.map((e) => e.id),
    });
  await db(d1)
    .updateTable("atlas_snapshots")
    .set((eb) => ({ bytes: eb("bytes", "+", bytes) }))
    .where("id", "=", snapshotId)
    .execute();
}

// ---- capabilities --------------------------------------------------------------

export type GroupStats = Partial<Grouping["stats"]> & {
  capabilities: number;
  areas: number;
  unclassified: number;
  /** False when an increment changed no grouping input and kept the published groups. */
  regrouped: boolean;
};

/**
 * Whether an increment changed anything grouping reads: an import between
 * files, a mention, which files are analyzed, or a concept's name.
 */
async function groupingInputsChanged(d1: D1Database, inc: Increment): Promise<boolean> {
  const edge = await d1
    .prepare(
      `SELECT 1 AS hit FROM (${FEED("edge")})
       WHERE edge_kind = 'mentions' OR (edge_kind = 'imports' AND src LIKE 'file:%' AND dst LIKE 'file:%')
       LIMIT 1`,
    )
    .bind(inc.repoId, inc.base, inc.mark)
    .first<{ hit: number }>();
  if (edge) return true;
  const nodes = await d1
    .prepare(
      `SELECT f.id, n.kind, n.name, json_extract(n.data, '$.pending') AS pending,
              json_extract(n.data, '$.skipped') AS skipped, e.entity_id AS was, e.name AS was_name,
              json_type(e.data, '$.membership') AS grouped
       FROM (SELECT DISTINCT src AS id FROM (${FEED("node")})
             WHERE src LIKE 'file:%' OR src LIKE 'concept:%') f
       LEFT JOIN kg_nodes n ON n.repo_id = ?1 AND n.id = f.id
       LEFT JOIN atlas_entities e ON e.scope = ?4 AND e.entity_id = f.id
         AND e.from_seq <= ?5 AND (e.to_seq IS NULL OR e.to_seq > ?5)`,
    )
    .bind(inc.repoId, inc.base, inc.mark, inc.scope, inc.baseSeq)
    .all<{
      id: string;
      kind: string | null;
      name: string | null;
      pending: unknown;
      skipped: unknown;
      was: string | null;
      was_name: string | null;
      grouped: string | null;
    }>();
  return nodes.results.some((n) => {
    if (n.id.startsWith("concept:")) return n.name !== n.was_name;
    // A file is a grouping unit when analyzed; published, units have a membership.
    const unit = n.kind !== null && !n.pending && !n.skipped;
    return unit !== (n.grouped === "object");
  });
}

/**
 * Group a repository's analyzed files into capabilities (CORE-163) for
 * snapshot `seq`: write capability and area entities, and record each file's
 * placement for the entity batches. Deterministic and inference-free. An
 * increment that changed no grouping input keeps the published groups and
 * placements; one that did regroups and records only placements that moved.
 */
export async function groupRepoCapabilities(
  d1: D1Database,
  repoId: string,
  snapshotId: string,
  seq: number,
): Promise<GroupStats> {
  const scope = repoScope(repoId);
  const increment = await incrementOf(d1, snapshotId);
  if (increment && !(await groupingInputsChanged(d1, increment))) {
    const counts = await d1
      .prepare(
        `SELECT
           (SELECT count(*) FROM atlas_entities WHERE scope = ?1 AND kind = 'capability' AND to_seq IS NULL) AS capabilities,
           (SELECT count(*) FROM atlas_entities WHERE scope = ?1 AND kind = 'area' AND to_seq IS NULL) AS areas,
           (SELECT count(*) FROM atlas_entities WHERE scope = ?1 AND parent_id = ?2 AND kind = 'file'
              AND to_seq IS NULL AND json_type(data, '$.membership') = 'object') AS unclassified`,
      )
      .bind(scope, GROUPS.unclassified)
      .first<{ capabilities: number; areas: number; unclassified: number }>();
    await db(d1)
      .updateTable("atlas_snapshots")
      .set({ grouping_version: GROUPING_VERSION })
      .where("id", "=", snapshotId)
      .execute();
    return {
      capabilities: Number(counts?.capabilities ?? 0),
      areas: Number(counts?.areas ?? 0),
      unclassified: Number(counts?.unclassified ?? 0),
      regrouped: false,
    };
  }
  const [fileRows, imports, mentions, concepts] = await Promise.all([
    d1
      .prepare(
        `SELECT id, json_extract(data, '$.pending') AS pending, json_extract(data, '$.skipped') AS skipped
         FROM kg_nodes WHERE repo_id = ? AND kind = 'file'`,
      )
      .bind(repoId)
      .all<{ id: string; pending: unknown; skipped: unknown }>(),
    d1
      .prepare(
        `SELECT src, dst FROM kg_edges WHERE repo_id = ? AND kind = 'imports'
         AND src LIKE 'file:%' AND dst LIKE 'file:%'`,
      )
      .bind(repoId)
      .all<{ src: string; dst: string }>(),
    d1
      .prepare(
        `SELECT src AS file, dst AS concept FROM kg_edges WHERE repo_id = ? AND kind = 'mentions'`,
      )
      .bind(repoId)
      .all<{ file: string; concept: string }>(),
    d1
      .prepare(`SELECT id, name FROM kg_nodes WHERE repo_id = ? AND kind = 'concept'`)
      .bind(repoId)
      .all<{ id: string; name: string }>(),
  ]);
  // Only analyzed files are units; pending and skipped ones stay unclassified.
  const files = fileRows.results.filter((row) => !row.pending && !row.skipped).map((row) => row.id);
  const grouping = groupCapabilities({
    files,
    imports: imports.results,
    mentions: mentions.results,
    conceptNames: new Map(concepts.results.map((c) => [c.id, c.name])),
  });

  // A capability with one area holds its files directly.
  const areasOf = new Map(grouping.capabilities.map((c) => [c.id, c.areas]));
  const shownAreas = grouping.areas.filter((a) => (areasOf.get(a.capability)?.length ?? 0) > 1);
  const shown = new Set(shownAreas.map((a) => a.id));

  // Public ids continue the previous snapshot's where membership does (CORE-165).
  const identity = await reconcileIdentity(d1, scope, seq, grouping, shownAreas);
  const capId = (key: string) => identity.capabilities.ids.get(key) ?? key;
  const areaId = (key: string) => identity.areas.ids.get(key) ?? key;
  const areaSlots = slotAreas(shownAreas, capId, areaId, identity.priorAreaSlots);

  const basis = { version: GROUPING_VERSION, evidence: ["imports", "concepts"] };
  const entities: AtlasEntity[] = [
    ...grouping.capabilities.map((c) => {
      const id = capId(c.id);
      return {
        id,
        kind: "capability",
        parentId: "repo",
        name: c.name,
        path: null,
        summary: "",
        data: {
          counts: { files: c.files, areas: c.areas.filter((a) => shown.has(a)).length },
          concepts: c.concepts,
          anchor: c.anchor,
          nameSource: "concepts",
          grouping: basis,
          layout: cell(identity.capabilities.slots.get(id) ?? 0, c.files, GRID_WIDTH.top),
          lineage: identity.origins.get(id) ?? null,
        },
      };
    }),
    ...shownAreas.map((a) => {
      const id = areaId(a.id);
      return {
        id,
        kind: "area",
        parentId: capId(a.capability),
        name: a.concepts[0]?.name ?? a.anchor.split("/").pop() ?? a.anchor,
        path: null,
        summary: "",
        data: {
          counts: { files: a.files.length },
          concepts: a.concepts,
          anchor: a.anchor,
          nameSource: a.concepts.length ? "concepts" : "anchor",
          grouping: basis,
          layout: cell(areaSlots.get(id) ?? 0, a.files.length, GRID_WIDTH.nested),
          lineage: identity.origins.get(id) ?? null,
        },
      };
    }),
  ];
  const bytes = await writeEntities(d1, scope, seq, entities, ["area:", "cap:~"], {
    final: false,
    owns: (id) => id.startsWith("cap:") || id.startsWith("area:"),
  });

  let placements = grouping.members.map((m) => {
    const area = m.area && shown.has(m.area) ? areaId(m.area) : null;
    const capability = m.capability ? capId(m.capability) : null;
    return {
      id: m.file,
      parent: area ?? capability ?? GROUPS.unclassified,
      data: JSON.stringify({
        capability,
        area,
        rationale: m.rationale,
        crossCutting: m.crossCutting.map((x) => ({ ...x, capability: capId(x.capability) })),
        ...(m.unclassified ? { unclassified: m.unclassified } : {}),
      }),
    };
  });
  // Capability to capability: how many file imports cross each boundary.
  const capabilityOf = new Map<string, string>();
  for (const m of grouping.members) if (m.capability) capabilityOf.set(m.file, capId(m.capability));
  const crossing = new Map<string, number>();
  for (const { src, dst } of imports.results) {
    const a = capabilityOf.get(src);
    const b = capabilityOf.get(dst);
    if (a && b && a !== b)
      crossing.set(`${a}\u0000${b}`, (crossing.get(`${a}\u0000${b}`) ?? 0) + 1);
  }
  await writeCapabilityEdges(
    d1,
    scope,
    seq,
    [...crossing].map(([key, weight]) => {
      const [src, dst] = key.split("\u0000") as [string, string];
      return { src, dst, kind: "depends_on", weight };
    }),
  );
  if (increment) {
    // Only placements that moved; a published unit that is no longer one
    // (removed, or no longer analyzed) is recorded as placed nowhere (`null`).
    const units = new Set(placements.map((p) => p.id));
    placements = placements.filter((p) => {
      const was = identity.priorFiles.get(p.id);
      return (
        !was ||
        was.parent !== p.parent ||
        was.membership === null ||
        JSON.stringify(JSON.parse(was.membership)) !== p.data
      );
    });
    for (const [id, was] of identity.priorFiles)
      if (!units.has(id) && was.membership !== null)
        placements.push({ id, parent: GROUPS.unclassified, data: "null" });
  }
  const statements: Statement[] = [
    raw("DELETE FROM atlas_assignments WHERE scope = ? AND seq = ?", scope, seq),
  ];
  for (let i = 0; i < placements.length; i += ROWS_PER_STATEMENT)
    statements.push(
      raw(
        `INSERT INTO atlas_assignments (scope, seq, entity_id, parent_id, data)
         SELECT ?, ?, json_extract(value, '$.id'), json_extract(value, '$.parent'), json_extract(value, '$.data')
         FROM json_each(?)`,
        scope,
        seq,
        JSON.stringify(placements.slice(i, i + ROWS_PER_STATEMENT)),
      ),
    );
  statements.push(raw("DELETE FROM atlas_lineage WHERE scope = ? AND retired_seq = ?", scope, seq));
  for (const [kind, retired] of [
    ["capability", identity.capabilities.retired],
    ["area", identity.areas.retired],
  ] as const)
    for (let i = 0; i < retired.length; i += ROWS_PER_STATEMENT)
      statements.push(
        raw(
          `INSERT INTO atlas_lineage (scope, entity_id, retired_seq, kind, name, change, successors)
           SELECT ?, json_extract(value, '$.id'), ?, ?, json_extract(value, '$.name'), json_extract(value, '$.change'),
                  json_extract(value, '$.successors')
           FROM json_each(?) WHERE true
           ON CONFLICT (scope, entity_id, retired_seq) DO UPDATE SET successors = excluded.successors, change = excluded.change`,
          scope,
          seq,
          kind,
          JSON.stringify(
            retired.slice(i, i + ROWS_PER_STATEMENT).map((r) => ({
              id: r.id,
              name: identity.priorNames.get(r.id) ?? r.id,
              change: r.change,
              successors: JSON.stringify(r.successors),
            })),
          ),
        ),
      );
  statements.push(
    raw(
      "UPDATE atlas_snapshots SET grouping_version = ?, bytes = bytes + ? WHERE id = ?",
      GROUPING_VERSION,
      bytes,
      snapshotId,
    ),
  );
  for (let i = 0; i < statements.length; i += 50) await batch(d1, statements.slice(i, i + 50));
  return {
    ...grouping.stats,
    capabilities: grouping.capabilities.length,
    areas: shownAreas.length,
    regrouped: true,
  };
}

/**
 * Write capability-to-capability edges for snapshot `seq`, versioned like
 * graph edges: unchanged ones stay one row, changed or new ones open at
 * `seq`, and ones no longer there close at `seq`. Idempotent for retries.
 */
export async function writeCapabilityEdges(
  d1: D1Database,
  scope: string,
  seq: number,
  edges: { src: string; dst: string; kind: string; weight: number }[],
) {
  const open = await d1
    .prepare(
      `SELECT src, dst, kind, from_seq, weight FROM atlas_edges
       WHERE scope = ? AND to_seq IS NULL AND src >= 'cap:' AND src < 'cap;'`,
    )
    .bind(scope)
    .all<{ src: string; dst: string; kind: string; from_seq: number; weight: number }>();
  const key = (e: { src: string; dst: string; kind: string }) =>
    `${e.src}\u0000${e.dst}\u0000${e.kind}`;
  const existing = new Map(open.results.map((e) => [key(e), e]));
  const insert: typeof edges = [];
  const close: { src: string; dst: string; kind: string }[] = [];
  const wanted = new Set<string>();
  for (const edge of edges) {
    const k = key(edge);
    wanted.add(k);
    const before = existing.get(k);
    if (before && Number(before.weight) === edge.weight) continue;
    if (before && before.from_seq !== seq) close.push(edge);
    insert.push(edge);
  }
  for (const [k, edge] of existing) if (!wanted.has(k)) close.push(edge);
  const statements: Statement[] = [];
  const match = `(src, dst, kind) IN (SELECT json_extract(value, '$.src'), json_extract(value, '$.dst'), json_extract(value, '$.kind') FROM json_each(?))`;
  for (let i = 0; i < close.length; i += ROWS_PER_STATEMENT) {
    const list = JSON.stringify(close.slice(i, i + ROWS_PER_STATEMENT));
    statements.push(
      raw(
        `DELETE FROM atlas_edges WHERE scope = ? AND from_seq = ? AND ${match}`,
        scope,
        seq,
        list,
      ),
      raw(
        `UPDATE atlas_edges SET to_seq = ? WHERE scope = ? AND to_seq IS NULL AND ${match}`,
        seq,
        scope,
        list,
      ),
    );
  }
  for (let i = 0; i < insert.length; i += ROWS_PER_STATEMENT)
    statements.push(
      raw(
        `INSERT INTO atlas_edges (scope, src, dst, kind, from_seq, to_seq, weight)
         SELECT ?, json_extract(value, '$.src'), json_extract(value, '$.dst'), json_extract(value, '$.kind'), ?, NULL,
                json_extract(value, '$.weight')
         FROM json_each(?) WHERE true
         ON CONFLICT (scope, src, dst, kind, from_seq) DO UPDATE SET weight = excluded.weight, to_seq = NULL`,
        scope,
        seq,
        JSON.stringify(insert.slice(i, i + ROWS_PER_STATEMENT)),
      ),
    );
  for (let i = 0; i < statements.length; i += 50) await batch(d1, statements.slice(i, i + 50));
}

/**
 * Every grouped file's membership JSON in a snapshot being built, once its
 * grouping step has run: the placements it recorded, and for an increment the
 * published placements of the files it didn't move.
 */
export async function buildingMemberships(
  d1: D1Database,
  snapshotId: string,
): Promise<{ entity_id: string; data: string }[]> {
  const inc = await incrementOf(d1, snapshotId);
  const snapshot = await db(d1)
    .selectFrom("atlas_snapshots")
    .select(["scope", "seq"])
    .where("id", "=", snapshotId)
    .executeTakeFirst();
  if (!snapshot) return [];
  const recorded = `SELECT entity_id, data FROM atlas_assignments WHERE scope = ?1 AND seq = ?2 AND data != 'null'`;
  const rows = await d1
    .prepare(
      inc
        ? `${recorded}
           UNION ALL
           SELECT e.entity_id, json_extract(e.data, '$.membership') FROM atlas_entities e
           WHERE e.scope = ?1 AND e.kind = 'file' AND e.from_seq <= ?3 AND (e.to_seq IS NULL OR e.to_seq > ?3)
             AND json_type(e.data, '$.membership') = 'object'
             AND NOT EXISTS (SELECT 1 FROM atlas_assignments a WHERE a.scope = ?1 AND a.seq = ?2 AND a.entity_id = e.entity_id)`
        : recorded,
    )
    .bind(snapshot.scope, snapshot.seq, ...(inc ? [inc.baseSeq] : []))
    .all<{ entity_id: string; data: string }>();
  return rows.results;
}

/**
 * Reconcile this build's capabilities and areas with the published snapshot's
 * (CORE-165): continuing ones keep their ids and slots, others get opaque ids
 * minted from the scope, snapshot and anchor (so a retried step reuses them).
 */
async function reconcileIdentity(
  d1: D1Database,
  scope: string,
  seq: number,
  grouping: Grouping,
  shownAreas: Grouping["areas"],
): Promise<{
  capabilities: Reconciled;
  areas: Reconciled;
  priorAreaSlots: Map<string, { slot: number | null; parent: string | null }>;
  priorNames: Map<string, string>;
  origins: Map<string, unknown>;
  /** Published files' placements: parent and membership JSON (null when ungrouped). */
  priorFiles: Map<string, { parent: string | null; membership: string | null }>;
}> {
  const published = await db(d1)
    .selectFrom("atlas_current")
    .select("seq")
    .where("scope", "=", scope)
    .executeTakeFirst();
  const priorSeq = published?.seq ?? null;
  const priorFiles = new Map<string, { parent: string | null; membership: string | null }>();
  const capMembers = new Map<string, string[]>();
  const areaMembers = new Map<string, string[]>();
  const regions = new Map<
    string,
    { kind: string; slot: number | null; parent: string | null; name: string; lineage: unknown }
  >();
  if (priorSeq !== null && priorSeq < seq) {
    const [files, groups] = await Promise.all([
      d1
        .prepare(
          `SELECT entity_id, parent_id, json_extract(data, '$.membership') AS membership
           FROM atlas_entities WHERE scope = ? AND kind = 'file' AND ${VISIBLE}`,
        )
        .bind(scope, priorSeq, priorSeq)
        .all<{ entity_id: string; parent_id: string | null; membership: string | null }>(),
      d1
        .prepare(
          `SELECT entity_id, kind, parent_id, name, json_extract(data, '$.layout.slot') AS slot,
                  json_extract(data, '$.lineage') AS lineage
           FROM atlas_entities WHERE scope = ? AND kind IN ('capability', 'area') AND ${VISIBLE}`,
        )
        .bind(scope, priorSeq, priorSeq)
        .all<{
          entity_id: string;
          kind: string;
          parent_id: string | null;
          name: string;
          slot: number | null;
          lineage: string | null;
        }>(),
    ]);
    for (const f of files.results) {
      priorFiles.set(f.entity_id, { parent: f.parent_id, membership: f.membership });
      const membership = f.membership
        ? (JSON.parse(f.membership) as { capability?: string | null; area?: string | null } | null)
        : null;
      const cap = membership?.capability;
      const area = membership?.area;
      if (cap) capMembers.set(cap, [...(capMembers.get(cap) ?? []), f.entity_id]);
      if (area) areaMembers.set(area, [...(areaMembers.get(area) ?? []), f.entity_id]);
    }
    for (const g of groups.results)
      regions.set(g.entity_id, {
        kind: g.kind,
        slot: g.slot === null || g.slot === undefined ? null : Number(g.slot),
        parent: g.parent_id,
        name: g.name,
        lineage: g.lineage ? JSON.parse(g.lineage) : null,
      });
  }
  const prior = (kind: string, members: Map<string, string[]>): PriorGroup[] =>
    [...regions]
      .filter(([, r]) => r.kind === kind)
      .map(([id, r]) => ({ id, members: members.get(id) ?? [], slot: r.slot }));

  const filesOf = new Map<string, string[]>();
  for (const m of grouping.members)
    if (m.capability) filesOf.set(m.capability, [...(filesOf.get(m.capability) ?? []), m.file]);
  const minted = new Map<string, string>();
  const mint = async (prefix: string, key: string, anchor: string) =>
    minted.set(
      key,
      `${prefix}:${(await sha256(`${scope}\u0000${seq}\u0000${prefix}\u0000${anchor}`)).slice(0, 12)}`,
    );
  for (const c of grouping.capabilities) await mint("cap", c.id, c.anchor);
  for (const a of shownAreas) await mint("area", a.id, a.anchor);

  const capabilities = reconcile(
    prior("capability", capMembers),
    grouping.capabilities.map((c) => ({ key: c.id, members: filesOf.get(c.id) ?? [] })),
    (key) => minted.get(key)!,
  );
  const areas = reconcile(
    prior("area", areaMembers),
    shownAreas.map((a) => ({ key: a.id, members: a.files })),
    (key) => minted.get(key)!,
  );
  const priorAreaSlots = new Map(
    [...regions]
      .filter(([, r]) => r.kind === "area")
      .map(([id, r]) => [id, { slot: r.slot, parent: r.parent }]),
  );
  // What an entity records about its origin: a split or merge, from the
  // snapshot that made it, carried unchanged while the id continues (so an
  // unchanged rebuild rewrites nothing). Ids that are simply new or kept
  // record nothing.
  const origins = new Map<string, unknown>();
  for (const result of [capabilities, areas])
    for (const [id, lineage] of result.lineage) {
      if (lineage.change === "kept") origins.set(id, regions.get(id)?.lineage ?? null);
      else if (lineage.change === "split" || lineage.change === "merge")
        origins.set(id, { ...lineage, since: seq });
      else origins.set(id, null);
    }
  return {
    capabilities,
    areas,
    priorAreaSlots,
    priorNames: new Map([...regions].map(([id, r]) => [id, r.name])),
    origins,
    priorFiles,
  };
}

/**
 * Slots for areas within their capability: an area that keeps its id and
 * parent keeps its slot; the rest take the lowest free slot in their parent.
 */
function slotAreas(
  areas: Grouping["areas"],
  capId: (key: string) => string,
  areaId: (key: string) => string,
  prior: Map<string, { slot: number | null; parent: string | null }>,
): Map<string, number> {
  const slots = new Map<string, number>();
  const byParent = new Map<string, string[]>();
  for (const a of areas) {
    const parent = capId(a.capability);
    byParent.set(parent, [...(byParent.get(parent) ?? []), areaId(a.id)]);
  }
  for (const [parent, ids] of byParent) {
    const taken = new Set<number>();
    for (const id of ids) {
      const before = prior.get(id);
      if (before && before.parent === parent && before.slot !== null && !taken.has(before.slot)) {
        slots.set(id, before.slot);
        taken.add(before.slot);
      }
    }
    let free = 0;
    for (const id of [...ids].sort()) {
      if (slots.has(id)) continue;
      while (taken.has(free)) free++;
      slots.set(id, free);
      taken.add(free);
    }
  }
  return slots;
}

// ---- edges -------------------------------------------------------------------

export type EdgeCursor = [string, string, string] | null;

/** Project the next batch of a repository's graph edges into snapshot `seq`. */
export async function projectEdges(
  d1: D1Database,
  repoId: string,
  snapshotId: string,
  seq: number,
  after: EdgeCursor,
  limit = EDGE_BATCH,
): Promise<{ next: EdgeCursor; written: number }> {
  const scope = repoScope(repoId);
  const start = after ?? ["", "", ""];
  const increment = await incrementOf(d1, snapshotId);
  let rows: { src: string; dst: string; kind: string; weight: number }[];
  let final: boolean;
  let last: EdgeCursor;
  let open: { src: string; dst: string; kind: string; from_seq: number; weight: number }[];
  if (increment) {
    // An increment's batch: the next changed edges, as the graph has them now
    // (no weight: removed) and as the projection has them open.
    const changed = `WITH changed AS (
      SELECT DISTINCT src, dst, edge_kind AS kind FROM atlas_feed
      WHERE repo_id = ?1 AND kind = 'edge' AND id > ?2 AND id <= ?3 AND (src, dst, edge_kind) > (?4, ?5, ?6)
      ORDER BY src, dst, edge_kind LIMIT ?7)`;
    const bind = [repoId, increment.base, increment.mark, ...start, limit];
    const [now, before] = await Promise.all([
      d1
        .prepare(
          `${changed} SELECT c.src, c.dst, c.kind, k.weight FROM changed c
           LEFT JOIN kg_edges k ON k.repo_id = ?1 AND k.src = c.src AND k.dst = c.dst AND k.kind = c.kind
           ORDER BY c.src, c.dst, c.kind`,
        )
        .bind(...bind)
        .all<{ src: string; dst: string; kind: string; weight: number | null }>(),
      d1
        .prepare(
          `${changed} SELECT a.src, a.dst, a.kind, a.from_seq, a.weight FROM changed c
           JOIN atlas_edges a ON a.scope = ?8 AND a.src = c.src AND a.dst = c.dst AND a.kind = c.kind
           AND a.to_seq IS NULL`,
        )
        .bind(...bind, scope)
        .all<{ src: string; dst: string; kind: string; from_seq: number; weight: number }>(),
    ]);
    final = now.results.length < limit;
    const lastRow = now.results.at(-1);
    last = lastRow ? [lastRow.src, lastRow.dst, lastRow.kind] : null;
    rows = now.results.flatMap((r) => (r.weight === null ? [] : [{ ...r, weight: r.weight }]));
    open = before.results;
  } else {
    const edges = await d1
      .prepare(
        `SELECT src, dst, kind, weight FROM kg_edges
         WHERE repo_id = ? AND (src, dst, kind) > (?, ?, ?)
         ORDER BY src, dst, kind LIMIT ?`,
      )
      .bind(repoId, ...start, limit)
      .all<{ src: string; dst: string; kind: string; weight: number }>();
    rows = edges.results;
    final = rows.length < limit;
    const lastRow = rows.at(-1);
    last = lastRow ? [lastRow.src, lastRow.dst, lastRow.kind] : null;
    const bounds = final || !last ? "" : "AND (src, dst, kind) <= (?, ?, ?)";
    // `+to_seq`: walk the key range by primary key, not every open row by to_seq.
    open = (
      await d1
        .prepare(
          `SELECT src, dst, kind, from_seq, weight FROM atlas_edges
           WHERE scope = ? AND +to_seq IS NULL AND (src, dst, kind) > (?, ?, ?) ${bounds}`,
        )
        .bind(scope, ...start, ...(final || !last ? [] : last))
        .all<{ src: string; dst: string; kind: string; from_seq: number; weight: number }>()
    ).results;
  }
  const key = (e: { src: string; dst: string; kind: string }) =>
    `${e.src}\u0000${e.dst}\u0000${e.kind}`;
  const existing = new Map(open.map((e) => [key(e), e]));

  const insert: { src: string; dst: string; kind: string; weight: number }[] = [];
  const close: { src: string; dst: string; kind: string }[] = [];
  const wanted = new Set<string>();
  for (const edge of rows) {
    const k = key(edge);
    wanted.add(k);
    const before = existing.get(k);
    if (before && before.weight === edge.weight) continue;
    if (before && before.from_seq !== seq) close.push(edge);
    insert.push(edge);
  }
  // Capability edges come from the grouping step, not the graph: never close them here.
  for (const [k, edge] of existing) if (!wanted.has(k) && !isSynthetic(edge.src)) close.push(edge);

  const statements: Statement[] = [];
  for (let i = 0; i < close.length; i += ROWS_PER_STATEMENT) {
    const list = JSON.stringify(close.slice(i, i + ROWS_PER_STATEMENT));
    const match = `(src, dst, kind) IN (SELECT json_extract(value, '$.src'), json_extract(value, '$.dst'), json_extract(value, '$.kind') FROM json_each(?))`;
    statements.push(
      raw(
        `DELETE FROM atlas_edges WHERE scope = ? AND from_seq = ? AND ${match}`,
        scope,
        seq,
        list,
      ),
      raw(
        `UPDATE atlas_edges SET to_seq = ? WHERE scope = ? AND to_seq IS NULL AND ${match}`,
        seq,
        scope,
        list,
      ),
    );
  }
  for (let i = 0; i < insert.length; i += ROWS_PER_STATEMENT) {
    statements.push(
      raw(
        `INSERT INTO atlas_edges (scope, src, dst, kind, from_seq, to_seq, weight)
         SELECT ?, json_extract(value, '$.src'), json_extract(value, '$.dst'), json_extract(value, '$.kind'), ?, NULL,
                json_extract(value, '$.weight')
         FROM json_each(?) WHERE true
         ON CONFLICT (scope, src, dst, kind, from_seq) DO UPDATE SET weight = excluded.weight, to_seq = NULL`,
        scope,
        seq,
        JSON.stringify(insert.slice(i, i + ROWS_PER_STATEMENT)),
      ),
    );
  }
  for (let i = 0; i < statements.length; i += 50) await batch(d1, statements.slice(i, i + 50));
  const bytes = insert.reduce(
    (n, e) => n + len(e.src) + len(e.dst) + len(e.kind) + EDGE_ROW_OVERHEAD,
    0,
  );
  await db(d1)
    .updateTable("atlas_snapshots")
    .set((eb) => ({ bytes: eb("bytes", "+", bytes) }))
    .where("id", "=", snapshotId)
    .execute();
  return { next: final ? null : last, written: rows.length };
}

// ---- reads -------------------------------------------------------------------

export function toSnapshot(row: {
  id: string;
  scope: string;
  seq: number;
  status: string;
  partial: number;
  projection_version: number;
  vector: string;
  entities: number;
  edges: number;
  bytes: number;
  published_at: string | null;
  expires_at: string | null;
  expired_reason: string | null;
}): AtlasSnapshot {
  return {
    id: row.id,
    scope: row.scope,
    seq: row.seq,
    status: row.status as AtlasSnapshot["status"],
    partial: Boolean(row.partial),
    projectionVersion: row.projection_version,
    vector: JSON.parse(row.vector) as VectorEntry[],
    entities: Number(row.entities),
    edges: Number(row.edges),
    bytes: Number(row.bytes),
    publishedAt: row.published_at,
    expiresAt: row.expires_at,
    expiredReason: row.expired_reason as AtlasSnapshot["expiredReason"],
  };
}

/** The published snapshot a scope's readers see, if any. */
export async function currentSnapshot(
  d1: D1Database,
  scope: string,
): Promise<AtlasSnapshot | null> {
  const row = await db(d1)
    .selectFrom("atlas_current as c")
    .innerJoin("atlas_snapshots as s", "s.id", "c.snapshot_id")
    .selectAll("s")
    .where("c.scope", "=", scope)
    .executeTakeFirst();
  return row ? toSnapshot(row) : null;
}

/** A snapshot by id within a scope (pinned reads); null when unknown. */
export async function snapshotById(
  d1: D1Database,
  scope: string,
  id: string,
): Promise<AtlasSnapshot | null> {
  const row = await db(d1)
    .selectFrom("atlas_snapshots")
    .selectAll()
    .where("scope", "=", scope)
    .where("id", "=", id)
    .executeTakeFirst();
  return row ? toSnapshot(row) : null;
}

function toEntity(row: {
  entity_id: string;
  kind: string;
  parent_id: string | null;
  name: string;
  path: string | null;
  summary: string;
  data: string;
  from_seq?: number;
}): AtlasEntity {
  return {
    id: row.entity_id,
    kind: row.kind,
    parentId: row.parent_id,
    name: row.name,
    path: row.path,
    summary: row.summary,
    data: JSON.parse(row.data) as Record<string, unknown>,
    // The snapshot its current row was written in: equal to the snapshot
    // read, it changed in that build.
    ...(row.from_seq === undefined ? {} : { since: Number(row.from_seq) }),
  };
}

/** One entity as snapshot `seq` saw it. */
export async function entityAt(
  d1: D1Database,
  scope: string,
  seq: number,
  id: string,
): Promise<AtlasEntity | null> {
  const row = await d1
    .prepare(
      `SELECT entity_id, kind, parent_id, name, path, summary, data, from_seq FROM atlas_entities
       WHERE scope = ? AND entity_id = ? AND ${VISIBLE}`,
    )
    .bind(scope, id, seq, seq)
    .first<Parameters<typeof toEntity>[0]>();
  return row ? toEntity(row) : null;
}

/** A page of an entity's children in snapshot `seq`, in stable order. */
export async function childrenAt(
  d1: D1Database,
  scope: string,
  seq: number,
  parentId: string,
  after: string | null,
  limit: number,
): Promise<{ entities: AtlasEntity[]; next: string | null }> {
  const rows = await d1
    .prepare(
      `SELECT entity_id, kind, parent_id, name, path, summary, data, from_seq, sort_key FROM atlas_entities
       WHERE scope = ? AND parent_id = ? AND sort_key > ? AND ${VISIBLE}
       ORDER BY sort_key LIMIT ?`,
    )
    .bind(scope, parentId, after ?? "", seq, seq, limit + 1)
    .all<Parameters<typeof toEntity>[0] & { sort_key: string }>();
  const page = rows.results.slice(0, limit);
  return {
    entities: page.map(toEntity),
    next: rows.results.length > limit ? (page.at(-1)?.sort_key ?? null) : null,
  };
}

/** Edges leaving (or, with `incoming`, arriving at) an entity in snapshot `seq`. */
export async function edgesAt(
  d1: D1Database,
  scope: string,
  seq: number,
  entityId: string,
  incoming: boolean,
): Promise<{ src: string; dst: string; kind: string; weight: number }[]> {
  const rows = await d1
    .prepare(
      `SELECT src, dst, kind, weight FROM atlas_edges
       WHERE scope = ? AND ${incoming ? "dst" : "src"} = ? AND ${VISIBLE}
       ORDER BY src, dst, kind`,
    )
    .bind(scope, entityId, seq, seq)
    .all<{ src: string; dst: string; kind: string; weight: number }>();
  return rows.results.map((r) => ({ ...r, weight: Number(r.weight) }));
}

// ---- bounded reads (CORE-160) --------------------------------------------------
//
// Keyset pages over one snapshot for the Atlas read API. Each reads only rows
// visible at `seq` (the same [from_seq, to_seq) rule as above), so a page keeps
// reading what its snapshot published whatever has been written since.

type EntityRow = Parameters<typeof toEntity>[0];
const ENTITY_COLUMNS = "entity_id, kind, parent_id, name, path, summary, data, from_seq";
/** VISIBLE for a joined table. */
const visibleAs = (alias: string) =>
  `${alias}.from_seq <= ? AND (${alias}.to_seq IS NULL OR ${alias}.to_seq > ?)`;

/** The repository root every top-level region hangs from. */
export const ROOT = "repo";

/**
 * Primary (deduplicated) files of a top-level region: a capability's or
 * component's `counts.files`, or the unclassified group's members (its
 * members are files). Other structural groups hold no files directly.
 */
const PRIMARY_FILES = `coalesce(json_extract(data, '$.counts.files'), CASE WHEN entity_id = '${GROUPS.unclassified}' THEN json_extract(data, '$.members') END, 0)`;
/**
 * Direct members: a group's members, a capability's areas when it has them
 * (its files then sit under the areas), else its files.
 */
const MEMBERS = `coalesce(json_extract(data, '$.members'), nullif(json_extract(data, '$.counts.areas'), 0), json_extract(data, '$.counts.files'), 0)`;
/** Semantic regions (capabilities, or components before grouping) first, structural groups after. */
const TIER = `CASE WHEN kind = 'group' OR json_extract(data, '$.structural') = 1 THEN 1 ELSE 0 END`;

/** Where a ranked top-level page stopped: [tier, files, members, sort_key]. */
export type RegionKey = [number, number, number, string];

/**
 * A page of the root's children, ranked: semantic regions (capabilities, or
 * components in an ungrouped projection) before structural groups, each by
 * primary files, then direct members, then name. `inclusive` starts at
 * `after` itself rather than past it (for merging several scopes' pages).
 */
export async function regionsAt(
  d1: D1Database,
  scope: string,
  seq: number,
  after: RegionKey | null,
  limit: number,
  inclusive = false,
): Promise<{
  regions: (AtlasEntity & { files: number; members: number; key: RegionKey })[];
  next: RegionKey | null;
}> {
  const keyset = after
    ? `AND (tier > ? OR (tier = ? AND (files < ? OR (files = ? AND
         (members < ? OR (members = ? AND sort_key ${inclusive ? ">=" : ">"} ?))))))`
    : "";
  const rows = await d1
    .prepare(
      `SELECT * FROM (
         SELECT ${ENTITY_COLUMNS}, sort_key, ${TIER} AS tier, ${PRIMARY_FILES} AS files, ${MEMBERS} AS members
         FROM atlas_entities WHERE scope = ? AND parent_id = ? AND ${VISIBLE}
       ) WHERE true ${keyset}
       ORDER BY tier, files DESC, members DESC, sort_key LIMIT ?`,
    )
    .bind(
      scope,
      ROOT,
      seq,
      seq,
      ...(after ? [after[0], after[0], after[1], after[1], after[2], after[2], after[3]] : []),
      limit + 1,
    )
    .all<EntityRow & { sort_key: string; tier: number; files: number; members: number }>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    regions: page.map((r) => ({
      ...toEntity(r),
      files: Number(r.files),
      members: Number(r.members),
      key: [Number(r.tier), Number(r.files), Number(r.members), r.sort_key] as RegionKey,
    })),
    next:
      rows.results.length > limit && last
        ? [Number(last.tier), Number(last.files), Number(last.members), last.sort_key]
        : null,
  };
}

/** How many children an entity has in snapshot `seq`. */
export async function childCountAt(
  d1: D1Database,
  scope: string,
  seq: number,
  parentId: string,
): Promise<number> {
  const row = await d1
    .prepare(
      `SELECT count(*) AS n FROM atlas_entities WHERE scope = ? AND parent_id = ? AND ${VISIBLE}`,
    )
    .bind(scope, parentId, seq, seq)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * An entity's ancestors in snapshot `seq`, root first, up to `maxDepth` of
 * them; `truncated` when the chain goes further (or loops).
 */
export async function ancestorsAt(
  d1: D1Database,
  scope: string,
  seq: number,
  id: string,
  maxDepth = 64,
): Promise<{ ancestors: AtlasEntity[]; truncated: boolean }> {
  const rows = await d1
    .prepare(
      `WITH RECURSIVE up (id, depth) AS (
         SELECT parent_id, 1 FROM atlas_entities
         WHERE scope = ?1 AND entity_id = ?2 AND from_seq <= ?3 AND (to_seq IS NULL OR to_seq > ?3)
         UNION ALL
         SELECT e.parent_id, up.depth + 1 FROM up JOIN atlas_entities e
           ON e.scope = ?1 AND e.entity_id = up.id AND e.from_seq <= ?3 AND (e.to_seq IS NULL OR e.to_seq > ?3)
         WHERE up.depth <= ?4
       )
       SELECT e.entity_id, e.kind, e.parent_id, e.name, e.path, e.summary, e.data, e.from_seq, up.depth
       FROM up JOIN atlas_entities e
         ON e.scope = ?1 AND e.entity_id = up.id AND e.from_seq <= ?3 AND (e.to_seq IS NULL OR e.to_seq > ?3)
       ORDER BY up.depth DESC`,
    )
    .bind(scope, id, seq, maxDepth)
    .all<EntityRow & { depth: number }>();
  const within = rows.results.filter((r) => Number(r.depth) <= maxDepth);
  return {
    ancestors: within.map(toEntity),
    truncated: within.length < rows.results.length,
  };
}

/** Edges per kind leaving (or, with `incoming`, arriving at) an entity in snapshot `seq`. */
export async function edgeCountsAt(
  d1: D1Database,
  scope: string,
  seq: number,
  entityId: string,
  incoming: boolean,
  kind: string | null = null,
): Promise<Record<string, number>> {
  const rows = await d1
    .prepare(
      `SELECT kind, count(*) AS n FROM atlas_edges
       WHERE scope = ? AND ${incoming ? "dst" : "src"} = ? AND ${VISIBLE} ${kind === null ? "" : "AND kind = ?"}
       GROUP BY kind ORDER BY kind`,
    )
    .bind(scope, entityId, seq, seq, ...(kind === null ? [] : [kind]))
    .all<{ kind: string; n: number }>();
  return Object.fromEntries(rows.results.map((r) => [r.kind, Number(r.n)]));
}

/** Where a relation page stopped: [the other end's id, kind]. */
export type RelationKey = [string, string];

/**
 * A page of an entity's edges in snapshot `seq`, ordered by the other end then
 * kind, each with the entity at its other end (null when the snapshot has none).
 */
export async function relationsAt(
  d1: D1Database,
  scope: string,
  seq: number,
  entityId: string,
  incoming: boolean,
  kind: string | null,
  after: RelationKey | null,
  limit: number,
): Promise<{
  relations: {
    src: string;
    dst: string;
    kind: string;
    weight: number;
    neighbor: AtlasEntity | null;
  }[];
  next: RelationKey | null;
}> {
  const [self, other] = incoming ? ["dst", "src"] : ["src", "dst"];
  const rows = await d1
    .prepare(
      `SELECT g.src, g.dst, g.kind, g.weight,
              n.entity_id, n.kind AS n_kind, n.parent_id, n.name, n.path, n.summary, n.data
       FROM atlas_edges g
       LEFT JOIN atlas_entities n ON n.scope = g.scope AND n.entity_id = g.${other} AND ${visibleAs("n")}
       WHERE g.scope = ? AND g.${self} = ? AND ${visibleAs("g")}
         ${kind === null ? "" : "AND g.kind = ?"}
         AND (g.${other}, g.kind) > (?, ?)
       ORDER BY g.${other}, g.kind LIMIT ?`,
    )
    .bind(
      seq,
      seq,
      scope,
      entityId,
      seq,
      seq,
      ...(kind === null ? [] : [kind]),
      ...(after ?? ["", ""]),
      limit + 1,
    )
    .all<
      { src: string; dst: string; kind: string; weight: number; n_kind: string | null } & Omit<
        EntityRow,
        "kind" | "entity_id"
      > & { entity_id: string | null }
    >();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    relations: page.map((r) => ({
      src: r.src,
      dst: r.dst,
      kind: r.kind,
      weight: Number(r.weight),
      neighbor:
        r.entity_id === null || r.n_kind === null
          ? null
          : toEntity({ ...r, entity_id: r.entity_id, kind: r.n_kind }),
    })),
    next: rows.results.length > limit && last ? [incoming ? last.src : last.dst, last.kind] : null,
  };
}

/**
 * Files backing an entity in snapshot `seq`, by file id: its member files
 * (a capability's include its areas' files), the files it contains, and the
 * files that mention or import it. Each file once.
 */
function evidenceSource(): string {
  return `SELECT entity_id AS id, 'member' AS via FROM atlas_entities
            WHERE scope = ?1 AND parent_id = ?2 AND kind = 'file' AND entity_id > ?4
              AND from_seq <= ?3 AND (to_seq IS NULL OR to_seq > ?3)
          UNION ALL
          SELECT f.entity_id, 'member' FROM atlas_entities a
            JOIN atlas_entities f ON f.scope = a.scope AND f.parent_id = a.entity_id
              AND f.kind = 'file' AND f.entity_id > ?4
              AND f.from_seq <= ?3 AND (f.to_seq IS NULL OR f.to_seq > ?3)
            WHERE a.scope = ?1 AND a.parent_id = ?2 AND a.kind = 'area'
              AND a.from_seq <= ?3 AND (a.to_seq IS NULL OR a.to_seq > ?3)
          UNION ALL
          SELECT dst, kind FROM atlas_edges
            WHERE scope = ?1 AND src = ?2 AND kind = 'contains' AND dst > ?4
              AND from_seq <= ?3 AND (to_seq IS NULL OR to_seq > ?3)
          UNION ALL
          SELECT src, kind FROM atlas_edges
            WHERE scope = ?1 AND dst = ?2 AND kind IN ('mentions', 'imports') AND src > ?4
              AND from_seq <= ?3 AND (to_seq IS NULL OR to_seq > ?3)`;
}

/** A page of the files backing a (non-file) entity; see evidenceSource. */
export async function evidenceFilesAt(
  d1: D1Database,
  scope: string,
  seq: number,
  entityId: string,
  after: string | null,
  limit: number,
): Promise<{ files: (AtlasEntity & { via: string })[]; next: string | null }> {
  const rows = await d1
    .prepare(
      `SELECT f.entity_id, f.kind, f.parent_id, f.name, f.path, f.summary, f.data,
              min(CASE c.via WHEN 'member' THEN 0 WHEN 'contains' THEN 1 WHEN 'mentions' THEN 2 ELSE 3 END) AS rank
       FROM (${evidenceSource()}) c
       JOIN atlas_entities f ON f.scope = ?1 AND f.entity_id = c.id AND f.kind = 'file'
         AND f.from_seq <= ?3 AND (f.to_seq IS NULL OR f.to_seq > ?3)
       GROUP BY f.entity_id ORDER BY f.entity_id LIMIT ?5`,
    )
    .bind(scope, entityId, seq, after ?? "", limit + 1)
    .all<EntityRow & { rank: number }>();
  const page = rows.results.slice(0, limit);
  const via = ["member", "contains", "mentions", "imports"];
  return {
    files: page.map((r) => ({ ...toEntity(r), via: via[Number(r.rank)] ?? "imports" })),
    next: rows.results.length > limit ? (page.at(-1)?.entity_id ?? null) : null,
  };
}

/** How many files back an entity in snapshot `seq` (see evidenceFilesAt). */
export async function evidenceCountAt(
  d1: D1Database,
  scope: string,
  seq: number,
  entityId: string,
): Promise<number> {
  const row = await d1
    .prepare(
      `SELECT count(DISTINCT f.entity_id) AS n FROM (${evidenceSource()}) c
       JOIN atlas_entities f ON f.scope = ?1 AND f.entity_id = c.id AND f.kind = 'file'
         AND f.from_seq <= ?3 AND (f.to_seq IS NULL OR f.to_seq > ?3)`,
    )
    .bind(scope, entityId, seq, "")
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** `q` as a LIKE pattern matching it anywhere, wildcards escaped. */
const containsPattern = (q: string) => `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/**
 * A page of snapshot `seq`'s entities whose name or path contains `q`
 * (case-insensitive for ASCII), optionally of one kind, in stable name order.
 * A lookup over the projection, not a search engine. `inclusive` starts at
 * `after` itself (for merging several scopes' pages).
 */
export async function catalogueAt(
  d1: D1Database,
  scope: string,
  seq: number,
  q: string,
  kind: string | null,
  after: string | null,
  limit: number,
  inclusive = false,
): Promise<{ entities: (AtlasEntity & { sortKey: string })[]; next: string | null }> {
  const pattern = containsPattern(q);
  const rows = await d1
    .prepare(
      `SELECT ${ENTITY_COLUMNS}, sort_key FROM atlas_entities
       WHERE scope = ? AND ${VISIBLE} AND sort_key ${inclusive ? ">=" : ">"} ?
         AND (name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\') ${kind === null ? "" : "AND kind = ?"}
       ORDER BY sort_key LIMIT ?`,
    )
    .bind(
      scope,
      seq,
      seq,
      after ?? "",
      pattern,
      pattern,
      ...(kind === null ? [] : [kind]),
      limit + 1,
    )
    .all<EntityRow & { sort_key: string }>();
  const page = rows.results.slice(0, limit);
  return {
    entities: page.map((r) => ({ ...toEntity(r), sortKey: r.sort_key })),
    next: rows.results.length > limit ? (page.at(-1)?.sort_key ?? null) : null,
  };
}

/** How many entities catalogueAt would list in all. */
export async function catalogueCountAt(
  d1: D1Database,
  scope: string,
  seq: number,
  q: string,
  kind: string | null,
): Promise<number> {
  const pattern = containsPattern(q);
  const row = await d1
    .prepare(
      `SELECT count(*) AS n FROM atlas_entities
       WHERE scope = ? AND ${VISIBLE}
         AND (name LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\') ${kind === null ? "" : "AND kind = ?"}`,
    )
    .bind(scope, seq, seq, pattern, pattern, ...(kind === null ? [] : [kind]))
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/**
 * The file imports behind one capability-to-capability relation (CORE-169):
 * edges from files whose primary capability is `from` to files whose primary
 * capability is `to`, in snapshot `seq`, paged by (src, dst).
 */
export async function contributingAt(
  d1: D1Database,
  scope: string,
  seq: number,
  from: string,
  to: string,
  after: [string, string] | null,
  limit: number,
): Promise<{
  links: { src: string; dst: string; srcPath: string | null; dstPath: string | null }[];
  next: [string, string] | null;
}> {
  const rows = await d1
    .prepare(
      `SELECT g.src, g.dst, s.path AS src_path, d.path AS dst_path
       FROM atlas_entities s
       JOIN atlas_edges g ON g.scope = s.scope AND g.src = s.entity_id AND g.kind = 'imports' AND ${visibleAs("g")}
       JOIN atlas_entities d ON d.scope = g.scope AND d.entity_id = g.dst AND ${visibleAs("d")} AND d.capability = ?
       WHERE s.scope = ? AND s.capability = ? AND ${visibleAs("s")} AND (g.src, g.dst) > (?, ?)
       ORDER BY g.src, g.dst LIMIT ?`,
    )
    .bind(seq, seq, seq, seq, to, scope, from, seq, seq, ...(after ?? ["", ""]), limit + 1)
    .all<{ src: string; dst: string; src_path: string | null; dst_path: string | null }>();
  const page = rows.results.slice(0, limit);
  const last = page.at(-1);
  return {
    links: page.map((r) => ({ src: r.src, dst: r.dst, srcPath: r.src_path, dstPath: r.dst_path })),
    next: rows.results.length > limit && last ? [last.src, last.dst] : null,
  };
}
