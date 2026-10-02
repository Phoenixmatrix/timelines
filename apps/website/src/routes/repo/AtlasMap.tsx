// The atlas on canvas, with semantic zoom: far out you see component regions
// and their names; closer, folders and files; closest, the symbols inside a
// file. Hovering anything lights what it imports (teal) and what uses it
// (violet); the selection keeps its links lit and carries the amber outline.
// Canvas, not DOM, so tens of thousands of files pan and zoom smoothly.

import { ArrowsOutIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { KnowledgeMap } from "../../../shared/api.ts";
import { boundsOf, buildAtlas, type Atlas, type Cell } from "./atlas.ts";

export const KIND_LABEL: Record<string, string> = {
  repository: "Repository",
  directory: "Folder",
  file: "File",
  symbol: "Symbol",
  package: "Package",
  concept: "Concept",
  component: "Component",
};

interface View {
  x: number;
  y: number;
  k: number;
}

/** Minimum on-screen size (px) before a level is drawn or picked. */
const SHOW = { district: 48, plot: 3, lots: 110 };
const labelSegments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

/** The whole map, clear of the search and zoom controls above and the legend below. */
function fitView(atlas: Atlas, w: number, h: number): View {
  const top = 60;
  const bottom = w < 640 ? 12 : 34;
  const side = 12;
  const k = Math.min((w - 2 * side) / atlas.width, (h - top - bottom) / atlas.height);
  return { k, x: (w - atlas.width * k) / 2, y: top + (h - top - bottom - atlas.height * k) / 2 };
}

export function AtlasMap({
  map,
  selected,
  hits,
  onSelect,
  children,
}: {
  map: KnowledgeMap;
  selected: number | null;
  /** Search hits, outlined on the map. */
  hits: Set<number>;
  onSelect: (node: number) => void;
  /** Overlays (search) placed over the map's top-left corner. */
  children?: ReactNode;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  // Lay the map out in the pane's shape (snapped, so it stays put while resizing).
  const [aspect, setAspect] = useState<number | null>(null);
  const atlas = useMemo(() => buildAtlas(map, aspect ?? 1.6), [map, aspect]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 });
  const [frame, setFrame] = useState(0);
  const [hover, setHover] = useState<{ cell: Cell; x: number; y: number } | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // Touch: two pointers pinch to zoom.
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const flight = useRef(0);
  const redraw = () => setFrame((f) => f + 1);

  const animateTo = (target: View) => {
    cancelAnimationFrame(flight.current);
    const from = { ...view.current };
    const started = performance.now();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const step = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - started) / 480);
      const e = 1 - (1 - t) ** 4;
      // Interpolate scale geometrically so zooming reads as one motion.
      const k = from.k * (target.k / from.k) ** e;
      view.current = {
        k,
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
      };
      redraw();
      if (t < 1) flight.current = requestAnimationFrame(step);
    };
    flight.current = requestAnimationFrame(step);
  };

  const fit = () => animateTo(fitView(atlas, size.current.w, size.current.h));

  // Size the canvas to its box; the first measurement fits the whole map.
  useLayoutEffect(() => {
    const box = wrap.current;
    if (!box) return;
    let first = true;
    const measure = () => {
      size.current = { w: box.clientWidth, h: box.clientHeight };
      if (size.current.w > 0) {
        // The usable area's shape; small changes keep the current layout.
        const ratio =
          (size.current.w - 24) / Math.max(1, size.current.h - (size.current.w < 640 ? 72 : 94));
        setAspect((prev) => (prev && Math.abs(ratio / prev - 1) < 0.12 ? prev : ratio));
      }
      if (first && size.current.w > 0) {
        view.current = fitView(atlas, size.current.w, size.current.h);
        first = false;
      }
      redraw();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [atlas]);

  // Fly to the selection.
  useEffect(() => {
    if (selected === null || !size.current.w) return;
    const rect = boundsOf(atlas, map, selected);
    if (!rect) return;
    const { w, h } = size.current;
    if (rect.w >= atlas.width * 0.99) return fit();
    const k = Math.min(
      atlas.maxScale,
      (w * 0.5) / Math.max(rect.w, 0.01),
      (h * 0.5) / Math.max(rect.h, 0.01),
    );
    animateTo({ k, x: w / 2 - (rect.x + rect.w / 2) * k, y: h / 2 - (rect.y + rect.h / 2) * k });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fly only when the target changes
  }, [selected, atlas, map]);

  useEffect(() => () => cancelAnimationFrame(flight.current), []);

  /** The cell a pointer means at this zoom: never deeper than what's drawn. */
  const pick = (sx: number, sy: number): Cell | null => {
    const { x, y, k } = view.current;
    const wx = (sx - x) / k;
    const wy = (sy - y) / k;
    let current: Cell | null = null;
    let children = atlas.root.children;
    for (;;) {
      const hit = children.find(
        (c) => wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h,
      );
      if (!hit) return current;
      const screen = Math.min(hit.w, hit.h) * k;
      if (hit.level === "district" && hit.w * k < SHOW.district) {
        // Too small to read as a district: look straight through to its files.
        const plot = hit.children.find(
          (c) => wx >= c.x && wx <= c.x + c.w && wy >= c.y && wy <= c.y + c.h,
        );
        if (plot && Math.min(plot.w, plot.h) * k >= 6) return plot;
        return current;
      }
      if (hit.level === "plot" && screen < 6) return current;
      if (
        hit.level === "lot" &&
        (!current || Math.min(current.w * k, current.h * k * 2) < SHOW.lots)
      )
        return current;
      current = hit;
      if (!hit.children.length) return current;
      children = hit.children;
    }
  };

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
      plot: cssVar("--raised"),
      lot: cssVar("--pane"),
      changed: cssVar("--data-berry"),
      ink: cssVar("--ink"),
      muted: cssVar("--ink-muted"),
      faint: cssVar("--ink-faint"),
      line: cssVar("--line"),
      signal: cssVar("--signal-line"),
      out: cssVar("--data-teal"),
      in: cssVar("--data-violet"),
      plate: cssVar("--pane"),
      well: cssVar("--pane"),
    };
    const font = getComputedStyle(document.body).fontFamily;
    const mono = cssVar("--font-mono") || "monospace";
    const sx = (wx: number) => wx * k + tx;
    const sy = (wy: number) => wy * k + ty;
    const visible = (c: Cell) =>
      sx(c.x) <= w && sx(c.x + c.w) >= 0 && sy(c.y) <= h && sy(c.y + c.h) >= 0;

    // Labels are placed after the territory, most important first. Long names
    // are ellipsized, not dropped; the hover and inspector keep the full name.
    // Keep labels clear of controls, the legend and higher-priority labels.
    interface Label {
      priority: number;
      box: [number, number, number, number];
      /** Reserves its box so lower-priority labels avoid it. */
      solid: boolean;
      draw: () => void;
    }
    const labels: Label[] = [];
    const blocked: [number, number, number, number][] = [
      [0, 0, w, 58],
      ...(w >= 640 ? ([[0, h - 30, 380, 30]] as [number, number, number, number][]) : []),
    ];
    const overlaps = (a: [number, number, number, number], b: [number, number, number, number]) =>
      a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
    /** Fit a readable prefix without splitting a grapheme or stretching the font. */
    const fitLine = (text: string, max: number): string | null => {
      if (ctx.measureText(text).width <= max) return text;
      if (ctx.measureText("…").width > max) return null;
      const starts = Array.from(labelSegments.segment(text), (part) => part.index);
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const candidate = `${text.slice(0, starts[mid]).trimEnd()}…`;
        if (ctx.measureText(candidate).width <= max) low = mid;
        else high = mid - 1;
      }
      return `${text.slice(0, starts[low]).trimEnd()}…`;
    };
    /** Wrap at words, then ellipsize the last line instead of hiding the name. */
    const wrapLines = (text: string, max: number): string[] | null => {
      const words = text.trim().split(/\s+/);
      const lines: string[] = [];
      let line = "";
      for (let i = 0; i < words.length; i++) {
        const next = line ? `${line} ${words[i]}` : words[i]!;
        if (ctx.measureText(next).width <= max) line = next;
        else if (line && lines.length === 0) {
          lines.push(line);
          line = words[i]!;
        } else {
          const last = fitLine([line, ...words.slice(i)].filter(Boolean).join(" "), max);
          if (last) lines.push(last);
          return lines.length ? lines : null;
        }
      }
      const last = fitLine(line, max);
      if (last) lines.push(last);
      return lines.length ? lines : null;
    };
    const inBand = (
      cell: Cell,
      X: number,
      Y: number,
      W: number,
      band: number,
      weight: string,
      size: number,
      fill: string,
      family: string,
      priority: number,
    ) => {
      ctx.font = `${weight} ${size}px ${family}`;
      const text = fitLine(cell.label, W - 12);
      if (!text) return;
      const tw = ctx.measureText(text).width;
      labels.push({
        priority,
        solid: false,
        box: [X + 6, Y, tw, band],
        draw: () => {
          ctx.font = `${weight} ${size}px ${family}`;
          ctx.fillStyle = fill;
          ctx.textBaseline = "middle";
          ctx.fillText(text, X + 6, Y + band / 2 + 1);
        },
      });
    };

    const draw = (cell: Cell) => {
      if (!visible(cell)) return;
      const X = sx(cell.x);
      const Y = sy(cell.y);
      const W = cell.w * k;
      const H = cell.h * k;
      if (cell.level === "region") {
        // A constant 1.5px seam keeps regions apart at every zoom.
        ctx.fillStyle = color.region;
        ctx.beginPath();
        ctx.roundRect(
          X + 1.5,
          Y + 1.5,
          Math.max(0, W - 3),
          Math.max(0, H - 3),
          Math.min(8, W / 8, H / 8),
        );
        ctx.fill();
        const band = cell.header * k;
        if (band >= 14)
          inBand(
            cell,
            X,
            Y,
            W,
            band,
            "600",
            Math.min(13, band * 0.62),
            color.ink,
            font,
            3e9 + W * H,
          );
        else if (W > 18 && H > 18) {
          // Far out a name may overhang its region, like a city on a map;
          // placement order and the collision check keep names apart.
          ctx.font = `600 12px ${font}`;
          const lines = wrapLines(cell.label, Math.max(W - 14, 150));
          if (lines) {
            const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
            const bh = lines.length * 15 + 5;
            const cx = X + W / 2;
            const cy = Y + H / 2;
            // A name wider than its region outlines the region it names.
            const overhangs = tw + 10 > W - 6;
            labels.push({
              priority: 2e9 + W * H,
              solid: true,
              box: [cx - tw / 2 - 5, cy - bh / 2, tw + 10, bh],
              draw: () => {
                if (overhangs) {
                  ctx.strokeStyle = color.faint;
                  ctx.globalAlpha = 0.7;
                  ctx.lineWidth = 1;
                  ctx.strokeRect(X + 1.5, Y + 1.5, Math.max(0, W - 3), Math.max(0, H - 3));
                  ctx.globalAlpha = 1;
                }
                ctx.font = `600 12px ${font}`;
                ctx.globalAlpha = 0.9;
                ctx.fillStyle = color.plate;
                ctx.beginPath();
                ctx.roundRect(cx - tw / 2 - 5, cy - bh / 2, tw + 10, bh, 5);
                ctx.fill();
                ctx.globalAlpha = 1;
                ctx.fillStyle = color.ink;
                ctx.textBaseline = "middle";
                ctx.textAlign = "center";
                lines.forEach((l, n) =>
                  ctx.fillText(l, cx, cy - (lines.length - 1) * 7.5 + n * 15 + 0.5),
                );
                ctx.textAlign = "start";
              },
            });
          }
        }
      } else if (cell.level === "district") {
        // Far out a district is just its files; closer, a darker well inside the region.
        if (W >= SHOW.district) {
          ctx.fillStyle = color.well;
          ctx.fillRect(X, Y, W, H);
          const band = cell.header * k;
          if (band >= 11)
            inBand(
              cell,
              X,
              Y,
              W,
              band,
              "400",
              Math.min(11, band * 0.68),
              color.faint,
              mono,
              1e9 + W * H,
            );
        }
      } else if (cell.level === "plot") {
        if (W * H < SHOW.plot) return;
        ctx.fillStyle = cell.changed ? color.changed : color.plot;
        ctx.globalAlpha = cell.changed ? 0.55 : 1;
        ctx.fillRect(X, Y, Math.max(W, 0.8), Math.max(H, 0.8));
        ctx.globalAlpha = 1;
        const band = cell.header * k;
        if (cell.children.length && W > SHOW.lots && band >= 9)
          inBand(cell, X - 2, Y, W, band, "600", Math.min(12, band * 0.75), color.ink, font, W * H);
        else if (W > 50 && H > 15)
          inBand(
            cell,
            X - 2,
            Y,
            W,
            Math.min(H, 20),
            "400",
            Math.min(12, H * 0.5),
            color.muted,
            font,
            W * H,
          );
        if (W < SHOW.lots || H * 2 < SHOW.lots) return;
      } else {
        ctx.fillStyle = color.lot;
        ctx.fillRect(X, Y, W, H);
        if (W > 42 && H > 13) {
          ctx.font = `${Math.min(11, H * 0.55)}px ${mono}`;
          const text = fitLine(cell.label, W - 6);
          // Room for a second line: where the symbol starts in its file.
          const line = map.nodes[cell.node]?.[4] ?? 0;
          const detail = H > 34 && line > 0 ? `line ${line}` : "";
          if (text)
            labels.push({
              priority: W * H,
              solid: false,
              box: [
                X + 3,
                Y + H / 2 - (detail ? 13 : 7),
                ctx.measureText(text).width,
                detail ? 26 : 14,
              ],
              draw: () => {
                ctx.font = `${Math.min(11, H * 0.55)}px ${mono}`;
                ctx.fillStyle = color.muted;
                ctx.textBaseline = "middle";
                ctx.fillText(text, X + 3, Y + H / 2 - (detail ? 6 : 0));
                if (detail) {
                  ctx.font = `10px ${mono}`;
                  ctx.fillStyle = color.faint;
                  ctx.fillText(detail, X + 3, Y + H / 2 + 8);
                }
              },
            });
        }
        return;
      }
      for (const child of cell.children) draw(child);
    };
    for (const region of atlas.root.children) draw(region);
    labels.sort((a, b) => b.priority - a.priority);
    for (const label of labels) {
      const [x, y, lw, lh] = label.box;
      if (x < 0 || y < 0 || x + lw > w || y + lh > h) continue;
      if (blocked.some((b) => overlaps(label.box, b))) continue;
      if (label.solid) blocked.push(label.box);
      label.draw();
    }

    const outline = (cell: Cell, stroke: string, width: number) => {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.strokeRect(
        sx(cell.x) - width / 2,
        sy(cell.y) - width / 2,
        cell.w * k + width,
        cell.h * k + width,
      );
    };
    for (const node of hits) {
      const cell = atlas.cellOf.get(node);
      if (cell && visible(cell)) outline(cell, color.ink, 1.5);
    }

    // Links of the hovered and selected nodes; containment is already the layout.
    const lit = [hover?.cell.node, selected].filter(
      (n): n is number => n !== undefined && n !== null && n >= 0,
    );
    const centre = (c: Cell) => [sx(c.x + c.w / 2), sy(c.y + c.h / 2)] as const;
    for (const node of new Set(lit)) {
      const from = atlas.cellOf.get(node);
      if (!from) continue;
      const [ax, ay] = centre(from);
      let drawn = 0;
      for (const [list, stroke] of [
        [atlas.out.get(node) ?? [], color.out],
        [atlas.in.get(node) ?? [], color.in],
      ] as const) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.25;
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        for (const [other, kind] of list) {
          if (kind === "contains" || kind === "defines" || drawn > 600) continue;
          const to = atlas.cellOf.get(other);
          if (!to || to === from) continue;
          const [bx, by] = centre(to);
          const mx = (ax + bx) / 2 - (by - ay) * 0.15;
          const my = (ay + by) / 2 + (bx - ax) * 0.15;
          ctx.moveTo(ax, ay);
          ctx.quadraticCurveTo(mx, my, bx, by);
          drawn++;
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    if (hover) outline(hover.cell, color.ink, 1);
    const chosen = selected !== null ? atlas.cellOf.get(selected) : undefined;
    if (chosen && chosen !== atlas.root) outline(chosen, color.signal, 2);
  }, [frame, atlas, hits, hover, selected]);

  const hoverNode = hover && hover.cell.node >= 0 ? map.nodes[hover.cell.node] : null;

  const zoomBy = (factor: number, cx = size.current.w / 2, cy = size.current.h / 2) => {
    const v = view.current;
    const min = fitView(atlas, size.current.w, size.current.h).k * 0.6;
    const k = Math.max(min, Math.min(atlas.maxScale, v.k * factor));
    view.current = { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
    redraw();
  };

  // Wheel zoom needs a non-passive listener so the page doesn't scroll.
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(flight.current);
      const rect = el.getBoundingClientRect();
      zoomBy(
        Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)),
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  return (
    <div ref={wrap} className="relative min-h-0 overflow-hidden rounded-pane bg-pane">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Map of the codebase: ${atlas.root.children.length} regions. Search or use the inspector to move between entries.`}
        className="block cursor-grab touch-none active:cursor-grabbing"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          cancelAnimationFrame(flight.current);
          pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          drag.current = { x: e.clientX, y: e.clientY, moved: pointers.current.size > 1 };
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          if (pointers.current.has(e.pointerId))
            pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointers.current.size === 2) {
            const [a, b] = [...pointers.current.values()] as [
              { x: number; y: number },
              { x: number; y: number },
            ];
            const distance = Math.hypot(a.x - b.x, a.y - b.y);
            if (pinch.current)
              zoomBy(
                distance / pinch.current,
                (a.x + b.x) / 2 - rect.left,
                (a.y + b.y) / 2 - rect.top,
              );
            pinch.current = distance;
            return;
          }
          if (drag.current) {
            const dx = e.clientX - drag.current.x;
            const dy = e.clientY - drag.current.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) drag.current.moved = true;
            drag.current.x = e.clientX;
            drag.current.y = e.clientY;
            view.current = { ...view.current, x: view.current.x + dx, y: view.current.y + dy };
            if (hover) setHover(null);
            redraw();
            return;
          }
          const cell = pick(e.clientX - rect.left, e.clientY - rect.top);
          if (cell?.node !== hover?.cell.node || cell !== hover?.cell)
            setHover(cell ? { cell, x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
        }}
        onPointerCancel={(e) => {
          pointers.current.delete(e.pointerId);
          pinch.current = null;
          drag.current = null;
        }}
        onPointerUp={(e) => {
          pointers.current.delete(e.pointerId);
          pinch.current = null;
          if (pointers.current.size) return;
          const moved = drag.current?.moved;
          drag.current = null;
          if (moved) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const cell = pick(e.clientX - rect.left, e.clientY - rect.top);
          if (cell && cell.node >= 0) onSelect(cell.node);
        }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          zoomBy(2.2, e.clientX - rect.left, e.clientY - rect.top);
        }}
      />
      <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start gap-2">
        <div className="pointer-events-auto min-w-0 flex-1">{children}</div>
        <div className="pointer-events-auto flex shrink-0 gap-1 rounded-control bg-pane p-0.5">
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
            aria-label="Zoom out"
            onClick={() => zoomBy(1 / 1.6)}
          >
            <MinusIcon weight="bold" />
          </button>
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
            aria-label="Zoom in"
            onClick={() => zoomBy(1.6)}
          >
            <PlusIcon weight="bold" />
          </button>
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
            aria-label="Show the whole map"
            onClick={fit}
          >
            <ArrowsOutIcon weight="bold" />
          </button>
        </div>
      </div>
      <ul className="mk-legend pointer-events-none absolute bottom-2 left-3 m-0 rounded-control bg-pane/90 px-2 py-1 text-micro max-sm:hidden">
        <li>
          <span className="mk-key mk-key--bar bg-data-berry/60" />
          Changed in the latest build
        </li>
        <li>
          <span className="mk-key mk-key--line bg-data-teal" />
          Uses
        </li>
        <li>
          <span className="mk-key mk-key--line bg-data-violet" />
          Used by
        </li>
      </ul>
      {hover && hoverNode && !drag.current && (
        <div
          className="mk-tooltip pointer-events-none absolute z-[1] max-w-[24rem] flex-col items-start gap-0.5"
          style={{
            left: Math.min(hover.x + 14, size.current.w - 260),
            top: Math.min(hover.y + 16, size.current.h - 64),
          }}
        >
          <span className="font-semibold">{hoverNode[2]}</span>
          <span className="text-micro text-ink-faint">
            {KIND_LABEL[hoverNode[1]]}
            {hover.cell.level === "region" || hover.cell.level === "district"
              ? ` · ${hover.cell.children.length.toLocaleString()} inside`
              : ""}
          </span>
          {hoverNode[3] && hoverNode[3] !== hoverNode[2] && (
            <span className="max-w-full truncate font-mono text-micro text-ink-muted">
              {hoverNode[3]}
            </span>
          )}
        </div>
      )}
      {hover && !hoverNode && !drag.current && (
        <div
          className="mk-tooltip pointer-events-none absolute z-[1]"
          style={{ left: Math.min(hover.x + 14, size.current.w - 200), top: hover.y + 16 }}
        >
          {hover.cell.label} · {hover.cell.children.length.toLocaleString()} inside
        </div>
      )}
    </div>
  );
}
