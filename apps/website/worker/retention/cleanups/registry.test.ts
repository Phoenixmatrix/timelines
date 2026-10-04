// The registry's site categories through the engine (CORE-205), over the
// registry harness (its D1 schema, R2 bucket and real request handling): an
// npm proxy feed caches a packument and a tarball, a local feed publishes a
// version; a run 31 days later drops the unused cache entries (dry run =
// run), a second one their orphaned derived objects, garbage collection
// their blobs; R2 then holds nothing without a row, and both packages still
// install (the proxy one from upstream again). The audit category removes
// old audit entries and superseded or deleted publish records only.

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { SYSTEM_ACTOR } from "../../../registry/core/auth/system.ts";
import { Services } from "../../../registry/core/context.ts";
import { createDb } from "../../../registry/core/db.ts";
import { invalidateMembers } from "../../../registry/core/virtual.ts";
import { makeTarball, publishBody } from "../../../registry/formats/npm/testing.ts";
import { collectGarbage, GC_GRACE_MS } from "../../../registry/jobs/gc.ts";
import { makeHarness, type Harness } from "../../../registry/testing/harness.ts";
import { advanceRun, createRun, getRun } from "../runs.ts";

const SITE = { scope: "site" } as const;
const DAY = 86_400_000;
const UPSTREAM = "https://registry.npmjs.org";
const leftPad = makeTarball("left-pad", "1.3.0");

let h: Harness;
let admin: string;
let hits: string[];

beforeEach(async () => {
  invalidateMembers();
  hits = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    hits.push(url.pathname);
    if (url.pathname === "/left-pad")
      return Response.json({
        _id: "left-pad",
        name: "left-pad",
        "dist-tags": { latest: "1.3.0" },
        versions: {
          "1.3.0": {
            name: "left-pad",
            version: "1.3.0",
            dist: { tarball: `${UPSTREAM}/left-pad/-/left-pad-1.3.0.tgz` },
          },
        },
      });
    if (url.pathname === "/left-pad/-/left-pad-1.3.0.tgz") return new Response(leftPad);
    return new Response("{}", { status: 404 });
  });
  h = await makeHarness();
  admin = await h.adminToken();
  await h.createRepo({ key: "js-local", format: "npm", kind: "local", visibility: "public" });
  await h.createRepo({
    key: "npmjs",
    format: "npm",
    kind: "remote",
    visibility: "public",
    config: { upstream: UPSTREAM },
  });
});

afterEach(() => vi.unstubAllGlobals());

async function install(path: string) {
  const res = await h.request(path);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

async function run(category: string, dryRun: boolean, now: Date, days: number) {
  const id = await createRun(h.env.DB, {
    target: SITE,
    trigger: "manual",
    actorId: null,
    dryRun,
    categories: [{ id: category, thresholds: { days } }],
    now,
  });
  const seen: string[] = [];
  let state;
  do
    state = await advanceRun(h.env, id, {
      now,
      limit: 2,
      afterBatch: async (_category, items) => void seen.push(...(items as string[])),
    });
  while (state === "more");
  return { seen, run: (await getRun(h.env.DB, SITE, id))! };
}

const rows = async (sql: string) =>
  (await h.db.prepare(sql).all<Record<string, unknown>>()).results;

describe("registry proxy cache and derived objects", () => {
  it("drops unused entries, then orphaned objects; GC reclaims blobs; everything installs", async () => {
    // A local version and the proxy's packument and tarball, all served once.
    const published = await h.request("/npm/js-local/@test/kept", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: publishBody("@test/kept", "1.0.0"),
    });
    expect(published.status).toBe(201);
    const localTarball = await install("/npm/js-local/@test/kept/-/kept-1.0.0.tgz");
    await install("/npm/npmjs/left-pad");
    expect(await install("/npm/npmjs/left-pad/-/left-pad-1.3.0.tgz")).toEqual(leftPad);
    const entries = (await rows("SELECT path FROM remote_entries ORDER BY path")).map(
      (r) => r.path,
    );
    expect(entries).toContain("artifact/left-pad/-/left-pad-1.3.0.tgz");
    expect(entries.some((path) => String(path).startsWith("upstream/"))).toBe(true);
    // The cached packuments' bodies, which become orphans once their entries go.
    const bodies = new Set(
      (await rows("SELECT r2_key FROM derived_files WHERE path LIKE 'upstream/%'")).map(
        (r) => r.r2_key as string,
      ),
    );
    // A derived object no row refers to any more (a replaced generation).
    await h.bucket.put("d/orphan-repo/0000", "stale index");
    const derivedBefore = (await h.bucket.list({ prefix: "d/" })).objects.length;

    // Not yet unused for 30 days: nothing.
    expect((await run("registry-proxy-cache", true, new Date(), 30)).seen).toEqual([]);

    const later = new Date(Date.now() + 31 * DAY);
    const dry = await run("registry-proxy-cache", true, later, 30);
    expect(dry.seen.filter((item) => item.startsWith("e:"))).toHaveLength(entries.length);
    expect(dry.seen.filter((item) => item.startsWith("d:"))).toEqual(["d:d/orphan-repo/0000"]);
    const real = await run("registry-proxy-cache", false, later, 30);
    expect(real.seen).toEqual(dry.seen);
    expect(real.run).toMatchObject({
      status: "succeeded",
      items: dry.run.items,
      bytes: dry.run.bytes,
    });
    expect(await rows("SELECT path FROM remote_entries")).toEqual([]);
    expect(await rows("SELECT path FROM derived_files WHERE path LIKE 'upstream/%'")).toEqual([]);

    // The next run takes the cached packument's body, now without a row.
    const second = await run("registry-proxy-cache", false, later, 30);
    expect(second.run).toMatchObject({ status: "succeeded", items: bodies.size });
    expect((await run("registry-proxy-cache", false, later, 30)).run).toMatchObject({ items: 0 });
    const derived = (await h.bucket.list({ prefix: "d/" })).objects.map((o) => o.key);
    expect(derived).toHaveLength(derivedBefore - 1 - bodies.size);
    const referenced = new Set(
      (await rows("SELECT r2_key FROM derived_files")).map((r) => r.r2_key as string),
    );
    for (const key of derived) expect(referenced.has(key), key).toBe(true);

    // Garbage collection, after its grace period, reclaims the tarball's blob only.
    const services = new Services(
      h.env,
      new Request("https://pkg.test/"),
      () => undefined,
      "test",
      SYSTEM_ACTOR,
    );
    const blobs = createDb(h.env.REGISTRY_DB);
    const before = await blobs.selectFrom("blobs").select("digest").execute();
    await collectGarbage(services, later.getTime() + 2 * GC_GRACE_MS);
    const after = await blobs.selectFrom("blobs").select("digest").execute();
    expect(after).toHaveLength(before.length - 1);
    for (const object of (await h.bucket.list()).objects) {
      if (object.key.startsWith("d/")) continue;
      const owned = await rows(
        `SELECT key FROM blob_representations WHERE key = '${object.key.replaceAll("'", "''")}'`,
      );
      expect(owned, object.key).toHaveLength(1);
    }

    // Every version still installs; the proxy fetches from upstream again.
    expect(await install("/npm/js-local/@test/kept/-/kept-1.0.0.tgz")).toEqual(localTarball);
    const fetched = hits.length;
    await install("/npm/npmjs/left-pad");
    expect(await install("/npm/npmjs/left-pad/-/left-pad-1.3.0.tgz")).toEqual(leftPad);
    expect(hits.length).toBeGreaterThan(fetched);
    expect(hits.slice(fetched)).toContain("/left-pad/-/left-pad-1.3.0.tgz");
  });

  it("keeps entries served within the period, and new derived objects", async () => {
    await install("/npm/npmjs/left-pad");
    // Served again 20 days on: its last use moves, so 31 days on it's 11 days old.
    await h.db
      .prepare("UPDATE remote_entries SET expires_at = '9999-01-01T00:00:00.000Z', used_at = ?")
      .bind(new Date(Date.now() - 2 * DAY).toISOString())
      .run();
    vi.setSystemTime(Date.now() + 20 * DAY);
    try {
      await install("/npm/npmjs/left-pad");
    } finally {
      vi.useRealTimers();
    }
    const used = (await rows("SELECT used_at FROM remote_entries"))[0]!.used_at as string;
    expect(Date.parse(used)).toBeGreaterThan(Date.now() + 19 * DAY);
    const dry = await run("registry-proxy-cache", true, new Date(Date.now() + 31 * DAY), 30);
    expect(dry.seen).toEqual([]);
    // A fresh orphan inside the grace period stays.
    await h.bucket.put("d/orphan-repo/1111", "just written");
    expect((await run("registry-proxy-cache", true, new Date(), 0)).seen).not.toContain(
      "d:d/orphan-repo/1111",
    );
  });
});

describe("registry audit log and publish records", () => {
  it("removes old audit entries and records history alone needs", async () => {
    const old = "2024-01-01T00:00:00.000Z";
    const older = "2023-06-01T00:00:00.000Z";
    const recent = new Date().toISOString();
    h.db.applySql(`
      INSERT INTO repositories (id, owner_id, key, format, kind, visibility, config, created_at, updated_at)
        SELECT 'feed', owner_id, 'audit-feed', 'generic', 'local', 'private', '{}', '${old}', '${old}'
        FROM repositories LIMIT 1;
      INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at)
        VALUES ('pkg', 'feed', 'app', 'app', '${old}', '${old}');
      INSERT INTO audit_log (id, at, actor, action, repo_id) VALUES
        ('old-1', '${old}', 'user:a', 'publish', 'feed'),
        ('old-2', '${older}', 'user:a', 'feed.update', 'feed'),
        ('new-1', '${recent}', 'user:a', 'publish', 'feed');
      INSERT INTO publishes (id, feed_id, format, package_id, version, action, status, actor, actor_label, via, at, off_default_branch) VALUES
        ('p-1-old', 'feed', 'generic', 'pkg', '1.0.0', 'publish', 'active', 'user:a', 'a', 'token', '${older}', 0),
        ('p-1-new', 'feed', 'generic', 'pkg', '1.0.0', 'publish', 'active', 'user:a', 'a', 'token', '${old}', 0),
        ('p-2', 'feed', 'generic', 'pkg', '2.0.0', 'publish', 'active', 'user:a', 'a', 'token', '${old}', 0),
        ('p-3', 'feed', 'generic', 'pkg', '3.0.0', 'publish', 'deleted', 'user:a', 'a', 'token', '${old}', 0),
        ('p-4-branch', 'feed', 'generic', 'pkg', '4.0.0', 'publish', 'active', 'job:j', 'ci', 'job', '${older}', 1),
        ('p-4', 'feed', 'generic', 'pkg', '4.0.0', 'publish', 'active', 'job:j', 'ci', 'job', '${old}', 0),
        ('p-5-old', 'feed', 'generic', 'pkg', '5.0.0', 'publish', 'active', 'user:a', 'a', 'token', '${older}', 0),
        ('p-5-new', 'feed', 'generic', 'pkg', '5.0.0', 'publish', 'active', 'user:a', 'a', 'token', '${recent}', 0);
    `);
    const now = new Date();
    const dry = await run("registry-audit", true, now, 365);
    const real = await run("registry-audit", false, now, 365);
    expect(real.seen).toEqual(dry.seen);
    expect(real.run).toMatchObject({ status: "succeeded", items: 5, bytes: dry.run.bytes });
    expect((await rows("SELECT id FROM audit_log ORDER BY id")).map((r) => r.id)).toEqual([
      "new-1",
    ]);
    expect((await rows("SELECT id FROM publishes ORDER BY id")).map((r) => r.id)).toEqual([
      "p-1-new",
      "p-2",
      "p-4",
      "p-4-branch",
      "p-5-new",
    ]);
    expect((await run("registry-audit", false, now, 365)).run).toMatchObject({ items: 0 });
  });
});
