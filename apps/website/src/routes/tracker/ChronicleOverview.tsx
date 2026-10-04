// The Chronicle's overview (CORE-251): the query's whole history as event
// density, with a brush that is the visible window. Drag the brush to move
// it, its edges to resize it, or across the strip to choose a new window;
// arrow keys move it and Shift+arrows resize it. Marks are one data hue
// (teal: events); amber only washes the brushed window (the Chart-Hue Rule).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChronicleDensity, ChronicleHistory } from "../../../shared/chronicle.ts";
import { useThemeVersion } from "./ChronicleTimeline.tsx";
import { day, MIN_WINDOW, moment } from "./chronicleModel.ts";

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
  const extent = { from: Math.min(start, view.from), to: end };
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
    // The window's edges, the playhead, now.
    ctx.fillStyle = cssVar("--signal-line");
    ctx.fillRect(Math.round(x(view.from)), 0, 2, height);
    ctx.fillRect(Math.round(x(view.to)) - 2, 0, 2, height);
    if (at >= extent.from && at <= extent.to) {
      ctx.fillStyle = cssVar("--ink");
      ctx.fillRect(Math.round(x(at)), 0, 1, height);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, density, history, view.from, view.to, at, now, theme]);

  const drag = useRef<
    | { mode: "move" | "from" | "to"; x: number; window: { from: number; to: number } }
    | { mode: "new"; x: number }
    | null
  >(null);
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
        className="relative h-10 cursor-grab touch-none rounded-plate outline-none select-none focus-visible:ring-2 focus-visible:ring-signal-line"
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
          const a = x(view.from);
          const b = x(view.to);
          drag.current =
            Math.abs(px - a) <= 8
              ? { mode: "from", x: px, window: view }
              : Math.abs(px - b) <= 8
                ? { mode: "to", x: px, window: view }
                : px > a && px < b
                  ? { mode: "move", x: px, window: view }
                  : { mode: "new", x: px };
        }}
        onPointerMove={(event) => {
          const d = drag.current;
          if (!d || !event.buttons) return;
          const px = event.clientX - event.currentTarget.getBoundingClientRect().left;
          if (d.mode === "new") {
            if (Math.abs(px - d.x) < 4) return;
            const a = tAt(Math.min(px, d.x));
            const b = tAt(Math.max(px, d.x));
            onWindow({ from: a, to: Math.max(b, a + MIN_WINDOW) }, false);
            return;
          }
          const shift = tAt(px) - tAt(d.x);
          if (d.mode === "move")
            onWindow({ from: d.window.from + shift, to: d.window.to + shift }, false);
          else if (d.mode === "from")
            onWindow(
              { from: Math.min(d.window.from + shift, d.window.to - MIN_WINDOW), to: d.window.to },
              false,
            );
          else
            onWindow(
              {
                from: d.window.from,
                to: Math.max(d.window.to + shift, d.window.from + MIN_WINDOW),
              },
              false,
            );
        }}
        onPointerUp={(event) => {
          const d = drag.current;
          drag.current = null;
          const px = event.clientX - event.currentTarget.getBoundingClientRect().left;
          if (d?.mode === "new" && Math.abs(px - d.x) < 4) {
            // A click centres the window there.
            const span = view.to - view.from;
            const t = tAt(px);
            onWindow({ from: t - span / 2, to: t + span / 2 }, true);
          } else onWindow(view, true);
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
