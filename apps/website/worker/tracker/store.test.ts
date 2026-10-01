import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { Mutation } from "../../shared/tracker.ts";
import { TrackerStore, type Access, type SqlDatabase } from "./store.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql: SqlDatabase = {
    exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]) {
      if (query.includes("CREATE TABLE")) {
        db.exec(query);
        return {
          toArray: () => [] as T[],
          one: (): T => {
            throw new Error("DDL has no rows");
          },
        };
      }
      const rows = db.prepare(query).all(...(bindings as SQLInputValue[])) as T[];
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error("Expected exactly one SQL row");
          return rows[0]!;
        },
      };
    },
  };
  let now = Date.parse("2026-10-01T00:00:00Z");
  const store = new TrackerStore(
    sql,
    (fn) => {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    () => now,
  );
  const access: Access = {
    actorId: "alice",
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
    store,
    access,
    mutate,
    issue,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

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
      data: { status: "canceled" },
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
    expect(() => f.store.mutate({ ...f.access, actorId: "bob" }, request)).toThrow(
      /different actor/,
    );
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
        { ...f.access, actorId: "bob", canAdmin: false },
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
