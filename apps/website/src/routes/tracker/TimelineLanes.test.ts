import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vite-plus/test";
import type { Timeline, TimelineEvent } from "../../../shared/timelines.ts";
import { DEFAULT_FILTERS, layoutGraph } from "./timelineGraph.ts";
import { LaneDrawing, RowText } from "./TimelineLanes.tsx";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 12, minute)).toISOString();
const timeline = (slug: string, fields: Partial<Timeline> = {}): Timeline => ({
  id: `tl_${slug}`,
  slug,
  name: `${slug} work`,
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
  createdAt: at(1),
  updatedAt: at(1),
  pushedAt: at(2),
  ...fields,
});
const event = (seq: number, timelineId: string, minute: number) => ({
  id: `e${seq}`,
  seq,
  timelineId,
  actorId: null,
  accountableId: null,
  createdAt: at(minute),
});

function data() {
  const timelines = [
    timeline("spike", { experimental: true, status: "abandoned" }),
    timeline("search"),
    timeline("ui", { pushedAt: at(3) }),
  ];
  const events: TimelineEvent[] = [
    { ...event(1, "tl_spike", 1), kind: "fork", parentId: null, commits: {}, trackerCursor: 0 },
    { ...event(2, "tl_search", 1), kind: "fork", parentId: null, commits: {}, trackerCursor: 0 },
    { ...event(3, "tl_ui", 1), kind: "fork", parentId: null, commits: {}, trackerCursor: 0 },
    { ...event(4, "tl_spike", 3), kind: "abandon", lastCommits: {} },
    {
      ...event(5, "tl_ui", 4),
      kind: "merge",
      fromId: "tl_ui",
      intoId: null,
      repoId: "app",
      commit: "a".repeat(40),
      parent: "b".repeat(40),
      refUpdateId: null,
    },
  ];
  return { timelines, events, actors: {}, projects: {} };
}

const draw = (selected: string | null) => {
  const graph = layoutGraph(data(), {
    selected,
    filters: { ...DEFAULT_FILTERS, abandoned: true },
  });
  return renderToStaticMarkup(createElement(LaneDrawing, { graph, selected, hovered: null }));
};

describe("the lane drawing", () => {
  test("experimental lanes are dashed, abandoned ones end with a mark, landed ones fold", () => {
    const svg = draw(null);
    expect(svg).toMatch(/<line[^>]*data-lane="spike"[^>]*stroke-dasharray="5 4"/);
    expect(svg).not.toMatch(/<line[^>]*data-lane="search"[^>]*stroke-dasharray/);
    expect(svg).toContain('data-mark="abandoned"');
    // ui landed: no lane, one square node on main.
    expect(svg).not.toContain('data-lane="ui"');
    expect(svg).toMatch(/data-kind="landed"><rect/);
    // With main selected, main is the amber lane.
    expect(svg).toMatch(/data-lane="main"[^>]*stroke="var\(--signal-line\)"/);
  });

  test("the selected timeline's lane is amber, and main steps back", () => {
    const svg = draw("tl_search");
    expect(svg).toMatch(/data-lane="search"[^>]*stroke="var\(--signal-line\)"/);
    expect(svg).toMatch(/data-lane="main"[^>]*stroke="var\(--ink-muted\)"/);
  });
});

describe("row text", () => {
  test("names both sides of a landing in words", () => {
    const graph = layoutGraph(data(), { selected: null });
    const row = graph.rows.find((r) => r.kind === "landed")!;
    const html = renderToStaticMarkup(
      createElement(RowText, {
        row,
        name: (t) => createElement(Fragment, null, `[${t ? t.name : "main"}]`),
      }),
    );
    expect(html).toBe('[ui work]<span class="text-ink-muted"> landed on </span>[main]');
  });
});
