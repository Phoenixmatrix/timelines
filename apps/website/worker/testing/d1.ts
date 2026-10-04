// Test helpers: D1 over node:sqlite, with this app's migrations applied.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export /** Enough of D1 over node:sqlite for Kysely (kysely-d1) and Better Auth's D1 dialect. */
function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, params: SQLInputValue[] = []) => {
    const run = () => {
      const total = () => (sqlite.prepare("SELECT total_changes() AS c").get() as { c: number }).c;
      const before = total();
      const prepared = sqlite.prepare(sql);
      const results = prepared.all(...params) as Record<string, unknown>[];
      // D1 counts trigger writes too, not just the outer statement's changes().
      return { results, changes: total() - before };
    };
    return {
      bind: (...next: SQLInputValue[]) => statement(sql, next),
      async all() {
        const { results, changes } = run();
        return { results, success: true, meta: { changes, last_row_id: 0, duration: 0 } };
      },
      async first(column?: string) {
        const row = run().results[0] ?? null;
        return column && row ? row[column] : row;
      },
      async run() {
        const { changes } = run();
        return { results: [], success: true, meta: { changes, last_row_id: 0, duration: 0 } };
      },
      async raw() {
        return run().results.map((row) => Object.values(row));
      },
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { all(): Promise<unknown> }[]) =>
      Promise.all(statements.map((s) => s.all())),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

/** A fresh in-memory database with every migration in migrations/ applied, in order. */
export function migratedDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../migrations/", import.meta.url).href);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  return sqlite;
}

/** A fresh in-memory registry database (REGISTRY_DB) with registry/migrations applied. */
export function migratedRegistryDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../registry/migrations/", import.meta.url).href);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
  return sqlite;
}
