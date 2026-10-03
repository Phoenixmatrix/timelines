import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  readiness,
  readinessIndex,
  type HumanRequest,
  type Issue,
  type Mutation,
} from "../../shared/tracker.ts";
import { RESUME_WINDOW_SECONDS, TrackerStore, type Access, type SqlDatabase } from "./store.ts";
import { trackerSql, transactional } from "../testing/tracker.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: SqlDatabase = trackerSql(db);
  let now = Date.parse("2026-10-01T00:00:00Z");
  const transaction = transactional(db);
  const store = new TrackerStore(sql, transaction, () => now);
  const access: Access = {
    actorId: "alice",
    principalId: "alice",
    agents: [
      {
        id: "agt-bot",
        name: "bot",
        accountable: { id: "alice", slug: "alice", displayName: "Alice" },
        capabilities: null,
        capabilitiesUpdatedAt: null,
        revokedAt: null,
      },
    ],
    owner: { id: "org", slug: "org", displayName: "Org" },
    canAdmin: true,
    members: [
      { id: "alice", slug: "alice", displayName: "Alice" },
      { id: "bob", slug: "bob", displayName: "Bob" },
    ],
    repos: [{ id: "repo", owner: "org", name: "private" }],
  };
  let operation = 0;
  const mutate = (...mutations: Mutation[]) =>
    store.mutate(access, { operationId: `operation-${++operation}`, mutations });
  mutate(
    { kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering" } },
    { kind: "workspace.create", id: "workspace", data: { slug: "platform", name: "Platform" } },
  );
  const issue = (id: string) =>
    mutate({ kind: "issue.create", id, data: { teamId: "team", title: id } });
  return {
    db,
    store,
    reopen: () => new TrackerStore(sql, transaction, () => now),
    access,
    mutate,
    issue,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

describe("ticket audit history", () => {
  test("persists creator and authenticated agent identity, paginates without duplicates, and fences retries", () => {
    const f = fixture();
    f.access.actorId = "agt-bot";
    f.access.source = "cli";
    f.issue("ticket");
    const creator = {
      id: "agt-bot",
      kind: "agent",
      name: "bot",
      accountable: { id: "alice", slug: "alice", displayName: "Alice" },
    };
    expect(f.store.snapshot(f.access).issues[0]!.createdBy).toEqual(creator);
    const input = {
      operationId: "edit-once",
      mutations: [
        { kind: "issue.update", id: "ticket", expectedVersion: 1, data: { title: "Changed" } },
      ],
    };
    f.advance(1000);
    f.store.mutate(f.access, input);
    f.access.source = "web";
    f.store.mutate(f.access, input);
    f.access.agents[0]!.name = "renamed";
    f.access.members[0]!.displayName = "Renamed Alice";
    const first = f.store.history(f.access, "ENG-1", null, 1);
    expect(first.creator).toEqual(creator);
    expect(first.hasMore).toBe(true);
    expect(first.events[0]).toMatchObject({
      actor: creator,
      source: "cli",
      kind: "issue.update",
      mutationKind: "issue.update",
      operationId: "edit-once",
      createdAt: "2026-10-01T00:00:01.000Z",
      before: { title: "ticket", version: 1 },
      entity: { title: "Changed", version: 2 },
    });
    const second = f.store.history(f.access, "ticket", first.nextBefore, 1);
    expect(second.hasMore).toBe(false);
    expect(second.nextBefore).toBeNull();
    expect(second.events.map((event) => event.kind)).toEqual(["issue.create"]);
    expect(second.events[0]!.cursor).toBeLessThan(first.events[0]!.cursor);
    expect(() => f.store.history(f.access, "missing", null, 10)).toThrow(/not found/);
    expect(() => f.store.history(f.access, "ticket", 0, 10)).toThrow(/before/);
    expect(() => f.store.history(f.access, "ticket", null, 101)).toThrow(/limit/);
    expect(() =>
      f.mutate(
        {
          kind: "issue.update",
          id: "ticket",
          expectedVersion: 2,
          data: { title: "Rolled back" },
        },
        { kind: "link.remove", id: "missing-link" },
      ),
    ).toThrow();
    expect(
      f.store.history(f.access, "ticket", null, 100).events.map((event) => event.kind),
    ).toEqual(["issue.update", "issue.create"]);
  });

  test("includes both link endpoints, former parents, requests, comments and completion effects without secrets", () => {
    const f = fixture();
    for (const id of ["ticket", "other", "parent", "new-parent"]) f.issue(id);
    f.mutate({
      kind: "issue.update",
      id: "ticket",
      expectedVersion: 1,
      data: { parentId: "parent" },
    });
    f.mutate({
      kind: "issue.update",
      id: "ticket",
      expectedVersion: 2,
      data: { parentId: "new-parent" },
    });
    f.mutate({
      kind: "link.add",
      id: "relation",
      data: { fromId: "ticket", toId: "other", kind: "related" },
    });
    f.mutate({ kind: "link.remove", id: "relation" });
    f.mutate({
      kind: "comment.add",
      id: "note",
      data: { issueId: "ticket", body: "Checkpoint", kind: "checkpoint" },
    });
    f.mutate({
      kind: "request.open",
      id: "question",
      data: { issueId: "ticket", kind: "question", prompt: "Proceed?" },
    });
    f.mutate({ kind: "request.answer", id: "question", data: { answer: "Yes" } });
    const claim = f.mutate({ kind: "issue.claim", id: "ticket", data: { agent: "audit-worker" } });
    const token = String(claim.results[0]!.leaseToken);
    f.mutate({
      kind: "issue.complete",
      id: "ticket",
      data: { leaseToken: token, evidence: "Verified" },
    });
    const history = f.store.history(f.access, "ticket", null, 100);
    expect(history.events.map((event) => event.kind)).toEqual([
      "issue.complete",
      "comment.add",
      "issue.claim",
      "issue.update",
      "request.answer",
      "issue.update",
      "request.open",
      "comment.add",
      "link.remove",
      "link.add",
      "issue.update",
      "issue.update",
      "issue.create",
    ]);
    expect(history.events.find((event) => event.kind === "link.remove")).toMatchObject({
      before: { fromId: "ticket", toId: "other", kind: "related" },
      entity: null,
    });
    expect(
      history.events.find(
        (event) => event.entityType === "comment" && event.mutationKind === "issue.complete",
      ),
    ).toMatchObject({ entity: { kind: "evidence", body: "Verified" } });
    expect(JSON.stringify(history)).not.toContain(token);
    expect(JSON.stringify(history)).not.toContain("leaseToken");
    expect(f.store.history(f.access, "other", null, 100).events.map((event) => event.kind)).toEqual(
      ["link.remove", "link.add", "issue.create"],
    );
    expect(
      f.store.history(f.access, "parent", null, 100).events.map((event) => event.kind),
    ).toEqual(["issue.update", "issue.update", "issue.create"]);
    expect(
      f.store.history(f.access, "new-parent", null, 100).events.map((event) => event.kind),
    ).toEqual(["issue.update", "issue.create"]);
  });

  test("backfills legacy creators and removed relationships without inventing old source metadata", () => {
    const f = fixture();
    for (const id of ["ticket", "other", "parent"]) f.issue(id);
    f.mutate({
      kind: "issue.update",
      id: "ticket",
      expectedVersion: 1,
      data: { parentId: "parent" },
    });
    f.mutate({ kind: "issue.update", id: "ticket", expectedVersion: 2, data: { parentId: null } });
    f.mutate({
      kind: "link.add",
      id: "removed",
      data: { fromId: "ticket", toId: "other", kind: "related" },
    });
    f.mutate({ kind: "link.remove", id: "removed" });
    f.db
      .exec(`UPDATE events SET data = json_remove(data, '$.actor', '$.source', '$.before', '$.mutationKind', '$.entity.createdBy');
      UPDATE issues SET data = json_remove(data, '$.createdBy');
      DELETE FROM issue_events; DELETE FROM tracker_migrations;`);
    const migrated = f.reopen();
    expect(
      migrated.snapshot(f.access).issues.find((issue) => issue.id === "ticket")!.createdBy,
    ).toEqual({ id: "alice", kind: "unknown", name: null, accountable: null });
    const history = migrated.history(f.access, "ticket", null, 100);
    expect(history.creator).toEqual({
      id: "alice",
      kind: "person",
      name: "Alice",
      accountable: null,
    });
    expect(history.events.every((event) => event.source === "unknown")).toBe(true);
    expect(history.events[0]).toMatchObject({
      kind: "link.remove",
      entity: null,
      before: { id: "removed", fromId: "ticket", toId: "other" },
    });
    expect(
      migrated.history(f.access, "other", null, 100).events.map((event) => event.kind),
    ).toEqual(["link.remove", "link.add", "issue.create"]);
    expect(
      migrated.history(f.access, "parent", null, 100).events.map((event) => event.kind),
    ).toEqual(["issue.update", "issue.update", "issue.create"]);
    expect(f.reopen().history(f.access, "ticket", null, 100)).toEqual(history);
    f.db.exec(`DELETE FROM events WHERE json_extract(data, '$.kind') = 'issue.create';
      UPDATE issues SET data = json_remove(data, '$.createdBy'); DELETE FROM tracker_migrations;`);
    expect(
      f
        .reopen()
        .snapshot(f.access)
        .issues.every((issue) => issue.createdBy === null),
    ).toBe(true);
  });
});

describe("tracker SQLite authority", () => {
  test("one claimant wins, expiry fences the old token, and completion persists evidence without leaking tokens", () => {
    const f = fixture();
    f.issue("issue");
    const first = f.mutate({
      kind: "issue.claim",
      id: "issue",
      data: { agent: "agent-a", ttlSeconds: 30 },
    });
    const token = String(first.results[0]!.leaseToken);
    expect(() =>
      f.mutate({ kind: "issue.claim", id: "issue", data: { agent: "agent-b" } }),
    ).toThrow(/active claim/);
    f.advance(30_000);
    expect(() =>
      f.mutate({
        kind: "issue.complete",
        id: "issue",
        data: { leaseToken: token, evidence: "Old process" },
      }),
    ).toThrow(/expired/);
    const second = f.mutate({ kind: "issue.claim", id: "issue", data: { agent: "agent-b" } });
    expect(() =>
      f.mutate({ kind: "issue.release", id: "issue", data: { leaseToken: token } }),
    ).toThrow(/superseded/);
    const nextToken = String(second.results[0]!.leaseToken);
    f.mutate({
      kind: "issue.complete",
      id: "issue",
      data: { leaseToken: nextToken, evidence: "Verified result" },
    });
    const snapshot = f.store.snapshot(f.access);
    expect(snapshot.issues[0]!.status).toBe("done");
    expect(snapshot.comments).toEqual([
      expect.objectContaining({ body: "Verified result", kind: "evidence", issueId: "issue" }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(nextToken);
    expect(JSON.stringify(f.store.changes(0, 500))).not.toContain(token);
    expect(JSON.stringify(f.store.changes(0, 500))).not.toContain(nextToken);
  });
  test("blockers prevent claims and completion including canceled blockers", () => {
    const f = fixture();
    f.issue("blocker");
    f.issue("target");
    f.mutate({
      kind: "link.add",
      id: "link",
      data: { fromId: "blocker", toId: "target", kind: "blocks" },
    });
    expect(() => f.mutate({ kind: "issue.claim", id: "target", data: { agent: "agent" } })).toThrow(
      /blockers/,
    );
    f.mutate({
      kind: "issue.update",
      id: "blocker",
      expectedVersion: 1,
      data: { status: "canceled", closeReason: "not_planned" },
    });
    expect(() => f.mutate({ kind: "issue.claim", id: "target", data: { agent: "agent" } })).toThrow(
      /blockers/,
    );
    f.mutate({ kind: "issue.update", id: "blocker", expectedVersion: 2, data: { status: "done" } });
    const claim = f.mutate({ kind: "issue.claim", id: "target", data: { agent: "agent" } });
    f.mutate({ kind: "issue.update", id: "blocker", expectedVersion: 3, data: { status: "todo" } });
    expect(() =>
      f.mutate({
        kind: "issue.complete",
        id: "target",
        data: { leaseToken: String(claim.results[0]!.leaseToken), evidence: "Not ready" },
      }),
    ).toThrow(/blockers/);
    expect(f.store.snapshot(f.access).comments).toEqual([]);
  });
  test("closing preserves its reason in snapshots and history without completing work, and reopening clears it", () => {
    const f = fixture();
    f.issue("blocker");
    f.issue("target");
    f.mutate({
      kind: "link.add",
      id: "link",
      data: { fromId: "blocker", toId: "target", kind: "blocks" },
    });
    const closed = f.mutate({
      kind: "issue.update",
      id: "target",
      expectedVersion: 1,
      data: { status: "canceled", closeReason: "duplicate" },
    });
    expect(f.store.snapshot(f.access).issues.find((issue) => issue.id === "target")).toMatchObject({
      status: "canceled",
      closeReason: "duplicate",
      claim: null,
      version: 2,
    });
    expect(f.store.snapshot(f.access).comments).toEqual([]);
    f.mutate({
      kind: "issue.update",
      id: "target",
      expectedVersion: 2,
      data: { status: "todo" },
    });
    expect(f.store.snapshot(f.access).issues.find((issue) => issue.id === "target")).toMatchObject({
      status: "todo",
      closeReason: null,
      version: 3,
    });
    expect(
      f.store.changes(0, 500).events.find((event) => event.cursor === closed.cursor)?.entity,
    ).toMatchObject({ status: "canceled", closeReason: "duplicate" });
  });
  test("close reasons are required on cancellation, forbidden on open work, and validated atomically", () => {
    const f = fixture();
    f.issue("issue");
    const before = f.store.snapshot(f.access);
    for (const data of [
      { status: "canceled" },
      { status: "canceled", closeReason: null },
      { closeReason: "duplicate" },
      { status: "canceled", closeReason: "invented" },
    ]) {
      expect(() =>
        f.store.mutate(f.access, {
          operationId: crypto.randomUUID(),
          mutations: [{ kind: "issue.update", id: "issue", expectedVersion: 1, data }],
        }),
      ).toThrow(/close reason/);
      expect(f.store.snapshot(f.access)).toEqual(before);
    }
    expect(() =>
      f.mutate({
        kind: "issue.create",
        id: "invalid",
        data: { teamId: "team", title: "Invalid", status: "canceled" },
      }),
    ).toThrow(/close reason/);
    f.mutate({
      kind: "issue.create",
      id: "closed",
      data: { teamId: "team", title: "Closed", status: "canceled", closeReason: "obsolete" },
    });
    expect(f.store.snapshot(f.access).issues.find((issue) => issue.id === "closed")).toMatchObject({
      key: "ENG-2",
      status: "canceled",
      closeReason: "obsolete",
    });
    expect(() =>
      f.mutate({
        kind: "issue.update",
        id: "closed",
        expectedVersion: 1,
        data: { closeReason: null },
      }),
    ).toThrow(/close reason/);
    f.mutate({
      kind: "issue.update",
      id: "closed",
      expectedVersion: 1,
      data: { status: "done" },
    });
    expect(f.store.snapshot(f.access).issues.find((issue) => issue.id === "closed")).toMatchObject({
      status: "done",
      closeReason: null,
    });
  });
  test("historical cancellations stay editable without inventing a reason", () => {
    const f = fixture();
    f.issue("legacy");
    f.db
      .prepare(
        "UPDATE issues SET data = json_set(json_remove(data, '$.closeReason'), '$.status', 'canceled') WHERE id = ?",
      )
      .run("legacy");
    f.mutate({
      kind: "issue.update",
      id: "legacy",
      expectedVersion: 1,
      data: { title: "Clarified" },
    });
    expect(f.store.snapshot(f.access).issues[0]).toMatchObject({
      title: "Clarified",
      status: "canceled",
    });
    expect(f.store.snapshot(f.access).issues[0]!.closeReason).toBeUndefined();
    f.mutate({
      kind: "issue.update",
      id: "legacy",
      expectedVersion: 2,
      data: { closeReason: "cannot_reproduce" },
    });
    expect(f.store.snapshot(f.access).issues[0]!.closeReason).toBe("cannot_reproduce");
  });
  test("the timeline rule defaults to agent_decides, keeps a policy only when required, and validates atomically", () => {
    const f = fixture();
    f.issue("issue");
    const read = (id: string) =>
      f.store.snapshot(f.access).issues.find((issue) => issue.id === id)!;
    expect(read("issue")).toMatchObject({ timelineUse: "agent_decides", timelinePolicy: null });
    const before = f.store.snapshot(f.access);
    for (const data of [
      { timelineUse: "sometimes" },
      { timelineUse: null },
      { timelinePolicy: "approval" },
      { timelineUse: "never", timelinePolicy: "auto" },
      { timelineUse: "required", timelinePolicy: "manual" },
    ]) {
      expect(() =>
        f.store.mutate(f.access, {
          operationId: crypto.randomUUID(),
          mutations: [{ kind: "issue.update", id: "issue", expectedVersion: 1, data } as Mutation],
        }),
      ).toThrow(/timeline/);
      expect(f.store.snapshot(f.access)).toEqual(before);
    }
    f.mutate({
      kind: "issue.update",
      id: "issue",
      expectedVersion: 1,
      data: { timelineUse: "required", timelinePolicy: "approval" },
    });
    expect(read("issue")).toMatchObject({ timelineUse: "required", timelinePolicy: "approval" });
    // Leaving required drops the policy.
    f.mutate({
      kind: "issue.update",
      id: "issue",
      expectedVersion: 2,
      data: { timelineUse: "never" },
    });
    expect(read("issue")).toMatchObject({ timelineUse: "never", timelinePolicy: null });
    f.mutate({
      kind: "issue.create",
      id: "auto",
      data: { teamId: "team", title: "Auto", timelineUse: "required", timelinePolicy: "auto" },
    });
    expect(read("auto")).toMatchObject({ timelineUse: "required", timelinePolicy: "auto" });
    // Issues from before the field keep working and can gain it.
    f.issue("legacy");
    f.db
      .prepare(
        "UPDATE issues SET data = json_remove(data, '$.timelineUse', '$.timelinePolicy') WHERE id = ?",
      )
      .run("legacy");
    f.mutate({ kind: "issue.update", id: "legacy", expectedVersion: 1, data: { title: "Old" } });
    expect(read("legacy").timelineUse).toBeUndefined();
    f.mutate({
      kind: "issue.update",
      id: "legacy",
      expectedVersion: 2,
      data: { timelineUse: "required" },
    });
    expect(read("legacy")).toMatchObject({ timelineUse: "required" });
    expect(read("legacy").timelinePolicy).toBeUndefined();
  });
  test("cyclic batches roll back entities, sequence numbers, events and receipts", () => {
    const f = fixture();
    const before = f.store.snapshot(f.access);
    const request = {
      operationId: "cycle",
      mutations: [
        { kind: "issue.create", id: "a", data: { teamId: "team", title: "A" } },
        { kind: "issue.create", id: "b", data: { teamId: "team", title: "B" } },
        { kind: "link.add", id: "ab", data: { fromId: "a", toId: "b", kind: "blocks" } },
        { kind: "link.add", id: "ba", data: { fromId: "b", toId: "a", kind: "blocks" } },
      ],
    };
    expect(() => f.store.mutate(f.access, request)).toThrow(/acyclic/);
    expect(f.store.snapshot(f.access)).toEqual(before);
    request.mutations.pop();
    f.store.mutate(f.access, request);
    expect(f.store.snapshot(f.access).issues.map((i) => i.key)).toEqual(["ENG-1", "ENG-2"]);
  });
  test("parent hierarchy is acyclic and version conflicts preserve authoritative edits", () => {
    const f = fixture();
    f.issue("a");
    f.issue("b");
    f.mutate({
      kind: "issue.update",
      id: "a",
      expectedVersion: 1,
      data: { parentId: "b", title: "Authoritative" },
    });
    expect(() =>
      f.mutate({ kind: "issue.update", id: "b", expectedVersion: 1, data: { parentId: "a" } }),
    ).toThrow(/acyclic/);
    expect(() =>
      f.mutate({
        kind: "issue.update",
        id: "a",
        expectedVersion: 1,
        data: { title: "Offline stale" },
      }),
    ).toThrow(
      expect.objectContaining({
        code: "version_conflict",
        details: expect.objectContaining({
          currentVersion: 2,
          current: expect.objectContaining({ title: "Authoritative" }),
        }),
      }),
    );
    expect(f.store.snapshot(f.access).issues.find((i) => i.id === "a")?.title).toBe(
      "Authoritative",
    );
  });
  test("operation replay is exact and actor-bound without duplicate comments", () => {
    const f = fixture();
    f.issue("a");
    const request = {
      operationId: "replay",
      mutations: [
        {
          kind: "comment.add",
          id: "comment",
          data: { issueId: "a", body: "Checkpoint", kind: "checkpoint" },
        },
      ],
    };
    const result = f.store.mutate(f.access, request);
    f.advance(5000);
    expect(f.store.mutate(f.access, request)).toEqual(result);
    expect(f.store.snapshot(f.access).comments).toEqual([
      expect.objectContaining({ id: "comment", body: "Checkpoint" }),
    ]);
    expect(() =>
      f.store.mutate({ ...f.access, actorId: "bob", principalId: "bob" }, request),
    ).toThrow(/different actor/);
    expect(() =>
      f.store.mutate(f.access, {
        ...request,
        mutations: [{ ...request.mutations[0], data: { issueId: "a", body: "Different" } }],
      }),
    ).toThrow(/payload/);
  });
  test("team members and assignees must be account members; team restrictions enforce writes", () => {
    const f = fixture();
    expect(() =>
      f.mutate({
        kind: "team.update",
        id: "team",
        expectedVersion: 1,
        data: { memberIds: ["outsider"] },
      }),
    ).toThrow(/account member/);
    f.mutate({
      kind: "team.update",
      id: "team",
      expectedVersion: 1,
      data: { memberIds: ["alice"] },
    });
    expect(() =>
      f.mutate({
        kind: "issue.create",
        id: "bad",
        data: { teamId: "team", title: "Bad", assigneeId: "bob" },
      }),
    ).toThrow(/owning team/);
    expect(() =>
      f.store.mutate(
        { ...f.access, actorId: "bob", principalId: "bob", canAdmin: false },
        {
          operationId: "bob-create",
          mutations: [{ kind: "issue.create", id: "bad", data: { teamId: "team", title: "Bad" } }],
        },
      ),
    ).toThrow(/team members/);
    expect(() =>
      f.store.mutate(
        { ...f.access, canAdmin: false },
        {
          operationId: "member-admin",
          mutations: [
            { kind: "workspace.create", id: "other", data: { slug: "other", name: "Other" } },
          ],
        },
      ),
    ).toThrow(/ownership/);
  });
  test("team edits retain an assigned agent through its accountable member but cannot remove that member", () => {
    const f = fixture();
    f.mutate({
      kind: "team.update",
      id: "team",
      expectedVersion: 1,
      data: { memberIds: ["alice"] },
    });
    f.issue("work");
    f.store.mutate(
      { ...f.access, actorId: "agt-bot" },
      {
        operationId: "agent-claim",
        mutations: [{ kind: "issue.claim", id: "work", data: { agent: "session" } }],
      },
    );
    // The admin form sends membership even when only the name changed.
    f.mutate({
      kind: "team.update",
      id: "team",
      expectedVersion: 2,
      data: { name: "Renamed engineering", memberIds: ["alice"] },
    });
    const saved = f.reopen().snapshot(f.access);
    expect(saved.teams[0]).toMatchObject({
      name: "Renamed engineering",
      memberIds: ["alice"],
      version: 3,
    });
    expect(saved.issues[0]).toMatchObject({
      assigneeId: "agt-bot",
      claim: { actorId: "agt-bot", accountableId: "alice" },
    });
    expect(() =>
      f.mutate({
        kind: "team.update",
        id: "team",
        expectedVersion: 3,
        data: { name: "Rejected rename", memberIds: ["bob"] },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_member", status: 409 }));
    expect(f.reopen().snapshot(f.access)).toEqual(saved);
  });
  test("repository administration is required for both subscription directions; archive prevents new associations", () => {
    const f = fixture();
    const subscription: Mutation = {
      kind: "subscription.add",
      id: "sub",
      data: { workspaceId: "workspace", repoId: "repo" },
    };
    expect(() =>
      f.store.mutate(
        { ...f.access, repos: [] },
        { operationId: "unauthorized", mutations: [subscription] },
      ),
    ).toThrow(/Repository administration/);
    f.mutate(subscription);
    expect(() =>
      f.store.mutate(
        { ...f.access, repos: [] },
        { operationId: "remove", mutations: [{ kind: "subscription.remove", id: "sub" }] },
      ),
    ).toThrow(/Repository administration/);
    f.mutate({
      kind: "workspace.update",
      id: "workspace",
      expectedVersion: 1,
      data: { archived: true },
    });
    expect(() =>
      f.mutate({
        kind: "issue.create",
        id: "bad",
        data: { teamId: "team", title: "Bad", workspaceIds: ["workspace"] },
      }),
    ).toThrow(/archived/);
    expect(() =>
      f.mutate({
        kind: "subscription.add",
        id: "sub2",
        data: { workspaceId: "workspace", repoId: "repo" },
      }),
    ).toThrow(/archived/);
    expect(f.store.snapshot(f.access).subscriptions).toEqual([
      { id: "sub", workspaceId: "workspace", repoId: "repo", owner: "org", name: "private" },
    ]);
  });
  test("only tracker admins may remove confirmed deleted-repository subscriptions", () => {
    const f = fixture();
    f.mutate({
      kind: "subscription.add",
      id: "orphan",
      data: { workspaceId: "workspace", repoId: "repo" },
    });
    const request = {
      operationId: "remove-orphan",
      mutations: [{ kind: "subscription.remove", id: "orphan" } satisfies Mutation],
    };
    expect(() => f.store.mutate({ ...f.access, repos: [] }, request)).toThrow(
      /Repository administration/,
    );
    expect(() =>
      f.store.mutate(
        {
          ...f.access,
          canAdmin: false,
          repos: [],
          deletedRepoIds: ["repo"],
        },
        request,
      ),
    ).toThrow(/ownership/);
    f.store.mutate({ ...f.access, repos: [], deletedRepoIds: ["repo"] }, request);
    expect(f.store.snapshot(f.access).subscriptions).toEqual([]);
    expect(() =>
      f.store.mutate(
        {
          ...f.access,
          repos: [],
          deletedRepoIds: ["repo"],
        },
        {
          operationId: "cannot-readd",
          mutations: [
            {
              kind: "subscription.add",
              id: "new-sub",
              data: { workspaceId: "workspace", repoId: "repo" },
            },
          ],
        },
      ),
    ).toThrow(/Repository administration/);
  });
  test("repo associations only return that repo's live workspaces across owning teams", () => {
    const f = fixture();
    f.access.repos.push({ id: "another-repo", owner: "other", name: "other" });
    f.mutate(
      { kind: "workspace.create", id: "other-workspace", data: { slug: "other", name: "Other" } },
      { kind: "subscription.add", id: "sub", data: { workspaceId: "workspace", repoId: "repo" } },
      {
        kind: "subscription.add",
        id: "other-sub",
        data: { workspaceId: "other-workspace", repoId: "another-repo" },
      },
    );
    expect(f.store.subscribedWorkspaces("repo")).toEqual([
      { workspaceId: "workspace", slug: "platform", name: "Platform" },
    ]);
    expect(f.store.subscribedWorkspaces("unrelated-repo")).toEqual([]);
    f.mutate({
      kind: "workspace.update",
      id: "workspace",
      expectedVersion: 1,
      data: { archived: true },
    });
    expect(f.store.subscribedWorkspaces("repo")).toEqual([]);
    expect(f.store.subscribedWorkspaces("another-repo")).toEqual([
      { workspaceId: "other-workspace", slug: "other", name: "Other" },
    ]);
  });
  test("malformed optional fields and content/cardinality limits reject without partial writes", () => {
    const f = fixture();
    f.issue("issue");
    const before = f.store.snapshot(f.access);
    const invalid = [
      { kind: "issue.claim", id: "issue", data: { agent: "agent", ttlSeconds: null } },
      { kind: "issue.claim", id: "issue", data: { agent: "agent", ttlSeconds: 29 } },
      {
        kind: "issue.update",
        id: "issue",
        expectedVersion: 1,
        data: { labels: ["duplicate", "duplicate"] },
      },
      { kind: "issue.update", id: "issue", expectedVersion: 1, data: { title: "x".repeat(501) } },
      {
        kind: "issue.update",
        id: "issue",
        expectedVersion: 1,
        data: { workspaceIds: ["missing"] },
      },
      { kind: "issue.update", id: "issue", expectedVersion: 1, data: { surprise: true } },
      { kind: "comment.add", id: "comment", data: { issueId: "issue", body: "Body", kind: null } },
    ];
    for (const mutation of invalid) {
      expect(() =>
        f.store.mutate(f.access, { operationId: "invalid", mutations: [mutation] }),
      ).toThrow();
      expect(f.store.snapshot(f.access)).toEqual(before);
    }
    expect(() =>
      f.store.mutate(f.access, { operationId: "too-many", mutations: Array(101).fill(invalid[0]) }),
    ).toThrow(/1–100/);
  });
  test("pagination cursors stop at included events, and final batch readiness cannot be bypassed", () => {
    const f = fixture();
    f.issue("a");
    f.issue("b");
    const first = f.store.changes(0, 2);
    expect(first.events.map((e) => e.cursor)).toEqual([1, 2]);
    expect(first.cursor).toBe(2);
    expect(first.hasMore).toBe(true);
    const second = f.store.changes(first.cursor, 2);
    expect(second.events.map((e) => e.cursor)).toEqual([3, 4]);
    expect(second.hasMore).toBe(false);
    expect(() =>
      f.mutate(
        { kind: "issue.claim", id: "b", data: { agent: "agent" } },
        { kind: "link.add", id: "block", data: { fromId: "a", toId: "b", kind: "blocks" } },
      ),
    ).toThrow(/blockers/);
    expect(f.store.snapshot(f.access).issues.find((i) => i.id === "b")?.claim).toBeNull();
    expect(f.store.snapshot(f.access).links).toEqual([]);
  });
});

describe("graph readiness", () => {
  function graph() {
    const f = fixture();
    for (const id of ["project", "a", "b"]) f.issue(id);
    const version = (id: string) =>
      (f.store.snapshot(f.access).issues.find((i) => i.id === id) as Issue).version;
    for (const id of ["a", "b"])
      f.mutate({
        kind: "issue.update",
        id,
        expectedVersion: version(id),
        data: { parentId: "project" },
      });
    const state = (id: string) => {
      const snap = f.store.snapshot(f.access);
      const index = readinessIndex(snap.issues, snap.links);
      return readiness(index.byId.get(id)!, index, snap.serverTime);
    };
    const claim = (id: string, agent: string, ttlSeconds?: number) =>
      String(
        f.mutate({
          kind: "issue.claim",
          id,
          data: { agent, ...(ttlSeconds ? { ttlSeconds } : {}) },
        }).results[0]!.leaseToken,
      );
    return { ...f, version, state, claim };
  }

  test("a parent with open sub-issues is a container, not work, but can be claimed to take its subtree", () => {
    const g = graph();
    expect([g.state("project"), g.state("a"), g.state("b")]).toEqual([
      "container",
      "ready",
      "ready",
    ]);
    g.claim("project", "lead");
    expect([g.state("a"), g.state("b")]).toEqual(["leased_above", "leased_above"]);
  });

  test("another agent can't claim or change status or parent inside a leased subtree", () => {
    const g = graph();
    const token = g.claim("project", "lead");
    expect(() => g.claim("a", "other")).toThrow(
      /ENG-1 is leased by lead, and its lease covers ENG-2/,
    );
    expect(() =>
      g.mutate({
        kind: "issue.update",
        id: "a",
        expectedVersion: g.version("a"),
        data: { status: "in_progress" },
      }),
    ).toThrow(/needs that lease's token/);
    expect(() =>
      g.mutate({
        kind: "issue.update",
        id: "a",
        expectedVersion: g.version("a"),
        data: { parentId: null },
      }),
    ).toThrow(/needs that lease's token/);
    expect(() =>
      g.mutate({
        kind: "issue.update",
        id: "a",
        expectedVersion: g.version("a"),
        data: { status: "canceled", closeReason: "duplicate" },
      }),
    ).toThrow(/needs that lease's token/);
    // Editing details stays open, and the holder's token covers the whole subtree.
    g.mutate({
      kind: "issue.update",
      id: "a",
      expectedVersion: g.version("a"),
      data: { title: "Renamed" },
    });
    g.mutate({
      kind: "issue.update",
      id: "a",
      expectedVersion: g.version("a"),
      data: { status: "canceled", closeReason: "duplicate", leaseToken: token },
    });
    // Once the lease ends, the subtree is open to everyone again.
    g.mutate({ kind: "issue.release", id: "project", data: { leaseToken: token } });
    expect(g.state("b")).toBe("ready");
    g.claim("b", "other");
  });

  test("an expired lease no longer covers its subtree", () => {
    const g = graph();
    g.claim("project", "lead", 30);
    expect(g.state("a")).toBe("leased_above");
    g.advance(30_000);
    expect(g.state("a")).toBe("ready");
  });

  test("a parent can't be completed or set done while a sub-issue is open; canceled ones don't count", () => {
    const g = graph();
    const token = g.claim("project", "lead");
    expect(() =>
      g.mutate({
        kind: "issue.complete",
        id: "project",
        data: { leaseToken: token, evidence: "All done" },
      }),
    ).toThrow(/Close its sub-issues first: ENG-2, ENG-3/);
    for (const id of ["a", "b"])
      g.mutate({
        kind: "issue.update",
        id,
        expectedVersion: g.version(id),
        data: {
          status: id === "a" ? "done" : "canceled",
          closeReason: id === "a" ? null : "obsolete",
          leaseToken: token,
        },
      });
    expect(g.state("project")).toBe("claimed");
    g.mutate({
      kind: "issue.complete",
      id: "project",
      data: { leaseToken: token, evidence: "All done" },
    });

    const h = graph();
    expect(() =>
      h.mutate({
        kind: "issue.update",
        id: "project",
        expectedVersion: h.version("project"),
        data: { status: "done" },
      }),
    ).toThrow(/Close its sub-issues first/);
  });

  test("blocker cycles are rejected", () => {
    const g = graph();
    g.mutate({ kind: "link.add", id: "l1", data: { fromId: "a", toId: "b", kind: "blocks" } });
    expect(g.state("b")).toBe("blocked");
    expect(() =>
      g.mutate({ kind: "link.add", id: "l2", data: { fromId: "b", toId: "a", kind: "blocks" } }),
    ).toThrow(/acyclic/);
  });
});

describe("agents", () => {
  test("an agent's actions are attributed to it, with its human answerable and its human's access", () => {
    const f = fixture();
    f.issue("work");
    // Team restricted to alice: her agent still gets in through her membership.
    f.mutate({
      kind: "team.update",
      id: "team",
      expectedVersion: 1,
      data: { memberIds: ["alice"] },
    });
    const asAgent: Access = { ...f.access, actorId: "agt-bot", principalId: "alice" };
    const claimed = f.store.mutate(asAgent, {
      operationId: "agent-claim",
      mutations: [{ kind: "issue.claim", id: "work", data: { agent: "session-1" } }],
    });
    const issue = f.store.snapshot(f.access).issues.find((i) => i.id === "work")!;
    expect(issue.claim).toMatchObject({ actorId: "agt-bot", accountableId: "alice" });
    expect(issue.assigneeId).toBe("agt-bot");
    expect(f.reopen().snapshot(f.access).issues[0]!.assigneeId).toBe("agt-bot");
    const audit = f.store.history(f.access, "work", null, 10).events[0]!;
    expect(audit.before).toMatchObject({ assigneeId: null, claim: null });
    expect(audit.entity).toMatchObject({ assigneeId: "agt-bot", claim: { actorId: "agt-bot" } });
    expect(claimed.events.at(-1)?.actorId).toBe("agt-bot");
    // The lease is the agent's: its human holds no claim on it.
    expect(() =>
      f.mutate({
        kind: "issue.release",
        id: "work",
        data: { leaseToken: String(claimed.results[0]!.leaseToken) },
      }),
    ).toThrow(/belongs to another agent/);
    expect(
      f.store.snapshot(f.access).agents.map((a) => `${a.name} for ${a.accountable.slug}`),
    ).toEqual(["bot for alice"]);
  });

  test.each(["bob", "agt-bot"])("claiming preserves the existing assignee %s", (assigneeId) => {
    const f = fixture();
    f.mutate({
      kind: "issue.create",
      id: "assigned",
      data: { teamId: "team", title: "Already assigned", assigneeId },
    });
    const claimed = f.mutate({ kind: "issue.claim", id: "assigned", data: { agent: "session" } });
    expect(f.store.snapshot(f.access).issues[0]).toMatchObject({
      assigneeId,
      claim: { actorId: "alice" },
    });
    f.mutate({
      kind: "issue.renew",
      id: "assigned",
      data: { leaseToken: String(claimed.results[0]!.leaseToken) },
    });
    expect(f.store.snapshot(f.access).issues[0]!.assigneeId).toBe(assigneeId);
  });

  test.each(["alice", "agt-bot"])(
    "an admin claim cannot assign %s outside the restricted team",
    (actorId) => {
      const f = fixture();
      f.mutate({
        kind: "team.update",
        id: "team",
        expectedVersion: 1,
        data: { memberIds: ["bob"] },
      });
      f.issue("work");
      f.access.actorId = actorId;
      expect(() =>
        f.mutate({ kind: "issue.claim", id: "work", data: { agent: "outside-team" } }),
      ).toThrow(expect.objectContaining({ code: "invalid_member", status: 400 }));
      expect(f.store.snapshot(f.access).issues[0]).toMatchObject({
        assigneeId: null,
        claim: null,
        status: "todo",
        version: 1,
      });
      expect(f.db.prepare("SELECT issue_id FROM leases").all()).toEqual([]);
      expect(f.store.history(f.access, "work", null, 10).events.map((event) => event.kind)).toEqual(
        ["issue.create"],
      );
      f.mutate({
        kind: "issue.update",
        id: "work",
        expectedVersion: 1,
        data: { title: "Still editable" },
      });
      expect(f.store.snapshot(f.access).issues[0]!.title).toBe("Still editable");
    },
  );

  test("an out-of-team admin can claim a valid assigned issue without breaking later edits", () => {
    const f = fixture();
    f.mutate({
      kind: "team.update",
      id: "team",
      expectedVersion: 1,
      data: { memberIds: ["bob"] },
    });
    f.mutate({
      kind: "issue.create",
      id: "work",
      data: { teamId: "team", title: "Work", assigneeId: "bob" },
    });
    f.mutate({ kind: "issue.claim", id: "work", data: { agent: "admin" } });
    f.mutate({
      kind: "issue.update",
      id: "work",
      expectedVersion: 2,
      data: { title: "Edited after claim" },
    });
    expect(f.store.snapshot(f.access).issues[0]).toMatchObject({
      assigneeId: "bob",
      claim: { actorId: "alice" },
      title: "Edited after claim",
      version: 3,
    });
  });

  test("next cannot autoassign an out-of-team admin's delegated agent", () => {
    const f = fixture();
    f.mutate({
      kind: "team.update",
      id: "team",
      expectedVersion: 1,
      data: { memberIds: ["bob"] },
    });
    f.issue("work");
    expect(() =>
      f.mutate({
        kind: "issue.next",
        id: "pick",
        data: { agent: "delegated", forActorId: "agt-bot" },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_member", status: 400 }));
    expect(f.store.snapshot(f.access).issues[0]).toMatchObject({
      assigneeId: null,
      claim: null,
      version: 1,
    });
  });

  test("assignment and claim roll back together when a later mutation fails", () => {
    const f = fixture();
    f.issue("work");
    f.access.actorId = "agt-bot";
    expect(() =>
      f.mutate(
        { kind: "issue.claim", id: "work", data: { agent: "session" } },
        { kind: "issue.update", id: "missing", expectedVersion: 1, data: { title: "Invalid" } },
      ),
    ).toThrow();
    expect(f.store.snapshot(f.access).issues[0]).toMatchObject({
      assigneeId: null,
      claim: null,
      status: "todo",
      version: 1,
    });
  });

  test("an agent can be assigned when its human could be; unknown agents can't", () => {
    const f = fixture();
    f.issue("work");
    f.mutate({
      kind: "issue.update",
      id: "work",
      expectedVersion: 1,
      data: { assigneeId: "agt-bot" },
    });
    expect(f.store.snapshot(f.access).issues[0]!.assigneeId).toBe("agt-bot");
    expect(() =>
      f.mutate({
        kind: "issue.update",
        id: "work",
        expectedVersion: 2,
        data: { assigneeId: "agt-stranger" },
      }),
    ).toThrow(/not a current account member/);
  });
});

describe("issue.next", () => {
  function board() {
    const f = fixture();
    const make = (id: string, data: Record<string, unknown> = {}) =>
      f.mutate({ kind: "issue.create", id, data: { teamId: "team", title: id, ...data } });
    let n = 0;
    const next = (data: Record<string, unknown> = {}, operationId = `next-${++n}`) =>
      f.store.mutate(f.access, {
        operationId,
        mutations: [
          { kind: "issue.next", id: `pick-${operationId}`, data: { agent: "walker", ...data } },
        ],
      }).results[0]!;
    return { ...f, make, next };
  }

  test("takes the highest priority, then whatever unblocks the most work, then the oldest", () => {
    const b = board();
    b.make("old", { priority: 2 });
    b.advance(1000);
    b.make("leaf", { priority: 2 });
    b.make("hub", { priority: 2 });
    b.make("after-1", { priority: 3 });
    b.make("after-2", { priority: 3 });
    b.make("urgent", { priority: 1 });
    b.mutate(
      { kind: "link.add", id: "l1", data: { fromId: "hub", toId: "after-1", kind: "blocks" } },
      { kind: "link.add", id: "l2", data: { fromId: "after-1", toId: "after-2", kind: "blocks" } },
    );
    expect(b.next().key).toBe("ENG-6");
    expect(b.next().key).toBe("ENG-3");
    expect(b.next().key).toBe("ENG-1");
    expect(b.next().key).toBe("ENG-2");
  });

  test("skips containers, PRDs, blocked work and other people's assignments, and stays in scope", () => {
    const b = board();
    b.make("project");
    b.make("child", { parentId: "project" });
    b.make("prd", { type: "prd" });
    b.make("theirs", { assigneeId: "bob" });
    b.make("blocked");
    b.make("blocker", { status: "backlog" });
    b.mutate({
      kind: "link.add",
      id: "l1",
      data: { fromId: "blocker", toId: "blocked", kind: "blocks" },
    });
    b.make("tagged", { workspaceIds: ["workspace"] });
    expect(b.next({ workspaceId: "workspace" })).toMatchObject({ issueId: "tagged" });
    expect(b.next({ underId: "project" })).toMatchObject({ issueId: "child" });
    // Everything left is a container, a PRD, someone else's, blocked or in the backlog.
    expect(b.next().issueId).toBeUndefined();
    expect(b.next({ teamId: "team" }).leaseToken).toBeUndefined();
  });

  test("claims atomically: two callers never get the same issue, and a retry returns the same claim", () => {
    const b = board();
    b.make("a");
    b.make("b");
    const first = b.next({}, "op-1");
    const replay = b.next({}, "op-1");
    const second = b.next({}, "op-2");
    expect(replay).toEqual(first);
    expect([first.issueId!, second.issueId!].sort((x, y) => x.localeCompare(y))).toEqual([
      "a",
      "b",
    ]);
    const claimed = b.store.snapshot(b.access).issues.find((i) => i.id === first.issueId)!;
    expect(claimed).toMatchObject({
      status: "in_progress",
      assigneeId: "alice",
      claim: { agent: "walker" },
    });
    // The token is a real lease on the issue it named.
    b.mutate({
      kind: "issue.complete",
      id: first.issueId!,
      data: { leaseToken: first.leaseToken!, evidence: "Done" },
    });
  });
});

describe("taking over a claim", () => {
  test("an owner, as themselves, takes over a live claim; the holder's token stops working", () => {
    const f = fixture();
    f.issue("issue");
    const holder: Access = { ...f.access, actorId: "agt-bot" };
    const held = f.store.mutate(holder, {
      operationId: "held",
      mutations: [
        { kind: "issue.claim", id: "issue", data: { agent: "lost-session", ttlSeconds: 86400 } },
      ],
    }).results[0]!;
    // Not an owner, or an owner's agent: refused.
    expect(() =>
      f.store.mutate(
        { ...f.access, canAdmin: false },
        {
          operationId: "member",
          mutations: [{ kind: "issue.claim", id: "issue", data: { agent: "x", force: true } }],
        },
      ),
    ).toThrow(/tracker owner/);
    expect(() =>
      f.store.mutate(holder, {
        operationId: "agent",
        mutations: [{ kind: "issue.claim", id: "issue", data: { agent: "x", force: true } }],
      }),
    ).toThrow(/tracker owner/);
    // Without force it's still busy.
    expect(() => f.mutate({ kind: "issue.claim", id: "issue", data: { agent: "x" } })).toThrow(
      /active claim/,
    );

    const taken = f.mutate({
      kind: "issue.claim",
      id: "issue",
      data: { agent: "alice-cli", force: true },
    });
    const token = String(taken.results[0]!.leaseToken);
    const snapshot = f.store.snapshot(f.access);
    const issue = snapshot.issues.find((i) => i.id === "issue")!;
    expect(issue).toMatchObject({
      status: "in_progress",
      claim: { agent: "alice-cli", actorId: "alice" },
    });
    expect(issue.attempts ?? 0).toBe(0);
    expect(snapshot.comments.find((c) => c.issueId === "issue")?.body).toMatch(
      /Took over the claim held by `lost-session`/,
    );
    expect(() =>
      f.store.mutate(holder, {
        operationId: "old",
        mutations: [
          {
            kind: "issue.complete",
            id: "issue",
            data: { leaseToken: String(held.leaseToken), evidence: "x" },
          },
        ],
      }),
    ).toThrow(/expired, was superseded/);
    // Or end it outright (the web's "End claim"): back to todo, no failure counted.
    f.mutate({ kind: "issue.release", id: "issue", data: { force: true } });
    const ended = f.store.snapshot(f.access).issues.find((i) => i.id === "issue")!;
    expect(ended).toMatchObject({ status: "todo", claim: null });
    expect(ended.attempts ?? 0).toBe(0);
    expect(() => f.mutate({ kind: "issue.release", id: "issue", data: { force: true } })).toThrow(
      /Nobody holds/,
    );
    expect(() =>
      f.mutate({ kind: "issue.complete", id: "issue", data: { leaseToken: token, evidence: "x" } }),
    ).toThrow();
    const again = f.mutate({ kind: "issue.claim", id: "issue", data: { agent: "alice-cli" } });
    f.mutate({
      kind: "issue.complete",
      id: "issue",
      data: { leaseToken: String(again.results[0]!.leaseToken), evidence: "Shipped" },
    });
    expect(f.store.snapshot(f.access).issues.find((i) => i.id === "issue")?.status).toBe("done");
  });
});

describe("delegated leases", () => {
  function tree() {
    const f = fixture();
    const make = (id: string, parentId?: string) =>
      f.mutate({
        kind: "issue.create",
        id,
        data: { teamId: "team", title: id, ...(parentId ? { parentId } : {}) },
      });
    make("project");
    make("child", "project");
    make("grandchild", "child");
    make("sibling", "project");
    const asBot: Access = { ...f.access, actorId: "agt-bot" };
    let n = 0;
    const as = (access: Access, ...mutations: Mutation[]) =>
      f.store.mutate(access, { operationId: `d-${++n}`, mutations });
    const version = (id: string) =>
      f.store.snapshot(f.access).issues.find((i) => i.id === id)!.version;
    const claimOf = (id: string) =>
      f.store.snapshot(f.access).issues.find((i) => i.id === id)!.claim;
    const lead = String(
      f.mutate({ kind: "issue.claim", id: "project", data: { agent: "lead" } }).results[0]!
        .leaseToken,
    );
    return { ...f, asBot, as, version, claimOf, lead };
  }

  test("the subtree's holder delegates a child to one of its own agents, who works it with its own token", () => {
    const t = tree();
    const delegated = t.mutate({
      kind: "issue.claim",
      id: "child",
      data: { agent: "sub", underToken: t.lead, forActorId: "agt-bot" },
    });
    const child = String(delegated.results[0]!.leaseToken);
    expect(t.claimOf("child")).toMatchObject({
      actorId: "agt-bot",
      accountableId: "alice",
      delegatedFrom: "project",
    });
    expect(t.store.snapshot(t.access).issues.find((i) => i.id === "child")!.assigneeId).toBe(
      "agt-bot",
    );
    // The lead's token no longer speaks for the delegated child; the child's does, for its holder.
    expect(() =>
      t.mutate({
        kind: "issue.update",
        id: "child",
        expectedVersion: t.version("child"),
        data: { status: "backlog", leaseToken: t.lead },
      }),
    ).toThrow(/belongs to another agent/);
    // A child token can't change anything above it.
    expect(() =>
      t.as(t.asBot, {
        kind: "issue.update",
        id: "project",
        expectedVersion: t.version("project"),
        data: { status: "todo", leaseToken: child },
      }),
    ).toThrow(/belongs to another agent/);
    t.as(t.asBot, {
      kind: "issue.update",
      id: "grandchild",
      expectedVersion: t.version("grandchild"),
      data: { status: "done", leaseToken: child },
    });
    t.as(t.asBot, {
      kind: "issue.complete",
      id: "child",
      data: { leaseToken: child, evidence: "Done" },
    });
  });

  test("delegation needs the covering lease's token, and only to yourself or your own agents", () => {
    const t = tree();
    expect(() =>
      t.mutate({ kind: "issue.claim", id: "child", data: { agent: "x", underToken: "wrong" } }),
    ).toThrow(/doesn't hold ENG-1's lease/);
    expect(() =>
      t.mutate({
        kind: "issue.claim",
        id: "child",
        data: { agent: "x", underToken: t.lead, forActorId: "agt-stranger" },
      }),
    ).toThrow(/your own agents/);
    expect(() =>
      t.mutate({ kind: "issue.claim", id: "sibling", data: { agent: "x", forActorId: "agt-bot" } }),
    ).toThrow(/leased by lead/);
    // Delegating to yourself is allowed too.
    t.mutate({ kind: "issue.claim", id: "sibling", data: { agent: "x", underToken: t.lead } });
    expect(t.claimOf("sibling")).toMatchObject({ actorId: "alice", delegatedFrom: "project" });
  });

  test("any lease above a claim can revoke it, which fences its token; others can't", () => {
    const t = tree();
    const childToken = String(
      t.mutate({
        kind: "issue.claim",
        id: "child",
        data: { agent: "sub", underToken: t.lead, forActorId: "agt-bot" },
      }).results[0]!.leaseToken,
    );
    const deep = String(
      t.as(t.asBot, {
        kind: "issue.claim",
        id: "grandchild",
        data: { agent: "deeper", underToken: childToken },
      }).results[0]!.leaseToken,
    );
    expect(() =>
      t.mutate({ kind: "issue.revoke", id: "grandchild", data: { underToken: "nope" } }),
    ).toThrow(/Only the holder of a lease above/);
    // The project's holder reaches past the child to the grandchild.
    t.mutate({ kind: "issue.revoke", id: "grandchild", data: { underToken: t.lead } });
    expect(t.claimOf("grandchild")).toBeNull();
    expect(() =>
      t.as(t.asBot, { kind: "issue.renew", id: "grandchild", data: { leaseToken: deep } }),
    ).toThrow(/expired, was superseded/);
    t.mutate({ kind: "issue.revoke", id: "child", data: { underToken: t.lead } });
    expect(t.claimOf("child")).toBeNull();
  });

  test("next picks inside your own leased subtree only with its token", () => {
    const t = tree();
    const pick = (data: Record<string, unknown>) =>
      t.mutate({
        kind: "issue.next",
        id: `p-${JSON.stringify(data).length}`,
        data: { agent: "w", ...data },
      }).results[0]!;
    expect(pick({ underId: "project" }).issueId).toBeUndefined();
    const own = pick({ underId: "project", underToken: t.lead, forActorId: "agt-bot" });
    expect(["grandchild", "sibling"]).toContain(own.issueId);
    expect(t.claimOf(own.issueId!)).toMatchObject({ actorId: "agt-bot", delegatedFrom: "project" });
    expect(t.store.snapshot(t.access).issues.find((i) => i.id === own.issueId)!.assigneeId).toBe(
      "agt-bot",
    );
  });
});

describe("waiting on a person", () => {
  function waiting() {
    const f = fixture();
    f.issue("work");
    const bot: Access = { ...f.access, actorId: "agt-bot" };
    let n = 0;
    const as = (access: Access, ...mutations: Mutation[]) =>
      f.store.mutate(access, { operationId: `w-${++n}`, mutations });
    const issue = () => f.store.snapshot(f.access).issues.find((i) => i.id === "work")!;
    const request = (id: string) =>
      f.store.snapshot(f.access).requests.find((r) => r.id === id) as HumanRequest;
    const state = () => {
      const snap = f.store.snapshot(f.access);
      const index = readinessIndex(snap.issues, snap.links);
      return readiness(index.byId.get("work")!, index, snap.serverTime);
    };
    const token = String(
      as(bot, { kind: "issue.claim", id: "work", data: { agent: "session" } }).results[0]!
        .leaseToken,
    );
    return { ...f, bot, as, issue, request, state, token };
  }

  test("asking with the lease parks it: the issue waits, in progress, and the lease outlives its ttl", () => {
    const w = waiting();
    w.as(w.bot, {
      kind: "request.open",
      id: "q1",
      data: { issueId: "work", kind: "question", prompt: "Which region?", leaseToken: w.token },
    });
    expect(w.issue()).toMatchObject({ status: "in_progress", waiting: 1 });
    expect(w.issue().claim?.parkedAt).toBeTruthy();
    expect(w.request("q1")).toMatchObject({ status: "open", askedBy: "agt-bot", routeTo: "alice" });
    expect(w.state()).toBe("waiting");
    w.advance(2 * 86_400_000);
    expect(() => w.mutate({ kind: "issue.claim", id: "work", data: { agent: "thief" } })).toThrow(
      /active claim/,
    );
  });

  test("a person answers, the lease unparks for its holder to resume with a fresh token", () => {
    const w = waiting();
    w.as(w.bot, {
      kind: "request.open",
      id: "q1",
      data: { issueId: "work", kind: "question", prompt: "Which region?", leaseToken: w.token },
    });
    expect(() =>
      w.as(w.bot, { kind: "request.answer", id: "q1", data: { answer: "Me, answering myself" } }),
    ).toThrow(/a person has to/);
    expect(() => w.as(w.bot, { kind: "issue.resume", id: "work", data: {} })).toThrow(
      /open requests/,
    );
    w.mutate({ kind: "request.answer", id: "q1", data: { answer: "eu-west" } });
    expect(w.request("q1")).toMatchObject({
      status: "answered",
      answer: "eu-west",
      answeredBy: "alice",
    });
    expect(w.issue().waiting).toBe(0);
    expect(w.issue().claim?.parkedAt).toBeUndefined();
    expect(() => w.mutate({ kind: "issue.resume", id: "work", data: {} })).toThrow(/lease holder/);
    const resumed = String(
      w.as(w.bot, { kind: "issue.resume", id: "work", data: {} }).results[0]!.leaseToken,
    );
    expect(resumed).not.toBe(w.token);
    expect(() =>
      w.as(w.bot, { kind: "issue.renew", id: "work", data: { leaseToken: w.token } }),
    ).toThrow(/superseded/);
    w.as(w.bot, {
      kind: "issue.complete",
      id: "work",
      data: { leaseToken: resumed, evidence: "Done" },
    });
  });

  test("if the holder doesn't come back within the window, anyone can take the work", () => {
    const w = waiting();
    w.as(w.bot, {
      kind: "request.open",
      id: "q1",
      data: { issueId: "work", kind: "question", prompt: "?", leaseToken: w.token },
    });
    w.mutate({ kind: "request.answer", id: "q1", data: { answer: "!" } });
    w.advance(RESUME_WINDOW_SECONDS * 1000);
    expect(w.state()).toBe("ready");
    w.mutate({ kind: "issue.claim", id: "work", data: { agent: "someone" } });
  });

  test("each kind takes its own answer, and credentials are recorded only as where they went", () => {
    const w = waiting();
    w.as(
      w.bot,
      {
        kind: "request.open",
        id: "d",
        data: { issueId: "work", kind: "decision", prompt: "Pick", choices: ["A", "B"] },
      },
      {
        kind: "request.open",
        id: "a",
        data: { issueId: "work", kind: "approval", prompt: "Ship?" },
      },
      {
        kind: "request.open",
        id: "c",
        data: {
          issueId: "work",
          kind: "credential",
          prompt: "Deploy token",
          secret: { repo: "org/private", name: "DEPLOY_TOKEN" },
        },
      },
    );
    expect(w.issue().waiting).toBe(3);
    expect(() => w.mutate({ kind: "request.answer", id: "d", data: { choice: "C" } })).toThrow(
      /Choose one of: A, B/,
    );
    w.mutate({ kind: "request.answer", id: "d", data: { choice: "B" } });
    w.mutate({ kind: "request.answer", id: "a", data: { approved: false, answer: "Not yet" } });
    expect(() =>
      w.mutate({ kind: "request.answer", id: "c", data: { answer: "s3cr3t", stored: true } }),
    ).toThrow(/no value/);
    w.mutate({ kind: "request.answer", id: "c", data: { stored: true } });
    expect(["d", "a", "c"].map((id) => w.request(id).answer)).toEqual([
      "B",
      "rejected · Not yet",
      "Stored as DEPLOY_TOKEN on org/private",
    ]);
    expect(JSON.stringify(w.store.snapshot(w.access))).not.toContain("s3cr3t");
    expect(w.issue().waiting).toBe(0);
    expect(() =>
      w.as(w.bot, {
        kind: "request.open",
        id: "x",
        data: { issueId: "work", kind: "decision", prompt: "?", choices: ["one"] },
      }),
    ).toThrow(/at least two choices/);
  });

  test("only the asker cancels; requests can be routed to another member, not an outsider", () => {
    const w = waiting();
    w.as(w.bot, {
      kind: "request.open",
      id: "q",
      data: { issueId: "work", kind: "question", prompt: "?", routeTo: "bob" },
    });
    expect(w.request("q").routeTo).toBe("bob");
    expect(() =>
      w.as(w.bot, {
        kind: "request.open",
        id: "q2",
        data: { issueId: "work", kind: "question", prompt: "?", routeTo: "outsider" },
      }),
    ).toThrow(/not a current account member/);
    expect(() =>
      w.store.mutate(
        { ...w.access, actorId: "bob", principalId: "bob", canAdmin: false },
        { operationId: "bob-cancel", mutations: [{ kind: "request.cancel", id: "q" }] },
      ),
    ).toThrow(/Only whoever asked/);
    w.as(w.bot, { kind: "request.cancel", id: "q" });
    expect(w.request("q").status).toBe("canceled");
    expect(w.issue().waiting).toBe(0);
  });
});

describe("handoff", () => {
  function handoff() {
    const f = fixture();
    f.issue("work");
    const bot: Access = { ...f.access, actorId: "agt-bot" };
    const bob: Access = { ...f.access, actorId: "bob", principalId: "bob" };
    let n = 0;
    const as = (access: Access, ...mutations: Mutation[]) =>
      f.store.mutate(access, { operationId: `h-${++n}`, mutations });
    const issue = () => f.store.snapshot(f.access).issues.find((i) => i.id === "work")!;
    const giver = String(
      as(bot, { kind: "issue.claim", id: "work", data: { agent: "first" } }).results[0]!.leaseToken,
    );
    const offer = (data: Record<string, unknown> = {}) =>
      String(
        as(bot, { kind: "issue.offer", id: "work", data: { leaseToken: giver, ...data } })
          .results[0]!.offerCode,
      );
    return { ...f, bot, bob, as, issue, giver, offer };
  }

  test("accepting moves the lease and its accountability; the giver's token stops at that moment", () => {
    const h = handoff();
    const code = h.offer();
    expect(code.startsWith("ENG-1.")).toBe(true);
    expect(h.issue().handoff).toMatchObject({ to: null });
    // Until it's accepted, the giver still holds the lease.
    h.as(h.bot, { kind: "issue.renew", id: "work", data: { leaseToken: h.giver } });
    const taken = String(
      h.as(h.bob, { kind: "issue.accept", id: "work", data: { code, agent: "second" } }).results[0]!
        .leaseToken,
    );
    expect(h.issue().claim).toMatchObject({
      actorId: "bob",
      accountableId: "bob",
      agent: "second",
    });
    expect(h.issue().handoff).toBeNull();
    expect(h.issue().assigneeId).toBe("agt-bot");
    expect(() =>
      h.as(h.bot, { kind: "issue.renew", id: "work", data: { leaseToken: h.giver } }),
    ).toThrow(/belongs to another agent/);
    // A code works once.
    expect(() => h.as(h.bob, { kind: "issue.accept", id: "work", data: { code } })).toThrow(
      /expired, used, withdrawn/,
    );
    h.as(h.bob, {
      kind: "issue.complete",
      id: "work",
      data: { leaseToken: taken, evidence: "Done" },
    });
  });

  test("withdrawn, expired and someone else's offers can't be accepted", () => {
    const h = handoff();
    const withdrawn = h.offer();
    h.as(h.bot, { kind: "issue.withdraw", id: "work", data: { leaseToken: h.giver } });
    expect(() =>
      h.as(h.bob, { kind: "issue.accept", id: "work", data: { code: withdrawn } }),
    ).toThrow(/withdrawn/);
    const forAlice = h.offer({ toActorId: "alice" });
    expect(() =>
      h.as(h.bob, { kind: "issue.accept", id: "work", data: { code: forAlice } }),
    ).toThrow(/for someone else/);
    const quick = h.offer({ ttlSeconds: 30 });
    h.advance(30_000);
    expect(() => h.as(h.bob, { kind: "issue.accept", id: "work", data: { code: quick } })).toThrow(
      /expired/,
    );
  });

  test("an offer dies with the lease it was made under", () => {
    const h = handoff();
    const code = h.offer();
    h.as(h.bot, { kind: "issue.release", id: "work", data: { leaseToken: h.giver } });
    expect(h.issue().handoff).toBeNull();
    expect(() => h.as(h.bob, { kind: "issue.accept", id: "work", data: { code } })).toThrow(
      /expired, used, withdrawn/,
    );
  });
});

describe("escalating repeated failures", () => {
  function attempts(limit?: number) {
    const f = fixture();
    if (limit !== undefined)
      f.mutate({
        kind: "team.update",
        id: "team",
        expectedVersion: 1,
        data: { attemptLimit: limit },
      });
    f.issue("flaky");
    const bot: Access = { ...f.access, actorId: "agt-bot" };
    let n = 0;
    const as = (access: Access, ...mutations: Mutation[]) =>
      f.store.mutate(access, { operationId: `e-${++n}`, mutations });
    const issue = () => f.store.snapshot(f.access).issues.find((i) => i.id === "flaky")!;
    const open = () =>
      f.store
        .snapshot(f.access)
        .requests.filter((r) => r.issueId === "flaky" && r.status === "open");
    const fail = (note: string) => {
      const token = String(
        as(bot, { kind: "issue.claim", id: "flaky", data: { agent: "try" } }).results[0]!
          .leaseToken,
      );
      as(bot, {
        kind: "comment.add",
        id: `c-${n}`,
        data: { issueId: "flaky", body: note, kind: "checkpoint" },
      });
      as(bot, { kind: "issue.release", id: "flaky", data: { leaseToken: token } });
    };
    return { ...f, bot, as, issue, open, fail };
  }

  test("the third failed attempt asks the accountable person, with the latest checkpoints, and leaves ready", () => {
    const e = attempts();
    e.fail("Tried the cache");
    e.fail("Tried a retry loop");
    expect(e.issue().attempts).toBe(2);
    expect(e.open()).toHaveLength(0);
    e.fail("Tried a bigger timeout");
    const [ask] = e.open();
    expect(ask).toMatchObject({ kind: "question", routeTo: "alice", escalation: true });
    expect(ask!.prompt).toContain("released ENG-1 3 times");
    expect(ask!.prompt).toContain("> Tried a bigger timeout");
    expect(e.issue().waiting).toBe(1);
    expect(() =>
      e.as(e.bot, { kind: "issue.claim", id: "flaky", data: { agent: "again" } }),
    ).toThrow(/waiting on a person/);
    expect(
      e.as(e.bot, { kind: "issue.next", id: "pick", data: { agent: "walker" } }).results[0]!
        .issueId,
    ).toBeUndefined();
    // The answer is the guidance, and the attempts start over.
    e.mutate({ kind: "request.answer", id: ask!.id, data: { answer: "Mock the clock instead." } });
    expect(e.issue()).toMatchObject({ attempts: 0, waiting: 0 });
    e.as(e.bot, { kind: "issue.claim", id: "flaky", data: { agent: "again" } });
  });

  test("a team can ask sooner, or never", () => {
    const soon = attempts(1);
    soon.fail("Once");
    expect(soon.open()).toHaveLength(1);
    const never = attempts(0);
    for (const note of ["1", "2", "3", "4"]) never.fail(note);
    expect(never.issue().attempts).toBe(4);
    expect(never.open()).toHaveLength(0);
  });
});

describe("shipped issues for release notes", () => {
  function shipping() {
    const f = fixture();
    const version = (id: string) =>
      f.store.snapshot(f.access).issues.find((issue) => issue.id === id)!.version;
    const status = (id: string, value: Issue["status"]) =>
      f.mutate({ kind: "issue.update", id, expectedVersion: version(id), data: { status: value } });
    const hour = 3_600_000;
    f.issue("leased");
    f.issue("reopened");
    f.issue("redone");
    f.issue("open");
    f.advance(hour);
    const lease = f.mutate({ kind: "issue.claim", id: "leased", data: { agent: "agent" } });
    f.mutate({
      kind: "issue.complete",
      id: "leased",
      data: { leaseToken: String(lease.results[0]!.leaseToken), evidence: "Shipped in abc123" },
    });
    f.advance(hour);
    status("reopened", "done");
    status("redone", "done");
    f.advance(hour);
    status("reopened", "todo");
    status("redone", "todo");
    f.advance(hour);
    status("redone", "done");
    // Edits after completion don't move it.
    f.advance(hour);
    f.mutate({
      kind: "issue.update",
      id: "redone",
      expectedVersion: version("redone"),
      data: { title: "Renamed" },
    });
    return f;
  }

  test("look up by key with team, completion time and evidence; unknown keys are skipped", () => {
    const f = shipping();
    const found = f.store.issuesByKey(["ENG-3", "ENG-1", "ENG-2", "ENG-4", "UTF-8"]);
    const byKey = Object.fromEntries(found.map((issue) => [issue.key, issue]));
    expect(Object.keys(byKey).sort()).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4"]);
    expect(byKey["ENG-1"]).toMatchObject({
      title: "leased",
      status: "done",
      team: { id: "team", key: "ENG", name: "Engineering" },
      completedAt: "2026-10-01T01:00:00.000Z",
      evidence: [
        { body: "Shipped in abc123", actorId: "alice", createdAt: "2026-10-01T01:00:00.000Z" },
      ],
    });
    expect(byKey["ENG-2"]).toMatchObject({ status: "todo", completedAt: null, evidence: [] });
    expect(byKey["ENG-3"]).toMatchObject({
      title: "Renamed",
      completedAt: "2026-10-01T04:00:00.000Z",
    });
    expect(byKey["ENG-4"]!.completedAt).toBeNull();
    expect(f.store.issuesByKey([])).toEqual([]);
  });

  test("completed in a window counts the latest completion of issues still done", () => {
    const f = shipping();
    const keys = (since: string, until: string) =>
      f.store.completedBetween(since, until, 100).map((issue) => issue.key);
    expect(keys("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")).toEqual(["ENG-1", "ENG-3"]);
    // The first completion of a reopened-then-redone issue is not its completion.
    expect(keys("2026-10-01T01:30:00Z", "2026-10-01T03:30:00Z")).toEqual([]);
    expect(keys("2026-10-01T04:00:00.000Z", "2026-10-01T04:00:00.001Z")).toEqual(["ENG-3"]);
    expect(keys("2026-10-01T01:00:00.001Z", "2026-10-01T04:00:00.000Z")).toEqual([]);
    expect(
      f.store.completedBetween("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z", 1),
    ).toHaveLength(1);
    expect(() => f.store.completedBetween("yesterday", "2026-10-02T00:00:00Z", 10)).toThrow(/ISO/);
    expect(() =>
      f.store.issuesByKey(Array.from({ length: 501 }, (_, i) => `ENG-${i + 1}`)),
    ).toThrow(/500/);
  });
});
