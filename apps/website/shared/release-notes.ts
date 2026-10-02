import type { CommitSummary } from "./api.ts";
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
  /** Issue keys the message mentions, in order; resolved ones appear in `issues`. */
  issueKeys: string[];
}

export interface ReleaseRangeResponse {
  /** The newest commit of the range: a tag, or the default branch for unreleased work. */
  to: { ref: string; oid: string } | null;
  /** The tag the range starts after (exclusive); null when history has none. */
  from: { tag: string; oid: string } | null;
  /** First-parent commits, newest first. */
  commits: RangeCommit[];
  /** The walk stopped at its limit before reaching `from` or the root. */
  truncated: boolean;
  /** Issues the commits mention, from trackers subscribed to this repository that the caller can read. */
  issues: LinkedIssue[];
}

/** The release name for the default branch's work since the newest tag. */
export const UNRELEASED = "@unreleased";

export type ReleaseCategory = "feature" | "fix" | "improvement" | "internal";

/** A semantic code change an entry was written from. */
export interface ReleaseNoteChange {
  kind: string;
  name: string;
  path: string;
  summary: string;
}

/** One shipped change: a tracker issue with its commits, or a commit citing none. */
export interface ReleaseNoteEntry {
  id: string;
  release: string;
  kind: "issue" | "commit";
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
  changes: ReleaseNoteChange[];
  shippedAt: string;
  model: string | null;
  updatedAt: string;
}

export type ReleaseNotesState = "disabled" | "idle" | "generating" | "ready" | "failed";

export interface ReleaseSummary {
  /** A tag, or UNRELEASED. */
  name: string;
  toOid: string;
  fromTag: string | null;
  releasedAt: string;
  updatedAt: string;
  /** Entries the viewer can see, internal ones included. */
  entries: number;
}

/** GET /api/repos/:owner/:name/release-notes */
export interface ReleaseNotesIndex {
  status: { state: ReleaseNotesState; generatedAt: string | null };
  /** Unreleased first, then tags newest first. */
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

/** An entry in a tracker's release feed, with the repository and release it shipped in. */
export interface ReleaseFeedEntry extends ReleaseNoteEntry {
  /** Each repository it shipped in, with its releases there (newest first). */
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
  /** Shipped newest first; an issue appears once per release it shipped in. */
  entries: ReleaseFeedEntry[];
  /** More entries matched than were returned. */
  truncated: boolean;
  facets: {
    teams: ReleaseFeedFacet[];
    repos: ReleaseFeedFacet[];
    workspaces: ReleaseFeedFacet[];
    categories: ReleaseFeedFacet[];
    labels: ReleaseFeedFacet[];
    releases: ReleaseFeedFacet[];
  };
}

export const RELEASE_QUERY_KEYS = [
  "team",
  "repo",
  "ws",
  "type",
  "label",
  "release",
  "since",
  "until",
] as const;
export type ReleaseQueryKey = (typeof RELEASE_QUERY_KEYS)[number];
const RELEASE_QUERY_ALIASES: Record<string, ReleaseQueryKey> = {
  workspace: "ws",
  category: "type",
  tag: "release",
};

export interface ParsedReleaseQuery {
  filters: { key: ReleaseQueryKey; value: string; negated: boolean }[];
  words: { text: string; negated: boolean }[];
  unknown: string[];
}

/**
 * The release feed's query language, like the tracker's: `team:core repo:engine
 * ws:platform type:fix label:web release:v1.2 since:2026-09-01 until:30d search
 * words`, any filter negated with a leading `-`, values quoted when they contain
 * spaces. `release:unreleased` names unreleased work.
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
    if (key === "release" && value === "unreleased") value = UNRELEASED;
    parsed.filters.push({ key, value, negated: filter[1] === "-" });
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
