import { describe, expect, onTestFinished, test } from "vite-plus/test";
import { freshTrackerStorage } from "../testing/tracker.ts";
import { TrackerStore, type Access } from "./store.ts";
import { TimelineStore, type NewTimeline } from "./timelines.ts";

const oid = (n: number) => n.toString(16).padStart(40, "0");

async function setup() {
  const { sql, transactionSync, close, scope, space } = await freshTrackerStorage();
  onTestFinished(close);
  let now = Date.parse("2026-10-03T00:00:00Z");
  // Its tables, the event log among them, come first, as in the Durable Object.
  new TrackerStore(sql, transactionSync);
  const store = new TimelineStore(sql, transactionSync, () => (now += 1000));
  const people = [
    { id: "ann", slug: "ann", displayName: "Ann" },
    { id: "ben", slug: "ben", displayName: "Ben" },
  ];
  const agents = ["bot", "helper"].map((name) => ({
    id: `agt_${name}`,
    name,
    accountable: people[1]!,
    capabilities: null,
    capabilitiesUpdatedAt: null,
    revokedAt: null,
  }));
  const as = (actorId: string, principalId = actorId): Access => ({
    actorId,
    principalId,
    agents,
    agentId: actorId === principalId ? null : actorId,
    ...scope,
    authorizationVersion: space.authorizationVersion,
    space,
    canAdmin: actorId === "ann",
    members: people,
    repos: [],
  });
  const fork = (access: Access, slug: string, parent: string | null = null) =>
    store.create(access, {
      slug,
      parent,
      repos: [{ id: "app", space: "org", name: "app" }],
      commits: { app: oid(1) },
    } satisfies NewTimeline);
  return { store, as, fork };
}

describe("timeline records", () => {
  test("a fork records who started it, who answers for it, and a fork event", async () => {
    const t = await setup();
    const bot = t.as("agt_bot", "ben");
    const created = t.fork(bot, "search");
    expect(created).toMatchObject({
      slug: "search",
      name: "search",
      policy: "approval",
      experimental: false,
      parentId: null,
      forkPoint: { commits: { app: oid(1) }, trackerCursor: 0 },
      repos: [{ id: "app", space: "org", name: "app", bookmark: "timeline/search" }],
      status: "active",
      accountableId: "ben",
      startedBy: "agt_bot",
      agentIds: ["agt_bot"],
      version: 1,
    });
    expect(t.store.list().map((tl) => tl.slug)).toEqual(["search"]);
    expect(t.store.detail("search", 0, 50).events).toMatchObject([
      { seq: 1, kind: "fork", timelineId: created.id, parentId: null, actorId: "agt_bot" },
    ]);
  });

  test("slugs are unique, never main, and a fork from a timeline is in both histories", async () => {
    const t = await setup();
    const ann = t.as("ann");
    const parent = t.fork(ann, "search");
    expect(() => t.fork(ann, "search")).toThrow(/already exists/);
    expect(() => t.fork(ann, "main")).toThrow(/names main/);
    expect(() => t.fork(ann, "Bad_Slug")).toThrow(/lowercase/);
    expect(() => t.fork(ann, "ranking", "missing")).toThrow(/No timeline missing/);
    const child = t.fork(ann, "ranking", "search");
    expect(child.parentId).toBe(parent.id);
    expect(t.store.detail("search", 0, 50).events.map((e) => [e.kind, e.timelineId])).toEqual([
      ["fork", parent.id],
      ["fork", child.id],
    ]);
    expect(t.store.detail("ranking", 0, 50).events).toHaveLength(1);
  });

  test("nobody forks from an ended timeline", async () => {
    const t = await setup();
    const ann = t.as("ann");
    t.fork(ann, "search");
    t.store.abandon(ann, "search", { app: oid(2) });
    expect(() => t.store.prepare("ranking", "search")).toThrow(/abandoned/);
  });

  test("any writer renames it or flags it experimental; slug and policy stay", async () => {
    const t = await setup();
    t.fork(t.as("ann"), "search");
    const updated = t.store.update("search", { experimental: true, name: "Search rewrite" });
    expect(updated).toMatchObject({ experimental: true, name: "Search rewrite", version: 2 });
    expect(() => t.store.update("search", { slug: "other" })).toThrow(/Unknown field/);
    expect(() => t.store.update("search", { experimental: "yes" })).toThrow(/true or false/);
    expect(() => t.store.update("search", { name: "x" }, 1)).toThrow(/changed since/);
  });
});

describe("abandoning", () => {
  test("only the accountable person, as themselves, or the agent that started it", async () => {
    const t = await setup();
    t.fork(t.as("agt_bot", "ben"), "search");
    for (const access of [t.as("ann"), t.as("agt_helper", "ben")])
      expect(() => t.store.abandon(access, "search", {})).toThrow(/accountable person/);
    expect(t.store.mayAbandon(t.as("ben"), "search").slug).toBe("search");
    const { timeline, abandoned } = t.store.abandon(t.as("agt_bot", "ben"), "search", {
      app: oid(5),
    });
    expect(abandoned).toBe(true);
    expect(timeline).toMatchObject({ status: "abandoned", version: 2 });
    expect(t.store.detail("search", 0, 50).events.at(-1)).toMatchObject({
      kind: "abandon",
      lastCommits: { app: oid(5) },
      actorId: "agt_bot",
      accountableId: "ben",
    });
  });

  test("abandoning again changes nothing, so bookmark deletion can be retried", async () => {
    const t = await setup();
    const ben = t.as("ben");
    t.fork(ben, "search");
    t.store.abandon(ben, "search", { app: oid(5) });
    const again = t.store.abandon(ben, "search", { app: null });
    expect(again.abandoned).toBe(false);
    expect(t.store.detail("search", 0, 50).events.filter((e) => e.kind === "abandon")).toHaveLength(
      1,
    );
  });
});

describe("pushes and merges", () => {
  const repo = { id: "app", spaceId: "org", space: "org", name: "app" };

  test("a push notes the agent, and a bookmark in another repository adds that repository", async () => {
    const t = await setup();
    t.fork(t.as("ben"), "search");
    t.store.recordPush({
      repo: { id: "lib", spaceId: "org", space: "org", name: "lib" },
      actorId: "agt_helper",
      accountableId: "ben",
      pushed: ["search", "someone-elses-branch"],
      merges: [],
    });
    const timeline = t.store.get("search");
    expect(timeline.agentIds).toEqual(["agt_helper"]);
    expect(timeline.pushedAt).not.toBeNull();
    expect(timeline.repos.map((r) => r.id)).toEqual(["app", "lib"]);
  });

  test("merges between timelines and with main are events in each side's history, once", async () => {
    const t = await setup();
    const ann = t.as("ann");
    const search = t.fork(ann, "search");
    const ranking = t.fork(ann, "ranking");
    const merges = [
      { into: "search", from: "ranking", commit: oid(10), parent: oid(9), refUpdateId: 4 },
      { into: "search", from: null, commit: oid(11), parent: oid(8), refUpdateId: 5 },
      { into: null, from: "search", commit: oid(12), parent: oid(11), refUpdateId: 6 },
      // Not timelines this tracker knows: ignored.
      { into: "nobody", from: null, commit: oid(13), parent: oid(8), refUpdateId: 7 },
      { into: null, from: "nobody", commit: oid(14), parent: oid(8), refUpdateId: 8 },
    ];
    const activity = { repo, actorId: "ann", accountableId: "ann", pushed: [], merges };
    expect(t.store.recordPush(activity)).toBe(3);
    expect(t.store.recordPush(activity)).toBe(0);
    const events = t.store.detail("search", 0, 50).events.filter((e) => e.kind === "merge");
    expect(events).toMatchObject([
      { timelineId: search.id, fromId: ranking.id, intoId: search.id, commit: oid(10) },
      { timelineId: search.id, fromId: null, intoId: search.id, parent: oid(8) },
      { timelineId: search.id, fromId: search.id, intoId: null, refUpdateId: 6 },
    ]);
    expect(t.store.detail("ranking", 0, 50).events.map((e) => e.kind)).toEqual(["fork", "merge"]);
  });

  test("an experimental timeline's work merges like any other's, into timelines and main", async () => {
    const t = await setup();
    const ann = t.as("ann");
    const search = t.fork(ann, "search");
    const ranking = t.store.create(ann, {
      slug: "ranking",
      parent: null,
      experimental: true,
      repos: [repo],
      commits: { app: oid(1) },
    });
    const merges = [
      { into: "search", from: "ranking", commit: oid(20), parent: oid(19), refUpdateId: 1 },
      { into: null, from: "ranking", commit: oid(21), parent: oid(19), refUpdateId: 2 },
    ];
    expect(
      t.store.recordPush({ repo, actorId: "ann", accountableId: "ann", pushed: [], merges }),
    ).toBe(2);
    expect(t.store.detail("ranking", 0, 50).events.map((e) => e.kind)).toEqual([
      "fork",
      "merge",
      "merge",
    ]);
    expect(t.store.detail("search", 0, 50).events.filter((e) => e.kind === "merge")).toMatchObject([
      { fromId: ranking.id, intoId: search.id, commit: oid(20) },
    ]);
    // The flag is a marker: merging neither clears it nor ends the timeline.
    expect(t.store.get("ranking")).toMatchObject({ experimental: true, status: "active" });
  });

  test("events page in order", async () => {
    const t = await setup();
    t.fork(t.as("ann"), "search");
    t.store.recordPush({
      repo,
      actorId: "ann",
      accountableId: "ann",
      pushed: [],
      merges: [1, 2, 3].map((n) => ({
        into: null,
        from: "search",
        commit: oid(n),
        parent: oid(100 + n),
        refUpdateId: n,
      })),
    });
    const first = t.store.detail("search", 0, 2);
    expect(first.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(first.next).toBe(2);
    const rest = t.store.detail("search", first.next!, 2);
    expect(rest.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(rest.next).toBeNull();
  });
});
