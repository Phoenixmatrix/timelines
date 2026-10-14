// "Why did this change?" (CORE-85): one chain that agents and people both walk. From a line, through
// blame, to a commit and its change id; then the timelines the change passed
// through (the push log and merges), its issues, the checkpoints that pinned
// it, their approvals, and its landing. Historical change ids join rewritten
// context; compact source admission and checkpoints use exact source/OID
// membership, never equality of change ids.
//
// GET /api/repos/:space/:name/why serves it to the web app and to `gm why`.

import type { Step } from "./steps.ts";
import type { RefUpdate, SourceLineage } from "./api.ts";
import type { CodeSource } from "./code-source.ts";
import type {
  ApprovalOutcome,
  Landing,
  LandingRepo,
  TimelinePolicy,
  TimelineStatus,
} from "./timelines.ts";
import type { IssueStatus } from "./tracker.ts";

/** Lines a single request may ask about. */
export const WHY_MAX_LINES = 200;
/** Commits a single request may resolve (`?commit=`). */
export const WHY_MAX_COMMITS = 20;

/** One line of the file, and the commit that last changed it. */
export interface WhyLine {
  /** 1-based, in the file at the requested revision. */
  line: number;
  commit: string;
  /** Where the line was in that commit: renames aren't followed, so the path is the same. */
  originalLine: number;
}

export interface WhyBlame {
  /**
   * `server`: the Worker blamed the file in the repository's history.
   * `local`: gm blamed it in the checkout and sent the commits.
   */
  source: "server" | "local";
  path: string;
  /** What was asked for: a branch, tag, commit or (for gm) a revision. */
  rev: string;
  /** The commit `rev` resolved to. */
  head: string;
  start: number;
  end: number;
  lines: WhyLine[];
  /** History was cut short (a limit): the oldest commits shown may be later than the truth. */
  truncated: boolean;
}

export interface WhyCommit {
  oid: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  parents: string[];
}

/** How the change id was found. */
export type WhyChangeSource =
  /** Sent by gm, which read the commit's `change-id` header. */
  | "client"
  /** The push log saw this commit as the change's first or latest commit on a ref. */
  | "push-log"
  /** Read from the commit's `change-id` header in the repository. */
  | "header";

/** What a ref a change reached is, for people. */
export type WhyLineKind = "main" | "timeline" | "branch" | "tag";

export interface WhyTimeline {
  id: string;
  slug: string;
  name: string;
  status: TimelineStatus;
  policy: TimelinePolicy;
  experimental: boolean;
}

/** A ref the change reached (CORE-68's change_refs), oldest first. */
export interface WhyRef {
  ref: string;
  kind: WhyLineKind;
  /** The timeline record, for a `timeline/<slug>` bookmark the tracker knows. */
  timeline: WhyTimeline | null;
  firstCommit: string;
  firstSeenAt: string;
  /** The push that brought it there. */
  firstUpdate: RefUpdate;
  lastCommit: string;
  lastSeenAt: string;
  /** The change was rewritten on this ref (amended or rebased): its commit changed. */
  rewritten: boolean;
  /**
   * It reached this ref after the default branch: main's work carried into a
   * timeline (a rebase onto main, or main merged in), not a line it came from.
   */
  afterLanding: boolean;
}

/** A merge that brought the change from one line into another. */
export interface WhyMerge {
  /** Each side is a timeline slug, or null for main. */
  from: string | null;
  into: string | null;
  commit: string;
  /** The merge's parent that brought the change. */
  parent: string;
  at: string;
  actorId: string | null;
}

export interface WhyIssue {
  id: string;
  key: string;
  title: string;
  status: IssueStatus;
  trackerSpace: string;
  /** `commit`: a commit of the change cites its key. `timeline`: the timeline worked on it. */
  source: "commit" | "timeline";
}

export interface WhyApproval {
  requestId: string;
  state: "pending" | ApprovalOutcome;
  by: string | null;
  at: string | null;
  note: string | null;
  /** Approved by `by`'s approve-when-green setting (CORE-378). */
  via?: "auto-approve";
}

/** A checkpoint that pinned the change (by change id, so a later rewrite still matches). */
export interface WhyCheckpoint {
  id: string;
  timeline: string;
  number: number;
  /** The change's commit when the checkpoint was made: may differ from the blamed commit. */
  commit: string;
  summary: string;
  createdAt: string;
  actorId: string;
  /** Still its timeline's head. */
  current: boolean;
  approval: WhyApproval | null;
}

/** How the change reached the default branch. */
export interface WhyLanding {
  ref: string;
  /** The change's commit when it first reached the default branch. */
  commit: string;
  at: string;
  update: RefUpdate | null;
  /**
   * `queue`: the landing queue recorded this repository advancing to this exact merge.
   * `push`: a ref update without matching queue provenance; not necessarily a direct push.
   * `unknown`: the caller can't read the tracker that records landings.
   */
  via: "compact" | "queue" | "push" | "unknown";
  /** Only set by an authoritative queue landing, never inferred from a nearby push. */
  timeline: string | null;
  queue:
    | (Pick<Landing, "id" | "checkpointId" | "checkpointNumber" | "trigger" | "requestedBy"> &
        Pick<LandingRepo, "mergeRun" | "gateRun">)
    | null;
}

/**
 * Discussions on timelines and changes are CORE-51, which hasn't shipped: the
 * chain names the gap instead of leaving the step out.
 */
export interface WhyDiscussions {
  available: false;
  reason: string;
  threads: never[];
}

export const NO_DISCUSSIONS: WhyDiscussions = {
  available: false,
  reason: "Discussions (CORE-51) aren't available yet.",
  threads: [],
};

/** The chain for one commit that blame named. */
export interface WhyChain {
  source?: CodeSource;
  lineage?: SourceLineage;
  /** Null when the server doesn't have the commit (gm blamed one that isn't pushed). */
  commit: WhyCommit | null;
  /** The commit gm or blame named; equals `commit.oid` when the server has it. */
  oid: string;
  /** The lines of the request this commit explains. */
  lines: number[];
  changeId: string | null;
  changeSource: WhyChangeSource | null;
  /** The refs the change reached, oldest first: where it has been. */
  refs: WhyRef[];
  /** The timelines it came through, in the order it reached them: none reached after landing. */
  timelines: WhyTimeline[];
  merges: WhyMerge[];
  issues: WhyIssue[];
  checkpoints: WhyCheckpoint[];
  /** The deciding approval: the newest one of the newest checkpoint that has one. */
  approval: (WhyApproval & { checkpointId: string; timeline: string; number: number }) | null;
  landing: WhyLanding | null;
  discussions: WhyDiscussions;
  /**
   * The step context behind the commit (CORE-243): its own step, or the
   * newest step of its change when a rebase or landing replaced the commit
   * (then `step.commitOid` differs). Null when no step was recorded.
   */
  step: Step | null;
}

export interface WhyResponse {
  source?: CodeSource;
  repo: { space: string; name: string; defaultBranch: string };
  /**
   * The tracker of the repository's Space, which holds its timelines,
   * checkpoints and approvals. Callers who can't read it get the git half of
   * the chain (blame, commits, refs, landing) and no tracker records.
   */
  tracker: { space: string; readable: boolean };
  /** Null when the caller named commits instead of lines. */
  blame: WhyBlame | null;
  /** One per distinct commit, in the order of the first line each explains. */
  chains: WhyChain[];
  /**
   * Names for the person and agent ids the chains mention (approvers, checkpoint
   * authors); a person also has their account slug, for their profile.
   */
  people: Record<string, { name: string; kind: "person" | "agent"; slug?: string }>;
}

/** The person and agent ids a chain mentions. */
export function mentionedIds(chain: WhyChain): string[] {
  const ids = [
    ...chain.checkpoints.flatMap((c) => [c.actorId, c.approval?.by]),
    ...chain.merges.map((m) => m.actorId),
    chain.approval?.by,
    chain.landing?.queue?.requestedBy.actorId,
    chain.landing?.queue?.requestedBy.accountableId,
    chain.landing?.queue?.requestedBy.agentId,
  ];
  return [...new Set(ids.filter((id): id is string => !!id))];
}
