// Deployments and environments (CORE-78; TIMELINES-RESEARCH.md, "Previews:
// primitives, not hosting"). Gitmatrix deploys nothing: CI jobs and outside
// systems record where a commit was deployed, and Gitmatrix shows it next to
// CI runs, commits, timelines and checkpoints. Records are kept after a
// preview expires.
//
// Provenance (CORE-351; decisions on CORE-348): a record may also say which
// provider version ran (`provider`) and which registry publication was
// deployed (`artifact`). Those are what make runtime evidence explicit
// (shared/observability.ts); a record without them is uninstrumented and its
// evidence is at best temporal. Nothing is inferred to fill them in: a package
// built from the same commit is not proof it was deployed.

import type { ObservabilityProvider } from "./observability.ts";

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

/**
 * The provider version a record ran: immutable ids the provider assigned. No
 * connection or binding is stored; observability reads resolve the binding
 * from (repository, service, environment) when they read, and treat the
 * version as explicit only once the provider lists it under that service.
 */
export interface DeploymentProvider {
  name: ObservabilityProvider;
  /** The provider's service: a Worker script (OTel `service.name`). */
  service: string;
  /** The version that ran (OTel `service.version`). */
  versionId: string;
  /**
   * The provider deployment that put it out: always recorded with the
   * version, so a canary's members share it and a rollback to an earlier
   * version is a record of its own.
   */
  deploymentId: string;
}

/**
 * The registry publication deployed: checked when recorded to be this
 * repository's CI publish from the same source and commit.
 */
export interface DeploymentArtifact {
  publishId: string;
  packageId: string;
  format: string;
  name: string;
  version: string;
  /** `<algorithm>:<hex>` of the primary file or manifest, when the publication has one. */
  digest: string | null;
}

export interface Deployment {
  id: number;
  repoId: string;
  sourceId: string;
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
  /** When Gitmatrix expired it, and the cleanup run number if scheduled; neither proves completion. */
  tornDownAt: string | null;
  teardownRun: number | null;
  /** Null for a record that didn't say (uninstrumented): never guessed. */
  provider: DeploymentProvider | null;
  artifact: DeploymentArtifact | null;
  /**
   * The recorder's claim when it deployed, not a snapshot of provider data:
   * when the provider deployed it, when it started and stopped serving traffic,
   * and a canary's share (0–100; null when unknown or all of it). The
   * provider's live deployment history is authoritative while it has them.
   * Each is null when unknown; none defaults to `createdAt`.
   */
  deployedAt: string | null;
  exposedFrom: string | null;
  exposedUntil: string | null;
  percentage: number | null;
  /**
   * The provider version it replaced (a rollback replaces a newer one), and
   * that version's record when one exists in the same source and environment.
   */
  replaces: { versionId: string; deploymentId: number | null } | null;
  /** When Gitmatrix recorded it (receipt), and last changed it. */
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentList {
  deployments: Deployment[];
  /** Pass back as `before` for older records; null on the last page. */
  next: number | null;
}

/**
 * GET /api/repos/:owner/:name/deployments/live-timelines: the slugs of the
 * timelines with an active or sleeping deployment in any of the repository's
 * sources, and nothing else (CORE-372).
 */
export interface LiveTimelineList {
  timelines: string[];
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
  /** A work source id; a job always records its own. Default: canonical. */
  source?: string;
  /**
   * What the provider deployed: the version and the deployment that put it
   * out. A job names it for its own commit, or re-asserts a version already
   * recorded for another commit in this source and environment (a canary's
   * older member, a rollback). Retrying the same provider deployment answers
   * its first record, unchanged, unless the commit, environment, artifact,
   * percentage or replaces differ (409); times and address are not compared.
   */
  provider?: {
    name: ObservabilityProvider;
    service: string;
    versionId: string;
    deploymentId: string;
  };
  /**
   * The registry publication deployed, by id or by package and version; it
   * must be this repository's CI publish from the same source and commit, and
   * `digest`, when given, must equal its digest (a publication that records
   * none, as npm's, refuses one). A job naming it records only its own commit.
   */
  artifact?: { publishId?: string; packageId?: string; version?: string; digest?: string };
  /** UTC ISO times (`…Z`). Exposure starts no earlier than the deployment and ends no earlier than it starts. */
  deployedAt?: string;
  exposedFrom?: string;
  exposedUntil?: string;
  /** A canary's traffic share, 0–100; needs `provider`. */
  percentage?: number;
  /** The provider version this replaced; needs `provider`. */
  replaces?: string;
}

/** PATCH /api/repos/:owner/:name/deployments/:id. */
export interface UpdateDeployment {
  status?: DeploymentStatus;
  url?: string | null;
  expiresAt?: string | null;
  /**
   * When it started serving: set once while unknown, no earlier than the
   * deployment and not in the future (it may precede the record).
   */
  exposedFrom?: string;
  /** When it stopped serving: set once (a UTC ISO time), never moved. */
  exposedUntil?: string;
  /** A canary's share, only while none is recorded. Provider and artifact never change. */
  percentage?: number;
}

export interface Environment {
  name: string;
  timeline: string | null;
  /** Its newest deployment; null for a `production` that was never deployed. */
  latest: Deployment | null;
  /**
   * Every live record of the newest one's provider deployment, newest first,
   * when that deployment split traffic between versions (a canary); else empty.
   */
  split: Deployment[];
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
    /** Its last change: when it ended, for a record older than `endedAt`. */
    updatedAt: string;
    /** For a landed or abandoned timeline: when it ended (CORE-77). */
    endedAt?: string | null;
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
  // When it ended; older records, which don't say, ended at their last change.
  if (timeline.status === "landed" || timeline.status === "abandoned") {
    const ended = Date.parse(timeline.endedAt ?? timeline.updatedAt);
    expiry = Math.min(expiry, since(ended) + settings.endedDays * DAY);
  }
  return new Date(expiry).toISOString();
}
