// Deployments and environments (CORE-78; TIMELINES-RESEARCH.md, "Previews:
// primitives, not hosting"). Gitmatrix deploys nothing: CI jobs and outside
// systems record where a commit was deployed, and Gitmatrix shows it next to
// CI runs, commits, timelines and checkpoints. Records are kept after a
// preview expires.

export type DeploymentStatus = "active" | "sleeping" | "expired" | "failed";
export const DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  "active",
  "sleeping",
  "expired",
  "failed",
];

/** The environment every repository has. */
export const PRODUCTION = "production";

/** A timeline's environment: `timeline/<slug>`. */
export function timelineEnvironment(slug: string): string {
  return `timeline/${slug}`;
}

/** The timeline an environment belongs to, if it is a timeline's. */
export function timelineOfEnvironment(environment: string): string | null {
  const match = /^timeline\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(environment);
  return match ? match[1]! : null;
}

/** The longest `branch/<name>` environment. */
export const MAX_BRANCH_ENVIRONMENT = 200;

/**
 * A branch's environment, for a branch that is neither the default branch nor
 * a timeline's (CORE-138): `branch/<name>`, lowercased, with each run of
 * characters other than letters, digits, '.', '_' and '-' as one '-', and each
 * '/'-separated part starting with a letter or digit and ending with one
 * (`Feature/Add login` is `branch/feature/add-login`). Null when nothing
 * usable is left or the name is longer than {@link MAX_BRANCH_ENVIRONMENT}.
 */
export function branchEnvironment(branch: string): string | null {
  const parts = branch
    .toLowerCase()
    .split("/")
    .map((part) =>
      part
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^[^a-z0-9]+/, "")
        .replace(/[^a-z0-9]+$/, ""),
    )
    .filter(Boolean);
  if (!parts.length) return null;
  const environment = `branch/${parts.join("/")}`;
  return environment.length > MAX_BRANCH_ENVIRONMENT ? null : environment;
}

export interface Deployment {
  id: number;
  environment: string;
  /** The timeline's slug, as recorded; null outside timelines. */
  timeline: string | null;
  /** The timeline's id when it existed at the time. */
  timelineId: string | null;
  /** The checkpoint it previews, as the recorder named it. */
  checkpoint: string | null;
  commit: string;
  /** Null only for a deployment that failed before it had an address. */
  url: string | null;
  status: DeploymentStatus;
  /** The CI run (by number) and job that recorded it, when one did. */
  run: number | null;
  job: string | null;
  /** The person accountable for it, and the agent that acted for them. */
  actor: string | null;
  agent: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentList {
  deployments: Deployment[];
  /** Pass back as `before` for older records; null on the last page. */
  next: number | null;
}

/** POST /api/repos/:owner/:name/deployments. */
export interface RecordDeployment {
  /** Default: the job's commit inside CI; required otherwise. */
  commit?: string;
  url?: string | null;
  /**
   * Default: `timeline/<slug>` for a timeline; inside CI, the job's branch
   * (`production` for the default branch, its timeline for a timeline
   * bookmark, `branch/<name>` for any other: see {@link branchEnvironment});
   * otherwise `production`.
   */
  environment?: string;
  /** A timeline slug; implied by a `timeline/<slug>` environment or branch. */
  timeline?: string | null;
  checkpoint?: string | null;
  /** Default: active. */
  status?: DeploymentStatus;
  /**
   * An ISO time, or null for none. Default: none, except for timeline
   * previews, which expire after the account's idle period.
   */
  expiresAt?: string | null;
}

/** PATCH /api/repos/:owner/:name/deployments/:id. */
export interface UpdateDeployment {
  status?: DeploymentStatus;
  url?: string | null;
  expiresAt?: string | null;
}

export interface Environment {
  name: string;
  timeline: string | null;
  /** Its newest deployment; null for a `production` that was never deployed. */
  latest: Deployment | null;
  /** Deployments still up (active or sleeping), and every one recorded. */
  live: number;
  total: number;
}

export interface EnvironmentList {
  environments: Environment[];
}

/** An account's preview retention (enforced by CORE-79). */
export interface PreviewSettings {
  /** Days after a timeline lands or is abandoned until its previews are torn down. */
  endedDays: number;
  /** Days without pushes until a timeline's previews are torn down. */
  idleDays: number;
  /** Null while the account uses the defaults. */
  updatedAt: string | null;
  updatedBy: string | null;
}

export const DEFAULT_PREVIEW_SETTINGS = { endedDays: 2, idleDays: 7 } as const;
