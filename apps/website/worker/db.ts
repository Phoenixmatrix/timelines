import type {
  AccountSummary,
  AgentRef,
  RepoRole,
  RepoSummary,
  Viewer,
  Visibility,
} from "../shared/api.ts";
import { sql } from "kysely";
import { repoRole } from "./permissions.ts";
import { db } from "./schema.ts";

/** A signed-in person, as the Worker sees them. */
export interface Actor {
  id: string;
  slug: string;
  displayName: string;
  isSiteAdmin: boolean;
  /**
   * Set when an agent's token signed in: the agent acts with this person's
   * permissions, and what it does is attributed to the agent.
   */
  agent?: AgentRef;
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

/** The database's clock as an ISO timestamp, matching the columns' defaults. */
export const sqlNow = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;

// The viewer's account id is "" when signed out, so the per-viewer columns
// come back null for anonymous requests.
function selectRepos(d1: D1Database, viewerId: string) {
  return db(d1)
    .selectFrom("repos as r")
    .innerJoin("accounts as o", "o.id", "r.owner_id")
    .selectAll("r")
    .select((eb) => [
      "o.slug as owner_slug",
      "o.kind as owner_kind",
      "o.display_name as owner_display_name",
      "o.member_repo_role",
      eb
        .selectFrom("org_members as m")
        .select("m.role")
        .whereRef("m.org_id", "=", "r.owner_id")
        .where("m.user_id", "=", viewerId)
        .as("org_role"),
      eb
        .selectFrom("repo_collaborators as c")
        .select("c.role")
        .whereRef("c.repo_id", "=", "r.id")
        .where("c.user_id", "=", viewerId)
        .as("collaborator_role"),
    ]);
}

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
    .where("slug", "=", slug)
    .executeTakeFirst();
  return row ?? null;
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
  d1: D1Database,
  actor: Actor | null,
  owner: string,
  name: string,
): Promise<RepoRow | null> {
  const row = await selectRepos(d1, actor?.id ?? "")
    .where("o.slug", "=", owner)
    .where("r.name", "=", name)
    .executeTakeFirst();
  return row ?? null;
}

/** Repositories the actor can read, most recently pushed first. */
export async function visibleRepos(
  d1: D1Database,
  actor: Actor | null,
  ownerId?: string,
): Promise<RepoSummary[]> {
  let query = selectRepos(d1, actor?.id ?? "");
  if (ownerId) query = query.where("r.owner_id", "=", ownerId);
  const results: RepoRow[] = await query.execute();
  return results
    .map((row) => repoSummary(row, actor))
    .filter((repo) => repo.viewerRole !== "none")
    .sort((a, b) => (b.pushedAt ?? b.createdAt).localeCompare(a.pushedAt ?? a.createdAt));
}

export async function viewerFor(d1: D1Database, actor: Actor): Promise<Viewer> {
  const orgs: AccountRow[] = actor.isSiteAdmin
    ? await db(d1)
        .selectFrom("accounts")
        .selectAll()
        .where("kind", "=", "org")
        .orderBy("slug")
        .execute()
    : await db(d1)
        .selectFrom("accounts as a")
        .innerJoin("org_members as m", "m.org_id", "a.id")
        .selectAll("a")
        .where("m.user_id", "=", actor.id)
        .orderBy("a.slug")
        .execute();
  const self: AccountSummary = {
    id: actor.id,
    kind: "user",
    slug: actor.slug,
    displayName: actor.displayName,
  };
  const { email } = (await db(d1)
    .selectFrom("accounts")
    .select("email")
    .where("id", "=", actor.id)
    .executeTakeFirst()) ?? { email: null };
  return {
    ...self,
    agent: actor.agent ?? null,
    kind: "user",
    isSiteAdmin: actor.isSiteAdmin,
    email,
    canCreateIn: [self, ...orgs.map(accountSummary)],
  };
}

/** Who may create repositories under an owner: the user themselves, org members, site admins. */
export async function canCreateIn(d1: D1Database, actor: Actor, owner: AccountRow) {
  if (actor.isSiteAdmin || owner.id === actor.id) return true;
  if (owner.kind !== "org") return false;
  const membership = await db(d1)
    .selectFrom("org_members")
    .select("role")
    .where("org_id", "=", owner.id)
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  return membership !== undefined;
}
