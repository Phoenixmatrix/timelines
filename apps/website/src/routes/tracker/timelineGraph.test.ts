import { describe, expect, test } from "vite-plus/test";
import type { Timeline, TimelineEvent } from "../../../shared/timelines.ts";
import {
  DEFAULT_FILTERS,
  groupTimelines,
  layoutGraph,
  lineState,
  type Row,
  type TimelineGraph,
} from "./timelineGraph.ts";

// A small history, a minute per step:
//   1 search forks from main            5 search merges into ui
//   2 ui forks from main                6 main merges into ui
//   3 ui-dark forks from ui             7 ui lands on main
//   4 spike forks from main (experimental), 8 spike is abandoned
const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();

function timeline(slug: string, fields: Partial<Timeline> = {}): Timeline {
  return {
    id: `tl_${slug}`,
    slug,
    name: slug,
    policy: "approval",
    experimental: false,
    parentId: null,
    forkPoint: { commits: {}, trackerCursor: 0 },
    repos: [{ id: "app", space: "orbit", name: "app", bookmark: `timeline/${slug}` }],
    status: "active",
    accountableId: "ann",
    startedBy: "ann",
    agentIds: [],
    version: 1,
    createdAt: at(0),
    updatedAt: at(0),
    pushedAt: null,
    ...fields,
  };
}

let seq = 0;
const base = (timelineId: string, minute: number) => ({
  id: `e${++seq}`,
  seq,
  timelineId,
  actorId: "ann",
  accountableId: "ann",
  createdAt: at(minute),
});
const fork = (id: string, parentId: string | null, minute: number): TimelineEvent => ({
  ...base(id, minute),
  kind: "fork",
  parentId,
  commits: {},
  trackerCursor: 0,
});
const merge = (fromId: string | null, intoId: string | null, minute: number): TimelineEvent => ({
  ...base((intoId ?? fromId)!, minute),
  kind: "merge",
  fromId,
  intoId,
  repoId: "app",
  commit: "c".repeat(40),
  parent: "p".repeat(40),
  refUpdateId: null,
});
const abandon = (id: string, minute: number): TimelineEvent => ({
  ...base(id, minute),
  kind: "abandon",
  lastCommits: {},
});

function history() {
  seq = 0;
  const timelines = [
    timeline("search", { createdAt: at(1), pushedAt: at(5) }),
    timeline("ui", { createdAt: at(2), pushedAt: at(6), status: "active" }),
    timeline("ui-dark", { createdAt: at(3), parentId: "tl_ui", pushedAt: at(9) }),
    timeline("spike", {
      createdAt: at(4),
      experimental: true,
      status: "abandoned",
      startedBy: "agt_bot",
      agentIds: ["agt_bot"],
    }),
  ];
  const events = [
    fork("tl_search", null, 1),
    fork("tl_ui", null, 2),
    fork("tl_ui-dark", "tl_ui", 3),
    fork("tl_spike", null, 4),
    merge("tl_search", "tl_ui", 5),
    merge(null, "tl_ui", 6),
    merge("tl_ui", null, 7),
    abandon("tl_spike", 8),
  ];
  return {
    timelines,
    events,
    actors: {
      ann: { name: "Ann", accountableId: null },
      agt_bot: { name: "bot", accountableId: "ann" },
    },
    projects: { app: [{ id: "w1", slug: "web", name: "Web" }] },
  };
}

const kinds = (graph: TimelineGraph) =>
  graph.rows.map((r) => `${r.kind}:${r.timeline?.slug ?? "main"}`);
const row = (graph: TimelineGraph, kind: Row["kind"], slug: string) =>
  graph.rows.find((r) => r.kind === kind && r.timeline?.slug === slug)!;
const lane = (graph: TimelineGraph, slug: string) =>
  graph.lanes.find((l) => l.timeline?.slug === slug);

describe("line state", () => {
  test("a merge into main with no push since is a landing", () => {
    const data = history();
    const [search, ui, uiDark, spike] = data.timelines;
    expect(lineState(ui!, data.events)).toBe("landed");
    expect(lineState(search!, data.events)).toBe("open");
    expect(lineState(spike!, data.events)).toBe("abandoned");
    // Pushed after landing: still going.
    expect(lineState({ ...ui!, pushedAt: at(20) }, data.events)).toBe("open");
    expect(lineState({ ...uiDark!, status: "landed" }, data.events)).toBe("landed");
  });
});

describe("with main selected", () => {
  test("main runs down the middle; open lanes beside it; landed ones fold onto main", () => {
    const graph = layoutGraph(history(), { selected: null });
    expect(kinds(graph)).toEqual([
      "main:main",
      "head:ui-dark",
      "landing:ui",
      "merge:ui",
      "head:search",
      "merge:ui",
      "fork:ui-dark",
      "fork:ui",
      "fork:search",
    ]);
    // ui landed, so it is one node on main; but ui-dark forked from it, so its
    // lane is drawn to connect ui-dark to main.
    expect(lane(graph, "ui")).toBeDefined();
    expect(row(graph, "landed", "ui")).toBeUndefined();
    expect(graph.lanes[0]).toMatchObject({ id: "main", column: 0 });
  });

  test("a landed timeline with nothing drawn on it is a single node on main", () => {
    const data = history();
    data.timelines = data.timelines.filter((t) => t.slug !== "ui-dark");
    data.events = data.events.filter((e) => e.timelineId !== "tl_ui-dark");
    const graph = layoutGraph(data, { selected: null });
    expect(kinds(graph)).toEqual([
      "main:main",
      "landed:ui",
      // search's merge into ui, which isn't drawn: a stub on search's lane.
      "head:search",
      "merged-out:search",
      "fork:search",
    ]);
    expect(row(graph, "landed", "ui")).toMatchObject({ node: 0, link: null });
    expect(lane(graph, "ui")).toBeUndefined();
  });

  test("expanding a landed timeline draws its lane, merges and landing", () => {
    const data = history();
    data.timelines = data.timelines.filter((t) => t.slug !== "ui-dark");
    data.events = data.events.filter((e) => e.timelineId !== "tl_ui-dark");
    const graph = layoutGraph(data, { selected: null, expanded: new Set(["tl_ui"]) });
    expect(kinds(graph)).toEqual([
      "main:main",
      "landing:ui",
      "merge:ui",
      "head:search",
      "merge:ui",
      "fork:ui",
      "fork:search",
    ]);
    const ui = lane(graph, "ui")!;
    const search = lane(graph, "search")!;
    // The landing is a node on main joined to ui's lane; the lane ends there.
    expect(row(graph, "landing", "ui")).toMatchObject({ node: 0, link: ui.column });
    expect(ui.top).toBe(2);
    expect(ui.state).toBe("landed");
    // Main into ui, then search into ui: each a node on ui joined to the other side.
    const merges = graph.rows.filter((r) => r.kind === "merge");
    expect(merges.map((r) => [r.node, r.link])).toEqual([
      [ui.column, 0],
      [ui.column, search.column],
    ]);
    // The two trees sit on either side of main.
    expect(Math.sign(ui.column)).toBe(-Math.sign(search.column));
  });

  test("abandoned lanes are shown when asked for and end with their abandon row", () => {
    const graph = layoutGraph(history(), {
      selected: null,
      filters: { ...DEFAULT_FILTERS, abandoned: true },
    });
    const spike = lane(graph, "spike")!;
    expect(spike).toMatchObject({ state: "abandoned", dashed: true });
    const end = graph.rows.findIndex((r) => r.kind === "abandon");
    expect(spike.top).toBe(end + 0.5);
    expect(graph.rows.some((r) => r.kind === "head" && r.timeline?.slug === "spike")).toBe(false);
  });

  test("filters hide experimental and abandoned timelines, and search narrows", () => {
    const data = history();
    expect(layoutGraph(data, { selected: null }).filtered).toBe(1);
    const noExperiments = layoutGraph(data, {
      selected: null,
      filters: { ...DEFAULT_FILTERS, abandoned: true, experimental: false },
    });
    expect(lane(noExperiments, "spike")).toBeUndefined();
    const searched = layoutGraph(data, {
      selected: null,
      filters: { ...DEFAULT_FILTERS, search: "sea" },
    });
    expect(searched.lanes.map((l) => l.id)).toEqual(["main", "tl_search"]);
  });

  test("the stalled view leaves experimental timelines out (CORE-86)", () => {
    const data = history();
    data.timelines.push(
      timeline("quiet-spike", { experimental: true, status: "idle" }),
      timeline("quiet", { status: "idle" }),
    );
    const now = Date.parse(at(0)) + 10 * 24 * 60 * 60 * 1000;
    const stalled = layoutGraph(data, {
      selected: null,
      now,
      filters: { ...DEFAULT_FILTERS, stalled: true },
    });
    const drawn = stalled.lanes.map((l) => l.id).filter((id) => id !== "main");
    // Ten days on, every open timeline that will land has stalled; experiments haven't.
    expect(drawn).toContain("tl_quiet");
    expect(drawn).toContain("tl_search");
    expect(drawn).not.toContain("tl_quiet-spike");
    expect(drawn).not.toContain("tl_spike");
    // Grouped by status (ui landed, so it folds onto main), quiet experiments sit apart.
    const groups = layoutGraph(data, { selected: null, now, laneLimit: 0 }).groups;
    expect(groups.map((g) => [g.label, g.timelines.map((t) => t.slug).sort()])).toEqual([
      ["Stalled", ["quiet", "search", "ui-dark"]],
      ["Experimental, quiet", ["quiet-spike"]],
    ]);
  });
});

describe("with a timeline selected", () => {
  test("draws it, its parents and what depends on it; the rest is grouped", () => {
    const data = history();
    const graph = layoutGraph(data, { selected: "tl_search" });
    // search merged into ui; ui-dark forked from ui: both depend on search.
    expect(graph.lanes.map((l) => l.timeline?.slug ?? "main").sort()).toEqual([
      "main",
      "search",
      "ui",
      "ui-dark",
    ]);
    // The merge between timelines is drawn between their lanes.
    const ui = lane(graph, "ui")!;
    const search = lane(graph, "search")!;
    expect(row(graph, "merge", "ui")).toBeDefined();
    expect(graph.rows.find((r) => r.kind === "merge" && r.link === search.column)?.node).toBe(
      ui.column,
    );
    // The selection's tree sits to the right of main; a fork sits further out than its parent.
    expect(search.column).toBeGreaterThan(0);
    expect(Math.abs(lane(graph, "ui-dark")!.column)).toBeGreaterThan(Math.abs(ui.column));
  });

  test("a selected child brings its parent's lane so it reaches main", () => {
    const graph = layoutGraph(history(), { selected: "tl_ui-dark" });
    expect(graph.lanes.map((l) => l.timeline?.slug ?? "main")).toEqual(["main", "ui", "ui-dark"]);
    const ui = lane(graph, "ui")!;
    expect(row(graph, "fork", "ui-dark").link).toBe(ui.column);
    expect(row(graph, "fork", "ui").link).toBe(0);
    // search merged into ui, which is drawn only to connect: a stub, not a lane.
    const stub = graph.rows.find((r) => r.kind === "merge" && r.peer?.slug === "search");
    expect(stub).toMatchObject({ node: ui.column, link: null });
    expect(graph.groups.flatMap((g) => g.timelines.map((t) => t.slug))).toEqual(["search"]);
  });

  test("a selected landed timeline is drawn as a lane, not folded", () => {
    const graph = layoutGraph(history(), { selected: "tl_ui" });
    expect(lane(graph, "ui")).toBeDefined();
    expect(graph.rows.some((r) => r.kind === "landed")).toBe(false);
    expect(row(graph, "landing", "ui")).toMatchObject({ node: 0 });
    // search merged into ui: drawn as its source.
    expect(lane(graph, "search")).toBeDefined();
  });

  test("a merge into a timeline that isn't drawn is a stub on the source's lane", () => {
    const data = history();
    const graph = layoutGraph(data, {
      selected: "tl_search",
      filters: { ...DEFAULT_FILTERS, search: "search" },
    });
    // ui depends on search but the search hides it.
    expect(lane(graph, "ui")).toBeUndefined();
    expect(row(graph, "merged-out", "search")).toMatchObject({
      node: lane(graph, "search")!.column,
      link: null,
      peer: expect.objectContaining({ slug: "ui" }),
    });
  });
});

describe("columns", () => {
  test("a column is reused once the lane before it has ended", () => {
    seq = 0;
    const a = timeline("a", { createdAt: at(1), status: "abandoned" });
    const b = timeline("b", { createdAt: at(10), pushedAt: at(11) });
    const c = timeline("c", { createdAt: at(1), pushedAt: at(12) });
    const graph = layoutGraph(
      {
        timelines: [a, b, c],
        events: [
          fork("tl_a", null, 1),
          fork("tl_c", null, 1),
          abandon("tl_a", 2),
          fork("tl_b", null, 10),
        ],
        actors: {},
        projects: {},
      },
      { selected: null, filters: { ...DEFAULT_FILTERS, abandoned: true } },
    );
    const columns = Object.fromEntries(graph.lanes.map((l) => [l.id, l.column]));
    // a and c sit on either side; b starts after a ended and takes its place.
    expect(columns.tl_b).toBe(columns.tl_a);
    expect(columns.tl_c).toBe(-columns.tl_a!);
    expect(graph.max - graph.min).toBe(2);
  });

  test("dozens of open timelines: the most recent are lanes, the rest are grouped", () => {
    seq = 0;
    const many = Array.from({ length: 40 }, (_, i) =>
      timeline(`t${i}`, { createdAt: at(i), pushedAt: at(i + 1) }),
    );
    const graph = layoutGraph(
      {
        timelines: many,
        events: many.map((t, i) => fork(t.id, null, i)),
        actors: {},
        projects: {},
      },
      { selected: null },
    );
    expect(graph.lanes).toHaveLength(11);
    expect(graph.overflow).toBe(30);
    expect(graph.groups.flatMap((g) => g.timelines)).toHaveLength(30);
    expect(lane(graph, "t39")).toBeDefined();
    expect(lane(graph, "t0")).toBeUndefined();
    // Lanes reuse columns where they can, so the graph stays narrow.
    expect(graph.max - graph.min).toBeLessThanOrEqual(10);
  });
});

describe("groups", () => {
  test("by status, project, agent and person", () => {
    const data = history();
    const ts = data.timelines;
    expect(groupTimelines(ts, "status", data).map((g) => [g.label, g.timelines.length])).toEqual([
      ["Active", 3],
      ["Abandoned", 1],
    ]);
    expect(groupTimelines(ts, "project", data).map((g) => g.label)).toEqual(["Web"]);
    expect(
      groupTimelines(ts, "agent", data).map((g) => [g.label, g.timelines.map((t) => t.slug)]),
    ).toEqual([
      ["bot", ["spike"]],
      ["No agent", ["search", "ui", "ui-dark"]],
    ]);
    expect(groupTimelines(ts, "person", data).map((g) => g.label)).toEqual(["Ann"]);
    const elsewhere = { ...data, projects: {} };
    expect(groupTimelines(ts, "project", elsewhere).map((g) => g.label)).toEqual(["No project"]);
  });
});
