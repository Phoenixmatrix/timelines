import type { RepoRole } from "../shared/api.ts";

const RANK: Record<RepoRole, number> = { none: 0, read: 1, write: 2, admin: 3 };

/** Everything that decides one person's access to one repository. */
export interface RepoAccessFacts {
  visibility: "public" | "private";
  /** Already resolved against a live Organization membership and Space grant. */
  spaceRole: "admin" | "member" | null;
  repositoryRole: "none" | "read" | "write" | null;
  viewer: { id: string; isSiteAdmin: boolean } | null;
  /** The viewer's explicit collaborator role on this repo, if any. */
  collaboratorRole: "read" | "write" | "admin" | null;
}

export function atLeast(role: RepoRole, needed: RepoRole): boolean {
  return RANK[role] >= RANK[needed];
}

function highest(roles: RepoRole[]): RepoRole {
  return roles.reduce<RepoRole>((best, role) => (RANK[role] > RANK[best] ? role : best), "none");
}

/** The strongest role any rule grants; access only ever adds up. */
export function repoRole(facts: RepoAccessFacts): RepoRole {
  const grants: RepoRole[] = [];
  if (facts.visibility === "public") grants.push("read");

  const viewer = facts.viewer;
  if (viewer) {
    if (viewer.isSiteAdmin) grants.push("admin");
    if (facts.spaceRole === "admin") grants.push("admin");
    if (facts.spaceRole === "member") grants.push(facts.repositoryRole ?? "none");
    if (facts.collaboratorRole) grants.push(facts.collaboratorRole);
  }

  return highest(grants);
}
