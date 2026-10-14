import { describe, expect, test, vi } from "vite-plus/test";
import { FakeD1 } from "@gitmatrix/testing";
import { SpaceCutover, CUTOVER_CONSUMERS, admissionFor, type CutoverRun } from "./control.ts";
import {
  cleanRefPass,
  installCutoverTestControl,
  cutoverTestManifest,
  CUTOVER_TEST_CHECKPOINT,
} from "../testing/space-cutover.ts";
import { migrationContext } from "./engine.ts";
import { spaceDigest } from "../../shared/space-cutover.ts";
import type { SpaceMigrationContext } from "../../shared/space-cutover.ts";
import { fakeDurableState } from "../testing/durable-state.ts";
import { Tracker } from "../tracker/object.ts";

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
function fixture() {
  const db = new FakeD1();
  const registry = new FakeD1();
  const ddl =
    "CREATE TABLE _space_cutover_fence(id INTEGER PRIMARY KEY,run_id TEXT,migration_epoch INTEGER,manifest_digest TEXT,authority_token TEXT NOT NULL DEFAULT '',fenced INTEGER NOT NULL DEFAULT 0,bypass INTEGER NOT NULL DEFAULT 0);INSERT INTO _space_cutover_fence(id) VALUES(1);CREATE TABLE business(id TEXT PRIMARY KEY);";
  db.applySql(ddl);
  registry.applySql(ddl);
  const env = { DB: db, REGISTRY_DB: registry } as unknown as Env;
  return { env, ...installCutoverTestControl(env) };
}
async function journalAtReconciled(f: { control: SpaceCutover; fence: () => Promise<CutoverRun> }) {
  const run = await f.fence();
  await f.control.fenceDatabases(run.runId);
  f.control.recordDrainInspection(run.runId, {
    preparationVersionId: run.preparationVersionId,
    blockers: [],
  });
  for (const consumer of CUTOVER_CONSUMERS)
    f.control.acknowledge(run.runId, consumer, run.checkpoint, 3);
  cleanRefPass(f.control, run.runId, "fenced");
  f.control.beginMigration(run.runId);
  f.control.recordPreflight(run.runId);
  const stores = ["application", "registry", `tracker:${run.manifest.mapping[0]!.space.id}`];
  // State-machine fixtures represent already exercised participants; actual
  // schema/data conversion and recovery are covered by participant tests.
  for (const storeId of stores) {
    const payload = JSON.stringify({ storeId, fixture: "protocol checkpoint" });
    f.control.recordInventory(run.runId, {
      storeId,
      digest: await spaceDigest(payload),
      counts: { business: 0 },
    });
    await f.control.storePage(run.runId, storeId, 0, {
      cursor: null,
      nextCursor: null,
      payload,
      digest: await spaceDigest(payload),
    });
    f.control.recordStore(run.runId, storeId, "exported");
  }
  for (const storeId of stores) {
    f.control.recordStore(run.runId, storeId, "migrated");
    f.control.recordStore(run.runId, storeId, "reconciled");
  }
  f.control.recordMapping(run.runId, run.manifest.mapping[0]!.space.id);
  f.control.complete(run.runId, stores);
  cleanRefPass(f.control, run.runId, "pre-open");
  return run;
}

describe("independent durable cutover control journal", () => {
  test("caller manifest approval fields cannot approve anything and exact checkpoint/digest are required", async () => {
    const f = fixture();
    const manifest = {
      ...cutoverTestManifest(),
      approval: { operator: "caller", approvedAt: "now" },
    };
    const run = await f.control.prepare(
      manifest,
      CUTOVER_TEST_CHECKPOINT,
      "human",
      await spaceDigest("private-capability"),
    );
    expect(() => f.control.fence(run.runId)).toThrow("approval");
    expect(() => f.control.approve(run.runId, "changed", run.checkpoint, "human")).toThrow(
      "does not match",
    );
    expect(() => f.control.approve(run.runId, run.manifestDigest, "b".repeat(40), "human")).toThrow(
      "does not match",
    );
    f.control.approve(run.runId, run.manifestDigest, run.checkpoint, "human");
    f.control.fence(run.runId);
    expect(f.control.admission().allowed).toBe(false);
    expect(await f.control.authorizeRecovery("private-capability")).toBe(true);
    expect(await f.control.authorizeRecovery("other")).toBe(false);
    f.close();
  });
  test("persisted tickets never expire and prevent acknowledgement until explicit completion", async () => {
    const f = fixture();
    const ticket = f.control.acquire("http-git-registry", 3);
    const run = await f.fence();
    const cold = new SpaceCutover(f.state.ctx, f.env);
    expect(cold.activeTickets()).toHaveLength(1);
    expect(() => cold.acquire("queue", 3)).toThrow("fenced");
    expect(() => cold.acknowledge(run.runId, "http-git-registry", run.checkpoint, 3)).toThrow(
      "acknowledgement",
    );
    cold.assertTicket(ticket.ticket, ticket.epoch, 3);
    cold.release(ticket.ticket);
    cold.release(ticket.ticket);
    cold.acknowledge(run.runId, "http-git-registry", run.checkpoint, 3);
    expect(() => cold.beginMigration(run.runId)).toThrow("drain");
    f.close();
  });
  test("mismatched epochs and incomplete checkpoints cannot transform or reconcile", async () => {
    const f = fixture();
    const run = await f.fence();
    const context = migrationContext(run, run.manifest.mapping[0]!);
    expect(() => f.control.assertParticipant({ ...context, migrationEpoch: 2 }, "export")).toThrow(
      "authority",
    );
    expect(() => f.control.assertParticipant(context, "migrate")).toThrow("fenced");
    expect(() => f.control.complete(run.runId, ["application"])).toThrow("set mismatch");
    expect(() => f.control.recordStore(run.runId, "application", "exported")).toThrow("checkpoint");
    f.close();
  });
  test("runtime compatibility cannot acknowledge preparation quiescence or clear the legacy barrier", async () => {
    const f = fixture();
    const run = await f.fence();
    await f.control.fenceDatabases(run.runId);
    expect(() =>
      f.control.acknowledgeRuntime(run.runId, "queue", 3, {
        versionId: run.preparationVersionId,
        checkpoint: run.checkpoint,
      }),
    ).toThrow("attestation boundary");
    await expect(
      f.control.reserveWorkflowRuntimeProbe(
        run.runId,
        "CI_RUN",
        run.preparationVersionId,
        run.checkpoint,
      ),
    ).rejects.toThrow("attestation boundary");
    expect(f.control.status()?.consumers).toEqual({});
    expect(f.control.status()?.runtimeConsumers).toEqual({});
    expect(f.control.status()?.drainBlockers).toContain("drain_inspection_required");
    expect(() => f.control.beginMigration(run.runId)).toThrow("drain");
    f.close();
  });
  test("new-epoch admission is recorded before D1 opening and failed opening is forward-only on cold resume", async () => {
    const f = fixture();
    const run = await journalAtReconciled(f);
    const checkpoint = "b".repeat(40);
    const versionId = "reviewed-v4";
    f.control.approveRelease(run.runId, checkpoint, versionId, "space", "human");
    await expect(f.control.openWriteAdmission(run.runId)).rejects.toThrow("release");
    Reflect.set(f.env, "CUTOVER_DEPLOYMENT_CHECKPOINT", checkpoint);
    Reflect.set(f.env, "CI_VERSION", { id: versionId, tag: checkpoint });
    expect(() =>
      f.control.acknowledgeRuntime(run.runId, "queue", 4, {
        versionId: "different-producer",
        checkpoint,
      }),
    ).toThrow("acknowledgement");
    for (const consumer of CUTOVER_CONSUMERS)
      f.control.acknowledgeRuntime(run.runId, consumer, 4, { versionId, checkpoint });
    const original = f.env.REGISTRY_DB;
    Reflect.set(
      f.env,
      "REGISTRY_DB",
      new Proxy(original, {
        get(target, key) {
          if (key === "prepare")
            return () => {
              throw new Error("injected opening interruption");
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    await expect(f.control.openWriteAdmission(run.runId)).rejects.toThrow("interruption");
    expect(f.control.status()?.writeAdmissionOpenedAt).not.toBeNull();
    expect(() => f.control.recover(run.runId)).toThrow("forward-only");
    expect(() => f.control.acquire("http-git-registry", 4)).toThrow("fenced");
    Reflect.set(f.env, "REGISTRY_DB", original);
    const cold = new SpaceCutover(f.state.ctx, f.env);
    await cold.openWriteAdmission(run.runId);
    expect(cold.admission(4).allowed).toBe(true);
    expect(cold.admission(3).allowed).toBe(false);
    expect(() => cold.acquire("http-git-registry", 3)).toThrow("fenced");
    expect(() => cold.recover(run.runId)).toThrow("forward-only");
    Reflect.set(f.env, "CUTOVER_DEPLOYMENT_CHECKPOINT", "c".repeat(40));
    Reflect.set(f.env, "CI_VERSION", { id: "later-compatible-release", tag: "c".repeat(40) });
    const updated = new SpaceCutover(f.state.ctx, f.env);
    expect(updated.admission(4)).toEqual({ allowed: true, epoch: run.migrationEpoch });
    expect(updated.admission(5).allowed).toBe(false);
    const ticket = cold.acquire("http-git-registry", 4);
    cold.release(ticket.ticket);
    f.close();
  });
  test("pre-admission coordinated restoration preserves control history and stays closed", async () => {
    const f = fixture();
    const run = await journalAtReconciled(f);
    f.control.recover(run.runId);
    await f.control.establishRecoveryFences(run.runId);
    const stores = Object.keys(f.control.status()!.stores);
    for (const store of stores) f.control.recordStore(run.runId, store, "restored");
    f.control.finishRestore(run.runId, stores);
    expect(f.control.status()?.phase).toBe("restored");
    expect(f.control.admission().allowed).toBe(false);
    expect(f.control.status()?.approval?.manifestDigest).toBe(run.manifestDigest);
    await expect(f.control.openWriteAdmission(run.runId)).rejects.toThrow("release");
    f.close();
  });
  test("partial preparation fencing can recover unchanged stores, reopen only after participant release, and start a fresh preserved epoch", async () => {
    const f = fixture();
    const trackerName = cutoverTestManifest().mapping[0]!.trackerDoName;
    const trackerState = fakeDurableState({ name: trackerName });
    Reflect.set(
      trackerState.ctx.id,
      "equals",
      (candidate: DurableObjectId) => candidate.toString() === trackerName,
    );
    let control = f.control;
    let failRelease = true;
    Reflect.set(f.env, "TRACKER", {
      idFromName: (name: string) => {
        if (name !== trackerName) throw new Error("Unexpected Tracker identity");
        return trackerState.ctx.id;
      },
      getByName: (name: string) => {
        if (name !== trackerName) throw new Error("Unexpected Tracker instance");
        const tracker = new Tracker(trackerState.ctx, f.env);
        return {
          spaceMigrationRestore: (context: SpaceMigrationContext) =>
            tracker.spaceMigrationRestore(context),
          spaceMigrationReleaseLegacy: (context: SpaceMigrationContext) => {
            expect(control.admission(3).allowed).toBe(false);
            if (failRelease) throw new Error("interrupted participant release");
            return tracker.spaceMigrationReleaseLegacy(context);
          },
        };
      },
    });
    const run = await f.fence();
    const original = f.env.REGISTRY_DB;
    Reflect.set(
      f.env,
      "REGISTRY_DB",
      new Proxy(original, {
        get(target, key) {
          if (key === "prepare")
            return () => {
              throw new Error("interrupted preparation fence");
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    );
    await expect(control.fenceDatabases(run.runId)).rejects.toThrow("interrupted");
    expect(control.status()?.storageFenced).toBe(false);
    control.recover(run.runId);
    Reflect.set(f.env, "REGISTRY_DB", original);
    for (let index = 0; index < 12 && control.status()?.phase !== "restored"; index++) {
      control = new SpaceCutover(f.state.ctx, f.env);
      await control.advance(run.runId, {
        id: "human",
        slug: "human",
        displayName: "Human",
        isSiteAdmin: true,
      });
    }
    expect(control.status()?.phase).toBe("restored");
    expect(control.admission(3).allowed).toBe(false);
    control.approveRelease(run.runId, run.checkpoint, run.preparationVersionId, "legacy", "human");
    cleanRefPass(control, run.runId, "pre-open");
    for (const consumer of CUTOVER_CONSUMERS)
      control.acknowledgeRuntime(run.runId, consumer, 3, {
        versionId: run.preparationVersionId,
        checkpoint: run.checkpoint,
      });
    await expect(control.openWriteAdmission(run.runId)).rejects.toThrow("participant release");
    expect(control.status()?.phase).toBe("opening-legacy");
    expect(control.admission(3).allowed).toBe(false);
    failRelease = false;
    control = new SpaceCutover(f.state.ctx, f.env);
    await control.openWriteAdmission(run.runId);
    expect(control.admission(3).allowed).toBe(true);
    expect(control.status()?.writeAdmissionOpenedAt).toBeNull();
    const next = await control.prepare(
      cutoverTestManifest(),
      run.checkpoint,
      "human",
      await spaceDigest("new-private-capability"),
    );
    expect(next.migrationEpoch).toBe(run.migrationEpoch + 1);
    expect(next.runId).not.toBe(run.runId);
    expect(next.approval).toBeNull();
    expect(control.historicalRun(run.runId)?.phase).toBe("legacy-active");
    expect(() => control.approve(run.runId, run.manifestDigest, run.checkpoint, "human")).toThrow();
    f.close();
    trackerState.db.close();
  });
});

describe("absorbing contract-4 admission (CORE-439)", () => {
  async function journalAtActive(f: ReturnType<typeof fixture>) {
    const run = await journalAtReconciled(f);
    const checkpoint = "b".repeat(40);
    const versionId = "reviewed-v4";
    f.control.approveRelease(run.runId, checkpoint, versionId, "space", "human");
    Reflect.set(f.env, "CUTOVER_DEPLOYMENT_CHECKPOINT", checkpoint);
    Reflect.set(f.env, "CI_VERSION", { id: versionId, tag: checkpoint });
    for (const consumer of CUTOVER_CONSUMERS)
      f.control.acknowledgeRuntime(run.runId, consumer, 4, { versionId, checkpoint });
    await f.control.openWriteAdmission(run.runId);
    return run;
  }

  test("an open run refuses every transition that would close admission or move its epoch", async () => {
    const f = fixture();
    const run = await journalAtActive(f);
    const open = f.control.admission(4);
    expect(open).toEqual({ allowed: true, epoch: run.migrationEpoch });
    expect(admissionFor(f.control.status(), null, 4)).toEqual(open);
    const id = run.runId;
    const stores = Object.keys(f.control.status()!.stores);
    const human = { id: "human", slug: "human", displayName: "Human", isSiteAdmin: true };
    const attempts: [string, () => unknown][] = [
      ["prepare", () => f.control.prepare(cutoverTestManifest(), run.checkpoint, "human", "x")],
      ["approve", () => f.control.approve(id, run.manifestDigest, run.checkpoint, "human")],
      ["fence", () => f.control.fence(id)],
      ["fenceDatabases", () => f.control.fenceDatabases(id)],
      ["recover", () => f.control.recover(id)],
      ["establishRecoveryFences", () => f.control.establishRecoveryFences(id)],
      ["finishRestore", () => f.control.finishRestore(id, stores)],
      ["beginMigration", () => f.control.beginMigration(id)],
      ["complete", () => f.control.complete(id, stores)],
      ["recordStore", () => f.control.recordStore(id, "application", "restored")],
      ["approveRelease", () => f.control.approveRelease(id, "c".repeat(40), "v", "space", "h")],
      ["openWriteAdmission", () => f.control.openWriteAdmission(id)],
      ["advance", () => f.control.advance(id, human)],
      ["advanceFreshInstallation", () => f.control.advanceFreshInstallation(null)],
    ];
    for (const [name, attempt] of attempts) {
      const outcome = await Promise.resolve()
        .then(attempt)
        .then(
          () => "returned",
          () => "refused",
        );
      expect([name, outcome]).toEqual([name, "refused"]);
      expect(f.control.admission(4)).toEqual(open);
    }
    expect(f.control.status()?.phase).toBe("active");
    f.close();
  });

  test("the journal itself refuses a write that closes open admission or moves its epoch", async () => {
    const f = fixture();
    const run = await journalAtActive(f);
    const save = (value: CutoverRun) =>
      (Reflect.get(f.control, "save") as (run: CutoverRun) => void).call(f.control, value);
    const current = f.control.status()!;
    for (const changed of [
      { ...current, phase: "fenced" as const },
      { ...current, migrationEpoch: current.migrationEpoch + 1 },
      { ...current, writeAdmissionOpenedAt: null },
      { ...current, releaseApproval: { ...current.releaseApproval!, mode: "legacy" as const } },
    ])
      expect(() => save(changed)).toThrow("space_cutover_admission_absorbing");
    // A write that keeps admission open at the same epoch is still journaled.
    save({ ...current, drainBlockers: [] });
    expect(f.control.status()?.drainBlockers).toEqual([]);
    expect(f.control.admission(4)).toEqual({ allowed: true, epoch: run.migrationEpoch });
    f.close();
  });
});
