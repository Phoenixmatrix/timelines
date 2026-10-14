import type {
  AccountSummary,
  AgentRef,
  RepoRole,
  RepoSummary,
  Viewer,
  Visibility,
} from "../shared/api.ts";
import { sql } from "kysely";
import { avatarUrl } from "./avatars/api.ts";
import { repoRole } from "./permissions.ts";
import { db } from "./schema.ts";
import { preferredSpace, type DefaultScope, type SpaceSummary } from "../shared/spaces.ts";
import { findSpaceById, listSpaceAccess, resolveSpaceAccess } from "./spaces/access.ts";
import { listOrganizations } from "./spaces/store.ts";

/** A signed-in person, as the Worker sees them. */
export interface Actor {
  id: string;
  slug: string;
  displayName: string;
  isSiteAdmin: boolean;
  /** Nonsecret identity of the credential authorizing delayed work. */
  credential?: { kind: "token" | "session"; id: string };
  /**
   * Set when an agent's token signed in: the agent acts with this person's
   * permissions, and what it does is attributed to the agent.
   */
  agent?: AgentRef;
}

export interface AccountRow {
  id: string;
  kind: "user";
  slug: string;
  display_name: string;
  bio: string;
  is_site_admin: number;
  avatar_key: string | null;
}

export interface RepoRow {
  id: string;
  space_id: string;
  name: string;
  description: string;
  visibility: Visibility;
  default_branch: string;
  artifacts_name: string;
  artifacts_remote: string;
  imported_from: string | null;
  created_at: string;
  pushed_at: string | null;
  /** Set while the repository is being deleted (only `deleting` lookups return one). */
  deleted_at: string | null;
  space_slug: string;
  space_display_name: string;
  space_archived_at: string | null;
  space_authorization_version: number;
  space_created_at: string;
  organization_id: string;
  organization_slug: string;
  organization_display_name: string;
  organization_kind: "company" | "personal";
  organization_avatar_key: string | null;
  personal_account_id: string | null;
  default_space_id: string;
  organization_created_at: string;
  space_role: "admin" | "member" | null;
  repository_role: "none" | "read" | "write" | null;
  collaborator_role: "read" | "write" | "admin" | null;
}

/** The database's clock as an ISO timestamp, matching the columns' defaults. */
export const sqlNow = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

// The viewer's account id is "" when signed out, so the per-viewer columns
// come back null for anonymous requests. A repository being deleted
// (deleted_at, CORE-199) is missing to every reader; only the paths a
// deletion's own preview teardown needs (a local runner claiming and
// reporting its job) ask for it with `deleting`.
export function selectRepos(
  d1: D1Database,
  viewerId: string,
  options: { deleting?: boolean } = {},
) {
  const query = db(d1)
    .selectFrom("repos as r")
    .innerJoin("spaces as s", "s.id", "r.space_id")
    .innerJoin("organizations as o", "o.id", "s.organization_id")
    .where("s.archived_at", "is", null)
    .selectAll("r")
    .select((eb) => [
      "s.id as space_id",
      "s.slug as space_slug",
      "s.display_name as space_display_name",
      "s.archived_at as space_archived_at",
      "s.authorization_version as space_authorization_version",
      "s.created_at as space_created_at",
      "o.id as organization_id",
      "o.slug as organization_slug",
      "o.display_name as organization_display_name",
      "o.kind as organization_kind",
      "o.avatar_key as organization_avatar_key",
      "o.personal_account_id",
      "o.default_space_id",
      "o.created_at as organization_created_at",
      eb
        .selectFrom("space_grants as g")
        .innerJoin("organization_members as m", (join) =>
          join
            .onRef("m.organization_id", "=", "g.organization_id")
            .onRef("m.account_id", "=", "g.account_id"),
        )
        .select("g.role")
        .whereRef("g.space_id", "=", "s.id")
        .whereRef("g.organization_id", "=", "s.organization_id")
        .where("g.account_id", "=", viewerId)
        .as("space_role"),
      eb
        .selectFrom("space_grants as g")
        .innerJoin("organization_members as m", (join) =>
          join
            .onRef("m.organization_id", "=", "g.organization_id")
            .onRef("m.account_id", "=", "g.account_id"),
        )
        .select("g.repository_role")
        .whereRef("g.space_id", "=", "s.id")
        .whereRef("g.organization_id", "=", "s.organization_id")
        .where("g.account_id", "=", viewerId)
        .as("repository_role"),
      eb
        .selectFrom("repo_collaborators as c")
        .select("c.role")
        .whereRef("c.repo_id", "=", "r.id")
        .where("c.user_id", "=", viewerId)
        .as("collaborator_role"),
    ]);
  return options.deleting ? query : query.where("r.deleted_at", "is", null);
}

export function accountSummary(row: AccountRow): AccountSummary {
  return {
    id: row.id,
    kind: "user",
    slug: row.slug,
    displayName: row.display_name,
    avatarUrl: avatarUrl(row.avatar_key),
  };
}

export function actorFromRow(row: AccountRow): Actor {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    isSiteAdmin: row.is_site_admin === 1,
  };
}

export async function findUserById(d1: D1Database, id: string): Promise<Actor | null> {
  const row = await db(d1)
    .selectFrom("accounts")
    .selectAll()
    .where("id", "=", id)
    .where("kind", "=", "user")
    .executeTakeFirst();
  return row ? actorFromRow(row) : null;
}

export async function findAccountBySlug(d1: D1Database, slug: string): Promise<AccountRow | null> {
  const row = await db(d1)
    .selectFrom("accounts")
    .selectAll()
    .where("kind", "=", "user")
    .where("slug", "=", slug)
    .executeTakeFirst();
  return row ?? null;
}

export function roleFor(row: RepoRow, actor: Actor | null): RepoRole {
  return repoRole({
    visibility: row.visibility,
    spaceRole: row.space_role,
    repositoryRole: row.repository_role,
    viewer: actor,
    collaboratorRole: row.collaborator_role,
  });
}

/** Same resource-only access rules as roleFor, before ranking/counting/limiting. */
export function readableRepo(actor: Actor | null) {
  if (actor?.isSiteAdmin) return sql<boolean>`1`;
  const viewerId = actor?.id ?? "";
  return sql<boolean>`(
    r.visibility = 'public'
    OR EXISTS (
      SELECT 1 FROM space_grants g JOIN organization_members m
        ON m.organization_id = g.organization_id AND m.account_id = g.account_id
      WHERE g.space_id = s.id AND g.organization_id = s.organization_id
        AND g.account_id = ${viewerId}
        AND (g.role = 'admin' OR g.repository_role IN ('read', 'write'))
    )
    OR EXISTS (SELECT 1 FROM repo_collaborators c WHERE c.repo_id = r.id AND c.user_id = ${viewerId})
  )`;
}

export function repoSpace(row: RepoRow): SpaceSummary {
  return {
    id: row.space_id,
    slug: row.space_slug,
    displayName: row.space_display_name,
    organizationId: row.organization_id,
    archivedAt: row.space_archived_at,
    authorizationVersion: row.space_authorization_version,
    createdAt: row.space_created_at,
    organization: {
      id: row.organization_id,
      slug: row.organization_slug,
      displayName: row.organization_display_name,
      kind: row.organization_kind,
      personalAccountId: row.personal_account_id,
      defaultSpaceId: row.default_space_id,
      createdAt: row.organization_created_at,
      avatarUrl: avatarUrl(row.organization_avatar_key),
    },
  };
}

export function repoSummary(row: RepoRow, actor: Actor | null): RepoSummary {
  return {
    id: row.id,
    space: repoSpace(row),
    name: row.name,
    description: row.description,
    visibility: row.visibility,
    defaultBranch: row.default_branch,
    viewerRole: roleFor(row, actor),
    createdAt: row.created_at,
    pushedAt: row.pushed_at,
    importedFrom: row.imported_from,
  };
}

export async function findRepo(
  d1: D1Database,
  actor: Actor | null,
  space: string,
  name: string,
  options: { deleting?: boolean } = {},
): Promise<RepoRow | null> {
  const row = await selectRepos(d1, actor?.id ?? "", options)
    .where("s.slug", "=", space)
    .where("r.name", "=", name)
    .executeTakeFirst();
  return row ?? null;
}

/** Repositories the actor can read, most recently pushed first. */
export async function visibleRepos(
  d1: D1Database,
  actor: Actor | null,
  spaceId?: string,
): Promise<RepoSummary[]> {
  let query = selectRepos(d1, actor?.id ?? "");
  if (spaceId) query = query.where("r.space_id", "=", spaceId);
  const results: RepoRow[] = await query.execute();
  return results
    .map((row) => repoSummary(row, actor))
    .filter((repo) => repo.viewerRole !== "none")
    .sort((a, b) => (b.pushedAt ?? b.createdAt).localeCompare(a.pushedAt ?? a.createdAt));
}

/** The default Organization and Space a person saved (CORE-413), as saved. */
export async function savedDefault(d1: D1Database, accountId: string): Promise<DefaultScope> {
  const row = await db(d1)
    .selectFrom("accounts")
    .select(["preferred_organization_id", "preferred_space_id"])
    .where("id", "=", accountId)
    .executeTakeFirst();
  return {
    organizationId: row?.preferred_organization_id ?? null,
    spaceId: row?.preferred_organization_id ? (row.preferred_space_id ?? null) : null,
  };
}

export async function viewerFor(d1: D1Database, actor: Actor): Promise<Viewer> {
  // Every navigation reads the viewer: one query for all granted Spaces, not one per
  // Space. Without an Organization there is nothing to grant, and a not-yet-cutover
  // schema (no Organization avatars) must still answer the session.
  const [organizations, account] = await Promise.all([
    listOrganizations(d1, actor),
    db(d1)
      .selectFrom("accounts")
      .select(["email", "avatar_key", "preferred_organization_id", "preferred_space_id"])
      .where("id", "=", actor.id)
      .executeTakeFirst(),
  ]);
  const granted = organizations.length ? await listSpaceAccess(d1, actor) : [];
  const spaces = granted.map((access) => access.space);
  const personal = organizations.find(
    (organization) => organization.personalAccountId === actor.id,
  );
  const { email, avatar_key } = account ?? { email: null, avatar_key: null };
  // The saved default (CORE-413) comes with the same account read.
  const saved: DefaultScope = {
    organizationId: account?.preferred_organization_id ?? null,
    spaceId: account?.preferred_organization_id ? (account.preferred_space_id ?? null) : null,
  };
  const self: AccountSummary = {
    id: actor.id,
    kind: "user",
    slug: actor.slug,
    displayName: actor.displayName,
    avatarUrl: avatarUrl(avatar_key),
  };
  return {
    ...self,
    agent: actor.agent ?? null,
    kind: "user",
    isSiteAdmin: actor.isSiteAdmin,
    email,
    organizations,
    spaces,
    personalOrganizationId: personal?.id ?? null,
    defaultSpaceId:
      preferredSpace(saved, spaces)?.id ??
      (personal && spaces.some((space) => space.id === personal.defaultSpaceId)
        ? personal.defaultSpaceId
        : null),
    savedDefault: saved,
  };
}

/** Creation is an explicit live Space grant or the separate Instance operator power. */
export async function canCreateRepository(d1: D1Database, actor: Actor, spaceId: string) {
  if (await resolveSpaceAccess(d1, actor, spaceId)) return true;
  if (!actor.isSiteAdmin) return false;
  const space = await findSpaceById(d1, spaceId);
  return space !== null && space.archivedAt === null;
}
