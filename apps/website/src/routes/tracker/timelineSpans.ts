// A timeline as a trace (CORE-396): each step is a span, placed in its
// author's lane at its commit time, with its health from the checks it
// recorded and CI ran, and the steering a person gave it. Pure, so the view
// (TimelineObservability.tsx) and its tests share one model.

import type {
  ContextEntry,
  Step,
  StepFeedRecord,
  StepJobResult,
  StepTest,
  StepTestSummary,
} from "../../../shared/steps.ts";
import type { CheckpointView } from "../../../shared/timelines.ts";

export type Health = "pass" | "fail" | "none";

export interface Span {
  /** Unique within the timeline: the repository and commit. */
  key: string;
  repo: string;
  changeId: string;
  commitOid: string;
  summary: string;
  /** When it was committed (ms). */
  at: number;
  author: { id: string; name: string; kind: "agent" | "person" };
  issue: string | null;
  health: Health;
  /** Checks it recorded locally plus CI's step-run jobs. */
  checks: { passed: number; failed: number };
  why: string;
  instructions: ContextEntry[];
  steering: ContextEntry[];
  challenges: string;
  tests: StepTest[];
  /** The newest CI step run's summary, if one ran. */
  ci: StepTestSummary | null;
  /** Whether the person's words were captured by the harness, not retold by the agent. */
  captured: boolean;
  /** Known only from the live feed so far: its full context hasn't loaded. */
  partial: boolean;
  harness: string | null;
  model: string | null;
}

/**
 * When an instruction or steering was given (CORE-398): the time the harness
 * (or the person) recorded with it, if it's a real one. An agent's retelling
 * has no trustworthy time.
 */
export function givenAt(entry: ContextEntry): number | null {
  if (entry.source === "agent" || !entry.at) return null;
  const at = Date.parse(entry.at);
  return Number.isFinite(at) ? at : null;
}

/** How long before its step a moment of steering is still drawn on the trace. */
const STEERING_WINDOW = 12 * 60 * 60 * 1000;

/**
 * The moments a person steered a span, as drawn on its lane: given, and within
 * twelve hours before the step (to a minute after). Older or odd times stay in
 * the step's details but don't stretch the trace.
 */
export function steeredAt(span: Span): { at: number; text: string }[] {
  return span.steering.flatMap((entry) => {
    const at = givenAt(entry);
    return at !== null && at >= span.at - STEERING_WINDOW && at <= span.at + 60_000
      ? [{ at, text: entry.text }]
      : [];
  });
}

const ciSummary = (step: Step): StepTestSummary | null => {
  const runs = (step.artifacts ?? [])
    .filter((artifact) => artifact.kind === "test-summary")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return runs.length ? (runs[0]!.data as StepTestSummary) : null;
};

function healthOf(checks: { passed: number; failed: number }, ci: StepTestSummary | null): Health {
  if (checks.failed > 0 || ci?.status === "failed") return "fail";
  return checks.passed > 0 ? "pass" : "none";
}

/** A step as a span. Its checks: what the agent ran, then CI's step-run jobs. */
export function spanFromStep(repo: string, step: Step): Span {
  const ci = ciSummary(step);
  const { context } = step;
  const checks = { passed: 0, failed: 0 };
  for (const test of context.tests) checks[test.exit === 0 ? "passed" : "failed"]++;
  // A cancelled run's finished jobs don't make the step pass.
  for (const job of ci?.status === "cancelled" ? [] : (ci?.jobs ?? [])) {
    if (job.status === "succeeded") checks.passed++;
    else if (job.status === "failed") checks.failed++;
  }
  return {
    key: `${repo}@${step.commitOid}`,
    repo,
    changeId: step.changeId,
    commitOid: step.commitOid,
    summary: step.summary,
    at: Date.parse(step.committedAt),
    author: { id: step.author.id, name: step.author.name, kind: step.author.kind },
    issue: step.issue,
    health: healthOf(checks, ci),
    checks,
    why: context.why,
    instructions: context.instructions,
    steering: context.steering,
    challenges: context.challenges,
    tests: context.tests,
    ci,
    captured: context.coverage.instructions.startsWith("hook:"),
    partial: false,
    harness: context.harness,
    model: context.model,
  };
}

/** A step the live feed announced before its full context loaded. */
export function spanFromFeed(record: StepFeedRecord): Span {
  const checks = record.tests ?? { passed: 0, failed: 0 };
  return {
    key: `${record.repo}@${record.commitOid}`,
    repo: record.repo,
    changeId: record.changeId,
    commitOid: record.commitOid,
    summary: record.summary,
    at: Date.parse(record.committedAt),
    author: { id: record.author.id, name: record.author.name, kind: record.author.kind },
    issue: record.issue,
    health: healthOf(checks, null),
    checks,
    why: record.why,
    instructions: [],
    steering: [],
    challenges: "",
    tests: [],
    ci: null,
    captured: false,
    partial: true,
    harness: null,
    model: null,
  };
}

/**
 * Every span once, oldest first: a loaded step beats its feed record, and of
 * an amended change only its newest commit stays (the line moved on from the
 * rest).
 */
export function mergeSpans(loaded: Span[], live: Span[]): Span[] {
  const byKey = new Map<string, Span>();
  for (const span of live) byKey.set(span.key, span);
  for (const span of loaded) byKey.set(span.key, span);
  const newest = new Map<string, Span>();
  for (const span of byKey.values()) {
    const change = `${span.repo}#${span.changeId}`;
    const seen = newest.get(change);
    if (!seen || span.at > seen.at || (span.at === seen.at && !span.partial))
      newest.set(change, span);
  }
  return [...newest.values()].sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
}

export interface Lane {
  author: Span["author"];
  spans: Span[];
}

/** One lane per author, the most recently active first. */
export function lanesOf(spans: Span[]): Lane[] {
  const lanes = new Map<string, Lane>();
  for (const span of spans) {
    const lane = lanes.get(span.author.id) ?? { author: span.author, spans: [] };
    lane.spans.push(span);
    lanes.set(span.author.id, lane);
  }
  return [...lanes.values()].sort((a, b) => b.spans.at(-1)!.at - a.spans.at(-1)!.at);
}

export interface Vitals {
  steps: number;
  checks: { passed: number; failed: number };
  /** Steering entries across every step. */
  steered: number;
  /** Steps that say why or what they were asked. */
  withIntent: number;
  checkpoints: number;
  previewLive: boolean;
  agents: number;
}

export function vitalsOf(spans: Span[], checkpoints: CheckpointView[]): Vitals {
  const checks = { passed: 0, failed: 0 };
  let steered = 0;
  let withIntent = 0;
  for (const span of spans) {
    checks.passed += span.checks.passed;
    checks.failed += span.checks.failed;
    steered += span.steering.length;
    if (span.why.trim() || span.instructions.length) withIntent++;
  }
  return {
    steps: spans.length,
    checks,
    steered,
    withIntent,
    checkpoints: checkpoints.length,
    previewLive: checkpoints.some((view) =>
      view.previews.some((preview) => preview.status === "active"),
    ),
    agents: new Set(spans.map((span) => span.author.id)).size,
  };
}

/** The time a trace spans: its first span or checkpoint to its last, or now while it's open. */
export function domainOf(
  spans: Span[],
  checkpoints: CheckpointView[],
  end: number | null,
): [number, number] {
  const times = [
    ...spans.map((span) => span.at),
    ...spans.flatMap((span) => steeredAt(span).map((moment) => moment.at)),
    ...checkpoints.map((view) => Date.parse(view.checkpoint.createdAt)),
  ].filter(Number.isFinite);
  if (!times.length) return [0, 1];
  const from = Math.min(...times);
  let to = end ?? Math.max(...times);
  to = Math.max(to, ...times);
  // A little room at both ends, and never zero wide.
  const pad = Math.max((to - from) * 0.03, 60_000);
  return [from - pad, to + pad];
}

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const STEPS = [5, 15, 30, 60, 180, 360, 720, 1440, 2880, 10080].map((m) => m * MINUTE);

/** Round-numbered ticks across [from, to]: at most `count`, on a 5 minute grid or coarser. */
export function ticksOf([from, to]: [number, number], count = 6): number[] {
  // Past a week a tick, whole weeks: as many as keep within `count`.
  const every =
    STEPS.find((step) => (to - from) / step <= count) ??
    Math.ceil((to - from) / count / (7 * DAY)) * 7 * DAY;
  // Align to the local clock, so hours and days fall on whole hours and midnights.
  const offset = new Date(from).getTimezoneOffset() * MINUTE;
  const first = Math.ceil((from - offset) / every) * every + offset;
  const ticks: number[] = [];
  for (let at = first; at <= to; at += every) ticks.push(at);
  return ticks;
}

/** A tick's label: the time within a day, the date for whole days, else both. */
export function tickLabel(at: number, [from, to]: [number, number], count = 6): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const every = STEPS.find((step) => (to - from) / step <= count) ?? 7 * DAY;
  if (every >= DAY) return day;
  return to - from <= 36 * 60 * MINUTE ? time : `${day} ${time}`;
}

/**
 * CI's step-run jobs, each with its duration as a share of the longest: the
 * jobs run independently and only their durations are recorded, so they're
 * compared, never laid end to end.
 */
export function jobBars(
  jobs: StepJobResult[],
): { job: StepJobResult; ms: number; share: number }[] {
  const longest = Math.max(0, ...jobs.map((job) => job.durationMs ?? 0));
  return jobs.map((job) => {
    const ms = Math.max(job.durationMs ?? 0, 0);
    return { job, ms, share: longest ? ms / longest : 0 };
  });
}
