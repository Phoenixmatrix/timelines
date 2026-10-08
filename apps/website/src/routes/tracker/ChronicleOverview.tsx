// The Chronicle's overview (CORE-251): the query's whole history as event
// density, with a brush that is the visible window. Drag the brush to move
// it, its edges to resize it, or across the strip to choose a new window;
// arrow keys move it and Shift+arrows resize it. Marks are one data hue
// (teal: events); amber only washes the brushed window (the Chart-Hue Rule).
// A drag keeps the strip's scale it started with and the window inside it,
// so nothing rescales under the pointer (CORE-276).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChronicleDensity, ChronicleHistory } from "../../../shared/chronicle.ts";
import { useThemeVersion } from "./ChronicleTimeline.tsx";
import { day, MIN_WINDOW, moment } from "./chronicleModel.ts";

/** How far outside the window an edge's grip reaches, in pixels. */
const GRIP = 8;
type Mode = "move" | "from" | "to" | "new";
const CURSOR: Record<Mode | "grabbing", string> = {
  from: "ew-resize",
  to: "ew-resize",
  move: "grab",
  grabbing: "grabbing",
  new: "crosshair",
};

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

export function ChronicleOverview({
  density,
  history,
  window: view,
  at,
  now,
  onWindow,
}: {
  density: ChronicleDensity | null;
  history: ChronicleHistory | null;
  window: { from: number; to: number };
  at: number;
  now: number;
  onWindow: (window: { from: number; to: number }, commit: boolean) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const theme = useThemeVersion();
  const height = 40;
  const start = density ? Date.parse(density.start) : view.from;
  const end = Math.max(now, view.to, start + MIN_WINDOW);
  // The strip's scale while a drag holds it still.
  const [held, setHeld] = useState<{ from: number; to: number } | null>(null);
  const extent = held ?? { from: Math.min(start, view.from), to: end };
  const x = (t: number) => ((t - extent.from) / (extent.to - extent.from)) * width;
  const tAt = (px: number) => extent.from + (px / Math.max(1, width)) * (extent.to - extent.from);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el || !width) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(height * dpr);
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    const ctx = el.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const pruned = history?.pruned ? Date.parse(history.pruned.before) : null;
    if (pruned !== null) {
      ctx.fillStyle = cssVar("--sunken");
      ctx.fillRect(0, 0, x(pruned), height);
    }
    // The brushed window, behind the marks.
    ctx.fillStyle = cssVar("--signal-wash");
    ctx.fillRect(x(view.from), 0, Math.max(2, x(view.to) - x(view.from)), height);
    if (density) {
      const peak = Math.max(1, ...density.counts);
      ctx.fillStyle = cssVar("--data-teal");
      const bw = Math.max(1, x(start + density.bucketMs) - x(start) - 1);
      density.counts.forEach((n, i) => {
        if (!n) return;
        const h = Math.max(2, ((height - 8) * Math.sqrt(n)) / Math.sqrt(peak));
        const px = x(start + i * density.bucketMs);
        ctx.beginPath();
        ctx.roundRect(px, height - h, bw, h, [Math.min(2, bw / 2), Math.min(2, bw / 2), 0, 0]);
        ctx.fill();
      });
    }
    // The window's edges, each with a grip to say it can be dragged; the playhead.
    ctx.fillStyle = cssVar("--signal-line");
    const a = Math.round(x(view.from));
    const b = Math.round(x(view.to));
    ctx.fillRect(a, 0, 2, height);
    ctx.fillRect(b - 2, 0, 2, height);
    for (const edge of [a + 1, b - 1]) {
      ctx.beginPath();
      ctx.roundRect(edge - 3, height / 2 - 8, 6, 16, 3);
      ctx.fill();
    }
    if (at >= extent.from && at <= extent.to) {
      ctx.fillStyle = cssVar("--ink");
      ctx.fillRect(Math.round(x(at)), 0, 1, height);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, density, history, view.from, view.to, at, now, theme, held]);

  const drag = useRef<
    | { mode: "move" | "from" | "to"; x: number; window: { from: number; to: number } }
    | { mode: "new"; x: number }
    | null
  >(null);
  const [cursor, setCursor] = useState<Mode | "grabbing" | null>(null);
  /** What a press at `px` takes hold of: an edge, the window, or the strip. */
  const modeAt = (px: number): Mode => {
    const a = x(view.from);
    const b = x(view.to);
    // An edge's grip reaches 8px outside; inside, a third of the window at most,
    // so a narrow window can still be moved by its middle.
    const reach = Math.min(GRIP, (b - a) / 3);
    if (px >= a - GRIP && px <= a + reach) return "from";
    if (px >= b - reach && px <= b + GRIP) return "to";
    if (px > a && px < b) return "move";
    return "new";
  };
  /** The window kept inside the strip, at least MIN_WINDOW wide. */
  const inside = (from: number, to: number, keep: "span" | "from" | "to") => {
    const { from: lo, to: hi } = extent;
    if (keep === "span") {
      const span = to - from;
      const at = Math.max(lo, Math.min(hi - span, from));
      return { from: at, to: at + span };
    }
    if (keep === "to") return { from: Math.max(lo, Math.min(from, to - MIN_WINDOW)), to };
    return { from, to: Math.min(hi, Math.max(to, from + MIN_WINDOW)) };
  };
  const release = (commit: boolean, px?: number) => {
    const d = drag.current;
    drag.current = null;
    setHeld(null);
    setCursor(null);
    // A cancelled drag (the system took the pointer) puts the window back.
    if (!commit && d && "window" in d) return onWindow(d.window, true);
    if (d?.mode === "new" && px !== undefined && Math.abs(px - d.x) < 4) {
      // A click centres the window there.
      const span = view.to - view.from;
      const t = tAt(px);
      onWindow({ from: t - span / 2, to: t + span / 2 }, true);
    } else onWindow(view, true);
  };
  const total = density?.counts.reduce((a, b) => a + b, 0) ?? 0;
  const label = `Overview: ${total.toLocaleString()} changes since ${day(extent.from)}. The window shows ${moment(view.from)} to ${moment(view.to)}. Arrow keys move it; Shift and arrows resize it.`;

  return (
    <section
      aria-label="History overview"
      className="flex flex-col gap-1 rounded-pane bg-pane px-3 pt-2 pb-1.5"
    >
      <div className="flex min-h-5 items-center gap-3 text-body-sm text-ink-muted">
        <span className="min-w-0 flex-1 truncate tabular-nums">
          {total.toLocaleString()} changes since {day(extent.from)}
        </span>
        {history?.pruned && (
          <span className="truncate text-micro text-ink-faint" data-chronicle-pruned>
            Retention removed closed work's activity before {day(Date.parse(history.pruned.before))}
          </span>
        )}
        <ul className="mk-legend text-micro max-sm:hidden">
          <li>
            <span className="mk-key mk-key--bar bg-data-teal" />
            Changes
          </li>
        </ul>
      </div>
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={extent.from}
        aria-valuemax={extent.to}
        aria-valuenow={Math.round(view.from)}
        aria-valuetext={`${moment(view.from)} to ${moment(view.to)}`}
        data-chronicle-overview
        data-grip={cursor ?? undefined}
        className="relative h-10 touch-none rounded-plate outline-none select-none focus-visible:ring-2 focus-visible:ring-signal-line"
        style={{ cursor: CURSOR[cursor ?? "new"] }}
        onKeyDown={(event) => {
          const span = view.to - view.from;
          const step = span / 4;
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const sign = event.key === "ArrowLeft" ? -1 : 1;
          if (event.shiftKey)
            onWindow(
              { from: view.from, to: Math.max(view.from + MIN_WINDOW, view.to + sign * step) },
              true,
            );
          else onWindow({ from: view.from + sign * step, to: view.to + sign * step }, true);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          const px = event.clientX - event.currentTarget.getBoundingClientRect().left;
          const mode = modeAt(px);
          setHeld(extent);
          setCursor(mode === "move" ? "grabbing" : mode);
          drag.current = mode === "new" ? { mode, x: px } : { mode, x: px, window: { ...view } };
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          const px = event.clientX - event.currentTarget.getBoundingClientRect().left;
          if (!d || !event.buttons) {
            if (!d) setCursor(modeAt(px));
            return;
          }
          if (d.mode === "new") {
            if (Math.abs(px - d.x) < 4) return;
            const a = tAt(Math.max(0, Math.min(px, d.x)));
            const b = tAt(Math.min(width, Math.max(px, d.x)));
            onWindow(inside(a, Math.max(b, a + MIN_WINDOW), "span"), false);
            return;
          }
          const shift = tAt(px) - tAt(d.x);
          const w = d.window;
          if (d.mode === "move") onWindow(inside(w.from + shift, w.to + shift, "span"), false);
          else if (d.mode === "from") onWindow(inside(w.from + shift, w.to, "to"), false);
          else onWindow(inside(w.from, w.to + shift, "from"), false);
        }}
        onPointerUp={(event) =>
          release(true, event.clientX - event.currentTarget.getBoundingClientRect().left)
        }
        onPointerCancel={() => release(false)}
        onPointerLeave={() => {
          if (!drag.current) setCursor(null);
        }}
      >
        <canvas ref={canvas} className="block" aria-hidden />
      </div>
      <div
        className="flex justify-between font-mono text-micro text-ink-faint tabular-nums"
        aria-hidden
      >
        <span>{day(extent.from)}</span>
        <span>Now</span>
      </div>
    </section>
  );
}
