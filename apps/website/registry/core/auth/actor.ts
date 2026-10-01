export type Scope = "packages:read" | "packages:write" | "packages:delete" | "packages:admin";

export const ALL_SCOPES: Scope[] = [
  "packages:read",
  "packages:write",
  "packages:delete",
  "packages:admin",
];

/** An OCI-style grant carried by registry-issued tokens. */
export interface AccessGrant {
  type: string;
  name: string;
  actions: string[];
}

/**
 * The CI job a credential belongs to. Jobs publish as their repository: the
 * repository is the identity, and every publish records the commit and run.
 */
export interface JobIdentity {
  jobId: string;
  jobName: string;
  runId: string;
  runNumber: number;
  /** gitmatrix repos.id, its owner's account id, and `owner/name`. */
  repoId: string;
  ownerId: string;
  repo: string;
  commit: string;
  /** Branch the run built. */
  ref: string;
}

/** Who is calling, after authentication and before authorization. */
export interface Actor {
  /** A person (gitmatrix account), a CI job, or nobody. */
  kind: "anonymous" | "user" | "job";
  /** gitmatrix account id for people; the CI job id for jobs. */
  subject: string | null;
  /** Account slug, or `owner/repo` for jobs. */
  name: string | null;
  email: string | null;
  scopes: ReadonlySet<Scope>;
  /** gitmatrix access token id, when the call used one. */
  tokenId: string | null;
  via: "none" | "token" | "job" | "registry" | "session";
  /** Only for `via: "registry"`: exactly what the token grants. */
  access?: AccessGrant[];
  /** Only for jobs (and registry tokens issued to them). */
  job?: JobIdentity;
  /** Site admins see and manage every owner's packages. */
  isSiteAdmin?: boolean;
}

export const ANONYMOUS: Actor = Object.freeze({
  kind: "anonymous",
  subject: null,
  name: null,
  email: null,
  scopes: new Set<Scope>(),
  tokenId: null,
  via: "none",
}) as Actor;

/** `user:<account id>` / `job:<ci job id>`: how publishes and audit name an actor. */
export function principalOf(actor: Actor): string | null {
  if (actor.kind === "anonymous" || !actor.subject) return null;
  return `${actor.kind}:${actor.subject}`;
}

export function actorLabel(actor: Actor): string {
  if (actor.kind === "job" && actor.job) {
    return `${actor.job.repo} · CI #${actor.job.runNumber} ${actor.job.jobName}`;
  }
  return actor.name ?? principalOf(actor) ?? "anonymous";
}

export function scopeSet(scopes: readonly string[]): Set<Scope> {
  return new Set(scopes.filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s)));
}

/** What a gitmatrix token scope allows in the registry. */
export function scopesForTokenScope(scope: "read" | "write"): Set<Scope> {
  return scope === "read" ? new Set<Scope>(["packages:read"]) : new Set<Scope>(ALL_SCOPES);
}
