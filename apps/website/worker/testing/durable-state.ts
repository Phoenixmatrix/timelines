// Test helpers: a whole DurableObjectState over node:sqlite, enough for the
// purge contract (worker/durable/contract.ts): SQL, the key-value API (in
// `_cf_KV`, like a SQLite-backed object), alarms, deleteAll, databaseSize,
// abort and an optional container.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export interface FakeContainer {
  running: boolean;
  destroyed: number;
  destroy(): Promise<void>;
}

export function fakeContainer(running = true): FakeContainer {
  const container: FakeContainer = {
    running,
    destroyed: 0,
    async destroy() {
      container.destroyed++;
      container.running = false;
    },
  };
  return container;
}

export function fakeDurableObjectId(name?: string): DurableObjectId {
  return {
    name,
    toString: () => name ?? "id",
    equals: (other: DurableObjectId) => other.toString() === (name ?? "id"),
  };
}

export function fakeDurableState(
  options: { name?: string; container?: FakeContainer; db?: DatabaseSync } = {},
) {
  // A given database (a restored snapshot) stands in for a fresh empty one.
  const db = options.db ?? new DatabaseSync(":memory:");
  const kv = () => db.exec("CREATE TABLE IF NOT EXISTS _cf_KV (key TEXT PRIMARY KEY, value TEXT)");
  let alarm: number | null = null;
  const aborted: string[] = [];
  let depth = 0;

  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      // Schema scripts hold several statements, which only exec() runs.
      if (bindings.length === 0 && /\bCREATE\s+(TABLE|INDEX|UNIQUE)/i.test(query)) {
        db.exec(query);
        return {
          toArray: () => [],
          one: () => ({}),
          [Symbol.iterator]: () => [][Symbol.iterator](),
        };
      }
      // Native DO SQL binds/returns ArrayBuffer; node:sqlite uses byte views.
      const inputs = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value,
      ) as SQLInputValue[];
      const rows = db.prepare(query).all(...inputs) as Record<string, unknown>[];
      for (const row of rows) {
        for (const [key, value] of Object.entries(row)) {
          if (value instanceof Uint8Array)
            row[key] = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        }
      }
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error("Expected exactly one SQL row");
          return rows[0]!;
        },
        [Symbol.iterator]: () => rows[Symbol.iterator](),
      };
    },
    get databaseSize() {
      const { page_count } = db.prepare("PRAGMA page_count").get() as { page_count: number };
      const { page_size } = db.prepare("PRAGMA page_size").get() as { page_size: number };
      return page_count * page_size;
    },
  };

  const storage = {
    sql,
    async get<T>(key: string): Promise<T | undefined> {
      kv();
      const row = db.prepare("SELECT value FROM _cf_KV WHERE key = ?").get(key) as
        | { value: string }
        | undefined;
      return row ? (JSON.parse(row.value) as T) : undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      kv();
      db.prepare("INSERT OR REPLACE INTO _cf_KV (key, value) VALUES (?, ?)").run(
        key,
        JSON.stringify(value),
      );
    },
    async delete(key: string): Promise<boolean> {
      kv();
      return Number(db.prepare("DELETE FROM _cf_KV WHERE key = ?").run(key).changes) > 0;
    },
    async list(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, unknown>> {
      kv();
      const prefix = options.prefix ?? "";
      const rows = db
        .prepare(
          "SELECT key, value FROM _cf_KV WHERE substr(key, 1, length(?)) = ? ORDER BY key LIMIT ?",
        )
        .all(prefix, prefix, options.limit ?? -1) as { key: string; value: string }[];
      return new Map(rows.map((r) => [r.key, JSON.parse(r.value)]));
    },
    async deleteAll(): Promise<void> {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[];
      for (const { name } of tables) db.exec(`DROP TABLE "${name}"`);
      // Like a SQLite-backed object's (compatibility date 2026), deleteAll takes the alarm too.
      alarm = null;
    },
    async getAlarm(): Promise<number | null> {
      return alarm;
    },
    async setAlarm(at: number | Date): Promise<void> {
      alarm = typeof at === "number" ? at : at.getTime();
    },
    async deleteAlarm(): Promise<void> {
      alarm = null;
    },
    transactionSync<T>(fn: () => T): T {
      const savepoint = `nested_${depth}`;
      db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN");
      depth++;
      try {
        const result = fn();
        depth--;
        db.exec(depth ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        depth--;
        db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
        throw error;
      }
    },
  };

  const ctx = {
    id: fakeDurableObjectId(options.name),
    storage,
    container: options.container,
    waitUntil: () => {},
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
    abort(reason?: string) {
      aborted.push(reason ?? "");
    },
  };
  return {
    db,
    ctx: ctx as unknown as DurableObjectState,
    aborted,
    alarm: () => alarm,
  };
}
