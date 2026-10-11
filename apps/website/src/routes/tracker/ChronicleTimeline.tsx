// The Chronicle's time area (CORE-251): a ruler with the playhead and the
// selected range, then one lane per issue with its status over time, its
// work spans and its markers, drawn on canvas like the Atlas (tokens read
// from the theme, devicePixelRatio, ResizeObserver). The canvas is a picture
// of the rows beside it: every row is a link in the label column, every span
// and marker is reachable from the keyboard here and in the list layout.
//
// Pointer: drag the lanes to pan, Ctrl/Cmd+wheel or pinch to zoom,
// Shift+wheel to pan, click to move the playhead or select a span; drag the
// ruler to select a range, or its playhead handle to scrub.
// Keys (lanes focused): ←/→ move the playhead (Shift: further), Home/End,
// +/- zoom, ↑/↓ pick a row, Enter opens it, [ and ] select its spans,
// , and . jump to its previous and next event.

import { FlagIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  actorText,
  MARKER_LABEL,
  SPAN_END_LABEL,
  type ChronicleIssue,
  type ChronicleMarker,
  type WorkSpan,
} from "../../../shared/chronicle.ts";
import type { IssueStatus } from "../../../shared/tracker.ts";
import { Tip } from "../../components/ui.tsx";
import type { Loaded } from "./chronicleData.ts";
import {
  checkpointInWindow,
  duration,
  eventTimes,
  GROUP_HEIGHT,
  hitInRow,
  isCheckpoint,
  moment,
  ROW_HEIGHT,
  rowAt,
  rowOffsets,
  stateAsOf,
  ticks,
  tickLabel,
  tickStep,
  zoom,
  type Row,
} from "./chronicleModel.ts";
import { STATE_LABEL } from "./query.ts";
import { StateDot } from "./Log.tsx";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
function palette() {
  return {
    pane: cssVar("--pane"),
    sunken: cssVar("--sunken"),
    surface: cssVar("--surface"),
    raised: cssVar("--raised"),
    pressed: cssVar("--pressed"),
    line: cssVar("--line"),
    soft: cssVar("--line-soft"),
    ink: cssVar("--ink"),
    muted: cssVar("--ink-muted"),
    faint: cssVar("--ink-faint"),
    signal: cssVar("--signal-line"),
    wash: cssVar("--signal-wash"),
    online: cssVar("--online"),
    danger: cssVar("--danger-text"),
  };
}
type Palette = ReturnType<typeof palette>;

/** Status as a lane: weight and dash carry it, never a data hue (status by shape). */
function laneStyle(
  status: IssueStatus,
  c: Palette,
): { color: string; width: number; dash: number[] } {
  switch (status) {
    case "in_progress":
      return { color: c.ink, width: 3, dash: [] };
    case "todo":
      return { color: c.faint, width: 1, dash: [] };
    case "backlog":
      return { color: c.faint, width: 1, dash: [2, 4] };
    case "done_in_timeline":
      return { color: c.online, width: 3, dash: [] };
    case "done":
      return { color: c.line, width: 1, dash: [] };
    case "canceled":
      return { color: c.line, width: 1, dash: [5, 3] };
  }
}

export interface Selection {
  issue: string | null;
  span: string | null;
}

export function ChronicleTimeline({
  data,
  rows,
  window: view,
  at,
  range,
  now,
  selection,
  issueHref,
  onWindow,
  onPlayhead,
  onRange,
  onSelectSpan,
  onOpenIssue,
  labelWidth,
}: {
  data: Loaded;
  rows: Row[];
  window: { from: number; to: number };
  at: number;
  range: { from: number; to: number } | null;
  now: number;
  selection: Selection;
  issueHref: (id: string) => string;
  /** `commit` false while a gesture is under way. */
  onWindow: (window: { from: number; to: number }, commit: boolean) => void;
  onPlayhead: (at: number, commit: boolean) => void;
  /** `done` false while the range is still being dragged. */
  onRange: (range: { from: number; to: number } | null, done: boolean) => void;
  onSelectSpan: (span: WorkSpan) => void;
  onOpenIssue: (issue: ChronicleIssue) => void;
  labelWidth: number;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const lanes = useRef<HTMLCanvasElement>(null);
  const ruler = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  // The keyboard's row, by issue: rows regroup as the playhead moves.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    issue: ChronicleIssue;
    span?: WorkSpan;
    marker?: ChronicleMarker;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [drawMs, setDrawMs] = useState(0);
  const { tops, height } = useMemo(() => rowOffsets(rows), [rows]);
  const issueRows = useMemo(
    () => rows.flatMap((row, i) => (row.kind === "issue" ? [i] : [])),
    [rows],
  );
  const checkpointCounts = useMemo(
    () =>
      new Map(
        data.issues.map((issue) => [
          issue.id,
          issue.markers.reduce(
            (count, marker) => count + Number(checkpointInWindow(marker, view.from, view.to)),
            0,
          ),
        ]),
      ),
    [data.issues, view.from, view.to],
  );
  const theme = useThemeVersion();
  const found = cursorId ? rows.findIndex((r) => r.id === cursorId) : -1;
  const cursor = found >= 0 ? found : (issueRows[0] ?? 0);
  const setCursor = (index: number) => setCursorId(rows[index]?.id ?? null);

  const span = view.to - view.from;
  const width = Math.max(1, size.w);
  const x = (t: number) => ((t - view.from) / span) * width;
  const tAt = (px: number) => view.from + (px / width) * span;

  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const measure = () => setSize({ w: box.clientWidth - labelWidth, h: box.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [labelWidth]);

  // The lanes.
  useEffect(() => {
    const el = lanes.current;
    if (!el || size.w <= 0) return;
    const started = performance.now();
    const c = palette();
    const ctx = fit(el, size.w, size.h);
    ctx.clearRect(0, 0, size.w, size.h);
    const first = Math.max(0, rowAt(tops, rows, scrollTop));
    const font = getComputedStyle(document.body).fontFamily;
    // The selected range, behind everything.
    if (range) {
      ctx.fillStyle = c.wash;
      ctx.fillRect(x(range.from), 0, x(range.to) - x(range.from), size.h);
    }
    // History retention removed is said, not left blank.
    if (data.history.pruned && Date.parse(data.history.pruned.before) > view.from) {
      ctx.fillStyle = c.sunken;
      ctx.fillRect(0, 0, Math.min(size.w, x(Date.parse(data.history.pruned.before))), size.h);
    }
    for (const tick of ticks(view.from, view.to, size.w)) {
      ctx.fillStyle = tick.major ? c.line : c.soft;
      ctx.fillRect(Math.round(x(tick.t)), 0, 1, size.h);
    }
    for (let i = first; i < rows.length; i++) {
      const top = tops[i]! - scrollTop;
      if (top > size.h) break;
      const row = rows[i]!;
      if (row.kind === "group") {
        ctx.fillStyle = c.surface;
        ctx.fillRect(0, top, size.w, GROUP_HEIGHT);
        continue;
      }
      const issue = row.issue;
      const selected = selection.issue === issue.id;
      if (selected) {
        ctx.fillStyle = c.wash;
        ctx.fillRect(0, top, size.w, ROW_HEIGHT);
      } else if (i === cursor && document.activeElement === lanes.current?.parentElement) {
        ctx.fillStyle = c.raised;
        ctx.fillRect(0, top, size.w, ROW_HEIGHT);
      }
      ctx.fillStyle = c.soft;
      ctx.fillRect(0, top + ROW_HEIGHT - 1, size.w, 1);
      drawLane(ctx, issue, c, x, view, now, top);
      drawSpans(ctx, issue, data, c, x, now, top, selection.span, font);
      drawMarkers(ctx, issue, c, x, top, view);
    }
    // The playhead.
    if (at >= view.from && at <= view.to) {
      ctx.fillStyle = c.signal;
      ctx.fillRect(Math.round(x(at)) - 1, 0, 2, size.h);
    }
    setDrawMs(Math.round((performance.now() - started) * 10) / 10);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rows,
    tops,
    size,
    scrollTop,
    view.from,
    view.to,
    at,
    range,
    selection,
    cursor,
    data,
    theme,
    now,
  ]);

  // The ruler.
  useEffect(() => {
    const el = ruler.current;
    if (!el || size.w <= 0) return;
    const c = palette();
    const h = 36;
    const ctx = fit(el, size.w, h);
    ctx.clearRect(0, 0, size.w, h);
    const font = getComputedStyle(document.body).fontFamily;
    if (range) {
      ctx.fillStyle = c.wash;
      ctx.fillRect(x(range.from), 0, x(range.to) - x(range.from), h);
    }
    const pruned = data.history.pruned ? Date.parse(data.history.pruned.before) : null;
    if (pruned !== null && pruned > view.from) {
      ctx.fillStyle = c.sunken;
      ctx.fillRect(0, 0, Math.min(size.w, x(pruned)), h);
    }
    ctx.font = `11px ${getComputedStyle(document.body).getPropertyValue("--font-mono") || "monospace"}`;
    ctx.textBaseline = "middle";
    for (const tick of ticks(view.from, view.to, size.w)) {
      const px = Math.round(x(tick.t));
      ctx.fillStyle = tick.major ? c.line : c.soft;
      ctx.fillRect(px, h - 10, 1, 10);
      ctx.fillStyle = tick.major ? c.muted : c.faint;
      ctx.fillText(tickLabel(tick.t, span, size.w), px + 4, h / 2 - 2);
    }
    // Now, when it's in view.
    if (now >= view.from && now <= view.to) {
      ctx.fillStyle = c.faint;
      ctx.font = `600 11px ${font}`;
      ctx.fillText("Now", Math.min(size.w - 28, x(now) + 4), h - 7);
      ctx.fillRect(Math.round(x(now)), h - 14, 1, 14);
    }
    if (at >= view.from && at <= view.to) {
      const px = x(at);
      ctx.fillStyle = c.signal;
      ctx.beginPath();
      ctx.moveTo(px - 6, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px + 6, 8);
      ctx.lineTo(px, 14);
      ctx.lineTo(px - 6, 8);
      ctx.closePath();
      ctx.fill();
      ctx.fillRect(Math.round(px) - 1, 14, 2, h - 14);
    }
    ctx.fillStyle = c.soft;
    ctx.fillRect(0, h - 1, size.w, 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.w, view.from, view.to, at, range, theme, now, data.history.pruned]);

  // Gestures.
  const gesture = useRef<
    | { kind: "pan"; x: number; from: number; to: number; moved: boolean; id: number }
    | { kind: "pinch"; distance: number; window: { from: number; to: number } }
    | { kind: "range"; x: number; moved: boolean }
    | { kind: "scrub" }
    | null
  >(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const local = (event: { clientX: number; clientY: number }, el: Element) => {
    const box = el.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };
  const issueAtY = (y: number): { index: number; issue: ChronicleIssue } | null => {
    const index = rowAt(tops, rows, y + scrollTop);
    const row = rows[index];
    if (!row || row.kind !== "issue" || y + scrollTop >= tops[index]! + ROW_HEIGHT) return null;
    return { index, issue: row.issue };
  };

  const announce = (message: string) => setAnnouncement(message);
  const describeAt = (t: number, issue?: ChronicleIssue) => {
    const head = `As of ${moment(t)}`;
    if (!issue) return head;
    const state = stateAsOf(issue, t, now);
    const holder = issue.spans.find(
      (s) => Date.parse(s.start) <= t && (s.end === null || t < Date.parse(s.end)),
    );
    return `${head}: ${issue.key} ${state ? STATE_LABEL[state] : "not created yet"}${
      holder ? `, held by ${actorText(data.actors, holder.holder)}` : ""
    }`;
  };

  // Keep the keyboard row in view.
  useEffect(() => {
    const box = scroller.current;
    const top = tops[cursor];
    if (!box || top === undefined) return;
    const visible = box.clientHeight - 8;
    if (top < box.scrollTop) box.scrollTop = top - GROUP_HEIGHT;
    else if (top + ROW_HEIGHT > box.scrollTop + visible) box.scrollTop = top + ROW_HEIGHT - visible;
  }, [cursor, tops]);
  // Start the keyboard on the selected row.
  useEffect(() => {
    if (!selection.issue) return;
    const index = rows.findIndex((r) => r.kind === "issue" && r.id === selection.issue);
    if (index >= 0) setCursor(index);
  }, [selection.issue, rows]);

  const onKey = (event: React.KeyboardEvent) => {
    const row = rows[cursor];
    const issue = row?.kind === "issue" ? row.issue : undefined;
    const step = tickStep(span, size.w).ms / (event.shiftKey ? 1 : 4);
    const move = (t: number) => {
      const next = Math.max(view.from, Math.min(view.to, t));
      onPlayhead(next, true);
      announce(describeAt(next, issue));
    };
    switch (event.key) {
      case "ArrowLeft":
        move(at - step);
        break;
      case "ArrowRight":
        move(at + step);
        break;
      case "Home":
        move(view.from);
        break;
      case "End":
        move(Math.min(view.to, now));
        break;
      case "+":
      case "=":
        onWindow(zoom(view, 0.6, at), true);
        announce(`Zoomed in: ${moment(view.from)} to ${moment(view.to)}`);
        break;
      case "-":
      case "_":
        onWindow(zoom(view, 1 / 0.6, at), true);
        break;
      case "ArrowDown":
      case "ArrowUp": {
        const position = issueRows.indexOf(cursor);
        const next =
          issueRows[
            Math.max(
              0,
              Math.min(issueRows.length - 1, position + (event.key === "ArrowDown" ? 1 : -1)),
            )
          ];
        if (next === undefined) break;
        setCursor(next);
        const target = rows[next];
        if (target?.kind === "issue") announce(describeAt(at, target.issue));
        break;
      }
      case "Enter":
        if (issue) onOpenIssue(issue);
        break;
      case "[":
      case "]": {
        if (!issue?.spans.length) {
          announce(issue ? `${issue.key} has no work spans in this range` : "");
          break;
        }
        const current = issue.spans.findIndex((s) => s.id === selection.span);
        const next =
          current < 0
            ? event.key === "]"
              ? 0
              : issue.spans.length - 1
            : (current + (event.key === "]" ? 1 : issue.spans.length - 1)) % issue.spans.length;
        const chosen = issue.spans[next]!;
        onSelectSpan(chosen);
        announce(spanText(chosen, data, now));
        break;
      }
      case ",":
      case ".": {
        if (!issue) break;
        const times = eventTimes(issue);
        const t =
          event.key === "."
            ? times.find((time) => time > at + 1000)
            : times.findLast((time) => time < at - 1000);
        if (t === undefined) {
          announce(`No ${event.key === "." ? "later" : "earlier"} change to ${issue.key}`);
          break;
        }
        if (t < view.from || t > view.to) onWindow({ from: t - span / 2, to: t + span / 2 }, true);
        onPlayhead(t, true);
        announce(describeAt(t, issue));
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  // Rows in view in the label column (virtualized like the canvas).
  const first = Math.max(0, rowAt(tops, rows, scrollTop) - 2);
  const visible: number[] = [];
  for (let i = first; i < rows.length && tops[i]! < scrollTop + size.h + ROW_HEIGHT * 2; i++)
    visible.push(i);

  const tooltip = hover ? hoverText(hover, data, now) : null;
  const rulerWidth = size.w;

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-pane bg-pane"
      data-chronicle-timeline
      data-draw-ms={drawMs}
      data-from={new Date(view.from).toISOString()}
      data-to={new Date(view.to).toISOString()}
    >
      <div className="flex shrink-0 border-b border-line-soft">
        <div
          className="flex shrink-0 items-center px-3 text-label text-ink-muted"
          style={{ width: labelWidth }}
        >
          {data.issues.length.toLocaleString()} issues
        </div>
        <canvas
          ref={ruler}
          aria-label={`Time ruler from ${moment(view.from)} to ${moment(view.to)}; drag to select a range`}
          role="img"
          data-chronicle-ruler
          className="block h-9 touch-none select-none"
          style={{ width: rulerWidth }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const p = local(event, event.currentTarget);
            gesture.current =
              Math.abs(p.x - x(at)) <= 8
                ? { kind: "scrub" }
                : { kind: "range", x: p.x, moved: false };
          }}
          onPointerMove={(event) => {
            const g = gesture.current;
            const p = local(event, event.currentTarget);
            if (g?.kind === "scrub")
              onPlayhead(Math.max(view.from, Math.min(view.to, tAt(p.x))), false);
            else if (g?.kind === "range" && Math.abs(p.x - g.x) > 4) {
              g.moved = true;
              const a = tAt(Math.min(g.x, p.x));
              const b = tAt(Math.max(g.x, p.x));
              onRange({ from: a, to: b }, false);
            }
          }}
          onPointerUp={(event) => {
            const g = gesture.current;
            gesture.current = null;
            const p = local(event, event.currentTarget);
            if (g?.kind === "scrub") onPlayhead(tAt(p.x), true);
            else if (g?.kind === "range" && !g.moved) onPlayhead(tAt(p.x), true);
            else if (g?.kind === "range") {
              const a = tAt(Math.min(g.x, p.x));
              const b = tAt(Math.max(g.x, p.x));
              onRange({ from: a, to: b }, true);
              announce(`Selected ${moment(a)} to ${moment(b)}`);
            }
          }}
        />
      </div>
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div className="relative" style={{ height: Math.max(height, size.h) }}>
          {visible.map((i) => {
            const row = rows[i]!;
            if (row.kind === "group")
              return (
                <div
                  key={row.id}
                  className="absolute left-0 flex items-center gap-2 bg-surface px-3 text-label text-ink-muted"
                  style={{ top: tops[i], height: GROUP_HEIGHT, width: labelWidth }}
                >
                  {row.label}
                  <span className="font-mono text-micro text-ink-faint tabular-nums">
                    {row.count}
                  </span>
                </div>
              );
            const issue = row.issue;
            const state = stateAsOf(issue, at, now);
            const selected = selection.issue === issue.id;
            const checkpoints = checkpointCounts.get(issue.id) ?? 0;
            return (
              <div
                key={row.id}
                className={`absolute left-0 flex items-center border-b border-line-soft ${selected ? "bg-signal-wash" : ""}`}
                style={{ top: tops[i], height: ROW_HEIGHT, width: labelWidth }}
              >
                <Link
                  to={issueHref(issue.id)}
                  preventScrollReset
                  data-chronicle-row={issue.key}
                  data-state={state ?? "none"}
                  aria-current={selected ? "true" : undefined}
                  aria-label={`${issue.key} ${issue.title}: ${state ? STATE_LABEL[state] : "not created yet"} as of ${moment(at)}; ${issue.spans.length} work span${issue.spans.length === 1 ? "" : "s"}`}
                  className={`flex h-full min-w-0 flex-1 items-center gap-2 px-3 no-underline hover:bg-raised ${selected ? "text-ink" : "text-ink-muted"}`}
                  onPointerMove={(event) => {
                    if (!lanes.current) return;
                    const p = local(event, lanes.current);
                    setHover({ x: p.x, y: p.y, issue });
                  }}
                  onPointerLeave={() => setHover(null)}
                >
                  <span className="flex w-3 shrink-0 justify-center">
                    {state ? (
                      <StateDot state={state} />
                    ) : (
                      <span className="size-2 rounded-full border border-line" aria-hidden />
                    )}
                  </span>
                  <span className="w-[4.5rem] shrink-0 truncate font-mono text-mono text-ink-muted">
                    {issue.key}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                    {issue.title}
                  </span>
                </Link>
                {checkpoints > 0 && (
                  <Tip label={`${checkpoints} checkpoint${checkpoints === 1 ? "" : "s"} in range`}>
                    <Link
                      to={`${issueHref(issue.id)}#chronicle-checkpoints`}
                      preventScrollReset
                      aria-label={`Read ${checkpoints} checkpoint${checkpoints === 1 ? "" : "s"} for ${issue.key}`}
                      className="flex h-full min-w-11 shrink-0 items-center justify-center gap-1 rounded-plate px-1 text-micro text-ink-muted no-underline hover:bg-raised hover:text-ink"
                    >
                      <FlagIcon size={14} weight="fill" aria-hidden />
                      <span className="tabular-nums">{checkpoints}</span>
                    </Link>
                  </Tip>
                )}
              </div>
            );
          })}
          <div
            className="sticky top-0 touch-pan-y outline-none select-none focus-visible:ring-2 focus-visible:ring-signal-line focus-visible:ring-inset"
            style={{ marginLeft: labelWidth, height: size.h, marginBottom: -size.h }}
            tabIndex={0}
            role="group"
            aria-roledescription="timeline"
            aria-label="Work over time"
            aria-describedby="chronicle-keys"
            data-chronicle-lanes
            onKeyDown={onKey}
            onFocus={() => {
              const row = rows[cursor];
              if (!row || row.kind !== "issue") {
                const firstIssue = issueRows[0];
                if (firstIssue !== undefined) setCursor(firstIssue);
              }
            }}
            onWheel={(event) => {
              const p = local(event, event.currentTarget);
              if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                onWindow(zoom(view, Math.exp(event.deltaY * 0.0025), tAt(p.x)), false);
              } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
                const delta = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
                const shift = (delta / width) * span;
                onWindow({ from: view.from + shift, to: view.to + shift }, false);
              }
            }}
            onPointerDown={(event) => {
              const p = local(event, event.currentTarget);
              pointers.current.set(event.pointerId, p);
              if (pointers.current.size === 2) {
                const [a, b] = [...pointers.current.values()] as [typeof p, typeof p];
                gesture.current = { kind: "pinch", distance: Math.abs(a.x - b.x), window: view };
                return;
              }
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              gesture.current = {
                kind: "pan",
                x: p.x,
                from: view.from,
                to: view.to,
                moved: false,
                id: event.pointerId,
              };
            }}
            onPointerMove={(event) => {
              const p = local(event, event.currentTarget);
              if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, p);
              const g = gesture.current;
              if (g?.kind === "pinch" && pointers.current.size === 2) {
                const [a, b] = [...pointers.current.values()] as [typeof p, typeof p];
                const distance = Math.max(8, Math.abs(a.x - b.x));
                onWindow(zoom(g.window, g.distance / distance, tAt((a.x + b.x) / 2)), false);
                return;
              }
              if (g?.kind === "pan" && event.buttons) {
                const dx = p.x - g.x;
                if (Math.abs(dx) > 4) g.moved = true;
                if (g.moved) {
                  const shift = (-dx / width) * (g.to - g.from);
                  onWindow({ from: g.from + shift, to: g.to + shift }, false);
                  setHover(null);
                }
                return;
              }
              const found = issueAtY(p.y);
              if (!found) return setHover(null);
              const hit = hitInRow(found.issue, x, p.x, now);
              setHover(
                hit
                  ? { x: p.x, y: p.y, issue: found.issue, ...hit }
                  : { x: p.x, y: p.y, issue: found.issue },
              );
            }}
            onPointerUp={(event) => {
              pointers.current.delete(event.pointerId);
              const g = gesture.current;
              gesture.current = null;
              if (g?.kind === "pinch") {
                onWindow(view, true);
                return;
              }
              if (g?.kind !== "pan") return;
              if (g.moved) {
                onWindow(view, true);
                return;
              }
              const p = local(event, event.currentTarget);
              const found = issueAtY(p.y);
              if (found) {
                setCursor(found.index);
                const hit = hitInRow(found.issue, x, p.x, now);
                if (hit && "span" in hit) {
                  onSelectSpan(hit.span);
                  return;
                }
                if (hit && "marker" in hit) {
                  onPlayhead(Date.parse(hit.marker.at), true);
                  onOpenIssue(found.issue);
                  return;
                }
              }
              onPlayhead(tAt(p.x), true);
            }}
            onPointerCancel={(event) => {
              pointers.current.delete(event.pointerId);
              gesture.current = null;
            }}
            onPointerLeave={() => setHover(null)}
          >
            <canvas ref={lanes} className="block" aria-hidden />
          </div>
        </div>
      </div>
      {tooltip && hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-72 rounded-plate bg-rail px-2.5 py-1.5 text-body-sm shadow-[var(--shadow-float),0_0_0_1px_var(--line-soft)]"
          style={{
            left: Math.min(labelWidth + hover.x + 14, labelWidth + size.w - 290),
            top: hover.y + 36 + 18,
          }}
          aria-hidden
          data-chronicle-tooltip
        >
          <div className="font-semibold text-ink [overflow-wrap:anywhere]">{tooltip.title}</div>
          {tooltip.lines.map((line) => (
            <div key={line} className="text-micro text-ink-muted">
              {line}
            </div>
          ))}
        </div>
      )}
      <p id="chronicle-keys" className="sr-only">
        Left and right arrows move the playhead; Shift moves further. Up and down pick an issue;
        Enter opens it. Left and right brackets select its work spans; comma and period jump to its
        previous and next change. Plus and minus zoom.
      </p>
      <p className="sr-only" aria-live="polite" data-chronicle-announce>
        {announcement}
      </p>
    </div>
  );
}

/** Size a canvas for its CSS box at the device's pixel ratio. */
function fit(el: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D {
  const dpr = window.devicePixelRatio || 1;
  if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
    el.width = Math.round(w * dpr);
    el.height = Math.round(h * dpr);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
  }
  const ctx = el.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Bumps when the theme changes, so canvases read the new tokens. */
export function useThemeVersion(): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    const observer = new MutationObserver(bump);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", bump);
    return () => {
      observer.disconnect();
      scheme.removeEventListener("change", bump);
    };
  }, []);
  return version;
}

function drawLane(
  ctx: CanvasRenderingContext2D,
  issue: ChronicleIssue,
  c: Palette,
  x: (t: number) => number,
  view: { from: number; to: number },
  now: number,
  top: number,
) {
  const y = top + ROW_HEIGHT - 6;
  const changes: { at: number; status: IssueStatus | null; waiting: boolean }[] = [
    { at: view.from, status: issue.start.status, waiting: issue.start.waiting },
    ...issue.segments.map((s) => ({ at: Date.parse(s.at), status: s.status, waiting: s.waiting })),
  ];
  const end = Math.min(view.to, now);
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    const a = Math.max(change.at, view.from);
    const b = Math.min(changes[i + 1]?.at ?? end, end);
    if (b <= view.from || a >= view.to || b <= a || !change.status) continue;
    const style = laneStyle(change.status, c);
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.setLineDash(style.dash);
    ctx.beginPath();
    ctx.moveTo(x(a), y);
    ctx.lineTo(x(b), y);
    ctx.stroke();
    // Waiting on a person: faint ink dots above the lane.
    if (change.waiting) {
      ctx.fillStyle = c.faint;
      for (let px = x(a) + 2; px < x(b); px += 6) ctx.fillRect(px, y - 4, 2, 2);
    }
  }
  ctx.setLineDash([]);
}

function drawSpans(
  ctx: CanvasRenderingContext2D,
  issue: ChronicleIssue,
  data: Loaded,
  c: Palette,
  x: (t: number) => number,
  now: number,
  top: number,
  selected: string | null,
  font: string,
) {
  const y = top + 5;
  const h = 15;
  for (const span of issue.spans) {
    const a = x(Date.parse(span.start));
    const end = span.end ? Date.parse(span.end) : now;
    const b = Math.max(a + 3, x(end));
    if (b < 0 || a > ctx.canvas.width) continue;
    const retained = span.retained ? Math.max(a, Math.min(b, x(Date.parse(span.retained.at)))) : b;
    // Worked: a raised bar; parked stretches recess; retained, an outline.
    ctx.fillStyle = c.raised;
    ctx.strokeStyle = c.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(a + 0.5, y + 0.5, Math.max(3, retained - a) - 1, h - 1, 4);
    ctx.fill();
    ctx.stroke();
    for (const parked of span.parked) {
      const p = x(Date.parse(parked.from));
      const q = parked.to ? x(Date.parse(parked.to)) : retained;
      if (q <= p) continue;
      ctx.fillStyle = c.sunken;
      ctx.fillRect(p, y + 1, q - p, h - 2);
      ctx.fillStyle = c.faint;
      for (let px = p + 2; px < q - 1; px += 5) ctx.fillRect(px, y + h / 2, 2, 1);
    }
    if (span.retained && b > retained) {
      ctx.strokeStyle = c.faint;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 2]);
      ctx.beginPath();
      ctx.roundRect(retained + 0.5, y + 0.5, b - retained - 1, h - 1, 4);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // A lapsed lease fades out; a completion ends on evidence green.
    if (span.endedBy === "expiry") {
      ctx.fillStyle = c.pane;
      ctx.fillRect(b - 2, y, 2, h);
      ctx.fillStyle = c.faint;
      ctx.fillRect(b - 4, y + 2, 1, h - 4);
    } else if (span.endedBy === "complete") {
      ctx.fillStyle = c.online;
      ctx.beginPath();
      ctx.arc(b - 5, y + h / 2, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // Renewals: small ticks inside the bar's foot, while they read apart.
    ctx.fillStyle = c.faint;
    let previous = -Infinity;
    for (const renewal of span.renewals) {
      const px = x(Date.parse(renewal));
      if (px - previous < 8 || px > retained - 3) continue;
      ctx.fillRect(px, y + h - 4, 1, 3);
      previous = px;
    }
    // The holder's flag and name, whole or not at all.
    ctx.fillStyle = c.ink;
    flag(ctx, a + 4, y + 3, 9);
    // The holder's own name; the tooltip and inspector add whom an agent works for.
    const name = data.actors[span.holder]?.name ?? actorText(data.actors, span.holder);
    ctx.font = `500 11.5px ${font}`;
    ctx.textBaseline = "middle";
    // Labels are drawn whole or not at all (DESIGN.md); the tooltip always has it.
    if (ctx.measureText(name).width <= retained - a - 22) {
      ctx.fillStyle = c.ink;
      ctx.fillText(name, a + 17, y + h / 2 + 0.5);
    }
    if (selected === span.id) {
      ctx.strokeStyle = c.signal;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(a - 1, y - 1, b - a + 2, h + 2, 5);
      ctx.stroke();
    }
  }
}

/** A small filled flag identifies the holder of a work span. */
function flag(ctx: CanvasRenderingContext2D, px: number, py: number, size: number) {
  ctx.fillRect(px, py, 1.5, size);
  ctx.beginPath();
  ctx.moveTo(px + 1.5, py);
  ctx.lineTo(px + size * 0.8, py + size * 0.25);
  ctx.lineTo(px + 1.5, py + size * 0.55);
  ctx.closePath();
  ctx.fill();
}

function drawMarkers(
  ctx: CanvasRenderingContext2D,
  issue: ChronicleIssue,
  c: Palette,
  x: (t: number) => number,
  top: number,
  view: { from: number; to: number },
) {
  const y = top + ROW_HEIGHT - 6;
  for (const marker of issue.markers) {
    if (isCheckpoint(marker)) continue;
    const t = Date.parse(marker.at);
    if (t < view.from || t > view.to) continue;
    const px = x(t);
    switch (marker.kind) {
      case "evidence":
      case "landed":
      case "timeline-landing":
        ctx.fillStyle = c.online;
        ctx.beginPath();
        ctx.arc(px, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "asked":
      case "withdrawn":
        ctx.strokeStyle = c.faint;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, y, 3.5, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case "answered":
        ctx.fillStyle = c.faint;
        ctx.beginPath();
        ctx.arc(px, y, 3.5, 0, Math.PI * 2);
        ctx.fill();
        break;
      case "linked":
      case "unlinked":
        ctx.fillStyle = c.muted;
        ctx.beginPath();
        ctx.moveTo(px, y - 4);
        ctx.lineTo(px + 4, y);
        ctx.lineTo(px, y + 4);
        ctx.lineTo(px - 4, y);
        ctx.closePath();
        ctx.fill();
        break;
      case "created":
        ctx.fillStyle = c.muted;
        ctx.fillRect(px - 0.5, y - 5, 1.5, 10);
        break;
      default:
        ctx.strokeStyle = c.muted;
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.arc(px, y, 2.5, 0, Math.PI * 2);
        ctx.stroke();
    }
  }
}

/** A span in words, for the tooltip, the announcer and the list. */
export function spanText(span: WorkSpan, data: Pick<Loaded, "actors">, now: number): string {
  const end = span.end ? Date.parse(span.end) : now;
  const who = actorText(data.actors, span.holder);
  const how = span.endedBy ? SPAN_END_LABEL[span.endedBy] : "Still held";
  return `${who}, ${moment(Date.parse(span.start))} for ${duration(end - Date.parse(span.start))}: ${how}`;
}

function hoverText(
  hover: { issue: ChronicleIssue; span?: WorkSpan; marker?: ChronicleMarker },
  data: Loaded,
  now: number,
): { title: string; lines: string[] } {
  if (hover.marker) {
    const m = hover.marker;
    return {
      title: `${hover.issue.key} · ${MARKER_LABEL[m.kind]}`,
      lines: [
        moment(Date.parse(m.at)),
        ...(m.text ? [m.text] : []),
        ...(m.actorId ? [actorText(data.actors, m.actorId)] : []),
      ],
    };
  }
  if (hover.span) {
    const s = hover.span;
    const end = s.end ? Date.parse(s.end) : now;
    return {
      title: `${hover.issue.key} · ${actorText(data.actors, s.holder)}`,
      lines: [
        `${moment(Date.parse(s.start))} → ${s.end ? moment(end) : "still held"} (${duration(end - Date.parse(s.start))})`,
        `${s.endedBy ? SPAN_END_LABEL[s.endedBy] : "Held"}${s.renewals.length ? ` · ${s.renewals.length} renewals` : ""}`,
        ...(s.parked.length ? ["Waited on a person"] : []),
        ...(s.retained ? [`Retained by ${s.retained.timeline.slug}`] : []),
      ],
    };
  }
  return { title: `${hover.issue.key} ${hover.issue.title}`, lines: [] };
}
