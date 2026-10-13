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
  /** What step runs of this commit produced, newest first (CORE-235). */
  artifacts: StepArtifact[];
}

/** One job of a step run, in a test summary. */
export interface StepJobResult {
  name: string;
  status: "succeeded" | "failed" | "cancelled" | "skipped";
  exitCode: number | null;
  durationMs: number | null;
}

/** A step run's results: the first artifact kind. */
export interface StepTestSummary {
  status: "succeeded" | "failed" | "cancelled";
  passed: number;
  failed: number;
  jobs: StepJobResult[];
}

/** Raster formats a screenshot may be, recognized by signature, never SVG. */
export type StepImageType = "image/png" | "image/jpeg" | "image/webp";

/** A picture of the app a CI job took at this commit (CORE-383). */
export interface StepScreenshot {
  /** What it shows, unique within its run; the same name across commits compares. */
  name: string;
  contentType: StepImageType;
  bytes: number;
  /** Hex SHA-256 of the image: equal across commits means unchanged. */
  sha256: string;
  /** The CI job that uploaded it. */
  job: string;
}

/** A diagram a CI job drew for this commit (CORE-383), kept inline. */
export interface StepDocument {
  name: string;
  format: "mermaid";
  source: string;
  job: string;
}

/** Bounds on what a run may attach to its commit (CORE-383). */
export const STEP_ARTIFACT_LIMITS = {
  /** Screenshots and documents together, per run. */
  perRun: 40,
  imageBytes: 2 * 1024 * 1024,
  documentChars: 50_000,
  /** Letters, digits, space, dot, underscore, hyphen; 1-80, starting alphanumeric. */
  name: /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,79}$/,
} as const;

/**
 * Something a step run produced, attached to the step by commit. A test
 * summary and a document carry their data inline; a screenshot points at a
 * stored image (`url`, served to people who can read the repository).
 */
export type StepArtifact = {
  id: string;
  runId: string;
  runNumber: number;
  createdAt: string;
} & (
  | { kind: "test-summary"; data: StepTestSummary }
  | { kind: "screenshot"; data: StepScreenshot; url: string }
  | { kind: "document"; data: StepDocument }
);

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

/** The live feed keeps a record this many days at most (CORE-244: an account may keep fewer). */
export const STEP_FEED_DAYS = 7;

/** The placeholder retention leaves for trimmed instructions and steering (CORE-244). */
export const TRIMMED_TEXT = "(Removed by retention.)";

/**
 * One record of a timeline's live feed (CORE-239): small, never the context
 * itself. `seq` orders a feed; readers may see a record twice and dedupe by
 * (repo, commitOid).
 */
export interface StepFeedRecord {
  seq: number;
  /** owner/name */
  repo: string;
  timeline: string;
  changeId: string;
  commitOid: string;
  summary: string;
  issue: string | null;
  author: { id: string; kind: "agent" | "person"; name: string };
  /** From the step's own tests: null when it reported none. */
  tests: { passed: number; failed: number } | null;
  /** The step's context said why: a first line, at most 200 characters. */
  why: string;
  committedAt: string;
  /** When the feed received it. */
  at: string;
}

/**
 * A step an admin deleted, sent on its live feed as `event: removed` (no `id`;
 * CORE-399): readers drop the record with this repository, change and commit.
 * A feed sends every removal it remembers on each connect, so a reader that
 * missed one while reconnecting still drops what it holds.
 */
export interface StepFeedRemoval {
  /** owner/name, as the record had it */
  repo: string;
  changeId: string;
  commitOid: string;
}
