// "Done in a timeline" (CORE-74): an issue finished in a timeline is done
// there and in what merges it, done in that timeline everywhere else until it
// lands, and ready again on main if the timeline is abandoned.

import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { Issue, Mutation, Snapshot } from "../../shared/tracker.ts";
import { durableStorage } from "../testing/durable.ts";
import { Tracker, type TrackerReply } from "./object.ts";
import { TrackerStore, type Access } from "./store.ts";
import { d1 } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { initializeFreshTrackerSpace } from "./space-migration.ts";
import { accessFor } from "./access.ts";
import { findSpaceById } from "../spaces/access.ts";
import { fakeDurableObjectId } from "../testing/durable-state.ts";

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

const oid = (n: number) => n.toString(16).padStart(40, "0");

function value<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

async function setup() {
  const { sql, db, transactionSync } = durableStorage();
  const identity = fakeDurableObjectId("org");
  const ctx = { id: identity, storage: { sql, transactionSync } } as unknown as DurableObjectState;
  const fresh = await createFreshSpaceTestEnvironment();
  const business = fresh.sqlite;
  onTestFinished(fresh.close);
  onTestFinished(() => db.close());
  business.exec(`
    INSERT INTO accounts(id,kind,slug,display_name) VALUES('ann','user','ann','Ann');
    INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four)
      VALUES('ann-token','ann','fixture','write','fixture-token-hash','test');
  `);
  await seedSpaceFixture(d1(business), {
    organization: { id: "company", slug: "company", displayName: "Company", kind: "company" },
    space: { id: "org", slug: "org", displayName: "Org" },
    actorId: "ann",
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  business.exec(
    "INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES('app','org','app','private','app','https://provider/app')",
  );
  const env = { ...fresh.env, TRACKER: { idFromName: fakeDurableObjectId } } as unknown as Env;
  await initializeFreshTrackerSpace(env, ctx, "org");
  const tracker = new Tracker(ctx, env);
  // The object's own store, over the same storage, for what it doesn't expose.
  const store = new TrackerStore(sql, transactionSync);
  const space = await findSpaceById(env.DB, "org");
  if (!space) throw new Error("Missing seeded Space");
  const access: Access = await accessFor(env, space, "ann", null, true, {
    kind: "token",
    id: "ann-token",
  });
  let operation = 0;
  const mutate = async (timeline: string | undefined, ...mutations: Mutation[]) =>
    value(
      await tracker.mutate(access, {
        contractVersion: 4,
        spaceId: access.spaceId,
        migrationEpoch: access.migrationEpoch,
        operationId: `op-${++operation}`,
        mutations,
        ...(timeline ? { timeline } : {}),
      }),
    );
  const fork = async (slug: string, parent: string | null = null) =>
    value(
      await tracker.createTimeline(access, {
        slug,
        parent,
        repos: [{ id: "app", space: "org", name: "app" }],
        commits: { app: oid(1) },
      }),
    );
  let commit = 10;
  const merge = async (from: string, into: string) =>
    value(
      await tracker.recordTimelinePush({
        repo: { id: "app", spaceId: "org", space: "org", name: "app" },
        actorId: "ann",
        accountableId: "ann",
        pushed: [into],
        merges: [{ into, from, commit: oid(++commit), parent: oid(++commit), refUpdateId: null }],
      }),
    );
  const view = async (timeline?: string): Promise<Snapshot> =>
    value(await tracker.snapshot(access, timeline));
  const issue = async (id: string, timeline?: string) =>
    (await view(timeline)).issues.find((i) => i.id === id) as Issue;
  const next = async (timeline?: string) =>
    (await mutate(timeline, { kind: "issue.next", id: crypto.randomUUID(), data: { agent: "w" } }))
      .results[0]!;
  /** Claim and complete `id` in a timeline (or main). */
  const finish = async (id: string, timeline?: string) => {
    const claimed = (
      await mutate(timeline, {
        kind: "issue.claim",
        id,
        data: { agent: "w" },
      })
    ).results[0]!;
    return mutate(timeline, {
      kind: "issue.complete",
      id,
      data: { leaseToken: claimed.leaseToken!, evidence: "Shipped." },
    });
  };
  await mutate(
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
  return {
    tracker,
    store,
    access,
    mutate,
    fork,
    merge,
    view,
    issue,
    next,
    finish,
    end,
    business,
    cold: () => new Tracker(ctx, env),
  };
}

describe("current Tracker authority", () => {
  const request = (access: Access) => ({
    contractVersion: 4 as const,
    spaceId: access.spaceId,
    migrationEpoch: access.migrationEpoch,
    operationId: crypto.randomUUID(),
    mutations: [
      {
        kind: "issue.create" as const,
        id: "denied",
        data: { teamId: "team", title: "Must not commit" },
      },
    ],
  });
  test("Space-grant revocation denies stale Access on warm and cold reads and writes", async () => {
    const t = await setup();
    expect((await t.tracker.snapshot(t.access)).ok).toBe(true);
    t.business
      .prepare("DELETE FROM space_grants WHERE space_id=? AND account_id=?")
      .run("org", "ann");
    for (const tracker of [t.tracker, t.cold()]) {
      expect(await tracker.snapshot(t.access)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await tracker.mutate(t.access, request(t.access))).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    }
    expect(t.store.snapshot(t.access).issues.some((issue) => issue.id === "denied")).toBe(false);
  });
  test("revoked credentials cannot reuse previously authorized Access", async () => {
    const t = await setup();
    expect((await t.tracker.snapshot(t.access)).ok).toBe(true);
    t.business.prepare("DELETE FROM access_tokens WHERE id=?").run("ann-token");
    for (const tracker of [t.tracker, t.cold()]) {
      expect(await tracker.snapshot(t.access)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await tracker.mutate(t.access, request(t.access))).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    }
  });
  test("agent revocation invalidates its still-live token on the next dispatch", async () => {
    const t = await setup();
    t.business.exec(`
      INSERT INTO agents(id,name,accountable_id) VALUES('agt-bot','builder','ann');
      INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four,agent_id)
      VALUES('agent-token','ann','agent fixture','write','agent-fixture-hash','test','agt-bot');
    `);
    const agent: Access = {
      ...t.access,
      actorId: "agt-bot",
      agentId: "agt-bot",
      credential: { kind: "token", id: "agent-token" },
    };
    expect((await t.tracker.snapshot(agent)).ok).toBe(true);
    t.business
      .prepare("UPDATE agents SET revoked_at=? WHERE id=?")
      .run(new Date().toISOString(), "agt-bot");
    for (const tracker of [t.tracker, t.cold()]) {
      expect(await tracker.snapshot(agent)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await tracker.mutate(agent, request(agent))).toMatchObject({
        ok: false,
        code: "forbidden",
      });
    }
  });
  test("physical Space and migration epoch cannot be changed by caller metadata", async () => {
    const t = await setup();
    const wrongSpace = { ...t.access, spaceId: "other", space: { ...t.access.space, id: "other" } };
    const stale = { ...t.access, migrationEpoch: t.access.migrationEpoch + 1 };
    for (const tracker of [t.tracker, t.cold()]) {
      expect(await tracker.snapshot(wrongSpace)).toMatchObject({ ok: false, code: "forbidden" });
      expect(await tracker.mutate(wrongSpace, request(wrongSpace))).toMatchObject({
        ok: false,
        code: "forbidden",
      });
      expect(await tracker.snapshot(stale)).toMatchObject({
        ok: false,
        code: "migration_epoch_mismatch",
      });
      expect(await tracker.mutate(stale, request(stale))).toMatchObject({
        ok: false,
        code: "migration_epoch_mismatch",
      });
    }
  });
});

describe("done in a timeline", () => {
  test("omitted completion evidence retains timeline fencing without creating a note", async () => {
    const t = await setup();
    const timeline = await t.fork("optional-evidence");
    const claim = (
      await t.mutate(timeline.slug, {
        kind: "issue.claim",
        id: "a",
        data: { agent: "w" },
      })
    ).results[0]!;
    await t.mutate(timeline.slug, {
      kind: "issue.complete",
      id: "a",
      data: { leaseToken: claim.leaseToken! },
    });
    expect(await t.issue("a")).toMatchObject({
      status: "done_in_timeline",
      claim: { retainedIn: { id: timeline.id, slug: timeline.slug } },
    });
    expect((await t.issue("a", timeline.slug)).status).toBe("done");
    expect((await t.view(timeline.slug)).comments).toEqual([]);
    await expect(
      async () =>
        await t.mutate(undefined, {
          kind: "issue.update",
          id: "a",
          expectedVersion: (await t.issue("a")).version,
          data: { status: "todo" },
        }),
    ).rejects.toThrow();
    await t.mutate(timeline.slug, {
      kind: "issue.update",
      id: "a",
      expectedVersion: (await t.issue("a", timeline.slug)).version,
      data: { status: "todo" },
    });
    expect((await t.issue("a", timeline.slug)).status).toBe("todo");
    expect((await t.view(timeline.slug)).comments).toEqual([]);
  });

  test("is done in its timeline, and done there everywhere else: blocking, not ready", async () => {
    const t = await setup();
    const search = await t.fork("search");
    await t.fork("other");
    await t.fork("stale");
    await t.fork("ranking", "search");
    // A timeline that set its own status earlier doesn't make it ready there.
    await t.mutate("stale", {
      kind: "issue.update",
      id: "a",
      expectedVersion: 1,
      data: { status: "backlog" },
    });
    const done = await t.finish("a", "search");
    expect(done.events.at(-1)).toMatchObject({
      kind: "issue.complete",
      timelineId: search.id,
      entity: { status: "done_in_timeline", doneIn: { id: search.id, slug: "search" } },
      view: { entity: { status: "done", doneIn: { id: search.id, slug: "search" } } },
    });

    // Main: done in search, still blocking b, and nothing is ready.
    expect(await t.issue("a")).toMatchObject({
      status: "done_in_timeline",
      doneIn: { id: search.id, slug: "search" },
      claim: { agent: "w", retainedIn: { id: search.id, slug: "search" } },
    });
    expect((await t.next()).issueId).toBeUndefined();
    await expect(
      async () => await t.mutate(undefined, { kind: "issue.claim", id: "a", data: { agent: "x" } }),
    ).rejects.toThrow(/done in timeline search/);
    // Timelines without that work see the same.
    for (const elsewhere of ["other", "stale"]) {
      expect(await t.issue("a", elsewhere)).toMatchObject({ status: "done_in_timeline" });
      expect((await t.next(elsewhere)).issueId).toBeUndefined();
    }
    // Inside it, and in its descendants, it's done: b is next.
    expect(await t.issue("a", "ranking")).toMatchObject({ status: "done" });
    expect(await t.issue("a", "search")).toMatchObject({
      status: "done",
      doneIn: { slug: "search" },
    });
    expect(await t.next("search")).toMatchObject({ issueId: "b" });
  });

  test("the timeline lists its issues, and the issue names the timeline", async () => {
    const t = await setup();
    const search = await t.fork("search");
    await t.mutate("search", {
      kind: "issue.create",
      id: "c",
      data: { teamId: "team", title: "Own" },
    });
    await t.finish("a", "search");
    const detail = value(await t.tracker.timeline(t.access, "search", 0, 10));
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
    expect(value(await t.tracker.timelineGraph(t.access, 100)).issues).toEqual({
      [search.id]: detail.issues,
    });
  });

  test("its status is locked wherever it shows; only a reopen in its timeline moves it", async () => {
    const t = await setup();
    await t.fork("search");
    await t.fork("other");
    await t.finish("a", "search");
    const locked =
      /ENG-1 is done in timeline search; it lands with the timeline, or reopen it there with --timeline search/;
    const update = async (timeline: string | undefined, data: Record<string, unknown>) =>
      await t.mutate(timeline, {
        kind: "issue.update",
        id: "a",
        expectedVersion: (await t.issue("a", timeline)).version,
        data,
      });
    // Not by people or agents, on main or where the timeline's work isn't.
    for (const where of [undefined, "other"])
      for (const status of ["todo", "done", "canceled", "backlog"])
        await expect(async () =>
          update(where, { status, ...(status === "canceled" ? { closeReason: "other" } : {}) }),
        ).rejects.toThrow(locked);
    await expect(
      async () => await t.mutate(undefined, { kind: "issue.claim", id: "a", data: { agent: "x" } }),
    ).rejects.toThrow(locked);
    await expect(
      async () => await t.mutate("other", { kind: "issue.claim", id: "a", data: { agent: "x" } }),
    ).rejects.toThrow(locked);
    // Nor picked for another issue.
    await expect(
      async () =>
        await t.mutate(undefined, {
          kind: "issue.update",
          id: "b",
          expectedVersion: (await t.issue("b")).version,
          data: { status: "done_in_timeline" },
        }),
    ).rejects.toThrow(/Invalid status/);
    // Other fields stay editable, and leaving the status as it is is fine.
    await update(undefined, {
      status: "done_in_timeline",
      title: "Index all docs",
      labels: ["docs"],
    });
    expect(await t.issue("a")).toMatchObject({
      title: "Index all docs",
      labels: ["docs"],
      status: "done_in_timeline",
      doneIn: { slug: "search" },
    });
    // Reopened in its timeline, it's main's to do again.
    await update("search", { status: "todo" });
    expect(await t.issue("a")).toMatchObject({ status: "todo", doneIn: null });
    expect(await t.issue("a", "other")).toMatchObject({ status: "todo" });
  });

  test("an ended timeline's view stays readable, and refuses changes", async () => {
    const t = await setup();
    const search = await t.fork("search");
    await t.mutate("search", {
      kind: "issue.create",
      id: "c",
      data: { teamId: "team", title: "Own" },
    });
    await t.finish("c", "search");
    await t.finish("a", "search");
    value(await t.tracker.abandonTimeline(t.access, "search", {}));
    // Main has a back to do; the abandoned timeline still shows what it did.
    expect(await t.issue("a")).toMatchObject({ status: "todo", doneIn: null });
    const ended = await t.view("search");
    expect(ended.timeline).toMatchObject({ slug: "search", status: "abandoned" });
    expect(await t.issue("a", "search")).toMatchObject({ status: "done" });
    expect(await t.issue("c", "search")).toMatchObject({ status: "done", title: "Own" });
    expect(await t.issue("c")).toBeUndefined();
    await expect(
      async () =>
        await t.mutate("search", {
          kind: "comment.add",
          id: "n",
          data: { issueId: "c", body: "x" },
        }),
    ).rejects.toThrow(/Timeline search is abandoned: its view is read-only/);
    // Its issues are listed with the status they had in it.
    expect(value(await t.tracker.timeline(t.access, "search", 0, 10)).issues).toEqual([
      { id: "a", key: "ENG-1", title: "Index the docs", status: "done", doneIn: null },
      { id: "c", key: "ENG-3", title: "Own", status: "done", doneIn: null },
    ]);
    expect(value(await t.tracker.timelineGraph(t.access, 100)).issues?.[search.id]).toHaveLength(2);

    // A landed timeline's view loads too, and is just as read-only.
    const ui = await t.fork("ui");
    await t.mutate("ui", { kind: "issue.create", id: "d", data: { teamId: "team", title: "D" } });
    t.store.landTimeline(t.access, "ui");
    t.end(ui.id, "landed");
    expect((await t.view("ui")).timeline).toMatchObject({ slug: "ui", status: "landed" });
    expect(await t.issue("d", "ui")).toMatchObject({ title: "D" });
    await expect(
      async () =>
        await t.mutate("ui", { kind: "comment.add", id: "m", data: { issueId: "d", body: "x" } }),
    ).rejects.toThrow(/Timeline ui is landed: its view is read-only/);
  });

  test("merging a timeline into another makes its finished issues done in that one", async () => {
    const t = await setup();
    const ui = await t.fork("ui");
    await t.fork("search");
    await t.finish("a", "search");
    expect((await t.next("ui")).issueId).toBeUndefined();
    await t.merge("search", "ui");
    expect(await t.issue("a")).toMatchObject({ doneIn: { id: ui.id, slug: "ui" } });
    expect(await t.issue("a", "ui")).toMatchObject({ status: "done" });
    expect(await t.next("ui")).toMatchObject({ issueId: "b" });
    // Recording the same merge again changes nothing.
    const version = (await t.issue("a")).version;
    await t.merge("search", "ui");
    expect((await t.issue("a")).version).toBe(version);
  });

  test("landing makes them done, including what merged into the timeline", async () => {
    const t = await setup();
    await t.mutate(undefined, {
      kind: "issue.create",
      id: "d",
      data: { teamId: "team", title: "D" },
    });
    await t.fork("ui");
    await t.fork("search");
    await t.finish("a", "search");
    await t.merge("search", "ui");
    await t.finish("d", "ui");
    await t.mutate("ui", { kind: "issue.create", id: "c", data: { teamId: "team", title: "Own" } });
    await t.finish("c", "ui");
    const events = t.store.landTimeline(t.access, "ui");
    const landed = events.filter((e) => e.entityType === "issue").map((e) => e.entityId);
    expect(landed.sort()).toEqual(["a", "c", "d"]);
    for (const id of ["a", "c", "d"])
      expect(await t.issue(id)).toMatchObject({ status: "done", doneIn: null });
    expect(events.find((e) => e.entityId === "a")!.before).toMatchObject({
      status: "done_in_timeline",
    });
    // b is unblocked on main now.
    expect(await t.next()).toMatchObject({ issueId: "b" });
  });

  test("abandoning returns them to ready on main, with a note linking the timeline", async () => {
    const t = await setup();
    await t.fork("search");
    await t.finish("a", "search");
    const abandoned = value(await t.tracker.abandonTimeline(t.access, "search", { app: null }));
    expect(abandoned.timeline.status).toBe("abandoned");
    expect(await t.issue("a")).toMatchObject({ status: "todo", doneIn: null, claim: null });
    const notes = (await t.view()).comments.filter(
      (c) => c.issueId === "a" && c.kind === "comment",
    );
    expect(notes).toMatchObject([
      {
        actorId: "ann",
        body: expect.stringContaining("](/tracker/org/timelines?tl=search)"),
      },
    ]);
    expect(await t.next()).toMatchObject({ issueId: "a" });
    // Abandoning again (to retry bookmarks) changes nothing more.
    value(await t.tracker.abandonTimeline(t.access, "search", { app: null }));
    expect((await t.view()).comments.filter((c) => c.kind === "comment")).toHaveLength(1);
  });

  test("abandoning leaves what main had finished itself done, and returns the rest", async () => {
    const t = await setup();
    await t.finish("a");
    const search = await t.fork("search");
    await t.mutate("search", {
      kind: "issue.update",
      id: "a",
      expectedVersion: (await t.issue("a", "search")).version,
      data: { status: "todo" },
    });
    await t.finish("a", "search");
    await t.finish("b", "search");
    expect(await t.issue("a")).toMatchObject({ status: "done", doneIn: { id: search.id } });
    expect(await t.issue("b")).toMatchObject({
      status: "done_in_timeline",
      doneIn: { id: search.id },
    });
    value(await t.tracker.abandonTimeline(t.access, "search", {}));
    expect(await t.issue("a")).toMatchObject({ status: "done", doneIn: null, claim: null });
    expect(await t.issue("b")).toMatchObject({ status: "todo", doneIn: null, claim: null });
    const notes = (await t.view()).comments.filter((c) => c.kind === "comment");
    expect(notes.map((c) => c.issueId)).toEqual(["b"]);
    expect(await t.next()).toMatchObject({ issueId: "b" });
    // Both stay listed with the status they had in it.
    expect(value(await t.tracker.timeline(t.access, "search", 0, 10)).issues).toMatchObject([
      { id: "a", status: "done" },
      { id: "b", status: "done" },
    ]);
  });

  test("abandoning a timeline something merged into leaves that work done where it was", async () => {
    const t = await setup();
    const search = await t.fork("search");
    await t.fork("ui");
    await t.finish("a", "search");
    await t.merge("search", "ui");
    value(await t.tracker.abandonTimeline(t.access, "ui", {}));
    expect(await t.issue("a")).toMatchObject({
      status: "done_in_timeline",
      doneIn: { id: search.id, slug: "search" },
    });
    expect((await t.view()).comments.find((c) => c.issueId === "a")?.body).toMatch(
      /still done in `search`/,
    );
  });
});
