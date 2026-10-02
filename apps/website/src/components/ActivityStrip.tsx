// A strip of stacked bars over time that you brush to scope a query: drag
// across bars (or press Enter on one) and the caller gets the time range.
// Marks use data hues, never amber; amber only washes the brushed span.

import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";

export interface StripSeries {
  label: string;
  values: number[];
  /** Tailwind background class for the bar segment and its legend key. */
  className: string;
}

function bucketLabel(t: number, ms: number): string {
  const d = new Date(t);
  return ms >= 86_400_000
    ? d.toLocaleDateString("en", { month: "short", day: "numeric" })
    : d.toLocaleString("en", { month: "short", day: "numeric", hour: "numeric" });
}

export function ActivityStrip({
  start,
  bucketMs,
  series,
  caption,
  scoped,
  onRange,
  onClear,
  height = "h-12",
}: {
  start: number;
  bucketMs: number;
  series: StripSeries[];
  caption: string;
  /** A readable label for the current scope, when the query has one. */
  scoped: string | null;
  onRange: (from: Date, until: Date) => void;
  onClear: () => void;
  height?: string;
}) {
  const n = series[0]?.values.length ?? 0;
  const sums = Array.from({ length: n }, (_, i) =>
    series.reduce((s, x) => s + (x.values[i] ?? 0), 0),
  );
  const peak = Math.max(1, ...sums);
  const [hover, setHover] = useState<number | null>(null);
  const [brush, setBrushState] = useState<{ from: number; to: number } | null>(null);
  const brushRef = useRef(brush);
  const dragging = useRef(false);
  const setBrush = (b: { from: number; to: number } | null) => {
    brushRef.current = b;
    setBrushState(b);
  };
  const lo = brush ? Math.min(brush.from, brush.to) : -1;
  const hi = brush ? Math.max(brush.from, brush.to) : -1;

  useEffect(() => {
    const release = () => {
      if (!dragging.current) return;
      dragging.current = false;
      const b = brushRef.current;
      brushRef.current = null;
      setBrushState(null);
      if (!b) return;
      const a = Math.min(b.from, b.to);
      const z = Math.max(b.from, b.to);
      onRange(new Date(start + a * bucketMs), new Date(start + (z + 1) * bucketMs));
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [onRange, start, bucketMs]);

  const line = brush
    ? `${bucketLabel(start + lo * bucketMs, bucketMs)} → ${bucketLabel(start + (hi + 1) * bucketMs, bucketMs)}. Release to show them.`
    : hover !== null
      ? `${bucketLabel(start + hover * bucketMs, bucketMs)} · ${series.map((s) => `${s.values[hover] ?? 0} ${s.label.toLowerCase()}`).join(", ")}`
      : caption;

  return (
    <section
      aria-label="Activity over time"
      className="flex flex-col gap-1 rounded-pane bg-pane px-3 pt-2 pb-1.5"
    >
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1">
        <p
          className="m-0 min-w-0 flex-1 truncate text-body-sm text-ink-muted tabular-nums"
          aria-live="polite"
        >
          {line}
        </p>
        <ul className="mk-legend text-micro">
          {series.map((s) => (
            <li key={s.label}>
              <span className={`mk-key mk-key--bar ${s.className}`} />
              {s.label}
            </li>
          ))}
        </ul>
        {scoped && (
          <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={onClear}>
            <span className="tabular-nums">{scoped}</span>
            <XIcon weight="bold" aria-hidden />
            <span className="sr-only">Show the whole range</span>
          </button>
        )}
      </div>
      <div
        className={`flex ${height} touch-none items-end gap-px select-none`}
        onMouseLeave={() => setHover(null)}
      >
        {sums.map((total, i) => (
          <button
            key={i}
            type="button"
            className="group/bar flex h-full min-w-px flex-1 basis-0 cursor-pointer items-end rounded-t-[4px] border-0 bg-transparent p-0 transition-colors hover:bg-raised focus-visible:bg-raised data-[brushed]:bg-signal-wash"
            data-brushed={i >= lo && i <= hi ? "" : undefined}
            aria-label={`${bucketLabel(start + i * bucketMs, bucketMs)}: ${series.map((s) => `${s.values[i] ?? 0} ${s.label.toLowerCase()}`).join(", ")}. Show only these.`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.releasePointerCapture(e.pointerId);
              dragging.current = true;
              setBrush({ from: i, to: i });
            }}
            onPointerEnter={() => {
              setHover(i);
              const b = brushRef.current;
              if (dragging.current && b) setBrush({ ...b, to: i });
            }}
            onFocus={() => setHover(i)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onRange(new Date(start + i * bucketMs), new Date(start + (i + 1) * bucketMs));
              }
            }}
          >
            <span
              className="flex min-h-0 w-full flex-col overflow-hidden rounded-t-[4px]"
              style={{ height: `${(total / peak) * 100}%` }}
            >
              {series.map((s) =>
                (s.values[i] ?? 0) > 0 ? (
                  <span
                    key={s.label}
                    className={`basis-0 ${s.className}`}
                    style={{ flexGrow: s.values[i] }}
                  />
                ) : null,
              )}
            </span>
          </button>
        ))}
      </div>
      <div
        className="flex justify-between font-mono text-micro text-ink-faint tabular-nums"
        aria-hidden
      >
        <span>{bucketLabel(start, bucketMs)}</span>
        <span>
          {start + n * bucketMs >= Date.now() - bucketMs
            ? "Now"
            : bucketLabel(start + n * bucketMs, bucketMs)}
        </span>
      </div>
    </section>
  );
}
