// Usage metering (CORE-207): measured figures match seeded stores of known
// sizes, estimates say so, collection is bounded and resumable, and every
// D1 table is in a group.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { FakeR2Bucket } from "@gitmatrix/testing";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { collectUsage, SITE, USAGE_LIMITS } from "./collect.ts";
import { TABLE_GROUPS } from "./tables.ts";

// Unreachable git data takes a fetch from Artifacts (worker/git/unreachable.test.ts).
vi.mock(import("../git/unreachable.ts"), async (original) => ({
  ...(await original()),
  measureUnreachable: async (_env: Env, repo: { id: string }) => ({
    commits: 1,
    objects: 3,
    bytes: repo.id === "repo_1" ? 100 : 250,
    truncated: false,
  }),
}));

function migrated(dir: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const path = fileURLToPath(new URL(dir, import.meta.url).href);
  for (const file of readdirSync(path)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(path, file), "utf8"));
  return db;
}

const NOW = new Date("2026-10-05T03:17:00Z");
const TODAY = "2026-10-05";
const YESTERDAY = "2026-10-04";
const LOG_A = "x".repeat(1000);
const LOG_B = "é".repeat(500); // 1000 UTF-8 bytes, 500 characters

let main: DatabaseSync;
let registry: DatabaseSync;
let env: Env;
let avatars: FakeR2Bucket;

beforeEach(async () => {
  main = migratedDatabase();
  registry = migrated("../../registry/migrations/");
  avatars = new FakeR2Bucket();
  env = {
    DB: d1(main),
    REGISTRY_DB: d1(registry),
    AVATARS: avatars,
  } as unknown as Env;
  main.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, avatar_key) VALUES
      ('acc_o', 'org', 'orbit', 'Orbit', 'avatars/acc_o/a.png'),
      ('acc_p', 'user', 'pat', 'Pat', NULL);
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote, pushed_bytes) VALUES
      ('repo_1', 'acc_o', 'engine', 'private', 'n1', 'https://x', 5000),
      ('repo_2', 'acc_o', 'site', 'public', 'n2', 'https://x', 7000),
      ('repo_p', 'acc_p', 'notes', 'private', 'n3', 'https://x', 0);
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES
      ('run_1', 'repo_1', 1, 'c', 'refs/heads/main', 'push', 'succeeded');
    -- Branches deleted in Orbit's two repositories, none in Pat's.
    INSERT INTO ref_updates (repo_id, ref, old_oid, new_oid) VALUES
      ('repo_1', 'refs/heads/gone', 'a1', NULL), ('repo_2', 'refs/heads/gone', 'b1', NULL),
      ('repo_p', 'refs/heads/main', NULL, 'c1');
    INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, started_at, finished_at) VALUES
      ('job_1', 'run_1', 'repo_1', 'a', '{}', 'succeeded', 'sandbox', '${YESTERDAY}T10:00:00.000Z', '${YESTERDAY}T10:30:00.000Z'),
      ('job_2', 'run_1', 'repo_1', 'b', '{}', 'succeeded', 'sandbox', '${YESTERDAY}T23:50:00.000Z', '${TODAY}T00:10:00.000Z'),
      ('job_3', 'run_1', 'repo_1', 'c', '{}', 'succeeded', 'local', '${YESTERDAY}T10:00:00.000Z', '${YESTERDAY}T11:00:00.000Z'),
      ('job_4', 'run_1', 'repo_1', 'd', '{"instance":"standard-4"}', 'succeeded', 'sandbox', '${YESTERDAY}T12:00:00.000Z', '${YESTERDAY}T12:10:00.000Z');
    INSERT INTO ci_logs (job_id, seq, step, text) VALUES
      ('job_1', 1, 0, '${LOG_A}'), ('job_1', 2, 0, '${LOG_B}'), ('job_2', 1, 0, '${LOG_A}'), ('job_3', 1, 0, 'tiny');
    INSERT INTO kg_nodes (repo_id, id, kind, name, summary, content_hash, changed_in) VALUES
      ('repo_1', 'file:a', 'file', 'a', 'A file.', 'h', 'c'),
      ('repo_1', 'sym:a#f', 'symbol', 'f', 'A function.', 'h', 'c'),
      ('repo_1', 'dir:src', 'directory', 'src', 'A directory.', 'h', 'c'),
      ('repo_2', 'file:b', 'file', 'b', '', 'h', 'c');
    INSERT INTO kg_search_items (repo_id, key, item_id, version, bytes) VALUES
      ('repo_1', 'file:a', 'i1', 'v', 3000), ('repo_1', 'file:b', 'i2', 'v', 1000),
      ('repo_2', 'page:x', 'i3', 'v', NULL);
    INSERT INTO do_instances (class, name, account_id, repo_id, storage_bytes, sized_at, purged_at) VALUES
      ('Tracker', 'acc_o', 'acc_o', NULL, 40960, '${TODAY}T00:00:00Z', NULL),
      ('KnowledgeCoordinator', 'repo_1', 'acc_o', 'repo_1', 8192, '${TODAY}T00:00:00Z', NULL),
      ('KnowledgeCoordinator', 'repo_2', 'acc_o', 'repo_2', NULL, NULL, NULL),
      ('KnowledgeCoordinator', 'repo_gone', 'acc_o', 'repo_gone', 0, '${TODAY}T00:00:00Z', '${TODAY}T00:00:00Z'),
      ('RegistryUpload', 'u1', NULL, NULL, NULL, NULL, NULL);
    INSERT INTO ai_usage (day, account_id, feature, model, calls, input_tokens, output_tokens, total_tokens) VALUES
      ('${YESTERDAY}', 'acc_o', 'knowledge', '@cf/m', 3, 300, 30, 330),
      ('${YESTERDAY}', 'acc_o', 'release_notes', '@cf/m', 1, 100, 10, 110),
      ('${YESTERDAY}', '', 'unattributed', '@cf/e', 2, 0, 0, 0),
      ('${TODAY}', 'acc_o', 'knowledge', '@cf/m', 9, 900, 90, 990);
  `);
  registry.exec(`
    INSERT INTO repositories (id, key, format, owner_id, kind, visibility, created_at, updated_at) VALUES
      ('feed_1', 'npm-o', 'npm', 'acc_o', 'local', 'private', 't', 't'),
      ('feed_2', 'gen-o', 'generic', 'acc_o', 'local', 'private', 't', 't'),
      ('feed_p', 'gen-p', 'generic', 'acc_p', 'local', 'private', 't', 't');
    INSERT INTO blobs (digest, r2_key, size, created_at) VALUES
      ('d1', 'b/1', 100, 't'), ('d2', 'b/2', 200, 't'), ('d3', 'b/3', 400, 't');
    INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at) VALUES
      ('pkg_1', 'feed_1', 'left-pad', 'left-pad', 't', 't');
    INSERT INTO versions (id, package_id, version, created_at) VALUES ('ver_1', 'pkg_1', '1.0.0', 't');
    INSERT INTO files (id, repo_id, path, version_id, digest, size, created_at) VALUES
      ('f1', 'feed_1', 'a.tgz', 'ver_1', 'd1', 100, 't'),
      ('f2', 'feed_2', 'b.bin', NULL, 'd1', 100, 't'),
      ('f3', 'feed_2', 'c.bin', NULL, 'd2', 200, 't'),
      ('f4', 'feed_p', 'd.bin', NULL, 'd3', 400, 't');
    INSERT INTO derived_files (repo_id, path, r2_key, size, sha256, content_type, generation, updated_at) VALUES
      ('feed_1', 'index.json', 'd/1', 50, 's', 'application/json', 1, 't');
  `);
  await avatars.put("avatars/acc_o/a.png", new Uint8Array(1234));
});

function figures(account: string) {
  return Object.fromEntries(
    (
      main
        .prepare(
          `SELECT day, construct, item, metric, kind, quantity, estimated, method FROM usage_snapshots
           WHERE account_id = ? ORDER BY construct, item, metric`,
        )
        .all(account) as {
        day: string;
        construct: string;
        item: string;
        metric: string;
        kind: string;
        quantity: number;
        estimated: number;
        method: string;
      }[]
    ).map((r) => [`${r.day} ${r.construct}/${r.item}/${r.metric}`, r]),
  );
}

async function collectAll(limits = USAGE_LIMITS) {
  let runs = 0;
  for (;;) {
    runs++;
    const result = await collectUsage(env, NOW, limits);
    if (result.done) return runs;
    if (runs > 500) throw new Error("collection never finished");
  }
}

describe("collectUsage", () => {
  test("measured figures match the seeded stores; estimates are labelled", async () => {
    expect(await collectAll()).toBe(1);
    const o = figures("acc_o");
    const q = (key: string) => o[`${key}`]?.quantity;

    // D1: CI logs measured exactly (job_3's local log belongs to the same account).
    expect(q(`${TODAY} d1/ci-logs/rows`)).toBe(4);
    expect(q(`${TODAY} d1/ci-logs/bytes`)).toBe(1000 + 1000 + 1000 + 4);
    expect(o[`${TODAY} d1/ci-logs/bytes`]!.estimated).toBe(0);
    // A sampled group: counts exact, bytes estimated with the method.
    expect(q(`${TODAY} d1/repositories/rows`)).toBe(2);
    expect(o[`${TODAY} d1/repositories/rows`]!.estimated).toBe(0);
    expect(o[`${TODAY} d1/repositories/bytes`]).toMatchObject({ estimated: 1 });
    expect(o[`${TODAY} d1/repositories/bytes`]!.method).toMatch(/sampled rows/);
    expect(q(`${TODAY} d1/repositories/bytes`)).toBeGreaterThan(0);
    // Registry D1 groups too: 2 feeds, 1 package, 1 version, 3 files, 1 derived file.
    expect(q(`${TODAY} d1/packages/rows`)).toBe(8);

    // Durable Objects from the registry's sizes; purged ones and other accounts' excluded.
    expect(q(`${TODAY} durable_objects/Tracker/bytes`)).toBe(40960);
    expect(o[`${TODAY} durable_objects/Tracker/bytes`]!.estimated).toBe(0);
    expect(q(`${TODAY} durable_objects/KnowledgeCoordinator/instances`)).toBe(2);
    expect(q(`${TODAY} durable_objects/KnowledgeCoordinator/bytes`)).toBe(8192);
    expect(o[`${TODAY} durable_objects/KnowledgeCoordinator/bytes`]).toMatchObject({
      estimated: 1,
      method: expect.stringMatching(/1 not yet sized/),
    });

    // R2: distinct blobs (d1 once, d2), derived files, the profile picture.
    expect(q(`${TODAY} r2/registry_blobs/objects`)).toBe(2);
    expect(q(`${TODAY} r2/registry_blobs/bytes`)).toBe(300);
    expect(q(`${TODAY} r2/registry_derived/bytes`)).toBe(50);
    expect(q(`${TODAY} r2/avatars/bytes`)).toBe(1234);

    // Artifacts: estimated from pushed pack bytes.
    expect(q(`${TODAY} artifacts/repositories/repositories`)).toBe(2);
    expect(o[`${TODAY} artifacts/repositories/bytes`]).toMatchObject({
      quantity: 12000,
      estimated: 1,
    });

    // Unreachable git data: one measurement per repository a ref left a commit in, summed.
    expect(o[`${TODAY} artifacts/repositories/unreachable_bytes`]).toMatchObject({
      quantity: 350,
      estimated: 1,
      method: expect.stringMatching(/can't prune/),
    });
    expect(q(`${TODAY} artifacts/repositories/unreachable_objects`)).toBe(6);

    // Vectorize: embedded kinds with a summary only; × 1024.
    expect(o[`${TODAY} vectorize/knowledge/vectors`]).toMatchObject({ quantity: 2, estimated: 1 });
    expect(q(`${TODAY} vectorize/knowledge/dimensions`)).toBe(2048);

    // AI Search: items exact; bytes measured plus the unmeasured one at the average.
    expect(o[`${TODAY} ai_search/knowledge/items`]).toMatchObject({ quantity: 3, estimated: 0 });
    expect(o[`${TODAY} ai_search/knowledge/bytes`]).toMatchObject({
      quantity: 3000 + 1000 + 2000,
      estimated: 1,
    });

    // Activity: yesterday's AI by model (all features), and sandbox minutes.
    expect(q(`${YESTERDAY} workers_ai/@cf/m/calls`)).toBe(4);
    expect(q(`${YESTERDAY} workers_ai/@cf/m/input_tokens`)).toBe(400);
    expect(q(`${YESTERDAY} workers_ai/@cf/m/output_tokens`)).toBe(40);
    expect(o[`${YESTERDAY} workers_ai/@cf/m/calls`]!.kind).toBe("activity");
    expect(q(`${YESTERDAY} ci/sandbox/jobs`)).toBe(2);
    expect(q(`${YESTERDAY} ci/sandbox/minutes`)).toBe(40);
    // What those minutes provision, by each job's instance type: 30 min on the
    // default standard-1 (1/2 vCPU, 4 GiB, 8 GB) and 10 on standard-4 (4, 12, 20).
    expect(q(`${YESTERDAY} ci/sandbox/vcpu_seconds`)).toBe(1800 * 0.5 + 600 * 4);
    expect(q(`${YESTERDAY} ci/sandbox/memory_gib_seconds`)).toBe(1800 * 4 + 600 * 12);
    expect(q(`${YESTERDAY} ci/sandbox/disk_gb_seconds`)).toBe(1800 * 8 + 600 * 20);
    expect(o[`${YESTERDAY} ci/sandbox/vcpu_seconds`]!.estimated).toBe(1);
    expect(o[`${YESTERDAY} ci/sandbox/minutes`]!.estimated).toBe(0);

    // The other account sees only its own.
    const p = figures("acc_p");
    expect(p[`${TODAY} r2/registry_blobs/bytes`]?.quantity).toBe(400);
    expect(p[`${TODAY} d1/ci-logs/rows`]).toBeUndefined();
    expect(p[`${TODAY} durable_objects/Tracker/bytes`]).toBeUndefined();

    // The site: global caches, unowned instances, the whole blob catalog, unattributed AI.
    const site = figures(SITE);
    expect(site[`${TODAY} r2/registry_blobs_all/bytes`]?.quantity).toBe(700);
    expect(site[`${TODAY} durable_objects/RegistryUpload/instances`]?.quantity).toBe(1);
    expect(site[`${YESTERDAY} workers_ai/@cf/e/calls`]?.quantity).toBe(2);
    expect(site[`${TODAY} d1/system/rows`]?.quantity).toBeGreaterThanOrEqual(1);

    // Done for the day: another run does nothing.
    expect(await collectUsage(env, NOW)).toMatchObject({ steps: 0, done: true });
  });

  test("bounded and resumable: tiny budgets reach the same figures", async () => {
    await collectAll();
    const whole = { o: figures("acc_o"), p: figures("acc_p"), site: figures(SITE) };
    main.exec("DELETE FROM usage_snapshots; DELETE FROM job_cursors WHERE name = 'usage:collect'");
    const runs = await collectAll({ ...USAGE_LIMITS, steps: 2, logJobs: 1 });
    expect(runs).toBeGreaterThan(10);
    const strip = (rows: Record<string, { quantity: number; estimated: number }>) =>
      Object.fromEntries(
        Object.entries(rows).map(([k, v]) => [k, [v.quantity, v.estimated]] as const),
      );
    expect(strip(figures("acc_o"))).toEqual(strip(whole.o));
    expect(strip(figures("acc_p"))).toEqual(strip(whole.p));
    expect(strip(figures(SITE))).toEqual(strip(whole.site));
  });

  test("a failing step is skipped, not retried forever", async () => {
    // The registry database is unavailable: its steps fail, the rest still land.
    env = { ...env, REGISTRY_DB: undefined } as unknown as Env;
    const errors = console.error;
    console.error = () => {};
    try {
      const result = await collectUsage(env, NOW);
      expect(result.done).toBe(true);
      expect(result.failed).toBeGreaterThan(0);
    } finally {
      console.error = errors;
    }
    expect(figures("acc_o")[`${TODAY} d1/ci-logs/bytes`]?.quantity).toBe(3004);
  });

  test("a new day starts over", async () => {
    await collectAll();
    const next = await collectUsage(env, new Date("2026-10-06T00:17:00Z"));
    expect(next.done).toBe(true);
    expect(
      main.prepare("SELECT COUNT(*) AS n FROM usage_snapshots WHERE day = '2026-10-06'").get(),
    ).toMatchObject({ n: expect.any(Number) });
    expect(figures("acc_o")["2026-10-06 d1/ci-logs/bytes"]?.quantity).toBe(3004);
    // Activity for the 5th: today's AI rows.
    expect(figures("acc_o")[`${TODAY} workers_ai/@cf/m/calls`]?.quantity).toBe(9);
  });
});

describe("table groups", () => {
  test("every table in both databases is in exactly one group", () => {
    const tables = (db: DatabaseSync) =>
      (
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all() as { name: string }[]
      ).map((r) => r.name);
    for (const [database, db] of [
      ["db", main],
      ["registry", registry],
    ] as const) {
      const grouped = TABLE_GROUPS.filter((g) => g.database === database).flatMap((g) =>
        Object.keys(g.tables),
      );
      expect(new Set(grouped).size, `${database}: a table is in two groups`).toBe(grouped.length);
      expect([...grouped].sort(), `${database}: add new tables to worker/usage/tables.ts`).toEqual(
        tables(db),
      );
    }
  });

  test("every account-scope owner clause runs", () => {
    for (const group of TABLE_GROUPS) {
      const db = group.database === "db" ? main : registry;
      for (const [table, owner] of Object.entries(group.tables))
        expect(() =>
          db
            .prepare(`SELECT COUNT(*) FROM "${table}" ${owner ? `WHERE ${owner}` : ""}`)
            .get(...(owner ? ["acc_o"] : [])),
        ).not.toThrow();
    }
  });
});
