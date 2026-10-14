// Timelines: a Space-wide line of work with an owned source in each repository it touches.
// The records and their events live in the Space's tracker, next to the issues
// and leases later steps change with them.

import type { KnowledgePageSet } from "./api.ts";
import type { CodeSource, SourceSnapshot, SourceDependency } from "./code-source.ts";
import type { DoneIn, Issue } from "./tracker.ts";
import type { WorkAuthority } from "./ci.ts";

export type TimelinePolicy = "auto" | "approval";
export const TIMELINE_POLICIES: readonly TimelinePolicy[] = ["auto", "approval"];

/**
 * - `active`: work goes on;
 * - `idle`: no pushes for the org's idle period;
 * - `waiting`: a checkpoint awaits approval;
 * - `landing`: queued to land;
 * - `partly_landed`: some repositories advanced, the rest retrying;
 * - `landed`, `abandoned`: ended, retained under the ended-timeline policy.
 */
export type TimelineStatus =
  | "active"
  | "idle"
  | "waiting"
  | "landing"
  | "partly_landed"
  | "landed"
  | "abandoned";

/** Stable repository identity. Stored labels are historical; live API views resolve names by ID. */
export interface TimelineRepo {
  id: string;
  space: string;
  name: string;
  /** The branch holding the timeline's work: `timeline/<slug>`. */
  bookmark: string;
  /** Absent only on legacy records, which cannot accept active work. */
  source?: CodeSource;
  logicalBase?: SourceSnapshot;
  dependencies?: SourceDependency[];
}

export interface Timeline {
  id: string;
  /** Unique in the Space and never changed: the bookmark is named after it. */
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
  /** When it landed or was abandoned; absent on older records and open timelines. */
  endedAt?: string | null;
  migrationState?: "frozen" | "ready";
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
        /** Each source's last commit when archived (null if already unavailable). */
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
        /** Approved by the person's approve-when-green setting, not by hand (CORE-378). */
        via?: "auto-approve";
      }
    | {
        kind: "landing";
        /** The landing (CORE-77) and the checkpoint it lands. */
        landingId: string;
        checkpointId: string;
        number: number;
        /**
         * - `queued`: it entered the landing queue;
         * - `conflict`: a merge with main conflicts: it needs a sync;
         * - `failed`: the gates failed on the merge, or something else stopped it;
         * - `partly_landed`: some repositories' mains advanced, the rest retry;
         * - `landed`: every repository's main advanced to its merge.
         */
        outcome: LandingOutcome;
        /** The merge commit per repository id that main advanced to, so far. */
        merges: Record<string, string>;
        note: string | null;
      }
  );

export type LandingOutcome =
  | "queued"
  | "conflict"
  | "failed"
  | "blocked_dependency"
  | "partly_landed"
  | "landed";

/**
 * One repository in a checkpoint: the timeline's commit there and the main
 * commit landing would merge it onto, both as of the checkpoint.
 */
export interface CheckpointRepo {
  id: string;
  space: string;
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
  source?: SourceSnapshot;
  logicalBase?: SourceSnapshot;
  dependencies?: SourceDependency[];
}

/** Change ids kept per repository in a checkpoint. */
export const CHECKPOINT_CHANGES = 200;

/**
 * An immutable record of a timeline at one point. Its CI runs, previews and approval are found by
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
  /** Answered by `by`'s approve-when-green setting once CI was green (CORE-378). */
  via?: "auto-approve";
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
  /** A preview run's action (CORE-79); null for a push or manual run. */
  preview: "create" | "teardown" | null;
}

/** A preview of a checkpoint (by its id) or of one of its commits in the timeline's environment. */
export interface CheckpointPreview {
  repoId: string;
  id: number;
  environment: string;
  url: string | null;
  status: "active" | "sleeping" | "expired" | "failed";
  commit: string;
  /** Rebuilt by a revival, not the original: it can differ if the toolchain or seed changed. */
  revived: boolean;
  rebuiltFrom: number | null;
  expiresAt: string | null;
  /** When Gitmatrix expired it and asked for a teardown. */
  tornDownAt: string | null;
  createdAt: string;
}

/** A checkpoint with what's known about it now: CI, previews, approval. */
export interface CheckpointView extends CheckpointState {
  timeline: Pick<Timeline, "id" | "slug" | "name" | "policy" | "status">;
  runs: CheckpointRun[];
  previews: CheckpointPreview[];
  /**
   * The timeline's wiki pages written for this checkpoint, per repository
   * (CORE-84); none for a repository whose pages were never asked for.
   */
  knowledge: (KnowledgePageSet & { repoId: string })[];
}

export interface CheckpointList {
  checkpoints: CheckpointView[];
}

/**
 * POST /api/tracker/:space/timelines/:slug/checkpoints/:ref/revive: the
 * checkpoint, and per repository the preview run started (its number) or
 * why none was (its ci.yml doesn't opt in, say).
 */
export interface PreviewRevival {
  checkpoint: CheckpointView;
  runs: ({ repoId: string; number: number } | { repoId: string; skipped: string })[];
}

/** POST /api/tracker/:space/timelines/:slug/checkpoints. */
export interface CreateCheckpoint {
  summary?: string;
}

export interface TimelineList {
  timelines: Timeline[];
  /** With `?stalled=true`: the Space's idle period the list was cut with. */
  idleDays?: number;
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

/** A failed, not-yet-published creation was fenced and its owned allocations drained. */
export interface TimelineCreationCancellation {
  cancelled: true;
  slug: string;
  bookmarks: [];
}

export interface CreateTimeline {
  slug: string;
  name?: string;
  policy?: TimelinePolicy;
  experimental?: boolean;
  /** `main` (the default) or another timeline's slug. */
  parent?: string;
  /**
   * `space/name`, or `{ repo, commit }` to fork at a commit other than the
   * parent's tip. Defaults to the parent timeline's repositories.
   */
  repos?: (string | { repo: string; commit?: string })[];
}

export interface UpdateTimeline {
  name?: string;
  experimental?: boolean;
}

/**
 * A landing (CORE-77): the queue merging a
 * checkpoint into each repository's current main, running the gates on each
 * merge, and only then advancing each main to its merge with a
 * compare-and-swap. Kept in the tracker with the timeline it lands.
 *
 * - `merging`: CI jobs merge the checkpoint into main (refs/heads/gitmatrix/landing/<slug>);
 * - `testing`: the gates (the repository's pipeline) run on the merges;
 * - `advancing`: every merge passed; mains advance one repository at a time;
 * - `conflict`: a merge conflicts: no automatic sync, a person or an agent
 *   merges main into the timeline and makes a new checkpoint;
 * - `failed`: the gates failed, the checkpoint moved on, or it ran out of retries;
 * - `landed`: every main advanced; the timeline is landed.
 */
export type LandingState =
  | "merging"
  | "testing"
  | "advancing"
  | "conflict"
  | "failed"
  | "blocked_dependency"
  | "landed";

/** One repository of a landing. */
export interface LandingRepo {
  id: string;
  space: string;
  name: string;
  /** The checkpoint's commit. */
  commit: string;
  /** Main's tip this attempt merges onto. */
  base: string | null;
  /** The merge commit, once the merge job pushed it. */
  merge: string | null;
  /** Merges tried: a main that moved before it advanced is merged again. */
  attempt: number;
  state:
    | "merging"
    | "testing"
    | "tested"
    | "advanced"
    | "conflict"
    | "failed"
    | "blocked_dependency";
  /** The CI runs that merged and tested this attempt. */
  mergeRun: { id: string; number: number } | null;
  gateRun: { id: string; number: number } | null;
  /** Why it stopped (conflicting files, failing jobs, a main that moved). */
  reason: string | null;
  source?: SourceSnapshot;
  logicalBase?: SourceSnapshot;
  dependencies?: SourceDependency[];
  casIntent?: { base: string; candidate: string; tree: string };
  resultTree?: string;
  noop?: boolean;
}

export interface Landing {
  id: string;
  timelineId: string;
  slug: string;
  checkpointId: string;
  checkpointNumber: number;
  state: LandingState;
  repos: LandingRepo[];
  /** Why it stopped, for people. */
  reason: string | null;
  /** How it was queued: a green checkpoint (`auto`), an approval, or someone asking. */
  trigger: "auto" | "approval" | "request";
  /** Who queued it: main's moves and the timeline's events are theirs. */
  requestedBy: { actorId: string; accountableId: string; agentId: string | null };
  /** Immutable initiating scope; re-authorized before each new external effect. */
  authority: WorkAuthority;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Landings still at work, as opposed to stopped or done. */
export const LANDING_ACTIVE: readonly LandingState[] = ["merging", "testing", "advancing"];

/** The branch a landing's merge is pushed to and tested on, before main moves. */
export function landingBranch(slug: string): string {
  return `gitmatrix/landing/${slug}`;
}

/** The slug a landing branch (short name, without refs/heads/) belongs to. */
export function landingSlugOf(branch: string): string | null {
  const match = /^gitmatrix\/landing\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(branch);
  return match ? match[1]! : null;
}

/** POST /api/tracker/:space/timelines/:slug/land: queued, or why not. */
export interface LandResult {
  landing: Landing;
  /** False when a landing of this checkpoint was already under way. */
  queued: boolean;
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

/** Days without a push before a timeline counts as idle, unless the Space says otherwise. */
export const DEFAULT_IDLE_DAYS = 7;
const DAY = 24 * 60 * 60 * 1000;

/** The last sign of work in a timeline: its newest push, or its fork. */
export function lastPush(timeline: Pick<Timeline, "pushedAt" | "createdAt">): string {
  return timeline.pushedAt && timeline.pushedAt > timeline.createdAt
    ? timeline.pushedAt
    : timeline.createdAt;
}

/**
 * Whether a timeline has stalled: still being worked (active or idle, not
 * waiting on a person or landing) with no push for the idle period. An
 * experimental timeline never counts: it isn't expected to land, so stalling
 * is expected of it. Views of stalled or
 * idle work use this.
 */
export function isStalled(
  timeline: Pick<Timeline, "status" | "experimental" | "pushedAt" | "createdAt">,
  now: number,
  idleDays = DEFAULT_IDLE_DAYS,
): boolean {
  if (timeline.experimental) return false;
  if (timeline.status === "idle") return true;
  if (timeline.status !== "active") return false;
  return now - Date.parse(lastPush(timeline)) >= idleDays * DAY;
}
