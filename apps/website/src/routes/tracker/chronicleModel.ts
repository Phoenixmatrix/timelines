// The Chronicle's pure model (CORE-251): its address, the time scale and
// ruler ticks, rows grouped as of the playhead, and hit-testing. The view
// (Chronicle.tsx) draws and wires it; tests drive it without a browser.

import {
  spanActiveAt,
  stateAt,
  type ChronicleIssue,
  type ChronicleMarker,
  type WorkSpan,
} from "../../../shared/chronicle.ts";
import type { IssueStatus } from "../../../shared/tracker.ts";
import type { IssueState } from "./query.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The shortest window the ruler zooms to, and the longest. */
export const MIN_WINDOW = 15 * MINUTE;
export const MAX_WINDOW = 3 * 365 * DAY;

export const PRESETS = [
  { id: "24h", label: "24 h", ms: DAY },
  { id: "7d", label: "7 days", ms: 7 * DAY },
  { id: "30d", label: "30 days", ms: 30 * DAY },
  { id: "all", label: "All", ms: null },
] as const;
export type PresetId = (typeof PRESETS)[number]["id"];

export type Grouping = "status" | "team";

/** Everything the address holds for the Chronicle; the issue itself is the route's. */
export interface ChronicleAddress {
  /** The visible window. */
  from: number;
  to: number;
  /** The playhead: what "as of" means everywhere. */
  at: number;
  /** A selected range for the summary; the window when null. */
  range: { from: number; to: number } | null;
  group: Grouping;
  /** A selected work span (`<issue id>:<cursor>`). */
  span: string | null;
  /** The accessible list instead of the picture. */
  list: boolean;
}

function time(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/** The address from search params; a missing or broken part falls back to the last 7 days, as of now. */
export function readAddress(params: URLSearchParams, now: number): ChronicleAddress {
  let from = time(params.get("from"));
  let to = time(params.get("to"));
  if (from === null || to === null || to - from < MIN_WINDOW || to - from > MAX_WINDOW) {
    to = now + HOUR;
    from = to - 7 * DAY;
  }
  const at = time(params.get("at")) ?? Math.min(now, to);
  const rs = time(params.get("rs"));
  const re = time(params.get("re"));
  return {
    from,
    to,
    at,
    range: rs !== null && re !== null && re > rs ? { from: rs, to: re } : null,
    group: params.get("group") === "team" ? "team" : "status",
    span: params.get("span") || null,
    list: params.get("layout") === "list",
  };
}

const iso = (t: number) => new Date(Math.round(t)).toISOString();

/** Write the address into search params, keeping everything else (query, view). */
export function writeAddress(params: URLSearchParams, address: ChronicleAddress): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("from", iso(address.from));
  next.set("to", iso(address.to));
  next.set("at", iso(address.at));
  if (address.range) {
    next.set("rs", iso(address.range.from));
    next.set("re", iso(address.range.to));
  } else {
    next.delete("rs");
    next.delete("re");
  }
  if (address.group === "team") next.set("group", "team");
  else next.delete("group");
  if (address.span) next.set("span", address.span);
  else next.delete("span");
  if (address.list) next.set("layout", "list");
  else next.delete("layout");
  return next;
}

/** A window of `ms` ending at `end`, or all of history. */
export function presetWindow(
  preset: PresetId,
  now: number,
  earliest: number | null,
): { from: number; to: number } {
  const to = now + HOUR / 2;
  const found = PRESETS.find((p) => p.id === preset)!;
  if (found.ms !== null) return { from: to - found.ms, to };
  const start = earliest ?? now - 7 * DAY;
  const span = Math.max(MIN_WINDOW, to - start);
  return { from: start - span * 0.02, to };
}

/** Zoom by `factor` (<1 zooms in) about `pivot`, within the window limits. */
export function zoom(
  window: { from: number; to: number },
  factor: number,
  pivot: number,
): { from: number; to: number } {
  const span = window.to - window.from;
  const next = Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, span * factor));
  const ratio = (pivot - window.from) / span;
  const from = pivot - ratio * next;
  return { from, to: from + next };
}

export function pan(window: { from: number; to: number }, ms: number) {
  return { from: window.from + ms, to: window.to + ms };
}

/** Steps the ruler may tick at, each with how its labels read. */
const STEPS: { ms: number; unit: "minute" | "hour" | "day" | "month" }[] = [
  { ms: MINUTE, unit: "minute" },
  { ms: 5 * MINUTE, unit: "minute" },
  { ms: 15 * MINUTE, unit: "minute" },
  { ms: 30 * MINUTE, unit: "minute" },
  { ms: HOUR, unit: "hour" },
  { ms: 3 * HOUR, unit: "hour" },
  { ms: 6 * HOUR, unit: "hour" },
  { ms: 12 * HOUR, unit: "hour" },
  { ms: DAY, unit: "day" },
  { ms: 2 * DAY, unit: "day" },
  { ms: 7 * DAY, unit: "day" },
  { ms: 14 * DAY, unit: "day" },
  { ms: 30 * DAY, unit: "month" },
  { ms: 90 * DAY, unit: "month" },
];

/** The finest step whose ticks sit at least `minPx` apart. */
export function tickStep(span: number, width: number, minPx = 88) {
  const perPx = span / Math.max(1, width);
  return STEPS.find((s) => s.ms / perPx >= minPx) ?? STEPS.at(-1)!;
}

/**
 * Tick times in [from, to], aligned to local time: hours to the clock, days
 * to midnight, months to the first.
 */
export function ticks(from: number, to: number, width: number): { t: number; major: boolean }[] {
  const step = tickStep(to - from, width);
  const out: { t: number; major: boolean }[] = [];
  const first = new Date(from);
  if (step.unit === "month") {
    first.setHours(0, 0, 0, 0);
    first.setDate(1);
    const months = Math.round(step.ms / (30 * DAY));
    while (first.getTime() <= to && out.length < 400) {
      if (first.getTime() >= from) out.push({ t: first.getTime(), major: first.getMonth() === 0 });
      first.setMonth(first.getMonth() + months);
    }
    return out;
  }
  if (step.unit === "day") {
    first.setHours(0, 0, 0, 0);
    const days = Math.round(step.ms / DAY);
    // Weekly ticks start on Mondays.
    if (days === 7 || days === 14) first.setDate(first.getDate() - ((first.getDay() + 6) % 7));
    while (first.getTime() <= to && out.length < 400) {
      if (first.getTime() >= from) out.push({ t: first.getTime(), major: first.getDate() === 1 });
      first.setDate(first.getDate() + days);
    }
    return out;
  }
  const minutes = step.ms / MINUTE;
  first.setSeconds(0, 0);
  first.setMinutes(Math.floor(first.getMinutes() / Math.min(60, minutes)) * Math.min(60, minutes));
  if (minutes >= 60)
    first.setHours(Math.floor(first.getHours() / (minutes / 60)) * (minutes / 60), 0);
  for (let t = first.getTime(); t <= to && out.length < 400; t += step.ms) {
    if (t < from) continue;
    const d = new Date(t);
    out.push({ t, major: d.getHours() === 0 && d.getMinutes() === 0 });
  }
  return out;
}

const formats = {
  minute: new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }),
  hour: new Intl.DateTimeFormat("en", { hour: "numeric" }),
  day: new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }),
  month: new Intl.DateTimeFormat("en", { month: "short", year: "numeric" }),
  full: new Intl.DateTimeFormat("en", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }),
  date: new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }),
  stamp: new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }),
};

/** "Sep 29, 10:00 AM": a moment in a list of moments. */
export function stamp(t: number): string {
  return formats.stamp.format(new Date(t));
}

/** A tick's label: the date at midnight, otherwise the time. */
export function tickLabel(t: number, span: number, width: number): string {
  const step = tickStep(span, width);
  const d = new Date(t);
  if (step.unit === "month") return formats.month.format(d);
  if (step.unit === "day") return formats.day.format(d);
  if (d.getHours() === 0 && d.getMinutes() === 0) return formats.day.format(d);
  return step.unit === "hour" ? formats.hour.format(d) : formats.minute.format(d);
}

/** "Tue, Sep 1, 10:30 AM": a moment, as the "as of" readout says it. */
export function moment(t: number): string {
  return formats.full.format(new Date(t));
}

export function day(t: number): string {
  return formats.date.format(new Date(t));
}

/** "2 h 15 min", "45 min", "3 d 4 h". */
export function duration(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
}

/** What a row's state mark shows as of `at`. */
export function stateAsOf(issue: ChronicleIssue, at: number, now: number): IssueState | null {
  const state = stateAt(issue, at);
  if (!state.status) return null;
  if (state.waiting) return "waiting";
  if (state.status === "done_in_timeline") return "done_in_timeline";
  if (issue.spans.some((s) => !s.retained && spanActiveAt(s, at, now) && workingAt(s, at)))
    return "claimed";
  return state.status;
}

/** A span is worked at `at` unless it was parked or retained then. */
function workingAt(span: WorkSpan, at: number): boolean {
  if (span.retained && Date.parse(span.retained.at) <= at) return false;
  return !span.parked.some(
    (p) => Date.parse(p.from) <= at && (p.to === null || at < Date.parse(p.to)),
  );
}

export const STATUS_ORDER: (IssueStatus | "none")[] = [
  "in_progress",
  "todo",
  "backlog",
  "done_in_timeline",
  "done",
  "canceled",
  "none",
];
export const STATUS_WORDS: Record<IssueStatus | "none", string> = {
  in_progress: "In progress",
  todo: "To do",
  backlog: "Backlog",
  done_in_timeline: "Done in a timeline",
  done: "Done",
  canceled: "Canceled",
  none: "Not created yet",
};

export type Row =
  | { kind: "group"; id: string; label: string; count: number }
  | { kind: "issue"; id: string; issue: ChronicleIssue };

const KEY_ORDER = new Intl.Collator("en", { numeric: true });

/** Rows in groups: by status as of the playhead (in working order), or by team. */
export function groupRows(
  issues: ChronicleIssue[],
  grouping: Grouping,
  at: number,
  teams: Record<string, string>,
): Row[] {
  const groups = new Map<string, ChronicleIssue[]>();
  for (const issue of issues) {
    const key =
      grouping === "team" ? (teams[issue.teamId] ?? "—") : (stateAt(issue, at).status ?? "none");
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  const order =
    grouping === "team"
      ? [...groups.keys()].sort((a, b) => KEY_ORDER.compare(a, b))
      : STATUS_ORDER.filter((s) => groups.has(s));
  const rows: Row[] = [];
  for (const key of order) {
    const members = groups.get(key)!.sort((a, b) => KEY_ORDER.compare(a.key, b.key));
    rows.push({
      kind: "group",
      id: `group:${key}`,
      label: grouping === "team" ? key : STATUS_WORDS[key as IssueStatus | "none"],
      count: members.length,
    });
    for (const issue of members) rows.push({ kind: "issue", id: issue.id, issue });
  }
  return rows;
}

export const ROW_HEIGHT = 32;
export const GROUP_HEIGHT = 28;

/** Each row's top, and the total height. */
export function rowOffsets(rows: Row[]): { tops: number[]; height: number } {
  const tops: number[] = [];
  let y = 0;
  for (const row of rows) {
    tops.push(y);
    y += row.kind === "group" ? GROUP_HEIGHT : ROW_HEIGHT;
  }
  return { tops, height: y };
}

/** The row at a vertical offset. */
export function rowAt(tops: number[], rows: Row[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (tops[mid]! <= y) lo = mid;
    else hi = mid - 1;
  }
  return rows.length ? lo : -1;
}

/** What sits under a point in an issue's lane: a marker (within 6px) wins over a span. */
export function hitInRow(
  issue: ChronicleIssue,
  t: (ms: number) => number,
  x: number,
  now: number,
): { span: WorkSpan } | { marker: ChronicleMarker } | null {
  let best: ChronicleMarker | null = null;
  let distance = 7;
  for (const marker of issue.markers) {
    const d = Math.abs(t(Date.parse(marker.at)) - x);
    if (d < distance) {
      best = marker;
      distance = d;
    }
  }
  if (best) return { marker: best };
  for (const span of issue.spans) {
    const a = t(Date.parse(span.start));
    const b = t(span.end ? Date.parse(span.end) : now);
    if (x >= a - 2 && x <= Math.max(b, a + 4) + 2) return { span };
  }
  return null;
}

/** Times something happened in a row, for stepping the playhead from event to event. */
export function eventTimes(issue: ChronicleIssue): number[] {
  const times = new Set<number>();
  for (const s of issue.segments) times.add(Date.parse(s.at));
  for (const m of issue.markers) times.add(Date.parse(m.at));
  for (const s of issue.spans) {
    times.add(Date.parse(s.start));
    if (s.end) times.add(Date.parse(s.end));
  }
  return [...times].sort((a, b) => a - b);
}
