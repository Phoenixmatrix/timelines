// The agent work page's finished issues (CORE-220): one tracker's issues its
// person's agents finished, newest first, with their timeline and evidence.

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { Issue, Mutation, Snapshot, TrackerAgent } from "../../shared/tracker.ts";
import { durableStorage } from "../testing/durable.ts";
import { Tracker, type TrackerReply } from "./object.ts";
import { TrackerStore, type Access } from "./store.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

// The tracker's clock is Date.now: fake it so each finish has its own time.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});
const later = (hours: number) => vi.setSystemTime(Date.now() + hours * 3_600_000);

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
    view,
    issue,
    finish,
    status,
    end,
  };
}

describe("finished work for the agent work page", () => {
  test("ann's agents' work since a time, newest first, with timeline and evidence", () => {
    const t = setup();
    t.mutate(
      t.ann,
      undefined,
      { kind: "issue.create", id: "c", data: { teamId: "team", title: "C" } },
      { kind: "issue.create", id: "d", data: { teamId: "team", title: "D" } },
    );
    t.finish(t.agent, "a");
    later(1);
    const claimed = t.mutate(t.agent, undefined, {
      kind: "issue.claim",
      id: "b",
      data: { agent: "laptop" },
    }).results[0]!;
    t.mutate(t.agent, undefined, {
      kind: "issue.complete",
      id: "b",
      data: { leaseToken: claimed.leaseToken!, evidence: "\n  vp test passed (12 files)\nmore" },
    });
    // A person's own work, and work in a timeline, with evidence made there.
    later(1);
    t.finish(t.ann, "c");
    const search = t.fork("search");
    later(1);
    const held = t.mutate(t.agent, "search", {
      kind: "issue.claim",
      id: "d",
      data: { agent: "laptop" },
    }).results[0]!;
    t.mutate(t.agent, "search", {
      kind: "issue.complete",
      id: "d",
      data: { leaseToken: held.leaseToken!, evidence: "Indexed in the search timeline" },
    });
    // Plenty of talk afterwards, in the timeline and on main, doesn't hide it.
    for (const timeline of ["search", undefined])
      t.mutate(
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
