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
