// Registry access is Space-scoped. Package baselines are independent of
// repository baselines; repository collaboration never grants feed access.
// OCI grants cap current authorization, rather than preserving old privileges.

import type { Actor as Person } from "../../worker/db.ts";
import { findSpaceById, resolveSpaceAccess } from "../../worker/spaces/access.ts";
import { currentPerson } from "./auth/authenticate.ts";
import { type Actor, type Scope } from "./auth/actor.ts";
import type { DB } from "./db.ts";
import { RegistryError } from "./errors.ts";
import { getRepoById, type Repository } from "./repos.ts";

export type Action = "read" | "write" | "delete" | "admin";
type Role = "read" | "write" | "admin";

const ROLE_RANK: Record<Role, number> = { read: 1, write: 2, admin: 3 };
// Deleting published versions is destructive: owner admins only, never CI.
const ACTION_ROLE: Record<Action, Role> = {
  read: "read",
  write: "write",
  delete: "admin",
  admin: "admin",
};
const ACTION_SCOPES: Record<Action, Scope[]> = {
  read: ["packages:read", "packages:write", "packages:delete", "packages:admin"],
  write: ["packages:write", "packages:admin"],
  delete: ["packages:delete", "packages:admin"],
  admin: ["packages:admin"],
};
/** OCI token actions for each registry action. */
const OCI_ACTIONS: Record<Action, string[]> = {
  read: ["pull"],
  write: ["push"],
  delete: ["delete"],
  admin: ["*"],
};

/** Shared by non-registry consumers of package provenance. */
export async function canReadSpacePackages(
  d1: D1Database,
  actor: Person | null,
  spaceId: string,
  visibility: "public" | "internal" | "private",
): Promise<boolean> {
  const space = await findSpaceById(d1, spaceId);
  if (!space || space.archivedAt) return false;
  if (visibility === "public") return true;
  const access = await resolveSpaceAccess(d1, actor, spaceId);
  if (access?.grant.role === "admin" || (access && access.grant.packageRole !== "none"))
    return true;
  if (!actor?.isSiteAdmin) return false;
  const person = await d1
    .prepare("SELECT is_site_admin FROM accounts WHERE id = ? AND kind = 'user'")
    .bind(actor.id)
    .first<{ is_site_admin: number }>();
  if (!person?.is_site_admin) return false;
  if (!actor.agent) return true;
  return !!(await d1
    .prepare("SELECT id FROM agents WHERE id = ? AND accountable_id = ? AND revoked_at IS NULL")
    .bind(actor.agent.id, actor.id)
    .first());
}

export class AccessControl {
  private readonly db: DB;
  private readonly gitmatrix: D1Database;
  readonly actor: Actor;

  constructor(db: DB, gitmatrix: D1Database, actor: Actor) {
    this.db = db;
    this.gitmatrix = gitmatrix;
    this.actor = actor;
  }

  async isAdmin(): Promise<boolean> {
    const person = await currentPerson(this.gitmatrix, this.actor);
    return this.actor.kind === "user" && person?.isSiteAdmin === true;
  }

  private hasScope(action: Action): boolean {
    return ACTION_SCOPES[action].some((scope) => this.actor.scopes.has(scope));
  }

  /** The current person's independent package baseline, never a repo aggregate. */
  async roleForSpace(spaceId: string): Promise<Role | null> {
    const person = await currentPerson(this.gitmatrix, this.actor);
    const access = await resolveSpaceAccess(this.gitmatrix, person, spaceId);
    if (!access) return null;
    if (access.grant.role === "admin") return "admin";
    return access.grant.packageRole === "none" ? null : access.grant.packageRole;
  }

  /**
   * `resource` is the OCI repository name (`<repo>/<image>`) when the caller
   * holds a registry token, whose grants are per image.
   */
  async can(repo: Repository, action: Action, resource?: string): Promise<boolean> {
    const current = await getRepoById(this.db, repo.id);
    if (!current || current.spaceId !== repo.spaceId) return false;
    repo = current;
    const actor = this.actor;
    if (actor.via === "registry") {
      const wanted = OCI_ACTIONS[action];
      const grants = actor.access ?? [];
      if (
        !grants.some(
          (g) =>
            g.type === "repository" &&
            (resource
              ? g.name === resource
              : g.name === repo.key || g.name.startsWith(`${repo.key}/`)) &&
            (g.actions.includes("*") || wanted.some((a) => g.actions.includes(a))),
        )
      )
        return false;
    }

    const space = await findSpaceById(this.gitmatrix, repo.spaceId);
    if (!space || space.archivedAt) return false;
    if (action === "read" && repo.visibility === "public") return true;
    if (actor.kind === "anonymous") return false;
    if (!this.hasScope(action)) return false;
    if (await this.isAdmin()) return true;

    if (actor.kind === "job") {
      if (action === "admin" || action === "delete") return false;
      if (actor.job?.spaceId !== repo.spaceId) return false;
    }
    const role = await this.roleForSpace(repo.spaceId);
    return role !== null && ROLE_RANK[role] >= ROLE_RANK[ACTION_ROLE[action]];
  }

  /** Throws 401 for anonymous callers (so clients retry with credentials), else 403. */
  async require(repo: Repository, action: Action, resource?: string): Promise<void> {
    if (await this.can(repo, action, resource)) return;
    if (this.actor.kind === "anonymous") throw RegistryError.unauthorized();
    throw RegistryError.denied(`You do not have ${action} access to ${repo.key}`);
  }

  /** Site-wide administration. */
  async requireAdmin(): Promise<void> {
    if (this.actor.kind === "anonymous") throw RegistryError.unauthorized();
    if (!(await this.isAdmin())) throw RegistryError.denied("Site administrators only");
  }
}
