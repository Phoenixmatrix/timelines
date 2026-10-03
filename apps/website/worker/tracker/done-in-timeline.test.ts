// "Done in a timeline" (CORE-74): an issue finished in a timeline is done
// there and in what merges it, done in that timeline everywhere else until it
// lands, and ready again on main if the timeline is abandoned.

import { describe, expect, test, vi } from "vite-plus/test";
import type { Issue, Mutation, Snapshot } from "../../shared/tracker.ts";
import { durableStorage } from "../testing/durable.ts";
import { Tracker, type TrackerReply } from "./object.ts";
import { TrackerStore, type Access } from "./store.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");

function value<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

function setup() {
  const { sql, db, transactionSync } = durableStorage();
  const ctx = { storage: { sql, transactionSync } } as unknown as DurableObjectState;
  const tracker = new Tracker(ctx, {} as Env);
  // The object's own store, over the same storage, for what it doesn't expose.
  const store = new TrackerStore(sql, transactionSync);
  const access: Access = {
    actorId: "ann",
    principalId: "ann",
    agents: [],
    owner: { id: "org", slug: "org", displayName: "Org" },
    canAdmin: true,
    members: [{ id: "ann", slug: "ann", displayName: "Ann" }],
    repos: [],
  };
  let operation = 0;
  const mutate = (timeline: string | undefined, ...mutations: Mutation[]) =>
    value(
      tracker.mutate(access, {
        operationId: `op-${++operation}`,
        mutations,
        ...(timeline ? { timeline } : {}),
      }),
    );
  const fork = (slug: string, parent: string | null = null) =>
    value(
      tracker.createTimeline(access, {
        slug,
        parent,
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
  const view = (timeline?: string): Snapshot => value(tracker.snapshot(access, timeline));
  const issue = (id: string, timeline?: string) =>
    view(timeline).issues.find((i) => i.id === id) as Issue;
  const next = (timeline?: string) =>
    mutate(timeline, { kind: "issue.next", id: crypto.randomUUID(), data: { agent: "w" } })
      .results[0]!;
  /** Claim and complete `id` in a timeline (or main). */
  const finish = (id: string, timeline?: string) => {
    const claimed = mutate(timeline, {
      kind: "issue.claim",
      id,
      data: { agent: "w" },
    }).results[0]!;
    return mutate(timeline, {
      kind: "issue.complete",
      id,
      data: { leaseToken: claimed.leaseToken!, evidence: "Shipped." },
    });
  };
  mutate(
    undefined,
    { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } },
    { kind: "issue.create", id: "a", data: { teamId: "team", title: "Index the docs" } },
    { kind: "issue.create", id: "b", data: { teamId: "team", title: "Search the docs" } },
    { kind: "link.add", id: "l", data: { fromId: "a", toId: "b", kind: "blocks" } },
  );
  const end = (id: string, status: "landed") =>
    db
      .prepare(`UPDATE timelines SET data = json_set(data, '$.status', ?) WHERE id = ?`)
      .run(status, id);
  return { tracker, store, access, mutate, fork, merge, view, issue, next, finish, end };
}

describe("done in a timeline", () => {
  test("is done in its timeline, and done there everywhere else: blocking, not ready", () => {
    const t = setup();
    const search = t.fork("search");
    t.fork("other");
    t.fork("stale");
    t.fork("ranking", "search");
    // A timeline that set its own status earlier doesn't make it ready there.
    t.mutate("stale", {
      kind: "issue.update",
      id: "a",
      expectedVersion: 1,
      data: { status: "backlog" },
    });
    const done = t.finish("a", "search");
    expect(done.events.at(-1)).toMatchObject({
      kind: "issue.complete",
      timelineId: search.id,
      entity: { status: "done_in_timeline", doneIn: { id: search.id, slug: "search" } },
      view: { entity: { status: "done", doneIn: { id: search.id, slug: "search" } } },
    });

    // Main: done in search, still blocking b, and nothing is ready.
    expect(t.issue("a")).toMatchObject({
      status: "done_in_timeline",
      doneIn: { id: search.id, slug: "search" },
      claim: null,
    });
    expect(t.next().issueId).toBeUndefined();
    expect(() =>
      t.mutate(undefined, { kind: "issue.claim", id: "a", data: { agent: "x" } }),
    ).toThrow(/done in timeline search/);
    // Timelines without that work see the same.
    for (const elsewhere of ["other", "stale"]) {
      expect(t.issue("a", elsewhere)).toMatchObject({ status: "done_in_timeline" });
      expect(t.next(elsewhere).issueId).toBeUndefined();
    }
    // Inside it, and in its descendants, it's done: b is next.
    expect(t.issue("a", "ranking")).toMatchObject({ status: "done" });
    expect(t.issue("a", "search")).toMatchObject({ status: "done", doneIn: { slug: "search" } });
    expect(t.next("search")).toMatchObject({ issueId: "b" });
  });

  test("the timeline lists its issues, and the issue names the timeline", () => {
    const t = setup();
    const search = t.fork("search");
    t.mutate("search", { kind: "issue.create", id: "c", data: { teamId: "team", title: "Own" } });
    t.finish("a", "search");
    const detail = value(t.tracker.timeline("search", 0, 10));
    expect(detail.issues).toEqual([
      {
        id: "a",
        key: "ENG-1",
        title: "Index the docs",
        status: "done_in_timeline",
        doneIn: { id: search.id, slug: "search" },
      },
      { id: "c", key: "ENG-3", title: "Own", status: "todo", doneIn: null },
    ]);
    expect(value(t.tracker.timelineGraph(100)).issues).toEqual({ [search.id]: detail.issues });
  });

  test("its status is locked wherever it shows; only a reopen in its timeline moves it", () => {
    const t = setup();
    t.fork("search");
    t.fork("other");
    t.finish("a", "search");
    const locked =
      /ENG-1 is done in timeline search; it lands with the timeline, or reopen it there with --timeline search/;
    const update = (timeline: string | undefined, data: Record<string, unknown>) =>
      t.mutate(timeline, {
        kind: "issue.update",
        id: "a",
        expectedVersion: t.issue("a", timeline).version,
        data,
      });
    // Not by people or agents, on main or where the timeline's work isn't.
    for (const where of [undefined, "other"])
      for (const status of ["todo", "done", "canceled", "backlog"])
        expect(() =>
          update(where, { status, ...(status === "canceled" ? { closeReason: "other" } : {}) }),
        ).toThrow(locked);
    expect(() =>
      t.mutate(undefined, { kind: "issue.claim", id: "a", data: { agent: "x" } }),
    ).toThrow(locked);
    expect(() => t.mutate("other", { kind: "issue.claim", id: "a", data: { agent: "x" } })).toThrow(
      locked,
    );
    // Nor picked for another issue.
    expect(() =>
      t.mutate(undefined, {
        kind: "issue.update",
        id: "b",
        expectedVersion: t.issue("b").version,
        data: { status: "done_in_timeline" },
      }),
    ).toThrow(/Invalid status/);
    // Other fields stay editable, and leaving the status as it is is fine.
    update(undefined, { status: "done_in_timeline", title: "Index all docs", labels: ["docs"] });
    expect(t.issue("a")).toMatchObject({
      title: "Index all docs",
      labels: ["docs"],
      status: "done_in_timeline",
      doneIn: { slug: "search" },
    });
    // Reopened in its timeline, it's main's to do again.
    update("search", { status: "todo" });
    expect(t.issue("a")).toMatchObject({ status: "todo", doneIn: null });
    expect(t.issue("a", "other")).toMatchObject({ status: "todo" });
  });

  test("an ended timeline's view stays readable, and refuses changes", () => {
    const t = setup();
    const search = t.fork("search");
    t.mutate("search", { kind: "issue.create", id: "c", data: { teamId: "team", title: "Own" } });
    t.finish("c", "search");
    t.finish("a", "search");
    value(t.tracker.abandonTimeline(t.access, "search", {}));
    // Main has a back to do; the abandoned timeline still shows what it did.
    expect(t.issue("a")).toMatchObject({ status: "todo", doneIn: null });
    const ended = t.view("search");
    expect(ended.timeline).toMatchObject({ slug: "search", status: "abandoned" });
    expect(t.issue("a", "search")).toMatchObject({ status: "done" });
    expect(t.issue("c", "search")).toMatchObject({ status: "done", title: "Own" });
    expect(t.issue("c")).toBeUndefined();
    expect(() =>
      t.mutate("search", { kind: "comment.add", id: "n", data: { issueId: "c", body: "x" } }),
    ).toThrow(/Timeline search is abandoned: its view is read-only/);
    // Its issues are listed with the status they had in it.
    expect(value(t.tracker.timeline("search", 0, 10)).issues).toEqual([
      { id: "a", key: "ENG-1", title: "Index the docs", status: "done", doneIn: null },
      { id: "c", key: "ENG-3", title: "Own", status: "done", doneIn: null },
    ]);
    expect(value(t.tracker.timelineGraph(100)).issues?.[search.id]).toHaveLength(2);

    // A landed timeline's view loads too, and is just as read-only.
    const ui = t.fork("ui");
    t.mutate("ui", { kind: "issue.create", id: "d", data: { teamId: "team", title: "D" } });
    t.store.landTimeline(t.access, "ui");
    t.end(ui.id, "landed");
    expect(t.view("ui").timeline).toMatchObject({ slug: "ui", status: "landed" });
    expect(t.issue("d", "ui")).toMatchObject({ title: "D" });
    expect(() =>
      t.mutate("ui", { kind: "comment.add", id: "m", data: { issueId: "d", body: "x" } }),
    ).toThrow(/Timeline ui is landed: its view is read-only/);
  });

  test("merging a timeline into another makes its finished issues done in that one", () => {
    const t = setup();
    const ui = t.fork("ui");
    t.fork("search");
    t.finish("a", "search");
    expect(t.next("ui").issueId).toBeUndefined();
    t.merge("search", "ui");
    expect(t.issue("a")).toMatchObject({ doneIn: { id: ui.id, slug: "ui" } });
    expect(t.issue("a", "ui")).toMatchObject({ status: "done" });
    expect(t.next("ui")).toMatchObject({ issueId: "b" });
    // Recording the same merge again changes nothing.
    const version = t.issue("a").version;
    t.merge("search", "ui");
    expect(t.issue("a").version).toBe(version);
  });

  test("landing makes them done, including what merged into the timeline", () => {
    const t = setup();
    t.mutate(undefined, { kind: "issue.create", id: "d", data: { teamId: "team", title: "D" } });
    t.fork("ui");
    t.fork("search");
    t.finish("a", "search");
    t.merge("search", "ui");
    t.finish("d", "ui");
    t.mutate("ui", { kind: "issue.create", id: "c", data: { teamId: "team", title: "Own" } });
    t.finish("c", "ui");
    const events = t.store.landTimeline(t.access, "ui");
    const landed = events.filter((e) => e.entityType === "issue").map((e) => e.entityId);
    expect(landed.sort()).toEqual(["a", "c", "d"]);
    for (const id of ["a", "c", "d"])
      expect(t.issue(id)).toMatchObject({ status: "done", doneIn: null });
    expect(events.find((e) => e.entityId === "a")!.before).toMatchObject({
      status: "done_in_timeline",
    });
    // b is unblocked on main now.
    expect(t.next()).toMatchObject({ issueId: "b" });
  });

  test("abandoning returns them to ready on main, with a note linking the timeline", () => {
    const t = setup();
    t.fork("search");
    t.finish("a", "search");
    const abandoned = value(t.tracker.abandonTimeline(t.access, "search", { app: null }));
    expect(abandoned.timeline.status).toBe("abandoned");
    expect(t.issue("a")).toMatchObject({ status: "todo", doneIn: null, claim: null });
    const notes = t.view().comments.filter((c) => c.issueId === "a" && c.kind === "comment");
    expect(notes).toMatchObject([
      {
        actorId: "ann",
        body: expect.stringContaining("](/tracker/org/timelines?tl=search)"),
      },
    ]);
    expect(t.next()).toMatchObject({ issueId: "a" });
    // Abandoning again (to retry bookmarks) changes nothing more.
    value(t.tracker.abandonTimeline(t.access, "search", { app: null }));
    expect(t.view().comments.filter((c) => c.kind === "comment")).toHaveLength(1);
  });

  test("abandoning a timeline something merged into leaves that work done where it was", () => {
    const t = setup();
    const search = t.fork("search");
    t.fork("ui");
    t.finish("a", "search");
    t.merge("search", "ui");
    value(t.tracker.abandonTimeline(t.access, "ui", {}));
    expect(t.issue("a")).toMatchObject({
      status: "done_in_timeline",
      doneIn: { id: search.id, slug: "search" },
    });
    expect(t.view().comments.find((c) => c.issueId === "a")?.body).toMatch(
      /still done in `search`/,
    );
  });
});
