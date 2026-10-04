// The instance registry (CORE-197): recording uses through durableStub,
// purging and retiring through the registry, the migration's backfill and
// the hourly sweep, against real migrations.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import type { PurgeReport, StorageReport } from "./contract.ts";
import {
  durableStub,
  forgetRecorded,
  purgeInstance,
  retireInstance,
  TOUCH_EVERY_MS,
} from "./registry.ts";
import { SWEEP_LIMITS, sweepDurableInstances } from "./sweep.ts";

/** Lets background recording (a promise per call) land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

interface FakeInstance {
  purges: string[];
  retired: string[];
  bytes: number;
  fail?: boolean;
}

function namespace(instances = new Map<string, FakeInstance>()) {
  const getByName = vi.fn((name: string) => {
    let instance = instances.get(name);
    if (!instance) instances.set(name, (instance = { purges: [], retired: [], bytes: 4096 }));
    const state = instance;
    return {
      async purge(reason: string): Promise<PurgeReport> {
        state.purges.push(reason);
        state.bytes = 0;
        return {
          reason,
          purgedAt: "2026-10-04T00:00:00.000Z",
          bytes: 0,
          tables: [],
          keys: 0,
          alarm: null,
        };
      },
      async retire(reason: string) {
        state.retired.push(reason);
      },
      async storageReport(): Promise<StorageReport> {
        if (state.fail) throw new Error("broken");
        return { bytes: state.bytes, tables: ["t"], keys: 0, alarm: null };
      },
    };
  });
  return { getByName, instances };
}

let sqlite: DatabaseSync;
let env: Env;
let trackers: ReturnType<typeof namespace>;
let coordinators: ReturnType<typeof namespace>;
let feeds: ReturnType<typeof namespace>;
let registry: DatabaseSync;

function migratedRegistry(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../registry/migrations/", import.meta.url).href);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    db.exec(readFileSync(join(dir, file), "utf8"));
  return db;
}

beforeEach(() => {
  forgetRecorded();
  sqlite = migratedDatabase();
  registry = migratedRegistry();
  trackers = namespace();
  coordinators = namespace();
  feeds = namespace();
  env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registry),
    TRACKER: trackers,
    KNOWLEDGE_COORDINATOR: coordinators,
    REGISTRY_REPO: feeds,
    CI_SANDBOX: namespace(),
    REGISTRY_UPLOAD: namespace(),
  } as unknown as Env;
});

function rows(cls?: string) {
  return sqlite
    .prepare(
      `SELECT class, name, account_id, repo_id, last_active_at, storage_bytes, sized_at, retiring_at, purged_at, purge_reason
       FROM do_instances ${cls ? "WHERE class = ?" : ""} ORDER BY class, name`,
    )
    .all(...(cls ? [cls] : [])) as Record<string, unknown>[];
}

describe("durableStub", () => {
  test("returns the instance's stub and records it with its owner", async () => {
    const stub = durableStub(env, "Tracker", "acc_orbit");
    expect(trackers.getByName).toHaveBeenCalledWith("acc_orbit");
    expect(typeof stub.purge).toBe("function");
    durableStub(env, "KnowledgeCoordinator", "repo_1");
    await settle();
    expect(rows()).toMatchObject([
      { class: "KnowledgeCoordinator", name: "repo_1", account_id: null, repo_id: "repo_1" },
      { class: "Tracker", name: "acc_orbit", account_id: "acc_orbit", repo_id: null },
    ]);
  });

  test("records at most once an hour per instance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
      durableStub(env, "Tracker", "acc_orbit");
      await settle();
      const prepare = vi.spyOn(env.DB, "prepare");
      vi.setSystemTime(new Date("2026-10-04T00:30:00Z"));
      durableStub(env, "Tracker", "acc_orbit");
      await settle();
      expect(prepare).not.toHaveBeenCalled();
      expect(rows()[0]).toMatchObject({ last_active_at: "2026-10-04T00:00:00.000Z" });

      vi.setSystemTime(new Date(Date.parse("2026-10-04T00:00:00Z") + TOUCH_EVERY_MS + 1));
      durableStub(env, "Tracker", "acc_orbit");
      await settle();
      expect(rows()[0]).toMatchObject({ last_active_at: "2026-10-04T01:00:00.001Z" });

      // Another isolate (no memory) within the hour: the database's own throttle holds.
      forgetRecorded();
      vi.setSystemTime(new Date("2026-10-04T01:10:00Z"));
      durableStub(env, "Tracker", "acc_orbit");
      await settle();
      expect(rows()[0]).toMatchObject({ last_active_at: "2026-10-04T01:00:00.001Z" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("never breaks the caller: a failing or missing database is only logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("D1 is down");
        },
      },
    } as unknown as Env;
    expect(() => durableStub(broken, "Tracker", "acc_orbit")).not.toThrow();
    const rejecting = {
      ...env,
      DB: {
        prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error("timeout")) }) }),
      },
    } as unknown as Env;
    expect(() => durableStub(rejecting, "Tracker", "acc_other")).not.toThrow();
    await settle();
    expect(warn).toHaveBeenCalled();
    const { DB: _, ...withoutDb } = env as unknown as Record<string, unknown>;
    expect(() => durableStub(withoutDb as unknown as Env, "Tracker", "acc_x")).not.toThrow();
    warn.mockRestore();
    // A failed recording is tried again on the next use.
    durableStub(env, "Tracker", "acc_other");
    await settle();
    expect(rows().map((r) => r.name)).toEqual(["acc_other"]);
  });
});

describe("purgeInstance and retireInstance", () => {
  test("purge calls the instance's purge and records it, registered or not", async () => {
    durableStub(env, "Tracker", "acc_gone");
    await settle();
    const report = await purgeInstance(env, "Tracker", "acc_gone", "account deleted");
    expect(report).toMatchObject({ reason: "account deleted", tables: [] });
    expect(trackers.instances.get("acc_gone")!.purges).toEqual(["account deleted"]);
    await purgeInstance(env, "KnowledgeCoordinator", "repo_never_seen", "repository deleted");
    expect(rows()).toMatchObject([
      {
        class: "KnowledgeCoordinator",
        name: "repo_never_seen",
        purged_at: "2026-10-04T00:00:00.000Z",
        purge_reason: "repository deleted",
        storage_bytes: 0,
      },
      { class: "Tracker", name: "acc_gone", purge_reason: "account deleted" },
    ]);
  });

  test("a later use brings a purged instance back", async () => {
    await purgeInstance(env, "Tracker", "acc_back", "test");
    durableStub(env, "Tracker", "acc_back");
    await settle();
    expect(rows()[0]).toMatchObject({ purged_at: null, purge_reason: null });
  });

  test("retire asks the instance and marks the row", async () => {
    await retireInstance(env, "KnowledgeCoordinator", "repo_1", "repository deleted");
    expect(coordinators.instances.get("repo_1")!.retired).toEqual(["repository deleted"]);
    expect(rows()[0]).toMatchObject({ purged_at: null });
    expect(rows()[0]!.retiring_at).toBeTruthy();
  });
});

describe("backfill", () => {
  test("the migration registers the instances D1 rows name", () => {
    const db = new DatabaseSync(":memory:");
    const dir = fileURLToPath(new URL("../../migrations/", import.meta.url).href);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const at = files.findIndex((f) => f.endsWith("_durable_instances.sql"));
    for (const file of files.slice(0, at)) db.exec(readFileSync(join(dir, file), "utf8"));
    db.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_a', 'user', 'a', 'A'), ('acc_o', 'org', 'o', 'O');
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES ('repo_1', 'acc_o', 'r', 'private', 'n', 'https://x');
      INSERT INTO assistant_chats (id, user_id) VALUES ('chat_1', 'acc_a');
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES ('run_1', 'repo_1', 1, 'c', 'refs/heads/main', 'push', 'succeeded');
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, started_at, finished_at)
        VALUES ('job_s', 'run_1', 'repo_1', 'a', '{}', 'succeeded', 'sandbox', '2026-01-01T00:00:00Z', '2026-01-01T00:05:00Z'),
               ('job_l', 'run_1', 'repo_1', 'b', '{}', 'succeeded', 'local', '2026-01-01T00:00:00Z', NULL),
               ('job_q', 'run_1', 'repo_1', 'c', '{}', 'queued', 'sandbox', NULL, NULL);
    `);
    for (const file of files.slice(at)) db.exec(readFileSync(join(dir, file), "utf8"));
    expect(
      db
        .prepare("SELECT class, name, account_id, repo_id FROM do_instances ORDER BY class, name")
        .all(),
    ).toEqual([
      { class: "Assistant", name: "acc_a:chat_1", account_id: "acc_a", repo_id: null },
      { class: "CiSandbox", name: "job_s", account_id: "acc_o", repo_id: "repo_1" },
      { class: "KnowledgeCoordinator", name: "repo_1", account_id: "acc_o", repo_id: "repo_1" },
      { class: "Tracker", name: "acc_a", account_id: "acc_a", repo_id: null },
      { class: "Tracker", name: "acc_o", account_id: "acc_o", repo_id: null },
    ]);
  });
});

describe("sweepDurableInstances", () => {
  function seedRegistry(count: number) {
    for (let i = 0; i < count; i++)
      registry
        .prepare(
          `INSERT INTO repositories (id, key, format, owner_id, kind, visibility, created_at, updated_at)
           VALUES (?, ?, 'npm', 'acc_o', 'local', 'private', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run(`feed_${String(i).padStart(3, "0")}`, `key${i}`);
  }

  test("backfills registry repositories in bounded, resumable steps", async () => {
    seedRegistry(5);
    const limits = { ...SWEEP_LIMITS, backfill: 2 };
    expect((await sweepDurableInstances(env, Date.now(), limits)).registered).toBe(2);
    expect((await sweepDurableInstances(env, Date.now(), limits)).registered).toBe(2);
    expect((await sweepDurableInstances(env, Date.now(), limits)).registered).toBe(1);
    expect((await sweepDurableInstances(env, Date.now(), limits)).registered).toBe(0);
    expect(rows("RegistryRepo")).toHaveLength(5);
    expect(rows("RegistryRepo").every((r) => r.account_id === "acc_o")).toBe(true);
  });

  test("fills owners from the rows that name them", async () => {
    sqlite.exec(`
      INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_o', 'org', 'o', 'O');
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES ('repo_1', 'acc_o', 'r', 'private', 'n', 'https://x');
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES ('run_1', 'repo_1', 1, 'c', 'refs/heads/main', 'push', 'running');
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES ('job_1', 'run_1', 'repo_1', 'a', '{}', 'running', 'sandbox');
    `);
    seedRegistry(1);
    durableStub(env, "KnowledgeCoordinator", "repo_1");
    durableStub(env, "CiSandbox", "job_1");
    durableStub(env, "RegistryRepo", "feed_000");
    durableStub(env, "KnowledgeCoordinator", "repo_deleted");
    await settle();
    await sweepDurableInstances(env, Date.now(), { ...SWEEP_LIMITS, backfill: 0 });
    expect(
      rows().map(({ class: cls, name, account_id, repo_id }) => ({
        cls,
        name,
        account_id,
        repo_id,
      })),
    ).toEqual([
      { cls: "CiSandbox", name: "job_1", account_id: "acc_o", repo_id: "repo_1" },
      { cls: "KnowledgeCoordinator", name: "repo_1", account_id: "acc_o", repo_id: "repo_1" },
      {
        cls: "KnowledgeCoordinator",
        name: "repo_deleted",
        account_id: null,
        repo_id: "repo_deleted",
      },
      { cls: "RegistryRepo", name: "feed_000", account_id: "acc_o", repo_id: null },
    ]);
  });

  test("sizes live instances never sized or used since, bounded, past a broken one", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const name of ["acc_1", "acc_2", "acc_3"]) durableStub(env, "Tracker", name);
    durableStub(env, "CiSandbox", "job_1");
    durableStub(env, "RegistryUpload", "upload_1");
    await purgeInstance(env, "KnowledgeCoordinator", "repo_purged", "test");
    await settle();
    trackers.instances.get("acc_2")!.bytes = 12_288;
    trackers.instances.get("acc_3")!.fail = true;
    const limits = { ...SWEEP_LIMITS, sizes: 2 };
    const first = await sweepDurableInstances(env, Date.now(), limits);
    const second = await sweepDurableInstances(env, Date.now(), limits);
    expect(first.sized + first.failed + second.sized + second.failed).toBe(3);
    expect((await sweepDurableInstances(env, Date.now(), limits)).sized).toBe(0);
    const sized = Object.fromEntries(
      rows().map((r) => [`${String(r.class)}:${String(r.name)}`, r.storage_bytes]),
    );
    expect(sized).toEqual({
      "Tracker:acc_1": 4096,
      "Tracker:acc_2": 12_288,
      // Failed: marked as looked at, size unknown.
      "Tracker:acc_3": null,
      // Stateless and self-cleaning classes are never woken to be sized.
      "CiSandbox:job_1": null,
      "RegistryUpload:upload_1": null,
      "KnowledgeCoordinator:repo_purged": 0,
    });
    expect(trackers.getByName.mock.calls.map(([n]) => n).sort()).toEqual([
      "acc_1",
      "acc_1",
      "acc_2",
      "acc_2",
      "acc_3",
      "acc_3",
    ]);
    warn.mockRestore();
  });

  test("forgets self-cleaning instances a week after their last use", async () => {
    durableStub(env, "RegistryUpload", "old");
    durableStub(env, "RegistryUpload", "new");
    durableStub(env, "Tracker", "old_tracker");
    await settle();
    sqlite.exec(
      "UPDATE do_instances SET last_active_at = '2026-01-01T00:00:00.000Z' WHERE name IN ('old', 'old_tracker')",
    );
    const { forgotten } = await sweepDurableInstances(env);
    expect(forgotten).toBe(1);
    expect(rows().map((r) => r.name)).toEqual(["new", "old_tracker"]);
  });
});
