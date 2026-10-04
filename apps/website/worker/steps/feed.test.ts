// A timeline's live feed (CORE-239): what it keeps and what a reader gets.

import { describe, expect, test, vi } from "vite-plus/test";
import type { StepFeedRecord } from "../../shared/steps.ts";
import { fakeDurableState } from "../testing/durable-state.ts";
import { FEED_KEEP, FEED_TTL_MS, StepFeed } from "./feed.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));

const record = (n: number): Omit<StepFeedRecord, "seq" | "at"> => ({
  repo: "orbit/app",
  timeline: "search",
  changeId: `change${String(n).padStart(4, "0")}`,
  commitOid: n.toString(16).padStart(40, "0"),
  summary: `Step ${n}`,
  issue: null,
  author: { id: "agt_1", kind: "agent", name: "builder" },
  tests: { passed: 1, failed: 0 },
  why: "Because.",
  committedAt: new Date().toISOString(),
});

/** Reads SSE events until `count` step events arrived. */
async function events(response: Response, count: number) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const steps: { id: number; data: StepFeedRecord }[] = [];
  while (steps.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    let end: number;
    while ((end = text.indexOf("\n\n")) >= 0) {
      const block = text.slice(0, end);
      text = text.slice(end + 2);
      const id = /^id: (\d+)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (id && data) steps.push({ id: Number(id), data: JSON.parse(data) as StepFeedRecord });
    }
  }
  await reader.cancel();
  return steps;
}

describe("the step feed", () => {
  test("a reader gets what's there after its last event, then each new step", async () => {
    const { ctx } = fakeDurableState();
    const feed = new StepFeed(ctx as never, {} as Env);
    for (let n = 1; n <= 3; n++) await feed.publish(record(n));
    const response = await feed.fetch(
      new Request("https://step-feed/subscribe", { headers: { "last-event-id": "1" } }),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reading = events(response, 3);
    // Delivered live once connected.
    await vi.waitFor(() => expect(feed.subscribers()).toBe(1));
    await feed.publish(record(4));
    const got = await reading;
    expect(got.map((e) => [e.id, e.data.summary])).toEqual([
      [2, "Step 2"],
      [3, "Step 3"],
      [4, "Step 4"],
    ]);
    expect(got[2]!.data).toMatchObject({
      seq: 4,
      repo: "orbit/app",
      tests: { passed: 1, failed: 0 },
    });
  });

  test("keeps the newest records for a week", async () => {
    const { ctx } = fakeDurableState();
    const feed = new StepFeed(ctx as never, {} as Env);
    for (let n = 1; n <= FEED_KEEP + 5; n++) await feed.publish(record(n));
    const kept = await feed.since(0);
    expect(kept).toHaveLength(FEED_KEEP);
    expect(kept[0]!.seq).toBe(6);
    expect(await ctx.storage.getAlarm()).not.toBeNull();
    // A week later the alarm expires them.
    vi.useFakeTimers({ now: Date.now() + FEED_TTL_MS + 1 });
    try {
      await feed.alarm();
      expect(await feed.since(0)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
