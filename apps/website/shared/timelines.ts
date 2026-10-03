// Timelines (TIMELINES-RESEARCH.md, "A timeline, concretely"): an
// account-wide line of work with a bookmark `timeline/<slug>` in each
// repository it touches. The records and their events live in the account's
// tracker, next to the issues and leases later steps change with them.

export type TimelinePolicy = "auto" | "approval";
export const TIMELINE_POLICIES: readonly TimelinePolicy[] = ["auto", "approval"];

/**
 * - `active`: work goes on;
 * - `idle`: no pushes for the org's idle period;
 * - `waiting`: a checkpoint awaits approval;
 * - `landing`: queued to land;
 * - `partly_landed`: some repositories advanced, the rest retrying;
 * - `landed`, `abandoned`: ended, kept forever.
 */
export type TimelineStatus =
  | "active"
  | "idle"
  | "waiting"
  | "landing"
  | "partly_landed"
  | "landed"
  | "abandoned";

/** A repository a timeline touches. Owner and name are as of creation; the id is the authority. */
export interface TimelineRepo {
  id: string;
  owner: string;
  name: string;
  /** The branch holding the timeline's work: `timeline/<slug>`. */
  bookmark: string;
}

export interface Timeline {
  id: string;
  /** Unique in the account and never changed: the bookmark is named after it. */
  slug: string;
  name: string;
  policy: TimelinePolicy;
  /** A UX marker for a timeline not expected to land; not a restriction. */
  experimental: boolean;
  /** The timeline it forked from; null for main. */
  parentId: string | null;
  /** Where it forked: the commit per repository id, and the tracker's event cursor. */
  forkPoint: { commits: Record<string, string>; trackerCursor: number };
  repos: TimelineRepo[];
  status: TimelineStatus;
  /** The person answerable for it: its starter, or the starter's accountable human. */
  accountableId: string;
  /** Who started it: an agent's id, or the person's. */
  startedBy: string;
  /** Agents that started it or pushed to its bookmarks. */
  agentIds: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  /** The last push to one of its bookmarks. */
  pushedAt: string | null;
}

export type TimelineEventKind =
  | "fork"
  | "merge"
  | "checkpoint"
  | "approval"
  | "landing"
  | "abandon";

interface TimelineEventBase {
  id: string;
  /** Order across every timeline's events. */
  seq: number;
  /** The timeline whose history it belongs to; a merge between two is listed by both. */
  timelineId: string;
  /** Who did it: an agent's id, or the person's; null when nobody is known. */
  actorId: string | null;
  /** The human answerable for the actor. */
  accountableId: string | null;
  createdAt: string;
}

export type TimelineEvent = TimelineEventBase &
  (
    | {
        kind: "fork";
        /** The timeline forked from; null for main. */
        parentId: string | null;
        commits: Record<string, string>;
        trackerCursor: number;
      }
    | {
        kind: "merge";
        /** Each side is a timeline id, or null for main. */
        fromId: string | null;
        intoId: string | null;
        repoId: string;
        /** The merge commit, and its parent that brought the other side's work. */
        commit: string;
        parent: string;
        /** The push log entry that moved the bookmark (or main) to it. */
        refUpdateId: number | null;
      }
    | {
        kind: "abandon";
        /** Each bookmark's last commit when it was deleted (null if it was already gone). */
        lastCommits: Record<string, string | null>;
      }
    // Recorded by later steps: checkpoints and approvals (CORE-76), landing (CORE-77).
    | { kind: "checkpoint" | "approval" | "landing" }
  );

export interface TimelineList {
  timelines: Timeline[];
}

/** A timeline and its events, oldest first; `after` pages on through `next`. */
export interface TimelineDetail {
  timeline: Timeline;
  events: TimelineEvent[];
  next: number | null;
}

/** What happened to each bookmark when a timeline was created or abandoned. */
export interface BookmarkResult {
  repoId: string;
  ref: string;
  ok: boolean;
  reason?: string;
}

export interface TimelineChange {
  timeline: Timeline;
  bookmarks: BookmarkResult[];
}

export interface CreateTimeline {
  slug: string;
  name?: string;
  policy?: TimelinePolicy;
  experimental?: boolean;
  /** `main` (the default) or another timeline's slug. */
  parent?: string;
  /**
   * `owner/name`, or `{ repo, commit }` to fork at a commit other than the
   * parent's tip. Defaults to the parent timeline's repositories.
   */
  repos?: (string | { repo: string; commit?: string })[];
}

export interface UpdateTimeline {
  name?: string;
  experimental?: boolean;
}

/** The branch a timeline's work lives on. */
export function timelineBookmark(slug: string): string {
  return `timeline/${slug}`;
}

/** The slug a branch belongs to, if it is a timeline bookmark. */
export function timelineSlugOf(ref: string): string | null {
  const match = /^refs\/heads\/timeline\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(ref);
  return match ? match[1]! : null;
}
