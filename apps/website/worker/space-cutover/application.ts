import {
  canonicalSpaceJson,
  type SpaceManifest,
  type SpaceMapping,
  type SpaceMigrationContext,
  type SpaceParticipantGuard,
  type SpaceReconciliation,
} from "../../shared/space-cutover.ts";
import {
  createD1SpaceCheckpoint,
  type D1InventoryState,
  type SpaceMigrationStep,
} from "../../registry/core/space-migration.ts";
import type { Actor } from "../db.ts";
import {
  buildSpaceImportStage,
  SPACE_IMPORT_BATCH,
  type SpaceImportStage,
} from "../spaces/store.ts";
import { SPACE_PREPARATION_COLUMNS } from "../spaces/ownership.ts";
import { CATEGORIES } from "../retention/categories.ts";
import { TABLE_GROUPS } from "../usage/tables.ts";

const SPINE = ["organizations", "spaces", "organization_members", "space_grants", "space_audit"];
const CONTENT_AI = [
  "knowledge",
  "knowledge_overlay",
  "wiki",
  "release_notes",
  // Highlights and on-demand release notes are billed to the content owner (CORE-359, CORE-151).
  "release_highlights",
  "release_notes_compose",
  "search",
  "merge_queue",
  "atlas",
];
const PERSONAL_AI = ["assistant", "avatars", "unattributed"];
const CONTENT_DO = [
  "Tracker",
  "KnowledgeCoordinator",
  "StepFeed",
  "RegistryRepo",
  "RegistryUpload",
];
const PERSONAL_DO = ["Assistant", "RegistryLogin", "CiSandbox"];
const literals = (values: readonly string[]) =>
  values.map((value) => `'${value.replaceAll("'", "''")}'`).join(",");
const contentCategories = CATEGORIES.filter((category) => category.scope === "space").map(
  (category) => category.id,
);
const contentGroups = TABLE_GROUPS.filter((group) => group.scope === "space").map(
  (group) => group.id,
);

/** SQL expressions are explicit field classification, never blanket owner replacement. */
export function applicationSpaceExpression(table: keyof typeof SPACE_PREPARATION_COLUMNS): string {
  const target = SPACE_PREPARATION_COLUMNS[table];
  if (target.classification === "content") return target.legacyColumn;
  if (table === "do_instances")
    return `CASE WHEN repo_id IS NOT NULL THEN (SELECT owner_id FROM repos WHERE id=repo_id) WHEN class IN (${literals(CONTENT_DO)}) THEN account_id ELSE NULL END`;
  if (table === "ai_usage" || table === "ai_usage_monthly")
    return `CASE WHEN account_id <> '' AND feature IN (${literals(CONTENT_AI)}) THEN account_id ELSE NULL END`;
  if (table === "account_ai_log_bodies")
    return "CASE WHEN component IN ('knowledge','release-notes','merge-queue') THEN account_id ELSE NULL END";
  if (table === "retention_policies" || table === "retention_policy_changes")
    return `CASE WHEN category IN (${literals(contentCategories)}) THEN account_id ELSE NULL END`;
  if (table === "cleanup_runs")
    return `CASE WHEN account_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cleanup_run_categories c WHERE c.run_id=cleanup_runs.id AND c.category NOT IN (${literals(contentCategories)})) THEN account_id ELSE NULL END`;
  // Legacy account/usage and per-model Workers AI aggregates combine identity
  // and content without a reversible breakdown. Preserve them as historical
  // Account/Instance totals; feature-level ai_usage above is independently mapped.
  return `CASE WHEN account_id <> '' AND ((construct IN ('artifacts','vectorize','ai_search','ci')) OR (construct='durable_objects' AND item IN (${literals(CONTENT_DO)})) OR (construct='d1' AND item IN (${literals(contentGroups)})) OR (construct='r2' AND item IN ('registry_blobs','registry_derived'))) THEN account_id ELSE NULL END`;
}

async function rows(db: D1Database, sql: string, ...values: (string | number)[]) {
  const result = await db
    .prepare(`${sql} LIMIT 10001`)
    .bind(...values)
    .all<Record<string, unknown>>();
  if (result.results.length > 10000)
    throw new Error("Operator mapping inventory exceeds the 10000-row safety bound");
  return result.results;
}
const equal = (left: unknown, right: unknown) =>
  canonicalSpaceJson(left) === canonicalSpaceJson(right);
function ordered(items: readonly unknown[]): unknown[] {
  return items.toSorted((a, b) => canonicalSpaceJson(a).localeCompare(canonicalSpaceJson(b)));
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a textual ownership observation");
  return value;
}
/** No inferred company grouping: inventory returns observations, never an approved mapping. */
export async function applicationInventory(db: D1Database, registry: D1Database) {
  return {
    owners: await rows(
      db,
      "SELECT id,kind,slug,display_name AS displayName,member_repo_role AS repositoryRole FROM accounts ORDER BY id",
    ),
    members: await rows(
      db,
      "SELECT org_id AS ownerId,user_id AS accountId,role FROM org_members ORDER BY org_id,user_id",
    ),
    repositories: await rows(
      db,
      "SELECT id,owner_id AS ownerId,name,visibility,artifacts_name AS artifactsName FROM repos ORDER BY id",
    ),
    repositoryCollaborators: await rows(
      db,
      "SELECT repo_id AS repoId,user_id AS accountId,role FROM repo_collaborators ORDER BY repo_id,user_id",
    ),
    registryFeeds: await rows(
      registry,
      "SELECT id,owner_id AS ownerId,key,format,kind,visibility FROM repositories ORDER BY id",
    ),
    providers: await rows(db, "SELECT id,account_id AS ownerId,kind FROM ai_providers ORDER BY id"),
    contentSettings: await rows(
      db,
      "SELECT account_id AS ownerId FROM account_settings ORDER BY account_id",
    ),
  };
}

export async function validateApplicationMapping(
  db: D1Database,
  registry: D1Database,
  manifest: SpaceManifest,
) {
  const inventory = await applicationInventory(db, registry);
  if (
    !equal(
      inventory.owners.map((owner) => text(owner.id)).sort((a, b) => a.localeCompare(b)),
      manifest.mapping.map((mapping) => mapping.legacyOwner.id).sort((a, b) => a.localeCompare(b)),
    )
  )
    throw new Error(
      "Manifest must map every legacy owner exactly once, including personal Trackers",
    );
  for (const mapping of manifest.mapping) {
    const owner = inventory.owners.find((item) => item.id === mapping.legacyOwner.id);
    if (
      !owner ||
      owner.kind !== mapping.legacyOwner.kind ||
      owner.slug !== mapping.legacyOwner.slug
    )
      throw new Error("Legacy identity changed");
    const members =
      owner.kind === "user"
        ? [{ accountId: owner.id, role: "owner" }]
        : inventory.members
            .filter((item) => item.ownerId === owner.id)
            .map(({ accountId, role }) => ({ accountId, role }));
    if (!equal(ordered(members), ordered(mapping.organizationMembers)))
      throw new Error("Legacy organization membership changed");
    const grants = members.map((member) => ({
      accountId: member.accountId,
      role: member.role === "owner" ? "admin" : "member",
      repositoryRole: member.role === "owner" ? "write" : (owner.repositoryRole ?? "none"),
      packageRole: member.role === "owner" || owner.repositoryRole === "write" ? "write" : "read",
      origin:
        owner.kind === "user"
          ? "legacy-personal-owner"
          : `legacy-org-membership:${text(member.role)}`,
    }));
    if (!equal(ordered(grants), ordered(mapping.spaceGrants)))
      throw new Error("Manifest expands or changes independent legacy grants");
    for (const [key, expected] of [
      ["repositories", mapping.repositories],
      ["registryFeeds", mapping.registryFeeds],
      ["providers", mapping.providers],
    ] as const) {
      const actual = inventory[key]
        .filter((item) => item.ownerId === owner.id)
        .map(({ ownerId: _ownerId, ...item }) => item);
      if (!equal(ordered(actual), ordered(expected))) throw new Error(`Manifest ${key} changed`);
    }
    const repoIds = new Set(mapping.repositories.map((repo) => repo.id));
    const collaborators = inventory.repositoryCollaborators.filter((item) =>
      repoIds.has(text(item.repoId)),
    );
    if (!equal(ordered(collaborators), ordered(mapping.repositoryCollaborators)))
      throw new Error("Repository-only grants changed");
    const settings = inventory.contentSettings.some((item) => item.ownerId === owner.id);
    if (settings !== mapping.hasContentSettings)
      throw new Error("Content settings inventory changed");
  }
}

export interface ApplicationMigrationState {
  context: string;
  stage: SpaceImportStage;
  done: boolean;
}
export interface ApplicationReconcileState {
  context: string;
  phase: "identities" | "mappings" | "inventory" | "done";
  index: number;
  inventory: D1InventoryState | null;
  result: SpaceReconciliation | null;
}

export function createApplicationSpaceMigration(
  db: D1Database,
  registry: D1Database,
  guard: SpaceParticipantGuard,
) {
  const checkpoint = createD1SpaceCheckpoint(db, "application", guard);
  const projection = {
    emptyTables: SPINE,
    nullColumns: Object.fromEntries(
      Object.keys(SPACE_PREPARATION_COLUMNS).map((table) => [table, ["space_id"]]),
    ),
  };
  async function preflight(context: SpaceMigrationContext, manifest: SpaceManifest) {
    await guard(context, "inventory");
    await validateApplicationMapping(db, registry, manifest);
    for (const table of SPINE)
      if (await db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).first())
        throw new Error("First cutover requires empty additive tenant spine");
    for (const [table, target] of Object.entries(SPACE_PREPARATION_COLUMNS)) {
      if (await db.prepare(`SELECT 1 FROM ${table} WHERE space_id IS NOT NULL LIMIT 1`).first())
        throw new Error("Unjournaled prior Space ownership");
      const expression = applicationSpaceExpression(
        table as keyof typeof SPACE_PREPARATION_COLUMNS,
      );
      if (
        await db
          .prepare(
            `SELECT 1 FROM ${table} WHERE (${expression}) IS NOT NULL AND (${expression}) NOT IN (SELECT id FROM accounts) LIMIT 1`,
          )
          .first()
      )
        throw new Error(`Orphaned content ownership: ${table}`);
      if (
        target.classification === "content" &&
        (await db
          .prepare(`SELECT 1 FROM ${table} WHERE ${target.legacyColumn} IS NULL LIMIT 1`)
          .first())
      )
        throw new Error("Unmapped content ownership");
    }
    for (const table of ["ai_usage", "ai_usage_monthly"])
      if (
        await db
          .prepare(
            `SELECT 1 FROM ${table} WHERE account_id <> '' AND feature NOT IN (${literals([...CONTENT_AI, ...PERSONAL_AI])}) LIMIT 1`,
          )
          .first()
      )
        throw new Error("Unknown AI ownership classification");
    if (
      await db
        .prepare(
          `SELECT 1 FROM do_instances WHERE repo_id IS NULL AND class NOT IN (${literals([...CONTENT_DO, ...PERSONAL_DO])}) LIMIT 1`,
        )
        .first()
    )
      throw new Error("Unknown durable ownership classification");
    if (
      await db
        .prepare(
          "SELECT 1 FROM account_ai_log_bodies WHERE component NOT IN ('knowledge','release-notes','merge-queue','assistant','assistant-titles','avatars') LIMIT 1",
        )
        .first()
    )
      throw new Error("Unknown gateway component ownership");
    for (const table of ["retention_policies", "retention_policy_changes"])
      if (
        await db
          .prepare(
            `SELECT 1 FROM ${table} WHERE category NOT IN (${literals(CATEGORIES.map((category) => category.id))}) LIMIT 1`,
          )
          .first()
      )
        throw new Error("Unknown retention ownership classification");
    for (const table of ["usage_snapshots", "usage_monthly"]) {
      const unknown = await db
        .prepare(`SELECT 1 FROM ${table} WHERE
        construct NOT IN ('d1','durable_objects','r2','artifacts','vectorize','ai_search','workers_ai','ci')
        OR (construct='d1' AND item NOT IN (${literals(TABLE_GROUPS.map((group) => group.id))}))
        OR (construct='durable_objects' AND item NOT IN (${literals([...CONTENT_DO, ...PERSONAL_DO])}))
        OR (construct='r2' AND item NOT IN ('registry_blobs','registry_derived','registry_blobs_all','avatars')) LIMIT 1`)
        .first();
      if (unknown) throw new Error("Unknown historical usage ownership classification");
    }
  }
  const tables = Object.keys(
    SPACE_PREPARATION_COLUMNS,
  ) as (keyof typeof SPACE_PREPARATION_COLUMNS)[];
  async function migrateStep(
    context: SpaceMigrationContext,
    mapping: SpaceMapping,
    actor: Actor,
    previous: ApplicationMigrationState | null,
  ): Promise<SpaceMigrationStep<ApplicationMigrationState, null>> {
    await guard(context, "migrate");
    const state: ApplicationMigrationState = previous ?? {
      context: canonicalSpaceJson(context),
      stage: { kind: "identity" },
      done: false,
    };
    if (state.context !== canonicalSpaceJson(context))
      throw new Error("Application progress context mismatch");
    if (state.done) return { state, done: true, result: null };
    const stage = state.stage;
    if (stage.kind === "backfill") {
      if (!tables.includes(stage.table as keyof typeof SPACE_PREPARATION_COLUMNS))
        throw new Error("Unknown ownership backfill");
      const table = stage.table as keyof typeof SPACE_PREPARATION_COLUMNS;
      const remaining = await db
        .prepare(
          `SELECT 1 FROM ${table} WHERE space_id IS NOT ? AND (${applicationSpaceExpression(table)})=? LIMIT 1`,
        )
        .bind(context.spaceId, context.legacyOwnerId)
        .first();
      if (!remaining) {
        const next = tables[tables.indexOf(table) + 1];
        state.stage = next ? { kind: "backfill", table: next, offset: 0 } : { kind: "complete" };
        return { state, done: false };
      }
    }
    const batch = buildSpaceImportStage(db, actor, mapping, context, stage);
    const receipt = await db
      .prepare(
        "SELECT manifest_digest FROM space_audit WHERE migration_run_id=? AND space_id=? AND action=? AND subject_id=?",
      )
      .bind(context.runId, context.spaceId, batch.action, batch.subjectId)
      .first<{ manifest_digest: string }>();
    if (receipt && receipt.manifest_digest !== context.manifestDigest)
      throw new Error("Application migration receipt mismatch");
    if (!receipt) {
      if (stage.kind === "backfill") {
        const table = stage.table as keyof typeof SPACE_PREPARATION_COLUMNS;
        batch.statements.push(
          db
            .prepare(
              `UPDATE ${table} SET space_id=? WHERE rowid IN (SELECT rowid FROM ${table} WHERE space_id IS NOT ? AND (${applicationSpaceExpression(table)})=? LIMIT 128)`,
            )
            .bind(context.spaceId, context.spaceId, context.legacyOwnerId),
        );
      }
      await db.batch(batch.statements);
    }
    if (stage.kind === "identity") state.stage = { kind: "members", offset: 0 };
    else if (stage.kind === "members")
      state.stage =
        stage.offset + SPACE_IMPORT_BATCH < mapping.organizationMembers.length
          ? { kind: "members", offset: stage.offset + SPACE_IMPORT_BATCH }
          : mapping.spaceGrants.length
            ? { kind: "grants", offset: 0 }
            : { kind: "backfill", table: tables[0]!, offset: 0 };
    else if (stage.kind === "grants")
      state.stage =
        stage.offset + SPACE_IMPORT_BATCH < mapping.spaceGrants.length
          ? { kind: "grants", offset: stage.offset + SPACE_IMPORT_BATCH }
          : { kind: "backfill", table: tables[0]!, offset: 0 };
    else if (stage.kind === "backfill") state.stage = { ...stage, offset: stage.offset + 1 };
    else state.done = true;
    return state.done ? { state, done: true, result: null } : { state, done: false };
  }
  async function reconcileStep(
    context: SpaceMigrationContext,
    manifest: SpaceManifest,
    beforeDigest: string,
    previous: ApplicationReconcileState | null,
  ): Promise<SpaceMigrationStep<ApplicationReconcileState, SpaceReconciliation>> {
    await guard(context, "reconcile");
    const state: ApplicationReconcileState = previous ?? {
      context: canonicalSpaceJson(context),
      phase: "identities",
      index: 0,
      inventory: null,
      result: null,
    };
    if (state.context !== canonicalSpaceJson(context))
      throw new Error("Application reconciliation context mismatch");
    if (state.phase === "done") return { state, done: true, result: state.result! };
    if (state.phase === "identities") {
      await validateApplicationMapping(db, registry, manifest);
      const organizations = [
        ...new Map(
          manifest.mapping.map((mapping) => [mapping.organization.id, mapping.organization]),
        ).values(),
      ];
      const actualOrganizations = await rows(
        db,
        "SELECT id,slug,display_name AS displayName,kind,personal_account_id AS personalAccountId,default_space_id AS defaultSpaceId FROM organizations ORDER BY id",
      );
      if (!equal(ordered(actualOrganizations), ordered(organizations)))
        throw new Error("Organization identity/default reconciliation failed");
      const actualSpaces = await rows(
        db,
        "SELECT id,organization_id AS organizationId,slug,display_name AS displayName,archived_at FROM spaces ORDER BY id",
      );
      const expectedSpaces = manifest.mapping.map((mapping) => ({
        id: mapping.space.id,
        organizationId: mapping.space.organizationId,
        slug: mapping.space.slug,
        displayName: mapping.space.displayName,
        archived_at: null,
      }));
      if (!equal(ordered(actualSpaces), ordered(expectedSpaces)))
        throw new Error("Space identity reconciliation failed");
      const expectedMembers = new Map<
        string,
        { organizationId: string; accountId: string; role: string }
      >();
      for (const mapping of manifest.mapping)
        for (const member of mapping.organizationMembers) {
          const key = `${mapping.organization.id}:${member.accountId}`;
          const prior = expectedMembers.get(key);
          expectedMembers.set(key, {
            organizationId: mapping.organization.id,
            accountId: member.accountId,
            role: prior?.role === "owner" || member.role === "owner" ? "owner" : "member",
          });
        }
      const actualMembers = await rows(
        db,
        "SELECT organization_id AS organizationId,account_id AS accountId,role FROM organization_members ORDER BY organization_id,account_id",
      );
      if (!equal(ordered(actualMembers), ordered([...expectedMembers.values()])))
        throw new Error("Organization membership reconciliation failed");
      const grantCount = await db
        .prepare("SELECT count(*) AS n FROM space_grants")
        .first<{ n: number }>();
      if (
        grantCount?.n !==
        manifest.mapping.reduce((count, mapping) => count + mapping.spaceGrants.length, 0)
      )
        throw new Error("Unexpected explicit grant");
      if (
        await db
          .prepare(
            "SELECT 1 FROM space_audit WHERE migration_run_id IS NOT ? OR manifest_digest IS NOT ? OR action NOT IN ('migration.import','migration.import-step') LIMIT 1",
          )
          .bind(context.runId, context.manifestDigest)
          .first()
      )
        throw new Error("Import provenance reconciliation failed");
      for (const table of tables)
        if (
          await db
            .prepare(
              `SELECT 1 FROM ${table} WHERE space_id IS NOT (${applicationSpaceExpression(table)}) LIMIT 1`,
            )
            .first()
        )
          throw new Error(`Ownership reconciliation failed: ${table}`);
      state.phase = "mappings";
      return { state, done: false };
    }
    if (state.phase === "mappings") {
      const mapping = manifest.mapping[state.index];
      if (mapping) {
        const grants = await rows(
          db,
          "SELECT account_id AS accountId,role,repository_role AS repositoryRole,package_role AS packageRole,origin FROM space_grants WHERE space_id=? ORDER BY account_id",
          mapping.space.id,
        );
        if (!equal(ordered(grants), ordered(mapping.spaceGrants)))
          throw new Error("Explicit grant reconciliation failed");
        const finals = await rows(
          db,
          "SELECT subject_id,detail FROM space_audit WHERE migration_run_id=? AND manifest_digest=? AND space_id=? AND action='migration.import'",
          context.runId,
          context.manifestDigest,
          mapping.space.id,
        );
        const expectedDetail = {
          organization: mapping.organization,
          space: mapping.space,
          organizationMembers: mapping.organizationMembers,
          spaceGrants: mapping.spaceGrants,
        };
        if (
          finals.length !== 1 ||
          finals[0]!.subject_id !== mapping.legacyOwner.id ||
          !equal(JSON.parse(text(finals[0]!.detail)), expectedDetail)
        )
          throw new Error("Final import receipt mismatch");
        state.index++;
        return { state, done: false };
      }
      state.phase = "inventory";
      return { state, done: false };
    }
    const step = await checkpoint.inventoryStep(context, state.inventory, projection);
    state.inventory = step.state;
    if (!step.done) return { state, done: false };
    if (step.result.digest !== beforeDigest)
      throw new Error("Application identity/history/credential bytes changed");
    state.phase = "done";
    state.result = { ...step.result, preserved: true };
    return { state, done: true, result: state.result };
  }
  return { ...checkpoint, preflight, migrateStep, reconcileStep };
}
