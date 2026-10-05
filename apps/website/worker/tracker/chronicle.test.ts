// The Chronicle's history by time (CORE-250): a known history, made through
// the tracker's real mutations under a controlled clock, reconstructed
// exactly: statuses as of arbitrary times, work spans through renewals,
// expiry, takeover, release, revoke, parking, retained leases and landing,
// markers, paging, the retention floor and the density strip.

import { afterEach, describe, expect, test } from "vite-plus/test";
import { stateAt, summarize, type Chronicle, type ChronicleIssue } from "../../shared/chronicle.ts";
import type { Mutation } from "../../shared/tracker.ts";
import { durableStorage } from "../testing/durable.ts";
import { removeActivity, selectActivity } from "./retention.ts";
import { TrackerStore, type Access } from "./store.ts";
import { ownedTimeline, ownedCheckpointRepo } from "../testing/timeline-source.ts";

const databases: { close(): void }[] = [];
afterEach(() => {
  for (const db of databases) db.close();
  databases.length = 0;
});

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const oid = (n: number) => n.toString(16).padStart(40, "0");

/** The history every test reads; minutes from T0 in the comments. */
function history() {
  const { db, sql, transactionSync } = durableStorage();
  databases.push(db);
  let now = T0;
  const store = new TrackerStore(sql, transactionSync, () => now);
  const alice: Access = {
    actorId: "alice",
    principalId: "alice",
    agents: [
      {
        id: "agt-bot",
        name: "builder",
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
    repos: [],
  };
  const bot: Access = { ...alice, actorId: "agt-bot" };
  const bob: Access = { ...alice, actorId: "bob", principalId: "bob", canAdmin: false };
  let n = 0;
  const as = (who: Access, minute: number, timeline: string | null, ...mutations: Mutation[]) => {
    now = T0 + minute * 60_000;
    return store.mutate(who, {
      operationId: `op-${++n}`,
      mutations,
      ...(timeline ? { timeline } : {}),
    });
  };
  const token = (result: ReturnType<typeof as>) => String(result.results[0]!.leaseToken);
  const create = (id: string, title: string, extra: Record<string, unknown> = {}) =>
    ({ kind: "issue.create", id, data: { teamId: "team", title, ...extra } }) as Mutation;

  // 0: the team and its issues: ENG-1 a … ENG-7 q.
  as(
    alice,
    0,
    null,
    { kind: "team.create", id: "team", data: { key: "ENG", name: "Engineering" } },
    create("a", "Index the docs", { labels: ["search"] }),
    create("b", "Fix the login race"),
    create("p", "Billing project"),
    create("c", "Invoice export", { parentId: "p" }),
    create("d", "Choose a region"),
    create("e", "Search ranking", { labels: ["search"] }),
    create("q", "Typo in footer"),
  );
  // q: done in minutes, long before the ranges read below.
  const q = token(as(alice, 5, null, { kind: "issue.claim", id: "q", data: { agent: "alice" } }));
  as(alice, 6, null, {
    kind: "issue.complete",
    id: "q",
    data: { leaseToken: q, evidence: "Fixed" },
  });

  // a: the agent claims (15 min), renews twice, checkpoints, completes.
  const a = token(
    as(bot, 60, null, { kind: "issue.claim", id: "a", data: { agent: "session-1" } }),
  );
  as(bot, 70, null, { kind: "issue.renew", id: "a", data: { leaseToken: a } });
  as(bot, 80, null, { kind: "issue.renew", id: "a", data: { leaseToken: a } });
  as(bot, 85, null, {
    kind: "comment.add",
    id: "a-cp",
    data: { issueId: "a", kind: "checkpoint", body: "Indexed 3 of 4 sites\n\nmore" },
  });
  as(bot, 90, null, {
    kind: "issue.complete",
    id: "a",
    data: { leaseToken: a, evidence: "All four sites indexed." },
  });

  // b: Alice's 30-minute claim lapses at 90 (nothing is recorded); Bob claims
  // it at 180; Alice takes it over at 190, and releases it at 200.
  as(alice, 60, null, {
    kind: "issue.claim",
    id: "b",
    data: { agent: "laptop", ttlSeconds: 1800 },
  });
  as(bob, 180, null, { kind: "issue.claim", id: "b", data: { agent: "bob", ttlSeconds: 1800 } });
  const b = token(
    as(alice, 190, null, { kind: "issue.claim", id: "b", data: { agent: "alice", force: true } }),
  );
  as(alice, 200, null, { kind: "issue.release", id: "b", data: { leaseToken: b } });

  // p/c: Alice leads the project; delegates c to her agent at 101 and revokes it at 120.
  const lead = token(
    as(alice, 100, null, {
      kind: "issue.claim",
      id: "p",
      data: { agent: "lead", ttlSeconds: 3600 },
    }),
  );
  as(alice, 101, null, {
    kind: "issue.claim",
    id: "c",
    data: { agent: "sub", underToken: lead, forActorId: "agt-bot", ttlSeconds: 3600 },
  });
  as(alice, 120, null, { kind: "issue.revoke", id: "c", data: { underToken: lead } });

  // d: the agent asks a person at 135 (parked), Alice answers at 300, the
  // agent resumes at 310 and releases at 320.
  const d = token(as(bot, 130, null, { kind: "issue.claim", id: "d", data: { agent: "s2" } }));
  as(bot, 135, null, {
    kind: "request.open",
    id: "ask",
    data: { issueId: "d", kind: "question", prompt: "Which region?", leaseToken: d },
  });
  as(alice, 300, null, { kind: "request.answer", id: "ask", data: { answer: "eu-west" } });
  const resumed = token(as(bot, 310, null, { kind: "issue.resume", id: "d", data: {} }));
  as(bot, 320, null, { kind: "issue.release", id: "d", data: { leaseToken: resumed } });

  // e: worked in timeline "search" (forked at 140), finished there at 160
  // (its lease retained), checkpointed at 170, landed at 400.
  now = T0 + 140 * 60_000;
  ownedTimeline(store.timelines, alice, {
    slug: "search",
    parent: null,
    repos: [{ id: "app", owner: "org", name: "app" }],
    commits: { app: oid(1) },
  });
  const e = token(as(bot, 150, "search", { kind: "issue.claim", id: "e", data: { agent: "s3" } }));
  as(bot, 160, "search", {
    kind: "issue.complete",
    id: "e",
    data: { leaseToken: e, evidence: "Ranking shipped in search." },
  });
  now = T0 + 170 * 60_000;
  store.timelines.createCheckpoint(bot, "search", {
    summary: "Ranking ready",
    repos: [
      ownedCheckpointRepo(store.timelines, "search", {
        id: "app",
        owner: "org",
        name: "app",
        commit: oid(2),
        base: oid(1),
        changes: [{ changeId: "changeone", commit: oid(2) }],
      }),
    ],
  });
  now = T0 + 400 * 60_000;
  store.landTimeline(alice, "search");

  now = T0 + 500 * 60_000;
  const read = (
    from: number,
    to: number,
    options: Partial<{ query: string; cursor: string | null; limit: number; quiet: boolean }> = {},
  ): Chronicle =>
    store.chronicle(alice, {
      from: at(from),
      to: at(to),
      query: "",
      cursor: null,
      limit: 100,
      quiet: false,
      ...options,
    });
  return {
    db,
    sql,
    store,
    alice,
    read,
    advance: (ms: number) => {
      now += ms;
    },
    nowIs: () => now,
  };
}

const row = (chronicle: Chronicle, key: string): ChronicleIssue =>
  chronicle.issues.find((issue) => issue.key === key)!;
const status = (issue: ChronicleIssue, minute: number) =>
  stateAt(issue, Date.parse(at(minute))).status;

describe("the Chronicle's history by time", () => {
  test("status as of any time matches the history exactly", () => {
    const h = history();
    const all = h.read(30, 500, { quiet: true });
    const a = row(all, "ENG-1");
    const b = row(all, "ENG-2");
    const c = row(all, "ENG-4");
    const d = row(all, "ENG-5");
    const e = row(all, "ENG-6");
    const q = row(all, "ENG-7");
    expect([a, b, c, d, e, q].map((issue) => issue.start.status)).toEqual([
      "todo",
      "todo",
      "todo",
      "todo",
      "todo",
      "done",
    ]);
    expect([59, 60, 89, 90, 499].map((m) => status(a, m))).toEqual([
      "todo",
      "in_progress",
      "in_progress",
      "done",
      "done",
    ]);
    // A lapsed lease leaves the status as it was until someone acts.
    expect([95, 179, 185, 195, 200, 201].map((m) => status(b, m))).toEqual([
      "in_progress",
      "in_progress",
      "in_progress",
      "in_progress",
      "todo",
      "todo",
    ]);
    expect([100, 101, 119, 120].map((m) => status(c, m))).toEqual([
      "todo",
      "in_progress",
      "in_progress",
      "todo",
    ]);
    expect(stateAt(d, Date.parse(at(200)))).toEqual({ status: "in_progress", waiting: true });
    expect(stateAt(d, Date.parse(at(305)))).toEqual({ status: "in_progress", waiting: false });
    // Finished in a timeline it's main's done_in_timeline until the timeline lands.
    expect([149, 150, 160, 399, 400].map((m) => status(e, m))).toEqual([
      "todo",
      "in_progress",
      "done_in_timeline",
      "done_in_timeline",
      "done",
    ]);
    // Before the range, a row reads as its start state; a range before it existed reads null.
    const early = h.read(-10, 1, { quiet: true });
    expect(row(early, "ENG-1").start.status).toBeNull();
    expect(row(early, "ENG-1").segments).toMatchObject([{ at: at(0), status: "todo" }]);
  });

  test("work spans: renewals, completion, expiry, takeover, release, revoke, parking, retained leases", () => {
    const h = history();
    const all = h.read(30, 500);
    expect(row(all, "ENG-1").spans).toEqual([
      {
        id: expect.stringMatching(/^a:\d+$/),
        issueId: "a",
        holder: "agt-bot",
        accountableId: "alice",
        session: "session-1",
        start: at(60),
        end: at(90),
        endedBy: "complete",
        endedById: null,
        expiresAt: at(95),
        renewals: [at(70), at(80)],
        parked: [],
        retained: null,
        delegatedFrom: null,
        timelineId: null,
      },
    ]);
    expect(
      row(all, "ENG-2").spans.map((s) => [s.holder, s.start, s.end, s.endedBy, s.endedById]),
    ).toEqual([
      ["alice", at(60), at(90), "expiry", null],
      ["bob", at(180), at(190), "takeover", "alice"],
      ["alice", at(190), at(200), "release", null],
    ]);
    expect(row(all, "ENG-4").spans).toMatchObject([
      {
        holder: "agt-bot",
        accountableId: "alice",
        start: at(101),
        end: at(120),
        endedBy: "revoke",
        endedById: "alice",
        delegatedFrom: "p",
      },
    ]);
    // The project's own lease ran out at 160.
    expect(row(all, "ENG-3").spans).toMatchObject([
      { holder: "alice", start: at(100), end: at(160), endedBy: "expiry" },
    ]);
    expect(row(all, "ENG-5").spans).toMatchObject([
      {
        holder: "agt-bot",
        start: at(130),
        end: at(320),
        endedBy: "release",
        parked: [{ from: at(135), to: at(300) }],
        renewals: [at(310)],
      },
    ]);
    const e = row(all, "ENG-6").spans;
    expect(e).toMatchObject([
      {
        holder: "agt-bot",
        start: at(150),
        end: at(400),
        endedBy: "landed",
        retained: { at: at(160), timeline: { slug: "search" } },
      },
    ]);
    expect(e[0]!.timelineId).toBeTruthy();
    // People and agents are named as recorded: the agent with its accountable person.
    expect(all.actors["agt-bot"]).toMatchObject({
      kind: "agent",
      name: "builder",
      accountable: { displayName: "Alice" },
    });
    expect(all.actors.bob).toMatchObject({ kind: "person", name: "Bob" });
  });

  test("a span still held at the range's end stays open; one cut by the range keeps its true bounds", () => {
    const h = history();
    const mid = h.read(140, 155);
    // e was claimed at 150 and held past 155: open as of the range's end.
    const e = row(mid, "ENG-6").spans[0]!;
    expect(e).toMatchObject({ start: at(150), end: null, endedBy: null });
    // d's span began before the range and ends after it: whole, parked inside.
    expect(row(mid, "ENG-5").spans[0]).toMatchObject({ start: at(130), end: null });
    expect(row(mid, "ENG-5").start).toEqual({ status: "in_progress", waiting: true });
    // Spans that ended before the range aren't in it; a's closed and quiet in it.
    expect(row(mid, "ENG-2").spans).toEqual([]);
    expect(mid.issues.map((i) => i.key)).not.toContain("ENG-1");
  });

  test("markers: comments, checkpoints, evidence, requests, links, landings and timeline checkpoints", () => {
    const h = history();
    const all = h.read(-1, 500, { quiet: true });
    const kinds = (key: string) => row(all, key).markers.map((m) => [m.kind, m.at, m.text]);
    expect(kinds("ENG-1")).toEqual([
      ["created", at(0), "Index the docs"],
      ["checkpoint", at(85), "Indexed 3 of 4 sites"],
      ["evidence", at(90), "All four sites indexed."],
    ]);
    expect(kinds("ENG-5")).toEqual([
      ["created", at(0), "Choose a region"],
      ["asked", at(135), "Which region?"],
      ["answered", at(300), "eu-west"],
    ]);
    expect(row(all, "ENG-5").markers[1]).toMatchObject({ request: "question", actorId: "agt-bot" });
    expect(kinds("ENG-6")).toEqual([
      ["created", at(0), "Search ranking"],
      ["evidence", at(160), "Ranking shipped in search."],
      ["timeline-checkpoint", at(170), "Ranking ready"],
      ["landed", at(400), "Landed with its timeline"],
    ]);
    // The takeover is on the record as a comment.
    expect(kinds("ENG-2").map(([kind, time]) => [kind, time])).toContainEqual(["comment", at(190)]);
  });

  test("links are markers on both issues, and current blockers ride along", () => {
    const h = history();
    h.store.mutate(h.alice, {
      operationId: "link",
      mutations: [{ kind: "link.add", id: "l1", data: { fromId: "b", toId: "d", kind: "blocks" } }],
    });
    const linkedAt = new Date(h.nowIs()).toISOString();
    const all = h.read(450, 600);
    expect(row(all, "ENG-2").markers).toMatchObject([
      { kind: "linked", at: linkedAt, issue: "ENG-5", text: "blocks ENG-5" },
    ]);
    expect(row(all, "ENG-5").markers).toMatchObject([
      { kind: "linked", issue: "ENG-2", text: "blocked by ENG-2" },
    ]);
    expect(row(all, "ENG-5").blockers).toEqual(["b"]);
    const summary = summarize(all.issues, Date.parse(at(450)), Date.parse(at(600)), h.nowIs());
    expect(summary.blocked.map((id) => all.issues.find((i) => i.id === id)!.key)).toEqual([
      "ENG-5",
    ]);
  });

  test("closed and untouched issues stay out unless asked for; queries narrow the rows", () => {
    const h = history();
    const range = h.read(30, 500);
    expect(range.issues.map((i) => i.key)).toEqual([
      "ENG-1",
      "ENG-2",
      "ENG-3",
      "ENG-4",
      "ENG-5",
      "ENG-6",
    ]);
    expect(range.quiet).toBe(1);
    expect(h.read(30, 500, { quiet: true }).issues).toHaveLength(7);
    expect(h.read(30, 500, { query: "label:search" }).issues.map((i) => i.key)).toEqual([
      "ENG-1",
      "ENG-6",
    ]);
    expect(h.read(30, 500, { query: "is:closed" }).issues.map((i) => i.key)).toEqual([
      "ENG-1",
      "ENG-6",
    ]);
    // Issues created after the range's end aren't rows.
    h.store.mutate(h.alice, {
      operationId: "late",
      mutations: [{ kind: "issue.create", id: "z", data: { teamId: "team", title: "Later" } }],
    });
    expect(h.read(30, 499).issues.map((i) => i.key)).not.toContain("ENG-8");
    expect(h.read(30, 501).issues.map((i) => i.key)).toContain("ENG-8");
  });

  test("the range summary counts start and end states, completions and who worked how long", () => {
    const h = history();
    const all = h.read(30, 500, { quiet: true });
    const summary = summarize(all.issues, Date.parse(at(30)), Date.parse(at(500)), h.nowIs());
    // q, closed before the range and untouched in it, isn't part of it.
    expect(summary.startCounts).toEqual({ todo: 6 });
    // p's lapsed lease left it in progress.
    expect(summary.endCounts).toEqual({ done: 2, todo: 3, in_progress: 1 });
    expect(summary.completed.sort()).toEqual(["a", "e"]);
    expect(summary.changed.sort()).toEqual(["a", "e", "p"]);
    const minutes = Object.fromEntries(
      summary.workers.map((w) => [w.actorId, Math.round(w.workedMs / 60_000)]),
    );
    // agt-bot: a 30 + c 19 + d 25 (190 held, 165 of it parked waiting on a
    // person) + e 10 (retained time isn't work) = 84.
    // alice: b 30 + 10, p 60 = 100. bob: b 10.
    expect(minutes).toEqual({ "agt-bot": 84, alice: 100, bob: 10 });
  });

  test("pages are bounded and cover every row once", () => {
    const h = history();
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = h.read(30, 500, { limit: 2, cursor, quiet: true });
      if (pages) expect(page.density).toBeUndefined();
      else expect(page.density).toBeDefined();
      expect(page.issues.length).toBeLessThanOrEqual(2);
      seen.push(...page.issues.map((i) => i.key));
      cursor = page.next;
      pages++;
    } while (cursor);
    expect(seen).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5", "ENG-6", "ENG-7"]);
    expect(pages).toBe(4);
    expect(() => h.read(30, 500, { limit: 0 })).toThrow(/limit/);
    expect(() => h.read(30, 30)).toThrow(/after from/);
  });

  test("density counts every issue event over the whole history; history states its beginning", () => {
    const h = history();
    const page = h.read(30, 500, { quiet: true });
    const density = page.density!;
    const events = (
      h.db
        .prepare(
          `SELECT count(*) AS n FROM events
           WHERE json_extract(data, '$.entityType') IN ('issue', 'comment', 'request', 'link')`,
        )
        .get() as { n: number }
    ).n;
    expect(density.counts.reduce((sum, n) => sum + n, 0)).toBe(events);
    expect(Date.parse(density.start)).toBeLessThanOrEqual(T0);
    expect(page.history).toEqual({ earliest: at(0), pruned: null, removedIssues: 0 });
    // A query's strip counts only its issues' events.
    const narrow = h.read(30, 500, { query: "label:search" }).density!;
    expect(narrow.counts.reduce((sum, n) => sum + n, 0)).toBeLessThan(events);
  });

  test("retention-pruned history is stated, not silently missing", () => {
    const h = history();
    // 100 days on, prune activity older than 30 days, as tracker-activity does.
    h.advance(100 * 86_400_000);
    const now = new Date(h.nowIs()).toISOString();
    const thresholds = { eventDays: 30, endedTimelineDays: 3650 };
    const selected = selectActivity(h.sql, thresholds, now, null, 1000);
    expect(selected.items.length).toBeGreaterThan(0);
    removeActivity(h.sql, thresholds, now, selected.items, now);
    const page = h.read(30, 500, { quiet: true });
    expect(page.history.pruned).toMatchObject({ cursor: expect.any(Number) });
    // When: the newest event it removed, inside the history, not "now".
    const before = Date.parse(page.history.pruned!.before);
    expect(before).toBeGreaterThanOrEqual(Date.parse(at(5)));
    expect(before).toBeLessThanOrEqual(Date.parse(at(500)));
    // q (closed) lost its early events: its row says where its history begins.
    const q = row(page, "ENG-7");
    expect(q.historyFrom).not.toBeNull();
    expect(q.start.status).toBe("done");
    // Open issues keep their whole history.
    expect(row(page, "ENG-2").historyFrom).toBeNull();
  });
});
