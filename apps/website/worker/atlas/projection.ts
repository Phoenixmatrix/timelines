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

import { batch, db, nowIso } from "../schema.ts";
import { sha256 } from "../knowledge/util.ts";

/** Bump when the projected shape changes: snapshots record which one built them. */
export const PROJECTION_VERSION = 1;
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
}

export interface AtlasEntity {
  id: string;
  kind: string;
  parentId: string | null;
  name: string;
  path: string | null;
  summary: string;
  data: Record<string, unknown>;
}

type Statement = { compile(): { sql: string; parameters: readonly unknown[] } };
const raw = (sql: string, ...parameters: unknown[]): Statement => ({
  compile: () => ({ sql, parameters }),
});

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
    raw(
      "UPDATE atlas_snapshots SET status = 'failed', error = coalesce(error, 'Superseded before publication.') WHERE scope = ? AND seq > ? AND status = 'building'",
      scope,
      published,
    ),
  ]);
}

/** Start a snapshot for a repository's projection, after rolling back any unpublished one. */
export async function beginRepoProjection(
  d1: D1Database,
  repoId: string,
  vector: VectorEntry[],
): Promise<{ snapshotId: string; seq: number }> {
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
    })
    .execute();
  return { snapshotId, seq };
}

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
  const groupBytes = await writeEntities(d1, scope, seq, groups, ["group:", "group:~"], {
    final: false,
    only: new Set(Object.values(GROUPS)),
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

/** Where an entity sits in the primary tree. Each source unit has exactly one parent. */
export function parentOf(
  id: string,
  kind: string,
  path: string | null,
  componentOf: Map<string, string>,
  broaderOf: Map<string, string>,
): string | null {
  switch (kind) {
    case "repository":
      return null;
    case "component":
      return "repo";
    case "file":
      return componentOf.get(id) ?? GROUPS.unclassified;
    case "symbol": {
      const hash = id.lastIndexOf("#");
      return hash > 4 ? `file:${id.slice(4, hash)}` : GROUPS.unclassified;
    }
    case "concept":
      return broaderOf.get(id) ?? GROUPS.concepts;
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
  options: { final: boolean; only?: Set<string> },
): Promise<number> {
  const [after, upTo] = range;
  const open = await d1
    .prepare(
      `SELECT entity_id, from_seq, content_hash FROM atlas_entities
       WHERE scope = ? AND to_seq IS NULL AND entity_id > ? ${upTo !== null && !options.final ? "AND entity_id <= ?" : ""}`,
    )
    .bind(scope, after ?? "", ...(upTo !== null && !options.final ? [upTo] : []))
    .all<{ entity_id: string; from_seq: number; content_hash: string }>();
  const existing = new Map(open.results.map((r) => [r.entity_id, r]));

  const rows: Record<string, unknown>[] = [];
  const close: string[] = [];
  let bytes = 0;
  const wanted = new Set<string>();
  for (const entity of entities) {
    wanted.add(entity.id);
    const hash = await entityHash(entity);
    const before = existing.get(entity.id);
    if (before?.content_hash === hash) continue;
    // A row this snapshot already opened (a retried step) is replaced in place.
    if (before && before.from_seq !== seq) close.push(entity.id);
    const data = JSON.stringify(entity.data);
    bytes += data.length + entity.summary.length + entity.name.length + (entity.path?.length ?? 0);
    rows.push({
      id: entity.id,
      kind: entity.kind,
      parent: entity.parentId,
      sort: sortKey(entity.name, entity.id),
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
    if (options.only ? !options.only.has(id) : id.startsWith("group:")) continue;
    close.push(id);
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

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  path: string | null;
  summary: string;
  data: string;
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

  const componentOf = new Map<string, string>();
  const broaderOf = new Map<string, string>();
  const symbols = new Map<string, number>();
  const componentFiles = new Map<string, number>();
  const mentions = new Map<string, number>();
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
    // A file in two components (it can't be, but be deterministic) takes the first.
    for (const row of containers.results.sort((a, b) => a.src.localeCompare(b.src)))
      if (!componentOf.has(row.dst)) componentOf.set(row.dst, row.src);
    for (const row of broader.results) broaderOf.set(row.src, row.dst);
    for (const row of defines.results) symbols.set(row.src, Number(row.n));
    for (const row of members.results) componentFiles.set(row.src, Number(row.n));
    for (const row of mentioned.results) mentions.set(row.dst, Number(row.n));
  }

  let partial = false;
  const entities: AtlasEntity[] = batchNodes.map((node) => {
    const data = JSON.parse(node.data) as Record<string, unknown>;
    if (node.kind === "file" && (data.pending || data.skipped)) partial ||= Boolean(data.pending);
    // Deduplicated counts: each source unit counts once, at its primary place.
    const counts: Record<string, number> = {};
    if (node.kind === "file") counts.symbols = symbols.get(node.id) ?? 0;
    if (node.kind === "component") counts.files = componentFiles.get(node.id) ?? 0;
    if (node.kind === "concept") counts.files = mentions.get(node.id) ?? 0;
    return {
      id: node.id,
      kind: node.kind,
      parentId: parentOf(node.id, node.kind, node.path, componentOf, broaderOf),
      name: node.name,
      path: node.path,
      summary: node.summary,
      data: { ...data, counts },
    };
  });

  const bytes = await writeEntities(d1, scope, seq, entities, [after, last], {
    final,
    only: undefined,
  });
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
  const edges = await d1
    .prepare(
      `SELECT src, dst, kind, weight FROM kg_edges
       WHERE repo_id = ? AND (src, dst, kind) > (?, ?, ?)
       ORDER BY src, dst, kind LIMIT ?`,
    )
    .bind(repoId, ...start, limit)
    .all<{ src: string; dst: string; kind: string; weight: number }>();
  const rows = edges.results;
  const final = rows.length < limit;
  const lastRow = rows.at(-1);
  const last: EdgeCursor = lastRow ? [lastRow.src, lastRow.dst, lastRow.kind] : null;

  const bounds = final || !last ? "" : "AND (src, dst, kind) <= (?, ?, ?)";
  const open = await d1
    .prepare(
      `SELECT src, dst, kind, from_seq, weight FROM atlas_edges
       WHERE scope = ? AND to_seq IS NULL AND (src, dst, kind) > (?, ?, ?) ${bounds}`,
    )
    .bind(scope, ...start, ...(final || !last ? [] : last))
    .all<{ src: string; dst: string; kind: string; from_seq: number; weight: number }>();
  const key = (e: { src: string; dst: string; kind: string }) =>
    `${e.src}\u0000${e.dst}\u0000${e.kind}`;
  const existing = new Map(open.results.map((e) => [key(e), e]));

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
  for (const [k, edge] of existing) if (!wanted.has(k)) close.push(edge);

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
  const bytes = insert.reduce((n, e) => n + e.src.length + e.dst.length + e.kind.length + 8, 0);
  await db(d1)
    .updateTable("atlas_snapshots")
    .set((eb) => ({ bytes: eb("bytes", "+", bytes) }))
    .where("id", "=", snapshotId)
    .execute();
  return { next: final ? null : last, written: rows.length };
}

// ---- reads -------------------------------------------------------------------

function toSnapshot(row: {
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
}): AtlasEntity {
  return {
    id: row.entity_id,
    kind: row.kind,
    parentId: row.parent_id,
    name: row.name,
    path: row.path,
    summary: row.summary,
    data: JSON.parse(row.data) as Record<string, unknown>,
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
      `SELECT entity_id, kind, parent_id, name, path, summary, data FROM atlas_entities
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
      `SELECT entity_id, kind, parent_id, name, path, summary, data, sort_key FROM atlas_entities
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
