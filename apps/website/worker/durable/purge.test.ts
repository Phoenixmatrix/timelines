// The purge contract, class by class (CORE-197): each holds something, and
// purge leaves no table, key or alarm; purging again is harmless; retire
// waits for in-flight work, then purges and records it. The assistant (an
// Agents SDK agent) and every class again in the real runtime: the E2E
// scenario durable-objects-register-and-purge.
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { FakeR2Bucket } from "@gitmatrix/testing";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { fakeContainer, fakeDurableObjectId, fakeDurableState } from "../testing/durable-state.ts";
import { initializeFreshTrackerSpace } from "../tracker/space-migration.ts";
import { isEmpty, storageReport, type Purgeable } from "./contract.ts";
import { Tracker } from "../tracker/object.ts";
import { KnowledgeCoordinator } from "../knowledge/coordinator.ts";
import { StepFeed } from "../steps/feed.ts";
import { CiSandbox } from "../ci/sandbox.ts";
import { RepoDO } from "../../registry/do/repo-do.ts";
import { UploadDO } from "../../registry/do/upload-do.ts";
import { LoginDO } from "../../registry/do/login-do.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

type Built = { object: Purgeable & { alarm?(): Promise<void> }; ctx: DurableObjectState };

let env: Env;
let control: Awaited<ReturnType<typeof createFreshSpaceTestEnvironment>>["control"];
let closeEnvironment: (() => void) | undefined;
beforeEach(async () => {
  const fixture = await createFreshSpaceTestEnvironment();
  env = { ...fixture.env, REGISTRY_BLOBS: new FakeR2Bucket() as unknown as R2Bucket };
  control = fixture.control;
  closeEnvironment = fixture.close;
});
afterEach(() => closeEnvironment?.());

async function purgedRow(cls: string, name: string) {
  return env.DB.prepare(
    "SELECT purged_at, purge_reason, storage_bytes, retiring_at FROM do_instances WHERE class = ? AND name = ?",
  )
    .bind(cls, name)
    .first<{ purged_at: string | null; purge_reason: string | null; retiring_at: string | null }>();
}

async function buildTracker() {
  const state = fakeDurableState({ name: "Tracker-1" });
  await seedSpaceFixture(env.DB, {
    organization: {
      id: "organization",
      slug: "organization",
      displayName: "Organization",
      kind: "company",
    },
    space: { id: "Tracker-1", slug: "tracker", displayName: "Tracker" },
    members: [],
    actorId: "test-fixture",
  });
  Reflect.set(env, "TRACKER", { idFromName: fakeDurableObjectId });
  await initializeFreshTrackerSpace(env, state.ctx, "Tracker-1");
  const object = new Tracker(state.ctx, env);
  await state.ctx.storage.setAlarm(Date.now() + 60_000);
  return { ...state, object };
}

/** Each class, holding something and an alarm. */
const CASES: Record<string, () => Promise<Built>> = {
  Tracker: buildTracker,
  async KnowledgeCoordinator() {
    const { ctx } = fakeDurableState();
    const object = new KnowledgeCoordinator(ctx, env);
    await ctx.storage.put("state", { repoId: "repo_1", seq: 1, scan: true });
    await ctx.storage.setAlarm(Date.now() + 60_000);
    return { object, ctx };
  },
  async StepFeed() {
    const { ctx } = fakeDurableState();
    const object = new StepFeed(ctx, env);
    // Existing persisted feed contents must be purged, independent of publication admission.
    await ctx.storage.put("r:000000000001", {
      seq: 1,
      at: new Date().toISOString(),
      repo: "orbit/app",
      timeline: "search",
      changeId: "change0001",
      commitOid: "a".repeat(40),
      summary: "Rank by recency",
      issue: null,
      author: { id: "agt_1", kind: "agent", name: "builder" },
      tests: null,
      why: "",
      committedAt: new Date().toISOString(),
    });
    await ctx.storage.put("seq", 1);
    await ctx.storage.setAlarm(Date.now() + 60_000);
    return { object, ctx };
  },
  async CiSandbox() {
    const { ctx } = fakeDurableState({ container: fakeContainer(true) });
    const object = new CiSandbox(ctx, env);
    await ctx.storage.setAlarm(Date.now() + 60_000);
    return { object, ctx };
  },
  async RegistryRepo() {
    const { ctx } = fakeDurableState();
    const object = new RepoDO(ctx, env);
    await ctx.storage.put("repoId", "feed_1");
    await ctx.storage.put("lastRebuildAt", Date.now());
    // Inside the debounce window: it arms the alarm.
    await object.requestRebuild("feed_1", 60_000);
    return { object, ctx };
  },
  async RegistryUpload() {
    const { ctx } = fakeDurableState();
    const object = new UploadDO(ctx, env);
    await object.putState({ version: 1, r2Key: "b/upload", r2UploadId: null }, null);
    await object.expireAt(Date.now() + 60_000);
    return { object, ctx };
  },
  async RegistryLogin() {
    const { ctx } = fakeDurableState();
    const object = new LoginDO(ctx, env);
    await object.start({
      status: "pending",
      doneSecretHash: "h",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      repo: "npm",
    });
    return { object, ctx };
  },
};

describe("purge(reason)", () => {
  for (const [name, build] of Object.entries(CASES)) {
    test(`${name}: leaves no storage and no alarm, twice`, async () => {
      const { object, ctx } = await build();
      const before = await storageReport(ctx.storage);
      expect(isEmpty(before)).toBe(false);
      expect(before.alarm).not.toBeNull();

      const report = await object.purge("test");
      expect(report).toMatchObject({ reason: "test", tables: [], keys: 0, alarm: null });
      expect(isEmpty(await storageReport(ctx.storage))).toBe(true);
      // Idempotent.
      expect(isEmpty(await object.purge("again"))).toBe(true);
    });
  }

  test("Tracker: fresh installation admission cannot erase unconverted legacy content", async () => {
    const { ctx, db } = fakeDurableState({ name: "legacy-owner" });
    try {
      db.exec(`
        CREATE TABLE workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE issues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        INSERT INTO workspaces VALUES ('workspace', '{"id":"workspace","slug":"legacy"}');
        INSERT INTO issues VALUES ('issue', '{"id":"issue","workspaceId":"workspace","title":"Keep me"}');
      `);
      const object = new Tracker(ctx, env);
      await expect(object.purge("test")).rejects.toThrow("space_migration_fenced");
      await expect(object.retire("test", "legacy-owner")).rejects.toThrow("space_migration_fenced");
      await expect(object.storageReport()).rejects.toThrow("space_migration_fenced");
      await expect(object.alarm()).rejects.toThrow("space_migration_fenced");
      expect(db.prepare("SELECT * FROM workspaces").all()).toEqual([
        { id: "workspace", data: '{"id":"workspace","slug":"legacy"}' },
      ]);
      expect(db.prepare("SELECT * FROM issues").all()).toEqual([
        { id: "issue", data: '{"id":"issue","workspaceId":"workspace","title":"Keep me"}' },
      ]);
      expect(await ctx.storage.list()).toEqual(new Map());
    } finally {
      db.close();
    }
  });

  test("CiSandbox: destroys a running container", async () => {
    const container = fakeContainer(true);
    const { ctx } = fakeDurableState({ container });
    await new CiSandbox(ctx, env).purge("job deleted");
    expect(container.destroyed).toBe(1);
    expect(container.running).toBe(false);
  });

  test("CiSandbox: purge can reply after a delayed admission release", async () => {
    vi.useFakeTimers();
    let resume!: () => void;
    let entered!: () => void;
    let abort!: (error: Error) => void;
    const releaseGate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const releasing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const reset = new Promise<never>((_, reject) => {
      abort = reject;
    });
    const release = control.release.bind(control);
    const delayed = vi.spyOn(control, "release").mockImplementation(async (ticket) => {
      entered();
      await releaseGate;
      release(ticket);
    });
    const container = fakeContainer(true);
    const { ctx } = fakeDurableState({ container });
    vi.spyOn(ctx, "abort").mockImplementation(() => {
      const error = new Error("Durable Object reset before its RPC replied");
      abort(error);
      throw error;
    });
    const purge = new CiSandbox(ctx, env).purge("job deleted");
    const response = Promise.race([purge, reset]).then(
      (report) => ({ report }),
      (error: unknown) => ({ error }),
    );
    try {
      await releasing;
      await vi.runAllTimersAsync();
      resume();
      expect(await response).toMatchObject({
        report: { reason: "job deleted", tables: [], keys: 0, alarm: null },
      });
      expect(container.running).toBe(false);
    } finally {
      resume();
      await purge.catch(() => {});
      await vi.runAllTimersAsync();
      delayed.mockRestore();
      vi.useRealTimers();
    }
  });

  test("RegistryUpload: aborts its multipart upload and deletes its tails", async () => {
    const bucket = new FakeR2Bucket();
    env = { ...env, REGISTRY_BLOBS: bucket } as unknown as Env;
    const upload = await bucket.createMultipartUpload("b/x");
    await bucket.put("b/x.tail.1", "tail");
    const { ctx } = fakeDurableState();
    const object = new UploadDO(ctx, env);
    await object.putState({ version: 1, r2Key: "b/x", r2UploadId: upload.uploadId }, null);
    await object.purge("expired");
    expect((await bucket.list({ prefix: "b/x" })).objects).toEqual([]);
  });

  test("resets the instance after answering", async () => {
    vi.useFakeTimers();
    try {
      const { object, aborted } = await buildTracker();
      await object.purge("test");
      expect(aborted).toEqual([]);
      await vi.runAllTimersAsync();
      expect(aborted).toEqual(["purged"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("retire(reason, name)", () => {
  for (const [name, build] of Object.entries(CASES)) {
    test(`${name}: purges from its alarm and records it`, async () => {
      const { object, ctx } = await build();
      await object.retire("owner deleted", `${name}-1`);
      expect(await ctx.storage.getAlarm()).not.toBeNull();
      await object.alarm!();
      expect(isEmpty(await storageReport(ctx.storage))).toBe(true);
      expect(await purgedRow(name, `${name}-1`)).toMatchObject({
        purge_reason: "owner deleted",
        retiring_at: null,
      });
    });

    test(`${name}: wakes when asked, and a purge before then cancels it`, async () => {
      const { object, ctx } = await build();
      await ctx.storage.deleteAlarm(); // Its own wake-ups come sooner; a fresh instance has none.
      const asked = Date.now();
      await object.retire("probe", `${name}-1`, 600_000);
      expect(await ctx.storage.getAlarm()).toBeGreaterThanOrEqual(asked + 600_000);
      expect((await object.purge("probe")).alarm).toBeNull();
    });
  }

  test("KnowledgeCoordinator: waits for a running build, then purges", async () => {
    const statuses = new Map<string, string>([["build_1", "running"]]);
    env = {
      ...env,
      KNOWLEDGE_BUILD: {
        get: async (id: string) => ({
          status: async () => ({ status: statuses.get(id) }),
          terminate: async () => {},
        }),
      },
    } as unknown as Env;
    const { ctx } = fakeDurableState();
    const object = new KnowledgeCoordinator(ctx, env);
    await ctx.storage.put("state", {
      repoId: "repo_1",
      running: { buildId: "build_1", seq: 1, startedAt: Date.now() },
    });
    await object.retire("repository deleted", "repo_1");
    await object.alarm();
    // Still building: it checks back later and starts nothing.
    expect(isEmpty(await storageReport(ctx.storage))).toBe(false);
    expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now() + 30_000);
    expect(await purgedRow("KnowledgeCoordinator", "repo_1")).toBeNull();

    // The build reports back; the next alarm purges.
    await object.finished("build_1", true, null);
    expect(await ctx.storage.getAlarm()).not.toBeNull();
    await object.alarm();
    expect(isEmpty(await storageReport(ctx.storage))).toBe(true);
    expect(await purgedRow("KnowledgeCoordinator", "repo_1")).toMatchObject({
      purge_reason: "repository deleted",
    });
  });
});
