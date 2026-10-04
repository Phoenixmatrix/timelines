// Steps (CORE-226): the context an agent attaches to a commit it makes at a
// meaningful step in a timeline. The contract between gm, the Worker and the
// web. Context is the agent's report (and its harness's capture), shown as
// such next to what Gitmatrix verifies: the commit, CI and approvals.

/** Where a piece of context came from. */
export type ContextSource = "hook" | "agent" | "person";

/** One instruction or one piece of steering, in order. */
export interface ContextEntry {
  text: string;
  source: ContextSource;
  /** When it was given, if known. */
  at?: string;
}

/** A test or check the agent (or gm test) ran for the step. */
export interface StepTest {
  command: string;
  /** Process exit status; 0 passed. */
  exit: number;
  summary: string;
  durationMs?: number;
  /** "local": gm ran it at commit time; "reported": the agent says it ran. */
  origin: "local" | "reported";
}

/** How each part was captured, so readers know what may be missing. */
export interface StepCoverage {
  /** e.g. "hook:claude-code", "agent", or "none". */
  instructions: string;
  steering: string;
}

/** The context itself: everything but the commit and who made it. */
export interface StepContextBody {
  instructions: ContextEntry[];
  steering: ContextEntry[];
  why: string;
  challenges: string;
  tests: StepTest[];
  coverage: StepCoverage;
  harness: string | null;
  model: string | null;
}

/** What gm sends for one step (POST /api/repos/:owner/:name/steps). */
export interface StepUpload extends Partial<StepContextBody> {
  changeId: string;
  commitOid: string;
  /** The commit's one-line summary. */
  summary: string;
  committedAt: string;
  timeline?: string | null;
  issue?: string | null;
}

/** Who made a step: an agent (with its accountable person) or a person. */
export interface StepAuthor {
  id: string;
  kind: "agent" | "person";
  name: string;
  accountable: { id: string; slug: string; displayName: string; avatarUrl: string | null };
}

/** One version of a step's context: one commit incarnation of the change. */
export interface Step {
  changeId: string;
  commitOid: string;
  summary: string;
  timeline: string | null;
  issue: string | null;
  author: StepAuthor;
  committedAt: string;
  /** Seen in a push; false is "local, unverified". */
  verified: boolean;
  /** Deleted or redacted: the context is gone, the step stays. */
  deleted: boolean;
  context: StepContextBody;
}

/** GET /api/repos/:owner/:name/steps: a page of steps, newest first. */
export interface StepPage {
  steps: Step[];
  /** Pass back as `cursor` for older steps; null at the start. */
  cursor: string | null;
}

/** GET /api/repos/:owner/:name/steps/:changeId: every version, newest first. */
export interface StepVersions {
  changeId: string;
  versions: Step[];
}

/** Bounds every upload obeys (413/400 beyond them). */
export const STEP_LIMITS = {
  /** The whole context record, as JSON. */
  contextBytes: 256 * 1024,
  /** Entries in instructions, steering or tests. */
  entries: 100,
  summary: 500,
} as const;

export const EMPTY_CONTEXT: StepContextBody = {
  instructions: [],
  steering: [],
  why: "",
  challenges: "",
  tests: [],
  coverage: { instructions: "none", steering: "none" },
  harness: null,
  model: null,
};
