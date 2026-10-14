import {
  canonicalSpaceJson,
  spaceDigest,
  WORK_STATE_MAX_CHARACTERS,
  type SpaceCheckpointPage,
  type SpaceMigrationContext,
  type SpaceParticipantGuard,
  type SpaceParticipantInventory,
  type SpaceReconciliation,
} from "../../shared/space-cutover.ts";

// Four-row blocks in 64 KB fragments took over 120k steps for production's 485k
// rows (CORE-341); its rows are at most tens of KB, so 64 rows in 256 KB fragments.
export const ROWS_PER_BLOCK = 64;
const FRAGMENT_CHARS = 256 * 1024;
const PAGE_BYTES = 512 * 1024;
// A block's hex-encoded rows plus their column metadata; a larger one fails closed.
const MAX_BLOCK_CHARS = 20_000_000;
const RECEIPTS = "registry_space_migrations";
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

export type SchemaEntry = { type: string; name: string; tbl_name: string; sql: string };
type Column = { name: string; pk: number };
export type Table = {
  name: string;
  columns: string[];
  keys: string[];
  rowid: boolean;
  parents: string[];
};
export interface D1CheckpointSchema {
  kind: "schema";
  storeId: string;
  schema: SchemaEntry[];
  tables: Table[];
}

/** Reserve the largest bounded row group and all retained schema/cursor copies
 * before any business transformation. The same bound covers inverse restoration.
 */
export function assertD1CheckpointProgressBudget(
  current: D1CheckpointSchema,
  target: D1CheckpointSchema,
  context: SpaceMigrationContext,
): void {
  const metadata = 5 * (canonicalSpaceJson(current).length + canonicalSpaceJson(target).length);
  const bound = MAX_BLOCK_CHARS + metadata + 4 * canonicalSpaceJson(context).length + 64 * 1024;
  if (bound > WORK_STATE_MAX_CHARACTERS)
    throw new Error(
      "space_cutover_export_required: checkpoint metadata exceeds the bounded reconstruction budget",
    );
}
export type ArchiveRows = { kind: "rows"; table: string; columns: string[]; rows: string[][] };
type Cursor = { table: number; offset: number; fragment: number };
type Fragment = {
  storeId: string;
  context: string;
  block: string;
  fragment: number;
  last: boolean;
  text: string;
};
export type SpaceCheckpointReader = (cursor: string | null) => Promise<SpaceCheckpointPage>;
export type SpaceMigrationStep<S, R> =
  | { state: S; done: false; page?: SpaceCheckpointPage }
  | { state: S; done: true; result: R; page?: SpaceCheckpointPage };
export interface D1CheckpointProjection {
  emptyTables?: readonly string[];
  nullColumns?: Readonly<Record<string, readonly string[]>>;
}
export interface SchemaDiscovery {
  phase: "entries" | "tables" | "sequence" | "done";
  afterType: string;
  afterName: string;
  tableIndex: number;
  schema: D1CheckpointSchema;
}
export interface D1InventoryState {
  binding: string;
  discovery: SchemaDiscovery;
  cursor: string | null;
  digest: string;
  counts: Record<string, number>;
  result: SpaceParticipantInventory | null;
}
interface TableRange {
  cursor: string;
  beforeDigest: string;
  afterDigest: string;
}
export interface D1CheckpointInspection {
  schema: D1CheckpointSchema;
  digest: string;
  counts: Record<string, number>;
  tableRanges: Record<string, TableRange>;
}
export interface D1InspectionState {
  binding: string;
  cursor: string | null;
  digest: string;
  schema: D1CheckpointSchema | null;
  counts: Record<string, number>;
  tableRanges: Record<string, TableRange>;
  result: D1CheckpointInspection | null;
}
type ForeignKey = { table: string; from: string[]; to: string[] };
type SavedRow = { table: string; columns: string[]; values: string[] };
interface RowGroup {
  rows: SavedRow[];
  index: number;
  relation: number;
  scan: { cursor: string; digest: string } | null;
  traversed?: number;
  traversalLimit?: number;
}
interface CycleDeletion {
  names: string[];
  leaf: number;
  changed: boolean;
  group: RowGroup | null;
}
const MAX_GROUP_ROWS = 32;

export interface D1RestoreState {
  binding: string;
  phase:
    | "validate"
    | "schema"
    | "current-relations"
    | "target-relations"
    | "drop-triggers"
    | "delete"
    | "drop-objects"
    | "drop-tables"
    | "create-tables"
    | "create-indexes"
    | "create-objects"
    | "insert"
    | "check-foreign-keys"
    | "verify"
    | "done";
  inspection: D1InspectionState | null;
  discovery: SchemaDiscovery;
  ordered: Table[];
  index: number;
  cursor: string | null;
  digest: string;
  relations: Record<string, ForeignKey[]>;
  group: RowGroup | null;
  /** Leading rows of the current cyclic block already known to be restored. */
  presentInBlock?: number;
  deletion: CycleDeletion | null;
  verification: D1InventoryState | null;
  result: SpaceReconciliation | null;
}
interface RegistryValidationState {
  phase: "target" | "feeds" | "sources" | "relations" | "done";
  afterFeed: string;
  sourceOffset: number;
}
export interface RegistryMigrationState {
  binding: string;
  phase: "validate" | "update" | "receipt" | "done";
  validation: RegistryValidationState;
  afterFeed: string;
}
export interface RegistryReconcileState {
  binding: string;
  mappingIndex: number;
  validation: RegistryValidationState;
  inventory: D1InventoryState | null;
  result: SpaceReconciliation | null;
}
export interface D1SpaceCheckpoint {
  inventoryStep(
    context: SpaceMigrationContext,
    state: D1InventoryState | null,
    projection?: D1CheckpointProjection,
  ): Promise<SpaceMigrationStep<D1InventoryState, SpaceParticipantInventory>>;
  restoreStep(
    context: SpaceMigrationContext,
    readPage: SpaceCheckpointReader,
    state: D1RestoreState | null,
    expectedDigest?: string,
  ): Promise<SpaceMigrationStep<D1RestoreState, SpaceReconciliation>>;
}
export interface RegistrySpaceMigration extends D1SpaceCheckpoint {
  migrateStep(
    context: SpaceMigrationContext,
    state: RegistryMigrationState | null,
    baseline: SpaceParticipantInventory,
  ): Promise<SpaceMigrationStep<RegistryMigrationState, null>>;
  reconcileStep(
    context: SpaceMigrationContext,
    contexts: readonly SpaceMigrationContext[],
    state: RegistryReconcileState | null,
    baseline: SpaceParticipantInventory,
  ): Promise<SpaceMigrationStep<RegistryReconcileState, SpaceReconciliation>>;
}
const REGISTRY_PRESERVATION: D1CheckpointProjection = {
  emptyTables: [RECEIPTS],
  nullColumns: { repositories: ["space_id"] },
};

function fail(): never {
  // Never include checkpoint contents, SQL values, ciphertext or credentials.
  const error = new Error("space_registry_checkpoint_invalid");
  // Only code locations: which check refused, for the operator's log.
  console.error("Space checkpoint check failed", (error.stack ?? "").slice(0, 1500));
  throw error;
}
function parseArchiveJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return fail();
  }
}
function contextKey(context: SpaceMigrationContext): string {
  return canonicalSpaceJson({
    runId: context.runId,
    migrationEpoch: context.migrationEpoch,
    manifestDigest: context.manifestDigest,
    contractVersion: context.contractVersion,
  });
}
export function discoveryFor(storeId: string): SchemaDiscovery {
  return {
    phase: "entries",
    afterType: "",
    afterName: "",
    tableIndex: 0,
    schema: { kind: "schema", storeId, schema: [], tables: [] },
  };
}

/** At most 32 schema entries or one table's two PRAGMAs per invocation. */
export async function discoverSchemaStep(
  db: D1Database,
  previous: SchemaDiscovery,
): Promise<SchemaDiscovery> {
  const state = { ...previous, schema: { ...previous.schema } };
  if (state.phase === "entries") {
    const entries = (
      await db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND tbl_name <> '_space_cutover_fence' AND name NOT GLOB '_space_cutover_write_*' AND (type,name)>(?,?) ORDER BY type,name LIMIT 32",
        )
        .bind(state.afterType, state.afterName)
        .all<SchemaEntry>()
    ).results;
    state.schema.schema = [...state.schema.schema, ...entries];
    const last = entries.at(-1);
    if (last) {
      state.afterType = last.type;
      state.afterName = last.name;
    }
    if (entries.length < 32) state.phase = "tables";
  } else if (state.phase === "tables") {
    const entry = state.schema.schema.filter((entry) => entry.type === "table")[state.tableIndex];
    if (!entry) {
      state.phase = "sequence";
      return state;
    }
    const columns = (await db.prepare(`PRAGMA table_info(${identifier(entry.name)})`).all<Column>())
      .results;
    const rowid = !/\bWITHOUT\s+ROWID\b/i.test(entry.sql);
    // SQLite shadows each rowid alias independently. Git object tables have a
    // real `oid` column, which does not shadow `_rowid_` or `rowid`.
    const rowidAlias = rowid
      ? ["_rowid_", "rowid", "oid"].find(
          (alias) => !columns.some((column) => column.name.toLowerCase() === alias),
        )
      : undefined;
    if (rowid && !rowidAlias) fail();
    const keys =
      rowid && rowidAlias
        ? [rowidAlias]
        : columns
            .filter((column) => column.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((column) => column.name);
    if (!keys.length) fail();
    const parents = (
      await db
        .prepare(`PRAGMA foreign_key_list(${identifier(entry.name)})`)
        .all<{ table: string }>()
    ).results.map((fk) => fk.table);
    state.schema.tables = [
      ...state.schema.tables,
      {
        name: entry.name,
        columns: columns.map((column) => column.name),
        keys,
        rowid,
        parents: [...new Set(parents)],
      },
    ];
    state.tableIndex++;
  } else if (state.phase === "sequence") {
    if (
      await db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE name='sqlite_sequence'")
        .first()
    ) {
      state.schema.tables = [
        ...state.schema.tables,
        {
          name: "sqlite_sequence",
          columns: ["name", "seq"],
          keys: ["_rowid_"],
          rowid: true,
          parents: [],
        },
      ];
    }
    state.phase = "done";
  }
  return state;
}
function cursorFrom(value: string | null): Cursor {
  if (value === null) return { table: -1, offset: 0, fragment: 0 };
  const cursor = parseArchiveJson(value) as Cursor;
  if (
    !cursor ||
    ![cursor.table, cursor.offset, cursor.fragment].every(Number.isSafeInteger) ||
    cursor.table < -1 ||
    cursor.offset < 0 ||
    cursor.fragment < 0
  )
    fail();
  return cursor;
}
function nextPosition(
  position: Cursor,
  last: boolean,
  count: number,
  tableCount: number,
): string | null {
  const next = !last
    ? { ...position, fragment: position.fragment + 1 }
    : position.table >= 0 && count === ROWS_PER_BLOCK
      ? { table: position.table, offset: position.offset + count, fragment: 0 }
      : { table: position.table + 1, offset: 0, fragment: 0 };
  return next.table >= tableCount ? null : canonicalSpaceJson(next);
}

/** Full recoverable values, including rowids, counters, BLOBs and exact TEXT bytes. */
async function buildPage(
  db: D1Database,
  context: SpaceMigrationContext,
  cursor: string | null,
  normalized: D1CheckpointProjection,
  schema: D1CheckpointSchema,
) {
  const position = cursorFrom(cursor);
  if (position.table >= schema.tables.length) fail();
  let block: D1CheckpointSchema | ArchiveRows;
  if (position.table === -1) {
    if (position.offset !== 0) fail();
    block = schema;
  } else {
    const table = schema.tables[position.table]!;
    const columns = [...(table.rowid ? table.keys : []), ...table.columns];
    const projection = columns
      .map((column, index) => {
        const quoted = identifier(column);
        // quote(TEXT) alone truncates embedded NUL; hex preserves every byte.
        const value = normalized.nullColumns?.[table.name]?.includes(column)
          ? "'NULL'"
          : `CASE WHEN typeof(${quoted})='text' THEN 'CAST(X''' || hex(${quoted}) || ''' AS TEXT)' ELSE quote(${quoted}) END`;
        return `${value} AS ${identifier(`v${index}`)}`;
      })
      .join(",");
    const rows = normalized.emptyTables?.includes(table.name)
      ? []
      : (
          await db
            .prepare(
              `SELECT ${projection} FROM ${identifier(table.name)} ORDER BY ${table.keys.map(identifier).join(",")} LIMIT ? OFFSET ?`,
            )
            .bind(ROWS_PER_BLOCK, position.offset)
            .all<Record<string, string>>()
        ).results;
    block = {
      kind: "rows",
      table: table.name,
      columns,
      rows: rows.map((row) => columns.map((_, index) => row[`v${index}`]!)),
    };
  }
  return encodeD1CheckpointPage(context, cursor, block, schema);
}

/** Encode one bounded archive fragment without converting SQLite literal cells. */
export async function encodeD1CheckpointPage(
  context: SpaceMigrationContext,
  cursor: string | null,
  block: D1CheckpointSchema | ArchiveRows,
  schema: D1CheckpointSchema,
) {
  const position = cursorFrom(cursor);
  const count = block.kind === "rows" ? block.rows.length : 0;
  if (count > ROWS_PER_BLOCK) fail();
  const text = canonicalSpaceJson(block);
  if (text.length > MAX_BLOCK_CHARS) fail();
  const start = position.fragment * FRAGMENT_CHARS;
  if (start >= text.length) fail();
  const last = start + FRAGMENT_CHARS >= text.length;
  const fragment: Fragment = {
    storeId: schema.storeId,
    context: contextKey(context),
    block: `${position.table}:${position.offset}`,
    fragment: position.fragment,
    last,
    text: text.slice(start, start + FRAGMENT_CHARS),
  };
  const payload = canonicalSpaceJson(fragment);
  if (new TextEncoder().encode(payload).byteLength > PAGE_BYTES) fail();
  const page: SpaceCheckpointPage = {
    cursor,
    nextCursor: nextPosition(position, last, count, schema.tables.length),
    payload,
    digest: await spaceDigest(payload),
  };
  return { page, table: block.kind === "rows" ? block.table : null, count: last ? count : 0 };
}

function validSqlValue(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === "NULL" || /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return true;
  const hex =
    value.startsWith("CAST(X'") && value.endsWith("' AS TEXT)")
      ? value.slice(7, -10)
      : value.startsWith("X'") && value.endsWith("'")
        ? value.slice(2, -1)
        : null;
  return hex !== null && hex.length % 2 === 0 && /^[0-9A-F]*$/.test(hex);
}

/** Reads at most one bounded block, never scans an entire archive. */
export async function readBlock(
  context: SpaceMigrationContext,
  storeId: string,
  readPage: SpaceCheckpointReader,
  start: string | null,
  initialDigest: string,
  schema: D1CheckpointSchema | null,
) {
  let cursor = start;
  let digest = initialDigest;
  let text = "";
  if (cursorFrom(start).fragment !== 0) fail();
  for (let fragments = 0; fragments <= Math.ceil(MAX_BLOCK_CHARS / FRAGMENT_CHARS); fragments++) {
    const page = await readPage(cursor);
    if (
      !page ||
      page.cursor !== cursor ||
      new TextEncoder().encode(page.payload).byteLength > PAGE_BYTES ||
      (await spaceDigest(page.payload)) !== page.digest
    )
      fail();
    const position = cursorFrom(cursor);
    const fragment = parseArchiveJson(page.payload) as Fragment;
    if (
      !fragment ||
      fragment.storeId !== storeId ||
      fragment.context !== contextKey(context) ||
      fragment.fragment !== position.fragment ||
      fragment.block !== `${position.table}:${position.offset}` ||
      typeof fragment.text !== "string" ||
      !fragment.text.length ||
      fragment.text.length > FRAGMENT_CHARS ||
      typeof fragment.last !== "boolean" ||
      (!fragment.last && fragment.text.length !== FRAGMENT_CHARS)
    )
      fail();
    text += fragment.text;
    if (text.length > MAX_BLOCK_CHARS) fail();
    digest = await spaceDigest(`${digest}:${page.digest}`);
    if (!fragment.last) {
      const expected = canonicalSpaceJson({ ...position, fragment: position.fragment + 1 });
      if (page.nextCursor !== expected) fail();
      cursor = expected;
      continue;
    }
    const block = parseArchiveJson(text) as D1CheckpointSchema | ArchiveRows;
    let count = 0;
    if (!block) fail();
    if (position.table === -1) {
      if (
        schema ||
        position.offset !== 0 ||
        block.kind !== "schema" ||
        block.storeId !== storeId ||
        !Array.isArray(block.schema) ||
        !Array.isArray(block.tables)
      )
        fail();
      schema = block;
    } else {
      if (!schema || block.kind !== "rows") fail();
      const table = schema.tables[position.table];
      if (
        !table ||
        block.table !== table.name ||
        canonicalSpaceJson(block.columns) !==
          canonicalSpaceJson([...(table.rowid ? table.keys : []), ...table.columns]) ||
        !Array.isArray(block.rows) ||
        block.rows.length > ROWS_PER_BLOCK
      )
        fail();
      for (const row of block.rows)
        if (!Array.isArray(row) || row.length !== block.columns.length || !row.every(validSqlValue))
          fail();
      count = block.rows.length;
    }
    const next = nextPosition(position, true, count, schema.tables.length);
    if (page.nextCursor !== next) fail();
    return { block, schema, digest, nextCursor: next };
  }
  return fail();
}

export async function inspectD1SpaceCheckpointStep(
  context: SpaceMigrationContext,
  storeId: string,
  readPage: SpaceCheckpointReader,
  previous: D1InspectionState | null,
): Promise<SpaceMigrationStep<D1InspectionState, D1CheckpointInspection>> {
  const binding = canonicalSpaceJson({ context: contextKey(context), storeId });
  if (previous && previous.binding !== binding) fail();
  const state: D1InspectionState = previous
    ? { ...previous, counts: { ...previous.counts }, tableRanges: { ...previous.tableRanges } }
    : {
        binding,
        cursor: null,
        digest: "",
        schema: null,
        counts: {},
        tableRanges: {},
        result: null,
      };
  if (state.result) return { state, done: true, result: state.result };
  const next = await readBlock(
    context,
    storeId,
    readPage,
    state.cursor,
    state.digest,
    state.schema,
  );
  if (next.block.kind === "rows") {
    const table = next.block.table;
    if (state.cursor === null) fail();
    state.tableRanges[table] = {
      cursor: state.tableRanges[table]?.cursor ?? state.cursor,
      beforeDigest: state.tableRanges[table]?.beforeDigest ?? state.digest,
      afterDigest: next.digest,
    };
    state.counts[table] = (state.counts[table] ?? 0) + next.block.rows.length;
  }
  state.schema = next.schema;
  state.cursor = next.nextCursor;
  state.digest = next.digest;
  if (state.cursor !== null) return { state, done: false };
  if (Object.keys(state.tableRanges).length !== state.schema.tables.length) fail();
  state.result = {
    schema: state.schema,
    digest: state.digest,
    counts: state.counts,
    tableRanges: state.tableRanges,
  };
  // The completed result owns the immutable schema/counts/ranges. Keeping the
  // accumulator copies would serialize the same archive metadata twice.
  state.schema = null;
  state.counts = {};
  state.tableRanges = {};
  return { state, done: true, result: state.result };
}

/** No secret bytes are ever interpolated into SQL: D1 limits SQL text to 100KB. */
function restoreStatement(
  db: D1Database,
  table: Table,
  columns: string[],
  row: string[],
  replaySafe = false,
): D1PreparedStatement {
  const parameters: (string | ArrayBuffer | null)[] = [];
  const values = row.map((value, index) => {
    if (!validSqlValue(value)) return fail();
    if (table.rowid && index === 0) {
      if (!/^-?\d{1,19}$/.test(value)) return fail();
      // Keep the implicit rowid out of the binding budget: a D1 table can have
      // 100 real columns, exactly the platform's 100-parameter limit.
      return value;
    }
    return bindCell(value, parameters);
  });
  // Parents are loaded before children; a replay cannot cascade into a later
  // table because progress is journaled before the next table is started.
  return db
    .prepare(
      `INSERT ${replaySafe ? "" : "OR REPLACE "}INTO ${identifier(table.name)} (${columns.map(identifier).join(",")}) VALUES (${values.join(",")})${replaySafe ? " ON CONFLICT DO NOTHING" : ""}`,
    )
    .bind(...parameters);
}

function bindCell(value: string, parameters: (string | ArrayBuffer | null)[]): string {
  if (!validSqlValue(value)) fail();
  if (value === "NULL") {
    parameters.push(null);
    return "?";
  }
  const text = value.startsWith("CAST(X'");
  if (text || value.startsWith("X'")) {
    const hex = text ? value.slice(7, -10) : value.slice(2, -1);
    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++)
      bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    parameters.push(bytes.buffer);
    return text ? "CAST(? AS TEXT)" : "?";
  }
  parameters.push(value);
  return /^-?\d+$/.test(value) ? "CAST(? AS INTEGER)" : "CAST(? AS REAL)";
}

function rowPredicate(
  columns: string[],
  values: string[],
  parameters: (string | ArrayBuffer | null)[],
) {
  return columns
    .map((column, index) => `${identifier(column)}=${bindCell(values[index]!, parameters)}`)
    .join(" AND ");
}

function rowValues(row: SavedRow, columns: string[]): string[] {
  return columns.map((column) => {
    const index = row.columns.indexOf(column);
    if (index < 0) fail();
    return row.values[index]!;
  });
}

function addGroupRow(group: RowGroup, row: SavedRow, tables: Table[]): boolean {
  const table = tables.find((table) => table.name === row.table);
  if (!table) fail();
  const key = canonicalSpaceJson(rowValues(row, table.keys));
  if (
    group.rows.some(
      (other) =>
        other.table === row.table && canonicalSpaceJson(rowValues(other, table.keys)) === key,
    )
  )
    return false;
  if (
    group.rows.length >= MAX_GROUP_ROWS ||
    canonicalSpaceJson(group.rows).length + canonicalSpaceJson(row).length > MAX_BLOCK_CHARS
  ) {
    // A long dependency path is not necessarily an indivisible cycle. Work
    // from its deeper dependency first, then revisit the original archive row.
    // More traversed vertices than the immutable row count proves repetition.
    group.traversed = (group.traversed ?? 0) + group.rows.length;
    if (
      group.traversalLimit === undefined ||
      group.traversed > group.traversalLimit ||
      canonicalSpaceJson(row).length > MAX_BLOCK_CHARS
    )
      throw new Error("space_checkpoint_indivisible_foreign_key_group_too_large");
    group.rows = [row];
    group.index = 0;
    group.relation = 0;
    group.scan = null;
    return true;
  }
  group.rows.push(row);
  return false;
}

async function foreignKeys(db: D1Database, name: string): Promise<ForeignKey[]> {
  const rows = (
    await db
      .prepare(
        `SELECT f.id,f.seq,f."table" AS parent,f."from" AS child,COALESCE(f."to",p.name) AS parent_column FROM pragma_foreign_key_list(?) f LEFT JOIN pragma_table_info(f."table") p ON f."to" IS NULL AND p.pk=f.seq+1 ORDER BY f.id,f.seq`,
      )
      .bind(name)
      .all<{
        id: number;
        seq: number;
        parent: string;
        child: string;
        parent_column: string | null;
      }>()
  ).results;
  const groups = new Map<number, ForeignKey>();
  for (const row of rows) {
    if (row.parent_column === null) fail();
    const group = groups.get(row.id) ?? { table: row.parent, from: [], to: [] };
    group.from.push(row.child);
    group.to.push(row.parent_column);
    groups.set(row.id, group);
  }
  return [...groups.values()];
}

/** Strongly connected table components, parents first. Empty cycles can be
 * dropped atomically; populated cycles are handled by bounded row closures. */
export function d1CheckpointDependencyGroups(tables: Table[]): Table[][] {
  const byName = new Map(tables.map((table) => [table.name, table]));
  const reachable = (name: string, found = new Set<string>()): Set<string> => {
    if (found.has(name)) return found;
    found.add(name);
    for (const parent of byName.get(name)?.parents ?? []) {
      if (!byName.has(parent)) fail();
      reachable(parent, found);
    }
    return found;
  };
  const reach = new Map(tables.map((table) => [table.name, reachable(table.name)]));
  const pending = [...tables];
  const groups: Table[][] = [];
  while (pending.length) {
    const root = pending.find((table) =>
      table.parents.every(
        (parent) =>
          !pending.some((candidate) => candidate.name === parent) ||
          reach.get(parent)!.has(table.name),
      ),
    );
    if (!root) fail();
    const group = pending.filter(
      (table) => reach.get(root.name)!.has(table.name) && reach.get(table.name)!.has(root.name),
    );
    groups.push(group);
    for (const table of group) pending.splice(pending.indexOf(table), 1);
  }
  return groups;
}

function cyclicTables(table: Table, tables: Table[]): Table[] {
  const group = d1CheckpointDependencyGroups(tables).find((group) =>
    group.some((candidate) => candidate.name === table.name),
  )!;
  return group.length > 1 || table.parents.includes(table.name) ? group : [];
}

/** Only use with migrationDatabase: CREATE and all guards must share its batch. */
export function createFencedD1TableStatements(
  db: D1Database,
  name: string,
  sql: string,
): D1PreparedStatement[] {
  if (name === "_space_cutover_fence" || /^(?:sqlite_|_cf_)/.test(name)) fail();
  return [
    db.prepare(sql),
    ...["INSERT", "UPDATE", "DELETE"].map((operation) =>
      db.prepare(
        `CREATE TRIGGER ${identifier(`_space_cutover_write_${name}_${operation.toLowerCase()}`)} BEFORE ${operation} ON ${identifier(name)} WHEN COALESCE((SELECT fenced=0 OR bypass=1 FROM _space_cutover_fence WHERE id=1),0)=0 BEGIN SELECT RAISE(ABORT,'space_cutover_fenced'); END`,
      ),
    ),
  ];
}

function dependencyOrder(tables: Table[]): Table[] {
  return [
    ...d1CheckpointDependencyGroups(
      tables.filter((table) => table.name !== "sqlite_sequence"),
    ).flat(),
    ...tables.filter((table) => table.name === "sqlite_sequence"),
  ];
}

async function selectSavedRows(
  db: D1Database,
  table: Table,
  where: string,
  parameters: (string | ArrayBuffer | null)[],
  limit: number,
): Promise<SavedRow[]> {
  const columns = [...(table.rowid ? table.keys : []), ...table.columns];
  const projection = columns
    .map((column, index) => {
      const quoted = `r.${identifier(column)}`;
      return `CASE WHEN typeof(${quoted})='text' THEN 'CAST(X''' || hex(${quoted}) || ''' AS TEXT)' ELSE quote(${quoted}) END AS ${identifier(`v${index}`)}`;
    })
    .join(",");
  const rows = (
    await db
      .prepare(
        `SELECT ${projection} FROM ${identifier(table.name)} r WHERE ${where} LIMIT ${limit}`,
      )
      .bind(...parameters)
      .all<Record<string, string>>()
  ).results;
  return rows.map((row) => ({
    table: table.name,
    columns,
    values: columns.map((_, index) => row[`v${index}`]!),
  }));
}

async function savedRowMatches(
  db: D1Database,
  row: SavedRow,
  columns: string[],
  values: string[],
): Promise<boolean> {
  const parameters: (string | ArrayBuffer | null)[] = [];
  const candidate = rowValues(row, columns).map((value) => bindCell(value, parameters));
  // Inherit the real referenced columns' collation and affinity rather than
  // comparing JavaScript strings or lossy JavaScript integers.
  const where = rowPredicate(columns, values, parameters);
  return !!(await db
    .prepare(
      `WITH candidate AS (SELECT ${columns.map(identifier).join(",")} FROM ${identifier(row.table)} WHERE 0 UNION ALL SELECT ${candidate.join(",")}) SELECT 1 AS present FROM candidate WHERE ${where}`,
    )
    .bind(...parameters)
    .first());
}

/** One dependency edge or one archive block per invocation. */
async function expandInsertGroup(
  db: D1Database,
  context: SpaceMigrationContext,
  storeId: string,
  readPage: SpaceCheckpointReader,
  archive: D1CheckpointInspection,
  relations: Record<string, ForeignKey[]>,
  group: RowGroup,
): Promise<boolean> {
  const row = group.rows[group.index];
  if (!row) return true;
  const relation = (relations[row.table] ?? [])[group.relation];
  if (!relation) {
    group.index++;
    group.relation = 0;
    return false;
  }
  const values = rowValues(row, relation.from);
  if (values.includes("NULL")) {
    group.relation++;
    return false;
  }
  if (!group.scan) {
    const parameters: (string | ArrayBuffer | null)[] = [];
    const where = rowPredicate(relation.to, values, parameters);
    if (
      await db
        .prepare(`SELECT 1 AS present FROM ${identifier(relation.table)} WHERE ${where}`)
        .bind(...parameters)
        .first()
    ) {
      group.relation++;
      return false;
    }
    for (const candidate of group.rows) {
      if (
        candidate.table === relation.table &&
        (await savedRowMatches(db, candidate, relation.to, values))
      ) {
        group.relation++;
        return false;
      }
    }
    const range = archive.tableRanges[relation.table];
    if (!range) fail();
    group.scan = { cursor: range.cursor, digest: range.beforeDigest };
  }
  const block = await readBlock(
    context,
    storeId,
    readPage,
    group.scan.cursor,
    group.scan.digest,
    archive.schema,
  );
  if (block.block.kind !== "rows" || block.block.table !== relation.table) fail();
  const wanted = rowValues(row, relation.from);
  for (const values of block.block.rows) {
    const candidate = { table: relation.table, columns: block.block.columns, values };
    // Archive cells are canonical literals: only an identical key literal can be
    // the referenced row, so SQL (affinity, collation) confirms just those. One
    // query per candidate made production's install crawl (CORE-341); a key that
    // matched only by affinity would end the scan unmatched and fail closed.
    if (rowValues(candidate, relation.to).some((value, index) => value !== wanted[index])) continue;
    if (await savedRowMatches(db, candidate, relation.to, wanted)) {
      if (addGroupRow(group, candidate, archive.schema.tables)) return false;
      group.scan = null;
      group.relation++;
      return false;
    }
  }
  if (
    block.nextCursor === null ||
    archive.schema.tables[cursorFrom(block.nextCursor).table]?.name !== relation.table
  )
    fail();
  group.scan = { cursor: block.nextCursor, digest: block.digest };
  return false;
}

/** Prune leaves before collecting an indivisible cycle, so an Organization's
 * many non-default Spaces do not enlarge its required default-Space pair. */
async function deleteCycleStep(
  db: D1Database,
  tables: Table[],
  relations: Record<string, ForeignKey[]>,
  state: CycleDeletion,
): Promise<boolean> {
  if (!state.group) {
    const name = state.names[state.leaf];
    if (name) {
      const table = tables.find((table) => table.name === name)!;
      const incoming = state.names.flatMap((child) =>
        (relations[child] ?? []).filter((fk) => fk.table === name).map((fk) => ({ child, fk })),
      );
      const where =
        incoming
          .map(
            ({ child, fk }) =>
              `NOT EXISTS (SELECT 1 FROM ${identifier(child)} c WHERE ${fk.to
                .map((column, index) => `r.${identifier(column)}=c.${identifier(fk.from[index]!)}`)
                .join(" AND ")})`,
          )
          .join(" AND ") || "1";
      const keys = table.keys.map(identifier).join(",");
      const result = await db
        .prepare(
          `DELETE FROM ${identifier(name)} WHERE (${keys}) IN (SELECT ${keys} FROM ${identifier(name)} r WHERE ${where} LIMIT 128)`,
        )
        .run();
      state.changed ||= result.meta.changes > 0;
      state.leaf++;
      return false;
    }
    if (state.changed) {
      state.leaf = 0;
      state.changed = false;
      return false;
    }
    for (const name of state.names) {
      const rows = await selectSavedRows(
        db,
        tables.find((table) => table.name === name)!,
        "1",
        [],
        1,
      );
      if (rows.length) {
        const count = await db
          .prepare(
            `SELECT ${state.names.map((name) => `(SELECT count(*) FROM ${identifier(name)})`).join("+")} AS n`,
          )
          .first<{ n: number }>();
        if (!count) fail();
        state.group = { rows, index: 0, relation: 0, scan: null, traversalLimit: count.n };
        return false;
      }
    }
    return true;
  }
  const group = state.group;
  const row = group.rows[group.index];
  if (!row) {
    const statements = [db.prepare("PRAGMA defer_foreign_keys=ON")];
    for (const row of group.rows) {
      const table = tables.find((table) => table.name === row.table)!;
      const parameters: (string | ArrayBuffer | null)[] = [];
      const where = rowPredicate(table.keys, rowValues(row, table.keys), parameters);
      statements.push(
        db.prepare(`DELETE FROM ${identifier(row.table)} WHERE ${where}`).bind(...parameters),
      );
    }
    await db.batch(statements);
    state.group = null;
    state.leaf = 0;
    return false;
  }
  const incoming = state.names.flatMap((child) =>
    (relations[child] ?? []).filter((fk) => fk.table === row.table).map((fk) => ({ child, fk })),
  );
  const edge = incoming[group.relation];
  if (!edge) {
    group.index++;
    group.relation = 0;
    return false;
  }
  const parent = tables.find((table) => table.name === row.table)!;
  const child = tables.find((table) => table.name === edge.child)!;
  const parameters: (string | ArrayBuffer | null)[] = [];
  const rootValues = rowValues(row, parent.keys);
  const root = parent.keys
    .map((key, index) => `p.${identifier(key)}=${bindCell(rootValues[index]!, parameters)}`)
    .join(" AND ");
  const join = edge.fk.to
    .map((column, index) => `p.${identifier(column)}=r.${identifier(edge.fk.from[index]!)}`)
    .join(" AND ");
  const rows = await selectSavedRows(
    db,
    child,
    `EXISTS (SELECT 1 FROM ${identifier(parent.name)} p WHERE ${root} AND ${join})`,
    parameters,
    MAX_GROUP_ROWS + 1,
  );
  for (const candidate of rows) if (addGroupRow(group, candidate, tables)) return false;
  group.relation++;
  return false;
}

/** Every method performs one resumable unit; only the independent journal drives loops. */
export function createD1SpaceCheckpoint(
  db: D1Database,
  storeId: string,
  guard: SpaceParticipantGuard,
  options: { purpose?: "restore" | "migrate" } = {},
): D1SpaceCheckpoint {
  async function inventoryStep(
    context: SpaceMigrationContext,
    previous: D1InventoryState | null,
    projection: D1CheckpointProjection = {},
  ): Promise<SpaceMigrationStep<D1InventoryState, SpaceParticipantInventory>> {
    await guard(context, "inventory");
    const binding = canonicalSpaceJson({ context: contextKey(context), storeId, projection });
    if (previous && previous.binding !== binding) fail();
    const state: D1InventoryState = previous
      ? { ...previous, counts: { ...previous.counts } }
      : {
          binding,
          discovery: discoveryFor(storeId),
          cursor: null,
          digest: "",
          counts: {},
          result: null,
        };
    if (state.result) return { state, done: true, result: state.result };
    if (state.discovery.phase !== "done") {
      state.discovery = await discoverSchemaStep(db, state.discovery);
      return { state, done: false };
    }
    const exported = await buildPage(db, context, state.cursor, projection, state.discovery.schema);
    state.digest = await spaceDigest(`${state.digest}:${exported.page.digest}`);
    if (exported.table !== null)
      state.counts[exported.table] = (state.counts[exported.table] ?? 0) + exported.count;
    state.cursor = exported.page.nextCursor;
    if (state.cursor !== null) return { state, done: false, page: exported.page };
    state.result = { storeId, digest: state.digest, counts: state.counts };
    return { state, done: true, result: state.result, page: exported.page };
  }

  async function restoreStep(
    context: SpaceMigrationContext,
    readPage: SpaceCheckpointReader,
    previous: D1RestoreState | null,
    expectedDigest?: string,
  ): Promise<SpaceMigrationStep<D1RestoreState, SpaceReconciliation>> {
    const purpose = options.purpose ?? "restore";
    await guard(context, purpose);
    const binding = canonicalSpaceJson({
      context: contextKey(context),
      storeId,
      purpose,
      expectedDigest: expectedDigest ?? null,
    });
    if (previous && previous.binding !== binding) fail();
    const state: D1RestoreState = previous
      ? {
          ...previous,
          relations: { ...previous.relations },
          group: previous.group ? { ...previous.group, rows: [...previous.group.rows] } : null,
          deletion: previous.deletion
            ? {
                ...previous.deletion,
                group: previous.deletion.group
                  ? {
                      ...previous.deletion.group,
                      rows: [...previous.deletion.group.rows],
                    }
                  : null,
              }
            : null,
        }
      : {
          binding,
          phase: "validate",
          inspection: null,
          discovery: discoveryFor(storeId),
          ordered: [],
          index: 0,
          cursor: null,
          digest: "",
          relations: {},
          group: null,
          deletion: null,
          verification: null,
          result: null,
        };
    if (state.result) return { state, done: true, result: state.result };
    const guardedRead: SpaceCheckpointReader = async (cursor) => {
      await guard(context, purpose);
      return readPage(cursor);
    };
    if (state.phase === "validate") {
      const step = await inspectD1SpaceCheckpointStep(
        context,
        storeId,
        guardedRead,
        state.inspection,
      );
      state.inspection = step.state;
      if (step.done) {
        if (expectedDigest !== undefined && step.result.digest !== expectedDigest)
          throw new Error("space_checkpoint_expected_digest_mismatch");
        state.phase = "schema";
      }
      return { state, done: false };
    }
    const archive = state.inspection?.result;
    if (!archive) fail();
    if (state.phase === "schema") {
      state.discovery = await discoverSchemaStep(db, state.discovery);
      if (state.discovery.phase !== "done") return { state, done: false };
      const current = state.discovery.schema;
      assertD1CheckpointProgressBudget(current, archive.schema, context);
      // Validate both dependency graphs before the first destructive operation.
      dependencyOrder(archive.schema.tables);
      state.ordered = dependencyOrder(current.tables);
      if (
        [current, archive.schema].some((snapshot) =>
          d1CheckpointDependencyGroups(snapshot.tables).some(
            (group) => group.length > MAX_GROUP_ROWS,
          ),
        )
      )
        throw new Error("space_checkpoint_schema_cycle_too_large");
      if (
        current.tables.some((table) => table.name === "sqlite_sequence") &&
        !archive.schema.tables.some((table) => table.name === "sqlite_sequence")
      )
        throw new Error("space_checkpoint_restore_sequence_schema_mismatch");
      state.phase = "current-relations";
      return { state, done: false };
    }
    if (state.phase === "current-relations" || state.phase === "target-relations") {
      const table = state.ordered[state.index];
      if (table) {
        state.relations[table.name] =
          table.name === "sqlite_sequence" ? [] : await foreignKeys(db, table.name);
        state.index++;
      } else {
        state.phase = state.phase === "current-relations" ? "drop-triggers" : "insert";
        state.index = 0;
      }
      return { state, done: false };
    }
    const triggers = state.discovery.schema.schema.filter((entry) => entry.type === "trigger");
    if (state.phase === "drop-triggers") {
      const trigger = triggers[state.index];
      if (trigger) {
        await db.prepare(`DROP TRIGGER IF EXISTS ${identifier(trigger.name)}`).run();
        state.index++;
      } else {
        state.phase = "delete";
        state.index = state.ordered.length - 1;
      }
    } else if (state.phase === "delete") {
      const table = state.ordered[state.index];
      if (!table) {
        state.phase = "drop-objects";
        state.index = 0;
      } else if (cyclicTables(table, state.ordered).length) {
        const group = cyclicTables(table, state.ordered);
        state.deletion ??= {
          names: group.map((table) => table.name),
          leaf: 0,
          changed: false,
          group: null,
        };
        if (await deleteCycleStep(db, state.ordered, state.relations, state.deletion)) {
          state.index -= group.length;
          state.deletion = null;
        }
      } else {
        const keys = table.keys.map(identifier).join(",");
        const result = await db
          .prepare(
            `DELETE FROM ${identifier(table.name)} WHERE (${keys}) IN (SELECT ${keys} FROM ${identifier(table.name)} LIMIT 128)`,
          )
          .run();
        if (result.meta.changes === 0) state.index--;
      }
    } else if (state.phase === "drop-objects") {
      const object = state.discovery.schema.schema.filter((entry) => entry.type === "view")[
        state.index
      ];
      if (object) {
        await db.prepare(`DROP VIEW IF EXISTS ${identifier(object.name)}`).run();
        state.index++;
      } else {
        state.phase = "drop-tables";
        state.index = state.ordered.length - 1;
        // From here, drops need only ordered table metadata. Source DDL and
        // FK edges have no remaining consumers and must not bloat the journal.
        state.discovery = { ...discoveryFor(storeId), phase: "done" };
        state.relations = {};
      }
    } else if (state.phase === "drop-tables") {
      const table = state.ordered[state.index];
      if (!table) {
        state.ordered = dependencyOrder(archive.schema.tables);
        state.phase = "create-tables";
        state.index = 0;
      } else {
        const group = cyclicTables(table, state.ordered);
        if (group.length) {
          if (group.length > MAX_GROUP_ROWS)
            throw new Error("space_checkpoint_schema_cycle_too_large");
          await db.batch([
            db.prepare("PRAGMA defer_foreign_keys=ON"),
            ...group.map((table) => db.prepare(`DROP TABLE IF EXISTS ${identifier(table.name)}`)),
          ]);
          state.index -= group.length;
        } else {
          if (table.name !== "sqlite_sequence")
            await db.prepare(`DROP TABLE IF EXISTS ${identifier(table.name)}`).run();
          state.index--;
        }
      }
    } else if (state.phase === "create-tables") {
      const table = state.ordered[state.index];
      if (!table) {
        state.phase = "create-indexes";
        state.index = 0;
      } else if (table.name === "sqlite_sequence") {
        state.index++;
      } else {
        const cycle = cyclicTables(table, state.ordered);
        const group = cycle.length ? cycle : [table];
        if (group.length > MAX_GROUP_ROWS)
          throw new Error("space_checkpoint_schema_cycle_too_large");
        const existing = await db
          .prepare(
            `SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN (${group.map(() => "?").join(",")})`,
          )
          .bind(...group.map((member) => member.name))
          .all<{ name: string; sql: string }>();
        // An authorized CREATE commits the whole component and its fences.
        // A partial component is not a valid lost-progress replay.
        if (existing.results.length !== 0 && existing.results.length !== group.length) fail();
        const statements: D1PreparedStatement[] = [];
        for (const member of group) {
          const entry = archive.schema.schema.find(
            (entry) => entry.type === "table" && entry.name === member.name,
          );
          if (!entry) fail();
          if (existing.results.length) {
            if (existing.results.find((entry) => entry.name === member.name)?.sql !== entry.sql)
              fail();
          } else {
            statements.push(...createFencedD1TableStatements(db, member.name, entry.sql));
          }
        }
        if (statements.length) await db.batch(statements);
        state.index += group.length;
      }
    } else if (state.phase === "create-indexes") {
      const entry = archive.schema.schema.filter((entry) => entry.type === "index")[state.index];
      if (!entry) {
        state.phase = "target-relations";
        state.relations = {};
        state.index = 0;
      } else {
        const existing = await db
          .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name=?")
          .bind(entry.name)
          .first<{ sql: string }>();
        if (existing && existing.sql !== entry.sql) fail();
        if (!existing) await db.prepare(entry.sql).run();
        state.index++;
      }
    } else if (state.phase === "insert") {
      const table = state.ordered[state.index];
      if (!table) {
        state.phase = "create-objects";
        state.index = 0;
      } else {
        const range = archive.tableRanges[table.name];
        if (!range) fail();
        const first = state.cursor === null;
        const current = state.cursor ?? range.cursor;
        const block = await readBlock(
          context,
          storeId,
          guardedRead,
          current,
          first ? range.beforeDigest : state.digest,
          archive.schema,
        );
        if (block.block.kind !== "rows" || block.block.table !== table.name) fail();
        if (cyclicTables(table, state.ordered).length) {
          // Expand and insert groups for up to three seconds per journaled step:
          // one action per step made production's ci_jobs take days (CORE-341).
          // Each group is its own atomic batch; an interrupted step re-checks
          // presence, so nothing is lost or inserted twice.
          const until = Date.now() + 3_000;
          let blockRestored = false;
          // And at most eight groups, keeping one invocation's queries bounded.
          for (let groups = 0; groups < 8; groups++) {
            if (!state.group) {
              // Rows before this offset were found restored; groups only add rows.
              const skip = Math.min(state.presentInBlock ?? 0, block.block.rows.length);
              for (const [offset, values] of block.block.rows.entries()) {
                if (offset < skip) continue;
                state.presentInBlock = offset;
                const row = { table: table.name, columns: block.block.columns, values };
                const parameters: (string | ArrayBuffer | null)[] = [];
                const where = rowPredicate(table.keys, rowValues(row, table.keys), parameters);
                if (
                  !(await db
                    .prepare(`SELECT 1 AS present FROM ${identifier(table.name)} WHERE ${where}`)
                    .bind(...parameters)
                    .first())
                ) {
                  state.group = {
                    rows: [],
                    index: 0,
                    relation: 0,
                    scan: null,
                    traversalLimit: Object.values(archive.counts).reduce(
                      (sum, count) => sum + count,
                      0,
                    ),
                  };
                  addGroupRow(state.group, row, archive.schema.tables);
                  break;
                }
              }
            }
            // Every remaining row of this block is restored: move on below.
            if (!state.group) {
              blockRestored = true;
              break;
            }
            let complete = false;
            while (
              !(complete = await expandInsertGroup(
                db,
                context,
                storeId,
                guardedRead,
                archive,
                state.relations,
                state.group,
              )) &&
              Date.now() < until
            );
            if (!complete) return { state, done: false };
            await db.batch([
              db.prepare("PRAGMA defer_foreign_keys=ON"),
              ...state.group.rows.map((row) =>
                restoreStatement(
                  db,
                  state.ordered.find((table) => table.name === row.table)!,
                  row.columns,
                  row.values,
                  true,
                ),
              ),
            ]);
            state.group = null;
            if (Date.now() >= until) return { state, done: false };
          }
          // Out of groups for this step: the block may still be missing rows.
          if (!blockRestored) return { state, done: false };
        }
        const statements = cyclicTables(table, state.ordered).length
          ? []
          : block.block.rows.map((row) =>
              restoreStatement(
                db,
                table,
                block.block.kind === "rows" ? block.block.columns : [],
                row,
              ),
            );
        // Ordinary AUTOINCREMENT inserts regenerate this table. Clear it in the
        // same atomic batch as its first restored block, preserving replay.
        if (first && table.name === "sqlite_sequence")
          statements.unshift(db.prepare("DELETE FROM sqlite_sequence"));
        if (statements.length) await db.batch(statements).catch(() => fail());
        const nextTable = block.nextCursor === null ? null : cursorFrom(block.nextCursor).table;
        state.presentInBlock = 0;
        if (nextTable === null || archive.schema.tables[nextTable]?.name !== table.name) {
          if (block.digest !== range.afterDigest) fail();
          state.index++;
          state.cursor = null;
          state.digest = "";
        } else {
          state.cursor = block.nextCursor;
          state.digest = block.digest;
        }
      }
    } else if (state.phase === "create-objects") {
      const object = archive.schema.schema.filter(
        (entry) => entry.type === "view" || entry.type === "trigger",
      )[state.index];
      if (!object) {
        state.phase = "check-foreign-keys";
      } else {
        if (!["index", "view", "trigger"].includes(object.type)) fail();
        const existing = await db
          .prepare("SELECT sql FROM sqlite_master WHERE type=? AND name=?")
          .bind(object.type, object.name)
          .first<{ sql: string }>();
        if (existing && existing.sql !== object.sql) fail();
        if (!existing) await db.prepare(object.sql).run();
        state.index++;
      }
    } else if (state.phase === "check-foreign-keys") {
      if (await db.prepare("SELECT 1 AS invalid FROM pragma_foreign_key_check LIMIT 1").first())
        fail();
      state.phase = "verify";
    } else if (state.phase === "verify") {
      const verification = await inventoryStep(context, state.verification);
      state.verification = verification.state;
      if (verification.done) {
        if (verification.result.digest !== archive.digest) fail();
        state.result = { ...verification.result, preserved: true };
        state.phase = "done";
        state.inspection = null;
        state.verification = null;
        state.ordered = [];
        state.relations = {};
        return { state, done: true, result: state.result };
      }
    }
    return { state, done: false };
  }
  return { inventoryStep, restoreStep };
}

type Receipt = {
  legacy_owner_id: string;
  space_id: string;
  organization_id: string;
  space_slug: string;
  run_id: string;
  migration_epoch: number;
  manifest_digest: string;
  contract_version: number;
  before_digest: string;
  after_digest: string;
};
function newValidation(): RegistryValidationState {
  return { phase: "target", afterFeed: "", sourceOffset: 0 };
}

/** Preparation only; this participant neither approves mapping nor admits ordinary writes. */
export function createRegistrySpaceMigration(
  appDb: D1Database,
  registryDb: D1Database,
  guard: SpaceParticipantGuard,
): RegistrySpaceMigration {
  const checkpoint = createD1SpaceCheckpoint(registryDb, "registry", guard);
  function matches(
    receipt: Receipt,
    context: SpaceMigrationContext,
    baseline: SpaceParticipantInventory,
  ): boolean {
    return (
      receipt.run_id === context.runId &&
      Number(receipt.migration_epoch) === context.migrationEpoch &&
      receipt.manifest_digest === context.manifestDigest &&
      receipt.contract_version === context.contractVersion &&
      receipt.legacy_owner_id === context.legacyOwnerId &&
      receipt.space_id === context.spaceId &&
      receipt.organization_id === context.organizationId &&
      receipt.space_slug === context.spaceSlug &&
      receipt.before_digest === baseline.digest &&
      receipt.after_digest === baseline.digest
    );
  }
  async function validateStep(
    context: SpaceMigrationContext,
    previous: RegistryValidationState,
  ): Promise<RegistryValidationState> {
    const state = { ...previous };
    if (state.phase === "target") {
      if (
        context.contractVersion !== 4 ||
        context.spaceId !== context.legacyOwnerId ||
        !context.organizationId ||
        !context.spaceSlug
      )
        throw new Error("space_registry_mapping_invalid");
      const target = await appDb
        .prepare("SELECT organization_id,slug FROM spaces WHERE id=?")
        .bind(context.spaceId)
        .first<{ organization_id: string; slug: string }>();
      if (
        !target ||
        target.organization_id !== context.organizationId ||
        target.slug !== context.spaceSlug
      )
        throw new Error("space_registry_mapping_invalid");
      if (
        await registryDb
          .prepare("SELECT 1 AS found FROM repositories WHERE space_id=? AND owner_id<>? LIMIT 1")
          .bind(context.spaceId, context.legacyOwnerId)
          .first()
      )
        throw new Error("space_registry_mapping_collision");
      state.phase = "feeds";
    } else if (state.phase === "feeds") {
      const feeds = (
        await registryDb
          .prepare(
            "SELECT id,key,space_id FROM repositories WHERE owner_id=? AND id>? ORDER BY id LIMIT 64",
          )
          .bind(context.legacyOwnerId, state.afterFeed)
          .all<{ id: string; key: string; space_id: string | null }>()
      ).results;
      for (const feed of feeds)
        if (
          (feed.space_id !== null && feed.space_id !== context.spaceId) ||
          !(feed.key === context.spaceSlug || feed.key.startsWith(`${context.spaceSlug}.`))
        )
          throw new Error("space_registry_mapping_invalid");
      if (feeds.length < 64) state.phase = "sources";
      if (feeds.length) state.afterFeed = feeds[feeds.length - 1]!.id;
    } else if (state.phase === "sources") {
      const sources = (
        await registryDb
          .prepare(`SELECT DISTINCT source.git_repo_id FROM (
        SELECT s.git_repo_id,r.owner_id FROM package_sources s JOIN packages p ON p.id=s.package_id JOIN repositories r ON r.id=p.repo_id
        UNION SELECT p.git_repo_id,r.owner_id FROM publishes p JOIN repositories r ON r.id=p.feed_id WHERE p.git_repo_id IS NOT NULL
      ) source WHERE source.owner_id=? ORDER BY source.git_repo_id LIMIT 64 OFFSET ?`)
          .bind(context.legacyOwnerId, state.sourceOffset)
          .all<{ git_repo_id: string }>()
      ).results;
      for (const source of sources) {
        const repo = await appDb
          .prepare("SELECT owner_id,space_id FROM repos WHERE id=?")
          .bind(source.git_repo_id)
          .first<{ owner_id: string; space_id: string | null }>();
        if (
          !repo ||
          repo.owner_id !== context.legacyOwnerId ||
          (repo.space_id !== null && repo.space_id !== context.spaceId)
        )
          throw new Error("space_registry_cross_space_source");
      }
      state.sourceOffset += sources.length;
      if (sources.length < 64) state.phase = "relations";
    } else if (state.phase === "relations") {
      const badPublish = await registryDb
        .prepare(
          "SELECT 1 AS found FROM publishes p JOIN packages k ON k.id=p.package_id JOIN repositories r ON r.id=p.feed_id WHERE r.owner_id=? AND k.repo_id<>p.feed_id LIMIT 1",
        )
        .bind(context.legacyOwnerId)
        .first();
      const badVirtual = await registryDb
        .prepare(
          "SELECT 1 AS found FROM virtual_members v JOIN repositories a ON a.id=v.virtual_id JOIN repositories b ON b.id=v.member_id WHERE (a.owner_id=? OR b.owner_id=?) AND a.owner_id<>b.owner_id LIMIT 1",
        )
        .bind(context.legacyOwnerId, context.legacyOwnerId)
        .first();
      if (badPublish || badVirtual) throw new Error("space_registry_cross_space_source");
      if (
        await registryDb
          .prepare("SELECT 1 AS invalid FROM pragma_foreign_key_check LIMIT 1")
          .first()
      )
        throw new Error("space_registry_orphaned_data");
      state.phase = "done";
    }
    return state;
  }
  async function migrateStep(
    context: SpaceMigrationContext,
    previous: RegistryMigrationState | null,
    baseline: SpaceParticipantInventory,
  ): Promise<SpaceMigrationStep<RegistryMigrationState, null>> {
    await guard(context, "migrate");
    if (baseline.storeId !== "registry") fail();
    const binding = canonicalSpaceJson({ context, baseline });
    if (previous && previous.binding !== binding) fail();
    const state: RegistryMigrationState = previous
      ? { ...previous }
      : { binding, phase: "validate", validation: newValidation(), afterFeed: "" };
    if (state.phase === "done") return { state, done: true, result: null };
    const receipt = await registryDb
      .prepare(`SELECT * FROM ${RECEIPTS} WHERE legacy_owner_id=?`)
      .bind(context.legacyOwnerId)
      .first<Receipt>();
    if (receipt) {
      if (!matches(receipt, context, baseline))
        throw new Error("space_registry_migration_context_mismatch");
      state.phase = "done";
      return { state, done: true, result: null };
    }
    if (state.phase === "validate") {
      state.validation = await validateStep(context, state.validation);
      if (state.validation.phase === "done") state.phase = "update";
    } else if (state.phase === "update") {
      const feeds = (
        await registryDb
          .prepare("SELECT id FROM repositories WHERE owner_id=? AND id>? ORDER BY id LIMIT 64")
          .bind(context.legacyOwnerId, state.afterFeed)
          .all<{ id: string }>()
      ).results;
      if (feeds.length) {
        await guard(context, "migrate");
        await registryDb
          .prepare(
            `UPDATE repositories SET space_id=? WHERE owner_id=? AND id IN (${feeds.map(() => "?").join(",")}) AND space_id IS NULL`,
          )
          .bind(context.spaceId, context.legacyOwnerId, ...feeds.map((feed) => feed.id))
          .run();
        state.afterFeed = feeds[feeds.length - 1]!.id;
      }
      if (feeds.length < 64) state.phase = "receipt";
    } else {
      if (
        await registryDb
          .prepare(
            "SELECT 1 AS found FROM repositories WHERE owner_id=? AND (space_id IS NULL OR space_id<>?) LIMIT 1",
          )
          .bind(context.legacyOwnerId, context.spaceId)
          .first()
      )
        throw new Error("space_registry_migration_incomplete");
      await guard(context, "migrate");
      await registryDb
        .prepare(
          `INSERT INTO ${RECEIPTS} (legacy_owner_id,space_id,organization_id,space_slug,run_id,migration_epoch,manifest_digest,contract_version,before_digest,after_digest,migrated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          context.legacyOwnerId,
          context.spaceId,
          context.organizationId,
          context.spaceSlug,
          context.runId,
          context.migrationEpoch,
          context.manifestDigest,
          context.contractVersion,
          baseline.digest,
          baseline.digest,
          new Date().toISOString(),
        )
        .run();
      state.phase = "done";
      return { state, done: true, result: null };
    }
    return { state, done: false };
  }
  async function reconcileStep(
    context: SpaceMigrationContext,
    contexts: readonly SpaceMigrationContext[],
    previous: RegistryReconcileState | null,
    baseline: SpaceParticipantInventory,
  ): Promise<SpaceMigrationStep<RegistryReconcileState, SpaceReconciliation>> {
    await guard(context, "reconcile");
    if (
      baseline.storeId !== "registry" ||
      !contexts.length ||
      contexts.some((candidate) => contextKey(candidate) !== contextKey(context))
    )
      fail();
    const binding = canonicalSpaceJson({ context, contexts, baseline });
    if (previous && previous.binding !== binding) fail();
    const state: RegistryReconcileState = previous
      ? { ...previous }
      : { binding, mappingIndex: 0, validation: newValidation(), inventory: null, result: null };
    if (state.result) return { state, done: true, result: state.result };
    const mapping = contexts[state.mappingIndex];
    if (mapping) {
      await guard(mapping, "reconcile");
      state.validation = await validateStep(mapping, state.validation);
      if (state.validation.phase === "done") {
        const receipt = await registryDb
          .prepare(`SELECT * FROM ${RECEIPTS} WHERE legacy_owner_id=?`)
          .bind(mapping.legacyOwnerId)
          .first<Receipt>();
        if (!receipt || !matches(receipt, mapping, baseline))
          throw new Error("space_registry_migration_context_mismatch");
        if (
          await registryDb
            .prepare(
              "SELECT 1 AS found FROM repositories WHERE owner_id=? AND (space_id IS NULL OR space_id<>?) LIMIT 1",
            )
            .bind(mapping.legacyOwnerId, mapping.spaceId)
            .first()
        )
          throw new Error("space_registry_migration_incomplete");
        state.mappingIndex++;
        state.validation = newValidation();
      }
      return { state, done: false };
    }
    if (!state.inventory) {
      const receipts = await registryDb
        .prepare(`SELECT count(*) AS n FROM ${RECEIPTS}`)
        .first<{ n: number }>();
      if (receipts?.n !== contexts.length)
        throw new Error("space_registry_migration_context_mismatch");
    }
    const scan = await checkpoint.inventoryStep(context, state.inventory, REGISTRY_PRESERVATION);
    state.inventory = scan.state;
    if (!scan.done) return { state, done: false };
    if (
      scan.result.digest !== baseline.digest ||
      canonicalSpaceJson(scan.result.counts) !== canonicalSpaceJson(baseline.counts)
    )
      throw new Error("space_registry_preservation_mismatch");
    state.result = { ...scan.result, preserved: true };
    return { state, done: true, result: state.result };
  }
  return { ...checkpoint, migrateStep, reconcileStep };
}
