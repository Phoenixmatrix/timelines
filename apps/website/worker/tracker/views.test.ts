import { afterEach, describe, expect, test } from "vite-plus/test";
import type { Issue, Mutation, Snapshot } from "../../shared/tracker.ts";
import { freshTrackerStorage } from "../testing/tracker.ts";
import { durableStorage } from "../testing/durable.ts";
import { TrackerStore, type Access } from "./store.ts";
import { TimelineStore } from "./timelines.ts";

const oid = (n: number) => n.toString(16).padStart(40, "0");
const databases: { close(): void }[] = [];
afterEach(() => {
  for (const storage of databases) storage.close();
  databases.length = 0;
});

async function setup() {
  const storage = await freshTrackerStorage("org", [
    {
      accountId: "ann",
      role: "owner",
      grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
    },
  ]);
  databases.push(storage);
  const { sql, db, transactionSync, scope, space } = storage;
  let now = Date.parse("2026-10-03T00:00:00Z");
  const clock = () => (now += 1000);
  const store = new TrackerStore(sql, transactionSync, clock);
  const timelines = new TimelineStore(sql, transactionSync, clock);
  const access: Access = {
    actorId: "ann",
    principalId: "ann",
    agents: [],
    agentId: null,
    ...scope,
    authorizationVersion: space.authorizationVersion,
    space,
    canAdmin: true,
    members: [{ id: "ann", slug: "ann", displayName: "Ann" }],
    repos: [],
  };
  let operation = 0;
  const mutate = (timeline: string | undefined, ...mutations: Mutation[]) =>
    store.mutate(access, {
      ...scope,
      operationId: `op-${++operation}`,
      mutations,
      ...(timeline ? { timeline } : {}),
    });
  const fork = (slug: string, parent: string | null = null) =>
    timelines.create(access, {
      slug,
      parent,
      repos: [{ id: "app", space: "org", name: "app" }],
      commits: { app: oid(1) },
    });
  const issue = (snapshot: Snapshot, id: string) => snapshot.issues.find((i) => i.id === id);
  const view = (timeline?: string) => store.snapshot(access, timeline);
  const version = (id: string, timeline?: string) => issue(view(timeline), id)!.version;
  const update = (timeline: string | undefined, id: string, data: Record<string, unknown>) =>
    mutate(timeline, {
      kind: "issue.update",
      id,
      expectedVersion: version(id, timeline),
      data,
    });
  mutate(undefined, { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } });
  return { store, timelines, db, access, mutate, fork, issue, view, update };
}

describe("timeline views of the tracker", () => {
  test("landing a comment preserves its original agent rather than attributing it to the lander", async () => {
    const t = await setup();
    t.mutate(undefined, { kind: "issue.create", id: "a", data: { teamId: "team", title: "A" } });
    t.fork("search");
    const agent = {
      id: "agt-builder",
      name: "builder",
      accountable: t.access.members[0]!,
      capabilities: null,
      capabilitiesUpdatedAt: null,
      revokedAt: null,
    };
    t.store.mutate(
      { ...t.access, actorId: agent.id, agentId: agent.id, agents: [agent] },
      {
        contractVersion: 4 as const,
        spaceId: "org",
        migrationEpoch: 0,
        operationId: "agent-comment",
        timeline: "search",
        mutations: [{ kind: "comment.add", id: "note", data: { issueId: "a", body: "Built it" } }],
      },
    );
    const original = t.view("search").comments[0]!;
    expect(original.actor).toEqual({
      id: agent.id,
      name: agent.name,
      kind: "agent",
      accountable: agent.accountable,
    });
    const landed = t.store.landTimeline(t.access, "search");
    const event = landed.find((item) => item.entityType === "comment")!;
    expect(event.actor).toMatchObject({ id: "ann", kind: "person" });
    expect(event.entity).toEqual(original);
    expect(t.view().comments).toEqual([original]);
  });

  test("pickup stays global across old timeline views and cannot be loosened by an agent", async () => {
    const t = await setup();
    t.mutate(undefined, {
      kind: "issue.create",
      id: "work",
      data: { teamId: "team", title: "Work" },
    });
    t.fork("old-view");
    t.update(undefined, "work", { pickup: "not_ready" });
    expect(t.issue(t.view("old-view"), "work")?.pickup).toBe("not_ready");
    expect(() =>
      t.mutate("old-view", {
        kind: "issue.claim",
        id: "work",
        data: { agent: "person" },
      }),
    ).toThrow(/not ready/);
    t.update("old-view", "work", { pickup: "human_only" });
    expect(t.issue(t.view(), "work")?.pickup).toBe("human_only");
    t.access.actorId = "agt-worker";
    t.access.agentId = "agt-worker";
    expect(() => t.update("old-view", "work", { pickup: "anyone", status: "in_progress" })).toThrow(
      /Only a person/,
    );
    expect(() => t.update("old-view", "work", { status: "done" })).toThrow(/human only/);
    expect(t.issue(t.view(), "work")?.pickup).toBe("human_only");
  });

  test("pickup restrictions never invalidate retained timeline leases", async () => {
    const t = await setup();
    t.mutate(undefined, {
      kind: "issue.create",
      id: "work",
      data: { teamId: "team", title: "Work" },
    });
    t.fork("work-view");
    const token = t.mutate("work-view", {
      kind: "issue.claim",
      id: "work",
      data: { agent: "person" },
    }).results[0]!.leaseToken!;
    t.mutate("work-view", {
      kind: "issue.complete",
      id: "work",
      data: { leaseToken: token, evidence: "Finished" },
    });
    expect(() => t.update(undefined, "work", { pickup: "not_ready" })).toThrow(
      /Retained timeline claims/,
    );
    expect(t.issue(t.view(), "work")?.claim?.retainedIn?.slug).toBe("work-view");
    t.mutate("work-view", {
      kind: "issue.renew",
      id: "work",
      data: { leaseToken: token },
    });
    expect(t.issue(t.view("work-view"), "work")?.status).toBe("done");
  });
  test("shares timeline-only tag definitions with main and backfills timeline history", async () => {
    const t = await setup();
    t.fork("tags");
    t.fork("other");
    t.mutate("tags", {
      kind: "issue.create",
      id: "tagged",
      data: { teamId: "team", title: "Only here", labels: ["timeline-only"] },
    });
    t.update("tags", "tagged", { labels: [] });
    expect(t.view().issues).toEqual([]);
    expect(t.view().labels).toEqual(["timeline-only"]);
    expect(t.view("other").labels).toEqual(["timeline-only"]);
    t.db.exec("DROP TABLE tracker_labels; DELETE FROM tracker_migrations WHERE name = 'labels-v1'");
    const storage = durableStorage(t.db);
    const reopened = new TrackerStore(storage.sql, storage.transactionSync);
    expect(reopened.snapshot(t.access).labels).toEqual(["timeline-only"]);
    expect(reopened.snapshot(t.access, "tags").issues[0]!.labels).toEqual([]);
  });
  test("an issue made in a timeline is the timeline's, and absent from main", async () => {
    const t = await setup();
    const search = t.fork("search");
    const result = t.mutate("search", {
      kind: "issue.create",
      id: "a",
      data: { teamId: "team", title: "Index the docs" },
    });
    expect(result.events).toMatchObject([
      {
        entityType: "issue",
        entityId: "a",
        timelineId: search.id,
        before: null,
        entity: null,
        view: { before: null, entity: { id: "a", timelineId: search.id, title: "Index the docs" } },
      },
    ]);
    expect(t.issue(t.view(), "a")).toBeUndefined();
    expect(t.view("search")).toMatchObject({
      timeline: { id: search.id, slug: "search", status: "active" },
      issues: [{ id: "a", key: "ENG-1", timelineId: search.id }],
    });
    // Its id stays taken in every view, and main can't change it.
    expect(() =>
      t.mutate(undefined, { kind: "issue.create", id: "a", data: { teamId: "team", title: "x" } }),
    ).toThrow(/already exists/);
    expect(() =>
      t.mutate(undefined, {
        kind: "issue.update",
        id: "a",
        expectedVersion: 1,
        data: { title: "x" },
      }),
    ).toThrow(/not found/);
    // History finds it by key, as the timeline saw it.
    expect(t.store.history(t.access, "ENG-1", null, 10).events).toMatchObject([
      {
        kind: "issue.create",
        timelineId: search.id,
        before: null,
        entity: { title: "Index the docs" },
      },
    ]);
  });

  test("a timeline's changes stay in its view and its descendants'; shared fields are everyone's", async () => {
    const t = await setup();
    t.mutate(undefined, {
      kind: "issue.create",
      id: "a",
      data: { teamId: "team", title: "Ship search" },
    });
    t.fork("search");
    t.fork("ranking", "search");
    t.fork("other");
    t.update("search", "a", { status: "in_progress", labels: ["search"] });
    // Main's view is as before, but the version moved for everyone.
    expect(t.issue(t.view(), "a")).toMatchObject({ status: "todo", labels: [], version: 2 });
    expect(t.issue(t.view("search"), "a")).toMatchObject({
      status: "in_progress",
      labels: ["search"],
      version: 2,
    });
    expect(t.issue(t.view("ranking"), "a")).toMatchObject({ status: "in_progress" });
    expect(t.issue(t.view("other"), "a")).toMatchObject({ status: "todo", labels: [] });
    // Main's later changes show through where the timeline didn't change the field.
    t.update(undefined, "a", { title: "Ship search v2", status: "backlog" });
    expect(t.issue(t.view("search"), "a")).toMatchObject({
      title: "Ship search v2",
      status: "in_progress",
      version: 3,
    });
    expect(t.issue(t.view(), "a")).toMatchObject({ title: "Ship search v2", status: "backlog" });
  });

  test("links removed in a timeline stay on main, and readiness follows the view", async () => {
    const t = await setup();
    t.mutate(
      undefined,
      {
        kind: "issue.create",
        id: "a",
        data: { teamId: "team", title: "Blocker", status: "backlog" },
      },
      { kind: "issue.create", id: "b", data: { teamId: "team", title: "Blocked" } },
      { kind: "link.add", id: "l", data: { fromId: "a", toId: "b", kind: "blocks" } },
    );
    t.fork("search");
    t.update("search", "a", { status: "done" });
    // In the timeline the blocker is done, so the blocked issue is next; on main it isn't.
    const next = (timeline?: string) =>
      t.mutate(timeline, { kind: "issue.next", id: crypto.randomUUID(), data: { agent: "w" } })
        .results[0]!;
    expect(next().issueId).toBeUndefined();
    const picked = next("search");
    expect(picked).toMatchObject({ issueId: "b", key: "ENG-2" });
    // The lease is shared: main sees the claim, though the status change is the timeline's.
    expect(t.issue(t.view(), "b")).toMatchObject({ status: "todo", claim: { agent: "w" } });
    expect(t.issue(t.view("search"), "b")).toMatchObject({ status: "in_progress" });
    t.mutate("search", { kind: "link.remove", id: "l" });
    expect(t.view().links.map((l) => l.id)).toEqual(["l"]);
    expect(t.view("search").links).toEqual([]);
  });

  test("work on a timeline's own issue goes through claim, batch edits and completion", async () => {
    const t = await setup();
    t.fork("search");
    t.mutate("search", { kind: "issue.create", id: "a", data: { teamId: "team", title: "A" } });
    const claimed = t.mutate("search", {
      kind: "issue.next",
      id: "pick",
      data: { agent: "w" },
    }).results[0]!;
    expect(claimed.issueId).toBe("a");
    expect(t.issue(t.view("search"), "a")).toMatchObject({ status: "in_progress", version: 2 });
    t.mutate(
      "search",
      { kind: "issue.update", id: "a", expectedVersion: 2, data: { title: "A, renamed" } },
      { kind: "issue.update", id: "a", expectedVersion: 3, data: { labels: ["x"] } },
    );
    t.mutate("search", {
      kind: "issue.complete",
      id: "a",
      data: { leaseToken: claimed.leaseToken!, evidence: "done" },
    });
    expect(t.issue(t.view("search"), "a")).toMatchObject({
      title: "A, renamed",
      labels: ["x"],
      status: "done",
      // Its lease is retained until the timeline lands or is abandoned (CORE-75).
      claim: { agent: "w", retainedIn: { slug: "search" } },
    });
    expect(t.view("search").comments).toMatchObject([{ issueId: "a", kind: "evidence" }]);
    expect(t.issue(t.view(), "a")).toBeUndefined();
    expect(t.view().comments).toEqual([]);
  });

  test("ended and unknown timelines take no changes", async () => {
    const t = await setup();
    t.fork("search");
    t.timelines.abandon(t.access, "search", {});
    const create: Mutation = {
      kind: "issue.create",
      id: "a",
      data: { teamId: "team", title: "x" },
    };
    expect(() => t.mutate("search", create)).toThrow(/abandoned/);
    expect(() => t.mutate("missing", create)).toThrow(/No timeline missing/);
    expect(() => t.view("missing")).toThrow(/No timeline missing/);
    // Main by name is main.
    expect(t.mutate("main", create).events[0]).not.toHaveProperty("timelineId");
  });

  test("a timeline merged into another is part of its view", async () => {
    const t = await setup();
    t.mutate(undefined, { kind: "issue.create", id: "a", data: { teamId: "team", title: "A" } });
    t.fork("search");
    t.fork("ranking");
    t.update("ranking", "a", { priority: 0 });
    expect(t.issue(t.view("search"), "a")!.priority).toBe(2);
    t.timelines.recordPush({
      repo: { id: "app", spaceId: "org", space: "org", name: "app" },
      actorId: "ann",
      accountableId: "ann",
      pushed: ["search"],
      merges: [{ into: "search", from: "ranking", commit: oid(5), parent: oid(4), refUpdateId: 1 }],
    });
    expect(t.issue(t.view("search"), "a")!.priority).toBe(0);
    expect(t.issue(t.view(), "a")!.priority).toBe(2);
  });

  test("landing folds a timeline's changes into main, once", async () => {
    const t = await setup();
    t.mutate(undefined, { kind: "issue.create", id: "a", data: { teamId: "team", title: "A" } });
    const search = t.fork("search");
    t.fork("ranking", "search");
    t.update("search", "a", { status: "done" });
    t.mutate("search", { kind: "issue.create", id: "b", data: { teamId: "team", title: "B" } });
    t.mutate("search", { kind: "comment.add", id: "c", data: { issueId: "b", body: "note" } });
    t.update("ranking", "b", { priority: 1 });
    const events = t.store.landTimeline(t.access, "search");
    expect(events.map((e) => [e.kind, e.entityId, e.timelineId])).toEqual([
      ["timeline.land", "a", undefined],
      ["timeline.land", "b", undefined],
      ["timeline.land", "c", undefined],
    ]);
    t.db
      .prepare(`UPDATE timelines SET data = json_set(data, '$.status', 'landed') WHERE id = ?`)
      .run(search.id);
    const main = t.view();
    expect(t.issue(main, "a")).toMatchObject({ status: "done" });
    // A descendant's own changes are still its own.
    expect(t.issue(main, "b")).toMatchObject({ timelineId: search.id, priority: 2 });
    expect(main.comments.map((c) => c.id)).toEqual(["c"]);
    expect(t.issue(t.view("ranking"), "b")).toMatchObject({ status: "todo", priority: 1 });
    expect(t.issue(t.view("search"), "b")).toMatchObject({ priority: 2 });
    expect(t.store.landTimeline(t.access, "search")).toEqual([]);
  });

  test("main's view and its event log are unchanged for work outside timelines", async () => {
    const t = await setup();
    t.fork("search");
    const result = t.mutate(undefined, {
      kind: "issue.create",
      id: "a",
      data: { teamId: "team", title: "Main work" },
    });
    expect(result.events[0]).not.toHaveProperty("timelineId");
    expect(result.events[0]).not.toHaveProperty("view");
    expect(result.events[0]!.entity).not.toHaveProperty("timelineId");
    expect(t.view()).not.toHaveProperty("timeline");
    expect((t.issue(t.view("search"), "a") as Issue).title).toBe("Main work");
  });

  test("timelines reach the change feed and snapshot only for replicas that ask", async () => {
    const t = await setup();
    const search = t.fork("search");
    t.timelines.update("search", { name: "Search" }, undefined, t.access);
    t.mutate("search", { kind: "issue.create", id: "a", data: { teamId: "team", title: "A" } });
    const kinds = (withTimelines: boolean) =>
      t.store.changes(t.access, 0, 100, withTimelines).events.map((e) => [e.entityType, e.kind]);
    expect(kinds(false)).toEqual([
      ["team", "team.create"],
      ["issue", "issue.create"],
    ]);
    expect(kinds(true)).toEqual([
      ["team", "team.create"],
      ["timeline", "timeline.create"],
      ["timelineEvent", "fork"],
      ["timeline", "timeline.update"],
      ["issue", "issue.create"],
    ]);
    expect(t.store.changes(t.access, 0, 100, true).events[2]).toMatchObject({
      entityId: `fork:${search.id}`,
      actorId: "ann",
      entity: { kind: "fork", seq: 1, timelineId: search.id },
    });
    expect(t.view()).not.toHaveProperty("timelines");
    expect(t.store.snapshot(t.access, undefined, true)).toMatchObject({
      timelines: [{ id: search.id, name: "Search", version: 2 }],
      timelineEvents: [{ seq: 1, kind: "fork" }],
    });
  });
});
