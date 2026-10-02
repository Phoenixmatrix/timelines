import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { FakeD1, FakeQueue, FakeR2Bucket } from "@gitmatrix/testing";
import { describe, expect, it } from "vite-plus/test";
import { sql } from "kysely";
import { FRAME_SIZE } from "@gitmatrix/formats/artifact-storage";
import { Services } from "./context.ts";
import { SYSTEM_ACTOR } from "./auth/system.ts";
import { storeBlob } from "./blobs.ts";
import { compactBlob, sweepCompactions, chooseFullSnapshot } from "./blob-compaction.ts";
import { loadBlobManifest, readBlobRange } from "./blob-storage.ts";
import { collectGarbage, GC_GRACE_MS } from "../jobs/gc.ts";
import type { Job } from "../jobs/index.ts";

interface Fixture {
  db: FakeD1;
  bucket: FakeR2Bucket;
  queue: FakeQueue<Job>;
  services: Services;
  migration: string;
}

function fixture(migrate = true) {
  const db = new FakeD1();
  db.applySql(
    readFileSync(
      fileURLToPath(new URL("../migrations/0001_init.sql", import.meta.url).href),
      "utf8",
    ),
  );
  const migration = readFileSync(
    fileURLToPath(new URL("../migrations/0004_artifact_storage.sql", import.meta.url).href),
    "utf8",
  );
  if (migrate) db.applySql(migration);
  db.applySql(`INSERT INTO repositories(id,key,format,owner_id,kind,visibility,created_at,updated_at)
    VALUES('repo','test','generic','owner','local','private','2020-01-01','2020-01-01')`);
  const bucket = new FakeR2Bucket();
  const queue = new FakeQueue<Job>();
  const env = { REGISTRY_DB: db, REGISTRY_BLOBS: bucket, REGISTRY_JOBS: queue } as unknown as Env;
  const services = new Services(
    env,
    new Request("https://test/"),
    () => undefined,
    "test",
    SYSTEM_ACTOR,
  );
  return { db, bucket, queue, services, migration };
}

function bytes(version: number, seed = 123456) {
  const data = new Uint8Array(128 * 1024);
  let state = seed;
  for (let i = 0; i < data.length / 2; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[i] = state & 255;
  }
  data.set(data.subarray(0, data.length / 2), data.length / 2);
  data[100] = version;
  return data;
}

async function publish(f: Fixture, version: number, data = bytes(version), artifact = "build") {
  const blob = await storeBlob(f.services.db, f.services.bucket, data);
  await f.services.db
    .insertInto("files")
    .values({
      id: `${artifact === "build" ? "file" : artifact}-${version}`,
      repo_id: "repo",
      path: `${artifact}/${version}/linux/app`,
      version_id: null,
      digest: blob.digest,
      size: blob.size,
      created_by: null,
      created_at: new Date(Date.UTC(2020, 0, version + 1)).toISOString(),
    })
    .onConflict((oc) => oc.column("id").doUpdateSet({ digest: blob.digest }))
    .execute();
  return blob;
}

async function drain(f: Fixture) {
  await sweepCompactions(f.services);
  for (let deliveries = 0; ; deliveries++) {
    if (deliveries > 1000) throw new Error("Compaction did not converge");
    if (!f.queue.messages.length) {
      // Simulate the later cron delivery after the physical cleanup grace.
      const waiting = await f.services.db
        .selectFrom("blob_compactions")
        .select("id")
        .where("phase", "=", "cleanup")
        .execute();
      if (!waiting.length) break;
      await f.services.db
        .updateTable("blob_compactions")
        .set({ lease_until: 0 })
        .where("phase", "=", "cleanup")
        .execute();
      for (const work of waiting) f.queue.messages.push({ type: "compact", id: work.id });
    }
    const job = f.queue.messages.shift()!;
    if (job.type === "compact-sweep") await sweepCompactions(f.services);
    if (job.type === "compact") await compactBlob(f.services, job.id);
  }
}

describe("artifact compaction", () => {
  it("only heats repeated historical content through a live recent publication", async () => {
    const f = fixture();
    const shared = await storeBlob(f.services.db, f.services.bucket, bytes(0));
    f.db.applySql(`WITH RECURSIVE versions(n) AS (
      SELECT 0 UNION ALL SELECT n+1 FROM versions WHERE n<999
    ) INSERT INTO files(id,repo_id,path,digest,size,created_at)
      SELECT 'history-' || n,'repo','build/' || n || '/linux/app',
        '${shared.digest}',${shared.size},'2020-01-01' FROM versions`);
    await publish(f, 1000, bytes(1));
    await publish(f, 1001, bytes(2));
    const hot = async () =>
      (
        await sql<{ digest: string }>`
      SELECT digest FROM artifact_hot_digests WHERE digest=${shared.digest}
    `.execute(f.services.db)
      ).rows;
    expect(await hot()).toEqual([]);

    // A different artifact can keep a globally deduplicated digest hot.
    await publish(f, 0, bytes(0), "other");
    expect(await hot()).toEqual([{ digest: shared.digest }]);
    await f.services.db.deleteFrom("files").where("id", "=", "other-0").execute();
    expect(await hot()).toEqual([]);

    await publish(f, 1002, bytes(0));
    expect(await hot()).toEqual([{ digest: shared.digest }]);
    await f.services.db.deleteFrom("files").where("id", "=", "file-1002").execute();
    expect(await hot()).toEqual([]);
  });

  it("recompacts an identical cold re-upload without recording another version update", async () => {
    const f = fixture();
    const first = await publish(f, 0);
    await publish(f, 1);
    await publish(f, 2);
    await drain(f);
    const before = await f.services.db.selectFrom("artifact_publications").select("id").execute();
    const uploaded = await publish(f, 0);
    expect(uploaded.r2Key).toMatch(/^b\//);
    await drain(f);
    expect(await f.services.db.selectFrom("artifact_publications").select("id").execute()).toEqual(
      before,
    );
    const stored = await f.services.db
      .selectFrom("blobs")
      .select("r2_key")
      .where("digest", "=", first.digest)
      .executeTakeFirstOrThrow();
    expect(stored.r2_key).toMatch(/^c\//);
    expect(await readBlobRange(f.services.bucket, stored.r2_key, 98, 5)).toEqual(
      bytes(0).slice(98, 103),
    );
  });

  it("compacts unrelated artifacts while identical historical digests await cleanup", async () => {
    const f = fixture();
    const same = bytes(0);
    for (let i = 0; i < 20; i++) {
      await publish(f, 0, same, `duplicate-${i}`);
      await publish(f, 1, bytes(1, i + 1), `duplicate-${i}`);
      await publish(f, 2, bytes(2, i + 1), `duplicate-${i}`);
    }
    const independent = await publish(f, 10, bytes(10, 987), "independent");
    await publish(f, 11, bytes(11, 987), "independent");
    await publish(f, 12, bytes(12, 987), "independent");
    for (let i = 0; i < 4; i++) await sweepCompactions(f.services);
    const shared = await f.services.db
      .selectFrom("blob_compactions")
      .select("id")
      .where("digest", "=", `sha256:${createHash("sha256").update(same).digest("hex")}`)
      .executeTakeFirstOrThrow();
    await compactBlob(f.services, shared.id);
    await sweepCompactions(f.services);
    const next = await f.services.db
      .selectFrom("blob_compactions")
      .select("id")
      .where("digest", "=", independent.digest)
      .executeTakeFirstOrThrow();
    await compactBlob(f.services, next.id);
    const stored = await f.services.db
      .selectFrom("blobs")
      .select("r2_key")
      .where("digest", "=", independent.digest)
      .executeTakeFirstOrThrow();
    expect(stored.r2_key).toMatch(/^c\//);
    expect(await readBlobRange(f.services.bucket, stored.r2_key, 98, 5)).toEqual(
      bytes(10, 987).slice(98, 103),
    );
  });

  it("records release attachment changes, not identical replay, and separates asset lineages", async () => {
    const f = fixture();
    const first = await storeBlob(f.services.db, f.services.bucket, bytes(1));
    const second = await storeBlob(f.services.db, f.services.bucket, bytes(2));
    await f.services.db
      .insertInto("releases")
      .values({
        id: "release",
        repo_id: "repo",
        project: "app",
        tag: "v1",
        created_by: null,
        created_at: "2020-01-01",
        published_at: null,
      })
      .execute();
    await f.services.db
      .insertInto("release_assets")
      .values({
        release_id: "release",
        name: "linux.zip",
        digest: first.digest,
        size: first.size,
        content_type: "application/zip",
        created_by: null,
        created_at: "2020-01-01",
      })
      .execute();
    await f.services.db
      .updateTable("release_assets")
      .set({ digest: first.digest })
      .where("release_id", "=", "release")
      .execute();
    let publications = await f.services.db
      .selectFrom("artifact_publications")
      .select(["lineage", "digest"])
      .orderBy("id")
      .execute();
    expect(publications).toEqual([{ lineage: "release:app/linux.zip", digest: first.digest }]);
    // Even two different overwrites in the same timestamp are real events.
    await f.services.db
      .updateTable("release_assets")
      .set({ digest: second.digest })
      .where("release_id", "=", "release")
      .execute();
    await f.services.db
      .updateTable("release_assets")
      .set({ digest: first.digest })
      .where("release_id", "=", "release")
      .execute();
    await f.services.db
      .insertInto("release_assets")
      .values({
        release_id: "release",
        name: "windows.zip",
        digest: second.digest,
        size: second.size,
        content_type: "application/zip",
        created_by: null,
        created_at: "2020-01-01",
      })
      .execute();
    publications = await f.services.db
      .selectFrom("artifact_publications")
      .select(["lineage", "digest"])
      .orderBy("id")
      .execute();
    expect(publications).toEqual([
      { lineage: "release:app/linux.zip", digest: first.digest },
      { lineage: "release:app/linux.zip", digest: second.digest },
      { lineage: "release:app/linux.zip", digest: first.digest },
      { lineage: "release:app/windows.zip", digest: second.digest },
    ]);
    await f.services.db
      .deleteFrom("release_assets")
      .where("release_id", "=", "release")
      .where("name", "=", "linux.zip")
      .execute();
    const live = await sql<{
      lineage: string;
    }>`SELECT lineage FROM artifact_live_publications`.execute(f.services.db);
    expect(live.rows).toEqual([{ lineage: "release:app/windows.zip" }]);
  });

  it("checkpoints a large source after two frames and resumes without exposing partial bytes", async () => {
    const f = fixture();
    const data = new Uint8Array(FRAME_SIZE * 2 + 17);
    data[data.length - 1] = 73;
    const original = await publish(f, 0, data);
    await publish(f, 1);
    await publish(f, 2);
    for (let i = 0; i < 4; i++) await sweepCompactions(f.services);
    const work = await f.services.db
      .selectFrom("blob_compactions")
      .selectAll()
      .executeTakeFirstOrThrow();
    await compactBlob(f.services, work.id);
    const checkpoint = await f.services.db
      .selectFrom("blob_compactions")
      .selectAll()
      .where("id", "=", work.id)
      .executeTakeFirstOrThrow();
    expect(checkpoint.frame).toBe(2);
    expect(
      (
        await f.services.db
          .selectFrom("blobs")
          .select("r2_key")
          .where("digest", "=", original.digest)
          .executeTakeFirstOrThrow()
      ).r2_key,
    ).toBe(original.r2Key);
    await drain(f);
    const current = await f.services.db
      .selectFrom("blobs")
      .select("r2_key")
      .where("digest", "=", original.digest)
      .executeTakeFirstOrThrow();
    expect(
      (await loadBlobManifest(f.services.bucket, current.r2_key)).frames.map((frame) => frame.size),
    ).toEqual([FRAME_SIZE, FRAME_SIZE, 17]);
    expect(await readBlobRange(f.services.bucket, current.r2_key, FRAME_SIZE * 2 + 15, 2)).toEqual(
      new Uint8Array([0, 73]),
    );
    await compactBlob(f.services, work.id);
    expect(
      (
        await f.services.db
          .selectFrom("blobs")
          .select("r2_key")
          .where("digest", "=", original.digest)
          .executeTakeFirstOrThrow()
      ).r2_key,
    ).toBe(current.r2_key);
  });

  it("keeps two updates hot, references one full snapshot, and rotates at update 32", async () => {
    const f = fixture();
    const blobs = [];
    for (let version = 0; version < 35; version++) blobs.push(await publish(f, version));
    await drain(f);
    const first = await f.services.db
      .selectFrom("blobs")
      .select("r2_key")
      .where("digest", "=", blobs[0]!.digest)
      .executeTakeFirstOrThrow();
    expect((await loadBlobManifest(f.services.bucket, first.r2_key)).base).toBeNull();
    for (const version of [1, 15, 31]) {
      const row = await f.services.db
        .selectFrom("blobs")
        .select("r2_key")
        .where("digest", "=", blobs[version]!.digest)
        .executeTakeFirstOrThrow();
      expect((await loadBlobManifest(f.services.bucket, row.r2_key)).base).toBe(first.r2_key);
      const restored = await readBlobRange(f.services.bucket, row.r2_key, 0, bytes(version).length);
      expect(createHash("sha256").update(restored).digest("hex")).toBe(
        blobs[version]!.digest.slice(7),
      );
    }
    const rotated = await f.services.db
      .selectFrom("blobs")
      .select("r2_key")
      .where("digest", "=", blobs[32]!.digest)
      .executeTakeFirstOrThrow();
    expect((await loadBlobManifest(f.services.bucket, rotated.r2_key)).base).toBeNull();
    for (const version of [33, 34]) {
      const row = await f.services.db
        .selectFrom("blobs")
        .select("r2_key")
        .where("digest", "=", blobs[version]!.digest)
        .executeTakeFirstOrThrow();
      expect(row.r2_key).toBe(blobs[version]!.r2Key);
    }
  });

  it("takes an early full snapshot for unrelated bytes and keeps incompressible frames raw", async () => {
    const f = fixture();
    await publish(f, 0);
    const changed = await publish(f, 1, bytes(1, 987654));
    const noise = bytes(2).subarray(0, 64 * 1024);
    const raw = await publish(f, 2, noise);
    await publish(f, 3);
    await publish(f, 4);
    await drain(f);
    const current = await f.services.db
      .selectFrom("blobs")
      .select("r2_key")
      .where("digest", "=", changed.digest)
      .executeTakeFirstOrThrow();
    expect((await loadBlobManifest(f.services.bucket, current.r2_key)).base).toBeNull();
    const untouched = await f.services.db
      .selectFrom("blobs")
      .select("r2_key")
      .where("digest", "=", raw.digest)
      .executeTakeFirstOrThrow();
    expect((await loadBlobManifest(f.services.bucket, untouched.r2_key)).frames[0]!.codec).toBe(
      "raw",
    );
    expect(chooseFullSnapshot(100, 50, true)).toBe(false);
    expect(chooseFullSnapshot(100, 51, true)).toBe(true);
  });

  it("pins deleted anchors until their dependent history is gone, then reclaims them", async () => {
    const f = fixture();
    const base = await publish(f, 0);
    const dependent = await publish(f, 1);
    await publish(f, 2);
    await publish(f, 3);
    await drain(f);
    const anchor = await f.services.db
      .selectFrom("blobs")
      .select("r2_key")
      .where("digest", "=", base.digest)
      .executeTakeFirstOrThrow();
    await f.services.db.deleteFrom("files").where("id", "=", "file-0").execute();
    await collectGarbage(f.services, Date.now() + 2 * GC_GRACE_MS);
    await collectGarbage(f.services, Date.now() + 4 * GC_GRACE_MS);
    expect(f.bucket.bytes(anchor.r2_key)).toBeDefined();
    const locator = await f.services.db
      .selectFrom("blobs")
      .select("r2_key")
      .where("digest", "=", dependent.digest)
      .executeTakeFirstOrThrow();
    expect(await readBlobRange(f.services.bucket, locator.r2_key, 98, 5)).toEqual(
      bytes(1).slice(98, 103),
    );
    await f.services.db.deleteFrom("files").where("id", "=", "file-1").execute();
    await collectGarbage(f.services, Date.now() + 6 * GC_GRACE_MS);
    await collectGarbage(f.services, Date.now() + 8 * GC_GRACE_MS);
    await collectGarbage(f.services, Date.now() + 10 * GC_GRACE_MS);
    expect(f.bucket.bytes(anchor.r2_key)).toBeUndefined();
  });

  it("backfills old attachments without replay duplicates and recovers expired work leases", async () => {
    const f = fixture(false);
    const original = await publish(f, 0);
    await publish(f, 1);
    await publish(f, 2);
    f.db.applySql(f.migration);
    for (let i = 0; i < 4; i++) await sweepCompactions(f.services);
    const work = await f.services.db
      .selectFrom("blob_compactions")
      .selectAll()
      .executeTakeFirstOrThrow();
    await sql`UPDATE blob_compactions SET fence='lost-worker',lease_until=${Date.now() + 60_000} WHERE id=${work.id}`.execute(
      f.services.db,
    );
    await compactBlob(f.services, work.id);
    expect(
      (
        await f.services.db
          .selectFrom("blobs")
          .select("r2_key")
          .where("digest", "=", original.digest)
          .executeTakeFirstOrThrow()
      ).r2_key,
    ).toBe(original.r2Key);
    await sql`UPDATE blob_compactions SET lease_until=0 WHERE id=${work.id}`.execute(f.services.db);
    await drain(f);
    await compactBlob(f.services, work.id);
    const rows = await f.services.db
      .selectFrom("artifact_publications")
      .select(["version", "status"])
      .orderBy("id")
      .execute();
    expect(rows).toEqual([
      { version: "0", status: "done" },
      { version: "1", status: "pending" },
      { version: "2", status: "pending" },
    ]);
    expect(
      (
        await f.services.db
          .selectFrom("blobs")
          .select("r2_key")
          .where("digest", "=", original.digest)
          .executeTakeFirstOrThrow()
      ).r2_key,
    ).toMatch(/^c\//);
  });
});
