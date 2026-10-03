// The timeline graph's layout (CORE-81; TIMELINES-RESEARCH.md, "Visualization
// and switching timelines"). Main runs down the middle and each drawn timeline
// is a lane beside it; rows are events, newest first, like `gm log`.
//
// It never draws every timeline. With a timeline selected it draws that one,
// the timelines it forked from (so its lane reaches main), what depends on it
// (timelines forked from it or that merged its work, transitively) and the
// timelines it merged from. With main selected it draws the most recently
// active timelines that haven't landed. Landed timelines fold into one node on main unless
// they are selected, expanded, or needed to connect a drawn lane; everything
// else is listed in groups beside the graph.

import type { TimelineActor, TimelineGraphData } from "../../../shared/timeline-graph.ts";
import type { Timeline, TimelineEvent, TimelineStatus } from "../../../shared/timelines.ts";

/** Where a timeline stands, for drawing: still going, landed on main, or abandoned. */
export type LineState = "open" | "landed" | "abandoned";

export type GroupBy = "status" | "workspace" | "agent" | "person";

export interface GraphFilters {
  open: boolean;
  landed: boolean;
  abandoned: boolean;
  /** Timelines flagged experimental; off hides them unless selected. */
  experimental: boolean;
  /** Words matched against name and slug. */
  search: string;
}

export const DEFAULT_FILTERS: GraphFilters = {
  open: true,
  landed: true,
  abandoned: false,
  experimental: true,
  search: "",
};

/** Lanes drawn with main selected, before the rest go to groups. */
export const LANE_LIMIT = 10;

export interface GraphOptions {
  /** The selected timeline's id; null is main. */
  selected: string | null;
  filters?: GraphFilters;
  /** Landed timelines drawn as lanes instead of single nodes on main. */
  expanded?: ReadonlySet<string>;
  groupBy?: GroupBy;
  laneLimit?: number;
}

export interface Lane {
  /** `main`, or the timeline's id. */
  id: string;
  timeline: Timeline | null;
  /** 0 is main; timelines sit to the right (positive) or left (negative). */
  column: number;
  /** Extent in row units: a node at row r sits at r + 0.5. */
  top: number;
  bottom: number;
  state: LineState;
  dashed: boolean;
}

export type RowKind =
  /** Main's own header row. */
  | "main"
  /** An open timeline's latest point. */
  | "head"
  | "fork"
  /** A merge from main or another timeline into this one. */
  | "merge"
  /** This timeline's work merged into a timeline that isn't drawn. */
  | "merged-out"
  /** A merge of this timeline into main, with its lane drawn. */
  | "landing"
  /** A landed timeline folded into one node on main. */
  | "landed"
  | "abandon"
  /** Checkpoints, approvals and whatever else later steps record. */
  | "event";

export interface Row {
  key: string;
  kind: RowKind;
  /** The timeline the row is about; null for main's own row. */
  timeline: Timeline | null;
  /** The lane column the node sits on. */
  node: number;
  /** A connector from the node down to this column, joining it just below the row. */
  link: number | null;
  /**
   * The other side of a fork, merge or landing: a timeline, or null for main.
   * When it isn't drawn, `link` is null and the row names it instead.
   */
  peer?: Timeline | null;
  event: TimelineEvent | null;
  at: string;
}

export interface Group {
  key: string;
  label: string;
  timelines: Timeline[];
}

export interface TimelineGraph {
  lanes: Lane[];
  rows: Row[];
  /** The leftmost and rightmost columns in use (main's 0 always). */
  min: number;
  max: number;
  /** Timelines neither drawn as lanes nor folded on main, grouped. */
  groups: Group[];
  /** Timelines the filters hide. */
  filtered: number;
  /** Timelines left out of the lanes because of the lane limit (main selected). */
  overflow: number;
}

type Merge = Extract<TimelineEvent, { kind: "merge" }>;

/** Merges of a timeline into main, oldest first. */
export function landingsOf(timeline: Timeline, events: TimelineEvent[]): Merge[] {
  return events.filter(
    (e): e is Merge => e.kind === "merge" && e.fromId === timeline.id && e.intoId === null,
  );
}

/**
 * Landed when its status says so, or when its work merged into main and
 * nothing was pushed to it since (the landing queue that sets `landed` comes
 * later; a merge into main is a landing either way).
 */
export function lineState(timeline: Timeline, events: TimelineEvent[]): LineState {
  if (timeline.status === "abandoned") return "abandoned";
  if (timeline.status === "landed") return "landed";
  const last = landingsOf(timeline, events).at(-1);
  if (last && (!timeline.pushedAt || timeline.pushedAt <= last.createdAt)) return "landed";
  return "open";
}

/** When it last moved: its last push, or its newest event. */
export function lastActivity(timeline: Timeline, events: TimelineEvent[]): string {
  let at = timeline.pushedAt ?? timeline.createdAt;
  for (const e of events) if (involves(e, timeline.id) && e.createdAt > at) at = e.createdAt;
  return at;
}

/** Whether an event belongs to a timeline's history. */
export function involves(event: TimelineEvent, id: string): boolean {
  if (event.timelineId === id) return true;
  if (event.kind === "merge") return event.fromId === id || event.intoId === id;
  if (event.kind === "fork") return event.parentId === id;
  return false;
}

const STATUS_ORDER: TimelineStatus[] = [
  "waiting",
  "landing",
  "partly_landed",
  "active",
  "idle",
  "landed",
  "abandoned",
];

export const STATUS_LABEL: Record<TimelineStatus, string> = {
  active: "Active",
  idle: "Idle",
  waiting: "Waiting for approval",
  landing: "Landing",
  partly_landed: "Partly landed",
  landed: "Landed",
  abandoned: "Abandoned",
};

function matches(timeline: Timeline, words: string[]): boolean {
  const hay = `${timeline.name} ${timeline.slug}`.toLowerCase();
  return words.every((word) => hay.includes(word));
}

/** Group timelines; a timeline in several workspaces is listed under each. */
export function groupTimelines(
  timelines: Timeline[],
  by: GroupBy,
  data: Pick<TimelineGraphData, "actors" | "workspaces">,
): Group[] {
  const groups = new Map<string, Group>();
  const add = (key: string, label: string, timeline: Timeline) => {
    const group = groups.get(key) ?? { key, label, timelines: [] };
    group.timelines.push(timeline);
    groups.set(key, group);
  };
  const nameOf = (id: string) => data.actors[id]?.name ?? "Someone outside the tracker";
  for (const timeline of timelines) {
    if (by === "status") add(timeline.status, STATUS_LABEL[timeline.status], timeline);
    else if (by === "workspace") {
      const seen = new Map<string, string>();
      for (const repo of timeline.repos)
        for (const w of data.workspaces[repo.id] ?? []) seen.set(w.id, w.name);
      if (!seen.size) add("", "No workspace", timeline);
      for (const [id, name] of seen) add(id, name, timeline);
    } else if (by === "agent") {
      const agent = isAgent(timeline.startedBy, data.actors)
        ? timeline.startedBy
        : timeline.agentIds[0];
      if (agent) add(agent, nameOf(agent), timeline);
      else add("", "No agent", timeline);
    } else add(timeline.accountableId, nameOf(timeline.accountableId), timeline);
  }
  const list = [...groups.values()];
  if (by === "status")
    return list.sort(
      (a, b) =>
        STATUS_ORDER.indexOf(a.key as TimelineStatus) -
        STATUS_ORDER.indexOf(b.key as TimelineStatus),
    );
  // Largest first; the catch-all group last.
  return list.sort(
    (a, b) =>
      Number(a.key === "") - Number(b.key === "") ||
      b.timelines.length - a.timelines.length ||
      a.label.localeCompare(b.label),
  );
}

function isAgent(id: string, actors: Record<string, TimelineActor>): boolean {
  return !!actors[id]?.accountableId;
}

export function layoutGraph(
  data: Pick<TimelineGraphData, "timelines" | "events" | "actors" | "workspaces">,
  options: GraphOptions,
): TimelineGraph {
  const filters = options.filters ?? DEFAULT_FILTERS;
  const expanded = options.expanded ?? new Set<string>();
  const laneLimit = options.laneLimit ?? LANE_LIMIT;
  const { timelines, events } = data;
  const byId = new Map(timelines.map((t) => [t.id, t]));
  const state = new Map(timelines.map((t) => [t.id, lineState(t, events)]));
  const selected = options.selected ? (byId.get(options.selected) ?? null) : null;

  const words = filters.search.toLowerCase().split(/\s+/).filter(Boolean);
  const passes = (t: Timeline) =>
    t === selected ||
    (filters[state.get(t.id)!] && (filters.experimental || !t.experimental) && matches(t, words));
  const visible = timelines.filter(passes);

  const ancestors = (t: Timeline): Timeline[] => {
    const chain: Timeline[] = [];
    const seen = new Set([t.id]);
    for (let p = t.parentId ? byId.get(t.parentId) : undefined; p && !seen.has(p.id);) {
      chain.push(p);
      seen.add(p.id);
      p = p.parentId ? byId.get(p.parentId) : undefined;
    }
    return chain;
  };

  // The lanes: the focus, then whatever connects it to main.
  const lanes = new Set<Timeline>();
  /** Drawn because something else needs them: never folded or filtered. */
  const required = new Set<Timeline>();
  let overflow = 0;
  if (selected) {
    lanes.add(selected);
    required.add(selected);
    // What depends on it: forks from it and timelines its work merged into, transitively.
    const queue = [selected];
    const reached = new Set([selected.id]);
    while (queue.length) {
      const at = queue.shift()!;
      const next = [
        ...timelines.filter((t) => t.parentId === at.id),
        ...events
          .filter((e): e is Merge => e.kind === "merge" && e.fromId === at.id && !!e.intoId)
          .map((e) => byId.get(e.intoId!))
          .filter((t): t is Timeline => !!t),
      ];
      for (const t of next) {
        if (reached.has(t.id)) continue;
        reached.add(t.id);
        queue.push(t);
        if (passes(t)) lanes.add(t);
      }
    }
    // What it merged from, one step.
    for (const e of events)
      if (e.kind === "merge" && e.intoId === selected.id && e.fromId) {
        const from = byId.get(e.fromId);
        if (from && passes(from)) lanes.add(from);
      }
  } else {
    // Open timelines, and abandoned ones when shown, most recently active first.
    const open = visible
      .filter((t) => state.get(t.id) !== "landed")
      .map((t) => ({ t, at: lastActivity(t, events) }))
      .sort((a, b) => b.at.localeCompare(a.at));
    for (const { t } of open.slice(0, laneLimit)) lanes.add(t);
    overflow = Math.max(0, open.length - laneLimit);
  }
  for (const t of visible) if (expanded.has(t.id)) lanes.add(t);
  // Landed timelines fold onto main unless selected, expanded or connecting.
  for (const t of lanes)
    if (state.get(t.id) === "landed" && !required.has(t) && !expanded.has(t.id)) lanes.delete(t);
  for (const t of lanes)
    for (const a of ancestors(t)) {
      lanes.add(a);
      required.add(a);
    }

  // With a timeline selected, main's history starts where its oldest drawn lane forked.
  const since = selected
    ? [...lanes].reduce((min, t) => (t.createdAt < min ? t.createdAt : min), selected.createdAt)
    : "";
  const landedAt = (t: Timeline) => landingsOf(t, events).at(-1)?.createdAt ?? t.updatedAt;
  const folded = visible.filter(
    (t) => !lanes.has(t) && state.get(t.id) === "landed" && landedAt(t) >= since,
  );
  const grouped = visible.filter((t) => !lanes.has(t) && state.get(t.id) !== "landed");

  // Rows, before columns are known: lanes are referred to by id, main by null.
  interface Draft {
    key: string;
    kind: RowKind;
    timeline: Timeline | null;
    node: string | null;
    link?: string | null;
    peer?: Timeline | null;
    event: TimelineEvent | null;
    at: string;
    seq: number;
  }
  const drafts: Draft[] = [];
  const drawn = (id: string | null) => id === null || lanes.has(byId.get(id)!);
  const forked = new Set<string>();
  for (const e of events) {
    if (e.kind === "fork") {
      const t = byId.get(e.timelineId);
      if (!t || !lanes.has(t)) continue;
      forked.add(t.id);
      const parent = e.parentId === null ? null : (byId.get(e.parentId) ?? null);
      drafts.push({
        key: e.id,
        kind: "fork",
        timeline: t,
        node: t.id,
        link: drawn(e.parentId) ? e.parentId : undefined,
        peer: parent,
        event: e,
        at: e.createdAt,
        seq: e.seq,
      });
    } else if (e.kind === "merge") {
      const from = e.fromId === null ? null : (byId.get(e.fromId) ?? null);
      const into = e.intoId === null ? null : (byId.get(e.intoId) ?? null);
      const fromDrawn = drawn(e.fromId) && (e.fromId === null || !!from);
      const intoDrawn = drawn(e.intoId) && (e.intoId === null || !!into);
      if (e.intoId === null) {
        // A landing: drawn on main when its lane is, folded otherwise.
        if (from && fromDrawn)
          drafts.push({
            key: e.id,
            kind: "landing",
            timeline: from,
            node: null,
            link: from.id,
            peer: null,
            event: e,
            at: e.createdAt,
            seq: e.seq,
          });
      } else if (into && intoDrawn)
        drafts.push({
          key: e.id,
          kind: "merge",
          timeline: into,
          node: into.id,
          link: fromDrawn ? e.fromId : undefined,
          peer: from,
          event: e,
          at: e.createdAt,
          seq: e.seq,
        });
      else if (from && e.fromId !== null && fromDrawn)
        drafts.push({
          key: e.id,
          kind: "merged-out",
          timeline: from,
          node: from.id,
          peer: into,
          event: e,
          at: e.createdAt,
          seq: e.seq,
        });
    } else {
      const t = byId.get(e.timelineId);
      if (!t || !lanes.has(t)) continue;
      drafts.push({
        key: e.id,
        kind: e.kind === "abandon" ? "abandon" : "event",
        timeline: t,
        node: t.id,
        event: e,
        at: e.createdAt,
        seq: e.seq,
      });
    }
  }
  for (const t of lanes) {
    // Events older than the payload reached: start the lane at its creation.
    if (!forked.has(t.id)) {
      const parent = t.parentId === null ? null : (byId.get(t.parentId) ?? null);
      drafts.push({
        key: `fork:${t.id}`,
        kind: "fork",
        timeline: t,
        node: t.id,
        link: drawn(t.parentId) && (t.parentId === null || parent) ? t.parentId : undefined,
        peer: parent,
        event: null,
        at: t.createdAt,
        seq: -1,
      });
    }
    if (state.get(t.id) === "open")
      drafts.push({
        key: `head:${t.id}`,
        kind: "head",
        timeline: t,
        node: t.id,
        event: null,
        at: lastActivity(t, events),
        seq: Number.MAX_SAFE_INTEGER,
      });
  }
  for (const t of folded) {
    const last = landingsOf(t, events).at(-1);
    drafts.push({
      key: `landed:${t.id}`,
      kind: "landed",
      timeline: t,
      node: null,
      peer: null,
      event: last ?? null,
      at: last?.createdAt ?? t.updatedAt,
      seq: last?.seq ?? -1,
    });
  }
  drafts.sort((a, b) => b.at.localeCompare(a.at) || b.seq - a.seq);
  drafts.unshift({
    key: "main",
    kind: "main",
    timeline: null,
    node: null,
    event: null,
    at: "",
    seq: 0,
  });

  // Each lane's extent: its nodes (r + 0.5), and where connectors join it (r + 1).
  const extent = new Map<string, { top: number; bottom: number }>();
  const reach = (id: string, y: number) => {
    const e = extent.get(id) ?? { top: y, bottom: y };
    extent.set(id, { top: Math.min(e.top, y), bottom: Math.max(e.bottom, y) });
  };
  drafts.forEach((d, r) => {
    if (d.node !== null) reach(d.node, r + 0.5);
    if (d.link) reach(d.link, r + 1);
  });

  // Columns: the oldest lanes first, so a fork's parent is placed before it.
  // Each tree of timelines keeps to one side of main, the selection's on the
  // right, and a child sits further out than its parent. A column is reused
  // once the lane before it has ended.
  const order = [...lanes].sort(
    (a, b) => extent.get(b.id)!.bottom - extent.get(a.id)!.bottom || a.id.localeCompare(b.id),
  );
  const rootOf = (t: Timeline): Timeline => {
    const chain = ancestors(t);
    return chain.length ? chain[chain.length - 1]! : t;
  };
  const side = new Map<string, 1 | -1>();
  const count = { 1: 0, [-1]: 0 } as Record<1 | -1, number>;
  if (selected) {
    side.set(rootOf(selected).id, 1);
    count[1]++;
  }
  const column = new Map<string, number>();
  const used = new Map<number, { top: number; bottom: number }[]>();
  for (const t of order) {
    const root = rootOf(t);
    if (!side.has(root.id)) {
      const s = count[1] <= count[-1] ? 1 : -1;
      side.set(root.id, s);
      count[s]++;
    }
    const s = side.get(root.id)!;
    const parentColumn = t.parentId ? column.get(t.parentId) : undefined;
    const span = extent.get(t.id)!;
    let distance = parentColumn === undefined ? 1 : Math.abs(parentColumn) + 1;
    for (; ; distance++) {
      const taken = used.get(s * distance) ?? [];
      if (taken.every((o) => span.bottom + 0.5 <= o.top || o.bottom + 0.5 <= span.top)) break;
    }
    column.set(t.id, s * distance);
    used.set(s * distance, [...(used.get(s * distance) ?? []), span]);
  }

  const col = (id: string | null | undefined) => (id ? column.get(id)! : 0);
  const rows: Row[] = drafts.map((d) => ({
    key: d.key,
    kind: d.kind,
    timeline: d.timeline,
    node: col(d.node),
    link: d.link === undefined ? null : col(d.link),
    ...(d.peer !== undefined ? { peer: d.peer } : {}),
    event: d.event,
    at: d.at,
  }));
  const laneList: Lane[] = [
    {
      id: "main",
      timeline: null,
      column: 0,
      top: 0.5,
      bottom: rows.length,
      state: "open",
      dashed: false,
    },
    ...order.map((t) => ({
      id: t.id,
      timeline: t,
      column: column.get(t.id)!,
      ...extent.get(t.id)!,
      state: state.get(t.id)!,
      dashed: t.experimental,
    })),
  ];
  const columns = [0, ...column.values()];
  return {
    lanes: laneList,
    rows,
    min: Math.min(...columns),
    max: Math.max(...columns),
    groups: groupTimelines(grouped, options.groupBy ?? "status", data),
    filtered: timelines.length - visible.length,
    overflow,
  };
}
