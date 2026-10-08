// The Chronicle (CORE-42): the tracker on a time axis. A point in time reads
// "as of"; a claimed stretch of work is a "work span". The server
// reconstructs both from the Tracker's event log (worker/tracker/chronicle.ts):
//
//   GET /api/tracker/:owner/chronicle?from&to[&q][&cursor][&limit][&quiet=1]
//   GET /api/tracker/:owner/issues/:issue/work
//
// Everything here is pure, shared by the Worker, the web view and the tests.

import type { AuditActor, DoneIn, IssueStatus, IssueType, RequestKind } from "./tracker.ts";
import type { LandingState, TimelinePolicy, TimelineStatus } from "./timelines.ts";
import type { ReleaseCategory } from "./release-notes.ts";

/** Issues per page: the default and the most one page may ask for. */
export const CHRONICLE_PAGE = 100;
export const CHRONICLE_MAX_PAGE = 200;
/** Events one page reads at most; a page stops early (and pages on) past it. */
export const CHRONICLE_EVENT_BUDGET = 20_000;
/** The longest range one request may cover. */
export const CHRONICLE_MAX_RANGE_MS = 3 * 366 * 86_400_000;

/** An issue's state at one moment: its status (null before it existed) and whether it waited on a person. */
export interface ChronicleState {
  status: IssueStatus | null;
  waiting: boolean;
}

/** From `at` on, the issue was in this state (until the next segment). */
export interface ChronicleSegment extends ChronicleState {
  at: string;
  /** The event that changed it. */
  cursor: number;
}

/**
 * How a work span ended:
 * - `release`: its holder let go; `complete`: its holder completed the issue;
 * - `revoke`: the holder of a lease above took it back;
 * - `takeover`: a tracker owner claimed it over the holder;
 * - `handoff`: someone accepted the holder's offer;
 * - `ended`: someone else ended it (a forced release, or an edit that cleared it);
 * - `expiry`: it ran out without a renewal (nothing is recorded then: the
 *   span ends at the lease's expiry);
 * - `landed`/`abandoned`: a retained lease, released when its timeline landed
 *   or was abandoned.
 */
export type SpanEnd =
  | "release"
  | "complete"
  | "revoke"
  | "takeover"
  | "handoff"
  | "ended"
  | "expiry"
  | "landed"
  | "abandoned";

export const SPAN_END_LABEL: Record<SpanEnd, string> = {
  release: "Released",
  complete: "Completed",
  revoke: "Revoked",
  takeover: "Taken over",
  handoff: "Handed off",
  ended: "Ended by someone else",
  expiry: "Expired",
  landed: "Released when its timeline landed",
  abandoned: "Released when its timeline was abandoned",
};

/** A claimed stretch of work: from the claim through renewals to its end. */
export interface WorkSpan {
  /** `<issue id>:<cursor of the claim>`: stable across requests. */
  id: string;
  issueId: string;
  /** Who held it: an agent's id, or a person's (see `actors`). */
  holder: string;
  /** The human answerable for the holder. */
  accountableId: string | null;
  /** The working session's label (`gm issue claim --agent`). */
  session: string;
  start: string;
  /** When it ended; null while it still holds as of the range's end. */
  end: string | null;
  endedBy: SpanEnd | null;
  /** Who ended it, when not its holder (a revoke, takeover, handoff or forced release). */
  endedById: string | null;
  /** The latest expiry it was renewed to. */
  expiresAt: string;
  /** Renewals inside the requested range. */
  renewals: string[];
  /** While it waited on a person: the lease held without renewals. */
  parked: { from: string; to: string | null }[];
  /**
   * Finished in a timeline: from `at` the lease was retained, held but no
   * longer worked, until that timeline landed or was abandoned (CORE-75).
   */
  retained: { at: string; timeline: DoneIn } | null;
  /** The issue whose lease handed this one out, for a delegated claim. */
  delegatedFrom: string | null;
  /** The timeline it was claimed in; null for main. */
  timelineId: string | null;
}

export type MarkerKind =
  | "created"
  | "comment"
  | "checkpoint"
  | "evidence"
  | "asked"
  | "answered"
  | "withdrawn"
  | "linked"
  | "unlinked"
  | "landed"
  | "timeline-checkpoint"
  | "timeline-landing";

export const MARKER_LABEL: Record<MarkerKind, string> = {
  created: "Created",
  comment: "Comment",
  checkpoint: "Checkpoint",
  evidence: "Evidence",
  asked: "Asked a person",
  answered: "Answered",
  withdrawn: "Request withdrawn",
  linked: "Linked",
  unlinked: "Unlinked",
  landed: "Landed with its timeline",
  "timeline-checkpoint": "Timeline checkpoint",
  "timeline-landing": "Timeline landing",
};

/** Something that happened to an issue at a moment. */
export interface ChronicleMarker {
  /** `e:<cursor>` for a tracker event, `t:<seq>` for a timeline event. */
  id: string;
  at: string;
  kind: MarkerKind;
  actorId: string | null;
  /** Plain text, at most a line or two. */
  text: string;
  /** The other issue (links), request kind, or timeline the marker is about. */
  issue?: string;
  request?: RequestKind;
  timeline?: string;
  checkpoint?: number;
  /** A timeline landing's outcome. */
  outcome?: string;
}

export interface ChronicleIssue {
  id: string;
  key: string;
  title: string;
  type: IssueType;
  priority: 0 | 1 | 2 | 3 | 4;
  teamId: string;
  parentId: string | null;
  createdAt: string;
  /** As of the range's start. */
  start: ChronicleState;
  /** Changes of state inside the range, oldest first. */
  segments: ChronicleSegment[];
  /** Work spans overlapping the range, oldest first. */
  spans: WorkSpan[];
  markers: ChronicleMarker[];
  /** Issues blocking it now (links can change; their history shows as markers). */
  blockers: string[];
  /**
   * Retention removed this issue's history before this time (CORE-203): its
   * state before it is the oldest one known, not necessarily the truth.
   */
  historyFrom: string | null;
}

/** Where the tracker's history begins, and what retention removed. */
export interface ChronicleHistory {
  /** The oldest event the tracker still has. */
  earliest: string | null;
  /**
   * Set once retention pruned the activity log (`tracker-activity`): events
   * before `before` (closed issues' older changes) may be missing.
   */
  pruned: { before: string; cursor: number } | null;
  /** Closed issues retention removed entirely (`closed-issues`). */
  removedIssues: number;
}

/** Events per bucket over the whole available history, for the overview strip. */
export interface ChronicleDensity {
  start: string;
  bucketMs: number;
  counts: number[];
}

/** GET /api/tracker/:owner/chronicle */
export interface Chronicle {
  from: string;
  to: string;
  query: string;
  serverTime: string;
  issues: ChronicleIssue[];
  /** Who each actor id names, as recorded when they acted. */
  actors: Record<string, AuditActor>;
  /** Team keys by id. */
  teams: Record<string, string>;
  /** Pass as `cursor` for the next page; null on the last. */
  next: string | null;
  /** Matching issues left out: closed before the range, untouched in it (`quiet=1` includes them). */
  quiet: number;
  history: ChronicleHistory;
  /** On the first page only. */
  density?: ChronicleDensity;
}

// ── Reading a chronicle ─────────────────────────────────────────────────────

const ms = (iso: string) => Date.parse(iso);

/** An issue's state as of `at`: the last change at or before it (the start state before the range). */
export function stateAt(issue: ChronicleIssue, at: number): ChronicleState {
  let state = issue.start;
  for (const segment of issue.segments) {
    if (ms(segment.at) > at) break;
    state = segment;
  }
  return { status: state.status, waiting: state.waiting };
}

/** When a span stops being drawn: its end, else `now` (it still holds). */
export function spanEndMs(span: WorkSpan, now: number): number {
  return span.end ? ms(span.end) : Math.max(now, ms(span.start));
}

/** Whether a span held at `at`. */
export function spanActiveAt(span: WorkSpan, at: number, now: number): boolean {
  return ms(span.start) <= at && at < spanEndMs(span, now);
}

/** The worked part of a span: from its start until it was retained (or ended). */
export function workedEndMs(span: WorkSpan, now: number): number {
  return span.retained
    ? Math.min(ms(span.retained.at), spanEndMs(span, now))
    : spanEndMs(span, now);
}

/** Time a span was worked inside [from, to): held, not parked waiting on a person, not retained. */
export function workedMs(span: WorkSpan, from: number, to: number, now: number): number {
  const start = ms(span.start);
  const end = workedEndMs(span, now);
  let worked = overlap(start, end, from, to);
  for (const parked of span.parked) {
    const a = Math.max(ms(parked.from), start);
    const b = Math.min(parked.to ? ms(parked.to) : end, end);
    if (b > a) worked -= overlap(a, b, from, to);
  }
  return Math.max(0, worked);
}

/** Milliseconds of `[start, end)` inside `[from, to)`. */
export function overlap(start: number, end: number, from: number, to: number): number {
  return Math.max(0, Math.min(end, to) - Math.max(start, from));
}

export interface RangeWorker {
  actorId: string;
  /** Worked time inside the range (parked and retained time excluded), in ms. */
  workedMs: number;
  spans: number;
  issues: string[];
}

export interface RangeSummary {
  /** Issues per status at the range's start and end (null: didn't exist yet). */
  startCounts: Partial<Record<IssueStatus | "none", number>>;
  endCounts: Partial<Record<IssueStatus | "none", number>>;
  /** Issues whose status at the end differs from the start. */
  changed: string[];
  /** Issues that became done inside the range and still were at its end. */
  completed: string[];
  /** Waiting on a person at the end of the range. */
  waiting: string[];
  /** Open at the end with a blocker not done at the end (by current links). */
  blocked: string[];
  workers: RangeWorker[];
}

/** What a range [from, to] holds, across the loaded issues. */
export function summarize(
  issues: ChronicleIssue[],
  from: number,
  to: number,
  now: number,
): RangeSummary {
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const summary: RangeSummary = {
    startCounts: {},
    endCounts: {},
    changed: [],
    completed: [],
    waiting: [],
    blocked: [],
    workers: [],
  };
  const workers = new Map<string, RangeWorker>();
  for (const issue of issues) {
    const start = stateAt(issue, from);
    const end = stateAt(issue, to);
    // Made after the range, or closed before it and untouched in it: not part of what it holds.
    if (!start.status && !end.status) continue;
    if (
      (start.status === "done" || start.status === "canceled") &&
      !issue.segments.some((s) => ms(s.at) > from && ms(s.at) <= to) &&
      !issue.markers.some((m) => ms(m.at) >= from && ms(m.at) <= to) &&
      !issue.spans.some((s) => workedMs(s, from, to, now) > 0)
    )
      continue;
    const a = start.status ?? "none";
    const b = end.status ?? "none";
    summary.startCounts[a] = (summary.startCounts[a] ?? 0) + 1;
    summary.endCounts[b] = (summary.endCounts[b] ?? 0) + 1;
    if (a !== b) summary.changed.push(issue.id);
    if (end.status === "done" && start.status !== "done") summary.completed.push(issue.id);
    if (end.waiting) summary.waiting.push(issue.id);
    if (
      end.status &&
      end.status !== "done" &&
      end.status !== "canceled" &&
      issue.blockers.some((id) => {
        const blocker = byId.get(id);
        return !blocker || stateAt(blocker, to).status !== "done";
      })
    )
      summary.blocked.push(issue.id);
    for (const span of issue.spans) {
      const worked = workedMs(span, from, to, now);
      if (!worked) continue;
      const worker = workers.get(span.holder) ?? {
        actorId: span.holder,
        workedMs: 0,
        spans: 0,
        issues: [],
      };
      worker.workedMs += worked;
      worker.spans++;
      if (!worker.issues.includes(issue.id)) worker.issues.push(issue.id);
      workers.set(span.holder, worker);
    }
  }
  summary.workers = [...workers.values()].sort(
    (x, y) => y.workedMs - x.workedMs || x.actorId.localeCompare(y.actorId),
  );
  return summary;
}

/** "builder for Ann Lee", "Ann Lee": an actor in words. */
export function actorText(actors: Record<string, AuditActor>, id: string | null): string {
  if (!id) return "Someone";
  const actor = actors[id];
  if (!actor) return id;
  const name = actor.name ?? id;
  return actor.kind === "agent" && actor.accountable
    ? `${name} for ${actor.accountable.displayName}`
    : name;
}

// ── Linked work ─────────────────────────────────────────────────────────────

/** A repository, by its current owner and name. */
export interface WorkRepo {
  id: string;
  owner: string;
  name: string;
}

/** Where a commit was found for the issue. */
export type WorkCommitSource = "step" | "release-note" | "checkpoint" | "landing";

export interface WorkCommit {
  repo: WorkRepo;
  oid: string;
  changeId: string | null;
  /** The commit's one-line summary, when known. */
  summary: string | null;
  /** When it was committed (a step) or recorded. */
  at: string | null;
  sources: WorkCommitSource[];
  href: string;
}

/** An agent's (or person's) work context for a commit (CORE-231 steps). */
export interface WorkStep {
  repo: WorkRepo;
  changeId: string;
  commitOid: string;
  summary: string;
  author: AuditActor;
  committedAt: string;
  verified: boolean;
  timeline: string | null;
  /** The step's "why", shortened. */
  why: string;
  model: string | null;
  href: string;
}

export interface WorkRun {
  repo: WorkRepo;
  number: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  commit: string;
  ref: string;
  title: string;
  kind: "push" | "manual" | "preview" | "landing";
  createdAt: string;
  finishedAt: string | null;
  href: string;
}

export interface WorkDeployment {
  repo: WorkRepo;
  id: number;
  environment: string;
  status: "active" | "sleeping" | "expired" | "failed";
  commit: string;
  url: string | null;
  createdAt: string;
  /** The preview itself while it's up, else the run that deployed it, else the repository's CI. */
  href: string;
}

export interface WorkPackage {
  format: string;
  name: string;
  version: string;
  /** The account whose registry it's in. */
  owner: string;
  commit: string;
  repo: WorkRepo;
  at: string;
  href: string;
}

export interface WorkCheckpoint {
  id: string;
  number: number;
  createdAt: string;
  summary: string;
  approval: "pending" | "approved" | "rejected" | "superseded" | null;
  commits: { repo: WorkRepo; oid: string }[];
  href: string;
}

export interface WorkLanding {
  id: string;
  checkpointNumber: number;
  state: LandingState;
  createdAt: string;
  updatedAt: string;
  runs: { repo: WorkRepo; number: number; href: string }[];
  href: string;
}

export interface WorkTimeline {
  id: string;
  slug: string;
  name: string;
  status: TimelineStatus;
  policy: TimelinePolicy;
  checkpoints: WorkCheckpoint[];
  landings: WorkLanding[];
  href: string;
}

export interface WorkReleaseNote {
  repo: WorkRepo;
  release: string;
  /** "2026-10-02" for a daily update, else the tag. */
  label: string;
  title: string;
  category: ReleaseCategory;
  shippedAt: string;
  href: string;
}

/**
 * A commit whose message names the issue (CORE-22): a mention, not evidence
 * the work was done, so it's kept apart from the explicit lists above. Its
 * own CI runs and packages ride along.
 */
export interface WorkMention {
  repo: WorkRepo;
  oid: string;
  changeId: string | null;
  /** The message's first line. */
  title: string;
  committedAt: string | null;
  /** The branch or tag whose push first made it reachable; null when found in history. */
  ref: string | null;
  pushedAt: string;
  /**
   * Opens the commit panel: `/<owner>/<repo>?commit=<oid>`, with `source=<id>`
   * for a commit in a timeline's work source (CORE-296).
   */
  href: string;
  runs: WorkRun[];
  packages: WorkPackage[];
}

/** GET /api/tracker/:owner/issues/:issue/work: what the issue's work produced, newest first. */
export interface LinkedWork {
  issue: { id: string; key: string; title: string; status: IssueStatus };
  commits: WorkCommit[];
  steps: WorkStep[];
  runs: WorkRun[];
  deployments: WorkDeployment[];
  packages: WorkPackage[];
  timelines: WorkTimeline[];
  releaseNotes: WorkReleaseNote[];
  /** Commits that mention the issue by key, newest first. */
  mentions: WorkMention[];
  /** A list stopped at its limit. */
  truncated: boolean;
}

/** Items per list in linked work. */
export const WORK_LIMIT = 50;
