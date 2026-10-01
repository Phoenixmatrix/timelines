// Authorization for the registry, in gitmatrix's terms. Feeds belong to an
// owner (user or org), so access follows the owner:
//
//   people   the owner, and org owners: admin. Org members: read, or write when
//            the org gives members write. Collaborators: write when they can
//            write one of the owner's repositories (the publish gate then
//            checks it's a source of the package), else read. Site admins:
//            everything. Deleting published versions takes admin.
//   CI jobs  publish as their repository: read and write in their owner's
//            feeds, and in any feed where their repository is a granted source
//            of some package. Which packages a repository may publish is the
//            publish gate's call (provenance.ts), not this one.
//
// A token's scope caps all of it, and registry tokens (Docker's token flow)
// carry exactly the grants they were issued with.

import { db as gitmatrixDb, type DB as GitmatrixDB } from "../../worker/schema.ts";
import { type Actor, type Scope } from "./auth/actor.ts";
import type { DB } from "./db.ts";
import { RegistryError } from "./errors.ts";
import type { Repository } from "./repos.ts";

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

export class AccessControl {
  private readonly ownerRoles = new Map<string, Promise<Role | null>>();
  private readonly sourceFeeds = new Map<string, Promise<boolean>>();

  private readonly db: DB;
  /** gitmatrix's database: accounts, orgs, repositories, collaborators. */
  private readonly gitmatrix: GitmatrixDB;
  readonly actor: Actor;

  constructor(db: DB, gitmatrix: D1Database, actor: Actor) {
    this.db = db;
    this.gitmatrix = gitmatrixDb(gitmatrix);
    this.actor = actor;
  }

  async isAdmin(): Promise<boolean> {
    return this.actor.kind === "user" && this.actor.isSiteAdmin === true;
  }

  private hasScope(action: Action): boolean {
    return ACTION_SCOPES[action].some((scope) => this.actor.scopes.has(scope));
  }

  /** What a person may do with everything an owner publishes. */
  roleForOwner(ownerId: string): Promise<Role | null> {
    let memo = this.ownerRoles.get(ownerId);
    if (!memo) {
      memo = (async (): Promise<Role | null> => {
        const actor = this.actor;
        if (actor.kind !== "user" || !actor.subject) return null;
        if (actor.subject === ownerId) return "admin";
        const userId = actor.subject;
        const row = await this.gitmatrix
          .selectFrom("accounts as a")
          .select((eb) => [
            "a.kind",
            "a.member_repo_role",
            eb
              .selectFrom("org_members as m")
              .select("m.role")
              .whereRef("m.org_id", "=", "a.id")
              .where("m.user_id", "=", userId)
              .as("org_role"),
            eb
              .selectFrom("repo_collaborators as c")
              .innerJoin("repos as r", "r.id", "c.repo_id")
              .select((sub) =>
                sub.fn
                  .max<number | null>(sub.case("c.role").when("read").then(1).else(2).end())
                  .as("rank"),
              )
              .whereRef("r.owner_id", "=", "a.id")
              .where("c.user_id", "=", userId)
              .as("collaborator"),
          ])
          .where("a.id", "=", ownerId)
          .executeTakeFirst();
        if (!row) return null;
        if (row.org_role === "owner") return "admin";
        if (row.org_role === "member" && row.member_repo_role === "write") return "write";
        if (row.collaborator === 2) return "write";
        if (row.org_role === "member" || row.collaborator) return "read";
        return null;
      })();
      this.ownerRoles.set(ownerId, memo);
    }
    return memo;
  }

  /** A CI job whose repository is a granted source of something in this feed. */
  private jobIsSourceIn(repo: Repository): Promise<boolean> {
    const job = this.actor.job;
    if (!job) return Promise.resolve(false);
    let memo = this.sourceFeeds.get(repo.id);
    if (!memo) {
      memo = this.db
        .selectFrom("package_sources as s")
        .innerJoin("packages as p", "p.id", "s.package_id")
        .select("s.package_id")
        .where("p.repo_id", "=", repo.id)
        .where("s.git_repo_id", "=", job.repoId)
        .limit(1)
        .executeTakeFirst()
        .then((row) => row !== undefined);
      this.sourceFeeds.set(repo.id, memo);
    }
    return memo;
  }

  /**
   * `resource` is the OCI repository name (`<repo>/<image>`) when the caller
   * holds a registry token, whose grants are per image.
   */
  async can(repo: Repository, action: Action, resource?: string): Promise<boolean> {
    const actor = this.actor;
    if (actor.via === "registry") {
      const wanted = OCI_ACTIONS[action];
      const grants = actor.access ?? [];
      return grants.some(
        (g) =>
          g.type === "repository" &&
          (resource
            ? g.name === resource
            : g.name === repo.key || g.name.startsWith(`${repo.key}/`)) &&
          (g.actions.includes("*") || wanted.some((a) => g.actions.includes(a))),
      );
    }

    if (action === "read") {
      if (repo.visibility === "public") return true;
      if (repo.visibility === "internal" && actor.kind !== "anonymous") return true;
    }
    if (actor.kind === "anonymous") return false;
    if (!this.hasScope(action)) return false;
    if (await this.isAdmin()) return true;

    if (actor.kind === "job") {
      if (action === "admin" || action === "delete") return false;
      if (actor.job?.ownerId === repo.ownerId) return true;
      return this.jobIsSourceIn(repo);
    }
    const role = await this.roleForOwner(repo.ownerId);
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
