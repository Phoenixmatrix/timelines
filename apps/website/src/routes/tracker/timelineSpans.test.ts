import { describe, expect, test } from "vite-plus/test";
import type { Step, StepFeedRecord } from "../../../shared/steps.ts";
import type { CheckpointView } from "../../../shared/timelines.ts";
import {
  domainOf,
  lanesOf,
  mergeSpans,
  spanFromFeed,
  spanFromStep,
  ticksOf,
  vitalsOf,
  jobBars,
  tickLabel,
} from "./timelineSpans.ts";

const step = (
  over: Omit<Partial<Step>, "context"> & { context?: Partial<Step["context"]> } = {},
): Step => {
  const { context, ...rest } = over;
  return {
    changeId: "change",
    commitOid: "a".repeat(40),
    summary: "Rank results by recency",
    timeline: "search",
    issue: "ENG-1",
    author: {
      id: "agt_builder",
      kind: "agent",
      name: "builder",
      accountable: { id: "acc_marco", slug: "marco", displayName: "Marco", avatarUrl: null },
    },
    committedAt: "2026-10-12T12:00:00.000Z",
    verified: true,
    deleted: false,
    artifacts: [],
    ...rest,
    context: {
      instructions: [],
      steering: [],
      why: "",
      challenges: "",
      tests: [],
      coverage: { instructions: "none", steering: "none" },
      harness: null,
      model: null,
      ...context,
    },
  } as Step;
};

const summary = (
  status: "succeeded" | "failed",
  jobs: [string, "succeeded" | "failed", number][],
) => ({
  id: crypto.randomUUID(),
  runId: "run",
  runNumber: 7,
  createdAt: "2026-10-12T12:05:00.000Z",
  kind: "test-summary" as const,
  data: {
    status,
    passed: jobs.filter((j) => j[1] === "succeeded").length,
    failed: jobs.filter((j) => j[1] === "failed").length,
    jobs: jobs.map(([name, s, durationMs]) => ({
      name,
      status: s,
      exitCode: s === "failed" ? 1 : 0,
      durationMs,
    })),
  },
});

describe("a step as a span", () => {
  test("its health comes from the checks it ran and CI's step run", () => {
    expect(spanFromStep("orbit/engine", step()).health).toBe("none");
    const local = spanFromStep(
      "orbit/engine",
      step({
        context: { tests: [{ command: "vp test", exit: 0, summary: "ok", origin: "local" }] },
      }),
    );
    expect(local.health).toBe("pass");
    expect(local.checks).toEqual({ passed: 1, failed: 0 });
    const ci = spanFromStep(
      "orbit/engine",
      step({
        context: { tests: [{ command: "vp test", exit: 0, summary: "ok", origin: "local" }] },
        artifacts: [
          summary("failed", [
            ["step-check", "succeeded", 40_000],
            ["step-unit", "failed", 90_000],
          ]),
        ],
      }),
    );
    expect(ci.health).toBe("fail");
    expect(ci.checks).toEqual({ passed: 2, failed: 1 });
    expect(ci.ci?.jobs.map((job) => job.name)).toEqual(["step-check", "step-unit"]);
  });

  test("a cancelled CI run's finished jobs don't make it pass", () => {
    const cancelled = spanFromStep(
      "orbit/engine",
      step({
        artifacts: [
          {
            ...summary("succeeded", [["step-check", "succeeded", 40_000]]),
            data: {
              status: "cancelled",
              passed: 1,
              failed: 0,
              jobs: [{ name: "step-check", status: "succeeded", exitCode: 0, durationMs: 40_000 }],
            },
          },
        ],
      }),
    );
    expect(cancelled.health).toBe("none");
    expect(cancelled.checks).toEqual({ passed: 0, failed: 0 });
  });

  test("captured means the harness took the person's words, not the agent's retelling", () => {
    const hooked = step({
      context: { coverage: { instructions: "hook:claude-code", steering: "hook:claude-code" } },
    });
    expect(spanFromStep("orbit/engine", hooked).captured).toBe(true);
    expect(
      spanFromStep(
        "orbit/engine",
        step({ context: { coverage: { instructions: "agent", steering: "agent" } } }),
      ).captured,
    ).toBe(false);
  });
});

const feed = (over: Partial<StepFeedRecord> = {}): StepFeedRecord => ({
  seq: 1,
  repo: "orbit/engine",
  timeline: "search",
  changeId: "later",
  commitOid: "b".repeat(40),
  summary: "Keep score as tie-breaker",
  issue: null,
  author: { id: "agt_reviewer", kind: "agent", name: "reviewer" },
  tests: { passed: 3, failed: 0 },
  why: "Ties need an order.",
  committedAt: "2026-10-12T13:00:00.000Z",
  at: "2026-10-12T13:00:05.000Z",
  ...over,
});

test("merging keeps a loaded step over its feed record, and only an amended change's newest commit", () => {
  const loaded = spanFromStep("orbit/engine", step());
  const amended = spanFromStep(
    "orbit/engine",
    step({ commitOid: "c".repeat(40), committedAt: "2026-10-12T12:30:00.000Z" }),
  );
  const live = spanFromFeed(feed());
  const duplicate = spanFromFeed(
    feed({
      changeId: "change",
      commitOid: "c".repeat(40),
      committedAt: "2026-10-12T12:30:00.000Z",
    }),
  );
  const spans = mergeSpans([loaded, amended], [live, duplicate]);
  expect(spans.map((span) => span.commitOid)).toEqual(["c".repeat(40), "b".repeat(40)]);
  // The loaded version wins over the feed's record of the same commit.
  expect(spans[0]!.partial).toBe(false);
  expect(spans[1]!.partial).toBe(true);
  expect(spans[1]!.health).toBe("pass");
});

test("lanes are by author, the most recently active first", () => {
  const spans = mergeSpans([spanFromStep("orbit/engine", step())], [spanFromFeed(feed())]);
  expect(lanesOf(spans).map((lane) => lane.author.name)).toEqual(["reviewer", "builder"]);
});

test("vitals add up the trace", () => {
  const spans = [
    spanFromStep(
      "orbit/engine",
      step({
        context: {
          why: "People want recent results.",
          steering: [{ text: "keep score as the tie-breaker", source: "hook" }],
          tests: [{ command: "vp test", exit: 1, summary: "1 failed", origin: "local" }],
        },
      }),
    ),
    spanFromFeed(feed()),
  ];
  const checkpoints = [
    { checkpoint: { createdAt: "2026-10-12T12:10:00.000Z" }, previews: [{ status: "active" }] },
  ] as unknown as CheckpointView[];
  expect(vitalsOf(spans, checkpoints)).toEqual({
    steps: 2,
    checks: { passed: 3, failed: 1 },
    steered: 1,
    // The feed's first line of why counts too.
    withIntent: 2,
    checkpoints: 1,
    previewLive: true,
    agents: 2,
  });
});

test("the domain runs from the first span or checkpoint to now while open, never zero wide", () => {
  const spans = [spanFromStep("orbit/engine", step())];
  const at = Date.parse("2026-10-12T12:00:00.000Z");
  const [from, to] = domainOf(spans, [], null);
  expect(from).toBeLessThan(at);
  expect(to).toBeGreaterThan(at);
  const open = domainOf(spans, [], at + 3_600_000);
  expect(open[1]).toBeGreaterThanOrEqual(at + 3_600_000);
});

test("ticks fall on round times, a handful at most", () => {
  const from = Date.parse("2026-10-12T12:07:00.000Z");
  const ticks = ticksOf([from, from + 3 * 3_600_000]);
  expect(ticks.length).toBeGreaterThan(1);
  expect(ticks.length).toBeLessThanOrEqual(6);
  for (const tick of ticks) expect(new Date(tick).getMinutes() % 30).toBe(0);
});

test("CI jobs are compared by duration, not laid end to end", () => {
  expect(
    jobBars([
      { name: "a", status: "succeeded", exitCode: 0, durationMs: 1000 },
      { name: "b", status: "failed", exitCode: 1, durationMs: 4000 },
      { name: "c", status: "skipped", exitCode: null, durationMs: null },
    ]).map(({ ms, share }) => [ms, share]),
  ).toEqual([
    [1000, 0.25],
    [4000, 1],
    [0, 0],
  ]);
});

test("long traces keep to a handful of ticks, and multi-day ones say the day with the time", () => {
  const from = Date.parse("2026-01-01T00:00:00.000Z");
  for (const days of [2, 5, 40, 120, 365]) {
    const domain: [number, number] = [from, from + days * 86_400_000];
    const ticks = ticksOf(domain);
    expect(ticks.length, `${days} days`).toBeLessThanOrEqual(6);
    expect(ticks.length, `${days} days`).toBeGreaterThan(1);
    const labels = ticks.map((tick) => tickLabel(tick, domain));
    expect(new Set(labels).size, `${days} days: ${labels.join(" | ")}`).toBe(labels.length);
  }
});
