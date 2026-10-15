// Test helpers: D1 over node:sqlite, with this app's migrations applied.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { providedDatabase } from "./provided.ts";

export /** Enough of D1 over node:sqlite for Kysely (kysely-d1) and Better Auth's D1 dialect. */
function d1(sqlite: DatabaseSync): D1Database {
  const executions = new WeakMap<object, () => unknown>();
  const statement = (sql: string, params: SQLInputValue[] = []) => {
    const run = () => {
      const total = () => (sqlite.prepare("SELECT total_changes() AS c").get() as { c: number }).c;
      const before = total();
      const prepared = sqlite.prepare(sql);
      const results = prepared.all(...params) as Record<string, unknown>[];
      // D1 counts trigger writes too, not just the outer statement's changes().
      return { results, changes: total() - before };
    };
    const all = () => {
      const { results, changes } = run();
      return { results, success: true, meta: { changes, last_row_id: 0, duration: 0 } };
    };
    const prepared = {
      bind: (...next: SQLInputValue[]) => statement(sql, next),
      async all() {
        return all();
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
    executions.set(prepared, all);
    return prepared;
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { all(): Promise<unknown> }[]) => {
      const execute = statements.map((statement) => {
        const run = executions.get(statement);
        if (!run) throw new Error("D1 batch received a statement from another database");
        return run;
      });
      // D1 serializes each batch transaction. Never yield with BEGIN open: Node
      // callers may start another batch while this one's promise is pending.
      sqlite.exec("BEGIN");
      try {
        const results = execute.map((run) => run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

/** Every migration in `dir`, applied in order to a new in-memory database, serialized. */
function migrate(dir: string): Uint8Array {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort())
      sqlite.exec(readFileSync(join(dir, file), "utf8"));
    return sqlite.serialize();
  } finally {
    sqlite.close();
  }
}

// Migrating takes about 0.15 s; restoring a copy takes about a millisecond.
// The unit run migrates once (worker/testing/provided.ts); other runs, once per module.
let migrated: Uint8Array | undefined;
let migratedRegistry: Uint8Array | undefined;

export function migratedDatabaseBytes(): Uint8Array {
  return (migrated ??=
    providedDatabase("migrated") ??
    migrate(fileURLToPath(new URL("../../migrations/", import.meta.url).href)));
}

export function migratedRegistryDatabaseBytes(): Uint8Array {
  return (migratedRegistry ??=
    providedDatabase("migratedRegistry") ??
    migrate(fileURLToPath(new URL("../../registry/migrations/", import.meta.url).href)));
}

/** A new in-memory database restored from serialized bytes. */
export function restoredDatabase(bytes: Uint8Array): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.deserialize(bytes);
  return sqlite;
}

/** A fresh in-memory database with every migration in migrations/ applied, in order. */
export function migratedDatabase(): DatabaseSync {
  return restoredDatabase(migratedDatabaseBytes());
}

/** A fresh in-memory registry database (REGISTRY_DB) with registry/migrations applied. */
export function migratedRegistryDatabase(): DatabaseSync {
  return restoredDatabase(migratedRegistryDatabaseBytes());
}
