import type { DatabaseSync } from "node:sqlite";
import { SpaceCutover, type RefReconciliationStage } from "../space-cutover/control.ts";
import { fakeDurableState } from "./durable-state.ts";
import type { SpaceManifest } from "../../shared/space-cutover.ts";
import { d1, migratedDatabase, migratedRegistryDatabase } from "./d1.ts";

export const CUTOVER_TEST_CHECKPOINT = "a".repeat(40);

/** Uses the real journal and SQLite, never a production missing-binding bypass. */
export function installCutoverTestControl(env: Env, db?: DatabaseSync) {
  const state = fakeDurableState({ name: "instance", db });
  Reflect.set(env, "CUTOVER_DEPLOYMENT_CHECKPOINT", CUTOVER_TEST_CHECKPOINT);
  Reflect.set(env, "CI_VERSION", {
    id: "cutover-test-version",
    tag: CUTOVER_TEST_CHECKPOINT,
    timestamp: "2026-10-11T00:00:00.000Z",
  });
  const control = new SpaceCutover(state.ctx, env);
  Reflect.set(env, "SPACE_CUTOVER", {
    getByName(name: string) {
      if (name !== "instance") throw new Error("Unexpected control journal name");
      return control;
    },
  });
  return {
    control,
    state,
    close: () => state.db.close(),
    async fence(manifest: SpaceManifest = cutoverTestManifest()) {
      const run = await control.prepare(
        manifest,
        CUTOVER_TEST_CHECKPOINT,
        "test-human",
        "test-recovery-digest",
      );
      control.approve(run.runId, run.manifestDigest, run.checkpoint, "test-human");
      control.fence(run.runId);
      return run;
    },
  };
}

/** A complete clean ref pass for a protocol fixture with no repositories to list.
 * ref-barrier.test.ts exercises the actual Artifacts listing and repair. */
export function cleanRefPass(
  control: SpaceCutover,
  runId: string,
  stage: RefReconciliationStage,
): void {
  const pass = control.refPass(runId, stage);
  if (!pass.complete) control.recordRefPage(runId, pass.pass, pass.cursor, null, []);
}

/** Original application/registry schemas for the actual pre-cutover operator protocol. */
export function createLegacyCutoverTestEnvironment() {
  const sqlite = migratedDatabase();
  const registry = migratedRegistryDatabase();
  const env = { DB: d1(sqlite), REGISTRY_DB: d1(registry) } as Env;
  const journal = installCutoverTestControl(env);
  return {
    env,
    sqlite,
    registry,
    control: journal.control,
    close() {
      journal.close();
      sqlite.close();
      registry.close();
    },
  };
}

export function cutoverTestManifest(): SpaceManifest {
  return {
    manifestVersion: 1,
    contentContractVersion: 4,
    source: "isolated-test",
    sourceCommit: CUTOVER_TEST_CHECKPOINT,
    mapping: [
      {
        legacyOwner: { id: "test-person", kind: "user", slug: "test-person" },
        organization: {
          id: "test-organization",
          slug: "test-person",
          displayName: "Test personal Organization",
          kind: "personal",
          personalAccountId: "test-person",
          defaultSpaceId: "test-person",
        },
        space: {
          id: "test-person",
          organizationId: "test-organization",
          slug: "test-person",
          displayName: "General",
          archived: false,
        },
        organizationMembers: [{ accountId: "test-person", role: "owner" }],
        spaceGrants: [
          {
            accountId: "test-person",
            role: "admin",
            repositoryRole: "write",
            packageRole: "write",
            origin: "legacy-personal-owner",
          },
        ],
        trackerDoName: "test-person",
        repositories: [],
        repositoryCollaborators: [],
        registryFeeds: [],
        providers: [],
        hasContentSettings: false,
      },
    ],
  };
}
