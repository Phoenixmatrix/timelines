// Who finished an issue (CORE-220): stamped as it becomes done, shared by every
// timeline view, kept by landing, cleared on reopen, and recovered from history
// for issues finished before the stamp existed.

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { Issue, Mutation, Snapshot, TrackerAgent } from "../../shared/tracker.ts";
import { durableStorage } from "../testing/durable.ts";
import { Tracker, type TrackerReply } from "./object.ts";
import { TrackerStore, type Access } from "./store.ts";
import { backfillCompletions } from "./completions.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

// The tracker's clock is Date.now: fake it so each finish has its own time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});
const later = (days: number) => vi.setSystemTime(Date.now() + days * 86_400_000);

const oid = (n: number) => n.toString(16).padStart(40, "0");

function value<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

const bot: TrackerAgent = {
  id: "agt-bot",
  name: "bot",
  accountable: { id: "ann", slug: "ann", displayName: "Ann" },
  capabilities: null,
  capabilitiesUpdatedAt: null,
  revokedAt: null,
};

function setup() {
  const { sql, db, transactionSync } = durableStorage();
  const ctx = { storage: { sql, transactionSync } } as unknown as DurableObjectState;
  const tracker = new Tracker(ctx, {} as Env);
  const store = new TrackerStore(sql, transactionSync);
  const ann: Access = {
    actorId: "ann",
    principalId: "ann",
    agents: [bot],
    owner: { id: "org", slug: "org", displayName: "Org" },
    canAdmin: true,
    members: [{ id: "ann", slug: "ann", displayName: "Ann" }],
    repos: [],
  };
  const agent: Access = { ...ann, actorId: "agt-bot" };
  let operation = 0;
  const mutate = (as: Access, timeline: string | undefined, ...mutations: Mutation[]) =>
    value(
      tracker.mutate(as, {
        operationId: `op-${++operation}`,
        mutations,
        ...(timeline ? { timeline } : {}),
      }),
    );
  const fork = (slug: string) =>
    value(
      tracker.createTimeline(ann, {
        slug,
        parent: null,
        repos: [{ id: "app", owner: "org", name: "app" }],
        commits: { app: oid(1) },
      }),
    );
  let commit = 10;
  const merge = (from: string, into: string) =>
    value(
      tracker.recordTimelinePush({
        repo: { id: "app", owner: "org", name: "app" },
        actorId: "ann",
        accountableId: "ann",
        pushed: [into],
        merges: [{ into, from, commit: oid(++commit), parent: oid(++commit), refUpdateId: null }],
      }),
    );
  const view = (timeline?: string): Snapshot => value(tracker.snapshot(ann, timeline));
  const issue = (id: string, timeline?: string) =>
    view(timeline).issues.find((i) => i.id === id) as Issue;
  /** Claim and complete `id` as `as`, in a timeline or main. */
  const finish = (as: Access, id: string, timeline?: string, session = "laptop") => {
    const claimed = mutate(as, timeline, { kind: "issue.claim", id, data: { agent: session } })
      .results[0]!;
    mutate(as, timeline, {
      kind: "issue.complete",
      id,
      data: { leaseToken: claimed.leaseToken! },
    });
  };
  const status = (as: Access, id: string, to: string, timeline?: string) =>
    mutate(as, timeline, {
      kind: "issue.update",
      id,
      expectedVersion: issue(id, timeline).version,
      data: { status: to, ...(to === "canceled" ? { closeReason: "obsolete" } : {}) },
    } as Mutation);
  mutate(
    ann,
    undefined,
    { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } },
    { kind: "issue.create", id: "a", data: { teamId: "team", title: "A" } },
    { kind: "issue.create", id: "b", data: { teamId: "team", title: "B" } },
  );
  const end = (id: string) =>
    db
      .prepare(`UPDATE timelines SET data = json_set(data, '$.status', 'landed') WHERE id = ?`)
      .run(id);
  return {
    tracker,
    store,
    sql,
    db,
    transactionSync,
    ann,
    agent,
    mutate,
    fork,
    merge,
    view,
    issue,
    finish,
    status,
    end,
  };
}

describe("issue completion credit", () => {
  test("an agent's completion credits it, its session and its person", () => {
    const t = setup();
    expect(t.issue("a").completion).toBeUndefined();
    t.finish(t.agent, "a");
    expect(t.issue("a").completion).toEqual({
      actorId: "agt-bot",
      accountableId: "ann",
      agent: "laptop",
      at: expect.any(String),
    });
  });

  test("a person's completion names no accountable person or session", () => {
    const t = setup();
    t.finish(t.ann, "a");
    expect(t.issue("a").completion).toEqual({
      actorId: "ann",
      accountableId: null,
      agent: null,
      at: expect.any(String),
    });
    // Done without a claim: whoever set the status.
    t.status(t.ann, "b", "done");
    expect(t.issue("b").completion).toMatchObject({ actorId: "ann", accountableId: null });
  });

  test("an agent setting done without a claim is credited to it and its person", () => {
    const t = setup();
    t.status(t.agent, "a", "done");
    expect(t.issue("a").completion).toMatchObject({
      actorId: "agt-bot",
      accountableId: "ann",
      agent: null,
    });
  });

  test("reopening or canceling clears the credit; edits while done keep it", () => {
    const t = setup();
    t.finish(t.agent, "a");
    const credit = t.issue("a").completion;
    t.mutate(t.ann, undefined, {
      kind: "issue.update",
      id: "a",
      expectedVersion: t.issue("a").version,
      data: { title: "A, renamed" },
    });
    expect(t.issue("a").completion).toEqual(credit);
    t.status(t.ann, "a", "todo");
    expect(t.issue("a").completion).toBeNull();
    t.status(t.ann, "b", "done");
    t.status(t.ann, "b", "canceled");
    expect(t.issue("b").completion).toBeNull();
  });

  test("clients can't write it", () => {
    const t = setup();
    expect(() =>
      t.mutate(t.ann, undefined, {
        kind: "issue.update",
        id: "a",
        expectedVersion: 1,
        data: { completion: { actorId: "x", accountableId: "ann", agent: null, at: "" } },
      } as unknown as Mutation),
    ).toThrow("Unknown field: completion.");
  });

  test("finished in a timeline: main credits the holder, and landing keeps it", () => {
    const t = setup();
    const search = t.fork("search");
    t.finish(t.agent, "a", "search");
    const credit = t.issue("a").completion;
    expect(t.issue("a")).toMatchObject({
      status: "done_in_timeline",
      completion: { actorId: "agt-bot", accountableId: "ann", agent: "laptop" },
    });
    expect(t.issue("a", "search").completion).toEqual(credit);
    // Ann lands it: the agent that did the work keeps the credit.
    t.store.landTimeline(t.ann, "search");
    t.end(search.id);
    expect(t.issue("a")).toMatchObject({ status: "done", completion: credit });
  });

  test("an issue only a timeline had is credited when it lands", () => {
    const t = setup();
    const ui = t.fork("ui");
    t.mutate(t.ann, "ui", { kind: "issue.create", id: "c", data: { teamId: "team", title: "C" } });
    t.finish(t.agent, "c", "ui");
    expect(t.issue("c", "ui").completion).toMatchObject({ actorId: "agt-bot" });
    t.store.landTimeline(t.ann, "ui");
    t.end(ui.id);
    expect(t.issue("c")).toMatchObject({
      status: "done",
      completion: { actorId: "agt-bot", accountableId: "ann" },
    });
  });

  test("abandoning the timeline it was done in clears the credit", () => {
    const t = setup();
    t.fork("search");
    t.finish(t.agent, "a", "search");
    value(t.tracker.abandonTimeline(t.ann, "search", {}));
    expect(t.issue("a")).toMatchObject({ status: "todo", completion: null });
  });

  test("finished again in a timeline: main keeps its credit until the timeline lands", () => {
    const t = setup();
    t.status(t.ann, "a", "done");
    const old = t.issue("a").completion!;
    expect(old).toMatchObject({ actorId: "ann", accountableId: null });
    const fix = t.fork("fix");
    later(30);
    t.status(t.ann, "a", "todo", "fix");
    t.finish(t.agent, "a", "fix");
    const credit = {
      actorId: "agt-bot",
      accountableId: "ann",
      agent: "laptop",
      at: new Date(Date.now()).toISOString(),
    };
    // The timeline credits its finish; main, still done from before, keeps Ann's.
    expect(t.issue("a", "fix")).toMatchObject({ status: "done", completion: credit });
    expect(t.issue("a")).toMatchObject({ status: "done", completion: old });
    later(1);
    t.store.landTimeline(t.ann, "fix");
    t.end(fix.id);
    expect(t.issue("a")).toMatchObject({
      status: "done",
      completion: credit,
      doneIn: null,
      claim: null,
    });
    expect(credit.at > old.at).toBe(true);
  });

  const leases = (t: ReturnType<typeof setup>) =>
    (t.db.prepare(`SELECT count(*) AS n FROM leases WHERE issue_id = 'a'`).get() as { n: number })
      .n;
  /** Ann finishes `a` on main (or cancels it); the agent finishes it again in `fix`. */
  const refinished = (t: ReturnType<typeof setup>, mainStatus = "done") => {
    t.status(t.ann, "a", mainStatus);
    const old = t.issue("a").completion ?? null;
    const fix = t.fork("fix");
    later(1);
    t.status(t.ann, "a", "todo", "fix");
    t.finish(t.agent, "a", "fix");
    expect(t.issue("a", "fix")).toMatchObject({
      status: "done",
      completion: { actorId: "agt-bot" },
    });
    return { old, fix };
  };

  describe("abandoning a timeline that finished again what main had finished (CORE-375)", () => {
    test.each(["done", "canceled"])("main keeps its %s status and credit", (mainStatus) => {
      const t = setup();
      const { old, fix } = refinished(t, mainStatus);
      // As stored before the fix too: main names the timeline, which holds the lease.
      expect(t.issue("a")).toMatchObject({
        status: mainStatus,
        doneIn: { id: fix.id, slug: "fix" },
        claim: { retainedIn: { id: fix.id, slug: "fix" } },
      });
      expect(leases(t)).toBe(1);
      later(1);
      value(t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(t.issue("a")).toMatchObject({ status: mainStatus, doneIn: null, claim: null });
      // Ann's credit (none for a cancel) stays: the agent's was the timeline's.
      expect(t.issue("a").completion ?? null).toEqual(old);
      expect(leases(t)).toBe(0);
      // Not "ready again": it isn't.
      expect(t.view().comments.filter((c) => c.issueId === "a" && c.kind === "comment")).toEqual(
        [],
      );
      // The abandoned timeline still lists it as it finished it.
      expect(value(t.tracker.timeline("fix", 0, 10)).issues).toMatchObject([
        { id: "a", status: "done" },
      ]);
      // Abandoning again changes nothing.
      const version = t.issue("a").version;
      value(t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(t.issue("a").version).toBe(version);
    });

    test("merged into a timeline abandoned first, then abandoned itself", () => {
      const t = setup();
      const ui = t.fork("ui");
      const { old, fix } = refinished(t);
      t.merge("fix", "ui");
      expect(t.issue("a")).toMatchObject({
        status: "done",
        doneIn: { id: ui.id },
        claim: { retainedIn: { id: ui.id } },
      });
      // Still done in fix, which merged it: fix holds it again.
      value(t.tracker.abandonTimeline(t.ann, "ui", {}));
      expect(t.issue("a")).toMatchObject({
        status: "done",
        completion: old,
        doneIn: { id: fix.id, slug: "fix" },
        claim: { retainedIn: { id: fix.id, slug: "fix" } },
      });
      value(t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(t.issue("a")).toMatchObject({
        status: "done",
        completion: old,
        doneIn: null,
        claim: null,
      });
      expect(leases(t)).toBe(0);
    });

    test("merged into a timeline, abandoned before it", () => {
      const t = setup();
      const ui = t.fork("ui");
      const { old } = refinished(t);
      t.merge("fix", "ui");
      // ui has the work now: abandoning fix leaves it with ui.
      value(t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(t.issue("a")).toMatchObject({ status: "done", doneIn: { id: ui.id } });
      value(t.tracker.abandonTimeline(t.ann, "ui", {}));
      expect(t.issue("a")).toMatchObject({
        status: "done",
        completion: old,
        doneIn: null,
        claim: null,
      });
      expect(leases(t)).toBe(0);
    });

    test("reopened and claimed on main since: the live claim is main's", () => {
      const t = setup();
      refinished(t);
      // Main reopens it (dropping the lease fix kept, and since CORE-376 its
      // doneIn) and the agent takes it on.
      t.status(t.ann, "a", "todo");
      t.mutate(t.agent, undefined, { kind: "issue.claim", id: "a", data: { agent: "desk" } });
      expect(t.issue("a")).toMatchObject({
        status: "in_progress",
        doneIn: null,
        claim: { actorId: "agt-bot", agent: "desk" },
      });
      expect(t.issue("a").claim?.retainedIn).toBeUndefined();
      value(t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(t.issue("a")).toMatchObject({
        status: "in_progress",
        doneIn: null,
        claim: { actorId: "agt-bot", agent: "desk" },
      });
      expect(t.issue("a").completion ?? null).toBeNull();
      expect(leases(t)).toBe(1);
      expect(t.view().comments.filter((c) => c.issueId === "a" && c.kind === "comment")).toEqual(
        [],
      );
    });

    test("a claim the timeline didn't keep stays", () => {
      const t = setup();
      refinished(t);
      // No mutation leaves main done naming fix under a claim fix didn't keep
      // (claiming needs todo; any status change on main drops the claim), so
      // make that row directly: the guard must not release someone else's lease.
      t.db.exec(`UPDATE issues SET data = json_remove(data, '$.claim.retainedIn') WHERE id = 'a'`);
      const claim = t.issue("a").claim;
      expect(t.issue("a")).toMatchObject({ status: "done", doneIn: { slug: "fix" } });
      value(t.tracker.abandonTimeline(t.ann, "fix", {}));
      expect(t.issue("a")).toMatchObject({ status: "done", doneIn: null, claim });
      expect(leases(t)).toBe(1);
    });
  });

  describe("landing a timeline that finished again what main has moved since (CORE-376)", () => {
    const land = (t: ReturnType<typeof setup>, id: string) => {
      t.store.landTimeline(t.ann, "fix");
      t.end(id);
    };
    /** After fix finishes `a` again, Ann reopens it on main and the agent claims it there. */
    const reclaimed = (t: ReturnType<typeof setup>) => {
      const { fix } = refinished(t);
      t.status(t.ann, "a", "todo");
      const { leaseToken } = t.mutate(t.agent, undefined, {
        kind: "issue.claim",
        id: "a",
        data: { agent: "desk" },
      }).results[0]!;
      // Main's own move ends the timeline's finish on main.
      expect(t.issue("a")).toMatchObject({ status: "in_progress", doneIn: null });
      return { fix, leaseToken: leaseToken! };
    };

    test("main's reopen and live claim stand; the timeline's other edits land", () => {
      const t = setup();
      const { fix, leaseToken } = reclaimed(t);
      t.mutate(t.ann, "fix", {
        kind: "issue.update",
        id: "a",
        expectedVersion: t.issue("a", "fix").version,
        data: { title: "A, fixed" },
      });
      const claim = t.issue("a").claim;
      land(t, fix.id);
      expect(t.issue("a")).toMatchObject({
        status: "in_progress",
        title: "A, fixed",
        doneIn: null,
        claim,
      });
      expect(t.issue("a").completion ?? null).toBeNull();
      expect(leases(t)).toBe(1);
      // Landing again changes nothing.
      const version = t.issue("a").version;
      t.store.landTimeline(t.ann, "fix");
      expect(t.issue("a").version).toBe(version);
      // The holder finishes it on main, and is credited.
      t.mutate(t.agent, undefined, { kind: "issue.complete", id: "a", data: { leaseToken } });
      expect(t.issue("a")).toMatchObject({
        status: "done",
        completion: { actorId: "agt-bot", agent: "desk" },
      });
    });

    test("a cancel on main since stands", () => {
      const t = setup();
      const { fix } = refinished(t);
      t.status(t.ann, "a", "canceled");
      expect(t.issue("a")).toMatchObject({ status: "canceled", doneIn: null });
      land(t, fix.id);
      expect(t.issue("a")).toMatchObject({
        status: "canceled",
        closeReason: "obsolete",
        doneIn: null,
      });
      expect(t.issue("a").completion ?? null).toBeNull();
    });

    test("a row reopened on main before main's moves cleared doneIn keeps main's status", () => {
      const t = setup();
      const { fix } = reclaimed(t);
      // As stored before CORE-376: open on main, still naming the timeline.
      t.db
        .prepare(`UPDATE issues SET data = json_set(data, '$.doneIn', json(?)) WHERE id = 'a'`)
        .run(JSON.stringify({ id: fix.id, slug: "fix" }));
      const claim = t.issue("a").claim;
      land(t, fix.id);
      expect(t.issue("a")).toMatchObject({ status: "in_progress", doneIn: null, claim });
      expect(leases(t)).toBe(1);
    });

    test("main's cancel from before the timeline finished it gives way", () => {
      const t = setup();
      const { fix } = refinished(t, "canceled");
      land(t, fix.id);
      expect(t.issue("a")).toMatchObject({
        status: "done",
        completion: { actorId: "agt-bot" },
        doneIn: null,
        claim: null,
      });
    });
  });

  test("a person finishing again in a timeline what an agent had done takes the credit on landing", () => {
    const t = setup();
    t.finish(t.agent, "a");
    const old = t.issue("a").completion!;
    expect(old).toMatchObject({ actorId: "agt-bot", accountableId: "ann" });
    const fix = t.fork("fix");
    later(2);
    t.status(t.ann, "a", "todo", "fix");
    t.status(t.ann, "a", "done", "fix");
    expect(t.issue("a").completion).toEqual(old);
    t.store.landTimeline(t.ann, "fix");
    t.end(fix.id);
    expect(t.issue("a").completion).toEqual({
      actorId: "ann",
      accountableId: null,
      agent: null,
      at: new Date(Date.now()).toISOString(),
    });
  });

  test("merging the timeline it was finished in into another keeps the credit", () => {
    const t = setup();
    const ui = t.fork("ui");
    t.fork("search");
    t.finish(t.agent, "a", "search");
    const credit = t.issue("a").completion;
    expect(credit).toMatchObject({ actorId: "agt-bot" });
    later(1);
    t.merge("search", "ui");
    expect(t.issue("a")).toMatchObject({
      status: "done_in_timeline",
      doneIn: { slug: "ui" },
      completion: credit,
    });
    expect(t.issue("a", "ui")).toMatchObject({ status: "done", completion: credit });
    t.store.landTimeline(t.ann, "ui");
    t.end(ui.id);
    expect(t.issue("a")).toMatchObject({ status: "done", completion: credit });
  });

  test("reopening in a timeline keeps main's credit until that timeline lands", () => {
    const t = setup();
    t.finish(t.agent, "a");
    const credit = t.issue("a").completion;
    const fix = t.fork("fix");
    t.status(t.ann, "a", "todo", "fix");
    expect(t.issue("a")).toMatchObject({ status: "done", completion: credit });
    t.store.landTimeline(t.ann, "fix");
    t.end(fix.id);
    expect(t.issue("a")).toMatchObject({ status: "todo", completion: null });
  });
});

describe("crediting issues finished before the stamp", () => {
  /** Forget completions as if they predate CORE-220, and the migration with them. */
  const forget = (t: ReturnType<typeof setup>) => {
    t.db.exec(`UPDATE issues SET data = json_remove(data, '$.completion')`);
    t.db.exec(`DELETE FROM tracker_migrations WHERE name = 'completion-v1'`);
  };

  test("recovers the latest finish from history, once", () => {
    const t = setup();
    t.mutate(t.ann, undefined, {
      kind: "issue.create",
      id: "c",
      data: { teamId: "team", title: "C" },
    });
    t.finish(t.agent, "a");
    // Finished, reopened, then finished again by a person: the latest counts.
    t.finish(t.agent, "b");
    t.status(t.ann, "b", "todo");
    t.status(t.ann, "b", "done");
    t.fork("search");
    t.finish(t.agent, "c", "search");
    const expected = Object.fromEntries(["a", "b", "c"].map((id) => [id, t.issue(id).completion]));
    forget(t);
    expect(t.issue("a").completion).toBeUndefined();

    expect(backfillCompletions(t.sql, t.transactionSync)).toBe(3);
    for (const id of ["a", "b", "c"]) expect(t.issue(id).completion).toEqual(expected[id]);
    expect(t.issue("b").completion).toMatchObject({ actorId: "ann", accountableId: null });
    expect(t.issue("c").completion).toMatchObject({ actorId: "agt-bot", agent: "laptop" });
    // Done once: it never runs again, and changes nothing if it did.
    const rows = t.db.prepare(`SELECT data FROM issues ORDER BY id`).all();
    expect(backfillCompletions(t.sql, t.transactionSync)).toBe(0);
    t.db.exec(`DELETE FROM tracker_migrations WHERE name = 'completion-v1'`);
    expect(backfillCompletions(t.sql, t.transactionSync)).toBe(0);
    expect(t.db.prepare(`SELECT data FROM issues ORDER BY id`).all()).toEqual(rows);
  });

  test("an unreadable event leaves that issue uncredited, and the tracker still starts", () => {
    const t = setup();
    t.finish(t.agent, "a");
    t.finish(t.agent, "b");
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
    expect(t.issue("a").completion).toBeNull();
    expect(t.issue("b").completion).toMatchObject({ actorId: "agt-bot" });
    expect(backfillCompletions(t.sql, t.transactionSync)).toBe(0);
  });

  test("a start stops when its event budget is spent, and the next takes up the rest", () => {
    const t = setup();
    t.finish(t.agent, "a");
    t.finish(t.agent, "b");
    // b's finish lies behind 110 later edits: more than two pages of its history.
    const edits = (id: string, count: number) => {
      // A request takes at most 100 mutations.
      for (let done = 0; done < count; done += 50) {
        const version = t.issue(id).version;
        t.mutate(
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
    edits("b", 110);
    // a was touched last, so a start takes it first.
    later(1);
    edits("a", 1);
    forget(t);
    const credit = (id: string) => t.issue(id).completion;

    // a is cheap; b's scan runs past the budget, so it waits, untouched.
    expect(backfillCompletions(t.sql, t.transactionSync, { events: 60 })).toBe(1);
    expect(credit("a")).toMatchObject({ actorId: "agt-bot" });
    expect(credit("b")).toBeUndefined();
    // The next start begins with b, which may finish its own scan whatever the budget.
    expect(backfillCompletions(t.sql, t.transactionSync, { events: 60 })).toBe(1);
    expect(credit("b")).toMatchObject({ actorId: "agt-bot", accountableId: "ann" });
    // Nothing left: a short batch ends the migration.
    expect(backfillCompletions(t.sql, t.transactionSync, { events: 60 })).toBe(0);
    expect(
      t.db.prepare(`SELECT name FROM tracker_migrations WHERE name = 'completion-v1'`).all(),
    ).toHaveLength(1);
  });

  test("pruned history leaves an explicit unknown, and batches resume across starts", () => {
    const t = setup();
    t.finish(t.agent, "a");
    t.finish(t.agent, "b");
    forget(t);
    t.db.exec(`DELETE FROM events WHERE json_extract(data, '$.entityId') = 'a'`);
    expect(backfillCompletions(t.sql, t.transactionSync, { issues: 1 })).toBe(1);
    expect(backfillCompletions(t.sql, t.transactionSync, { issues: 1 })).toBe(1);
    expect(backfillCompletions(t.sql, t.transactionSync, { issues: 1 })).toBe(0);
    expect(t.issue("a").completion).toBeNull();
    expect(t.issue("b").completion).toMatchObject({ actorId: "agt-bot", accountableId: "ann" });
    // A new store over the same storage doesn't start again.
    new TrackerStore(t.sql, t.transactionSync);
    expect(t.issue("a").completion).toBeNull();
  });
});
