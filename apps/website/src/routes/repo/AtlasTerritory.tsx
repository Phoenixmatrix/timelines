// The capability territory on canvas (CORE-168): the regions the bounded
// Atlas API returned, in their stable slots, with expanded regions' children
// nested inside. Semantic zoom: children and labels appear only once their
// cell is big enough on screen to read. The region list beside the map is the
// accessible path; this canvas is a picture of it.

import { ArrowsOutIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cellAt, type Territory, type TerritoryCell } from "./territory.ts";

interface View {
  x: number;
  y: number;
  k: number;
}

/** On-screen sizes (px) before children are drawn, and before a cell gets a label. */
const SHOW = { children: 140, label: 64, counts: 120 };
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function fitView(t: Territory, w: number, h: number): View {
  const pad = 24;
  const k = Math.min(
    (w - pad * 2) / Math.max(1, t.width),
    (h - pad * 2 - 40) / Math.max(1, t.height),
  );
  return { k, x: (w - t.width * k) / 2, y: pad + 40 + (h - pad * 2 - 40 - t.height * k) / 2 };
}

/**
 * A labelled frame drawn behind cells: in a workspace, one repository's
 * territory (CORE-172). `header` is the world height of its label strip.
 */
export interface MapBand {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  header: number;
  label: string;
  note?: string;
}

const NO_BANDS: readonly MapBand[] = [];

const fileLabel = (n: number) => `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;

export function AtlasTerritory({
  territory,
  selected,
  loading,
  onSelect,
  label,
  bands = NO_BANDS,
  origin,
}: {
  territory: Territory;
  selected: string | null;
  /** Regions whose children are loading. */
  loading: ReadonlySet<string>;
  onSelect: (cell: TerritoryCell) => void;
  /** What the picture shows, for assistive tech. */
  label: string;
  /** Frames drawn behind the cells, e.g. one per repository in a workspace. */
  bands?: readonly MapBand[];
  /** Where a cell comes from, for its hover card (e.g. its repository). */
  origin?: (cell: TerritoryCell) => string | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 });
  const fitted = useRef(false);
  const flight = useRef(0);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [hover, setHover] = useState<{ cell: TerritoryCell; x: number; y: number } | null>(null);
  const redraw = () => setFrame((f) => f + 1);

  const animateTo = (target: View) => {
    cancelAnimationFrame(flight.current);
    const from = { ...view.current };
    const started = performance.now();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - started) / 420);
      const e = 1 - (1 - t) ** 4;
      view.current = {
        k: from.k * (target.k / from.k) ** e,
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
      };
      redraw();
      if (t < 1) flight.current = requestAnimationFrame(step);
    };
    flight.current = requestAnimationFrame(step);
  };
  const fit = () => animateTo(fitView(territory, size.current.w, size.current.h));
  const zoomBy = (factor: number, cx = size.current.w / 2, cy = size.current.h / 2) => {
    const { x, y, k } = view.current;
    const next = Math.min(40, Math.max(0.05, k * factor));
    view.current = { k: next, x: cx - ((cx - x) / k) * next, y: cy - ((cy - y) / k) * next };
    redraw();
  };

  // Size to the box. The first measurement fits; afterwards the camera stays
  // put, so loading children never jumps the view.
  useLayoutEffect(() => {
    const box = wrap.current;
    if (!box) return;
    const measure = () => {
      size.current = { w: box.clientWidth, h: box.clientHeight };
      if (!fitted.current && size.current.w > 0 && territory.cells.length) {
        view.current = fitView(territory, size.current.w, size.current.h);
        fitted.current = true;
      }
      redraw();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [territory]);

  // Fly to the selection, once it's on the map.
  const target = selected ? territory.byId.get(selected) : undefined;
  useEffect(() => {
    if (!target || !size.current.w) return;
    const { w, h } = size.current;
    const k = Math.min(40, (w * 0.55) / target.w, (h * 0.55) / target.h);
    animateTo({
      k,
      x: w / 2 - (target.x + target.w / 2) * k,
      y: h / 2 - (target.y + target.h / 2) * k,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fly when the target's place changes
  }, [target?.id, target?.x, target?.y, target?.w]);
  useEffect(() => () => cancelAnimationFrame(flight.current), []);
  // Colours come from the theme's tokens: draw again when the theme changes.
  useEffect(() => {
    const observer = new MutationObserver(redraw);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", redraw);
    return () => {
      observer.disconnect();
      scheme.removeEventListener("change", redraw);
    };
  }, []);

  useEffect(() => {
    const el = canvas.current;
    const { w, h } = size.current;
    if (!el || !w) return;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    const ctx = el.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const { x: tx, y: ty, k } = view.current;
    const color = {
      region: cssVar("--surface"),
      child: cssVar("--raised"),
      grandchild: cssVar("--pane"),
      structural: cssVar("--sunken"),
      line: cssVar("--line"),
      soft: cssVar("--line-soft"),
      ink: cssVar("--ink"),
      muted: cssVar("--ink-muted"),
      faint: cssVar("--ink-faint"),
      signal: cssVar("--signal-line"),
      changed: cssVar("--data-berry"),
    };
    const font = getComputedStyle(document.body).fontFamily;
    const fitText = (text: string, max: number): string | null => {
      if (ctx.measureText(text).width <= max) return text;
      if (ctx.measureText("…").width > max) return null;
      const starts = Array.from(segments.segment(text), (s) => s.index);
      let lo = 0;
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(`${text.slice(0, starts[mid]).trimEnd()}…`).width <= max) lo = mid;
        else hi = mid - 1;
      }
      return lo > 0 ? `${text.slice(0, starts[lo]).trimEnd()}…` : null;
    };
    const visibleParent = (c: TerritoryCell): boolean => {
      if (!c.parent) return true;
      const parent = territory.byId.get(c.parent);
      return !!parent && Math.min(parent.w, parent.h) * k >= SHOW.children && visibleParent(parent);
    };

    for (const b of bands) {
      const x = b.x * k + tx;
      const y = b.y * k + ty;
      const bw = b.w * k;
      const bh = b.h * k;
      if (x > w || y > h || x + bw < 0 || y + bh < 0) continue;
      ctx.beginPath();
      ctx.roundRect(x, y, bw, bh, Math.min(14, bw / 10));
      ctx.lineWidth = 1;
      ctx.strokeStyle = color.soft;
      ctx.stroke();
      const strip = b.header * k;
      if (strip < 12 || bw < 48) continue;
      const titleSize = Math.min(16, Math.max(11, strip * 0.4));
      ctx.font = `650 ${titleSize}px ${font}`;
      ctx.fillStyle = color.ink;
      ctx.textBaseline = "top";
      const title = fitText(b.label, bw - 24);
      const top = y + Math.max(4, Math.min(14, strip * 0.18));
      if (title) ctx.fillText(title, x + 12, top);
      if (b.note && strip >= 30) {
        ctx.font = `450 ${Math.max(10, titleSize - 3)}px ${font}`;
        ctx.fillStyle = color.faint;
        const note = fitText(b.note, bw - 24);
        if (note) ctx.fillText(note, x + 12, top + titleSize + 5);
      }
    }

    for (const c of territory.cells) {
      if (!visibleParent(c)) continue;
      const x = c.x * k + tx;
      const y = c.y * k + ty;
      const cw = c.w * k;
      const ch = c.h * k;
      if (x > w || y > h || x + cw < 0 || y + ch < 0 || cw < 1.5) continue;
      const radius = Math.min(10, cw / 8, ch / 8);
      ctx.beginPath();
      ctx.roundRect(x, y, cw, ch, radius);
      ctx.fillStyle = c.structural
        ? color.structural
        : c.depth === 0
          ? color.region
          : c.depth === 1
            ? color.child
            : color.grandchild;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.depth === 0 ? color.line : color.soft;
      if (c.structural) ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
      if (c.id === selected) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = color.signal;
        ctx.beginPath();
        ctx.roundRect(x - 1, y - 1, cw + 2, ch + 2, radius + 1);
        ctx.stroke();
      }
      if (c.changed && cw >= 16) {
        ctx.beginPath();
        ctx.arc(x + cw - 9, y + 9, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = color.changed;
        ctx.fill();
      }
      if (cw < SHOW.label) continue;
      const size = c.depth === 0 ? 15 : 12.5;
      ctx.font = `${c.depth === 0 ? 650 : 550} ${size}px ${font}`;
      ctx.fillStyle = c.structural ? color.muted : color.ink;
      ctx.textBaseline = "top";
      const name = fitText(c.entity.name, cw - 24);
      if (name) ctx.fillText(name, x + 10, y + 10);
      if (cw >= SHOW.counts && ch >= 48) {
        ctx.font = `450 12px ${font}`;
        ctx.fillStyle = color.faint;
        const files = c.entity.counts.files;
        const line = loading.has(c.id)
          ? "Loading…"
          : files !== undefined
            ? fileLabel(files)
            : c.entity.kind === "file"
              ? (c.entity.path ?? "")
              : "";
        const text = line && fitText(line, cw - 20);
        if (text) ctx.fillText(text, x + 10, y + 10 + size + 6);
      }
    }
  }, [frame, territory, selected, loading, bands]);

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const pick = (sx: number, sy: number) => {
    const { x, y, k } = view.current;
    const hit = cellAt(territory, (sx - x) / k, (sy - y) / k);
    if (!hit) return null;
    // Never pick deeper than what's drawn.
    let cell: TerritoryCell | null = hit;
    while (cell?.parent) {
      const parent: TerritoryCell = territory.byId.get(cell.parent)!;
      if (Math.min(parent.w, parent.h) * k >= SHOW.children) break;
      cell = parent;
    }
    return cell;
  };

  return (
    <div ref={wrap} className="relative h-full min-h-[22rem] overflow-hidden rounded-pane bg-pane">
      <canvas
        ref={canvas}
        role="img"
        aria-label={label}
        className="absolute inset-0 block touch-none select-none"
        onWheel={(event) => {
          const p = local(event);
          zoomBy(Math.exp(-event.deltaY * 0.0015), p.x, p.y);
        }}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          const p = local(event);
          pointers.current.set(event.pointerId, p);
          drag.current = { ...p, moved: false };
        }}
        onPointerMove={(event) => {
          const p = local(event);
          if (pointers.current.has(event.pointerId)) pointers.current.set(event.pointerId, p);
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()] as [
              { x: number; y: number },
              { x: number; y: number },
            ];
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            if (pinch.current) zoomBy(distance / pinch.current, (a.x + b.x) / 2, (a.y + b.y) / 2);
            pinch.current = distance;
            if (drag.current) drag.current.moved = true;
            return;
          }
          if (drag.current && event.buttons) {
            const dx = p.x - drag.current.x;
            const dy = p.y - drag.current.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
            view.current = { ...view.current, x: view.current.x + dx, y: view.current.y + dy };
            drag.current = { ...p, moved: drag.current.moved };
            redraw();
            return;
          }
          const cell = pick(p.x, p.y);
          setHover(cell ? { cell, x: p.x, y: p.y } : null);
        }}
        onPointerUp={(event) => {
          pointers.current.delete(event.pointerId);
          if (pointers.current.size < 2) pinch.current = null;
          const p = local(event);
          if (drag.current && !drag.current.moved) {
            const cell = pick(p.x, p.y);
            if (cell) onSelect(cell);
          }
          drag.current = null;
        }}
        onPointerLeave={() => setHover(null)}
      />
      <div className="absolute top-2 right-2 flex gap-1">
        <button
          type="button"
          className="mk-btn mk-btn--icon mk-btn--sm pointer-coarse:size-11"
          aria-label="Zoom in"
          onClick={() => zoomBy(1.4)}
        >
          <PlusIcon weight="bold" aria-hidden />
        </button>
        <button
          type="button"
          className="mk-btn mk-btn--icon mk-btn--sm pointer-coarse:size-11"
          aria-label="Zoom out"
          onClick={() => zoomBy(1 / 1.4)}
        >
          <MinusIcon weight="bold" aria-hidden />
        </button>
        <button
          type="button"
          className="mk-btn mk-btn--icon mk-btn--sm pointer-coarse:size-11"
          aria-label="Fit the map"
          onClick={fit}
        >
          <ArrowsOutIcon weight="bold" aria-hidden />
        </button>
      </div>
      {hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-64 rounded-plate bg-raised px-2.5 py-1.5 text-body-sm shadow-[var(--shadow-float)]"
          style={{ left: Math.min(hover.x + 14, size.current.w - 260), top: hover.y + 14 }}
          aria-hidden
        >
          <div className="truncate font-semibold text-ink">{hover.cell.entity.name}</div>
          <div className="text-micro text-ink-faint">
            {hover.cell.entity.counts.files !== undefined
              ? fileLabel(hover.cell.entity.counts.files)
              : (hover.cell.entity.path ?? hover.cell.entity.kind)}
            {hover.cell.changed && " · changed in this build"}
          </div>
          {origin?.(hover.cell) && (
            <div className="truncate text-micro text-ink-muted">{origin(hover.cell)}</div>
          )}
        </div>
      )}
    </div>
  );
}
