import { describe, expect, test } from "vite-plus/test";
import { FakeD1 } from "@gitmatrix/testing";
import { fenceBusinessDatabase, migrationDatabase } from "./storage-fence.ts";
import type { SpaceMigrationContext } from "../../shared/space-cutover.ts";

const context: SpaceMigrationContext = {
  runId: "run",
  migrationEpoch: 1,
  manifestDigest: "digest",
  legacyOwnerId: "owner",
  spaceId: "owner",
  organizationId: "organization",
  spaceSlug: "owner",
  contractVersion: 4,
};
function fixture() {
  const fake = new FakeD1();
  fake.applySql(
    `CREATE TABLE _space_cutover_fence(id INTEGER PRIMARY KEY,run_id TEXT,migration_epoch INTEGER,manifest_digest TEXT,authority_token TEXT NOT NULL DEFAULT '',fenced INTEGER NOT NULL DEFAULT 0,bypass INTEGER NOT NULL DEFAULT 0); INSERT INTO _space_cutover_fence(id) VALUES(1); CREATE TABLE business(id TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO business VALUES('stable','original');`,
  );
  return fake as unknown as D1Database;
}
describe("storage-side legacy execution fence", () => {
  test("blocks delayed old writes while permitting only an atomic authorized migration batch", async () => {
    const db = fixture();
    const previouslyPrepared = db.prepare(
      "UPDATE business SET value='late-old-worker' WHERE id='stable'",
    );
    await fenceBusinessDatabase(db, context, "migration");
    await expect(previouslyPrepared.run()).rejects.toThrow("space_cutover_fenced");
    const migration = migrationDatabase(
      db,
      context,
      "migrate",
      async (candidate) => {
        expect(candidate).toEqual(context);
      },
      "migration",
    );
    await migration.batch([
      migration.prepare("UPDATE business SET value='converted' WHERE id='stable'"),
    ]);
    expect(await db.prepare("SELECT value FROM business").first()).toEqual({ value: "converted" });
    expect(await db.prepare("SELECT bypass,fenced FROM _space_cutover_fence").first()).toEqual({
      bypass: 0,
      fenced: 1,
    });
    await expect(previouslyPrepared.run()).rejects.toThrow("space_cutover_fenced");
    await expect(db.prepare("DELETE FROM business").run()).rejects.toThrow("space_cutover_fenced");
  });
  test("a failing transactional step cannot leak bypass or partial business changes", async () => {
    const db = fixture();
    await fenceBusinessDatabase(db, context, "migration");
    const migration = migrationDatabase(db, context, "migrate", async () => {}, "migration");
    await expect(
      migration.batch([
        migration.prepare("UPDATE business SET value='partial'"),
        migration.prepare("INSERT INTO business VALUES('stable','duplicate')"),
      ]),
    ).rejects.toThrow();
    expect(await db.prepare("SELECT value FROM business").first()).toEqual({ value: "original" });
    expect(await db.prepare("SELECT bypass FROM _space_cutover_fence").first()).toEqual({
      bypass: 0,
    });
    await expect(db.prepare("UPDATE business SET value='old'").run()).rejects.toThrow(
      "space_cutover_fenced",
    );
  });
  test("requires both independent authority and the matching persisted fence epoch", async () => {
    const db = fixture();
    await fenceBusinessDatabase(db, context, "migration");
    const stale = migrationDatabase(
      db,
      { ...context, migrationEpoch: 2 },
      "restore",
      async () => {},
      "migration",
    );
    await expect(stale.prepare("DELETE FROM business").run()).rejects.toThrow(
      "fence is not closed",
    );
    const revoked = migrationDatabase(
      db,
      context,
      "restore",
      async () => {
        throw new Error("forward-only");
      },
      "migration",
    );
    await expect(revoked.prepare("DELETE FROM business").run()).rejects.toThrow("forward-only");
    expect(await db.prepare("SELECT count(*) AS n FROM business").first()).toEqual({ n: 1 });
  });
  test("rotated recovery authority rejects a delayed previously-authorized migration transaction", async () => {
    const db = fixture();
    await fenceBusinessDatabase(db, context, "old-migration");
    const old = migrationDatabase(db, context, "migrate", async () => {}, "old-migration");
    const delayed = old.prepare("UPDATE business SET value='late-migration'");
    await fenceBusinessDatabase(db, context, "recovery", "old-migration");
    await expect(delayed.run()).rejects.toThrow();
    const restore = migrationDatabase(db, context, "restore", async () => {}, "recovery");
    await restore.prepare("UPDATE business SET value='restored'").run();
    await expect(delayed.run()).rejects.toThrow();
    expect(await db.prepare("SELECT value FROM business").first()).toEqual({ value: "restored" });
    expect(
      await db.prepare("SELECT bypass,authority_token FROM _space_cutover_fence").first(),
    ).toEqual({ bypass: 0, authority_token: "recovery" });
  });
});
