// The instance registry (CORE-197): recording uses through durableStub,
// purging and retiring through the registry, the migration's backfill and
// the hourly sweep, against real migrations.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import type { PurgeReport, StorageReport } from "./contract.ts";
import {
  durableAgent,
  durableStub,
  forgetRecorded,
  purgeInstance,
  retireInstance,
  TOUCH_EVERY_MS,
} from "./registry.ts";
import { SWEEP_LIMITS, sweepDurableInstances } from "./sweep.ts";
import { recordUse, resolveDurableOwner } from "./record.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));

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

let close: () => void;

afterEach(() => close?.());

beforeEach(async () => {
  forgetRecorded();
  const fixture = await createFreshSpaceTestEnvironment();
  close = fixture.close;
  sqlite = fixture.sqlite;
  registry = fixture.registry;
  trackers = namespace();
  coordinators = namespace();
  feeds = namespace();
  env = {
    ...fixture.env,
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
      `SELECT class, name, space_id, account_id, repo_id, last_active_at, storage_bytes, sized_at, retiring_at, purged_at, purge_reason
       FROM do_instances ${cls ? "WHERE class = ?" : ""} ORDER BY class, name`,
    )
    .all(...(cls ? [cls] : [])) as Record<string, unknown>[];
}

async function seedSpace(id: string) {
  await seedSpaceFixture(env.DB, {
    organization: { id: `organization_${id}`, slug: id, displayName: id, kind: "company" },
    space: { id, slug: id, displayName: id },
    members: [],
    actorId: "test-fixture",
  });
}

describe("durableStub", () => {
  test("returns the instance's stub and records it with its owner", async () => {
    await seedSpace("acc_orbit");
    const stub = durableStub(env, "Tracker", "acc_orbit");
    expect(typeof stub.purge).toBe("function");
    durableStub(env, "KnowledgeCoordinator", "repo_1");
    await settle();
    expect(rows()).toMatchObject([
      { class: "KnowledgeCoordinator", name: "repo_1", account_id: null, repo_id: "repo_1" },
      {
        class: "Tracker",
        name: "acc_orbit",
        space_id: "acc_orbit",
        account_id: null,
        repo_id: null,
      },
    ]);
  });

  test("equal ids do not conflate Space, person, unknown content, or infrastructure", async () => {
    sqlite.exec(
      "INSERT INTO accounts (id, kind, slug, display_name) VALUES ('same', 'user', 'same', 'Person')",
    );
    await seedSpace("same");
    expect(await resolveDurableOwner(env, "Tracker", "same", { account: "same" })).toEqual({
      space: "same",
      account: null,
      repo: null,
    });
    expect(await resolveDurableOwner(env, "Assistant", "same:chat", { repo: "same" })).toEqual({
      space: null,
      account: "same",
      repo: null,
    });
    expect(
      await resolveDurableOwner(env, "KnowledgeCoordinator", "same", { account: "same" }),
    ).toEqual({ space: null, account: null, repo: "same" });
    expect(await resolveDurableOwner(env, "CiSandbox", "same")).toEqual({
      space: null,
      account: null,
      repo: null,
    });
    expect(await resolveDurableOwner(env, "RegistryLogin", "same")).toEqual({
      space: null,
      account: null,
      repo: null,
    });
  });

  test("unknown named content stays unattributed through retirement, purge, and cold sweep", async () => {
    sqlite.exec(
      "INSERT INTO accounts (id, kind, slug, display_name) VALUES ('missing', 'user', 'missing', 'Person')",
    );
    durableStub(env, "Tracker", "missing", { account: "missing" });
    await settle();
    await retireInstance(env, "Tracker", "missing", "deleted");
    await purgeInstance(env, "Tracker", "missing", "deleted");
    forgetRecorded();
    await sweepDurableInstances(env, Date.now(), { ...SWEEP_LIMITS, sizes: 0 });
    expect(rows("Tracker")[0]).toMatchObject({
      space_id: null,
      account_id: null,
      purged_at: "2026-10-04T00:00:00.000Z",
      retiring_at: null,
      purge_reason: "deleted",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM spaces").get()).toEqual({ count: 0 });
  });

  test("sandbox ownership preserves an original person but never infers one from its opaque name", async () => {
    sqlite.exec(
      "INSERT INTO accounts (id, kind, slug, display_name) VALUES ('person', 'user', 'person', 'Person')",
    );
    await recordUse(
      env.DB,
      {
        class: "CiSandbox",
        name: "opaque-job",
        space: null,
        account: "person",
        repo: null,
      },
      "2026-10-04T00:00:00.000Z",
      "2026-10-04T00:00:00.000Z",
    );
    expect(await resolveDurableOwner(env, "CiSandbox", "opaque-job")).toEqual({
      space: null,
      account: "person",
      repo: null,
    });
    expect(await resolveDurableOwner(env, "CiSandbox", "person")).toEqual({
      space: null,
      account: null,
      repo: null,
    });
  });

  test("warm ownership corrections and cold replay replace stale attribution without reviving purge during sweep", async () => {
    await seedSpace("same");
    const at = "2026-10-04T00:00:00.000Z";
    await recordUse(
      env.DB,
      { class: "Tracker", name: "same", space: null, account: "same", repo: null },
      at,
      at,
    );
    durableStub(env, "Tracker", "same");
    await settle();
    expect(rows("Tracker")[0]).toMatchObject({ space_id: "same", account_id: null });
    forgetRecorded();
    durableStub(env, "Tracker", "same");
    await settle();
    await purgeInstance(env, "Tracker", "same", "test");
    sqlite.exec(
      "UPDATE do_instances SET space_id = NULL, account_id = 'same' WHERE class = 'Tracker'",
    );
    await sweepDurableInstances(env, Date.now(), { ...SWEEP_LIMITS, sizes: 0 });
    expect(rows("Tracker")[0]).toMatchObject({
      space_id: "same",
      account_id: null,
      purge_reason: "test",
    });
  });

  test("sweep pages past unresolved content and retries it after source rows arrive", async () => {
    await seedSpace("space");
    await seedSpace("other");
    durableStub(env, "RegistryRepo", "a_missing");
    durableStub(env, "RegistryRepo", "z_later");
    await settle();
    registry.exec(`INSERT INTO repositories (id, key, format, space_id, kind, visibility, created_at, updated_at)
      VALUES ('z_later', 'later', 'npm', 'space', 'local', 'private', '2026-10-04', '2026-10-04')`);
    const limits = { ...SWEEP_LIMITS, backfill: 0, owners: 1, sizes: 0 };
    await sweepDurableInstances(env, Date.now(), limits);
    await sweepDurableInstances(env, Date.now(), limits);
    expect(rows("RegistryRepo")[1]).toMatchObject({ space_id: "space", account_id: null });
    registry.exec(`INSERT INTO repositories (id, key, format, space_id, kind, visibility, created_at, updated_at)
      VALUES ('a_missing', 'missing', 'npm', 'other', 'local', 'private', '2026-10-04', '2026-10-04')`);
    await sweepDurableInstances(env, Date.now(), limits);
    await sweepDurableInstances(env, Date.now(), limits);
    expect(rows("RegistryRepo")[0]).toMatchObject({ space_id: "other", account_id: null });
  });

  test("registry backfill keeps missing Space references unresolved and reconciles them later", async () => {
    registry.exec(`INSERT INTO repositories (id, key, format, space_id, kind, visibility, created_at, updated_at)
      VALUES ('feed', 'feed', 'npm', 'later', 'local', 'private', '2026-10-04', '2026-10-04')`);
    const limits = { ...SWEEP_LIMITS, sizes: 0 };
    expect((await sweepDurableInstances(env, Date.now(), limits)).registered).toBe(1);
    await purgeInstance(env, "RegistryRepo", "feed", "deleted");
    expect(rows("RegistryRepo")[0]).toMatchObject({
      space_id: null,
      account_id: null,
      purge_reason: "deleted",
    });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM spaces").get()).toEqual({ count: 0 });
    await seedSpace("later");
    forgetRecorded();
    await sweepDurableInstances(env, Date.now(), limits);
    expect(rows("RegistryRepo")[0]).toMatchObject({
      space_id: "later",
      account_id: null,
      purge_reason: "deleted",
      purged_at: "2026-10-04T00:00:00.000Z",
    });
  });

  test("records at most once an hour per instance", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
      durableStub(env, "Tracker", "acc_orbit");
      await settle();
      vi.setSystemTime(new Date("2026-10-04T00:30:00Z"));
      durableStub(env, "Tracker", "acc_orbit");
      await settle();
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
          `INSERT INTO repositories (id, key, format, space_id, kind, visibility, created_at, updated_at)
           VALUES (?, ?, 'npm', 'acc_o', 'local', 'private', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        )
        .run(`feed_${String(i).padStart(3, "0")}`, `key${i}`);
  }

  test("backfills registry repositories in bounded, resumable steps", async () => {
    await seedSpace("acc_o");
    seedRegistry(5);
    const limits = { ...SWEEP_LIMITS, backfill: 2 };
    expect((await sweepDurableInstances(env, Date.now(), limits)).registered).toBe(2);
    expect((await sweepDurableInstances(env, Date.now(), limits)).registered).toBe(2);
    expect((await sweepDurableInstances(env, Date.now(), limits)).registered).toBe(1);
    expect((await sweepDurableInstances(env, Date.now(), limits)).registered).toBe(0);
    expect(rows("RegistryRepo")).toHaveLength(5);
    expect(rows("RegistryRepo").every((r) => r.space_id === "acc_o" && r.account_id === null)).toBe(
      true,
    );
  });

  test("fills owners from the rows that name them", async () => {
    sqlite.exec(
      "INSERT INTO accounts (id, kind, slug, display_name) VALUES ('person', 'user', 'person', 'Person')",
    );
    await seedSpaceFixture(env.DB, {
      organization: { id: "org", slug: "org", displayName: "Org", kind: "company" },
      space: { id: "acc_o", slug: "space", displayName: "Space" },
      members: [{ accountId: "person", role: "owner" }],
      actorId: "person",
    });
    sqlite.exec(`
      INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES ('repo_1', 'acc_o', 'r', 'private', 'n', 'https://x');
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES ('run_1', 'repo_1', 1, 'c', 'refs/heads/main', 'push', 'running');
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES ('job_1', 'run_1', 'repo_1', 'a', '{}', 'running', 'sandbox');
    `);
    expect(
      await resolveDurableOwner(env, "CiSandbox", "run_1", { account: "person", repo: "wrong" }),
    ).toEqual({ space: "acc_o", account: null, repo: "repo_1" });
    expect(
      await resolveDurableOwner(env, "CiSandbox", "job_1", { account: "person", repo: "wrong" }),
    ).toEqual({ space: "acc_o", account: null, repo: "repo_1" });
    seedRegistry(1);
    durableStub(env, "KnowledgeCoordinator", "repo_1");
    durableStub(env, "CiSandbox", "job_1");
    durableStub(env, "RegistryRepo", "feed_000");
    durableStub(env, "KnowledgeCoordinator", "repo_deleted");
    await settle();
    await sweepDurableInstances(env, Date.now(), { ...SWEEP_LIMITS, backfill: 0 });
    expect(
      rows().map(({ class: cls, name, space_id, account_id, repo_id }) => ({
        cls,
        name,
        space_id,
        account_id,
        repo_id,
      })),
    ).toEqual([
      { cls: "CiSandbox", name: "job_1", space_id: "acc_o", account_id: null, repo_id: "repo_1" },
      {
        cls: "KnowledgeCoordinator",
        name: "repo_1",
        space_id: "acc_o",
        account_id: null,
        repo_id: "repo_1",
      },
      {
        cls: "KnowledgeCoordinator",
        name: "repo_deleted",
        space_id: null,
        account_id: null,
        repo_id: "repo_deleted",
      },
      { cls: "RegistryRepo", name: "feed_000", space_id: "acc_o", account_id: null, repo_id: null },
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

describe("assistant facade startup", () => {
  test("does not return the named stub until SDK initialization finishes", async () => {
    const startup = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const stub = {
      __unsafe_ensureInitialized: vi.fn(async () => {
        entered.resolve();
        await startup.promise;
      }),
    };
    const getByName = vi.fn(() => stub);
    Reflect.set(env, "ASSISTANT", { getByName });
    let returned = false;
    const pending = durableAgent(env, "Assistant", "person:chat").then((value) => {
      returned = true;
      return value;
    });
    await entered.promise;
    expect(returned).toBe(false);
    expect(getByName).toHaveBeenCalledWith("person:chat");
    startup.resolve();
    expect(await pending).toBe(stub);
  });

  test("preserves SDK retryable startup failures without retrying overloads or admission denial", async () => {
    vi.useFakeTimers();
    try {
      const transient = Object.assign(new Error("platform reset"), { retryable: true });
      const initialize = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue(undefined);
      const stub = { __unsafe_ensureInitialized: initialize };
      Reflect.set(env, "ASSISTANT", { getByName: () => stub });
      const pending = durableAgent(env, "Assistant", "person:retry");
      await vi.runAllTimersAsync();
      expect(await pending).toBe(stub);
      expect(initialize).toHaveBeenCalledTimes(2);
      for (const error of [
        Object.assign(new Error("overloaded"), { retryable: true, overloaded: true }),
        new Error("space_cutover_fenced"),
      ]) {
        initialize.mockReset().mockRejectedValue(error);
        await expect(durableAgent(env, "Assistant", "person:denied")).rejects.toBe(error);
        expect(initialize).toHaveBeenCalledTimes(1);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
