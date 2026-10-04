// The capability map on canvas (CORE-168, CORE-47): islands of hexagons,
// each one something. A capability is a country of its concepts, placed
// beside the capabilities it's linked with; structural groups are islands
// below. Selecting a capability draws its one-hop routes: what it uses and
// what uses it. Semantic zoom: far out, countries carry their names; closer,
// each concept's hexagon carries its own; closer still, a hexagon shows its
// files as small hexagons, named once they're big enough to read. The region
// list beside the map is the accessible path; this canvas is a picture of it.

import { ArrowsOutIcon, MinusIcon, PlusIcon } from "@phosphor-icons/react";
import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cellAt, HEX, type Territory, type TerritoryCell, type Tile } from "./territory.ts";

interface View {
  x: number;
  y: number;
  k: number;
}

/**
 * On-screen circumradius (px) at which a country's concepts are named and
 * can be picked, a hexagon's small ones are drawn and picked, and a small
 * one is named.
 */
const SHOW = { concepts: 30, inside: 12, named: 24 };
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SQ3 = Math.sqrt(3);

/** Whether a cell's children are drawn, named and picked at zoom k. */
const openAt = (c: TerritoryCell, k: number) =>
  c.inner > 0 && c.inner * k >= (c.hex ? SHOW.inside : SHOW.concepts);

function fitView(t: Territory, w: number, h: number): View {
  const pad = 24;
  const tw = Math.max(1, t.width - t.left);
  const th = Math.max(1, t.height - t.top);
  const k = Math.min((w - pad * 2) / tw, (h - pad * 2 - 40) / th);
  return {
    k,
    x: (w - tw * k) / 2 - t.left * k,
    y: pad + 40 + (h - pad * 2 - 40 - th * k) / 2 - t.top * k,
  };
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

/**
 * Regions drawn as one thing across bands: in a workspace, the repository
 * capabilities of a capability spanning repositories (CORE-184), joined by a
 * line. `active` draws it, and its members, in the selection colour.
 */
export interface MapTie {
  id: string;
  cells: readonly string[];
  active: boolean;
}

/** One hop from the selection: a region it uses (out) or that uses it (in), and how many imports. */
export interface MapRoute {
  id: string;
  direction: "out" | "in";
  weight: number;
}

const NO_TIES: readonly MapTie[] = [];
const NO_ROUTES: readonly MapRoute[] = [];
const NO_EMPHASIS: ReadonlySet<string> = new Set();

const fileLabel = (n: number) => `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;

/** The paths a territory is drawn with, built once per territory. */
interface Scene {
  /**
   * Hexagons by region, shade and host: each country's plate (its hexagons
   * whole, so it reads as one piece of land) and faces (a little smaller, so
   * the plate shows between them). Small hexagons have a host and no plate.
   */
  fills: { region: string; shade: number; host: string | null; face: Path2D; plate: Path2D }[];
  /** Coasts of countries, and of structural islands. */
  coast: Path2D;
  isles: Path2D;
  /** Each top-level region's own hexagons, for where routes leave and land. */
  tilesOf: Map<string, Tile[]>;
  outline: (id: string) => Path2D;
}

function hexPath(path: Path2D, x: number, y: number, r: number) {
  path.moveTo(x + (r * SQ3) / 2, y - r / 2);
  path.lineTo(x + (r * SQ3) / 2, y + r / 2);
  path.lineTo(x, y + r);
  path.lineTo(x - (r * SQ3) / 2, y + r / 2);
  path.lineTo(x - (r * SQ3) / 2, y - r / 2);
  path.lineTo(x, y - r);
  path.closePath();
}

function sceneOf(territory: Territory): Scene {
  const fills = new Map<string, Scene["fills"][number]>();
  const tilesOf = new Map<string, Tile[]>();
  for (const tile of territory.tiles) {
    const key = `${tile.region}|${tile.shade}|${tile.host ?? ""}`;
    let fill = fills.get(key);
    if (!fill) {
      fill = {
        region: tile.region,
        shade: tile.shade,
        host: tile.host,
        face: new Path2D(),
        plate: new Path2D(),
      };
      fills.set(key, fill);
    }
    if (tile.host) {
      hexPath(fill.face, tile.x, tile.y, tile.r * 0.86);
      continue;
    }
    hexPath(fill.plate, tile.x, tile.y, tile.r * 1.005);
    hexPath(fill.face, tile.x, tile.y, tile.r * 0.9);
    const list = tilesOf.get(tile.region) ?? [];
    list.push(tile);
    tilesOf.set(tile.region, list);
  }
  const coast = new Path2D();
  const isles = new Path2D();
  for (const c of territory.cells) {
    if (c.depth !== 0 || !c.size) continue;
    const path = c.structural ? isles : coast;
    for (let i = 0; i < c.edges.length; i += 4) {
      path.moveTo(c.edges[i]!, c.edges[i + 1]!);
      path.lineTo(c.edges[i + 2]!, c.edges[i + 3]!);
    }
  }
  const outlines = new Map<string, Path2D>();
  const outline = (id: string) => {
    let path = outlines.get(id);
    if (path) return path;
    path = new Path2D();
    const e = territory.byId.get(id)?.edges ?? [];
    for (let i = 0; i < e.length; i += 4) {
      path.moveTo(e[i]!, e[i + 1]!);
      path.lineTo(e[i + 2]!, e[i + 3]!);
    }
    outlines.set(id, path);
    return path;
  };
  return { fills: [...fills.values()], coast, isles, tilesOf, outline };
}

const nearestTile = (tiles: readonly Tile[] | undefined, x: number, y: number): Tile | null => {
  let hit: Tile | null = null;
  let best = Infinity;
  for (const t of tiles ?? []) {
    const d = (t.x - x) ** 2 + (t.y - y) ** 2;
    if (d < best) {
      best = d;
      hit = t;
    }
  }
  return hit;
};

/** A file's or symbol's own name: the last part of its path. */
const shortName = (c: TerritoryCell) => c.entity.path?.split("/").pop() || c.entity.name;

export function AtlasTerritory({
  territory,
  selected,
  loading,
  onSelect,
  label,
  bands = NO_BANDS,
  ties = NO_TIES,
  routes = NO_ROUTES,
  origin,
  emphasis = NO_EMPHASIS,
  emphasisNote = null,
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
  /** Regions joined across bands, drawn over them. */
  ties?: readonly MapTie[];
  /** The selection's one-hop links to other regions on the map. */
  routes?: readonly MapRoute[];
  /** Where a cell comes from, for its hover card (e.g. its repository). */
  origin?: (cell: TerritoryCell) => string | null;
  /** Regions outlined as well as drawn, e.g. the capabilities a timeline touches (CORE-186). */
  emphasis?: ReadonlySet<string>;
  /** What the outline means, for the hover card. */
  emphasisNote?: string | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const mini = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 });
  const fitted = useRef(false);
  const flight = useRef(0);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<number | null>(null);
  const [frame, setFrame] = useState(0);
  const [hover, setHover] = useState<{ cell: TerritoryCell; x: number; y: number } | null>(null);
  const [overview, setOverview] = useState(false);
  const miniView = useRef({ mx: 0, my: 0, ms: 1 });
  const redraw = () => setFrame((f) => f + 1);
  const scene = useMemo(() => sceneOf(territory), [territory]);
  const hovered = hover?.cell.id ?? null;

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
    let k = Math.min(40, (w * 0.55) / target.w, (h * 0.55) / target.h);
    // A country: close enough to name its concepts, while its neighbours,
    // where its routes go, stay in view where they can.
    if (target.depth === 0 && !target.hex) {
      const named = (SHOW.concepts * 1.1) / HEX;
      k = Math.max(named, Math.min(k, Math.max(named * 1.3, fitView(territory, w, h).k * 1.25)));
    }
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
    const box = wrap.current;
    const { w, h } = size.current;
    if (!el || !box || !w) return;
    const dpr = window.devicePixelRatio || 1;
    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    }
    const ctx = el.getContext("2d")!;
    const style = getComputedStyle(box);
    const token = (name: string) => style.getPropertyValue(name).trim() || "#888";
    const pair = (name: string, fallback: [number, number]): [number, number] => {
      const [a, b] = token(name).split(/\s+/).map(Number);
      return Number.isFinite(a) && Number.isFinite(b) ? [a!, b!] : fallback;
    };
    const num = (name: string, fallback: number) => {
      const v = Number(token(name));
      return Number.isFinite(v) ? v : fallback;
    };
    const color = {
      sea: token("--map-sea"),
      seaFar: token("--map-sea-far"),
      shallows: token("--map-shallows"),
      coast: token("--map-coast"),
      border: token("--map-border"),
      soft: token("--line-soft"),
      ink: token("--ink"),
      muted: token("--ink-muted"),
      faint: token("--ink-faint"),
      rail: token("--rail"),
      signal: token("--signal-line"),
      changed: token("--data-berry"),
      uses: token("--data-teal"),
      usedBy: token("--data-violet"),
      emphasis: token("--data-teal"),
    };
    const land = pair("--map-land", [0.355, 0.05]);
    const isle = pair("--map-isle", [0.29, 0.006]);
    const halo = pair("--map-halo", [0.17, 0.012]);
    const lift = num("--map-land-lift", 0.075);
    const dim = num("--map-land-dim", -0.07);
    const step = num("--map-land-step", 0.022);
    const font = getComputedStyle(document.body).fontFamily;
    const mono = token("--font-mono");
    const { x: tx, y: ty, k } = view.current;
    const sx = (x: number) => x * k + tx;
    const sy = (y: number) => y * k + ty;

    // The sea: deeper in the middle of the view, fading to the pane at its edges.
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sea = ctx.createRadialGradient(
      w * 0.45,
      h * 0.5,
      0,
      w * 0.45,
      h * 0.5,
      Math.hypot(w, h) * 0.6,
    );
    sea.addColorStop(0, color.sea);
    sea.addColorStop(1, color.seaFar);
    ctx.fillStyle = sea;
    ctx.fillRect(0, 0, w, h);

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
    /** Up to `most` lines of at most `max` px, the last cut short if it must be. */
    const lines = (text: string, max: number, most = 2): string[] => {
      const out: string[] = [];
      let words = text.split(/\s+/).filter(Boolean);
      while (words.length && out.length < most) {
        if (out.length === most - 1) {
          const last = fitText(words.join(" "), max);
          if (last) out.push(last);
          break;
        }
        let line = "";
        let i = 0;
        for (; i < words.length; i++) {
          const next = line ? `${line} ${words[i]}` : words[i]!;
          if (line && ctx.measureText(next).width > max) break;
          line = next;
        }
        const fitted = fitText(line, max);
        if (!fitted) break;
        out.push(fitted);
        words = words.slice(i);
      }
      return out;
    };
    const opened = (c: TerritoryCell) => openAt(c, k);
    const visibleParent = (c: TerritoryCell): boolean => {
      if (!c.parent) return true;
      const parent = territory.byId.get(c.parent);
      return !!parent && opened(parent) && visibleParent(parent);
    };
    const shown = (c: TerritoryCell) => c.size > 0 && visibleParent(c);
    const topOf = (c: TerritoryCell): TerritoryCell => {
      let cell = c;
      while (cell.parent) cell = territory.byId.get(cell.parent) ?? cell;
      return cell;
    };

    for (const b of bands) {
      const x = sx(b.x);
      const y = sy(b.y);
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
      ctx.textAlign = "left";
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

    // Who the selection talks to: their countries stay lit, the rest sink.
    const sel = selected ? territory.byId.get(selected) : undefined;
    const lit = new Set<string>();
    const drawnRoutes = routes.filter((r) => {
      const c = territory.byId.get(r.id);
      return c && c.id !== sel?.id && shown(c);
    });
    if (sel && drawnRoutes.length) {
      lit.add(topOf(sel).id);
      for (const r of drawnRoutes) lit.add(topOf(territory.byId.get(r.id)!).id);
    }
    const hueOf = new Map<string, number>();
    const structural = new Set<string>();
    for (const c of territory.cells)
      if (c.depth === 0) {
        hueOf.set(c.id, c.hue);
        if (c.structural) structural.add(c.id);
      }
    const selTop = sel ? topOf(sel).id : null;

    // World space from here: lines are set in screen pixels over k.
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * tx, dpr * ty);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const px = (n: number) => n / k;

    // Shallow water: soft rings around every coast.
    ctx.strokeStyle = color.shallows;
    for (const [width, alpha] of [
      [HEX * 0.75, 0.03],
      [HEX * 0.48, 0.045],
      [HEX * 0.26, 0.07],
      [HEX * 0.11, 0.11],
    ] as const) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = width;
      ctx.stroke(scene.coast);
      ctx.globalAlpha = alpha * 0.7;
      ctx.stroke(scene.isles);
    }
    ctx.globalAlpha = 1;

    const tone = (region: string, shade: number, extra = 0) => {
      const isleLand = structural.has(region);
      const [l0, c0] = isleLand ? isle : land;
      let l = l0 + (shade - 1) * step + extra;
      let c = c0;
      if (region === selTop) {
        l += lift;
        c *= 1.35;
      } else if (lit.size && !lit.has(region)) {
        l += dim;
        c *= 0.55;
      }
      return `oklch(${l.toFixed(3)} ${c.toFixed(3)} ${isleLand ? 70 : (hueOf.get(region) ?? 70)})`;
    };
    // Plates first, darker, so every country reads as one piece of land with its concepts on it.
    for (const f of scene.fills) {
      if (f.host) continue;
      ctx.fillStyle = tone(f.region, 0, -step * 2.5);
      ctx.fill(f.plate);
    }
    for (const f of scene.fills) {
      if (f.host) continue;
      ctx.fillStyle = tone(f.region, f.shade);
      ctx.fill(f.face);
    }
    // What's inside a hexagon, once there's room to see it.
    const hosts = new Map<string, boolean>();
    const hostOpen = (id: string) => {
      let open = hosts.get(id);
      if (open === undefined) {
        const host = territory.byId.get(id);
        open = !!host && shown(host) && opened(host);
        hosts.set(id, open);
      }
      return open;
    };
    for (const f of scene.fills) {
      if (!f.host || !hostOpen(f.host)) continue;
      ctx.fillStyle = tone(f.region, f.shade, step * 4);
      ctx.fill(f.face);
    }

    ctx.strokeStyle = color.coast;
    ctx.lineWidth = px(1.5);
    ctx.stroke(scene.coast);
    ctx.setLineDash([px(4), px(4)]);
    ctx.stroke(scene.isles);
    ctx.setLineDash([]);

    for (const c of territory.cells) {
      if (!emphasis.has(c.id) || !shown(c)) continue;
      // Dashed, so it reads without colour.
      ctx.strokeStyle = color.emphasis;
      ctx.lineWidth = px(2.5);
      ctx.setLineDash([px(7), px(4)]);
      ctx.stroke(scene.outline(c.id));
      ctx.setLineDash([]);
    }
    const hoverCell = hovered ? territory.byId.get(hovered) : undefined;
    if (hoverCell && hoverCell.id !== selected && shown(hoverCell)) {
      ctx.strokeStyle = color.ink;
      ctx.globalAlpha = 0.6;
      ctx.lineWidth = px(1.5);
      ctx.stroke(scene.outline(hoverCell.id));
      ctx.globalAlpha = 1;
    }

    // Routes: from the edge of the selection nearest each region, curving
    // into it; uses bend one way and used-by the other, so a pair that use
    // each other draw as two.
    const pills: { x: number; y: number; text: string; color: string }[] = [];
    if (sel?.size && drawnRoutes.length) {
      const own = sel.depth === 0 ? scene.tilesOf.get(sel.id) : undefined;
      // Leave from inside the edge facing each region, so routes fan out
      // around the selection instead of all leaving its nearest corner.
      const radius = Math.max(0, Math.min(sel.w, sel.h) / 2 - HEX * 0.6);
      const from = (x: number, y: number) => {
        const dx = x - sel.anchor.x;
        const dy = y - sel.anchor.y;
        const d = Math.hypot(dx, dy) || 1;
        return (
          nearestTile(own, sel.anchor.x + (dx / d) * radius, sel.anchor.y + (dy / d) * radius) ??
          sel.anchor
        );
      };
      const heavy = new Set(
        [...drawnRoutes]
          .sort((a, b) => b.weight - a.weight)
          .slice(0, 6)
          .map((r) => `${r.direction}|${r.id}`),
      );
      for (const r of [...drawnRoutes].sort((a, b) => a.weight - b.weight)) {
        const other = territory.byId.get(r.id)!;
        const start = from(other.anchor.x, other.anchor.y);
        const landing =
          other.depth === 0 ? nearestTile(scene.tilesOf.get(other.id), start.x, start.y) : null;
        // Onto the near edge of the country, a little way in.
        const end = landing
          ? (() => {
              const dx = start.x - landing.x;
              const dy = start.y - landing.y;
              const d = Math.hypot(dx, dy) || 1;
              const out = Math.min(d, HEX * 0.35);
              return { x: landing.x + (dx / d) * out, y: landing.y + (dy / d) * out };
            })()
          : other.anchor;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const len = Math.hypot(dx, dy) || 1;
        const bend = (r.direction === "out" ? 1 : -1) * Math.min(len * 0.18, HEX * 1.6);
        const cx = (start.x + end.x) / 2 - (dy / len) * bend;
        const cy = (start.y + end.y) / 2 + (dx / len) * bend;
        // Arrows point the way the dependency goes: from the user to the used.
        const [a, b] = r.direction === "out" ? [start, end] : [end, start];
        const stroke = r.direction === "out" ? color.uses : color.usedBy;
        const width = Math.min(6, 1.3 + Math.sqrt(r.weight) * 0.55);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(cx, cy, b.x, b.y);
        ctx.strokeStyle = color.border;
        ctx.globalAlpha = 0.6;
        ctx.lineWidth = px(width + 3.5);
        ctx.stroke();
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = px(width);
        ctx.stroke();
        ctx.globalAlpha = 1;
        const angle = Math.atan2(b.y - cy, b.x - cx);
        const head = px(5 + width);
        ctx.beginPath();
        ctx.moveTo(b.x + Math.cos(angle) * head * 0.4, b.y + Math.sin(angle) * head * 0.4);
        ctx.lineTo(b.x - Math.cos(angle - 0.5) * head, b.y - Math.sin(angle - 0.5) * head);
        ctx.lineTo(b.x - Math.cos(angle + 0.5) * head, b.y - Math.sin(angle + 0.5) * head);
        ctx.closePath();
        ctx.fillStyle = stroke;
        ctx.fill();
        if (heavy.has(`${r.direction}|${r.id}`))
          pills.push({
            x: sx(0.25 * a.x + 0.5 * cx + 0.25 * b.x),
            y: sy(0.25 * a.y + 0.5 * cy + 0.25 * b.y),
            text: r.weight.toLocaleString(),
            color: stroke,
          });
      }
    }

    if (sel?.size && shown(sel)) {
      // The selection: a soft amber halo under a firm line.
      ctx.strokeStyle = color.signal;
      ctx.globalAlpha = 0.28;
      ctx.lineWidth = px(9);
      ctx.stroke(scene.outline(sel.id));
      ctx.globalAlpha = 1;
      ctx.lineWidth = px(2.5);
      ctx.stroke(scene.outline(sel.id));
    }

    // Ties over the land: arcs between the members' middles, left to right,
    // bowed upward so a tie never runs through a region it doesn't join.
    for (const tie of [...ties].sort((a, b) => Number(a.active) - Number(b.active))) {
      const members = tie.cells
        .map((id) => territory.byId.get(id))
        .filter((c): c is TerritoryCell => !!c && shown(c))
        .sort((a, b) => a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y);
      if (members.length < 2) continue;
      ctx.lineWidth = px(tie.active ? 2.5 : 1.5);
      ctx.strokeStyle = tie.active ? color.signal : color.muted;
      ctx.setLineDash(tie.active ? [] : [px(6), px(5)]);
      ctx.beginPath();
      members.forEach((c, i) => {
        if (i === 0) {
          ctx.moveTo(c.anchor.x, c.anchor.y);
          return;
        }
        const p = members[i - 1]!;
        const rise = Math.min(
          px(160),
          Math.hypot(c.anchor.x - p.anchor.x, c.anchor.y - p.anchor.y) * 0.3,
        );
        ctx.quadraticCurveTo(
          (p.anchor.x + c.anchor.x) / 2,
          Math.min(p.anchor.y, c.anchor.y) - rise,
          c.anchor.x,
          c.anchor.y,
        );
      });
      ctx.stroke();
      ctx.setLineDash([]);
      for (const c of members) {
        ctx.beginPath();
        ctx.arc(c.anchor.x, c.anchor.y, px(tie.active ? 5 : 3.5), 0, Math.PI * 2);
        ctx.fillStyle = tie.active ? color.signal : color.muted;
        ctx.fill();
        if (!tie.active) continue;
        ctx.lineWidth = px(2);
        ctx.strokeStyle = color.signal;
        ctx.stroke(scene.outline(c.id));
      }
    }

    // ---- labels, in screen space ------------------------------------------------
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const free = (b: { x0: number; y0: number; x1: number; y1: number }) =>
      !placed.some((p) => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
    const haloOf = (c: TerritoryCell) =>
      `oklch(${halo[0]} ${halo[1]} ${c.structural ? 70 : c.hue} / 0.85)`;
    const text = (
      t: string,
      x: number,
      y: number,
      fill: string,
      haloFill: string,
      weight: number,
      sizePx: number,
      family = font,
    ) => {
      ctx.font = `${weight} ${sizePx}px ${family}`;
      ctx.lineWidth = sizePx * 0.34;
      ctx.strokeStyle = haloFill;
      ctx.strokeText(t, x, y);
      ctx.fillStyle = fill;
      ctx.fillText(t, x, y);
    };
    const changedDot = (x: number, y: number) => {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color.changed;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = color.border;
      ctx.stroke();
    };
    /**
     * A name in a pill along a region's top edge: the selection, and regions
     * whose insides are named (their middles go to what's inside).
     */
    const pill = (c: TerritoryCell, active: boolean) => {
      if (!active && (sx(c.x + c.w) < 0 || sx(c.x) > w || sy(c.y + c.h) < 0 || sy(c.y) > h)) return;
      const sizePx = c.depth === 0 ? 14 : 13;
      ctx.font = `700 ${sizePx}px ${font}`;
      const name = fitText(c.entity.name, 260);
      if (!name) return;
      const dot = c.changed ? 14 : 0;
      const wpx = ctx.measureText(name).width + 22 + dot;
      const hpx = 26;
      // Kept on screen, but within the region's own extent.
      const clampTo = (v: number, lo: number, hi: number) =>
        Math.min(Math.max(v, lo), Math.max(lo, hi));
      const x = clampTo(
        sx(c.anchor.x),
        Math.max(wpx / 2 + 6, sx(c.x) + wpx / 2),
        Math.min(w - wpx / 2 - 6, sx(c.x + c.w) - wpx / 2),
      );
      const y0 = clampTo(
        sy(c.y + (c.hex ? c.hex * 0.42 : 0)) + (c.hex ? 0 : 6),
        hpx / 2 + 44,
        Math.min(h - hpx / 2 - 6, sy(c.y + c.h) - hpx / 2),
      );
      let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
      for (const dy of active ? [0] : [0, 1, 2]) {
        const y = y0 + dy * (hpx + 4);
        const b = { x0: x - wpx / 2, y0: y - hpx / 2, x1: x + wpx / 2, y1: y + hpx / 2 };
        if (active || free(b)) {
          box = b;
          break;
        }
      }
      if (!box) return;
      const y = (box.y0 + box.y1) / 2;
      placed.push(box);
      ctx.beginPath();
      ctx.roundRect(box.x0, box.y0, wpx, hpx, 8);
      ctx.fillStyle = color.rail;
      ctx.fill();
      ctx.lineWidth = active ? 1.5 : 1;
      ctx.strokeStyle = active ? color.signal : color.soft;
      ctx.stroke();
      if (dot) changedDot(box.x0 + 13, y);
      ctx.fillStyle = color.ink;
      ctx.fillText(name, x + dot / 2, y + 0.5);
    };
    const opensInto = (c: TerritoryCell) =>
      opened(c) && territory.cells.some((d) => d.parent === c.id && d.size > 0);

    if (sel && shown(sel) && sel.size) pill(sel, true);
    for (const p of pills) {
      ctx.font = `500 11px ${mono}`;
      const wpx = ctx.measureText(p.text).width + 12;
      const box = { x0: p.x - wpx / 2, y0: p.y - 9, x1: p.x + wpx / 2, y1: p.y + 9 };
      if (!free(box)) continue;
      placed.push(box);
      ctx.beginPath();
      ctx.roundRect(p.x - wpx / 2, p.y - 8.5, wpx, 17, 8.5);
      ctx.fillStyle = color.rail;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = p.color;
      ctx.stroke();
      ctx.fillStyle = color.ink;
      ctx.fillText(p.text, p.x, p.y + 0.5);
    }
    // Biggest first, so a crowded view keeps the names of the largest regions.
    const order = territory.cells
      .filter((c) => shown(c) && c.id !== sel?.id)
      .sort(
        (a, b) => a.depth - b.depth || (b.entity.counts.files ?? 0) - (a.entity.counts.files ?? 0),
      );
    // Regions whose insides are named get a pill; what's inside, the names in line.
    for (const c of order) if (opensInto(c)) pill(c, false);
    for (const c of order) {
      if (opensInto(c)) continue;
      const leaf = c.depth > 0 && c.hex > 0 && c.hex < HEX;
      // Room for a name across the middle of its hexagon, or of its country's.
      const room = c.hex ? c.hex * SQ3 * k * 0.86 : Math.min(c.w * k * 0.7, 240);
      if (c.hex && c.hex * k < (leaf ? SHOW.named : SHOW.concepts) * 0.85) continue;
      const x = sx(c.anchor.x);
      const y = sy(c.anchor.y);
      if (x < -200 || x > w + 200 || y < -60 || y > h + 60) continue;
      const files = c.entity.counts.files;
      const sizePx =
        c.depth === 0 && !c.hex
          ? Math.min(17, 12 + Math.log2((files ?? 0) + 1) * 0.6)
          : leaf
            ? 11
            : 12.5;
      const weight = leaf ? 500 : c.depth === 0 ? 700 : 600;
      ctx.font = `${weight} ${sizePx}px ${font}`;
      const name = lines(leaf ? shortName(c) : c.entity.name, Math.max(40, room), leaf ? 2 : 3);
      if (!name.length) continue;
      const counts = !leaf && (c.hex ? c.hex * k >= 52 : true);
      const line = sizePx * 1.18;
      const countLine = loading.has(c.id)
        ? "Loading…"
        : files !== undefined
          ? fileLabel(files)
          : "";
      const width = Math.max(...name.map((n) => ctx.measureText(n).width));
      const height = name.length * line + (counts && countLine ? 15 : 0);
      // At its anchor, or nudged up or down (inside it) if something's there already.
      let spot: { x: number; y: number } | null = null;
      for (const dy of c.hex ? [0] : [0, -0.6, 0.6, -1.2, 1.2]) {
        const cy = y + dy * height;
        const box = {
          x0: x - width / 2 - 4,
          y0: cy - height / 2 - 2,
          x1: x + width / 2 + 4,
          y1: cy + height / 2 + 2,
        };
        if (!free(box)) continue;
        if (dy) {
          const under = cellAt(territory, (x - tx) / k, (cy - ty) / k);
          if (!under || (under.id !== c.id && !isInside(territory, under, c.id))) continue;
        }
        placed.push(box);
        spot = { x, y: cy };
        break;
      }
      if (!spot) continue;
      const related = !lit.size || lit.has(topOf(c).id);
      const top = spot.y - height / 2 + line / 2;
      name.forEach((n, i) =>
        text(
          n,
          spot.x,
          top + i * line,
          c.structural || !related ? color.muted : color.ink,
          haloOf(c),
          weight,
          sizePx,
        ),
      );
      if (counts && countLine)
        text(
          countLine,
          spot.x,
          top + name.length * line - 2,
          color.muted,
          haloOf(c),
          450,
          10.5,
          mono,
        );
      if (c.changed) changedDot(spot.x - width / 2 - 9, top);
    }
    // Changed concepts and regions too small for a label still show their
    // dot; files and symbols only once they're named.
    for (const c of order) {
      const r = c.hex || HEX;
      if (!c.changed || opensInto(c) || r * k < 3 || r < HEX) continue;
      if (c.hex && c.hex * k >= (c.hex < HEX && c.depth > 0 ? SHOW.named : SHOW.concepts) * 0.85)
        continue;
      if (!c.hex) continue;
      changedDot(sx(c.anchor.x), sy(c.anchor.y));
    }

    // The minimap, once the view no longer shows everything.
    const all = fitView(territory, w, h);
    const whole =
      k <= all.k * 1.05 &&
      sx(territory.left) >= -2 &&
      sy(territory.top) >= -2 &&
      sx(territory.width) <= w + 2 &&
      sy(territory.height) <= h + 2;
    const wantMini = !whole && w >= 560 && h >= 320;
    if (wantMini !== overview) setOverview(wantMini);
    const m = mini.current;
    if (!m || !wantMini) return;
    const mw = 156;
    const mh = 104;
    if (m.width !== Math.round(mw * dpr)) {
      m.width = Math.round(mw * dpr);
      m.height = Math.round(mh * dpr);
    }
    const mc = m.getContext("2d")!;
    mc.setTransform(dpr, 0, 0, dpr, 0, 0);
    mc.clearRect(0, 0, mw, mh);
    mc.fillStyle = color.seaFar;
    mc.globalAlpha = 0.92;
    mc.fillRect(0, 0, mw, mh);
    mc.globalAlpha = 1;
    const tw = territory.width - territory.left;
    const th = territory.height - territory.top;
    const ms = Math.min((mw - 12) / tw, (mh - 12) / th);
    const mx = (mw - tw * ms) / 2 - territory.left * ms;
    const my = (mh - th * ms) / 2 - territory.top * ms;
    mc.setTransform(dpr * ms, 0, 0, dpr * ms, dpr * mx, dpr * my);
    for (const f of scene.fills) {
      if (f.host) continue;
      const isleLand = structural.has(f.region);
      const [l0, c0] = isleLand ? isle : land;
      const l = l0 + (f.region === selTop ? lift * 2 : 0);
      mc.fillStyle = `oklch(${l.toFixed(3)} ${(c0 * 1.3).toFixed(3)} ${isleLand ? 70 : (hueOf.get(f.region) ?? 70)})`;
      mc.fill(f.plate);
    }
    mc.setTransform(dpr, 0, 0, dpr, 0, 0);
    const vx = mx + ((0 - tx) / k) * ms;
    const vy = my + ((0 - ty) / k) * ms;
    mc.strokeStyle = color.signal;
    mc.lineWidth = 1.5;
    mc.beginPath();
    mc.roundRect(vx, vy, (w / k) * ms, (h / k) * ms, 3);
    mc.stroke();
    miniView.current = { mx, my, ms };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hover redraws only when its region changes
  }, [
    frame,
    territory,
    scene,
    selected,
    loading,
    bands,
    ties,
    routes,
    emphasis,
    hovered,
    overview,
  ]);

  /** Centre the view on a point of the minimap. */
  const jump = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const { mx, my, ms } = miniView.current;
    const wx = (event.clientX - rect.left - mx) / ms;
    const wy = (event.clientY - rect.top - my) / ms;
    const { k } = view.current;
    view.current = { k, x: size.current.w / 2 - wx * k, y: size.current.h / 2 - wy * k };
    redraw();
  };

  const local = (event: { clientX: number; clientY: number }) => {
    const rect = canvas.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const pick = (sx: number, sy: number) => {
    const { x, y, k } = view.current;
    const hit = cellAt(territory, (sx - x) / k, (sy - y) / k);
    if (!hit) return null;
    // Never pick deeper than what's drawn.
    const chain: TerritoryCell[] = [];
    for (
      let c: TerritoryCell | undefined = hit;
      c;
      c = c.parent ? territory.byId.get(c.parent) : undefined
    )
      chain.unshift(c);
    let cell = chain[0]!;
    for (const c of chain.slice(1)) {
      if (!openAt(territory.byId.get(c.parent!)!, k)) break;
      cell = c;
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
          setHover((now) => (cell ? { cell, x: p.x, y: p.y } : now === null ? now : null));
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
      <canvas
        ref={mini}
        aria-hidden
        hidden={!overview}
        className="absolute right-2 bottom-2 h-[104px] w-[156px] cursor-pointer touch-none rounded-plate shadow-[var(--shadow-float)]"
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          jump(event);
        }}
        onPointerMove={(event) => {
          if (event.buttons) jump(event);
        }}
      />
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
            {emphasisNote && emphasis.has(hover.cell.id) && ` · ${emphasisNote}`}
          </div>
          {origin?.(hover.cell) && (
            <div className="truncate text-micro text-ink-muted">{origin(hover.cell)}</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Whether `cell` lies inside the region `id`. */
function isInside(territory: Territory, cell: TerritoryCell, id: string): boolean {
  for (
    let c: TerritoryCell | undefined = cell;
    c;
    c = c.parent ? territory.byId.get(c.parent) : undefined
  )
    if (c.id === id) return true;
  return false;
}
