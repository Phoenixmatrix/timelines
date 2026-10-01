import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * An in-memory D1 stand-in over `node:sqlite` implementing the subset of the
 * D1 API the registry uses: `prepare().bind()` with `first()`/`all()`/`run()`/
 * `raw()`, and `batch()` executed as one transaction. Cast to `D1Database` at
 * the call site; this is a test double, not a full implementation.
 */

type Param = null | number | bigint | string | Uint8Array;
const MAX_BOUND_PARAMETERS = 100;

function normalize(values: unknown[]): Param[] {
  return values.map((v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (v instanceof ArrayBuffer) return new Uint8Array(v);
    return v as Param;
  });
}

export class FakeStatement {
  private readonly db: DatabaseSync;
  private readonly sql: string;
  private readonly params: Param[];
  constructor(db: DatabaseSync, sql: string, params: Param[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: unknown[]): FakeStatement {
    if (values.length > MAX_BOUND_PARAMETERS) {
      throw new Error("D1_ERROR: too many SQL variables: SQLITE_ERROR");
    }
    return new FakeStatement(this.db, this.sql, normalize(values));
  }

  private stmt(): StatementSync {
    return this.db.prepare(this.sql);
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.stmt().get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{
    results: T[];
    success: true;
    meta: { changes: number; last_row_id: number | null; duration: number };
  }> {
    const stmt = this.stmt();
    // Statements that return no columns (INSERT/UPDATE without RETURNING) must run.
    if (stmt.columns().length === 0) {
      const info = stmt.run(...this.params);
      return {
        results: [],
        success: true,
        meta: {
          changes: Number(info.changes),
          last_row_id: Number(info.lastInsertRowid),
          duration: 0,
        },
      };
    }
    const results = stmt.all(...this.params) as T[];
    return { results, success: true, meta: { changes: 0, last_row_id: null, duration: 0 } };
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.stmt();
    const rows = stmt.all(...this.params) as Record<string, unknown>[];
    const values = rows.map((row) => Object.values(row)) as T[];
    if (options?.columnNames) {
      return [stmt.columns().map((c) => c.name) as T, ...values];
    }
    return values;
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const info = this.stmt().run(...this.params);
    return {
      success: true,
      meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
    };
  }
}

export class FakeD1 {
  private readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys = ON");
  }

  /** Apply raw migration SQL (multiple statements) directly. */
  applySql(sql: string): void {
    this.sqlite.exec(sql);
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.sqlite, sql);
  }

  async batch<T = unknown>(statements: FakeStatement[]): Promise<T[]> {
    this.sqlite.exec("BEGIN");
    try {
      const out: T[] = [];
      for (const statement of statements) out.push((await statement.all()) as T);
      this.sqlite.exec("COMMIT");
      return out;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }

  withSession(): FakeD1 {
    return this;
  }
}
