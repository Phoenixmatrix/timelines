import { describe, expect, test } from "vite-plus/test";
import { FakeD1 } from "@gitmatrix/testing";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createApplicationSpaceMigration,
  validateApplicationMapping,
  type ApplicationMigrationState,
  type ApplicationReconcileState,
} from "./application.ts";
import type {
  D1InventoryState,
  D1RestoreState,
  SpaceMigrationStep,
} from "../../registry/core/space-migration.ts";
import {
  type SpaceManifest,
  type SpaceMapping,
  type SpaceMigrationContext,
  type SpaceCheckpointPage,
} from "../../shared/space-cutover.ts";
import { fenceBusinessDatabase, migrationDatabase } from "./storage-fence.ts";

function database(relative: string): D1Database {
  const fake = new FakeD1();
  const directory = fileURLToPath(new URL(relative, import.meta.url).href);
  for (const file of readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort())
    fake.applySql(readFileSync(`${directory}/${file}`, "utf8"));
  return fake as unknown as D1Database;
}
async function fixture() {
  const db = database("../../migrations/");
  const registry = database("../../registry/migrations/");
  await db.batch([
    db.prepare(
      "INSERT INTO accounts(id,kind,slug,display_name,is_site_admin) VALUES('person','user','person','Person',1)",
    ),
    db.prepare(
      "INSERT INTO accounts(id,kind,slug,display_name,member_repo_role) VALUES('group','org','group','Group','none')",
    ),
    db.prepare("INSERT INTO org_members(org_id,user_id,role) VALUES('group','person','member')"),
  ]);
  // Group has a separate legitimate owner; the none-baseline member never gains
  // repository read or package write simply because it can work in the Tracker.
  await db.batch([
    db.prepare(
      "INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner')",
    ),
    db.prepare("INSERT INTO org_members(org_id,user_id,role) VALUES('group','owner','owner')"),
  ]);
  const personal = (id: string): SpaceMapping => ({
    legacyOwner: { id, kind: "user", slug: id },
    organization: {
      id: `organization-${id}`,
      slug: id,
      displayName: id,
      kind: "personal",
      personalAccountId: id,
      defaultSpaceId: id,
    },
    space: {
      id,
      organizationId: `organization-${id}`,
      slug: id,
      displayName: "General",
      archived: false,
    },
    organizationMembers: [{ accountId: id, role: "owner" }],
    spaceGrants: [
      {
        accountId: id,
        role: "admin",
        repositoryRole: "write",
        packageRole: "write",
        origin: "legacy-personal-owner",
      },
    ],
    trackerDoName: id,
    repositories: [],
    repositoryCollaborators: [],
    registryFeeds: [],
    providers: [],
    hasContentSettings: false,
  });
  const group: SpaceMapping = {
    ...personal("group"),
    legacyOwner: { id: "group", kind: "org", slug: "group" },
    organization: {
      id: "company",
      slug: "company",
      displayName: "Company",
      kind: "company",
      personalAccountId: null,
      defaultSpaceId: "group",
    },
    space: {
      id: "group",
      organizationId: "company",
      slug: "group",
      displayName: "General",
      archived: false,
    },
    organizationMembers: [
      { accountId: "owner", role: "owner" },
      { accountId: "person", role: "member" },
    ],
    spaceGrants: [
      {
        accountId: "owner",
        role: "admin",
        repositoryRole: "write",
        packageRole: "write",
        origin: "legacy-org-membership:owner",
      },
      {
        accountId: "person",
        role: "member",
        repositoryRole: "none",
        packageRole: "read",
        origin: "legacy-org-membership:member",
      },
    ],
  };
  const manifest: SpaceManifest = {
    manifestVersion: 1,
    contentContractVersion: 4,
    source: "https://fixture.invalid",
    sourceCommit: "a".repeat(40),
    mapping: [personal("person"), personal("owner"), group],
  };
  const context = (mapping: SpaceMapping): SpaceMigrationContext => ({
    runId: "run",
    migrationEpoch: 1,
    manifestDigest: "approved-digest",
    legacyOwnerId: mapping.legacyOwner.id,
    spaceId: mapping.space.id,
    organizationId: mapping.organization.id,
    spaceSlug: mapping.space.slug,
    contractVersion: 4,
  });
  let fault = false;
  const guard = async (_context: SpaceMigrationContext, operation: string) => {
    if (fault && operation === "restore") throw new Error("interrupted");
  };
  const storageContext = context(manifest.mapping[0]!);
  const nonce = "application-migration-fixture";
  await fenceBusinessDatabase(db, storageContext, nonce);
  await fenceBusinessDatabase(registry, storageContext, nonce);
  const fencedDb = migrationDatabase(db, storageContext, "migrate", guard, nonce);
  const fencedRegistry = migrationDatabase(registry, storageContext, "migrate", guard, nonce);
  const participant = createApplicationSpaceMigration(fencedDb, fencedRegistry, guard);
  const actor = { id: "person", slug: "person", displayName: "Person", isSiteAdmin: true };
  return {
    db: fencedDb,
    registry: fencedRegistry,
    manifest,
    context,
    participant,
    actor,
    failRestore: (value: boolean) => {
      fault = value;
    },
  };
}

async function drive<S, R>(
  work: (state: S | null) => Promise<SpaceMigrationStep<S, R>>,
  pages?: SpaceCheckpointPage[],
): Promise<R> {
  let state: S | null = null;
  for (let index = 0; index < 20000; index++) {
    const step = await work(state);
    if (step.page) pages?.push(step.page);
    if (step.done) return step.result;
    state = JSON.parse(JSON.stringify(step.state)) as S;
  }
  throw new Error("Bounded participant did not finish");
}

describe("application fenced ownership migration", () => {
  test("preserves complete bytes, independent grants and personal usage through idempotent import and recovery", async () => {
    const f = await fixture();
    await f.db.batch([
      f.db.prepare(
        "INSERT INTO ai_usage(day,account_id,feature,model) VALUES('2026-01-01','person','assistant','model')",
      ),
      f.db.prepare(
        "INSERT INTO ai_usage(day,account_id,feature,model) VALUES('2026-01-01','group','knowledge','model')",
      ),
    ]);
    const context = f.context(f.manifest.mapping[0]!);
    await f.participant.preflight(context, f.manifest);
    const pages: SpaceCheckpointPage[] = [];
    const original = await drive(
      (state: D1InventoryState | null) => f.participant.inventoryStep(context, state),
      pages,
    );
    const digest = original.digest;
    for (const mapping of f.manifest.mapping) {
      await drive((state: ApplicationMigrationState | null) =>
        f.participant.migrateStep(f.context(mapping), mapping, f.actor, state),
      );
      await drive((state: ApplicationMigrationState | null) =>
        f.participant.migrateStep(f.context(mapping), mapping, f.actor, state),
      );
    }
    expect(
      (
        await drive((state: ApplicationReconcileState | null) =>
          f.participant.reconcileStep(context, f.manifest, digest, state),
        )
      ).preserved,
    ).toBe(true);
    expect(
      await f.db
        .prepare(
          "SELECT repository_role,package_role FROM space_grants WHERE space_id='group' AND account_id='person'",
        )
        .first(),
    ).toEqual({ repository_role: "none", package_role: "read" });
    expect(
      await f.db.prepare("SELECT space_id FROM ai_usage WHERE feature='assistant'").first(),
    ).toEqual({ space_id: null });
    expect(
      await f.db.prepare("SELECT space_id FROM ai_usage WHERE feature='knowledge'").first(),
    ).toEqual({ space_id: "group" });
    const reader = async (requested: string | null) => {
      const page = pages.find((page) => page.cursor === requested);
      if (!page) throw new Error("missing checkpoint");
      return page;
    };
    f.failRestore(true);
    await expect(f.participant.restoreStep(context, reader, null, digest)).rejects.toThrow(
      "interrupted",
    );
    f.failRestore(false);
    expect(
      (
        await drive((state: D1RestoreState | null) =>
          f.participant.restoreStep(context, reader, state, digest),
        )
      ).digest,
    ).toBe(digest);
    expect(await f.db.prepare("SELECT count(*) AS n FROM space_grants").first()).toEqual({ n: 0 });
  }, 20_000);
  test("rejects missing owners, changed membership and independent package grant expansion before migration", async () => {
    const f = await fixture();
    await expect(
      validateApplicationMapping(f.db, f.registry, {
        ...f.manifest,
        mapping: f.manifest.mapping.slice(1),
      }),
    ).rejects.toThrow("every legacy owner");
    const changed = structuredClone(f.manifest);
    changed.mapping[2]!.spaceGrants[1]!.packageRole = "write";
    await expect(validateApplicationMapping(f.db, f.registry, changed)).rejects.toThrow(
      "independent legacy grants",
    );
    await f.db.prepare("DELETE FROM org_members WHERE org_id='group' AND user_id='person'").run();
    await expect(validateApplicationMapping(f.db, f.registry, f.manifest)).rejects.toThrow(
      "membership changed",
    );
  });
  test("cold-resumable inventory, import, reconciliation and recovery of more than 1000 rows stay below an invocation query budget", async () => {
    const f = await fixture();
    for (let offset = 0; offset < 1100; offset += 100)
      await f.db.batch(
        Array.from({ length: Math.min(100, 1100 - offset) }, (_, index) =>
          f.db
            .prepare(
              "INSERT INTO ai_usage(day,account_id,feature,model) VALUES('2026-01-01','group','knowledge',?)",
            )
            .bind(`history-${offset + index}`),
        ),
      );
    let queries = 0;
    const db = new Proxy(f.db, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            queries++;
            return target.prepare(sql);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const participant = () => createApplicationSpaceMigration(db, f.registry, async () => {});
    const context = f.context(f.manifest.mapping[0]!);
    const pages: SpaceCheckpointPage[] = [];
    const original = await drive(async (state: D1InventoryState | null) => {
      queries = 0;
      const result = await participant().inventoryStep(context, state);
      expect(queries).toBeLessThan(128);
      return result;
    }, pages);
    for (const mapping of f.manifest.mapping)
      await drive(async (state: ApplicationMigrationState | null) => {
        queries = 0;
        const retry =
          mapping.legacyOwner.id === "group" &&
          state?.stage.kind === "backfill" &&
          state.stage.table === "ai_usage" &&
          state.stage.offset === 0
            ? structuredClone(state)
            : null;
        const result = await participant().migrateStep(f.context(mapping), mapping, f.actor, state);
        if (retry) {
          await participant().migrateStep(f.context(mapping), mapping, f.actor, retry);
          expect(
            await f.db.prepare("SELECT count(*) AS n FROM ai_usage WHERE space_id='group'").first(),
          ).toEqual({ n: 128 });
        }
        expect(queries).toBeLessThan(128);
        return result;
      });
    const reconciled = await drive(async (state: ApplicationReconcileState | null) => {
      queries = 0;
      const result = await participant().reconcileStep(context, f.manifest, original.digest, state);
      expect(queries).toBeLessThan(128);
      return result;
    });
    expect(reconciled.digest).toBe(original.digest);
    const archive = new Map(pages.map((page) => [page.cursor, page]));
    const restored = await drive(async (state: D1RestoreState | null) => {
      queries = 0;
      const result = await participant().restoreStep(
        context,
        async (cursor) => {
          const page = archive.get(cursor);
          if (!page) throw new Error("missing archive page");
          return page;
        },
        state,
        original.digest,
      );
      expect(queries).toBeLessThan(128);
      return result;
    });
    expect(restored.digest).toBe(original.digest);
    expect(
      await f.db.prepare("SELECT count(*) AS n FROM ai_usage WHERE space_id IS NULL").first(),
    ).toEqual({ n: 1100 });
  }, 120_000);
});
