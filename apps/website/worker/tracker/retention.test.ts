// Tracker retention (CORE-203) over the store's real SQL: what each category
// selects and never selects, dry run = run across batches, idempotence,
// tombstones (404 with a reason, keys and slugs never reused), and replicas
// converging through the change feed (or starting over below its floor).

import { describe, expect, test } from "vite-plus/test";
import type { Mutation, Snapshot, TrackerEvent } from "../../shared/tracker.ts";
import { durableStorage } from "../testing/durable.ts";
import { TrackerStore, type Access } from "./store.ts";
import {
  feedFloor,
  removeActivity,
  removeClosedIssues,
  selectActivity,
  selectClosedIssues,
  type TrackerSelection,
} from "./retention.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2025-01-01T00:00:00Z");
const oid = (n: number) => n.toString(16).padStart(40, "0");

function setup() {
  const { db, sql, transactionSync } = durableStorage();
  let now = T0;
  const store = new TrackerStore(sql, transactionSync, () => now);
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
  const mutate = (mutations: Mutation[], timeline?: string) =>
    store.mutate(access, {
      operationId: `op-${++operation}`,
      mutations,
      ...(timeline ? { timeline } : {}),
    });
  const issue = (id: string, data: Record<string, unknown> = {}) =>
    mutate([{ kind: "issue.create", id, data: { teamId: "team", title: id, ...data } }]);
  /** An issue change at its current version (in a timeline's view with `timeline`). */
  const update = (id: string, data: Record<string, unknown>, timeline?: string) => {
    const issue = store.snapshot(access, timeline).issues.find((i) => i.id === id)!;
    return mutate([{ kind: "issue.update", id, expectedVersion: issue.version, data }], timeline);
  };
  const close = (id: string, status = "done") =>
    update(id, { status, ...(status === "canceled" ? { closeReason: "obsolete" } : {}) });
  const fork = (slug: string, parent: string | null = null) =>
    store.timelines.create(access, {
      slug,
      parent,
      repos: [{ id: "app", owner: "org", name: "app" }],
      commits: { app: oid(1) },
    });
  mutate([{ kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering" } }]);
  return {
    db,
    sql,
    store,
    access,
    mutate,
    issue,
    update,
    close,
    fork,
    at: (days: number) => {
      now = T0 + days * DAY;
    },
    snapshot: (withTimelines = false) => store.snapshot(access, undefined, withTimelines),
  };
}

type Fixture = ReturnType<typeof setup>;

/**
 * Closed on day 0 and quiet since (A, B linked, A with a comment): removed.
 * Kept: C (closed, linked to open D), E (closed child of open P), F (closed,
 * commented on day 300), G (closed on day 300), H (closed, changed in a
 * timeline still on record), D and P (open).
 */
function seeded() {
  const f = setup();
  for (const id of ["A", "B", "C", "D", "E", "F", "G", "H", "P"]) f.issue(id);
  f.update("E", { parentId: "P" });
  f.mutate([
    { kind: "link.add", id: "l-ab", data: { fromId: "A", toId: "B", kind: "blocks" } },
    { kind: "link.add", id: "l-cd", data: { fromId: "D", toId: "C", kind: "related" } },
    { kind: "comment.add", id: "c-a", data: { issueId: "A", body: "Shipped." } },
  ]);
  f.fork("old");
  f.update("H", { title: "H, as old saw it" }, "old");
  for (const id of ["A", "C", "E", "F", "H"]) f.close(id);
  f.close("B", "canceled");
  f.at(300);
  f.mutate([{ kind: "comment.add", id: "c-f", data: { issueId: "F", body: "Still relevant." } }]);
  f.close("G");
  return f;
}

const NOW = new Date(T0 + 400 * DAY).toISOString();
const CLOSED = { days: 365 };
const ACTIVITY = { eventDays: 365, endedTimelineDays: 180 };

/** Every page of a category's selection, removing each page first when `run`. */
function pages(
  f: Fixture,
  category: "closed" | "activity",
  thresholds: Record<string, number>,
  run: boolean,
  limit = 1,
) {
  const select = category === "closed" ? selectClosedIssues : selectActivity;
  const remove = category === "closed" ? removeClosedIssues : removeActivity;
  const out: { items: string[]; count: number; bytes: number }[] = [];
  let cursor: string | null = null;
  do {
    const page: TrackerSelection = select(f.sql, thresholds, NOW, cursor, limit);
    let { count, bytes } = page;
    if (run && page.items.length)
      ({ count, bytes } = remove(f.sql, thresholds, NOW, page.items, NOW));
    out.push({ items: page.items, count, bytes });
    cursor = page.next;
  } while (cursor !== null);
  return out;
}

const ids = (snapshot: Snapshot, key: "issues" | "links" | "comments") =>
  snapshot[key].map((entity) => entity.id).sort();

/** What gm does with the feed: replace or drop each entity by id. */
function replay(base: Snapshot, events: TrackerEvent[]): Snapshot {
  const out = structuredClone(base) as unknown as Record<string, { id: string }[]>;
  const tables: Record<string, string> = {
    issue: "issues",
    link: "links",
    comment: "comments",
    request: "requests",
    team: "teams",
    workspace: "workspaces",
    subscription: "subscriptions",
  };
  for (const event of events) {
    const table = tables[event.entityType];
    if (!table) continue;
    out[table] = out[table]!.filter((row) => row.id !== event.entityId);
    if (event.entity) out[table]!.push(event.entity as { id: string });
  }
  return out as unknown as Snapshot;
}

describe("closed issues", () => {
  test("removes quiet closed components only, never open, linked, active or recent work", () => {
    const f = seeded();
    const selected = pages(f, "closed", CLOSED, false).flatMap((page) => page.items);
    expect(selected).toEqual(["A", "B"]);
    // Not yet: 365 days after closing is day 365.
    f.at(300);
    expect(
      selectClosedIssues(f.sql, CLOSED, new Date(T0 + 364 * DAY).toISOString(), null, 10),
    ).toMatchObject({ items: [], next: null });
  });

  test("a dry run lists exactly what the run removes, batch by batch, and runs twice harmlessly", () => {
    const f = seeded();
    const dry = pages(f, "closed", CLOSED, false);
    const logged = f.db
      .prepare(
        `SELECT count(*) AS n FROM events WHERE json_extract(data, '$.entityId') IN ('A', 'B', 'c-a', 'l-ab')`,
      )
      .get() as { n: number };
    const run = pages(f, "closed", CLOSED, true);
    expect(run).toEqual(dry);
    // Two issues, a comment, a link and their events, nothing else.
    expect(dry.reduce((sum, page) => sum + page.count, 0)).toBe(4 + logged.n);
    const after = f.snapshot();
    expect(ids(after, "issues")).toEqual(["C", "D", "E", "F", "G", "H", "P"]);
    expect(ids(after, "links")).toEqual(["l-cd"]);
    expect(ids(after, "comments")).toEqual(["c-f"]);
    expect(pages(f, "closed", CLOSED, true)).toEqual([{ items: [], count: 0, bytes: 0 }]);
    expect(removeClosedIssues(f.sql, CLOSED, NOW, ["A", "B", "C"], NOW)).toEqual({
      count: 0,
      bytes: 0,
    });
    // Nothing of theirs is left behind: events, history rows, receipts.
    const left = f.db
      .prepare(
        `SELECT count(*) AS n FROM events WHERE json_extract(data, '$.entityId') IN ('A', 'B', 'c-a', 'l-ab')
           AND json_extract(data, '$.kind') != 'retention.remove'`,
      )
      .get() as { n: number };
    expect(left.n).toBe(0);
    expect(
      f.db.prepare("SELECT count(*) AS n FROM issue_events WHERE issue_id IN ('A', 'B')").get(),
    ).toEqual({ n: 0 });
    expect(
      (f.db.prepare("SELECT result FROM receipts").all() as { result: string }[]).filter((r) =>
        /"entityId":"(A|B|c-a|l-ab)"/.test(r.result),
      ),
    ).toEqual([]);
  });

  test("removed issues answer 404 with the reason, and keys and ids are never reused", () => {
    const f = seeded();
    pages(f, "closed", CLOSED, true);
    for (const ref of ["ENG-1", "eng-1", "A"])
      expect(() => f.store.history(f.access, ref, null, 10)).toThrow(
        expect.objectContaining({
          status: 404,
          code: "removed_by_retention",
          message: expect.stringMatching(
            /^Issue ENG-1 was removed by retention on \d{4}-\d\d-\d\d \(done or canceled with no activity for 365 days\)\.$/,
          ),
        }),
      );
    expect(() =>
      f.mutate([{ kind: "issue.update", id: "A", expectedVersion: 1, data: { title: "back" } }]),
    ).toThrow(expect.objectContaining({ code: "removed_by_retention" }));
    expect(() => f.issue("A")).toThrow(/ID already exists/);
    f.issue("Z");
    expect(f.snapshot().issues.find((issue) => issue.id === "Z")!.key).toBe("ENG-10");
    expect(() => f.store.history(f.access, "ENG-404", null, 10)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });

  test("a replica converges through the change feed", () => {
    const f = seeded();
    const replica = f.snapshot();
    pages(f, "closed", CLOSED, true);
    const feed = f.store.changes(replica.cursor, 500);
    expect(feed.events.map((event) => [event.kind, event.entityType, event.entityId])).toEqual(
      expect.arrayContaining([
        ["retention.remove", "issue", "A"],
        ["retention.remove", "issue", "B"],
        ["retention.remove", "comment", "c-a"],
        ["retention.remove", "link", "l-ab"],
      ]),
    );
    const replayed = replay(replica, feed.events as TrackerEvent[]);
    const fresh = f.snapshot();
    for (const key of ["issues", "links", "comments"] as const)
      expect(ids(replayed, key)).toEqual(ids(fresh, key));
  });
});

describe("activity logs and ended timelines", () => {
  test("a retained source dependency keeps ancestor evidence without a parent or merge event", () => {
    const f = setup();
    const ancestor = f.fork("ancestor");
    f.store.timelines.abandon(f.access, "ancestor", { app: oid(1) });
    const child = f.fork("independent");
    const source = {
      sourceId: "work_ancestor",
      repoId: "app",
      kind: "timeline-work",
      timelineId: ancestor.id,
      ref: "refs/heads/work",
      commit: oid(1),
      tree: oid(2),
    };
    f.sql.exec(
      "UPDATE timelines SET data=json_set(data,'$.repos[0].dependencies',json(?)) WHERE id=?",
      JSON.stringify([
        { source, base: { ...source, sourceId: "canonical", kind: "canonical", timelineId: null } },
      ]),
      child.id,
    );
    expect(selectActivity(f.sql, ACTIVITY, NOW, "t:", 100).items).not.toContain(`t:${ancestor.id}`);
    f.sql.exec(
      "UPDATE timelines SET data=json_set(data,'$.repos[0].dependencies',json('[]')) WHERE id=?",
      child.id,
    );
    expect(selectActivity(f.sql, ACTIVITY, NOW, "t:", 100).items).toContain(`t:${ancestor.id}`);
    f.db.close();
  });

  function timelines() {
    const f = seeded();
    // "old" (H changed in it) and "gone" ended on day 0; "parent" too, but
    // "child", still open, forked from it; "open" is active.
    f.at(0);
    f.fork("gone");
    f.fork("parent");
    f.fork("child", "parent");
    f.fork("open");
    for (const slug of ["old", "gone", "parent"])
      f.store.timelines.abandon(f.access, slug, { app: null });
    return f;
  }

  test("keeps open work's history, the newest event of what exists, and open or referenced timelines", () => {
    const f = timelines();
    f.at(400);
    const selected = pages(f, "activity", ACTIVITY, false, 500).flatMap((page) => page.items);
    const timelineItems = selected.filter((item) => item.startsWith("t:"));
    const slugs = Object.fromEntries(
      f.store.timelines.list().map((timeline) => [timeline.id, timeline.slug]),
    );
    expect(
      timelineItems
        .map((item) => slugs[item.slice(2)])
        .sort((a, b) => String(a).localeCompare(String(b))),
    ).toEqual(["gone", "old"]);
    const events = selected
      .filter((item) => item.startsWith("e:"))
      .map((item) => Number(item.slice(2)));
    const kept = (
      f.db.prepare("SELECT cursor, data FROM events ORDER BY cursor").all() as {
        cursor: number;
        data: string;
      }[]
    )
      .filter((row) => !events.includes(row.cursor))
      .map((row) => JSON.parse(row.data) as TrackerEvent);
    // Open issues' whole history stays (their links and children's moves
    // included); so does day 300's activity.
    const history = (
      f.db.prepare("SELECT cursor FROM issue_events WHERE issue_id IN ('D', 'P')").all() as {
        cursor: number;
      }[]
    ).map((row) => row.cursor);
    expect(history.length).toBeGreaterThan(2);
    expect(history.filter((cursor) => events.includes(cursor))).toEqual([]);
    expect(kept.some((event) => event.entityId === "c-f")).toBe(true);
    // A closed issue keeps its newest event only; H's timeline change stays with "old".
    expect(kept.filter((event) => event.entityId === "C")).toHaveLength(1);
    expect(kept.some((event) => event.entityId === "H" && event.timelineId)).toBe(true);
    // Receipts older than a year go too.
    expect(selected.some((item) => item.startsWith("r:"))).toBe(true);
  });

  test("dry run = run, idempotent, and replicas below the floor start over", () => {
    const f = timelines();
    const replica = f.snapshot(true);
    const dry = pages(f, "activity", ACTIVITY, false, 3);
    expect(pages(f, "activity", ACTIVITY, true, 3)).toEqual(dry);
    // The next run takes what the removed timelines held on to (events made
    // in them, and their records' older feed entries), and then nothing.
    const next = pages(f, "activity", ACTIVITY, true, 3).flatMap((page) => page.items);
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((item) => item.startsWith("e:"))).toBe(true);
    expect(pages(f, "activity", ACTIVITY, true, 3).flatMap((page) => page.items)).toEqual([]);
    const after = f.snapshot(true);
    expect(after.timelines!.map((timeline) => timeline.slug).sort()).toEqual([
      "child",
      "open",
      "parent",
    ]);
    expect(ids(after, "issues")).toEqual(ids(replica, "issues"));
    // The view and history of what stays still work.
    expect(f.store.history(f.access, "D", null, 50).events.length).toBeGreaterThan(1);
    expect(f.store.snapshot(f.access, "child").issues.length).toBe(replica.issues.length);
    expect(() => f.store.timelines.get("gone")).toThrow(
      expect.objectContaining({
        code: "removed_by_retention",
        message: expect.stringMatching(/^Timeline gone was removed by retention/),
      }),
    );
    expect(() => f.fork("gone")).toThrow(/removed by retention; choose another name/);
    // The feed below its floor: 410, so gm fetches a fresh snapshot.
    expect(feedFloor(f.sql)).toBeGreaterThan(0);
    expect(() => f.store.changes(replica.cursor, 500)).not.toThrow();
    expect(() => f.store.changes(0, 500)).toThrow(
      expect.objectContaining({ status: 410, code: "cursor_expired" }),
    );
    // From the replica's cursor (above the floor), timeline removals arrive as deletions.
    const feed = f.store.changes(replica.cursor, 500, true);
    expect(
      feed.events
        .filter((event) => event.kind === "retention.remove")
        .map((event) => event.entityType),
    ).toEqual(expect.arrayContaining(["timeline", "timelineEvent"]));
    expect(
      feed.events
        .filter((event) => event.kind === "retention.remove")
        .every((e) => e.entity === null),
    ).toBe(true);
  });
});
