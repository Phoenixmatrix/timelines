/** Bounded serialized migration progress, not an arbitrary-database size guarantee. */
export const WORK_STATE_MAX_CHARACTERS = 32_000_000;

export interface SpaceMigrationContext {
  runId: string;
  migrationEpoch: number;
  manifestDigest: string;
  legacyOwnerId: string;
  spaceId: string;
  organizationId: string;
  spaceSlug: string;
  contractVersion: 4;
}

export type SpaceParticipantOperation =
  | "inventory"
  | "export"
  | "migrate"
  | "reconcile"
  | "restore"
  | "release-legacy"
  /** Logging Artifacts ref moves no push recorded, under the storage fence. */
  | "refs";
export type SpaceParticipantGuard = (
  context: SpaceMigrationContext,
  operation: SpaceParticipantOperation,
) => Promise<void>;
export interface SpaceCheckpointPage {
  cursor: string | null;
  nextCursor: string | null;
  payload: string;
  digest: string;
}
export interface SpaceParticipantInventory {
  storeId: string;
  digest: string;
  counts: Record<string, number>;
}
export interface SpaceReconciliation extends SpaceParticipantInventory {
  preserved: boolean;
}
export interface SpaceMapping {
  legacyOwner: { id: string; kind: "user" | "org"; slug: string };
  organization: {
    id: string;
    slug: string;
    displayName: string;
    kind: "personal" | "company";
    personalAccountId: string | null;
    defaultSpaceId: string;
  };
  space: {
    id: string;
    organizationId: string;
    slug: string;
    displayName: string;
    archived: boolean;
  };
  organizationMembers: { accountId: string; role: "owner" | "member" }[];
  spaceGrants: {
    accountId: string;
    role: "admin" | "member";
    repositoryRole: "none" | "read" | "write";
    packageRole: "none" | "read" | "write";
    origin: string;
  }[];
  trackerDoName: string;
  repositories: { id: string; name: string; visibility: string; artifactsName: string }[];
  repositoryCollaborators: {
    repoId: string;
    accountId: string;
    role: "read" | "write" | "admin";
  }[];
  registryFeeds: { id: string; key: string; format: string; kind: string; visibility: string }[];
  providers: { id: string; kind: string }[];
  hasContentSettings: boolean;
}
export interface SpaceManifest {
  manifestVersion: 1;
  contentContractVersion: 4;
  source: string;
  sourceCommit: string;
  mapping: SpaceMapping[];
}

/** Stable canonical bytes bind approvals to content, not caller approval flags. */
export function canonicalSpaceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalSpaceJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSpaceJson(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Unsupported checkpoint value");
  return encoded;
}
export async function spaceDigest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
