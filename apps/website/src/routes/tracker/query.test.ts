import { describe, expect, it } from "vite-plus/test";
import type { HumanRequest, Issue, Link, Snapshot } from "../../../shared/tracker.ts";
import {
  activityOf,
  buildIndex,
  compile,
  facetsOf,
  groupIssues,
  parseQuery,
  queryTokenSet,
  sortIssues,
  STATE_LABEL,
  subIssueLabel,
  subIssueProgress,
  toggleToken,
  VIEWS,
  tokenize,
  whyNotReady,
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
    projectIds: [],
    labels: [],
    claim: null,
    ...fields,
  };
}

function snapshot(issues: Issue[], links: Link[] = []): Snapshot {
  return {
    contractVersion: 4,
    spaceId: "o",
    migrationEpoch: 1,
    space: {
      id: "o",
      slug: "priya",
      displayName: "Priya",
      organizationId: "personal",
      organization: {
        id: "personal",
        slug: "personal",
        displayName: "Personal",
        kind: "personal",
        avatarUrl: null,
        personalAccountId: "m-priya",
        defaultSpaceId: "o",
        createdAt: ago(30),
      },
      archivedAt: null,
      authorizationVersion: 1,
      createdAt: ago(30),
    },
    canAdmin: true,
    members: [
      { id: "m-priya", slug: "priya", displayName: "Priya Raman" },
      { id: "m-jun", slug: "jun", displayName: "Jun Park" },
    ],
    agents: [],
    labels: [],
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
    projects: [
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

it("keeps restricted pickup out of Ready while preserving explicit policy filters and human eligibility", () => {
  const issues = [
    issue("CORE-1"),
    issue("CORE-2", { pickup: "not_ready" }),
    issue("CORE-3", { pickup: "human_only", assigneeId: "agt-worker" }),
    issue("CORE-4", { pickup: "human_only", status: "done" }),
  ];
  const snap = snapshot(issues);
  snap.agents = [
    {
      id: "agt-worker",
      name: "worker",
      accountable: snap.members[0]!,
      capabilities: null,
      capabilitiesUpdatedAt: null,
      revokedAt: null,
    },
  ];
  const index = buildIndex(snap, snap.serverTime);
  const keys = (query: string, viewer = "m-priya") => {
    const compiled = compile(query, index, viewer, NOW);
    return issues.filter((item) => compiled.matches(item)).map((item) => item.key);
  };
  expect(keys("is:ready")).toEqual(["CORE-1"]);
  expect(keys("is:not_ready")).toEqual(["CORE-2"]);
  expect(keys("is:human_only")).toEqual(["CORE-3"]);
  expect(keys("is:open eligible:me")).toEqual(["CORE-1", "CORE-3"]);
  expect(keys("is:open eligible:me", "agt-worker")).toEqual(["CORE-1"]);
  expect(keys("is:closed")).toEqual(["CORE-4"]);
});

describe("done in a timeline", () => {
  it("has a state of its own, keeps blocking and stays open until it lands", () => {
    const doneIn = { id: "tl_1", slug: "search" };
    const later = new Date(NOW + 3_600_000).toISOString();
    const snap = snapshot(
      [
        issue("CORE-1", { status: "done_in_timeline", doneIn }),
        issue("CORE-2"),
        // A lease kept until it lands doesn't make it look like work going on.
        issue("CORE-3", {
          status: "done_in_timeline",
          doneIn,
          claim: { actorId: "m-jun", agent: "codex", expiresAt: later },
        }),
      ],
      [blocks("core-1", "core-2")],
    );
    const index = buildIndex(snap, new Date(NOW).toISOString());
    expect(["core-1", "core-2", "core-3"].map((id) => index.state.get(id))).toEqual([
      "done_in_timeline",
      "blocked",
      "done_in_timeline",
    ]);
    const keys = (query: string) => {
      const compiled = compile(query, index, "m-priya", NOW);
      return snap.issues.filter((i) => compiled.matches(i)).map((i) => i.key);
    };
    expect(keys("status:done_in_timeline")).toEqual(["CORE-1", "CORE-3"]);
    expect(keys("is:done_in_timeline")).toEqual(["CORE-1", "CORE-3"]);
    expect(keys("is:open")).toEqual(["CORE-1", "CORE-2", "CORE-3"]);
    expect(keys("is:closed")).toEqual([]);
    expect(keys("is:ready")).toEqual([]);
  });
});

describe("graph states", () => {
  it("shows containers as their own state and issues under another lease as leased", () => {
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
      "container",
      "ready",
    ]);
    expect(index.leasedBy.get("core-2")?.key).toBe("CORE-1");
    const leased = compile("is:leased", index, "m-priya", NOW);
    expect(snap.issues.filter((i) => leased.matches(i)).map((i) => i.key)).toEqual(["CORE-2"]);
  });

  it("finds containers with is:container, and a parent stops being one once its sub-issues close", () => {
    const keys = (issues: Issue[], q: string) => {
      const snap = snapshot(issues);
      const index = buildIndex(snap, snap.serverTime);
      const compiled = compile(q, index, "m-priya", NOW);
      return issues.filter((i) => compiled.matches(i)).map((i) => i.key);
    };
    const open = [
      issue("CORE-1"),
      issue("CORE-2", { parentId: "core-1" }),
      issue("CORE-3", { parentId: "core-1", status: "done" }),
      issue("CORE-4"),
    ];
    expect(keys(open, "is:container")).toEqual(["CORE-1"]);
    expect(keys(open, "state:container")).toEqual(["CORE-1"]);
    expect(keys(open, "-is:container is:ready")).toEqual(["CORE-2", "CORE-4"]);
    // Readiness is unchanged: a blocked parent reports blocked first.
    const blockedParent = snapshot(open, [blocks("core-4", "core-1")]);
    expect(buildIndex(blockedParent, blockedParent.serverTime).state.get("core-1")).toBe("blocked");
    const closed = [
      issue("CORE-1"),
      issue("CORE-2", { parentId: "core-1", status: "done" }),
      issue("CORE-3", { parentId: "core-1", status: "canceled" }),
    ];
    expect(keys(closed, "is:container")).toEqual([]);
    expect(keys(closed, "is:ready")).toEqual(["CORE-1"]);
  });

  it("counts sub-issue progress without canceled ones, and done in a timeline as still open", () => {
    const progress = subIssueProgress([
      issue("CORE-2", { status: "done" }),
      issue("CORE-3", { status: "canceled" }),
      issue("CORE-4", { status: "done_in_timeline" }),
      issue("CORE-5", { status: "in_progress" }),
      issue("CORE-6"),
    ]);
    expect(progress.open.map((i) => i.key)).toEqual(["CORE-4", "CORE-5", "CORE-6"]);
    expect([progress.done, progress.total]).toEqual([1, 4]);
    expect(subIssueLabel(progress)).toBe("Sub-issues · 1/4 done");
    expect(STATE_LABEL.container).toBe("Sub-issues");
  });

  it("says why every non-ready issue isn't ready, in one line", () => {
    const later = new Date(NOW + 3_600_000).toISOString();
    const issues = [
      issue("CORE-1"),
      issue("CORE-2", { waiting: 1 }),
      issue("CORE-3", { claim: { actorId: "m-jun", agent: "laptop", expiresAt: later } }),
      issue("CORE-4", { parentId: "core-3" }),
      issue("CORE-5", { pickup: "not_ready" }),
      issue("CORE-6", { pickup: "human_only" }),
      issue("CORE-7"),
      issue("CORE-8"),
      issue("CORE-9", { parentId: "core-8", status: "done" }),
      issue("CORE-10", { parentId: "core-8" }),
      issue("CORE-11", { parentId: "core-8", status: "canceled" }),
      issue("CORE-12", { status: "backlog" }),
      issue("CORE-13", { status: "in_progress" }),
      issue("CORE-14", { status: "done" }),
      issue("CORE-15", { status: "canceled" }),
    ];
    const asked: HumanRequest = {
      id: "r1",
      issueId: "core-2",
      kind: "question",
      prompt: "Which region?",
      choices: [],
      secret: null,
      status: "open",
      askedBy: "m-jun",
      routeTo: "m-priya",
      answer: null,
      answeredBy: null,
      answeredAt: null,
      createdAt: ago(1),
    };
    const snap = { ...snapshot(issues, [blocks("core-1", "core-7")]), requests: [asked] };
    const index = buildIndex(snap, snap.serverTime);
    const why = (key: string) => whyNotReady(index.byKey.get(key.toLowerCase())!, index, snap);
    expect(why("CORE-1")).toBeNull();
    expect(why("CORE-2")).toBe("Waiting on Priya Raman to answer a request");
    expect(why("CORE-3")).toMatch(/^Claimed by Jun Park/);
    expect(why("CORE-4")).toBe("Covered by CORE-3's lease");
    expect(why("CORE-5")).toBe("Pickup is paused until a person enables it");
    expect(why("CORE-6")).toBe("Only people can pick up this issue");
    expect(why("CORE-7")).toBe("Blocked by CORE-1");
    expect(why("CORE-8")).toBe("1 of 2 sub-issues still open");
    expect(why("CORE-12")).toBe("In Backlog: move it to To do to queue it");
    expect(why("CORE-13")).toBe("In progress, but nobody holds a claim on it");
    // Finished work has nothing to explain.
    expect(why("CORE-14")).toBeNull();
    expect(why("CORE-15")).toBeNull();
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
    const parsed = parseQuery("project:packages priority:1 colour:red -flaky");
    expect(parsed.filters.map((f) => `${f.key}:${f.value}`)).toEqual(["project:packages", "p:1"]);
    expect(parsed.unknown).toEqual(["colour:red"]);
    expect(parsed.words).toEqual([{ text: "flaky", negated: true }]);
  });

  it("ORs values of one key, ANDs keys, and applies negation", () => {
    const issues = [
      issue("CORE-1", { labels: ["perf"] }),
      issue("WEB-1", { teamId: "t-web" }),
      issue("CORE-2", { status: "done" }),
      issue("CORE-3", { assigneeId: "m-jun", projectIds: ["w-pkg"] }),
    ];
    const snap = snapshot(issues);
    const index = buildIndex(snap, snap.serverTime);
    const keys = (q: string) => {
      const c = compile(q, index, "m-priya", NOW);
      return issues.filter((i) => c.matches(i)).map((i) => i.key);
    };
    expect(keys("team:core team:web is:open")).toEqual(["CORE-1", "WEB-1", "CORE-3"]);
    expect(keys("team:core -tag:perf")).toEqual(["CORE-2", "CORE-3"]);
    expect(keys("assignee:jun project:packages")).toEqual(["CORE-3"]);
    expect(keys("assignee:none is:closed")).toEqual(["CORE-2"]);
    expect(keys("web-1")).toEqual(["WEB-1"]);
    expect(keys("is:open -core")).toEqual(["WEB-1"]);
  });

  it("matches whole ticket numbers and case-insensitive keys, not mentions or substrings", () => {
    const issues = [
      issue("CORE-98", { title: "Search tickets", labels: ["perf"] }),
      issue("WEB-98", { teamId: "t-web", title: "Search tickets", status: "done" }),
      issue("CORE-198"),
      issue("CORE-980"),
      issue("CORE-7", { title: "Mention CORE-98", labels: ["98"] }),
      issue("UI2-98"),
    ];
    const snap = snapshot(issues);
    const index = buildIndex(snap, snap.serverTime);
    const keys = (query: string) => {
      const compiled = compile(query, index, "m-priya", NOW);
      return issues.filter((i) => compiled.matches(i)).map((i) => i.key);
    };
    expect(keys("98")).toEqual(["CORE-98", "WEB-98", "UI2-98"]);
    expect(keys("CoRe-98")).toEqual(["CORE-98"]);
    expect(keys("uI2-98")).toEqual(["UI2-98"]);
    expect(keys("99")).toEqual([]);
    expect(keys("CORE-99")).toEqual([]);
    expect(keys("98 team:core is:open search tag:perf")).toEqual(["CORE-98"]);
    expect(keys("98 team:web is:open")).toEqual([]);
    expect(keys("98 -core-98")).toEqual(["WEB-98", "UI2-98"]);
    expect(keys("-98")).toEqual(["CORE-198", "CORE-980", "CORE-7"]);
    expect(keys("search -98")).toEqual([]);
    expect(keys("mention")).toEqual(["CORE-7"]);
    expect(keys('"mention core-98"')).toEqual(["CORE-7"]);
    expect(keys("tag:98")).toEqual(["CORE-7"]);
    expect(keys("core")).toEqual(["CORE-98", "CORE-198", "CORE-980", "CORE-7"]);
  });

  it("filters by tag, with label: kept as an alias for the old spelling (CORE-271)", () => {
    const issues = [
      issue("CORE-1", { labels: ["UX", "frontend"] }),
      issue("CORE-2", { labels: ["data"] }),
      issue("CORE-3", { labels: ["needs design"] }),
      issue("CORE-4"),
    ];
    const snap = snapshot(issues);
    const index = buildIndex(snap, snap.serverTime);
    const keys = (q: string) => {
      const c = compile(q, index, "", NOW);
      expect(c.parsed.unknown).toEqual([]);
      return issues.filter((i) => c.matches(i)).map((i) => i.key);
    };
    for (const spelling of ["tag", "label", "Label", "tags", "labels"]) {
      expect(keys(`${spelling}:ux`)).toEqual(["CORE-1"]);
      expect(keys(`-${spelling}:ux`)).toEqual(["CORE-2", "CORE-3", "CORE-4"]);
    }
    expect(keys('tag:"needs design"')).toEqual(["CORE-3"]);
    expect(keys("tag:ux label:data")).toEqual(["CORE-1", "CORE-2"]);
    expect(parseQuery("label:ux").filters).toEqual([{ key: "tag", value: "ux", negated: false }]);
    // A facet toggles the filter off whichever spelling put it there.
    expect(toggleToken("is:open label:ux", "tag", "ux")).toBe("is:open");
    expect(toggleToken("is:open", "tag", "ux")).toBe("is:open tag:ux");
    expect(toggleToken('label:"needs design"', "tag", "needs design")).toBe("");
    // A tag pill (CORE-253) removes every copy, and an exclusion only as an exclusion.
    expect(toggleToken("tag:ux is:open TAG:UX", "tag", "ux")).toBe("is:open");
    expect(toggleToken("is:open -label:data", "tag", "data", true)).toBe("is:open");
    expect(toggleToken("is:open -tag:data", "tag", "data")).toBe("is:open -tag:data tag:data");
    expect(queryTokenSet("label:UX -labels:data").has("tag:ux")).toBe(true);
    expect(withoutKeys("label:ux tag:data team:core", ["tag"])).toBe("team:core");
    const facets = facetsOf(issues, compile("label:ux", index, "", NOW), index, snap);
    expect(facets.tag.map((f) => [f.token.key, f.token.value, f.count])).toEqual([
      ["tag", "ux", 1],
      ["tag", "frontend", 1],
      ["tag", "data", 1],
      ["tag", "needs design", 1],
    ]);
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

  it("filters by requirements and by which agents meet them (CORE-32)", () => {
    const issues = [
      issue("CORE-1", { requires: { tags: ["ux"], minMemory: 16 * 2 ** 30 } }),
      issue("CORE-2", { requires: { models: ["gpt-5*"] } }),
      issue("CORE-3"),
      issue("CORE-4", { requires: { tags: ["gpu"] }, assigneeId: "agt-blank" }),
    ];
    const snap = snapshot(issues);
    const accountable = { id: "m-priya", slug: "priya", displayName: "Priya Raman" };
    snap.agents = [
      {
        id: "agt-ux",
        name: "designer",
        accountable,
        capabilities: {
          version: 1,
          harness: "claude-code",
          model: "claude-opus-4-5",
          environment: {
            os: "linux",
            arch: "x86_64",
            runtime: "host",
            cpuCount: 8,
            memoryBytes: 32 * 2 ** 30,
          },
          tags: ["ux"],
          skills: [],
        },
        capabilitiesUpdatedAt: ago(1),
        revokedAt: null,
      },
      {
        id: "agt-blank",
        name: "blank",
        accountable,
        capabilities: null,
        capabilitiesUpdatedAt: null,
        revokedAt: null,
      },
    ];
    const index = buildIndex(snap, snap.serverTime);
    const keys = (q: string, viewer = "m-priya") => {
      const c = compile(q, index, viewer, NOW);
      return issues.filter((i) => c.matches(i)).map((i) => i.key);
    };
    expect(keys("requires:ux")).toEqual(["CORE-1"]);
    expect(keys("requires:tag:ux")).toEqual(["CORE-1"]);
    expect(keys("requires:memory>=16GiB")).toEqual(["CORE-1"]);
    expect(keys("requires:gpt-5*")).toEqual(["CORE-2"]);
    expect(keys("requires:none")).toEqual(["CORE-3"]);
    expect(keys("-requires:none")).toEqual(["CORE-1", "CORE-2", "CORE-4"]);
    expect(keys("eligible:designer")).toEqual(["CORE-1", "CORE-3"]);
    expect(keys("eligible:agt-ux")).toEqual(["CORE-1", "CORE-3"]);
    // Without capabilities only open-to-all work, and what's assigned to it.
    expect(keys("eligible:blank")).toEqual(["CORE-3", "CORE-4"]);
    expect(keys("-eligible:designer")).toEqual(["CORE-2", "CORE-4"]);
    expect(keys("eligible:nobody")).toEqual([]);
    // People can always claim; an agent viewer is checked itself.
    expect(keys("eligible:me")).toEqual(["CORE-1", "CORE-2", "CORE-3", "CORE-4"]);
    expect(keys("eligible:me", "agt-ux")).toEqual(["CORE-1", "CORE-3"]);
  });

  it("selects work by who finished it and when (CORE-220)", () => {
    const credit = (actorId: string, accountableId: string | null, days: number) => ({
      actorId,
      accountableId,
      agent: accountableId ? "laptop" : null,
      at: ago(days),
    });
    const issues = [
      // Priya's agent, recently; and in a timeline that hasn't landed.
      issue("CORE-1", { status: "done", completion: credit("agt-ux", "m-priya", 2) }),
      issue("CORE-2", { status: "done_in_timeline", completion: credit("agt-ux", "m-priya", 1) }),
      // Priya herself, and Jun's agent.
      issue("CORE-3", { status: "done", completion: credit("m-priya", null, 3) }),
      issue("CORE-4", { status: "done", completion: credit("agt-jun", "m-jun", 4) }),
      // Long ago; finished before credit was recorded; reopened.
      issue("CORE-5", { status: "done", completion: credit("agt-ux", "m-priya", 30) }),
      issue("CORE-6", { status: "done" }),
      issue("CORE-7", { status: "todo", completion: credit("agt-ux", "m-priya", 1) }),
    ];
    const snap = snapshot(issues);
    const accountable = { id: "m-priya", slug: "priya", displayName: "Priya Raman" };
    snap.agents = [
      {
        id: "agt-ux",
        name: "designer",
        accountable,
        capabilities: null,
        capabilitiesUpdatedAt: null,
        revokedAt: null,
      },
      {
        id: "agt-jun",
        name: "builder",
        accountable: { id: "m-jun", slug: "jun", displayName: "Jun Park" },
        capabilities: null,
        capabilitiesUpdatedAt: null,
        revokedAt: null,
      },
    ];
    const index = buildIndex(snap, snap.serverTime);
    const keys = (q: string, viewer = "m-priya") => {
      const c = compile(q, index, viewer, NOW);
      return issues.filter((i) => c.matches(i)).map((i) => i.key);
    };
    expect(parseQuery("done-by:mine -done-by:me").filters).toEqual([
      { key: "done-by", value: "mine", negated: false },
      { key: "done-by", value: "me", negated: true },
    ]);
    expect(keys("done-by:mine")).toEqual(["CORE-1", "CORE-2", "CORE-5"]);
    expect(keys("done-by:mine done:14d")).toEqual(["CORE-1", "CORE-2"]);
    expect(keys("done-by:me")).toEqual(["CORE-3"]);
    expect(keys("done-by:designer")).toEqual(["CORE-1", "CORE-2", "CORE-5"]);
    expect(keys("done-by:agt-jun")).toEqual(["CORE-4"]);
    expect(keys("done-by:jun")).toEqual([]);
    expect(keys("done-by:priya")).toEqual(["CORE-3"]);
    expect(keys("doneby:builder")).toEqual(["CORE-4"]);
    expect(keys("done:3d")).toEqual(["CORE-1", "CORE-2", "CORE-3"]);
    expect(keys("done:2026-09-01")).toEqual(["CORE-1", "CORE-2", "CORE-3", "CORE-4"]);
    expect(keys("done-by:mine -done:14d")).toEqual(["CORE-5"]);
    // An agent viewing counts its person's agents as "mine", and itself as "me".
    expect(keys("done-by:mine", "agt-ux")).toEqual(["CORE-1", "CORE-2", "CORE-5"]);
    expect(keys("done-by:me", "agt-jun")).toEqual(["CORE-4"]);
    // The saved view, and hyphenated keys through the token helpers.
    expect(VIEWS.find((v) => v.label === "My agents' work")?.query).toBe("done-by:mine done:14d");
    expect(toggleToken("done:14d", "done-by", "mine")).toBe("done:14d done-by:mine");
    expect(toggleToken("done:14d DONEBY:mine", "done-by", "mine")).toBe("done:14d");
    expect(withoutKeys("is:open -done-by:me done:7d", ["done-by"])).toBe("is:open done:7d");
    expect(tokenize('done-by:"x y" z')).toEqual(["done-by:x y", "z"]);
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

  it("selects the issues counted by agent, person and unassigned facets", () => {
    const assigned = [
      issue("CORE-1", { assigneeId: "agt-priya" }),
      issue("CORE-2", { assigneeId: "agt-priya", status: "done" }),
      issue("CORE-3", { assigneeId: "agt-jun" }),
      issue("CORE-4", { assigneeId: "m-jun" }),
      issue("CORE-5"),
      issue("CORE-6", { assigneeId: "agt-missing" }),
    ];
    const snap = snapshot(assigned);
    snap.agents = snap.members.map((accountable) => ({
      id: accountable.id.replace("m-", "agt-"),
      name: "claude-code",
      accountable,
      capabilities: null,
      capabilitiesUpdatedAt: null,
      revokedAt: null,
    }));
    const index = buildIndex(snap, snap.serverTime);
    const facets = facetsOf(assigned, compile("", index, "m-priya", NOW), index, snap);
    const cases = [
      ["agt-priya", ["CORE-1", "CORE-2"]],
      ["agt-jun", ["CORE-3"]],
      ["jun", ["CORE-4"]],
      ["none", ["CORE-5"]],
      ["agt-missing", ["CORE-6"]],
    ] as const;
    for (const [value, expected] of cases) {
      const facet = facets.assignee.find((entry) => entry.token.value === value)!;
      const query = toggleToken("", facet.token.key, facet.token.value);
      const selected = compile(query, index, "m-priya", NOW);
      expect(assigned.filter((entry) => selected.matches(entry)).map((entry) => entry.key)).toEqual(
        expected,
      );
    }
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

  it("puts work underway above what can move now, in every sort, without splitting a group", () => {
    const work = [
      issue("CORE-1", { priority: 0, updatedAt: ago(5) }),
      issue("CORE-2", {
        priority: 3,
        status: "in_progress",
        updatedAt: ago(4),
        claim: { actorId: "m-jun", agent: "codex", expiresAt: ago(-1) },
      }),
      issue("CORE-3", { priority: 2, status: "in_progress", updatedAt: ago(1) }),
      issue("CORE-4", { status: "backlog", updatedAt: ago(0.5) }),
      issue("CORE-5", { status: "done", updatedAt: ago(0.1) }),
      issue("CORE-6", { status: "done_in_timeline", updatedAt: ago(2) }),
    ];
    const snap = snapshot(work);
    const index = buildIndex(snap, snap.serverTime);
    expect(sortIssues(work, index, "rank").map((i) => i.key)).toEqual([
      "CORE-2",
      "CORE-3",
      "CORE-6",
      "CORE-1",
      "CORE-4",
      "CORE-5",
    ]);
    const sections = (sort: "rank" | "updated" | "priority") =>
      groupIssues(sortIssues(work, index, sort), index).map((g) => [
        g.label,
        g.issues.map((i) => i.key),
      ]);
    expect(sections("rank")).toEqual([
      ["In progress", ["CORE-2", "CORE-3"]],
      ["Done in a timeline", ["CORE-6"]],
      ["Up next", ["CORE-1"]],
      ["Backlog", ["CORE-4"]],
      ["Closed", ["CORE-5"]],
    ]);
    // Another sort reorders inside each group; the groups keep their order.
    expect(sections("updated")).toEqual([
      ["In progress", ["CORE-3", "CORE-2"]],
      ["Done in a timeline", ["CORE-6"]],
      ["Up next", ["CORE-1"]],
      ["Backlog", ["CORE-4"]],
      ["Closed", ["CORE-5"]],
    ]);
    expect(sections("priority")[0]).toEqual(["In progress", ["CORE-3", "CORE-2"]]);
    // A filtered list keeps only the groups it has, with a count per state.
    const underway = groupIssues(sortIssues(work.slice(0, 3), index, "rank"), index);
    expect(underway.map((g) => g.key)).toEqual(["underway", "next"]);
    expect(underway[0]!.states).toEqual([
      { state: "claimed", count: 1 },
      { state: "in_progress", count: 1 },
    ]);
  });

  it("buckets opened and closed work", () => {
    const activity = activityOf(issues, NOW);
    expect(activity.opened.reduce((a, b) => a + b, 0)).toBe(4);
    expect(activity.closed.reduce((a, b) => a + b, 0)).toBe(1);
    expect(activity.opened.length).toBeLessThanOrEqual(90);
  });
});
