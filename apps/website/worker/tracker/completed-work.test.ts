// The agent work page's finished issues (CORE-220): one tracker's issues its
// person's agents finished, newest first, with their timeline and evidence.

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { Mutation } from "../../shared/tracker.ts";
import { completionTracker as setup } from "../testing/completion-tracker.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// The tracker's clock is Date.now: fake it so each finish has its own time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});
const later = (hours: number) => vi.setSystemTime(Date.now() + hours * 3_600_000);

describe("finished work for the agent work page", () => {
  test("ann's agents' work since a time, newest first, with timeline and evidence", async () => {
    const t = await setup();
    await t.mutate(
      t.ann,
      undefined,
      { kind: "issue.create", id: "c", data: { teamId: "team", title: "C" } },
      { kind: "issue.create", id: "d", data: { teamId: "team", title: "D" } },
    );
    await t.finish(t.agent, "a");
    later(1);
    const claimed = (
      await t.mutate(t.agent, undefined, {
        kind: "issue.claim",
        id: "b",
        data: { agent: "laptop" },
      })
    ).results[0]!;
    await t.mutate(t.agent, undefined, {
      kind: "issue.complete",
      id: "b",
      data: { leaseToken: claimed.leaseToken!, evidence: "\n  vp test passed (12 files)\nmore" },
    });
    // A person's own work, and work in a timeline, with evidence made there.
    later(1);
    await t.finish(t.ann, "c");
    const search = await t.fork("search");
    later(1);
    const held = (
      await t.mutate(t.agent, "search", {
        kind: "issue.claim",
        id: "d",
        data: { agent: "laptop" },
      })
    ).results[0]!;
    await t.mutate(t.agent, "search", {
      kind: "issue.complete",
      id: "d",
      data: { leaseToken: held.leaseToken!, evidence: "Indexed in the search timeline" },
    });
    // Plenty of talk afterwards, in the timeline and on main, doesn't hide it.
    for (const timeline of ["search", undefined])
      await t.mutate(
        t.ann,
        timeline,
        ...Array.from({ length: 25 }, (_, n): Mutation => ({
          kind: "comment.add",
          id: `chat-${timeline ?? "main"}-${n}`,
          data: { issueId: "d", body: `Note ${n}` },
        })),
      );

    const since = "2000-01-01T00:00:00.000Z";
    const all = t.store.completedWork({ since, accountableId: "ann", actorIds: null });
    expect(all.truncated).toBe(false);
    // Newest first.
    expect(all.items.map((item) => item.issue.key)).toEqual(["ENG-4", "ENG-2", "ENG-1"]);
    const byKey = Object.fromEntries(all.items.map((item) => [item.issue.key, item]));
    expect(byKey["ENG-2"]!.evidence).toBe("vp test passed (12 files)");
    expect(byKey["ENG-1"]!.evidence).toBeNull();
    expect(byKey["ENG-4"]).toMatchObject({
      issue: { status: "done_in_timeline" },
      timeline: { id: search.id, slug: "search" },
      completion: { actorId: "agt-bot", accountableId: "ann" },
      // Evidence made in the timeline, though its comments aren't main's yet.
      evidence: "Indexed in the search timeline",
    });
    expect(new Set(all.items.map((item) => item.completion.at)).size).toBe(3);

    expect(t.store.completedWork({ since, accountableId: "ben", actorIds: null }).items).toEqual(
      [],
    );
    expect(
      t.store.completedWork({ since, accountableId: "ann", actorIds: ["agt-other"] }).items,
    ).toEqual([]);
    expect(t.store.completedWork({ since, accountableId: "ann", actorIds: [] }).items).toEqual([]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(
      t.store.completedWork({ since: future, accountableId: "ann", actorIds: null }).items,
    ).toEqual([]);
    const limited = t.store.completedWork({ since, accountableId: "ann", actorIds: null }, 2);
    expect(limited).toMatchObject({ truncated: true });
    expect(limited.items).toHaveLength(2);
  });
});
