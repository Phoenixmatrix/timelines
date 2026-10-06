// The retention category registry (CORE-196; PRD CORE-195, "Retention
// categories and defaults when enabled"). One entry per kind of data that
// retention can clean up, shared by the policy store and API
// (worker/retention/policies.ts, api.ts), the cleanup engine, the admin UI and
// the usage report.
//
// "policy" categories are disabled until an administrator enables them unless
// defaultEnabled is set; thresholds default to the values here, within bounds,
// per account (account scope) or for the whole site (site scope; site
// administrators also set site-wide defaults for account categories).
//
// Two categories describe cleanup that already ran before policies existed and
// keeps running exactly as before: preview teardown ("active"; its two numbers
// are the account_settings preview columns, also served by
// /settings/previews) and Atlas snapshot retention ("active"; ATLAS_RETENTION,
// which an account can tighten within ATLAS_RETENTION_BOUNDS; CORE-201).
//
// "fixed" categories always run with their defaults and can't be changed:
// auth hygiene (CORE-249).
//
// Adding a category: append an entry (a new kebab-case id; ids are stored, so
// never rename one), then implement its cleanup against the engine contract
// (worker/retention/engine.ts) in the ticket that owns it.

import type { RetentionCategory, RetentionThreshold } from "../../shared/retention.ts";
import { ATLAS_RETENTION, ATLAS_RETENTION_BOUNDS } from "../atlas/retention.ts";
import { DEFAULT_PREVIEW_SETTINGS } from "../../shared/deployments.ts";
import { STEP_FEED_DAYS } from "../../shared/steps.ts";

const TEN_YEARS = 3650;

const days = (key: string, label: string, value: number, min = 1): RetentionThreshold => ({
  key,
  label,
  unit: "days",
  min,
  max: TEN_YEARS,
  default: value,
});

const keepLatest = (label: string, value: number): RetentionThreshold => ({
  key: "keepLatest",
  label,
  unit: "count",
  min: 1,
  max: 1000,
  default: value,
});

export const CATEGORIES = [
  // Account scope.
  {
    id: "ci-logs",
    scope: "account",
    control: "policy",
    label: "CI logs",
    description: "Log text of CI jobs that finished more than the given days ago.",
    never: ["Logs of pending, queued or running jobs", "The run, job and step records themselves"],
    overlaps: ["ci-runs"],
    thresholds: [days("days", "Days after the job finished", 30)],
  },
  {
    id: "ci-runs",
    scope: "account",
    control: "policy",
    label: "CI run history",
    description: "CI runs older than the given days, with their jobs, steps and logs.",
    never: [
      "The latest runs of each ref (the count below)",
      "Running or queued runs, and runs with a job still running",
      "Runs a deployment, a landing or a package publish refers to",
    ],
    overlaps: ["ci-logs", "step-artifacts"],
    thresholds: [days("days", "Days after the run", 180), keepLatest("Runs kept per ref", 20)],
  },
  {
    id: "preview-records",
    scope: "account",
    control: "policy",
    label: "Expired preview deployment records",
    description: "Records of preview deployments that expired more than the given days ago.",
    never: ["Live or sleeping deployments", "Production deployments", "Failed deployments"],
    thresholds: [days("days", "Days after expiry", 30)],
  },
  {
    id: "knowledge-builds",
    scope: "account",
    control: "policy",
    label: "Knowledge build history",
    description: "Knowledge graph build records and their change lists older than the given days.",
    never: ["The current graph, wiki and Atlas snapshot", "The latest builds (the count below)"],
    thresholds: [
      days("days", "Days after the build", 90),
      keepLatest("Builds kept per repository", 20),
    ],
  },
  {
    id: "ended-timeline-data",
    scope: "account",
    control: "policy",
    label: "Ended timeline overlays and page sets",
    description:
      "Knowledge overlays, regroupings and page sets of timelines that ended more than the given days ago.",
    never: ["Data of open timelines", "Anything on the main line"],
    thresholds: [days("days", "Days after the timeline ended", 90)],
  },
  // Work context (CORE-244; PRD CORE-226, "Settings: retention"): a step's why,
  // challenges, tests and coverage are kept as long as the repository; the
  // people's own words, the step-run artifacts and the live feed are not.
  {
    id: "step-steering",
    scope: "account",
    control: "policy",
    label: "Step instructions and steering",
    description:
      "The text of steps' instructions and steering (what people told their agents), the given days after the step's commit, trimmed to a placeholder.",
    never: ["A step's why, challenges, tests or coverage", "The step itself and its commit"],
    thresholds: [days("days", "Days after the step's commit", 365)],
  },
  {
    id: "step-artifacts",
    scope: "account",
    control: "policy",
    label: "Step run artifacts",
    description: "What step runs produced (test summaries), the given days after the run.",
    never: ["The step and its context", "The CI run that produced them"],
    overlaps: ["ci-runs"],
    thresholds: [days("days", "Days after the step run", 90)],
  },
  {
    id: "step-feed",
    scope: "account",
    control: "active",
    label: "Live step feed",
    description:
      "Each timeline's live feed keeps a step's small record for the given days, enough for readers to catch up; the step itself stays. An account can keep less, never more.",
    never: ["Steps and their context"],
    thresholds: [
      {
        key: "days",
        label: "Days a feed record is kept",
        unit: "days",
        min: 1,
        max: STEP_FEED_DAYS,
        default: STEP_FEED_DAYS,
      },
    ],
  },
  {
    id: "timeline-work-sources",
    scope: "account",
    control: "policy",
    defaultEnabled: true,
    label: "Timeline work Git repositories",
    description:
      "Read-only work Git repositories expire independently of Tracker details and published outputs, after landing or abandonment.",
    never: [
      "Canonical Git repositories and historical canonical sources",
      "Open timeline sources",
      "Sources required by live dependencies or unacknowledged consumers",
    ],
    thresholds: [
      days("landedDays", "Days after landing", 30),
      days("abandonedDays", "Days after abandonment", 90),
    ],
  },
  {
    id: "push-log",
    scope: "account",
    control: "policy",
    label: "Push log",
    description:
      "Push log entries older than the given days, and records of changes on branches or bookmarks that no longer exist, last seen before then.",
    never: [
      "Commits, refs or any git history",
      "The latest push log entry of each branch or tag that exists",
      "A change's record on a branch or tag that exists, or the push log entry it points to",
    ],
    thresholds: [days("days", "Days after the push", 365)],
  },
  {
    id: "unreachable-git",
    scope: "account",
    control: "policy",
    label: "Unreachable git data",
    description:
      "Git objects no ref reaches any more (deleted branches, landed or abandoned timeline bookmarks). Artifacts can't prune them yet: they are measured in the usage report, never deleted.",
    never: [
      "Reachable history of any branch, tag or bookmark",
      "Anything, until Artifacts can prune",
    ],
    thresholds: [days("days", "Days after becoming unreachable", 30)],
  },
  {
    id: "closed-issues",
    scope: "account",
    control: "policy",
    label: "Closed and canceled issues",
    description:
      "Issues closed or canceled more than the given days ago, with their comments, links and events.",
    never: ["Open issues", "Issue keys (never reused)"],
    overlaps: ["tracker-activity"],
    thresholds: [days("days", "Days after closing", 365)],
  },
  {
    id: "tracker-activity",
    scope: "account",
    control: "policy",
    label: "Tracker activity logs and ended timelines",
    description: "Tracker activity log entries older than the given days, and ended timelines.",
    never: ["Activity that open issues and timelines still show", "Open timelines"],
    overlaps: ["closed-issues"],
    thresholds: [
      days("eventDays", "Days to keep activity", 365),
      days("endedTimelineDays", "Days after a timeline ended", 180),
    ],
  },
  {
    id: "assistant-chats",
    scope: "account",
    control: "policy",
    label: "Assistant chats",
    description: "Assistant chats nobody has used for the given days.",
    never: [
      "Chats used within the period (unless over the per-person limit)",
      "A chat with a turn in progress",
      "The newest chats up to the per-person limit",
    ],
    thresholds: [
      days("days", "Days without activity", 90),
      {
        key: "maxPerUser",
        label: "Chats kept per person (0 for no limit)",
        unit: "count",
        min: 0,
        max: 10_000,
        default: 0,
      },
    ],
  },
  {
    id: "release-notes",
    scope: "account",
    control: "policy",
    label: "Release notes",
    description: "Release notes older than the given days, with their entries and mentions.",
    never: ["Each repository's latest daily and latest tagged release notes"],
    thresholds: [days("days", "Days after publishing", 730)],
  },
  {
    id: "previews",
    scope: "account",
    control: "active",
    label: "Timeline previews",
    description:
      "Live timeline previews are torn down after their timeline lands or is abandoned, or after a period without pushes. Their records stay (see expired preview deployment records).",
    never: ["Previews with an expiry their recorder pinned", "Production deployments"],
    thresholds: [
      {
        key: "endedDays",
        label: "Days after the timeline ended",
        unit: "days",
        min: 0,
        max: 365,
        default: DEFAULT_PREVIEW_SETTINGS.endedDays,
      },
      {
        key: "idleDays",
        label: "Days without pushes",
        unit: "days",
        min: 1,
        max: 365,
        default: DEFAULT_PREVIEW_SETTINGS.idleDays,
      },
    ],
  },
  {
    id: "atlas-snapshots",
    scope: "account",
    control: "active",
    label: "Atlas snapshots",
    description:
      "Each repository keeps its current Atlas snapshot and recent prior ones; older priors expire and their rows are reclaimed. An account can keep fewer, never more.",
    never: ["The current snapshot"],
    thresholds: [
      {
        key: "maxPrior",
        label: "Prior snapshots kept",
        unit: "count",
        ...ATLAS_RETENTION_BOUNDS.maxPrior,
        default: ATLAS_RETENTION.maxPrior,
      },
      {
        key: "priorDays",
        label: "Days a prior snapshot is kept",
        unit: "days",
        ...ATLAS_RETENTION_BOUNDS.priorDays,
        default: ATLAS_RETENTION.priorTtlMs / 86_400_000,
      },
      {
        key: "capGib",
        label: "Storage per repository",
        unit: "gib",
        ...ATLAS_RETENTION_BOUNDS.capGib,
        default: ATLAS_RETENTION.repoCapBytes / 1024 ** 3,
      },
    ],
  },

  // Site scope.
  {
    id: "analysis-caches",
    scope: "site",
    control: "policy",
    label: "Analysis caches",
    description:
      "Cached file analyses and syntheses no repository's current build has used for the given days.",
    never: ["Entries any current build uses"],
    thresholds: [days("days", "Days unused", 30)],
  },
  {
    id: "registry-proxy-cache",
    scope: "site",
    control: "policy",
    label: "Registry proxy cache and derived objects",
    description:
      "Cached upstream package entries and derived files unused for the given days, so garbage collection can reclaim their blobs.",
    never: [
      "Blobs any version, tag or kept cache entry refers to",
      "Published packages",
      "Derived files in use, or written within the last day",
    ],
    thresholds: [days("days", "Days unused", 30)],
  },
  {
    id: "registry-audit",
    scope: "site",
    control: "policy",
    label: "Registry audit log and publish records",
    description: "Registry audit entries and publish records older than the given days.",
    never: [
      "Package versions and their contents",
      "The newest publish record of each version still published",
      "Records of versions published from another branch (they keep them from becoming latest)",
    ],
    thresholds: [days("days", "Days to keep", 365)],
  },
  {
    id: "auth-hygiene",
    scope: "site",
    // Expired sign-in state is worth nothing to keep, so it isn't left to an
    // administrator to find and enable (CORE-249).
    control: "fixed",
    label: "Auth hygiene",
    description:
      "Expired sign-in sessions, sign-in and device codes, lockouts, SSH challenges and expired tokens, the given days after they ended.",
    never: ["Live sessions, valid tokens and active lockouts"],
    thresholds: [days("days", "Days after expiry", 7)],
  },
  {
    id: "ai-spend",
    scope: "site",
    control: "policy",
    label: "AI spend records",
    description: "Per-call AI spend records older than the given days, rolled up to daily totals.",
    never: ["Totals budgets are enforced against", "Reservations still in flight"],
    // At least a week: a run's own caps read its per-call rows.
    thresholds: [days("days", "Days of per-call detail", 90, 7)],
  },
  // CORE-225: what metering (CORE-207) and the Durable Object registry (CORE-197) keep.
  {
    id: "usage-history",
    scope: "site",
    control: "policy",
    label: "Usage history",
    description:
      "Daily usage figures older than the given days, rolled up to monthly figures; monthly figures older than the given months.",
    never: [
      "The latest figures of each account and construct (the report's current usage)",
      "Totals: a month's roll-up keeps the sum of its days",
    ],
    thresholds: [
      // At least the report's 30-day window (worker/usage/report.ts WINDOW_DAYS) and then some.
      days("days", "Days of daily figures", 90, 32),
      {
        key: "months",
        label: "Months of monthly figures",
        unit: "months",
        min: 1,
        max: 120,
        default: 24,
      },
    ],
  },
  {
    id: "ai-usage",
    scope: "site",
    control: "policy",
    label: "AI usage records",
    description:
      "Daily AI call and token records older than the given days, rolled up to monthly totals per account, feature and model.",
    never: ["Totals: a month's roll-up keeps the sum of its days", "Records of the current period"],
    thresholds: [days("days", "Days of daily records", 90, 7)],
  },
  {
    id: "durable-registry",
    scope: "site",
    control: "policy",
    label: "Durable Object registry rows",
    description: "Rows of Durable Object instances purged more than the given days ago.",
    never: ["Rows of live instances, or of instances used again since their purge"],
    thresholds: [days("days", "Days after the purge", 30)],
  },
] as const satisfies readonly RetentionCategory[];

export type CategoryId = (typeof CATEGORIES)[number]["id"];

const BY_ID = new Map<string, RetentionCategory>(CATEGORIES.map((c) => [c.id, c]));

/** The category with this id, or undefined for an unknown one. */
export function category(id: string): RetentionCategory | undefined {
  return BY_ID.get(id);
}

export function isCategoryId(id: string): id is CategoryId {
  return BY_ID.has(id);
}

/** A category's thresholds at their defaults. */
export function defaultValues(c: RetentionCategory): Record<string, number> {
  return Object.fromEntries(c.thresholds.map((t) => [t.key, t.default]));
}

/** Whether a stored value is acceptable for a threshold now (bounds can tighten). */
/**
 * Overlapping categories among `ids`, as pairs in registry order: a dry run of
 * both counts their shared records under each (see RetentionCategory.overlaps).
 */
export function overlappingPairs(ids: readonly string[]): [RetentionCategory, RetentionCategory][] {
  const chosen = CATEGORIES.filter((c) => ids.includes(c.id)) as readonly RetentionCategory[];
  const pairs: [RetentionCategory, RetentionCategory][] = [];
  chosen.forEach((a, i) => {
    for (const b of chosen.slice(i + 1)) if (a.overlaps?.includes(b.id)) pairs.push([a, b]);
  });
  return pairs;
}

export function validThreshold(t: RetentionThreshold, value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= t.min && value <= t.max;
}
