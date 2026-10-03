import { describe, expect, test } from "vite-plus/test";
import { isStalled, lastPush, type Timeline } from "./timelines.ts";

const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-10-20T00:00:00Z");
const timeline = (fields: Partial<Timeline>) =>
  ({
    status: "active",
    experimental: false,
    createdAt: "2026-10-01T00:00:00Z",
    pushedAt: null,
    ...fields,
  }) as Pick<Timeline, "status" | "experimental" | "pushedAt" | "createdAt">;

describe("stalled timelines", () => {
  test("open work without a push for the idle period has stalled", () => {
    const quiet = timeline({ pushedAt: new Date(now - 8 * DAY).toISOString() });
    expect(isStalled(quiet, now)).toBe(true);
    expect(isStalled(quiet, now, 10)).toBe(false);
    expect(isStalled(timeline({ pushedAt: new Date(now - DAY).toISOString() }), now)).toBe(false);
    // Never pushed: the fork is its last sign of work.
    expect(isStalled(timeline({}), now)).toBe(true);
    expect(lastPush(timeline({}))).toBe("2026-10-01T00:00:00Z");
  });

  test("experimental timelines never count: stalling is expected of them", () => {
    expect(isStalled(timeline({ experimental: true }), now)).toBe(false);
    expect(isStalled(timeline({ experimental: true, status: "idle" }), now)).toBe(false);
  });

  test("idle counts; waiting on a person, landing and ended timelines don't", () => {
    expect(
      isStalled(timeline({ status: "idle", pushedAt: new Date(now).toISOString() }), now),
    ).toBe(true);
    for (const status of ["waiting", "landing", "partly_landed", "landed", "abandoned"] as const)
      expect(isStalled(timeline({ status }), now)).toBe(false);
  });
});
