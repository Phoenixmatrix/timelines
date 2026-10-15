import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { FakeD1, FakeR2Bucket } from "@gitmatrix/testing";
import { fakeDurableState } from "../testing/durable-state.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { freshInstallationDatabases } from "../testing/spaces.ts";
import { cleanRefPass, installCutoverTestControl } from "../testing/space-cutover.ts";
import { KnowledgeCoordinator } from "../knowledge/coordinator.ts";
import { StepFeed } from "../steps/feed.ts";
import { Tracker } from "../tracker/object.ts";
import { LoginDO } from "../../registry/do/login-do.ts";
import { RepoDO } from "../../registry/do/repo-do.ts";
import { UploadDO } from "../../registry/do/upload-do.ts";
import { forgetRecorded, touchInstance } from "./registry.ts";
import { CUTOVER_CONSUMERS } from "../space-cutover/control.ts";
import { spaceDigest } from "../../shared/space-cutover.ts";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";

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
  waitUntil: (work: Promise<unknown>) => {
    void work.catch(() => {});
  },
}));

const resources: { close(): void }[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) resource.close();
  forgetRecorded();
});

function fixture(fresh?: Awaited<ReturnType<typeof freshInstallationDatabases>>) {
  const database = fresh?.sqlite ?? migratedDatabase();
  resources.push(database);
  const env = { DB: d1(database), REGISTRY_BLOBS: new FakeR2Bucket() } as unknown as Env;
  const journal = installCutoverTestControl(env, fresh?.control);
  resources.push(journal);
  const state = fakeDurableState({ name: "business-instance" });
  resources.push(state.db);
  return { env, journal, state, database };
}

async function nativeFixture() {
  const fresh = await freshInstallationDatabases();
  const fixtureState = fixture(fresh);
  const { registry } = fresh;
  resources.push(registry);
  Reflect.set(fixtureState.env, "REGISTRY_DB", d1(registry));
  await initializeFreshSpaceInstallation(fixtureState.env);
  return fixtureState;
}

const login = () => ({
  status: "pending" as const,
  doneSecretHash: "secret-hash",
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  repo: "npm",
});

const step = {
  repo: "orbit/app",
  timeline: "work",
  changeId: "change",
  commitOid: "a".repeat(40),
  summary: "Work",
  issue: null,
  author: { id: "person", kind: "person" as const, name: "Person" },
  tests: null,
  why: "",
  committedAt: "2026-10-11T00:00:00.000Z",
};

describe("autonomous business admission", () => {
  test("runtime probes never admit or initialize business state", async () => {
    const { env, journal, state } = fixture();
    const run = await journal.fence();
    const before = state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    const probes = [
      new LoginDO(state.ctx, env),
      new UploadDO(state.ctx, env),
      new RepoDO(state.ctx, env),
      new KnowledgeCoordinator(state.ctx, env),
      new StepFeed(state.ctx, env),
      new Tracker(state.ctx, env),
    ];
    for (const object of probes) {
      // The real journal rejects this phase: a probe never invents approval or
      // silently turns an ordinary closed fence into a successful attestation.
      await expect(object.cutoverRuntime(run.runId)).rejects.toThrow();
    }
    expect(journal.control.status()?.runtimeConsumers).toEqual({});
    expect(journal.control.activeTickets()).toEqual([]);
    expect(state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(
      before,
    );
  });

  test("current DO producers cannot attest a restored legacy3 release", async () => {
    const { env, journal, state } = fixture();
    const registry = new FakeD1();
    registry.applySql(
      "CREATE TABLE _space_cutover_fence(id INTEGER PRIMARY KEY,run_id TEXT,migration_epoch INTEGER,manifest_digest TEXT,authority_token TEXT NOT NULL DEFAULT '',fenced INTEGER NOT NULL DEFAULT 0,bypass INTEGER NOT NULL DEFAULT 0);INSERT INTO _space_cutover_fence(id) VALUES(1);",
    );
    Reflect.set(env, "REGISTRY_DB", registry);
    const run = await journal.fence();
    await journal.control.fenceDatabases(run.runId);
    journal.control.recordDrainInspection(run.runId, {
      preparationVersionId: run.preparationVersionId,
      blockers: [],
    });
    for (const consumer of CUTOVER_CONSUMERS)
      journal.control.acknowledge(run.runId, consumer, run.checkpoint, 3);
    cleanRefPass(journal.control, run.runId, "fenced");
    journal.control.beginMigration(run.runId);
    journal.control.recordPreflight(run.runId);
    const stores = [
      "application",
      "registry",
      ...run.manifest.mapping.map(({ space }) => `tracker:${space.id}`),
    ];
    // Protocol-state fixture only: participant conversion is exercised by the
    // participant suites. Runtime attestations below invoke the actual DOs.
    for (const storeId of stores) {
      const payload = JSON.stringify({ storeId, fixture: "protocol checkpoint" });
      const digest = await spaceDigest(payload);
      journal.control.recordInventory(run.runId, { storeId, digest, counts: { business: 0 } });
      await journal.control.storePage(run.runId, storeId, 0, {
        cursor: null,
        nextCursor: null,
        payload,
        digest,
      });
      journal.control.recordStore(run.runId, storeId, "exported");
    }
    journal.control.recover(run.runId);
    await journal.control.establishRecoveryFences(run.runId);
    for (const storeId of stores) journal.control.recordStore(run.runId, storeId, "restored");
    journal.control.finishRestore(run.runId, stores);
    journal.control.approveRelease(
      run.runId,
      run.checkpoint,
      run.preparationVersionId,
      "legacy",
      "human",
    );
    const before = state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all();
    const probes = [
      new LoginDO(state.ctx, env),
      new UploadDO(state.ctx, env),
      new RepoDO(state.ctx, env),
      new KnowledgeCoordinator(state.ctx, env),
      new StepFeed(state.ctx, env),
      new Tracker(state.ctx, env),
    ];
    for (const object of probes) {
      await expect(object.cutoverRuntime(run.runId)).rejects.toThrow();
      expect(journal.control.status()?.runtimeConsumers).toEqual({});
    }
    const staleProducer = { ...env, CI_VERSION: { ...env.CI_VERSION, id: "stale-runtime" } };
    await expect(new LoginDO(state.ctx, staleProducer).cutoverRuntime(run.runId)).rejects.toThrow();
    Reflect.deleteProperty(staleProducer, "CUTOVER_DEPLOYMENT_CHECKPOINT");
    await expect(new LoginDO(state.ctx, staleProducer).cutoverRuntime(run.runId)).rejects.toThrow();
    expect(journal.control.admission(3).allowed).toBe(false);
    expect(journal.control.activeTickets()).toEqual([]);
    expect(state.db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(
      before,
    );
  });

  test("a closed fence denies login, upload, repository, coordinator, feed and tracker mutations", async () => {
    const { env, journal, state } = fixture();
    await state.ctx.storage.put("sentinel", { preserved: true });
    const before = [...(await state.ctx.storage.list())];
    await journal.fence();
    const operations = [
      () => new LoginDO(state.ctx, env).start(login()),
      () => new UploadDO(state.ctx, env).putState({ version: 1 }, null),
      () => new RepoDO(state.ctx, env).requestRebuild("feed"),
      () =>
        new KnowledgeCoordinator(state.ctx, env).notify("repo", {
          authorization: {
            spaceId: "test-person",
            migrationEpoch: 1,
            personId: "test-person",
            agentId: null,
            credential: { kind: "token", id: "unconsumed-fenced-credential" },
          },
        }),
      () =>
        new StepFeed(state.ctx, env).publish(
          "repo",
          {
            spaceId: "test-person",
            migrationEpoch: 1,
            personId: "test-person",
            agentId: null,
            credential: { kind: "token", id: "unconsumed-fenced-credential" },
          },
          step,
        ),
      () =>
        new Tracker(state.ctx, env).chronicleFixture([], [], {
          issues: 1,
          days: 1,
          end: Date.now(),
          seed: 1,
          team: "TEST",
        }),
    ];
    for (const operation of operations) {
      await expect(operation()).rejects.toThrow("space_cutover_fenced");
      expect([...(await state.ctx.storage.list())]).toEqual(before);
    }
    expect(journal.control.activeTickets()).toEqual([]);
    expect(state.db.prepare("SELECT name FROM sqlite_master WHERE name='teams'").all()).toEqual([]);
  });

  test("purge and retirement permissions cannot bypass a closed fence", async () => {
    const { env, journal, state } = fixture();
    await state.ctx.storage.put("state", login());
    const objects = [
      new LoginDO(state.ctx, env),
      new UploadDO(state.ctx, env),
      new RepoDO(state.ctx, env),
      new KnowledgeCoordinator(state.ctx, env),
      new StepFeed(state.ctx, env),
      new Tracker(state.ctx, env),
    ];
    const before = await state.ctx.storage.get("state");
    await journal.fence();
    for (const object of objects) {
      await expect(object.purge("operator purge")).rejects.toThrow("space_cutover_fenced");
      await expect(object.retire("operator retirement", "business-instance")).rejects.toThrow(
        "space_cutover_fenced",
      );
    }
    expect(await state.ctx.storage.get("state")).toEqual(before);
    expect(await state.ctx.storage.getAlarm()).toBeNull();
  });

  test("a fenced alarm retains its intended expiration and schedules another wake", async () => {
    const { env, journal, state } = fixture();
    // A pending legacy alarm survives deployment; no current-v4 startup is
    // allowed under the old installation's authority.
    await state.ctx.storage.put("state", login());
    const object = new LoginDO(state.ctx, env);
    const before = await state.ctx.storage.get("state");
    await journal.fence();
    await state.ctx.storage.deleteAlarm(); // The runtime consumes the fired alarm.
    await object.alarm();
    expect(await state.ctx.storage.get("state")).toEqual(before);
    expect(await state.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    expect(journal.control.activeTickets()).toEqual([]);
  });

  test("an unavailable control preserves alarm intent and expiration resumes when control returns", async () => {
    const { env, state } = await nativeFixture();
    const object = new LoginDO(state.ctx, env);
    await object.start(login());
    const control = env.SPACE_CUTOVER;
    Reflect.deleteProperty(env, "SPACE_CUTOVER");
    await state.ctx.storage.deleteAlarm();
    await expect(object.alarm()).rejects.toThrow(
      "Missing independent Space cutover control binding",
    );
    expect(await state.ctx.storage.get("state")).toBeDefined();
    expect(await state.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    Reflect.set(env, "SPACE_CUTOVER", control);
    await state.ctx.storage.deleteAlarm();
    await object.alarm();
    expect(await state.ctx.storage.get("state")).toBeUndefined();
  });

  test("a late coordinator publication holds its ticket through control loss and finishes before release", async () => {
    const { env, journal, state } = await nativeFixture();
    const coordinator = new KnowledgeCoordinator(state.ctx, env);
    await state.ctx.storage.put("state", { running: { buildId: "build" } });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const put = state.ctx.storage.put.bind(state.ctx.storage);
    vi.spyOn(state.ctx.storage, "put").mockImplementationOnce(async (...args: unknown[]) => {
      entered.resolve();
      await finish.promise;
      await Reflect.apply(put, state.ctx.storage, args);
    });
    const publication = coordinator.finished("build", true, null);
    try {
      await Promise.race([
        entered.promise,
        publication.then(() => {
          throw new Error("Coordinator finished without entering delayed publication");
        }),
      ]);
      expect(journal.control.activeTickets()).toMatchObject([
        { consumer: "knowledge-coordinator" },
      ]);
      Reflect.deleteProperty(env, "SPACE_CUTOVER");
      await expect(coordinator.pagesFinished("late-build")).rejects.toThrow(
        "Missing independent Space cutover control binding",
      );
      expect(journal.control.activeTickets()).toHaveLength(1);
    } finally {
      finish.resolve();
      await publication;
    }
    expect(await state.ctx.storage.get("state")).toMatchObject({ running: null, lastError: null });
    expect(journal.control.activeTickets()).toEqual([]);
  });

  test("native background instance recording cannot write after the fence closes", async () => {
    const { env, journal, database } = fixture();
    await journal.fence();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    touchInstance(env, "Tracker", "late-instance");
    await vi.waitFor(() => expect(warning).toHaveBeenCalled());
    expect(database.prepare("SELECT name FROM do_instances").all()).toEqual([]);
    expect(journal.control.activeTickets()).toEqual([]);
  });
});
