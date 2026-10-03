// Timelines (TIMELINES-RESEARCH.md, "A timeline, concretely"): an
// account-wide line of work with a bookmark `timeline/<slug>` in each
// repository it touches. The records and their events live in the account's
// tracker, next to the issues and leases later steps change with them.

import type { DoneIn, Issue } from "./tracker.ts";

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
    | {
        kind: "checkpoint";
        checkpointId: string;
        /** 1, 2, 3… within the timeline. */
        number: number;
        /** The commit per repository id it pins. */
        commits: Record<string, string>;
        summary: string;
      }
    | {
        kind: "approval";
        checkpointId: string;
        number: number;
        /** The approval request it closed. */
        requestId: string;
        /**
         * A person approved or rejected it; or new commits (or a newer
         * checkpoint) superseded it while the request was open, which
         * withdrew the request.
         */
        outcome: ApprovalOutcome;
        /** What the person added to their answer, or why it was superseded. */
        note: string | null;
      }
    // Recorded by a later step: landing (CORE-77).
    | { kind: "landing" }
  );

/**
 * One repository in a checkpoint: the timeline's commit there and the main
 * commit landing would merge it onto, both as of the checkpoint.
 */
export interface CheckpointRepo {
  id: string;
  owner: string;
  name: string;
  /** The tip of the timeline's bookmark. */
  commit: string;
  /** Main's tip: what a landing would merge onto. Null when the repository has no main yet. */
  base: string | null;
  /**
   * gm change ids the bookmark has reached (CORE-68's push log), newest first,
   * each with the commit it last had; capped at CHECKPOINT_CHANGES.
   */
  changes: { changeId: string; commit: string }[];
}

/** Change ids kept per repository in a checkpoint. */
export const CHECKPOINT_CHANGES = 200;

/**
 * An immutable record of a timeline at one point (TIMELINES-RESEARCH.md,
 * "A timeline, concretely"). Its CI runs, previews and approval are found by
 * its commits and its id, and read live: they change after it's made.
 */
export interface Checkpoint {
  id: string;
  timelineId: string;
  /** 1, 2, 3… within the timeline. */
  number: number;
  repos: CheckpointRepo[];
  /** Markdown, written by the agent (or person) that made it: what it holds and why. */
  summary: string;
  actorId: string;
  accountableId: string;
  createdAt: string;
}

export type ApprovalOutcome = "approved" | "rejected" | "superseded";

/** Where a checkpoint's approval stands: its newest approval request, or how it closed. */
export interface CheckpointApproval {
  requestId: string;
  state: "pending" | ApprovalOutcome;
  /** Who answered (or pushed past it), and when; null while pending. */
  by: string | null;
  at: string | null;
  note: string | null;
}

/** What tracks a checkpoint: whether it's still its timeline's head, and its approval. */
export interface CheckpointState {
  checkpoint: Checkpoint;
  /**
   * Still its timeline's head: the newest checkpoint, with no commits pushed
   * since. Only a current checkpoint can be approved, and an approval counts
   * only while it is.
   */
  current: boolean;
  approval: CheckpointApproval | null;
  /** Approved, and still current: what landing may merge. */
  approved: boolean;
}

/** A CI run of one of a checkpoint's commits. */
export interface CheckpointRun {
  repoId: string;
  number: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  commit: string;
  createdAt: string;
}

/** A preview of a checkpoint (by its id) or of one of its commits in the timeline's environment. */
export interface CheckpointPreview {
  repoId: string;
  id: number;
  environment: string;
  url: string | null;
  status: "active" | "sleeping" | "expired" | "failed";
  commit: string;
}

/** A checkpoint with what's known about it now: CI, previews, approval. */
export interface CheckpointView extends CheckpointState {
  timeline: { id: string; slug: string; name: string; policy: TimelinePolicy };
  runs: CheckpointRun[];
  previews: CheckpointPreview[];
}

export interface CheckpointList {
  checkpoints: CheckpointView[];
}

/** POST /api/tracker/:owner/timelines/:slug/checkpoints. */
export interface CreateCheckpoint {
  summary?: string;
}

export interface TimelineList {
  timelines: Timeline[];
}

/**
 * An issue a timeline worked on or has done (CORE-74), with main's status:
 * `done_in_timeline` with `doneIn` while it waits for the timeline to land.
 * An issue only timelines have shows its newest status in them.
 */
export type TimelineIssue = Pick<Issue, "id" | "key" | "title" | "status"> & {
  doneIn: DoneIn | null;
};

/** A timeline and its events, oldest first; `after` pages on through `next`. */
export interface TimelineDetail {
  timeline: Timeline;
  events: TimelineEvent[];
  next: number | null;
  /** Its issues, by key. */
  issues?: TimelineIssue[];
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
