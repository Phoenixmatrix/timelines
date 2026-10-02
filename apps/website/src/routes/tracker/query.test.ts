import { describe, expect, it } from "vite-plus/test";
import type { Issue, Link, Snapshot } from "../../../shared/tracker.ts";
import {
  activityOf,
  buildIndex,
  compile,
  facetsOf,
  parseQuery,
  sortIssues,
  toggleToken,
  tokenize,
  withoutKeys,
} from "./query.ts";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function issue(key: string, fields: Partial<Issue> = {}): Issue {
  return {
    id: key.toLowerCase(),
    key,
    version: 1,
    createdAt: ago(10),
    updatedAt: ago(1),
    teamId: "t-core",
    title: `Issue ${key}`,
    description: "",
    acceptance: "",
    type: "task",
    status: "todo",
    priority: 2,
    assigneeId: null,
    parentId: null,
    workspaceIds: [],
    labels: [],
    claim: null,
    ...fields,
  };
}

function snapshot(issues: Issue[], links: Link[] = []): Snapshot {
  return {
    owner: { id: "o", slug: "priya", displayName: "Priya" },
    canAdmin: true,
    members: [
      { id: "m-priya", slug: "priya", displayName: "Priya Raman" },
      { id: "m-jun", slug: "jun", displayName: "Jun Park" },
    ],
    agents: [],
    teams: [
      {
        id: "t-core",
        key: "CORE",
        name: "Core",
        description: "",
        memberIds: [],
        archived: false,
        version: 1,
        createdAt: ago(30),
        updatedAt: ago(30),
      },
      {
        id: "t-web",
        key: "WEB",
        name: "Web",
        description: "",
        memberIds: [],
        archived: false,
        version: 1,
        createdAt: ago(30),
        updatedAt: ago(30),
      },
    ],
    workspaces: [
      {
        id: "w-pkg",
        slug: "packages",
        name: "Packages",
        description: "",
        archived: false,
        version: 1,
        createdAt: ago(30),
        updatedAt: ago(30),
      },
    ],
    issues,
    links,
    comments: [],
    requests: [],
    subscriptions: [],
    cursor: 1,
    serverTime: new Date(NOW).toISOString(),
  };
}

const blocks = (from: string, to: string): Link => ({
  id: `${from}>${to}`,
  fromId: from,
  toId: to,
  kind: "blocks",
});

describe("buildIndex", () => {
  it("derives state from claims, blockers and status", () => {
    const issues = [
      issue("CORE-1"),
      issue("CORE-2"),
      issue("CORE-3", { status: "done" }),
      issue("CORE-4"),
      issue("CORE-5", { claim: { actorId: "m-jun", agent: "codex", expiresAt: ago(-1) } }),
      issue("CORE-6", {
        status: "in_progress",
        claim: { actorId: "m-jun", agent: "codex", expiresAt: ago(1) },
      }),
      issue("CORE-7", { status: "in_progress" }),
      issue("CORE-8", { status: "backlog" }),
    ];
    const index = buildIndex(
      snapshot(issues, [blocks("core-1", "core-2"), blocks("core-3", "core-4")]),
      new Date(NOW).toISOString(),
    );
    expect(Object.fromEntries(index.state)).toEqual({
      "core-1": "ready",
      "core-2": "blocked",
      "core-3": "done",
      // A done blocker no longer blocks.
      "core-4": "ready",
      "core-5": "claimed",
      // An expired claim on in-progress work makes it ready to reclaim.
      "core-6": "ready",
      "core-7": "in_progress",
      "core-8": "backlog",
    });
    expect(index.openBlockers.get("core-2")?.map((i) => i.key)).toEqual(["CORE-1"]);
    expect(index.byKey.get("core-1")?.id).toBe("core-1");
  });
});

describe("graph states", () => {
  it("shows containers by status and issues under another lease as leased", () => {
    const later = new Date(NOW + 3_600_000).toISOString();
    const snap = snapshot([
      issue("CORE-1", {
        claim: { actorId: "m-jun", agent: "lead", expiresAt: later },
        status: "in_progress",
      }),
      issue("CORE-2", { parentId: "core-1" }),
      issue("CORE-3"),
      issue("CORE-4", { parentId: "core-3" }),
      issue("CORE-5", { parentId: "core-3", status: "done" }),
    ]);
    const index = buildIndex(snap, snap.serverTime);
    expect(["core-1", "core-2", "core-3", "core-4"].map((id) => index.state.get(id))).toEqual([
      "claimed",
      "leased",
      "todo",
      "ready",
    ]);
    expect(index.leasedBy.get("core-2")?.key).toBe("CORE-1");
    const leased = compile("is:leased", index, "m-priya", NOW);
    expect(snap.issues.filter((i) => leased.matches(i)).map((i) => i.key)).toEqual(["CORE-2"]);
  });
});

describe("query language", () => {
  it("tokenizes quoted values and keeps the key", () => {
    expect(tokenize('label:"needs design" team:core  retention')).toEqual([
      "label:needs design",
      "team:core",
      "retention",
    ]);
  });

  it("resolves aliases and reports unknown keys", () => {
    const parsed = parseQuery("workspace:packages priority:1 colour:red -flaky");
    expect(parsed.filters.map((f) => `${f.key}:${f.value}`)).toEqual(["ws:packages", "p:1"]);
    expect(parsed.unknown).toEqual(["colour:red"]);
    expect(parsed.words).toEqual([{ text: "flaky", negated: true }]);
  });

  it("ORs values of one key, ANDs keys, and applies negation", () => {
    const issues = [
      issue("CORE-1", { labels: ["perf"] }),
      issue("WEB-1", { teamId: "t-web" }),
      issue("CORE-2", { status: "done" }),
      issue("CORE-3", { assigneeId: "m-jun", workspaceIds: ["w-pkg"] }),
    ];
    const snap = snapshot(issues);
    const index = buildIndex(snap, snap.serverTime);
    const keys = (q: string) => {
      const c = compile(q, index, "m-priya", NOW);
      return issues.filter((i) => c.matches(i)).map((i) => i.key);
    };
    expect(keys("team:core team:web is:open")).toEqual(["CORE-1", "WEB-1", "CORE-3"]);
    expect(keys("team:core -label:perf")).toEqual(["CORE-2", "CORE-3"]);
    expect(keys("assignee:jun ws:packages")).toEqual(["CORE-3"]);
    expect(keys("assignee:none is:closed")).toEqual(["CORE-2"]);
    expect(keys("web-1")).toEqual(["WEB-1"]);
    expect(keys("is:open -core")).toEqual(["WEB-1"]);
  });

  it("filters by last activity with durations and dates", () => {
    const issues = [
      issue("CORE-1", { updatedAt: ago(2) }),
      issue("CORE-2", { updatedAt: ago(20) }),
    ];
    const snap = snapshot(issues);
    const index = buildIndex(snap, snap.serverTime);
    const keys = (q: string) => {
      const c = compile(q, index, "", NOW);
      return issues.filter((i) => c.matches(i)).map((i) => i.key);
    };
    expect(keys("since:7d")).toEqual(["CORE-1"]);
    expect(keys(`until:${ago(7).slice(0, 10)}`)).toEqual(["CORE-2"]);
  });

  it("toggles tokens and strips keys", () => {
    expect(toggleToken("is:open", "team", "core")).toBe("is:open team:core");
    expect(toggleToken("is:open TEAM:core", "team", "core")).toBe("is:open");
    expect(withoutKeys("is:open since:7d -until:2026-01-01 x", ["since", "until"])).toBe(
      "is:open x",
    );
  });
});

describe("facets, sorting and activity", () => {
  const issues = [
    issue("CORE-1", { priority: 1 }),
    issue("CORE-2", { priority: 0 }),
    issue("WEB-1", { teamId: "t-web", status: "done", updatedAt: ago(3) }),
    issue("CORE-10", { status: "backlog" }),
  ];
  const snap = snapshot(issues);
  const index = buildIndex(snap, snap.serverTime);

  it("counts each facet without its own filter so siblings stay visible", () => {
    const facets = facetsOf(issues, compile("team:core", index, "", NOW), index, snap);
    expect(facets.team.map((f) => [f.token.value, f.count])).toEqual([
      ["core", 3],
      ["web", 1],
    ]);
    expect(facets.state.map((f) => [f.label, f.count])).toEqual([
      ["Ready", 2],
      ["Backlog", 1],
    ]);
  });

  it("ranks what can move now first", () => {
    expect(sortIssues(issues, index, "rank").map((i) => i.key)).toEqual([
      "CORE-2",
      "CORE-1",
      "CORE-10",
      "WEB-1",
    ]);
    expect(sortIssues(issues, index, "key").map((i) => i.key)).toEqual([
      "CORE-1",
      "CORE-2",
      "CORE-10",
      "WEB-1",
    ]);
  });

  it("buckets opened and closed work", () => {
    const activity = activityOf(issues, NOW);
    expect(activity.opened.reduce((a, b) => a + b, 0)).toBe(4);
    expect(activity.closed.reduce((a, b) => a + b, 0)).toBe(1);
    expect(activity.opened.length).toBeLessThanOrEqual(90);
  });
});
