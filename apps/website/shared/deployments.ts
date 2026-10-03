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
  /**
   * When it is due to be torn down. A timeline preview follows the account's
   * retention (see {@link previewExpiry}) unless `expiryPinned`.
   */
  expiresAt: string | null;
  /** The recorder set `expiresAt`; retention doesn't move it. */
  expiryPinned: boolean;
  /**
   * Rebuilt by reviving its checkpoint's preview (CORE-79), not the original:
   * it can differ if the toolchain or seed changed since.
   */
  revived: boolean;
  /** The earlier record of the same checkpoint it stands in for, when there was one. */
  rebuiltFrom: number | null;
  /** When Gitmatrix expired it, and the run (number) that tore it down. */
  tornDownAt: string | null;
  teardownRun: number | null;
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
   * An ISO time, or null for none; giving it pins it. Default: none, except
   * for timeline previews, which follow the account's retention.
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

const DAY = 24 * 60 * 60 * 1000;

/** What a timeline preview's expiry depends on. */
export interface PreviewClock {
  /** The timeline as the tracker has it now; null when it has no record. */
  timeline: {
    status: string;
    createdAt: string;
    pushedAt: string | null;
    /** For a landed or abandoned timeline: when it ended (its last change). */
    updatedAt: string;
  } | null;
  /** When the preview was recorded. */
  createdAt: string;
  /** A revival: its clock starts no earlier than the revival. */
  revived: boolean;
}

/**
 * When a timeline preview is torn down (TIMELINES-RESEARCH.md, Decisions):
 * `endedDays` after its timeline lands or is abandoned, and `idleDays` after
 * the timeline's last push, whichever comes first. A revived preview counts
 * from its revival too, so reviving last week's checkpoint gives it the same
 * time again. A preview of a timeline with no record counts from its own
 * recording.
 */
export function previewExpiry(
  clock: PreviewClock,
  settings: Pick<PreviewSettings, "endedDays" | "idleDays">,
): string {
  const created = Date.parse(clock.createdAt);
  const { timeline } = clock;
  if (!timeline) return new Date(created + settings.idleDays * DAY).toISOString();
  const pushed =
    timeline.pushedAt && timeline.pushedAt > timeline.createdAt
      ? timeline.pushedAt
      : timeline.createdAt;
  const since = (time: number) => (clock.revived ? Math.max(time, created) : time);
  let expiry = since(Date.parse(pushed)) + settings.idleDays * DAY;
  if (timeline.status === "landed" || timeline.status === "abandoned")
    expiry = Math.min(expiry, since(Date.parse(timeline.updatedAt)) + settings.endedDays * DAY);
  return new Date(expiry).toISOString();
}
