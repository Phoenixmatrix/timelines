// Test helpers: a Durable Object's synchronous SQLite storage over node:sqlite.

import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDatabase } from "../tracker/sql.ts";

export function durableStorage(db = new DatabaseSync(":memory:")) {
  const sql: SqlDatabase = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) {
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
  const transactionSync = <T>(fn: () => T): T => {
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
  return { db, sql, transactionSync };
}
