// `gm issue next --tag` (CORE-253): next picks only among issues with any of
// the wanted tags and none of the excluded ones, like the web's
// `tag:a tag:b -tag:c`, case-insensitively.

import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { Issue, Mutation } from "../../shared/tracker.ts";
import { TrackerError, TrackerStore, type Access } from "./store.ts";
import { trackerSql, transactional } from "../testing/tracker.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const store = new TrackerStore(trackerSql(db), transactional(db), () =>
    Date.parse("2026-10-01T00:00:00Z"),
  );
  const alice = { id: "alice", slug: "alice", displayName: "Alice" };
  const owner: Access = {
    actorId: "alice",
    principalId: "alice",
    agents: [],
    owner: { id: "org", slug: "org", displayName: "Org" },
    canAdmin: true,
    members: [alice],
    repos: [],
  };
  let n = 0;
  const run = (...mutations: Mutation[]) =>
    store.mutate(owner, { operationId: `op-${++n}`, mutations });
  run({ kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering" } });
  const create = (id: string, tags: string[], priority: Issue["priority"] = 2) =>
    run({ kind: "issue.create", id, data: { teamId: "team", title: id, tags, priority } });
  const issue = (id: string) => store.snapshot(owner).issues.find((i) => i.id === id) as Issue;
  const next = (data: Record<string, unknown>) =>
    run({ kind: "issue.next", id: crypto.randomUUID(), data: { agent: "w", ...data } }).results[0]!;
  return { create, issue, next };
}

describe("issue.next with tags", () => {
  test("picks only issues with any of the wanted tags", () => {
    const f = fixture();
    f.create("urgent", ["backend"], 0);
    f.create("ui", ["ux"]);
    f.create("both", ["UX", "frontend"], 3);
    expect(f.next({ tags: ["Ux", "frontend"] }).key).toBe(f.issue("ui").key);
    expect(f.next({ tags: ["ux"] }).key).toBe(f.issue("both").key);
    // Nothing else is tagged ux: nothing ready, and the backend issue stays unclaimed.
    expect(f.next({ tags: ["ux"] }).issueId).toBeUndefined();
    expect(f.issue("urgent").claim).toBeNull();
  });

  test("never picks an issue with an excluded tag", () => {
    const f = fixture();
    f.create("urgent", ["backend", "ai"], 0);
    f.create("plain", []);
    expect(f.next({ excludeTags: ["AI"] }).key).toBe(f.issue("plain").key);
    expect(f.issue("urgent").claim).toBeNull();
  });

  test("without tags, next is unchanged", () => {
    const f = fixture();
    f.create("urgent", ["backend"], 0);
    f.create("ui", ["ux"]);
    expect(f.next({}).key).toBe(f.issue("urgent").key);
  });

  test("refuses tags that aren't a list of names", () => {
    const f = fixture();
    expect(() => f.next({ tags: "ux" })).toThrow(TrackerError);
    expect(() => f.next({ excludeTags: [42] })).toThrow(TrackerError);
  });
});
