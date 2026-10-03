// Leases across timelines (CORE-75): finishing an issue inside a timeline
// keeps its lease, "retained", until the timeline lands (released as done) or
// is abandoned (released back to ready). Normal leases are unchanged.

import { afterEach, describe, expect, test } from "vite-plus/test";
import type { Issue, Mutation } from "../../shared/tracker.ts";
import { TrackerStore, type Access } from "./store.ts";
import { durableStorage } from "../testing/durable.ts";

const databases: { close(): void }[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});

const oid = (n: number) => n.toString(16).padStart(40, "0");

function fixture() {
  const { db, sql, transactionSync } = durableStorage();
  databases.push(db);
  let now = Date.parse("2026-10-01T00:00:00Z");
  const store = new TrackerStore(sql, transactionSync, () => now);
  const member = (id: string): Access => ({
    actorId: id,
    principalId: id,
    agents: [],
    owner: { id: "org", slug: "org", displayName: "Org" },
    canAdmin: true,
    members: [
      { id: "ann", slug: "ann", displayName: "Ann" },
      { id: "bob", slug: "bob", displayName: "Bob" },
    ],
    repos: [],
  });
  const ann = member("ann");
  const bob = member("bob");
  let operation = 0;
  const mutate = (who: Access, timeline: string | undefined, ...mutations: Mutation[]) =>
    store.mutate(who, {
      operationId: `op-${++operation}`,
      mutations,
      ...(timeline ? { timeline } : {}),
    });
  mutate(
    ann,
    undefined,
    { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } },
    { kind: "issue.create", id: "a", data: { teamId: "team", title: "Index the docs" } },
  );
  const fork = (slug: string) =>
    store.timelines.create(ann, {
      slug,
      parent: null,
      repos: [{ id: "app", owner: "org", name: "app" }],
      commits: { app: oid(1) },
    });
  const issue = (id: string, timeline?: string) =>
    store.snapshot(ann, timeline).issues.find((i) => i.id === id) as Issue;
  const claim = (who: Access, timeline?: string, id = "a") =>
    mutate(who, timeline, { kind: "issue.claim", id, data: { agent: who.actorId } }).results[0]!
      .leaseToken!;
  const next = (who: Access, timeline?: string) =>
    mutate(who, timeline, { kind: "issue.next", id: crypto.randomUUID(), data: { agent: "x" } })
      .results[0]!.issueId;
  const leases = () => db.prepare("SELECT issue_id FROM leases").all();
  /** Ann claims a and finishes it in `slug`; her lease token. */
  const finishIn = (slug: string) => {
    const token = claim(ann, slug);
    mutate(ann, slug, {
      kind: "issue.complete",
      id: "a",
      data: { leaseToken: token, evidence: "Shipped." },
    });
    return token;
  };
  return {
    store,
    ann,
    bob,
    mutate,
    fork,
    issue,
    claim,
    next,
    leases,
    finishIn,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("leases across timelines", () => {
  test("finishing inside a timeline retains the lease: nobody else can claim it, and it doesn't expire", () => {
    const f = fixture();
    const search = f.fork("search");
    f.fork("other");
    f.finishIn("search");
    const retained = { actorId: "ann", retainedIn: { id: search.id, slug: "search" } };
    expect(f.issue("a")).toMatchObject({ status: "done_in_timeline", claim: retained });
    expect(f.issue("a", "search")).toMatchObject({ status: "done", claim: retained });
    // Long past its ttl, it still holds, in every view.
    f.advance(7 * 24 * 3600 * 1000);
    for (const where of [undefined, "other", "search"]) {
      expect(f.issue("a", where).claim).toMatchObject(retained);
      expect(() => f.claim(f.bob, where)).toThrow(/done in timeline search|active claim/);
      expect(f.next(f.bob, where)).toBeUndefined();
    }
    expect(f.leases()).toHaveLength(1);
  });

  test("renewing a retained lease keeps the issue's locked status", () => {
    const f = fixture();
    f.fork("search");
    const token = f.finishIn("search");
    for (const where of [undefined, "search"]) {
      const renewed = f.mutate(f.ann, where, {
        kind: "issue.renew",
        id: "a",
        data: { leaseToken: token, ttlSeconds: 600 },
      });
      expect(renewed.results[0]).toMatchObject({ leaseToken: token });
    }
    expect(f.issue("a")).toMatchObject({
      status: "done_in_timeline",
      claim: { retainedIn: { slug: "search" } },
    });
    expect(f.issue("a", "search").status).toBe("done");
    // The wrong token doesn't renew it.
    expect(() =>
      f.mutate(f.bob, undefined, {
        kind: "issue.renew",
        id: "a",
        data: { leaseToken: token },
      }),
    ).toThrow(/Claim expired, was superseded, or belongs to another agent/);
  });

  test("a retained lease isn't released or completed by hand, but can be handed off", () => {
    const f = fixture();
    f.fork("search");
    const token = f.finishIn("search");
    for (const kind of ["issue.release", "issue.complete"] as const)
      expect(() =>
        f.mutate(f.ann, "search", {
          kind,
          id: "a",
          data: { leaseToken: token, ...(kind === "issue.complete" ? { evidence: "x" } : {}) },
        } as Mutation),
      ).toThrow(/held until that timeline lands or is abandoned/);
    const offer = f.mutate(f.ann, undefined, {
      kind: "issue.offer",
      id: "a",
      data: { leaseToken: token, toActorId: "bob" },
    }).results[0]!;
    f.mutate(f.bob, undefined, {
      kind: "issue.accept",
      id: "a",
      data: { code: offer.offerCode!, agent: "bob" },
    });
    expect(f.issue("a")).toMatchObject({
      status: "done_in_timeline",
      claim: { actorId: "bob", agent: "bob", retainedIn: { slug: "search" } },
    });
  });

  test("landing releases the lease as done", () => {
    const f = fixture();
    f.fork("search");
    const token = f.finishIn("search");
    f.store.landTimeline(f.ann, "search");
    expect(f.issue("a")).toMatchObject({ status: "done", doneIn: null, claim: null });
    expect(f.leases()).toEqual([]);
    expect(() =>
      f.mutate(f.ann, undefined, { kind: "issue.renew", id: "a", data: { leaseToken: token } }),
    ).toThrow(/Claim expired/);
  });

  test("abandoning releases the lease back to ready", () => {
    const f = fixture();
    const search = f.fork("search");
    f.finishIn("search");
    const { timeline } = f.store.timelines.abandon(f.ann, "search", {});
    expect(timeline.id).toBe(search.id);
    f.store.timelineAbandoned(f.ann, timeline);
    expect(f.issue("a")).toMatchObject({ status: "todo", claim: null });
    expect(f.leases()).toEqual([]);
    // Ready again, for the agent it's assigned to.
    expect(f.next(f.ann)).toBe("a");
  });

  test("merging the timeline into another moves the lease with the work", () => {
    const f = fixture();
    f.fork("search");
    const ui = f.fork("ui");
    f.finishIn("search");
    f.store.timelines.recordPush(
      {
        repo: { id: "app", owner: "org", name: "app" },
        actorId: "ann",
        accountableId: "ann",
        pushed: ["ui"],
        merges: [{ into: "ui", from: "search", commit: oid(2), parent: oid(3), refUpdateId: null }],
      },
      (merge) => f.store.timelineMerged(merge.fromId, merge.intoId, merge.id, "ann"),
    );
    expect(f.issue("a")).toMatchObject({
      doneIn: { id: ui.id },
      claim: { retainedIn: { id: ui.id, slug: "ui" } },
    });
    f.store.landTimeline(f.ann, "ui");
    expect(f.issue("a")).toMatchObject({ status: "done", claim: null });
  });

  test("finishing by status keeps the lease too; reopening in the timeline ends it", () => {
    const f = fixture();
    f.fork("search");
    const token = f.claim(f.ann, "search");
    f.mutate(f.ann, "search", {
      kind: "issue.update",
      id: "a",
      expectedVersion: f.issue("a", "search").version,
      data: { status: "done", leaseToken: token },
    });
    expect(f.issue("a").claim).toMatchObject({ retainedIn: { slug: "search" } });
    // A person reopening it there needs no token: the finished work is open again.
    f.mutate(f.bob, "search", {
      kind: "issue.update",
      id: "a",
      expectedVersion: f.issue("a", "search").version,
      data: { status: "todo" },
    });
    expect(f.issue("a")).toMatchObject({ status: "todo", claim: null });
    expect(f.leases()).toEqual([]);
    expect(f.next(f.ann, "search")).toBe("a");
  });

  test("normal leases still expire, renew and end on main", () => {
    const f = fixture();
    const token = f.claim(f.ann);
    f.advance(10 * 60 * 1000);
    f.mutate(f.ann, undefined, { kind: "issue.renew", id: "a", data: { leaseToken: token } });
    f.advance(10 * 60 * 1000);
    expect(f.next(f.bob)).toBeUndefined();
    f.advance(6 * 60 * 1000);
    // Expired: anyone may take it, and the old token is dead.
    const bobs = f.claim(f.bob);
    expect(() =>
      f.mutate(f.ann, undefined, { kind: "issue.renew", id: "a", data: { leaseToken: token } }),
    ).toThrow(/Claim expired/);
    f.mutate(f.bob, undefined, {
      kind: "issue.complete",
      id: "a",
      data: { leaseToken: bobs, evidence: "Shipped." },
    });
    expect(f.issue("a")).toMatchObject({ status: "done", claim: null });
    expect(f.leases()).toEqual([]);
  });
});
