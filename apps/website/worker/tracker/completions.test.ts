// Who finished an issue (CORE-220): stamped as it becomes done, shared by every
// timeline view, kept by landing, cleared on reopen, and recovered from history
// for issues finished before the stamp existed.

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { Mutation } from "../../shared/tracker.ts";
import {
  completionTracker as setup,
  value,
  type CompletionTracker,
} from "../testing/completion-tracker.ts";
import { TrackerStore } from "./store.ts";
import { backfillCompletions } from "./completions.ts";

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
const later = (days: number) => vi.setSystemTime(Date.now() + days * 86_400_000);

describe("issue completion credit", () => {
  test("an agent's completion credits it, its session and its person", async () => {
    const t = await setup();
    expect((await t.issue("a")).completion).toBeUndefined();
    await t.finish(t.agent, "a");
    expect((await t.issue("a")).completion).toEqual({
      actorId: "agt-bot",
      accountableId: "ann",
      agent: "laptop",
      at: expect.any(String),
    });
  });

  test("a person's completion names no accountable person or session", async () => {
    const t = await setup();
    await t.finish(t.ann, "a");
    expect((await t.issue("a")).completion).toEqual({
      actorId: "ann",
      accountableId: null,
      agent: null,
      at: expect.any(String),
    });
    // Done without a claim: whoever set the status.
    await t.status(t.ann, "b", "done");
    expect((await t.issue("b")).completion).toMatchObject({ actorId: "ann", accountableId: null });
  });

  test("an agent setting done without a claim is credited to it and its person", async () => {
    const t = await setup();
    await t.status(t.agent, "a", "done");
    expect((await t.issue("a")).completion).toMatchObject({
      actorId: "agt-bot",
      accountableId: "ann",
      agent: null,
    });
  });

  test("reopening or canceling clears the credit; edits while done keep it", async () => {
    const t = await setup();
    await t.finish(t.agent, "a");
    const credit = (await t.issue("a")).completion;
    await t.mutate(t.ann, undefined, {
      kind: "issue.update",
      id: "a",
      expectedVersion: (await t.issue("a")).version,
      data: { title: "A, renamed" },
    });
    expect((await t.issue("a")).completion).toEqual(credit);
    await t.status(t.ann, "a", "todo");
    expect((await t.issue("a")).completion).toBeNull();
    await t.status(t.ann, "b", "done");
    await t.status(t.ann, "b", "canceled");
    expect((await t.issue("b")).completion).toBeNull();
  });

  test("clients can't write it", async () => {
    const t = await setup();
    await expect(
      t.mutate(t.ann, undefined, {
        kind: "issue.update",
        id: "a",
        expectedVersion: 1,
        data: { completion: { actorId: "x", accountableId: "ann", agent: null, at: "" } },
      } as unknown as Mutation),
    ).rejects.toThrow("Unknown field: completion.");
  });

  test("finished in a timeline: main credits the holder, and landing keeps it", async () => {
    const t = await setup();
    const search = await t.fork("search");
    await t.finish(t.agent, "a", "search");
    const credit = (await t.issue("a")).completion;
    expect(await t.issue("a")).toMatchObject({
      status: "done_in_timeline",
      completion: { actorId: "agt-bot", accountableId: "ann", agent: "laptop" },
    });
    expect((await t.issue("a", "search")).completion).toEqual(credit);
    // Ann lands it: the agent that did the work keeps the credit.
    t.store.landTimeline(t.ann, "search");
    t.end(search.id);
    expect(await t.issue("a")).toMatchObject({ status: "done", completion: credit });
  });

  test("an issue only a timeline had is credited when it lands", async () => {
    const t = await setup();
    const ui = await t.fork("ui");
    await t.mutate(t.ann, "ui", {
      kind: "issue.create",
      id: "c",
      data: { teamId: "team", title: "C" },
    });
    await t.finish(t.agent, "c", "ui");
    expect((await t.issue("c", "ui")).completion).toMatchObject({ actorId: "agt-bot" });
    t.store.landTimeline(t.ann, "ui");
    t.end(ui.id);
    expect(await t.issue("c")).toMatchObject({
      status: "done",
      completion: { actorId: "agt-bot", accountableId: "ann" },
    });
  });

  test("abandoning the timeline it was done in clears the credit", async () => {
    const t = await setup();
    await t.fork("search");
    await t.finish(t.agent, "a", "search");
    value(await t.tracker.abandonTimeline(t.ann, "search", {}));
    expect(await t.issue("a")).toMatchObject({ status: "todo", completion: null });
  });

  test("finished again in a timeline: main keeps its credit until the timeline lands", async () => {
    const t = await setup();
    await t.status(t.ann, "a", "done");
    const old = (await t.issue("a")).completion!;
    expect(old).toMatchObject({ actorId: "ann", accountableId: null });
    const fix = await t.fork("fix");
    later(30);
    await t.status(t.ann, "a", "todo", "fix");
    await t.finish(t.agent, "a", "fix");
    const credit = {
      actorId: "agt-bot",
      accountableId: "ann",
      agent: "laptop",
      at: new Date(Date.now()).toISOString(),
    };
    // The timeline credits its finish; main, still done from before, keeps Ann's.
    expect(await t.issue("a", "fix")).toMatchObject({ status: "done", completion: credit });
    expect(await t.issue("a")).toMatchObject({ status: "done", completion: old });
    later(1);
    t.store.landTimeline(t.ann, "fix");
    t.end(fix.id);
    expect(await t.issue("a")).toMatchObject({
      status: "done",
      completion: credit,
      doneIn: null,
      claim: null,
    });
    expect(credit.at > old.at).toBe(true);
  });

  const leases = (t: CompletionTracker) =>
    (t.db.prepare(`SELECT count(*) AS n FROM leases WHERE issue_id = 'a'`).get() as { n: number })
      .n;
  /** Ann finishes `a` on main (or cancels it); the agent finishes it again in `fix`. */
  const refinished = async (t: CompletionTracker, mainStatus = "done") => {
    await t.status(t.ann, "a", mainStatus);
    const old = (await t.issue("a")).completion ?? null;
    const fix = await t.fork("fix");
    later(1);
    await t.status(t.ann, "a", "todo", "fix");
    await t.finish(t.agent, "a", "fix");
    expect(await t.issue("a", "fix")).toMatchObject({
      status: "done",
      completion: { actorId: "agt-bot" },
    });
    return { old, fix };
  };

  describe("abandoning a timeline that finished again what main had finished (CORE-375)", () => {
    test.each(["done", "canceled"])("main keeps its %s status and credit", async (mainStatus) => {
      const t = await setup();
      const { old, fix } = await refinished(t, mainStatus);
      // As stored before the fix too: main names the timeline, which holds the lease.
      expect(await t.issue("a")).toMatchObject({
        status: mainStatus,
        doneIn: { id: fix.id, slug: "fix" },
        claim: { retainedIn: { id: fix.id, slug: "fix" } },
      });
      expect(leases(t)).toBe(1);
      later(1);
      value(await t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(await t.issue("a")).toMatchObject({ status: mainStatus, doneIn: null, claim: null });
      // Ann's credit (none for a cancel) stays: the agent's was the timeline's.
      expect((await t.issue("a")).completion ?? null).toEqual(old);
      expect(leases(t)).toBe(0);
      // Not "ready again": it isn't.
      expect(
        (await t.view()).comments.filter((c) => c.issueId === "a" && c.kind === "comment"),
      ).toEqual([]);
      // The abandoned timeline still lists it as it finished it.
      expect(value(await t.tracker.timeline(t.ann, "fix", 0, 10)).issues).toMatchObject([
        { id: "a", status: "done" },
      ]);
      // Abandoning again changes nothing.
      const version = (await t.issue("a")).version;
      value(await t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect((await t.issue("a")).version).toBe(version);
    });

    test("merged into a timeline abandoned first, then abandoned itself", async () => {
      const t = await setup();
      const ui = await t.fork("ui");
      const { old, fix } = await refinished(t);
      await t.merge("fix", "ui");
      expect(await t.issue("a")).toMatchObject({
        status: "done",
        doneIn: { id: ui.id },
        claim: { retainedIn: { id: ui.id } },
      });
      // Still done in fix, which merged it: fix holds it again.
      value(await t.tracker.abandonTimeline(t.ann, "ui", {}));
      expect(await t.issue("a")).toMatchObject({
        status: "done",
        completion: old,
        doneIn: { id: fix.id, slug: "fix" },
        claim: { retainedIn: { id: fix.id, slug: "fix" } },
      });
      value(await t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(await t.issue("a")).toMatchObject({
        status: "done",
        completion: old,
        doneIn: null,
        claim: null,
      });
      expect(leases(t)).toBe(0);
    });

    test("merged into a timeline, abandoned before it", async () => {
      const t = await setup();
      const ui = await t.fork("ui");
      const { old } = await refinished(t);
      await t.merge("fix", "ui");
      // ui has the work now: abandoning fix leaves it with ui.
      value(await t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(await t.issue("a")).toMatchObject({ status: "done", doneIn: { id: ui.id } });
      value(await t.tracker.abandonTimeline(t.ann, "ui", {}));
      expect(await t.issue("a")).toMatchObject({
        status: "done",
        completion: old,
        doneIn: null,
        claim: null,
      });
      expect(leases(t)).toBe(0);
    });

    test("reopened and claimed on main since: the live claim is main's", async () => {
      const t = await setup();
      await refinished(t);
      // Main reopens it (dropping the lease fix kept, and since CORE-376 its
      // doneIn) and the agent takes it on.
      await t.status(t.ann, "a", "todo");
      await t.mutate(t.agent, undefined, { kind: "issue.claim", id: "a", data: { agent: "desk" } });
      expect(await t.issue("a")).toMatchObject({
        status: "in_progress",
        doneIn: null,
        claim: { actorId: "agt-bot", agent: "desk" },
      });
      expect((await t.issue("a")).claim?.retainedIn).toBeUndefined();
      value(await t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(await t.issue("a")).toMatchObject({
        status: "in_progress",
        doneIn: null,
        claim: { actorId: "agt-bot", agent: "desk" },
      });
      expect((await t.issue("a")).completion ?? null).toBeNull();
      expect(leases(t)).toBe(1);
      expect(
        (await t.view()).comments.filter((c) => c.issueId === "a" && c.kind === "comment"),
      ).toEqual([]);
    });

    test("a claim the timeline didn't keep stays", async () => {
      const t = await setup();
      await refinished(t);
      // No mutation leaves main done naming fix under a claim fix didn't keep
      // (claiming needs todo; any status change on main drops the claim), so
      // make that row directly: the guard must not release someone else's lease.
      t.db.exec(`UPDATE issues SET data = json_remove(data, '$.claim.retainedIn') WHERE id = 'a'`);
      const claim = (await t.issue("a")).claim;
      expect(await t.issue("a")).toMatchObject({ status: "done", doneIn: { slug: "fix" } });
      value(await t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(await t.issue("a")).toMatchObject({ status: "done", doneIn: null, claim });
      expect(leases(t)).toBe(1);
    });
  });

  describe("landing a timeline that finished again what main has moved since (CORE-376)", () => {
    const land = async (t: CompletionTracker, id: string) => {
      t.store.landTimeline(t.ann, "fix");
      t.end(id);
    };
    /** After fix finishes `a` again, Ann reopens it on main and the agent claims it there. */
    const reclaimed = async (t: CompletionTracker) => {
      const { fix } = await refinished(t);
      await t.status(t.ann, "a", "todo");
      const { leaseToken } = (
        await t.mutate(t.agent, undefined, {
          kind: "issue.claim",
          id: "a",
          data: { agent: "desk" },
        })
      ).results[0]!;
      // Main's own move ends the timeline's finish on main.
      expect(await t.issue("a")).toMatchObject({ status: "in_progress", doneIn: null });
      return { fix, leaseToken: leaseToken! };
    };

    test("main's reopen and live claim stand; the timeline's other edits land", async () => {
      const t = await setup();
      const { fix, leaseToken } = await reclaimed(t);
      await t.mutate(t.ann, "fix", {
        kind: "issue.update",
        id: "a",
        expectedVersion: (await t.issue("a", "fix")).version,
        data: { title: "A, fixed" },
      });
      const claim = (await t.issue("a")).claim;
      await land(t, fix.id);
      expect(await t.issue("a")).toMatchObject({
        status: "in_progress",
        title: "A, fixed",
        doneIn: null,
        claim,
      });
      expect((await t.issue("a")).completion ?? null).toBeNull();
      expect(leases(t)).toBe(1);
      // Landing again changes nothing.
      const version = (await t.issue("a")).version;
      t.store.landTimeline(t.ann, "fix");
      expect((await t.issue("a")).version).toBe(version);
      // The holder finishes it on main, and is credited.
      await t.mutate(t.agent, undefined, { kind: "issue.complete", id: "a", data: { leaseToken } });
      expect(await t.issue("a")).toMatchObject({
        status: "done",
        completion: { actorId: "agt-bot", agent: "desk" },
      });
    });

    test("a cancel on main since stands", async () => {
      const t = await setup();
      const { fix } = await refinished(t);
      await t.status(t.ann, "a", "canceled");
      expect(await t.issue("a")).toMatchObject({ status: "canceled", doneIn: null });
      await land(t, fix.id);
      expect(await t.issue("a")).toMatchObject({
        status: "canceled",
        closeReason: "obsolete",
        doneIn: null,
      });
      expect((await t.issue("a")).completion ?? null).toBeNull();
    });

    test("a row reopened on main before main's moves cleared doneIn keeps main's status", async () => {
      const t = await setup();
      const { fix } = await reclaimed(t);
      // As stored before CORE-376: open on main, still naming the timeline.
      t.db
        .prepare(`UPDATE issues SET data = json_set(data, '$.doneIn', json(?)) WHERE id = 'a'`)
        .run(JSON.stringify({ id: fix.id, slug: "fix" }));
      const claim = (await t.issue("a")).claim;
      await land(t, fix.id);
      expect(await t.issue("a")).toMatchObject({ status: "in_progress", doneIn: null, claim });
      expect(leases(t)).toBe(1);
    });

    test("main's cancel from before the timeline finished it gives way", async () => {
      const t = await setup();
      const { fix } = await refinished(t, "canceled");
      await land(t, fix.id);
      expect(await t.issue("a")).toMatchObject({
        status: "done",
        completion: { actorId: "agt-bot" },
        doneIn: null,
        claim: null,
      });
    });
  });

  test("a person finishing again in a timeline what an agent had done takes the credit on landing", async () => {
    const t = await setup();
    await t.finish(t.agent, "a");
    const old = (await t.issue("a")).completion!;
    expect(old).toMatchObject({ actorId: "agt-bot", accountableId: "ann" });
    const fix = await t.fork("fix");
    later(2);
    await t.status(t.ann, "a", "todo", "fix");
    await t.status(t.ann, "a", "done", "fix");
    expect((await t.issue("a")).completion).toEqual(old);
    t.store.landTimeline(t.ann, "fix");
    t.end(fix.id);
    expect((await t.issue("a")).completion).toEqual({
      actorId: "ann",
      accountableId: null,
      agent: null,
      at: new Date(Date.now()).toISOString(),
    });
  });

  test("merging the timeline it was finished in into another keeps the credit", async () => {
    const t = await setup();
    const ui = await t.fork("ui");
    await t.fork("search");
    await t.finish(t.agent, "a", "search");
    const credit = (await t.issue("a")).completion;
    expect(credit).toMatchObject({ actorId: "agt-bot" });
    later(1);
    await t.merge("search", "ui");
    expect(await t.issue("a")).toMatchObject({
      status: "done_in_timeline",
      doneIn: { slug: "ui" },
      completion: credit,
    });
    expect(await t.issue("a", "ui")).toMatchObject({ status: "done", completion: credit });
    t.store.landTimeline(t.ann, "ui");
    t.end(ui.id);
    expect(await t.issue("a")).toMatchObject({ status: "done", completion: credit });
  });

  test("reopening in a timeline keeps main's credit until that timeline lands", async () => {
    const t = await setup();
    await t.finish(t.agent, "a");
    const credit = (await t.issue("a")).completion;
    const fix = await t.fork("fix");
    await t.status(t.ann, "a", "todo", "fix");
    expect(await t.issue("a")).toMatchObject({ status: "done", completion: credit });
    t.store.landTimeline(t.ann, "fix");
    t.end(fix.id);
    expect(await t.issue("a")).toMatchObject({ status: "todo", completion: null });
  });
});

describe("crediting issues finished before the stamp", () => {
  /** Forget completions as if they predate CORE-220, and the migration with them. */
  const forget = (t: CompletionTracker) => {
    t.db.exec(`UPDATE issues SET data = json_remove(data, '$.completion')`);
    t.db.exec(`DELETE FROM tracker_migrations WHERE name = 'completion-v1'`);
  };

  test("recovers the latest finish from history, once", async () => {
    const t = await setup();
    await t.mutate(t.ann, undefined, {
      kind: "issue.create",
      id: "c",
      data: { teamId: "team", title: "C" },
    });
    await t.finish(t.agent, "a");
    // Finished, reopened, then finished again by a person: the latest counts.
    await t.finish(t.agent, "b");
    await t.status(t.ann, "b", "todo");
    await t.status(t.ann, "b", "done");
    await t.fork("search");
    await t.finish(t.agent, "c", "search");
    const expected: Record<string, unknown> = {};
    for (const id of ["a", "b", "c"]) expected[id] = (await t.issue(id)).completion;
    forget(t);
    expect((await t.issue("a")).completion).toBeUndefined();

    expect(backfillCompletions(t.sql, t.transactionSync)).toBe(3);
    for (const id of ["a", "b", "c"]) expect((await t.issue(id)).completion).toEqual(expected[id]);
    expect((await t.issue("b")).completion).toMatchObject({ actorId: "ann", accountableId: null });
    expect((await t.issue("c")).completion).toMatchObject({ actorId: "agt-bot", agent: "laptop" });
    // Done once: it never runs again, and changes nothing if it did.
    const rows = t.db.prepare(`SELECT data FROM issues ORDER BY id`).all();
    expect(backfillCompletions(t.sql, t.transactionSync)).toBe(0);
    t.db.exec(`DELETE FROM tracker_migrations WHERE name = 'completion-v1'`);
    expect(backfillCompletions(t.sql, t.transactionSync)).toBe(0);
    expect(t.db.prepare(`SELECT data FROM issues ORDER BY id`).all()).toEqual(rows);
  });

  test("an unreadable event leaves that issue uncredited, and the tracker still starts", async () => {
    const t = await setup();
    await t.finish(t.agent, "a");
    await t.finish(t.agent, "b");
    forget(t);
    // SQLite reads this (JSON5); JavaScript's JSON.parse doesn't.
    t.db
      .prepare(`INSERT INTO events (data) VALUES (?)`)
      .run(`{"entityType":"issue","entityId":"a","kind":"issue.update",}`);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new TrackerStore(t.sql, t.transactionSync);
    expect(warn).toHaveBeenCalledWith(
      "completion backfill: issue a left uncredited",
      expect.any(SyntaxError),
    );
    warn.mockRestore();
    expect((await t.issue("a")).completion).toBeNull();
    expect((await t.issue("b")).completion).toMatchObject({ actorId: "agt-bot" });
    expect(backfillCompletions(t.sql, t.transactionSync)).toBe(0);
  });

  test("a start stops when its event budget is spent, and the next takes up the rest", async () => {
    const t = await setup();
    await t.finish(t.agent, "a");
    await t.finish(t.agent, "b");
    // b's finish lies behind 110 later edits: more than two pages of its history.
    const edits = async (id: string, count: number) => {
      // A request takes at most 100 mutations.
      for (let done = 0; done < count; done += 50) {
        const version = (await t.issue(id)).version;
        await t.mutate(
          t.ann,
          undefined,
          ...Array.from({ length: Math.min(50, count - done) }, (_, n): Mutation => ({
            kind: "issue.update",
            id,
            expectedVersion: version + n,
            data: { title: `${id} ${done + n}` },
          })),
        );
      }
    };
    later(1);
    await edits("b", 110);
    // a was touched last, so a start takes it first.
    later(1);
    await edits("a", 1);
    forget(t);
    const credit = async (id: string) => (await t.issue(id)).completion;

    // a is cheap; b's scan runs past the budget, so it waits, untouched.
    expect(backfillCompletions(t.sql, t.transactionSync, { events: 60 })).toBe(1);
    expect(await credit("a")).toMatchObject({ actorId: "agt-bot" });
    expect(await credit("b")).toBeUndefined();
    // The next start begins with b, which may finish its own scan whatever the budget.
    expect(backfillCompletions(t.sql, t.transactionSync, { events: 60 })).toBe(1);
    expect(await credit("b")).toMatchObject({ actorId: "agt-bot", accountableId: "ann" });
    // Nothing left: a short batch ends the migration.
    expect(backfillCompletions(t.sql, t.transactionSync, { events: 60 })).toBe(0);
    expect(
      t.db.prepare(`SELECT name FROM tracker_migrations WHERE name = 'completion-v1'`).all(),
    ).toHaveLength(1);
  });

  test("pruned history leaves an explicit unknown, and batches resume across starts", async () => {
    const t = await setup();
    await t.finish(t.agent, "a");
    await t.finish(t.agent, "b");
    forget(t);
    t.db.exec(`DELETE FROM events WHERE json_extract(data, '$.entityId') = 'a'`);
    expect(backfillCompletions(t.sql, t.transactionSync, { issues: 1 })).toBe(1);
    expect(backfillCompletions(t.sql, t.transactionSync, { issues: 1 })).toBe(1);
    expect(backfillCompletions(t.sql, t.transactionSync, { issues: 1 })).toBe(0);
    expect((await t.issue("a")).completion).toBeNull();
    expect((await t.issue("b")).completion).toMatchObject({
      actorId: "agt-bot",
      accountableId: "ann",
    });
    // A new store over the same storage doesn't start again.
    new TrackerStore(t.sql, t.transactionSync);
    expect((await t.issue("a")).completion).toBeNull();
  });
});
