import type { ContentRole, OrganizationSummary, SpaceAccess } from "../../shared/spaces.ts";
import type { SpaceMapping } from "../../shared/space-cutover.ts";
import type { Actor } from "../db.ts";
import { slugProblem } from "../names.ts";
import { resolveSpaceAccess } from "./access.ts";
import { avatarUrl } from "../avatars/api.ts";

export interface SpaceImportProvenance {
  runId: string;
  manifestDigest: string;
}
type Value = string | number | null;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
function name(slug: string, displayName: string) {
  const problem = slugProblem(slug);
  if (problem) throw new Error(problem);
  if (!displayName.trim()) throw new Error("A display name is required");
}
const ownerPredicate = `EXISTS (SELECT 1 FROM organization_members WHERE organization_id = ? AND account_id = p.id AND role = 'owner')`;
const preservesOwner = `NOT EXISTS (SELECT 1 FROM organization_members target
  WHERE target.organization_id = ? AND target.account_id = ? AND target.role = 'owner'
  AND NOT EXISTS (SELECT 1 FROM organization_members other WHERE other.organization_id = target.organization_id
    AND other.account_id <> target.account_id AND other.role = 'owner'))`;
/** This insert is also the authorization assertion INSIDE the mutation batch.
 * NULL violates actor_id's NOT NULL constraint and rolls the entire batch back.
 * Do not replace it with a preflight-only authorization check (revocation race).
 */
function audit(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  spaceId: string | null,
  action: string,
  subjectId: string | null,
  detail: unknown,
  predicate: string,
  values: Value[] = [],
  provenance?: SpaceImportProvenance,
): D1PreparedStatement {
  return d1
    .prepare(`INSERT INTO space_audit
    (id, organization_id, space_id, actor_id, agent_id, action, subject_id, detail, migration_run_id, manifest_digest)
    VALUES (?, ?, ?, (SELECT p.id FROM accounts p WHERE p.id = ? AND p.kind = 'user'
      AND (? IS NULL OR EXISTS (SELECT 1 FROM agents a WHERE a.id = ? AND a.accountable_id = p.id AND a.revoked_at IS NULL))
      AND (${predicate})), ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      organizationId,
      spaceId,
      actor.id,
      actor.agent?.id ?? null,
      actor.agent?.id ?? null,
      ...values,
      actor.agent?.id ?? null,
      action,
      subjectId,
      JSON.stringify(detail),
      provenance?.runId ?? null,
      provenance?.manifestDigest ?? null,
    );
}
function membership(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  accountId: string,
  role: "owner" | "member",
  origin: string,
  importing = false,
) {
  return d1
    .prepare(`INSERT INTO organization_members
    (organization_id, account_id, role, origin, granted_by, granted_by_agent_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (organization_id, account_id) DO UPDATE SET role = ${
      importing
        ? "CASE WHEN organization_members.role = 'owner' OR excluded.role = 'owner' THEN 'owner' ELSE 'member' END"
        : "excluded.role"
    },
      origin = excluded.origin, granted_at = ${NOW}, granted_by = excluded.granted_by,
      granted_by_agent_id = excluded.granted_by_agent_id`)
    .bind(organizationId, accountId, role, origin, actor.id, actor.agent?.id ?? null);
}
export interface GrantInput {
  accountId: string;
  role: "admin" | "member";
  repositoryRole: ContentRole;
  packageRole: ContentRole;
}
function grant(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  spaceId: string,
  input: GrantInput,
  origin: string,
) {
  return d1
    .prepare(`INSERT INTO space_grants
    (space_id, organization_id, account_id, role, repository_role, package_role, origin, granted_by, granted_by_agent_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (space_id, account_id) DO UPDATE SET role = excluded.role,
      repository_role = excluded.repository_role, package_role = excluded.package_role,
      origin = excluded.origin, granted_at = ${NOW}, granted_by = excluded.granted_by,
      granted_by_agent_id = excluded.granted_by_agent_id`)
    .bind(
      spaceId,
      organizationId,
      input.accountId,
      input.role,
      input.repositoryRole,
      input.packageRole,
      origin,
      actor.id,
      actor.agent?.id ?? null,
    );
}
function organizationInsert(
  d1: D1Database,
  input: SpaceMapping["organization"],
  importing = false,
) {
  name(input.slug, input.displayName);
  return d1
    .prepare(`INSERT INTO organizations
    (id, slug, display_name, kind, personal_account_id, default_space_id) VALUES (?, ?, ?, ?, ?, ?)
    ${
      importing
        ? `ON CONFLICT (id) DO UPDATE SET display_name = CASE
      WHEN organizations.slug IS excluded.slug AND organizations.display_name IS excluded.display_name
        AND organizations.kind IS excluded.kind AND organizations.personal_account_id IS excluded.personal_account_id
        AND organizations.default_space_id IS excluded.default_space_id
      THEN organizations.display_name ELSE NULL END`
        : ""
    }`)
    .bind(
      input.id,
      input.slug,
      input.displayName,
      input.kind,
      input.personalAccountId,
      input.defaultSpaceId,
    );
}
function spaceInsert(d1: D1Database, input: SpaceMapping["space"]) {
  name(input.slug, input.displayName);
  if (input.archived) throw new Error("Cannot bootstrap an archived Space");
  return d1
    .prepare(`INSERT INTO spaces (id, organization_id, slug, display_name) VALUES (?, ?, ?, ?)`)
    .bind(input.id, input.organizationId, input.slug, input.displayName);
}

interface OrganizationBootstrapInput {
  slug: string;
  displayName: string;
  kind: "company" | "personal";
  spaceSlug: string;
  spaceDisplayName: string;
}

function organizationBootstrap(d1: D1Database, actor: Actor, input: OrganizationBootstrapInput) {
  const organizationId = `org_${crypto.randomUUID()}`;
  const spaceId = `space_${crypto.randomUUID()}`;
  const statements = [
    audit(d1, actor, organizationId, spaceId, "organization.bootstrap", actor.id, input, "1"),
    organizationInsert(d1, {
      id: organizationId,
      slug: input.slug,
      displayName: input.displayName,
      kind: input.kind,
      personalAccountId: input.kind === "personal" ? actor.id : null,
      defaultSpaceId: spaceId,
    }),
    spaceInsert(d1, {
      id: spaceId,
      organizationId,
      slug: input.spaceSlug,
      displayName: input.spaceDisplayName,
      archived: false,
    }),
    membership(d1, actor, organizationId, actor.id, "owner", "bootstrap"),
    grant(
      d1,
      actor,
      organizationId,
      spaceId,
      { accountId: actor.id, role: "admin", repositoryRole: "write", packageRole: "write" },
      "bootstrap",
    ),
  ];
  return { organizationId, spaceId, statements };
}

/** Bootstrap commits identity, real default, owner membership and explicit grant together. */
export async function createOrganization(
  d1: D1Database,
  actor: Actor,
  input: OrganizationBootstrapInput,
): Promise<{ organizationId: string; spaceId: string }> {
  const { statements, organizationId, spaceId } = organizationBootstrap(d1, actor, input);
  await d1.batch(statements);
  return { organizationId, spaceId };
}

/** Signup is one transaction: no person can commit without their personal content scope. */
export interface NewPerson {
  id: string;
  slug: string;
  displayName: string;
  email: string;
  isSiteAdmin: boolean;
  ownerOrganizationSlug?: string;
}
export async function createPerson(d1: D1Database, input: NewPerson): Promise<void> {
  await d1.batch(personStatements(d1, input));
}
/** A person with their private personal Organization and default Space, for one atomic batch. */
export function personStatements(d1: D1Database, input: NewPerson): D1PreparedStatement[] {
  const actor: Actor = {
    id: input.id,
    slug: input.slug,
    displayName: input.displayName,
    isSiteAdmin: input.isSiteAdmin,
  };
  const personal = organizationBootstrap(d1, actor, {
    slug: input.slug,
    displayName: input.displayName,
    kind: "personal",
    spaceSlug: input.slug,
    spaceDisplayName: "Personal",
  });
  const company = input.ownerOrganizationSlug
    ? organizationBootstrap(d1, actor, {
        slug: input.ownerOrganizationSlug,
        displayName: input.ownerOrganizationSlug,
        kind: "company",
        spaceSlug: input.ownerOrganizationSlug,
        spaceDisplayName: "General",
      }).statements
    : [];
  return [
    d1
      .prepare(`INSERT INTO accounts (id, kind, slug, display_name, email, is_site_admin)
      VALUES (?, 'user', ?, ?, ?, ?)`)
      .bind(input.id, input.slug, input.displayName, input.email, input.isSiteAdmin ? 1 : 0),
    ...personal.statements,
    ...company,
    d1.prepare("DELETE FROM auth_invites WHERE email = ?").bind(input.email),
  ];
}
export async function createSpace(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  input: { slug: string; displayName: string },
): Promise<string> {
  const id = `space_${crypto.randomUUID()}`;
  await d1.batch([
    audit(d1, actor, organizationId, id, "space.create", actor.id, input, ownerPredicate, [
      organizationId,
    ]),
    spaceInsert(d1, { id, organizationId, ...input, archived: false }),
    grant(
      d1,
      actor,
      organizationId,
      id,
      { accountId: actor.id, role: "admin", repositoryRole: "write", packageRole: "write" },
      "space-create",
    ),
  ]);
  return id;
}
export async function updateOrganization(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  displayName: string,
): Promise<void> {
  if (!displayName.trim()) throw new Error("A display name is required");
  await d1.batch([
    audit(
      d1,
      actor,
      organizationId,
      null,
      "organization.update",
      null,
      { displayName },
      ownerPredicate,
      [organizationId],
    ),
    d1
      .prepare("UPDATE organizations SET display_name = ? WHERE id = ?")
      .bind(displayName, organizationId),
  ]);
}
export async function updateSpace(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  spaceId: string,
  displayName: string,
): Promise<void> {
  if (!displayName.trim()) throw new Error("A display name is required");
  await d1.batch([
    audit(
      d1,
      actor,
      organizationId,
      spaceId,
      "space.update",
      null,
      { displayName },
      `${ownerPredicate} AND EXISTS (SELECT 1 FROM spaces WHERE id = ? AND organization_id = ?)`,
      [organizationId, spaceId, organizationId],
    ),
    d1
      .prepare("UPDATE spaces SET display_name = ? WHERE id = ? AND organization_id = ?")
      .bind(displayName, spaceId, organizationId),
  ]);
}
export async function setDefaultSpace(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  spaceId: string,
): Promise<void> {
  await d1.batch([
    audit(
      d1,
      actor,
      organizationId,
      spaceId,
      "organization.default",
      null,
      { spaceId },
      ownerPredicate,
      [organizationId],
    ),
    d1
      .prepare("UPDATE organizations SET default_space_id = ? WHERE id = ?")
      .bind(spaceId, organizationId),
  ]);
}
/** Explicit replacement first, archive second; any failure rolls both back. */
export async function archiveSpace(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  spaceId: string,
  replacementDefaultSpaceId?: string,
): Promise<void> {
  const statements = [
    audit(
      d1,
      actor,
      organizationId,
      spaceId,
      "space.archive",
      null,
      { replacementDefaultSpaceId: replacementDefaultSpaceId ?? null },
      `${ownerPredicate} AND EXISTS (SELECT 1 FROM spaces WHERE id = ? AND organization_id = ? AND archived_at IS NULL)`,
      [organizationId, spaceId, organizationId],
    ),
  ];
  if (replacementDefaultSpaceId)
    statements.push(
      d1
        .prepare("UPDATE organizations SET default_space_id = ? WHERE id = ?")
        .bind(replacementDefaultSpaceId, organizationId),
    );
  statements.push(
    d1
      .prepare(`UPDATE spaces SET archived_at = ${NOW} WHERE id = ? AND organization_id = ?`)
      .bind(spaceId, organizationId),
  );
  await d1.batch(statements);
}
export async function restoreSpace(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  spaceId: string,
): Promise<void> {
  await d1.batch([
    audit(
      d1,
      actor,
      organizationId,
      spaceId,
      "space.restore",
      null,
      {},
      `${ownerPredicate} AND EXISTS (SELECT 1 FROM spaces WHERE id = ? AND organization_id = ? AND archived_at IS NOT NULL)`,
      [organizationId, spaceId, organizationId],
    ),
    d1
      .prepare("UPDATE spaces SET archived_at = NULL WHERE id = ? AND organization_id = ?")
      .bind(spaceId, organizationId),
  ]);
}
export async function setOrganizationMember(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  accountId: string,
  role: "owner" | "member",
): Promise<void> {
  await d1.batch([
    audit(
      d1,
      actor,
      organizationId,
      null,
      "membership.set",
      accountId,
      { role },
      role === "owner" ? ownerPredicate : `${ownerPredicate} AND ${preservesOwner}`,
      role === "owner" ? [organizationId] : [organizationId, organizationId, accountId],
    ),
    membership(d1, actor, organizationId, accountId, role, "explicit"),
  ]);
}
export async function setSpaceGrant(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  spaceId: string,
  input: GrantInput,
): Promise<void> {
  await d1.batch([
    audit(d1, actor, organizationId, spaceId, "grant.set", input.accountId, input, ownerPredicate, [
      organizationId,
    ]),
    grant(d1, actor, organizationId, spaceId, input, "explicit"),
  ]);
}
export async function revokeSpaceGrant(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  spaceId: string,
  accountId: string,
): Promise<void> {
  await d1.batch([
    audit(
      d1,
      actor,
      organizationId,
      spaceId,
      "grant.revoke",
      accountId,
      {},
      `${ownerPredicate} AND EXISTS (SELECT 1 FROM space_grants WHERE space_id = ? AND organization_id = ? AND account_id = ?)`,
      [organizationId, spaceId, organizationId, accountId],
    ),
    d1
      .prepare(
        "DELETE FROM space_grants WHERE space_id = ? AND organization_id = ? AND account_id = ?",
      )
      .bind(spaceId, organizationId, accountId),
  ]);
}
export async function removeOrganizationMember(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  accountId: string,
): Promise<void> {
  await d1.batch([
    audit(
      d1,
      actor,
      organizationId,
      null,
      "membership.revoke",
      accountId,
      {},
      `${ownerPredicate} AND ${preservesOwner} AND EXISTS (SELECT 1 FROM organization_members WHERE organization_id = ? AND account_id = ?)`,
      [organizationId, organizationId, accountId, organizationId, accountId],
    ),
    // Record every affected Space, with the same person/agent, before cascading.
    d1
      .prepare(`INSERT INTO space_audit (id, organization_id, space_id, actor_id, agent_id, action, subject_id, detail)
      SELECT ? || ':' || space_id, organization_id, space_id, ?, ?, 'grant.revoke-membership', account_id,
        json_object('role', role, 'repositoryRole', repository_role, 'packageRole', package_role, 'origin', origin)
      FROM space_grants WHERE organization_id = ? AND account_id = ?`)
      .bind(crypto.randomUUID(), actor.id, actor.agent?.id ?? null, organizationId, accountId),
    d1
      .prepare("DELETE FROM organization_members WHERE organization_id = ? AND account_id = ?")
      .bind(organizationId, accountId),
  ]);
}
export async function resolveDefaultSpaceAccess(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
): Promise<SpaceAccess | null> {
  const row = await d1
    .prepare("SELECT default_space_id FROM organizations WHERE id = ?")
    .bind(organizationId)
    .first<{ default_space_id: string }>();
  return row ? resolveSpaceAccess(d1, actor, row.default_space_id) : null;
}
/** Directory metadata only: owners see directory rows, members see grant-visible rows.
 * No content counts, provider metadata or resource ACL inference belongs here.
 */
export async function listOrganizations(
  d1: D1Database,
  actor: Actor,
): Promise<OrganizationSummary[]> {
  const result = await d1
    .prepare(`SELECT o.* FROM organizations o
    JOIN organization_members m ON m.organization_id = o.id
    JOIN accounts p ON p.id = m.account_id AND p.kind = 'user'
    WHERE p.id = ? AND (? IS NULL OR EXISTS (SELECT 1 FROM agents WHERE id = ? AND accountable_id = p.id AND revoked_at IS NULL))
    ORDER BY o.slug`)
    .bind(actor.id, actor.agent?.id ?? null, actor.agent?.id ?? null)
    .all<{
      id: string;
      slug: string;
      display_name: string;
      kind: "company" | "personal";
      personal_account_id: string | null;
      default_space_id: string;
      created_at: string;
      avatar_key: string | null;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    kind: row.kind,
    personalAccountId: row.personal_account_id,
    defaultSpaceId: row.default_space_id,
    createdAt: row.created_at,
    avatarUrl: avatarUrl(row.avatar_key),
  }));
}

/** Directory permission is deliberately not SpaceAccess. An Organization owner
 * may administer explicit grants without acquiring any private content rights.
 */
export async function listSpaceDirectory(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
): Promise<
  {
    id: string;
    slug: string;
    displayName: string;
    archivedAt: string | null;
    isDefault: boolean;
  }[]
> {
  const result = await d1
    .prepare(`SELECT s.id, s.slug, s.display_name, s.archived_at,
      CASE WHEN o.default_space_id = s.id THEN 1 ELSE 0 END AS is_default
    FROM spaces s JOIN organizations o ON o.id = s.organization_id
    JOIN organization_members m ON m.organization_id = o.id
    JOIN accounts p ON p.id = m.account_id AND p.kind = 'user'
    WHERE o.id = ? AND p.id = ?
      AND (? IS NULL OR EXISTS (SELECT 1 FROM agents WHERE id = ? AND accountable_id = p.id AND revoked_at IS NULL))
      AND (m.role = 'owner' OR (s.archived_at IS NULL AND EXISTS
        (SELECT 1 FROM space_grants g WHERE g.space_id = s.id AND g.account_id = p.id AND g.organization_id = o.id)))
    ORDER BY s.slug`)
    .bind(organizationId, actor.id, actor.agent?.id ?? null, actor.agent?.id ?? null)
    .all<{
      id: string;
      slug: string;
      display_name: string;
      archived_at: string | null;
      is_default: number;
    }>();
  return result.results.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    archivedAt: row.archived_at,
    isDefault: row.is_default === 1,
  }));
}

export async function organizationRole(d1: D1Database, actor: Actor, organizationId: string) {
  const row = await d1
    .prepare(`SELECT m.role FROM organization_members m
    JOIN accounts p ON p.id = m.account_id AND p.kind = 'user'
    WHERE m.organization_id = ? AND p.id = ?
    AND (? IS NULL OR EXISTS (SELECT 1 FROM agents WHERE id = ? AND accountable_id = p.id AND revoked_at IS NULL))`)
    .bind(organizationId, actor.id, actor.agent?.id ?? null, actor.agent?.id ?? null)
    .first<{ role: "owner" | "member" }>();
  return row?.role ?? null;
}

export async function listOrganizationMembers(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
) {
  if (!(await organizationRole(d1, actor, organizationId))) return [];
  const rows = await d1
    .prepare(`SELECT p.id, p.slug, p.display_name, m.role
    FROM organization_members m JOIN accounts p ON p.id = m.account_id
    WHERE m.organization_id = ? ORDER BY p.slug`)
    .bind(organizationId)
    .all<{ id: string; slug: string; display_name: string; role: "owner" | "member" }>();
  return rows.results.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    kind: "user" as const,
    role: row.role,
  }));
}

export async function listSpaceGrants(
  d1: D1Database,
  actor: Actor,
  organizationId: string,
  spaceId: string,
) {
  if ((await organizationRole(d1, actor, organizationId)) !== "owner") return [];
  const rows = await d1
    .prepare(`SELECT g.* FROM space_grants g
    JOIN organization_members m ON m.organization_id = g.organization_id AND m.account_id = g.account_id
    WHERE g.organization_id = ? AND g.space_id = ? ORDER BY g.account_id`)
    .bind(organizationId, spaceId)
    .all<{
      space_id: string;
      account_id: string;
      role: "admin" | "member";
      repository_role: ContentRole;
      package_role: ContentRole;
      origin: string;
      granted_at: string;
      granted_by: string;
      granted_by_agent_id: string | null;
    }>();
  return rows.results.map((row) => ({
    spaceId: row.space_id,
    accountId: row.account_id,
    role: row.role,
    repositoryRole: row.repository_role,
    packageRole: row.package_role,
    origin: row.origin,
    grantedAt: row.granted_at,
    grantedBy: row.granted_by,
    grantedByAgentId: row.granted_by_agent_id,
  }));
}

export type SpaceImportStage =
  | { kind: "identity" | "complete" }
  | { kind: "members" | "grants"; offset: number }
  | { kind: "backfill"; table: string; offset: number };
export const SPACE_IMPORT_BATCH = 32;
/** Internal bounded import primitive. Every batch carries a live authorization
 * assertion and a distinct durable receipt; only the coordinator's final stage
 * claims completion after all classified ownership backfills have finished. */
export function buildSpaceImportStage(
  d1: D1Database,
  actor: Actor,
  mapping: SpaceMapping,
  provenance: SpaceImportProvenance,
  stage: SpaceImportStage,
): { statements: D1PreparedStatement[]; action: string; subjectId: string } {
  if (!provenance.runId || !provenance.manifestDigest)
    throw new Error("Import provenance is required");
  if (
    mapping.space.organizationId !== mapping.organization.id ||
    mapping.space.id !== mapping.legacyOwner.id ||
    mapping.trackerDoName !== mapping.space.id
  )
    throw new Error("Invalid immutable owner mapping");
  if (
    mapping.organization.kind === "personal" &&
    (mapping.legacyOwner.kind !== "user" ||
      mapping.organization.personalAccountId !== mapping.legacyOwner.id)
  )
    throw new Error("Invalid personal mapping");
  const members = new Set(mapping.organizationMembers.map((member) => member.accountId));
  if (
    members.size !== mapping.organizationMembers.length ||
    new Set(mapping.spaceGrants.map((entry) => entry.accountId)).size !== mapping.spaceGrants.length
  )
    throw new Error("Duplicate import principal");
  if (!mapping.organizationMembers.some((member) => member.role === "owner"))
    throw new Error("Organization requires an owner");
  for (const entry of mapping.spaceGrants)
    if (!members.has(entry.accountId) || !entry.origin)
      throw new Error("Grant lacks membership or provenance");
  if ("offset" in stage && (!Number.isSafeInteger(stage.offset) || stage.offset < 0))
    throw new Error("Invalid import offset");
  const action = stage.kind === "complete" ? "migration.import" : "migration.import-step";
  const subjectId =
    stage.kind === "complete"
      ? mapping.legacyOwner.id
      : `${stage.kind}:${"table" in stage ? `${stage.table}:` : ""}${"offset" in stage ? stage.offset : 0}`;
  const statements = [
    audit(
      d1,
      actor,
      mapping.organization.id,
      mapping.space.id,
      action,
      subjectId,
      stage.kind === "complete"
        ? {
            organization: mapping.organization,
            space: mapping.space,
            organizationMembers: mapping.organizationMembers,
            spaceGrants: mapping.spaceGrants,
          }
        : stage,
      "p.is_site_admin = 1",
      [],
      provenance,
    ),
  ];
  if (stage.kind === "identity")
    statements.push(
      organizationInsert(d1, mapping.organization, true),
      spaceInsert(d1, mapping.space),
    );
  if (stage.kind === "members")
    for (const member of mapping.organizationMembers.slice(
      stage.offset,
      stage.offset + SPACE_IMPORT_BATCH,
    )) {
      statements.push(
        membership(
          d1,
          actor,
          mapping.organization.id,
          member.accountId,
          member.role,
          `migration:${provenance.runId}`,
          true,
        ),
      );
    }
  if (stage.kind === "grants")
    for (const entry of mapping.spaceGrants.slice(
      stage.offset,
      stage.offset + SPACE_IMPORT_BATCH,
    )) {
      statements.push(
        grant(d1, actor, mapping.organization.id, mapping.space.id, entry, entry.origin),
      );
    }
  return { statements, action, subjectId };
}
