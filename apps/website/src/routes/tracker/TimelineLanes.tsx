// The timeline graph's drawing (CORE-81): one SVG of lanes, connectors and
// nodes behind a list of rows, one row per event, newest first. Status is
// carried by shape and words, never by a hue alone; amber marks the selection.

import type { ReactNode } from "react";
import type { Timeline, TimelineEvent, TimelineStatus } from "../../../shared/timelines.ts";
import { STATUS_LABEL, type Lane, type Row, type TimelineGraph } from "./timelineGraph.ts";

export const ROW_HEIGHT = 36;
const LANE_WIDTH = 16;
const PAD = 12;

export function graphWidth(graph: Pick<TimelineGraph, "min" | "max">): number {
  return PAD * 2 + (graph.max - graph.min) * LANE_WIDTH;
}

const xOf = (column: number, min: number) => PAD + (column - min) * LANE_WIDTH;

/** The repository an event happened in, from the timelines that name it. */
export function eventRepo(
  event: TimelineEvent | null,
  timelines: (Timeline | null | undefined)[],
): { owner: string; name: string } | null {
  if (!event || event.kind !== "merge") return null;
  for (const t of timelines) {
    const repo = t?.repos.find((r) => r.id === event.repoId);
    if (repo) return repo;
  }
  return null;
}

type Stroke = { color: string; width: number };

function laneStroke(lane: Lane, selected: string | null, hovered: string | null): Stroke {
  if (lane.id === "main")
    return { color: selected === null ? "var(--signal-line)" : "var(--ink-muted)", width: 2.5 };
  if (lane.id === selected) return { color: "var(--signal-line)", width: 2.5 };
  if (lane.id === hovered) return { color: "var(--ink)", width: 2 };
  return { color: lane.state === "open" ? "var(--ink-faint)" : "var(--line)", width: 1.5 };
}

/** A head node by status: filled while active, a ring while it waits on something. */
function HeadNode({ x, y, status }: { x: number; y: number; status: TimelineStatus }) {
  switch (status) {
    case "active":
      return <circle cx={x} cy={y} r={4.5} fill="var(--ink)" />;
    case "waiting":
      return <circle cx={x} cy={y} r={4.5} fill="var(--ink-faint)" />;
    case "landing":
    case "partly_landed":
      return (
        <circle cx={x} cy={y} r={4} fill="var(--pane)" stroke="var(--online)" strokeWidth={2} />
      );
    default:
      return (
        <circle
          cx={x}
          cy={y}
          r={4}
          fill="var(--pane)"
          stroke="var(--ink-faint)"
          strokeWidth={1.5}
        />
      );
  }
}

function Node({ row, x, y }: { row: Row; x: number; y: number }) {
  switch (row.kind) {
    case "main":
      return <rect x={x - 5} y={y - 5} width={10} height={10} rx={2} fill="var(--ink-muted)" />;
    case "head":
      return <HeadNode x={x} y={y} status={row.timeline!.status} />;
    case "fork":
    case "merged-out":
      return (
        <circle
          cx={x}
          cy={y}
          r={3}
          fill="var(--pane)"
          stroke="var(--ink-muted)"
          strokeWidth={1.5}
        />
      );
    case "merge":
      return <circle cx={x} cy={y} r={4} fill="var(--ink-muted)" />;
    case "landing":
      return <circle cx={x} cy={y} r={4.5} fill="var(--online)" />;
    case "landed":
      // A whole landed timeline, folded: one square node on main.
      return <rect x={x - 5} y={y - 5} width={10} height={10} rx={2} fill="var(--online)" />;
    case "abandon":
      return (
        <g stroke="var(--ink-muted)" strokeWidth={2} strokeLinecap="round" data-mark="abandoned">
          <line x1={x - 4} y1={y - 4} x2={x + 4} y2={y + 4} />
          <line x1={x - 4} y1={y + 4} x2={x + 4} y2={y - 4} />
        </g>
      );
    default:
      return (
        <circle cx={x} cy={y} r={4} fill="var(--pane)" stroke="var(--ink)" strokeWidth={1.5} />
      );
  }
}

/** The lanes, connectors and nodes; decorative, since every row says the same in words. */
export function LaneDrawing({
  graph,
  selected,
  hovered,
}: {
  graph: TimelineGraph;
  selected: string | null;
  hovered: string | null;
}) {
  const width = graphWidth(graph);
  const height = graph.rows.length * ROW_HEIGHT;
  const x = (column: number) => xOf(column, graph.min);
  const strokes = new Map(graph.lanes.map((l) => [l.id, laneStroke(l, selected, hovered)]));
  // Selected and hovered lanes draw last, above the others.
  const lanes = [...graph.lanes].sort(
    (a, b) =>
      Number(a.id === selected || a.id === hovered) - Number(b.id === selected || b.id === hovered),
  );
  return (
    <svg
      className="pointer-events-none absolute top-0 left-0"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden
      data-testid="timeline-lanes"
    >
      {lanes.map((lane) => {
        const stroke = strokes.get(lane.id)!;
        return (
          <line
            key={lane.id}
            data-lane={lane.timeline?.slug ?? "main"}
            x1={x(lane.column)}
            x2={x(lane.column)}
            y1={lane.top * ROW_HEIGHT}
            y2={lane.bottom * ROW_HEIGHT}
            stroke={stroke.color}
            strokeWidth={stroke.width}
            strokeDasharray={lane.dashed ? "5 4" : undefined}
            strokeLinecap="round"
          />
        );
      })}
      {graph.rows.map((row, r) => {
        if (row.link === null) return null;
        const x1 = x(row.node);
        const y1 = (r + 0.5) * ROW_HEIGHT;
        const x2 = x(row.link);
        const y2 = (r + 1) * ROW_HEIGHT;
        // The connector takes the style of the timeline the row is about.
        const lane = row.timeline ? graph.lanes.find((l) => l.id === row.timeline!.id) : undefined;
        const stroke = lane ? strokes.get(lane.id)! : strokes.get("main")!;
        return (
          <path
            key={`link:${row.key}`}
            d={`M ${x1} ${y1} C ${x1} ${y2} ${x2} ${y1} ${x2} ${y2}`}
            fill="none"
            stroke={stroke.color}
            strokeWidth={Math.min(stroke.width, 2)}
            strokeDasharray={lane?.dashed ? "5 4" : undefined}
          />
        );
      })}
      {graph.rows.map((row, r) => (
        <g key={`node:${row.key}`} data-kind={row.kind}>
          <Node row={row} x={x(row.node)} y={(r + 0.5) * ROW_HEIGHT} />
        </g>
      ))}
    </svg>
  );
}

/** One row's words: who did what, with the other side named. */
export function RowText({
  row,
  name,
  commit,
}: {
  row: Row;
  /** A timeline's name, linked to select it; null is main. */
  name: (timeline: Timeline | null) => ReactNode;
  /** The merge commit, linked, when the row has one. */
  commit?: ReactNode;
}) {
  const t = row.timeline;
  const peer = row.peer ?? null;
  // Inline words with spaces, so the row truncates as one line of text.
  const verb = (text: string) => <span className="text-ink-muted">{` ${text} `}</span>;
  switch (row.kind) {
    case "main":
      return <>{name(null)}</>;
    case "head":
      return (
        <>
          {name(t)}
          {verb(STATUS_LABEL[t!.status].toLowerCase())}
        </>
      );
    case "fork":
      return (
        <>
          {name(t)}
          {verb("forked from")}
          {name(peer)}
        </>
      );
    case "merge":
      return (
        <>
          {name(peer)}
          {verb("merged into")}
          {name(t)}
          {commit && <> {commit}</>}
        </>
      );
    case "merged-out":
      return (
        <>
          {name(t)}
          {verb("merged into")}
          {name(peer)}
          {commit && <> {commit}</>}
        </>
      );
    case "landing":
    case "landed":
      return (
        <>
          {name(t)}
          {verb("landed on")}
          {name(null)}
          {commit && <> {commit}</>}
        </>
      );
    case "abandon":
      return (
        <>
          {name(t)}
          {verb("abandoned")}
        </>
      );
    default:
      return (
        <>
          {verb(`${row.event?.kind ?? "event"} in`)}
          {name(t)}
        </>
      );
  }
}
