import { FakeD1 } from "@gitmatrix/testing";
import { describe, expect, test } from "vite-plus/test";
import type {
  SpaceCheckpointPage,
  SpaceMigrationContext,
  SpaceParticipantGuard,
} from "../../shared/space-cutover.ts";
import {
  fenceBusinessDatabase,
  migrationDatabase,
} from "../../worker/space-cutover/storage-fence.ts";
import {
  createD1SpaceCheckpoint,
  createFencedD1TableStatements,
  inspectD1SpaceCheckpointStep,
  type D1InspectionState,
  type D1InventoryState,
  type D1RestoreState,
  type SpaceCheckpointReader,
} from "./space-migration.ts";

const context: SpaceMigrationContext = {
  runId: "structural-reconstruction",
  migrationEpoch: 9,
  manifestDigest: "approved-schema",
  legacyOwnerId: "person",
  spaceId: "space",
  organizationId: "organization",
  spaceSlug: "space",
  contractVersion: 4,
};
const guard: SpaceParticipantGuard = async () => {};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function database(sql: string): D1Database {
  const fake = new FakeD1();
  fake.applySql(`
    CREATE TABLE _space_cutover_fence(
      id INTEGER PRIMARY KEY,run_id TEXT,migration_epoch INTEGER,manifest_digest TEXT,
      authority_token TEXT NOT NULL DEFAULT '',fenced INTEGER NOT NULL DEFAULT 0,
      bypass INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO _space_cutover_fence(id) VALUES(1);
    ${sql}
  `);
  return fake as unknown as D1Database;
}
async function checkpoint(db: D1Database) {
  const pages: SpaceCheckpointPage[] = [];
  let state: D1InventoryState | null = null;
  for (let step = 0; step < 30_000; step++) {
    const result = await createD1SpaceCheckpoint(db, "fixture", guard).inventoryStep(
      context,
      state,
    );
    state = clone(result.state);
    if (result.page) pages.push(result.page);
    if (result.done) {
      const byCursor = new Map(pages.map((page) => [page.cursor, page]));
      const read: SpaceCheckpointReader = async (cursor) => {
        const page = byCursor.get(cursor);
        if (!page) throw new Error("missing immutable archive page");
        return page;
      };
      return { read, digest: result.result.digest, pages };
    }
  }
  throw new Error("checkpoint did not finish");
}
async function restore(
  db: D1Database,
  read: SpaceCheckpointReader,
  previous: D1RestoreState | null = null,
  replay = false,
  purpose: "restore" | "migrate" = "restore",
) {
  let state = previous;
  for (let step = 0; step < 30_000; step++) {
    const participant = () => createD1SpaceCheckpoint(db, "fixture", guard, { purpose });
    // Lose every response once, including committed DDL/rows/sequence writes.
    if (replay) await participant().restoreStep(context, read, clone(state));
    const result = await participant().restoreStep(context, read, clone(state));
    state = clone(result.state);
    if (result.done) {
      expect(state.inspection).toBeNull();
      expect(state.verification).toBeNull();
      expect(state.ordered).toEqual([]);
      expect(await participant().restoreStep(context, read, state)).toEqual(result);
      return result.result;
    }
  }
  throw new Error("restore did not finish");
}

const exactSchema = `
  CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id TEXT NOT NULL UNIQUE);
  CREATE TABLE child(id TEXT PRIMARY KEY,parent_id INTEGER NOT NULL REFERENCES parent(id),value TEXT,bytes BLOB,wide INTEGER);
  CREATE TABLE audit(id INTEGER PRIMARY KEY,note TEXT);
  CREATE TABLE keyed(a TEXT,b INTEGER,PRIMARY KEY(a,b)) WITHOUT ROWID;
  CREATE INDEX child_parent ON child(parent_id);
  CREATE VIEW child_view AS SELECT id,value FROM child;
  CREATE TRIGGER child_audit AFTER INSERT ON child BEGIN INSERT INTO audit(note) VALUES('original trigger'); END;
  INSERT INTO parent(id,owner_id) VALUES(12,'owner');
  INSERT INTO child(_rowid_,id,parent_id,value,bytes,wide)
    VALUES(9007199254740995,'opaque-child',12,CAST(X'610062' AS TEXT),X'00FF8041',9223372036854775806);
  INSERT INTO keyed VALUES('opaque',9223372036854775805);
  UPDATE sqlite_sequence SET seq=9223372036854775000 WHERE name='parent';
`;

describe("bounded exact D1 structural checkpoint reconstruction", () => {
  test("completed inspection retains one authoritative schema and resumes without archive reads", async () => {
    const db = database(
      "CREATE TABLE original(id TEXT PRIMARY KEY); INSERT INTO original VALUES('opaque');",
    );
    const archive = await checkpoint(db);
    let state: D1InspectionState | null = null;
    for (let index = 0; index < 1000; index++) {
      const step = await inspectD1SpaceCheckpointStep(context, "fixture", archive.read, state);
      state = clone(step.state);
      if (step.done) {
        expect(state.schema).toBeNull();
        expect(state.counts).toEqual({});
        expect(state.tableRanges).toEqual({});
        expect(state.result?.schema.tables.map((table) => table.name)).toEqual(["original"]);
        expect(state.result?.counts).toEqual({ original: 1 });
        expect(state.result?.tableRanges.original).toBeDefined();
        expect(state.result?.digest).toBe(archive.digest);
        expect(
          await inspectD1SpaceCheckpointStep(
            context,
            "fixture",
            async () => {
              throw new Error("completed inspection must not reread archive");
            },
            state,
          ),
        ).toEqual(step);
        return;
      }
    }
    throw new Error("inspection did not finish");
  });

  test("restores changed tables, indexes, views and original triggers without replay side effects", async () => {
    const db = database(exactSchema);
    await fenceBusinessDatabase(db, context, "authority");
    const archive = await checkpoint(db);
    const migration = migrationDatabase(db, context, "restore", guard, "authority");
    await migration.batch([
      migration.prepare("DROP TRIGGER child_audit"),
      migration.prepare("ALTER TABLE child RENAME COLUMN value TO changed_value"),
      migration.prepare("ALTER TABLE parent ADD COLUMN space_id TEXT"),
      migration.prepare("DROP VIEW child_view"),
      migration.prepare("CREATE VIEW child_view AS SELECT id,bytes FROM child"),
      migration.prepare("DROP INDEX child_parent"),
      migration.prepare("CREATE INDEX child_parent ON child(id,parent_id)"),
      ...createFencedD1TableStatements(
        migration,
        "target_only",
        "CREATE TABLE target_only(id TEXT PRIMARY KEY)",
      ),
      migration.prepare("INSERT INTO target_only VALUES('new schema')"),
      migration.prepare("UPDATE child SET changed_value='changed',bytes=X'01',wide=2"),
      migration.prepare("DELETE FROM audit"),
      migration.prepare(
        "CREATE TRIGGER target_audit AFTER INSERT ON child BEGIN INSERT INTO audit(note) VALUES('target trigger'); END",
      ),
    ]);
    const result = await restore(migration, archive.read, null, true);
    expect(result.digest).toBe(archive.digest);
    expect(result.preserved).toBe(true);
    expect(
      await db
        .prepare(
          "SELECT CAST(_rowid_ AS TEXT) AS rowid,hex(value) AS text,hex(bytes) AS bytes,CAST(wide AS TEXT) AS wide FROM child",
        )
        .first(),
    ).toEqual({
      rowid: "9007199254740995",
      text: "610062",
      bytes: "00FF8041",
      wide: "9223372036854775806",
    });
    expect(
      await db
        .prepare("SELECT CAST(seq AS TEXT) AS seq FROM sqlite_sequence WHERE name='parent'")
        .first(),
    ).toEqual({ seq: "9223372036854775000" });
    expect(await db.prepare("SELECT note FROM audit").all()).toMatchObject({
      results: [{ note: "original trigger" }],
    });
    expect(
      await db
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('target_only','target_audit')")
        .all(),
    ).toMatchObject({ results: [] });
    expect(
      await db.prepare("SELECT authority_token,bypass,fenced FROM _space_cutover_fence").first(),
    ).toEqual({ authority_token: "authority", bypass: 0, fenced: 1 });
    await expect(
      db.prepare("INSERT INTO parent(owner_id) VALUES('old writer')").run(),
    ).rejects.toThrow("space_cutover_fenced");
    await migration
      .prepare("INSERT INTO child(id,parent_id,value) VALUES('after',12,'after restore')")
      .run();
    expect(await db.prepare("SELECT count(*) AS n FROM audit").first()).toEqual({ n: 2 });
  });

  test("table creation and fence triggers commit together, and stale authority cannot resume reconstruction", async () => {
    const db = database(
      "CREATE TABLE original(id TEXT PRIMARY KEY); INSERT INTO original VALUES('opaque');",
    );
    await fenceBusinessDatabase(db, context, "old");
    const archive = await checkpoint(db);
    const old = migrationDatabase(db, context, "restore", guard, "old");
    let state: D1RestoreState | null = null;
    for (let step = 0; step < 1000; step++) {
      const result = await createD1SpaceCheckpoint(old, "fixture", guard).restoreStep(
        context,
        archive.read,
        state,
      );
      state = clone(result.state);
      if (state.phase === "create-tables") break;
    }
    expect(state?.phase).toBe("create-tables");
    await fenceBusinessDatabase(db, context, "new", "old");
    await expect(
      createD1SpaceCheckpoint(old, "fixture", guard).restoreStep(context, archive.read, state),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT name FROM sqlite_master WHERE name='original'").first(),
    ).toBeNull();
    const current = migrationDatabase(db, context, "restore", guard, "new");
    const created = await createD1SpaceCheckpoint(current, "fixture", guard).restoreStep(
      context,
      archive.read,
      state,
    );
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name='original'",
        )
        .first(),
    ).toEqual({ n: 3 });
    await expect(db.prepare("INSERT INTO original VALUES('late')").run()).rejects.toThrow(
      "space_cutover_fenced",
    );
    expect((await restore(current, archive.read, created.state, true)).digest).toBe(archive.digest);
  });

  for (const boundary of [
    "before-tables",
    "organizations-created",
    "all-tables-created",
  ] as const) {
    for (const replay of [false, true]) {
      test(`restores original checkpoint after canonical table boundary ${boundary}, lost progress ${replay}`, async () => {
        const db = database(exactSchema);
        await fenceBusinessDatabase(db, context, "authority");
        const original = await checkpoint(db);
        const canonical = await checkpoint(
          database(`
            CREATE TABLE organizations(id TEXT PRIMARY KEY,default_space_id TEXT NOT NULL,
              FOREIGN KEY(default_space_id,id) REFERENCES spaces(id,organization_id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TABLE spaces(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(id,organization_id));
            CREATE TABLE repositories(id INTEGER PRIMARY KEY AUTOINCREMENT,space_id TEXT NOT NULL REFERENCES spaces(id));
          `),
        );
        const migration = migrationDatabase(db, context, "migrate", guard, "authority");
        let state: D1RestoreState | null = null;
        for (let step = 0; step < 1000; step++) {
          const result = await createD1SpaceCheckpoint(migration, "fixture", guard, {
            purpose: "migrate",
          }).restoreStep(context, canonical.read, clone(state));
          if (replay && state?.phase === "create-tables") {
            // The committed operation survives, but the caller loses its new journal state.
            const repeated = await createD1SpaceCheckpoint(migration, "fixture", guard, {
              purpose: "migrate",
            }).restoreStep(context, canonical.read, clone(state));
            expect(repeated).toEqual(result);
          }
          state = clone(result.state);
          if (boundary === "before-tables" && state.phase === "create-tables") break;
          if (
            boundary === "organizations-created" &&
            state.phase === "create-tables" &&
            (await db
              .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='organizations'")
              .first())
          )
            break;
          if (boundary === "all-tables-created" && state.phase === "create-indexes") break;
          if (result.done) throw new Error("missed canonical table-creation interruption");
        }
        expect(state?.phase).toBe(
          boundary === "all-tables-created" ? "create-indexes" : "create-tables",
        );
        if (boundary === "organizations-created") {
          expect(
            await db
              .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('organizations','spaces') ORDER BY name",
              )
              .all(),
          ).toMatchObject({ results: [{ name: "organizations" }, { name: "spaces" }] });
          expect(
            await db
              .prepare(
                "SELECT count(*) AS n FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('organizations','spaces')",
              )
              .first(),
          ).toEqual({ n: 6 });
          expect(state?.index).toBe(2);
          await expect(
            db.prepare("INSERT INTO organizations VALUES('late','late-space')").run(),
          ).rejects.toThrow("space_cutover_fenced");
          await expect(
            db.prepare("INSERT INTO spaces VALUES('late-space','late')").run(),
          ).rejects.toThrow("space_cutover_fenced");
        }

        // Recovery starts a fresh restore journal against the interrupted live schema.
        const recovery = migrationDatabase(db, context, "restore", guard, "authority");
        expect((await restore(recovery, original.read, null, true)).digest).toBe(original.digest);
        expect((await checkpoint(db)).pages).toEqual(original.pages);
        expect(await db.prepare("SELECT * FROM pragma_foreign_key_check").all()).toMatchObject({
          results: [],
        });
        expect(await db.prepare("SELECT bypass,fenced FROM _space_cutover_fence").first()).toEqual({
          bypass: 0,
          fenced: 1,
        });
        await expect(
          db.prepare("INSERT INTO parent(owner_id) VALUES('late')").run(),
        ).rejects.toThrow("space_cutover_fenced");
      });
    }
  }

  test("a failed atomic CREATE cannot leave an unguarded business table", async () => {
    const db = database("");
    await fenceBusinessDatabase(db, context, "authority");
    const migration = migrationDatabase(db, context, "migrate", guard, "authority");
    await expect(
      migration.batch([
        ...createFencedD1TableStatements(migration, "new_table", "CREATE TABLE new_table(id TEXT)"),
        migration.prepare("INSERT INTO nonexistent VALUES(1)"),
      ]),
    ).rejects.toThrow();
    expect(
      await db.prepare("SELECT name FROM sqlite_master WHERE name='new_table'").first(),
    ).toBeNull();
    expect(await db.prepare("SELECT bypass FROM _space_cutover_fence").first()).toEqual({
      bypass: 0,
    });
  });

  test("rejects a self-consistent but independently unapproved archive before any mutation", async () => {
    const db = database(
      "CREATE TABLE original(id TEXT PRIMARY KEY); INSERT INTO original VALUES('opaque');",
    );
    await fenceBusinessDatabase(db, context, "authority");
    const archive = await checkpoint(db);
    const migration = migrationDatabase(db, context, "restore", guard, "authority");
    let state: D1RestoreState | null = null;
    const rejected = async () => {
      for (let step = 0; step < 1000; step++) {
        const result = await createD1SpaceCheckpoint(migration, "fixture", guard).restoreStep(
          context,
          archive.read,
          state,
          "different-approved-digest",
        );
        state = clone(result.state);
        if (result.done) throw new Error("unexpected acceptance");
      }
      throw new Error("unexpected nontermination");
    };
    await expect(rejected()).rejects.toThrow("space_checkpoint_expected_digest_mismatch");
    expect(await db.prepare("SELECT id FROM original").first()).toEqual({ id: "opaque" });
    expect((await checkpoint(db)).digest).toBe(archive.digest);
    await expect(
      createD1SpaceCheckpoint(migration, "fixture", guard).restoreStep(
        context,
        archive.read,
        state,
        archive.digest,
      ),
    ).rejects.toThrow("space_registry_checkpoint_invalid");
  });

  test("forward reconstruction uses migrate authority, not rollback authority", async () => {
    const db = database(
      "CREATE TABLE original(id TEXT PRIMARY KEY); INSERT INTO original VALUES('opaque');",
    );
    await fenceBusinessDatabase(db, context, "authority");
    const archive = await checkpoint(db);
    const operations: string[] = [];
    const forwardGuard: SpaceParticipantGuard = async (_, operation) => {
      operations.push(operation);
      if (operation === "restore") throw new Error("rollback is not authorized");
    };
    const migration = migrationDatabase(db, context, "migrate", forwardGuard, "authority");
    let state: D1RestoreState | null = null;
    for (let step = 0; step < 1000; step++) {
      const result = await createD1SpaceCheckpoint(migration, "fixture", forwardGuard, {
        purpose: "migrate",
      }).restoreStep(context, archive.read, state);
      state = clone(result.state);
      if (result.done) {
        expect(result.result.digest).toBe(archive.digest);
        expect(operations).toContain("migrate");
        expect(operations).not.toContain("restore");
        return;
      }
    }
    throw new Error("forward reconstruction did not finish");
  });

  test("restores many required Organization/default-Space pairs and prunes more than 32 nondefault Spaces", async () => {
    const db = database(`
      CREATE TABLE organizations(id TEXT PRIMARY KEY,default_space_id TEXT NOT NULL,
        FOREIGN KEY(default_space_id,id) REFERENCES spaces(id,organization_id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TABLE spaces(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id) DEFERRABLE INITIALLY DEFERRED,UNIQUE(id,organization_id));
    `);
    for (let index = 0; index < 40; index++) {
      await db.batch([
        db.prepare("INSERT INTO organizations VALUES(?,?)").bind(`org-${index}`, `space-${index}`),
        db.prepare("INSERT INTO spaces VALUES(?,?)").bind(`space-${index}`, `org-${index}`),
      ]);
    }
    for (let index = 0; index < 80; index++)
      await db.prepare("INSERT INTO spaces VALUES(?,'org-0')").bind(`extra-${index}`).run();
    await fenceBusinessDatabase(db, context, "authority");
    const archive = await checkpoint(db);
    const migration = migrationDatabase(db, context, "restore", guard, "authority");
    await migration.prepare("ALTER TABLE spaces ADD COLUMN changed TEXT").run();
    expect((await restore(migration, archive.read, null, true)).digest).toBe(archive.digest);
    expect(await db.prepare("SELECT count(*) AS n FROM organizations").first()).toEqual({ n: 40 });
    expect(await db.prepare("SELECT count(*) AS n FROM spaces").first()).toEqual({ n: 120 });
    expect(await db.prepare("SELECT * FROM pragma_foreign_key_check").all()).toMatchObject({
      results: [],
    });
  });

  test("splits a long acyclic row dependency path inside a self-referencing table", async () => {
    const db = database(
      "CREATE TABLE chain(id INTEGER PRIMARY KEY,next INTEGER REFERENCES chain(id) DEFERRABLE INITIALLY DEFERRED);",
    );
    await db.batch(
      Array.from({ length: 70 }, (_, index) =>
        db.prepare("INSERT INTO chain VALUES(?,?)").bind(index, index === 69 ? null : index + 1),
      ),
    );
    await fenceBusinessDatabase(db, context, "authority");
    const archive = await checkpoint(db);
    const migration = migrationDatabase(db, context, "restore", guard, "authority");
    await migration.prepare("ALTER TABLE chain ADD COLUMN changed TEXT").run();
    expect((await restore(migration, archive.read, null, true)).digest).toBe(archive.digest);
    expect(await db.prepare("SELECT count(*) AS n FROM chain").first()).toEqual({ n: 70 });
  });

  test("oversized insertion cycles fail before committing any partial cyclic group", async () => {
    const db = database(
      "CREATE TABLE ring(id INTEGER PRIMARY KEY,next INTEGER NOT NULL REFERENCES ring(id) DEFERRABLE INITIALLY DEFERRED);",
    );
    await db.batch(
      Array.from({ length: 33 }, (_, index) =>
        db.prepare("INSERT INTO ring VALUES(?,?)").bind(index, (index + 1) % 33),
      ),
    );
    await fenceBusinessDatabase(db, context, "authority");
    const archive = await checkpoint(db);
    const migration = migrationDatabase(db, context, "restore", guard, "authority");
    await migration.prepare("DELETE FROM ring").run();
    await expect(restore(migration, archive.read)).rejects.toThrow(
      "space_checkpoint_indivisible_foreign_key_group_too_large",
    );
    expect(await db.prepare("SELECT count(*) AS n FROM ring").first()).toEqual({ n: 0 });
    expect(await db.prepare("SELECT bypass,fenced FROM _space_cutover_fence").first()).toEqual({
      bypass: 0,
      fenced: 1,
    });
    expect((await archive.read(null)).digest).toBe(archive.pages[0]!.digest);
  });

  test("rejects an oversized indivisible row cycle while retaining its immutable archive and closed fence", async () => {
    const db = database(
      "CREATE TABLE ring(id INTEGER PRIMARY KEY,next INTEGER NOT NULL REFERENCES ring(id) DEFERRABLE INITIALLY DEFERRED);",
    );
    await db.batch(
      Array.from({ length: 33 }, (_, index) =>
        db.prepare("INSERT INTO ring VALUES(?,?)").bind(index, (index + 1) % 33),
      ),
    );
    await fenceBusinessDatabase(db, context, "authority");
    const archive = await checkpoint(db);
    const migration = migrationDatabase(db, context, "restore", guard, "authority");
    await expect(restore(migration, archive.read)).rejects.toThrow(
      "space_checkpoint_indivisible_foreign_key_group_too_large",
    );
    expect(await db.prepare("SELECT count(*) AS n FROM ring").first()).toEqual({ n: 33 });
    expect(await db.prepare("SELECT bypass,fenced FROM _space_cutover_fence").first()).toEqual({
      bypass: 0,
      fenced: 1,
    });
    expect((await checkpoint(db)).digest).toBe(archive.digest);
  });
});
