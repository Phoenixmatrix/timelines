import type { AgentRef } from "./api.ts";

/** JSON content protocol; independent cutover admission still governs availability. */
export const CONTENT_CONTRACT_VERSION = 4 as const;
export const CONTENT_CONTRACT_HEADER = "X-Gitmatrix-Content-Version";
export type ContentRole = "none" | "read" | "write";
export interface OrganizationSummary {
  id: string;
  slug: string;
  avatarUrl: string | null;
  displayName: string;
  kind: "company" | "personal";
  personalAccountId: string | null;
  defaultSpaceId: string;
  createdAt: string;
}
export interface SpaceSummary {
  id: string;
  organizationId: string;
  organization: OrganizationSummary;
  slug: string;
  displayName: string;
  archivedAt: string | null;
  authorizationVersion: number;
  createdAt: string;
}
export interface SpaceGrant {
  spaceId: string;
  accountId: string;
  role: "admin" | "member";
  repositoryRole: ContentRole;
  packageRole: ContentRole;
  origin: string;
  grantedAt: string;
  grantedBy: string;
  grantedByAgentId: string | null;
}
export interface SpaceAccess {
  space: SpaceSummary;
  spaceId: string;
  personId: string;
  agent?: AgentRef;
  grant: SpaceGrant;
  authorizationVersion: number;
  contractVersion: typeof CONTENT_CONTRACT_VERSION;
}

export interface SpaceCapabilities {
  canReadContent: boolean;
  canAdministerContent: boolean;
  canCreateRepository: boolean;
  canManageGrants: boolean;
}
export interface SpacePage {
  space: SpaceSummary;
  grant: SpaceGrant | null;
  capabilities: SpaceCapabilities;
  contractVersion: typeof CONTENT_CONTRACT_VERSION;
  migrationEpoch: number;
}
export interface OrganizationPage {
  organization: OrganizationSummary;
  activeSpaceCount: number;
  viewerRole: "owner" | "member";
  spaces: SpacePage[];
}

/** Legacy package read is independent of the repository baseline. */
export function legacyMemberRoles(repositoryRole: ContentRole): {
  repositoryRole: ContentRole;
  packageRole: ContentRole;
} {
  return { repositoryRole, packageRole: repositoryRole === "write" ? "write" : "read" };
}
