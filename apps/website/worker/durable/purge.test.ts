// The purge contract, class by class (CORE-197): each holds something, and
// purge leaves no table, key or alarm; purging again is harmless; retire
// waits for in-flight work, then purges and records it. The assistant (an
// Agents SDK agent) and every class again in the real runtime: the E2E
// scenario durable-objects-register-and-purge.
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { FakeR2Bucket } from "@gitmatrix/testing";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeContainer, fakeDurableState } from "../testing/durable-state.ts";
import { isEmpty, storageReport, type Purgeable } from "./contract.ts";
import { Tracker } from "../tracker/object.ts";
import { KnowledgeCoordinator } from "../knowledge/coordinator.ts";
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
beforeEach(() => {
  env = { DB: d1(migratedDatabase()), REGISTRY_BLOBS: new FakeR2Bucket() } as unknown as Env;
});

async function purgedRow(cls: string, name: string) {
  return env.DB.prepare(
    "SELECT purged_at, purge_reason, storage_bytes, retiring_at FROM do_instances WHERE class = ? AND name = ?",
  )
    .bind(cls, name)
    .first<{ purged_at: string | null; purge_reason: string | null; retiring_at: string | null }>();
}

/** Each class, holding something and an alarm. */
const CASES: Record<string, () => Promise<Built>> = {
  async Tracker() {
    const { ctx } = fakeDurableState();
    const object = new Tracker(ctx, env);
    // Its schema alone is storage; an alarm too.
    await ctx.storage.setAlarm(Date.now() + 60_000);
    return { object, ctx };
  },
  async KnowledgeCoordinator() {
    const { ctx } = fakeDurableState();
    const object = new KnowledgeCoordinator(ctx, env);
    await object.notify("repo_1");
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

  test("CiSandbox: destroys a running container", async () => {
    const container = fakeContainer(true);
    const { ctx } = fakeDurableState({ container });
    await new CiSandbox(ctx, env).purge("job deleted");
    expect(container.destroyed).toBe(1);
    expect(container.running).toBe(false);
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
      const { ctx, aborted } = fakeDurableState();
      await new Tracker(ctx, env).purge("test");
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
    await object.notify("repo_1");
    await ctx.storage.put("state", {
      ...(await ctx.storage.get<object>("state")),
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
