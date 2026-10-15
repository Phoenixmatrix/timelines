import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import type { D1CheckpointSchema } from "../../registry/core/space-migration.ts";
import type { SpaceMigrationContext } from "../../shared/space-cutover.ts";
import { d1, migratedDatabase, migratedRegistryDatabase } from "../testing/d1.ts";
import { fenceBusinessDatabase, migrationDatabase } from "./storage-fence.ts";
import {
  buildCanonicalD1Schema,
  initializeCanonicalEmptyStoreStep,
  type CanonicalEmptyStoreState,
  type CanonicalStore,
} from "./canonical-schema.ts";

function schemaOf(sqlite: DatabaseSync, storeId: CanonicalStore): D1CheckpointSchema {
  const schema = sqlite
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND tbl_name <> '_space_cutover_fence' AND name NOT GLOB '_space_cutover_write_*' ORDER BY type,name",
    )
    .all() as D1CheckpointSchema["schema"];
  const tables: D1CheckpointSchema["tables"] = schema
    .filter((entry) => entry.type === "table")
    .map((entry) => {
      const columns = sqlite.prepare(`PRAGMA table_info("${entry.name}")`).all() as {
        name: string;
        pk: number;
      }[];
      const rowid = !/\bWITHOUT\s+ROWID\b/i.test(entry.sql);
      const parents = sqlite.prepare(`PRAGMA foreign_key_list("${entry.name}")`).all() as {
        table: string;
      }[];
      return {
        name: entry.name,
        columns: columns.map((column) => column.name),
        rowid,
        keys: rowid
          ? ["_rowid_"]
          : columns
              .filter((column) => column.pk)
              .sort((a, b) => a.pk - b.pk)
              .map((column) => column.name),
        parents: [...new Set(parents.map((parent) => parent.table))],
      };
    });
  if (sqlite.prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'").get())
    tables.push({
      name: "sqlite_sequence",
      columns: ["name", "seq"],
      keys: ["_rowid_"],
      rowid: true,
      parents: [],
    });
  return { kind: "schema", storeId, schema, tables };
}

const context: SpaceMigrationContext = {
  runId: "fresh-canonical-regression",
  migrationEpoch: 0,
  manifestDigest: "fresh-canonical-regression",
  legacyOwnerId: "",
  spaceId: "",
  organizationId: "",
  spaceSlug: "",
  contractVersion: 4,
};

describe("canonical initialization after real ordinary migrations", () => {
  for (const store of ["application", "registry"] as const) {
    it(`preserves exact ${store} Instance migration seeds and bookkeeping`, async () => {
      const sqlite = store === "application" ? migratedDatabase() : migratedRegistryDatabase();
      try {
        sqlite.exec(
          "CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL); INSERT INTO d1_migrations(name) VALUES ('migration-receipt')",
        );
        const names =
          store === "application"
            ? [
                "cloudflare_price_changes",
                "cloudflare_prices",
                "environment_limits",
                "d1_migrations",
                "sqlite_sequence",
              ]
            : ["artifact_backfill", "d1_migrations", "sqlite_sequence"];
        const before = names.map((name) => ({
          name,
          rows: sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all(),
        }));
        for (const snapshot of before) expect(snapshot.rows.length).toBeGreaterThan(0);
        const source = schemaOf(sqlite, store);
        const target = buildCanonicalD1Schema(source, store);
        const raw = d1(sqlite);
        await fenceBusinessDatabase(raw, context, "fresh-test-authority");
        const db = migrationDatabase(
          raw,
          context,
          "migrate",
          async () => {},
          "fresh-test-authority",
        );
        let state: CanonicalEmptyStoreState | null = null;
        const initialSchema = sqlite
          .prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name")
          .all();
        for (let step = 0; step <= source.tables.length + 1; step++) {
          const result = await initializeCanonicalEmptyStoreStep(db, source, target, state);
          state = result.state;
          if (state.phase === "drop") break;
        }
        expect(state?.phase).toBe("drop");
        expect(
          sqlite.prepare("SELECT type,name,sql FROM sqlite_schema ORDER BY type,name").all(),
        ).toEqual(initialSchema);
        for (let step = 0; step < 2000; step++) {
          const result = await initializeCanonicalEmptyStoreStep(db, source, target, state);
          // Repeat every committed unit with the previous durable cursor, as if
          // its mutation committed but the control journal acknowledgement did not.
          const replay = await initializeCanonicalEmptyStoreStep(db, source, target, state);
          expect(replay).toEqual(result);
          state = result.state;
          if (result.done) break;
        }
        expect(state?.phase).toBe("done");
        for (const snapshot of before)
          expect(sqlite.prepare(`SELECT * FROM "${snapshot.name}" ORDER BY rowid`).all()).toEqual(
            snapshot.rows,
          );
        expect(schemaOf(sqlite, store)).toEqual(target);
        expect(
          sqlite.prepare("SELECT fenced,bypass FROM _space_cutover_fence WHERE id=1").get(),
        ).toEqual({ fenced: 1, bypass: 0 });
        if (store === "application") {
          const trigger = sqlite
            .prepare("SELECT sql FROM sqlite_schema WHERE name='release_highlights_space_deleted'")
            .get() as { sql: string };
          expect(trigger.sql).toContain("AFTER DELETE ON spaces");
          expect(trigger.sql).toContain("'$.spaceId'");
          expect(trigger.sql).toContain("'$.trackerSpaceId'");
          expect(trigger.sql).not.toContain("ownerAccountId");
          expect(
            sqlite
              .prepare(
                "SELECT 1 FROM sqlite_schema WHERE name='release_highlights_account_deleted'",
              )
              .get(),
          ).toBeUndefined();
        }
      } finally {
        sqlite.close();
      }
    });
  }
});
