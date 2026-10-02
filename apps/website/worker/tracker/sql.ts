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
  subscriptions: EntityRow;
  team_numbers: { id: string; number: number };
  leases: { issue_id: string; token: string };
  receipts: { id: string; actor_id: string; request: string; result: string };
  events: { cursor: Generated<number>; data: string };
}

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
