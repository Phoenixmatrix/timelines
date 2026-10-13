import type {
  SpaceMigrationContext,
  SpaceMapping,
  SpaceParticipantGuard,
} from "../../shared/space-cutover.ts";
import {
  createRegistrySpaceMigration,
  createD1SpaceCheckpoint,
  inspectD1SpaceCheckpointStep,
  readBlock,
  assertD1CheckpointProgressBudget,
  type D1InspectionState,
  type D1InventoryState,
  type D1RestoreState,
  type RegistryMigrationState,
  type RegistryReconcileState,
  type SpaceMigrationStep,
} from "../../registry/core/space-migration.ts";
import {
  createApplicationSpaceMigration,
  type ApplicationMigrationState,
  type ApplicationReconcileState,
} from "./application.ts";
import type { CutoverRun, SpaceCutover } from "./control.ts";
import type { Actor } from "../db.ts";
import { peekStub } from "../durable/registry.ts";
import { migrationDatabase } from "./storage-fence.ts";
import {
  transformCanonicalCheckpointStep,
  type CanonicalTransformState,
} from "./canonical-transform.ts";
import { buildCanonicalD1Schema } from "./canonical-schema.ts";

export function migrationContext(run: CutoverRun, mapping: SpaceMapping): SpaceMigrationContext {
  return {
    runId: run.runId,
    migrationEpoch: run.migrationEpoch,
    manifestDigest: run.manifestDigest,
    legacyOwnerId: mapping.legacyOwner.id,
    spaceId: mapping.space.id,
    organizationId: mapping.organization.id,
    spaceSlug: mapping.space.slug,
    contractVersion: 4,
  };
}

/** Exactly one bounded, independently journaled participant unit per request. */
export async function advanceSpaceCutover(
  env: Env,
  journal: SpaceCutover,
  actor: Actor,
): Promise<void> {
  const run = journal.status();
  if (!run || !["migrating", "recovering"].includes(run.phase))
    throw new Error("Cutover is not ready to advance");
  if (run.phase === "recovering" && !run.recoveryFencesReady) {
    await journal.establishRecoveryFences(run.runId);
    return;
  }
  const guard: SpaceParticipantGuard = async (context, operation) => {
    journal.assertParticipant(context, operation);
  };
  const mappings = run.manifest.mapping.toSorted(
    (a, b) =>
      Number(b.space.id === b.organization.defaultSpaceId) -
      Number(a.space.id === a.organization.defaultSpaceId),
  );
  const first = migrationContext(run, mappings[0]!);
  const operation = run.phase === "recovering" ? "restore" : "migrate";
  const database = migrationDatabase(env.DB, first, operation, guard, run.authorityToken);
  const registryDatabase = migrationDatabase(
    env.REGISTRY_DB,
    first,
    operation,
    guard,
    run.authorityToken,
  );
  const application = createApplicationSpaceMigration(database, registryDatabase, guard);
  const registry = createRegistrySpaceMigration(database, registryDatabase, guard);
  const stores = [
    "application",
    "registry",
    ...mappings.map((mapping) => `tracker:${mapping.space.id}`),
  ];
  const readPages = (store: string) => async (cursor: string | null) =>
    journal.pageAtCursor(run.runId, store, cursor);
  async function step<S, R>(
    key: string,
    work: (state: S | null) => Promise<SpaceMigrationStep<S, R>>,
    checkpointStore?: string,
  ): Promise<{ done: false } | { done: true; result: R }> {
    const saved = journal.workState(run!.runId, key);
    const previous = saved
      ? (JSON.parse(saved) as { done: false; state: S } | { done: true; result: R })
      : null;
    if (previous?.done) return previous;
    const result = await work(previous?.state ?? null);
    const { page, ...progress } = result;
    if (page && !checkpointStore) throw new Error("Checkpoint page lacks an immutable archive");
    if (page && checkpointStore) {
      const ordinal =
        journal.pageOrdinal(run!.runId, checkpointStore, page.cursor) ??
        journal.checkpointPosition(run!.runId, checkpointStore).ordinal;
      await journal.storePage(run!.runId, checkpointStore, ordinal, page);
    }
    const persisted = progress.done ? { done: true as const, result: progress.result } : progress;
    journal.recordWorkState(run!.runId, key, JSON.stringify(persisted));
    return persisted;
  }
  function completed(key: string): boolean {
    const saved = journal.workState(run!.runId, key);
    if (!saved) return false;
    const value: unknown = JSON.parse(saved);
    if (
      !value ||
      typeof value !== "object" ||
      !("done" in value) ||
      typeof value.done !== "boolean"
    )
      throw new Error("Invalid persisted work envelope");
    return value.done;
  }
  if (run.phase === "recovering") {
    const store = [
      "registry",
      ...stores.filter((id) => id.startsWith("tracker:")),
      "application",
    ].find((id) => !run.stores[id]?.restored);
    if (!store) {
      journal.finishRestore(run.runId, stores);
      return;
    }
    if (store.startsWith("tracker:")) {
      const mapping = mappings.find((mapping) => store === `tracker:${mapping.space.id}`)!;
      const result = await peekStub(env, "Tracker", mapping.trackerDoName).spaceMigrationRestore(
        migrationContext(run, mapping),
      );
      if (!result.preserved) throw new Error("Tracker restoration did not reconcile");
      journal.recordStore(run.runId, store, "restored");
      return;
    }
    if (!run.stores[store]?.exported) {
      // The coordinator never issues ANY business transformation until EVERY
      // checkpoint is complete. An interrupted preparation therefore needs no
      // invented snapshot or inverse mutation for an unexported D1 store.
      if (run.completedMappings.length || Object.values(run.stores).some((state) => state.migrated))
        throw new Error("Modified business store lacks a recoverable checkpoint");
      journal.recordStore(run.runId, store, "restored");
      return;
    }
    const baseline = run.inventories[store];
    if (!baseline) throw new Error("Original inventory is missing");
    const checkpoint = createD1SpaceCheckpoint(
      store === "application" ? database : registryDatabase,
      store,
      guard,
    );
    const result = await step(`${store}:restore`, (state: D1RestoreState | null) =>
      checkpoint.restoreStep(first, readPages(store), state, baseline.digest),
    );
    if (result.done) {
      if (!result.result.preserved || result.result.digest !== baseline.digest)
        throw new Error("Restored store differs from original checkpoint");
      journal.recordStore(run.runId, store, "restored");
    }
    return;
  }
  if (!run.preflightComplete) {
    await application.preflight(first, run.manifest);
    journal.recordPreflight(run.runId);
    return;
  }
  for (const store of stores) {
    if (run.stores[store]?.exported) continue;
    if (store === "application" || store === "registry") {
      const participant = store === "application" ? application : registry;
      const result = await step(
        `${store}:inventory`,
        (state: D1InventoryState | null) => participant.inventoryStep(first, state),
        store,
      );
      if (result.done) {
        journal.recordInventory(run.runId, result.result);
        journal.recordStore(run.runId, store, "exported");
      }
      return;
    }
    const mapping = mappings.find((mapping) => store === `tracker:${mapping.space.id}`)!;
    const tracker = peekStub(env, "Tracker", mapping.trackerDoName);
    const context = migrationContext(run, mapping);
    if (!run.inventories[store]) {
      journal.recordInventory(run.runId, await tracker.spaceMigrationInventory(context));
      return;
    }
    const position = journal.checkpointPosition(run.runId, store);
    if (position.complete) {
      journal.recordStore(run.runId, store, "exported");
      return;
    }
    const page = await tracker.spaceMigrationExport(context, position.cursor);
    await journal.storePage(run.runId, store, position.ordinal, page);
    if (page.nextCursor === null) journal.recordStore(run.runId, store, "exported");
    return;
  }
  for (const store of ["application", "registry"] as const) {
    const key = `${store}:schema-budget`;
    if (completed(key)) continue;
    await step(key, async () => {
      const original = await readBlock(first, store, readPages(store), null, "", null);
      if (original.block.kind !== "schema") throw new Error("Original checkpoint lacks its schema");
      assertD1CheckpointProgressBudget(
        original.block,
        buildCanonicalD1Schema(original.block, store),
        first,
      );
      return { state: null, done: true, result: null };
    });
    return;
  }
  for (const mapping of mappings) {
    if (run.completedMappings.includes(mapping.space.id)) continue;
    const context = migrationContext(run, mapping);
    const applicationKey = `application:migrate:${mapping.space.id}`;
    if (!completed(applicationKey)) {
      await step(applicationKey, (state: ApplicationMigrationState | null) =>
        application.migrateStep(context, mapping, actor, state),
      );
      return;
    }
    const registryKey = `registry:migrate:${mapping.space.id}`;
    if (!completed(registryKey)) {
      await step(registryKey, (state: RegistryMigrationState | null) =>
        registry.migrateStep(context, state, run.inventories.registry!),
      );
      return;
    }
    const tracker = peekStub(env, "Tracker", mapping.trackerDoName);
    await tracker.spaceMigrationMigrate(context);
    const result = await tracker.spaceMigrationReconcile(context);
    if (!result.preserved) throw new Error("Tracker reconciliation failed");
    journal.recordStore(run.runId, `tracker:${mapping.space.id}`, "migrated");
    journal.recordStore(run.runId, `tracker:${mapping.space.id}`, "reconciled");
    journal.recordMapping(run.runId, mapping.space.id);
    return;
  }
  // First prove the additive mapping preserved every original business byte.
  // Only then archive the full mapped stores and derive a distinct v4 target.
  if (!completed("application:preservation")) {
    await step("application:preservation", (state: ApplicationReconcileState | null) =>
      application.reconcileStep(first, run.manifest, run.inventories.application!.digest, state),
    );
    return;
  }
  if (!completed("registry:preservation")) {
    const result = await step("registry:preservation", (state: RegistryReconcileState | null) =>
      registry.reconcileStep(
        first,
        mappings.map((mapping) => migrationContext(run, mapping)),
        state,
        run.inventories.registry!,
      ),
    );
    if (
      result.done &&
      (!result.result.preserved || result.result.digest !== run.inventories.registry!.digest)
    )
      throw new Error("Registry normalized preservation differs from original inventory");
    return;
  }
  for (const store of ["application", "registry"] as const) {
    if (run.stores[store]?.reconciled) continue;
    const checkpoint = createD1SpaceCheckpoint(
      store === "application" ? database : registryDatabase,
      store,
      guard,
      { purpose: "migrate" },
    );
    const mapped = await step(
      `${store}:mapped-inventory`,
      (state: D1InventoryState | null) => checkpoint.inventoryStep(first, state),
      `${store}:mapped`,
    );
    if (!mapped.done) return;
    const inspected = await step(`${store}:mapped-inspection`, (state: D1InspectionState | null) =>
      inspectD1SpaceCheckpointStep(first, store, readPages(`${store}:mapped`), state),
    );
    if (!inspected.done) return;
    if (inspected.result.digest !== mapped.result.digest)
      throw new Error("Mapped archive differs from its full inventory");
    const target = await step(
      `${store}:canonical-transform-v2`,
      (state: CanonicalTransformState | null) =>
        transformCanonicalCheckpointStep(
          first,
          run.manifest,
          inspected.result,
          readPages(`${store}:mapped`),
          state,
        ),
      `${store}:canonical-v2`,
    );
    if (!target.done) return;
    if (target.result.sourceDigest !== mapped.result.digest)
      throw new Error("Canonical target is not bound to the mapped archive");
    const installed = await step(`${store}:canonical-install-v2`, (state: D1RestoreState | null) =>
      checkpoint.restoreStep(
        first,
        readPages(`${store}:canonical-v2`),
        state,
        target.result.digest,
      ),
    );
    if (installed.done) {
      if (!installed.result.preserved || installed.result.digest !== target.result.digest)
        throw new Error("Installed canonical store differs from its immutable target");
      journal.recordStore(run.runId, store, "migrated");
      journal.recordStore(run.runId, store, "reconciled");
    }
    return;
  }
  journal.complete(run.runId, stores);
}
