import type { AccountSummary, RepoRole, RepoSummary, Viewer, Visibility } from "../shared/api.ts";
import { repoRole } from "./permissions.ts";

/** A signed-in person, as the Worker sees them. */
export interface Actor {
  id: string;
  slug: string;
  displayName: string;
  isSiteAdmin: boolean;
}

export interface AccountRow {
  id: string;
  kind: "user" | "org";
  slug: string;
  display_name: string;
  bio: string;
  is_site_admin: number;
  member_repo_role: "none" | "read" | "write" | null;
}

export interface RepoRow {
  id: string;
  owner_id: string;
  name: string;
  description: string;
  visibility: Visibility;
  default_branch: string;
  artifacts_name: string;
  artifacts_remote: string;
  imported_from: string | null;
  created_at: string;
  pushed_at: string | null;
  owner_slug: string;
  owner_kind: "user" | "org";
  owner_display_name: string;
  member_repo_role: "none" | "read" | "write" | null;
  org_role: "owner" | "member" | null;
  collaborator_role: "read" | "write" | "admin" | null;
}

// ?1 is the viewer's account id ("" when signed out), so the per-viewer
// columns come back null for anonymous requests.
const REPO_SELECT = `
  SELECT r.*, o.slug AS owner_slug, o.kind AS owner_kind, o.display_name AS owner_display_name,
    o.member_repo_role,
    (SELECT role FROM org_members m WHERE m.org_id = r.owner_id AND m.user_id = ?1) AS org_role,
    (SELECT role FROM repo_collaborators c WHERE c.repo_id = r.id AND c.user_id = ?1) AS collaborator_role
  FROM repos r JOIN accounts o ON o.id = r.owner_id`;

export function accountSummary(row: AccountRow): AccountSummary {
  return { id: row.id, kind: row.kind, slug: row.slug, displayName: row.display_name };
}

export function actorFromRow(row: AccountRow): Actor {
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    isSiteAdmin: row.is_site_admin === 1,
  };
}

export async function findUserById(db: D1Database, id: string): Promise<Actor | null> {
  const row = await db
    .prepare("SELECT * FROM accounts WHERE id = ? AND kind = 'user'")
    .bind(id)
    .first<AccountRow>();
  return row ? actorFromRow(row) : null;
}

export async function findAccountBySlug(db: D1Database, slug: string): Promise<AccountRow | null> {
  return db.prepare("SELECT * FROM accounts WHERE slug = ?").bind(slug).first<AccountRow>();
}

export function roleFor(row: RepoRow, actor: Actor | null): RepoRole {
  return repoRole({
    visibility: row.visibility,
    ownerId: row.owner_id,
    ownerKind: row.owner_kind,
    orgMemberRepoRole: row.member_repo_role,
    viewer: actor,
    orgRole: row.org_role,
    collaboratorRole: row.collaborator_role,
  });
}

export function repoSummary(row: RepoRow, actor: Actor | null): RepoSummary {
  return {
    id: row.id,
    owner: {
      id: row.owner_id,
      kind: row.owner_kind,
      slug: row.owner_slug,
      displayName: row.owner_display_name,
    },
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
  db: D1Database,
  actor: Actor | null,
  owner: string,
  name: string,
): Promise<RepoRow | null> {
  return db
    .prepare(`${REPO_SELECT} WHERE o.slug = ?2 AND r.name = ?3`)
    .bind(actor?.id ?? "", owner, name)
    .first<RepoRow>();
}

/** Repositories the actor can read, most recently pushed first. */
export async function visibleRepos(
  db: D1Database,
  actor: Actor | null,
  ownerId?: string,
): Promise<RepoSummary[]> {
  const statement = ownerId
    ? db.prepare(`${REPO_SELECT} WHERE r.owner_id = ?2`).bind(actor?.id ?? "", ownerId)
    : db.prepare(REPO_SELECT).bind(actor?.id ?? "");
  const { results } = await statement.all<RepoRow>();
  return results
    .map((row) => repoSummary(row, actor))
    .filter((repo) => repo.viewerRole !== "none")
    .sort((a, b) => (b.pushedAt ?? b.createdAt).localeCompare(a.pushedAt ?? a.createdAt));
}

export async function viewerFor(db: D1Database, actor: Actor): Promise<Viewer> {
  const orgs = actor.isSiteAdmin
    ? await db.prepare("SELECT * FROM accounts WHERE kind = 'org' ORDER BY slug").all<AccountRow>()
    : await db
        .prepare(
          `SELECT a.* FROM accounts a JOIN org_members m ON m.org_id = a.id
           WHERE m.user_id = ? ORDER BY a.slug`,
        )
        .bind(actor.id)
        .all<AccountRow>();
  const self: AccountSummary = {
    id: actor.id,
    kind: "user",
    slug: actor.slug,
    displayName: actor.displayName,
  };
  return {
    ...self,
    kind: "user",
    isSiteAdmin: actor.isSiteAdmin,
    canCreateIn: [self, ...orgs.results.map(accountSummary)],
  };
}

/** Who may create repositories under an owner: the user themselves, org members, site admins. */
export async function canCreateIn(db: D1Database, actor: Actor, owner: AccountRow) {
  if (actor.isSiteAdmin || owner.id === actor.id) return true;
  if (owner.kind !== "org") return false;
  const membership = await db
    .prepare("SELECT role FROM org_members WHERE org_id = ? AND user_id = ?")
    .bind(owner.id, actor.id)
    .first();
  return membership !== null;
}
