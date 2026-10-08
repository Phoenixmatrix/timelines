// Test helpers: the Tracker Durable Object's synchronous SQL over node:sqlite.

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqlDatabase } from "../tracker/store.ts";
import { boundVariables } from "./durable.ts";

/** Durable Object SQL storage's exec(), enough for TrackerStore. */
export function trackerSql(db: DatabaseSync): SqlDatabase {
  return {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) {
      boundVariables(bindings);
      if (query.includes("CREATE TABLE")) {
        db.exec(query);
        return {
          toArray: () => [] as T[],
          one: (): T => {
            throw new Error("DDL has no rows");
          },
        };
      }
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[])) as T[];
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error("Expected exactly one SQL row");
          return rows[0]!;
        },
      };
    },
  };
}

/** ctx.storage.transactionSync over node:sqlite. */
export function transactional(db: DatabaseSync) {
  return <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}
