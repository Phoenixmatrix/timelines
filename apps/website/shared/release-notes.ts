import type { CommitSummary } from "./api.ts";
import type { SourceSnapshot } from "./code-source.ts";
import type { IssueStatus, IssueType } from "./tracker.ts";

/** A tracker issue as release notes see it: what shipped, when, and the proof. */
export interface ShippedIssue {
  id: string;
  key: string;
  title: string;
  description: string;
  type: IssueType;
  status: IssueStatus;
  labels: string[];
  workspaceIds: string[];
  team: { id: string; key: string; name: string };
  /** When the issue last became done; null while it isn't. */
  completedAt: string | null;
  evidence: { body: string; actorId: string; createdAt: string }[];
}

/** A shipped issue resolved through one of the trackers subscribed to a repository. */
export interface LinkedIssue extends ShippedIssue {
  /** The tracker account the issue belongs to. */
  trackerOwner: string;
  trackerOwnerId: string;
}

export interface RangeCommit extends CommitSummary {
  source?: SourceSnapshot;
  /** Issue keys the message mentions, in order; resolved ones appear in `issues`. */
  issueKeys: string[];
  /** The merge on the first-parent line that landed this commit; null on the line itself. */
  landing: string | null;
}

/**
 * The timeline a piece of work landed with: a merge into the default branch,
 * whose other parent was the timeline's checkpoint.
 */
export interface LandedTimeline {
  kind?: "compact" | "merge";
  source?: SourceSnapshot;
  /** The timeline record a `timeline/<slug>` branch names; null for other branches or none. */
  id: string | null;
  /** The branch it merged, like `timeline/search`, when git or the push log name it. */
  branch: string | null;
  /** The landing merge commit. */
  landing: string;
}

export interface ReleaseRangeResponse {
  /** The newest commit of the range: a tag, or the default branch for unreleased work. */
  to: { ref: string; oid: string } | null;
  /** The tag the range starts after (exclusive); null when history has none. */
  from: { tag: string; oid: string } | null;
  /** First-parent commits, newest first, each merge followed by the commits it landed. */
  commits: RangeCommit[];
  /** What each merge in the range landed, as far as it is known. */
  timelines: LandedTimeline[];
  /** The walk stopped at its limit before reaching `from` or the root. */
  truncated: boolean;
  /** Issues the commits mention, from trackers subscribed to this repository that the caller can read. */
  issues: LinkedIssue[];
}

/** The slug of the timeline an entry landed with, when its branch is a timeline bookmark. */
export function landedTimelineSlug(timeline: LandedTimeline | null): string | null {
  const match = /^timeline\/(.+)$/.exec(timeline?.branch ?? "");
  return match ? match[1]! : null;
}

/** How an entry names its timeline: the branch, else the landing merge. */
export function timelineLabel(timeline: LandedTimeline): string {
  return (
    timeline.branch ??
    `${timeline.kind === "compact" ? "landing" : "merge"} ${timeline.landing.slice(0, 7)}`
  );
}

/** Colons cannot occur in Git tag names, so daily update IDs cannot collide with tags. */
export const DAILY_RELEASE_PREFIX = "@day:";
export type ReleaseKind = "daily" | "tag";

export function releaseKind(name: string): ReleaseKind {
  return name.startsWith(DAILY_RELEASE_PREFIX) ? "daily" : "tag";
}

/** Human-facing selectors use `day:YYYY-MM-DD`; tag names remain literal. */
export function releaseName(value: string): string {
  return /^day:\d{4}-\d{2}-\d{2}$/.test(value) ? `@${value}` : value;
}

export function releaseLabel(name: string): string {
  return releaseKind(name) === "daily" ? name.slice(DAILY_RELEASE_PREFIX.length) : name;
}

export type ReleaseCategory = "feature" | "fix" | "improvement" | "internal";

/** A semantic code change an entry was written from. */
export interface ReleaseNoteChange {
  kind: string;
  name: string;
  path: string;
  summary: string;
}

/**
 * A code update: a tracker issue with its commits, a commit citing none, or a
 * landing's commits that cite none.
 */
export interface ReleaseNoteEntry {
  provenance?: { source: SourceSnapshot; commits: string[]; receiptId: string }[];
  id: string;
  release: string;
  releaseKind: ReleaseKind;
  kind: "issue" | "commit" | "landing";
  category: ReleaseCategory;
  title: string;
  summary: string;
  issue: {
    trackerOwner: string;
    id: string;
    key: string;
    type: string;
    team: { id: string; key: string };
  } | null;
  labels: string[];
  workspaceIds: string[];
  commits: string[];
  /** The timeline the work landed with; null when it was committed to the default branch. */
  timeline: LandedTimeline | null;
  changes: ReleaseNoteChange[];
  /** Latest Git committer timestamp among this entry's commits; not a deployment time. */
  lastCommitAt: string;
  model: string | null;
  updatedAt: string;
}

export type ReleaseNotesState = "disabled" | "idle" | "generating" | "ready" | "failed";

export type ReleaseHighlightsScope = "tracker";
export type ReleaseHighlightsState = "disabled" | "idle" | "generating" | "ready" | "failed";

/** An authorized backlink to the exact detailed daily note, never a model-written URL. */
export interface ReleaseHighlightsLink {
  repo: { owner: string; name: string };
  release: string;
}

/** GET highlights for a tracker organization. */
export interface ReleaseHighlights {
  scope: ReleaseHighlightsScope;
  owner: { slug: string; displayName: string };
  status: { state: ReleaseHighlightsState; generatedAt: string | null };
  body: string | null;
  model: string | null;
  notes: ReleaseHighlightsLink[];
  updatedAt: string | null;
}

export interface ReleaseSummary {
  /** A Git tag name, or `@day:YYYY-MM-DD` for a UTC commit-date digest. */
  name: string;
  kind: ReleaseKind;
  toOid: string;
  fromTag: string | null;
  /** Latest Git committer timestamp in this group; not a publication or deployment time. */
  lastCommitAt: string;
  updatedAt: string;
  /** Entries the viewer can see, internal ones included. */
  entries: number;
}

/** GET /api/repos/:owner/:name/release-notes */
export interface ReleaseNotesIndex {
  status: { state: ReleaseNotesState; generatedAt: string | null };
  /** Daily updates first, then named tags; each group newest first. */
  releases: ReleaseSummary[];
}

/** GET /api/repos/:owner/:name/release-notes/release?name= */
export interface ReleaseNotesRelease {
  release: ReleaseSummary & {
    fromOid: string | null;
    truncated: boolean;
    /** Null when the viewer can't read every tracker whose issues shaped it. */
    intro: string | null;
    introModel: string | null;
  };
  entries: ReleaseNoteEntry[];
}

/** An entry in a tracker's code-update feed, with its repository and grouping. */
export interface ReleaseFeedEntry extends ReleaseNoteEntry {
  /** The repository whose commits `commits` (and the landing) are. */
  repo: { owner: string; name: string };
  /** Repository and release-note groups containing this entry. */
  repos: { owner: string; name: string; releases: string[] }[];
}

export interface ReleaseFeedFacet {
  value: string;
  label: string;
  count: number;
}

/** GET /api/tracker/:owner/release-notes?q= */
export interface ReleaseFeed {
  owner: { slug: string; displayName: string };
  query: ParsedReleaseQuery;
  /** Latest commit first. Daily updates by default; explicit kind/release filters can select tags. */
  entries: ReleaseFeedEntry[];
  /** More entries matched than were returned. */
  truncated: boolean;
  facets: {
    teams: ReleaseFeedFacet[];
    repos: ReleaseFeedFacet[];
    workspaces: ReleaseFeedFacet[];
    categories: ReleaseFeedFacet[];
    /** The entries' issue tags (absent from servers before CORE-271: read `labels`). */
    tags?: ReleaseFeedFacet[];
    /** The same as `tags`, under its old name (CORE-271): kept for older clients. */
    labels: ReleaseFeedFacet[];
    releases: ReleaseFeedFacet[];
    /** Timelines the entries landed with, by slug. */
    timelines?: ReleaseFeedFacet[];
  };
}

export const RELEASE_QUERY_KEYS = [
  "team",
  "repo",
  "ws",
  "type",
  "tag",
  "release",
  "kind",
  "timeline",
  "since",
  "until",
] as const;
export type ReleaseQueryKey = (typeof RELEASE_QUERY_KEYS)[number];
const RELEASE_QUERY_ALIASES: Record<string, ReleaseQueryKey> = {
  workspace: "ws",
  category: "type",
  // `label:` is the old name of `tag:` (CORE-271).
  label: "tag",
  labels: "tag",
  tags: "tag",
};

export interface ParsedReleaseQuery {
  filters: { key: ReleaseQueryKey; value: string; negated: boolean }[];
  words: { text: string; negated: boolean }[];
  unknown: string[];
}

/**
 * The release feed's query language, like the tracker's: `team:core repo:engine
 * ws:platform type:fix tag:web release:v1.2 since:2026-09-01 until:30d search
 * words`, any filter negated with a leading `-`, values quoted when they contain
 * spaces. `tag:` is an issue tag (`label:` still works). `release:day:2026-10-02`
 * selects a UTC day; `kind:tag` selects tagged releases. Before CORE-271 `tag:`
 * meant `release:`; `tag:day:…` still does, and so does a `tag:` naming a
 * release the feed has (buildFeed);
 * `timeline:search` what landed with the timeline whose bookmark is `timeline/search`.
 */
export function parseReleaseQuery(query: string): ParsedReleaseQuery {
  const parsed: ParsedReleaseQuery = { filters: [], words: [], unknown: [] };
  for (const match of query.matchAll(/(-?[A-Za-z]+:)?"([^"]*)"|\S+/g)) {
    const token = match[2] !== undefined ? `${match[1] ?? ""}${match[2]}` : match[0];
    const filter = /^(-?)([A-Za-z]+):(.*)$/.exec(token);
    if (!filter) {
      const negated = token.length > 1 && token.startsWith("-");
      parsed.words.push({ text: (negated ? token.slice(1) : token).toLowerCase(), negated });
      continue;
    }
    const name = filter[2]!.toLowerCase();
    const key = (RELEASE_QUERY_KEYS as readonly string[]).includes(name)
      ? (name as ReleaseQueryKey)
      : RELEASE_QUERY_ALIASES[name];
    if (!key || !filter[3]) {
      parsed.unknown.push(token);
      continue;
    }
    let value = filter[3].toLowerCase();
    let resolved = key;
    // The old spelling of a daily release: `tag:day:2026-09-21`.
    if (key === "tag" && name === "tag" && /^@?day:/.test(value)) resolved = "release";
    if (resolved === "release") value = releaseName(value);
    parsed.filters.push({ key: resolved, value, negated: filter[1] === "-" });
  }
  return parsed;
}

const DURATION = /^(\d+)(h|d|w)$/;
const UNIT_MS = { h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;

/** `since:`/`until:` values: a date (`2026-09-01`) or an age (`30d`, `2w`, `12h`). */
export function parseReleaseWhen(value: string, now: number): string | null {
  const age = DURATION.exec(value);
  if (age)
    return new Date(now - Number(age[1]) * UNIT_MS[age[2] as keyof typeof UNIT_MS]).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at).toISOString();
}
