import {
  DummyDriver,
  Kysely,
  sql as raw,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Compilable,
  type Generated,
  type InferResult,
  type RawBuilder,
} from "kysely";

/**
 * The Tracker Durable Object's own SQLite tables (created in TrackerStore's
 * constructor). Entities are stored whole as JSON text in `data`, parsed at
 * the edges.
 */
interface EntityRow {
  id: string;
  data: string;
}
export interface TrackerDatabase {
  teams: EntityRow;
  workspaces: EntityRow;
  issues: EntityRow;
  links: EntityRow;
  comments: EntityRow;
  requests: EntityRow;
  subscriptions: EntityRow;
  team_numbers: { id: string; number: number };
  leases: { issue_id: string; token: string };
  /** One pending handoff per issue, bound to the lease token it was offered under. */
  offers: {
    issue_id: string;
    code: string;
    lease_token: string;
    to_actor: string | null;
    expires_at: string;
  };
  receipts: { id: string; actor_id: string; request: string; result: string };
  events: { cursor: Generated<number>; data: string };
  issue_events: { issue_id: string; cursor: number };
  tracker_migrations: { name: string };
  /** Timelines (timelines.ts), whole as JSON like the entities above. */
  timelines: EntityRow;
  /** Timeline events, kept forever; `seq` orders them across timelines. */
  timeline_events: { seq: Generated<number>; id: string; data: string };
  /** The timelines each event belongs to: a merge between two is listed by both. */
  timeline_event_index: { timeline_id: string; seq: number };
  /** Checkpoints (CORE-76): written once, never changed. */
  timeline_checkpoints: { id: string; timeline_id: string; number: number; data: string };
  /**
   * Each timeline bookmark's last known tip, per repository: from pushes
   * (logged after they answer) and from checkpoints. Null once deleted.
   */
  timeline_heads: { timeline_id: string; repo_id: string; oid: string | null };
  /** Landings (CORE-77), whole as JSON; a timeline's newest is its current one. */
  timeline_landings: { id: string; timeline_id: string; created_at: string; data: string };
}

/**
 * The timeline tables (timelines.ts). Both stores create them: the tracker's
 * views read timelines, and either store may be constructed first.
 */
export const TIMELINE_TABLES = `CREATE TABLE IF NOT EXISTS timelines (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS timeline_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS timeline_event_index (timeline_id TEXT NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (timeline_id, seq));
  CREATE UNIQUE INDEX IF NOT EXISTS timeline_slugs ON timelines(json_extract(data, '$.slug'));
  CREATE TABLE IF NOT EXISTS timeline_checkpoints (id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL, number INTEGER NOT NULL, data TEXT NOT NULL, UNIQUE (timeline_id, number));
  CREATE TABLE IF NOT EXISTS timeline_heads (timeline_id TEXT NOT NULL, repo_id TEXT NOT NULL, oid TEXT, PRIMARY KEY (timeline_id, repo_id));
  CREATE TABLE IF NOT EXISTS timeline_landings (id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL, created_at TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS timeline_landings_by_timeline ON timeline_landings(timeline_id, created_at);`;

/** The storage surface the store needs: `ctx.storage.sql`, or a test double. */
export interface SqlDatabase {
  exec<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): { toArray(): T[]; one(): T };
}

/**
 * Kysely as a compile-only query builder. Durable Object SQLite is
 * synchronous, and a mutation batch stays atomic only while no `await` runs
 * between its statements, so queries are compiled here and executed through
 * the synchronous helpers below rather than through an async driver.
 */
export const tracker = new Kysely<TrackerDatabase>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (db) => new SqliteIntrospector(db),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

type Row<Q extends Compilable<any>> = InferResult<Q>[number];

function exec(sql: SqlDatabase, query: Compilable<any>) {
  const { sql: text, parameters } = query.compile();
  return sql.exec(text, ...(parameters as SqlStorageValue[]));
}

/** Every row of a query. */
export function all<Q extends Compilable<any>>(sql: SqlDatabase, query: Q): Row<Q>[] {
  return exec(sql, query).toArray() as Row<Q>[];
}

/** The first row of a query, or undefined. */
export function first<Q extends Compilable<any>>(sql: SqlDatabase, query: Q): Row<Q> | undefined {
  return exec(sql, query).toArray()[0] as Row<Q> | undefined;
}

/** Exactly one row (e.g. an aggregate or RETURNING); throws otherwise. */
export function one<Q extends Compilable<any>>(sql: SqlDatabase, query: Q): Row<Q> {
  return exec(sql, query).one() as Row<Q>;
}

/** Runs a statement for its effect. */
export function run(sql: SqlDatabase, query: Compilable<any>): void {
  exec(sql, query);
}

/**
 * `json_extract(column, '$.path')` with the path inlined as a literal, so
 * the comparison matches the store's indexes on the same expressions.
 */
export function json<T = unknown>(column: string, path: string): RawBuilder<T> {
  return raw<T>`json_extract(${raw.ref(column)}, ${raw.lit(path)})`;
}
