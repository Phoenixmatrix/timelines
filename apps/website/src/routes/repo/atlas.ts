// The atlas model: the knowledge graph laid out as nested territory.
// Components are regions, directories districts inside them, files plots,
// symbols lots inside a file. Concepts and packages get regions of their own.
// A squarified treemap keeps every level close to square; weights are
// bucketed (log2) and ties break by name, so places stay put across builds
// unless something changes by an order of magnitude. Pure, so it is tested
// without a canvas.

import type { KnowledgeMap } from "../../../shared/api.ts";

export type CellLevel = "region" | "district" | "plot" | "lot";

export interface Cell {
  /** Index into the map's nodes, or -1 for a synthetic group. */
  node: number;
  level: CellLevel;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** World units reserved at the top for this cell's own label. */
  header: number;
  changed: boolean;
  children: Cell[];
  parent: Cell | null;
}

export interface Atlas {
  root: Cell;
  width: number;
  height: number;
  /** Map node index to the cell that draws it. */
  cellOf: Map<number, Cell>;
  /** Outgoing and incoming edges by node index: [other node, kind]. */
  out: Map<number, [number, string][]>;
  in: Map<number, [number, string][]>;
  byId: Map<string, number>;
  /** Scale at which the typical smallest entry fills a good part of the screen. */
  maxScale: number;
}

export const WORLD_W = 1600;

interface Item {
  weight: number;
  label: string;
}

/** Squarified treemap: rects for items (sorted by weight, descending) inside x,y,w,h. */
export function squarify<T extends Item>(
  items: T[],
  x: number,
  y: number,
  w: number,
  h: number,
): { item: T; x: number; y: number; w: number; h: number }[] {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (!items.length || total <= 0 || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const areas = items.map((i) => i.weight * scale);
  const out: { item: T; x: number; y: number; w: number; h: number }[] = [];
  let i = 0;
  let rx = x;
  let ry = y;
  let rw = w;
  let rh = h;
  const worst = (sum: number, min: number, max: number, side: number) =>
    Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  while (i < items.length) {
    const side = Math.min(rw, rh);
    let sum = areas[i]!;
    let min = sum;
    let max = sum;
    let ratio = worst(sum, min, max, side);
    let j = i + 1;
    while (j < items.length) {
      const a = areas[j]!;
      const next = worst(sum + a, Math.min(min, a), Math.max(max, a), side);
      if (next > ratio) break;
      sum += a;
      min = Math.min(min, a);
      max = Math.max(max, a);
      ratio = next;
      j++;
    }
    if (rw >= rh) {
      const sw = sum / rh;
      let cy = ry;
      for (let k = i; k < j; k++) {
        const hk = areas[k]! / sw;
        out.push({ item: items[k]!, x: rx, y: cy, w: sw, h: hk });
        cy += hk;
      }
      rx += sw;
      rw -= sw;
    } else {
      const sh = sum / rw;
      let cx = rx;
      for (let k = i; k < j; k++) {
        const wk = areas[k]! / sh;
        out.push({ item: items[k]!, x: cx, y: ry, w: wk, h: sh });
        cx += wk;
      }
      ry += sh;
      rh -= sh;
    }
    i = j;
  }
  return out;
}

/** Stable order: weight bucket (log2) first, then name. */
function stable<T extends Item>(items: T[]): T[] {
  return items.sort(
    (a, b) =>
      Math.floor(Math.log2(b.weight)) - Math.floor(Math.log2(a.weight)) ||
      a.label.localeCompare(b.label),
  );
}

const dirname = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

interface Group extends Item {
  node: number;
  level: CellLevel;
  changed: boolean;
  children: Group[];
}

const leaf = (
  node: number,
  label: string,
  weight: number,
  level: CellLevel,
  changed: boolean,
): Group => ({
  node,
  label,
  weight,
  level,
  changed,
  children: [],
});

function group(node: number, label: string, level: CellLevel, children: Group[]): Group {
  return {
    node,
    label,
    level,
    changed: false,
    children: stable(children),
    weight: children.reduce((s, c) => s + c.weight, 0),
  };
}

/** Lay out children inside a parent cell, leaving room for its label and a margin. */
function place(groups: Group[], parent: Cell, cellOf: Map<number, Cell>) {
  // The root lays regions edge to edge; each level inside brings a margin.
  // Margins shrink with the cell, so a tiny file in a huge map is still mostly content.
  const base = !parent.parent
    ? 0
    : parent.level === "region"
      ? 3
      : parent.level === "district"
        ? 1.6
        : 0.8;
  const pad = Math.min(base, Math.min(parent.w, parent.h) * 0.04);
  const top = parent.y + parent.header;
  const inner = {
    x: parent.x + pad,
    y: top + pad,
    w: parent.w - 2 * pad,
    h: parent.y + parent.h - top - 2 * pad,
  };
  // Too small for a margin and label: children fill the parent outright.
  const area = inner.w > 0 && inner.h > 0 ? inner : parent;
  const rects = squarify(groups, area.x, area.y, area.w, area.h);
  for (const r of rects) {
    const g = r.item;
    const gap = Math.min(
      g.level === "lot" ? 0.25 : g.level === "plot" ? 0.5 : g.level === "region" ? 0.8 : 0,
      r.w / 4,
      r.h / 4,
    );
    const cell: Cell = {
      node: g.node,
      level: g.level,
      label: g.label,
      x: r.x + gap,
      y: r.y + gap,
      w: Math.max(0, r.w - 2 * gap),
      h: Math.max(0, r.h - 2 * gap),
      header: 0,
      changed: g.changed,
      children: [],
      parent,
    };
    // Room for a label scales with the cell, capped so small ones stay all content.
    cell.header =
      g.level === "region"
        ? Math.min(16, cell.h * 0.14)
        : g.level === "district"
          ? Math.min(9, cell.h * 0.16)
          : g.level === "plot" && g.children.length
            ? Math.min(5, cell.h * 0.22)
            : 0;
    if (g.node >= 0 && !cellOf.has(g.node)) cellOf.set(g.node, cell);
    parent.children.push(cell);
    if (g.children.length) place(g.children, cell, cellOf);
  }
}

export function buildAtlas(map: KnowledgeMap, aspect = 1.6): Atlas {
  const WORLD_H = WORLD_W / aspect;
  const { nodes, edges } = map;
  const byId = new Map(nodes.map((n, i) => [n[0], i]));
  const out = new Map<number, [number, string][]>();
  const inn = new Map<number, [number, string][]>();
  for (const [a, b, kind] of edges) {
    out.set(a, [...(out.get(a) ?? []), [b, kind]]);
    inn.set(b, [...(inn.get(b) ?? []), [a, kind]]);
  }

  // Which component holds each file, and the symbols each file defines.
  const componentOf = new Map<number, number>();
  const symbols = new Map<number, number[]>();
  for (const [a, b, kind] of edges) {
    const [, ak] = nodes[a]!;
    const [, bk] = nodes[b]!;
    if (kind === "contains" && ak === "component" && bk === "file") componentOf.set(b, a);
    if (kind === "defines" && ak === "file" && bk === "symbol")
      symbols.set(a, [...(symbols.get(a) ?? []), b]);
  }

  const regions: Group[] = [];
  const filesByRegion = new Map<
    string,
    { node: number; label: string; base: string; files: number[] }
  >();
  for (const [i, [, kind, , path]] of nodes.entries()) {
    if (kind !== "file" || path === null) continue;
    const component = componentOf.get(i);
    const key = component !== undefined ? `c:${component}` : `d:${path.split("/")[0]}`;
    let region = filesByRegion.get(key);
    if (!region) {
      region =
        component !== undefined
          ? {
              node: component,
              label: nodes[component]![2],
              base: nodes[component]![3] ?? "",
              files: [],
            }
          : {
              node: byId.get(`dir:${path.split("/")[0]}`) ?? -1,
              label: path.includes("/") ? `${path.split("/")[0]}/` : "Root files",
              base: path.includes("/") ? path.split("/")[0]! : "",
              files: [],
            };
      filesByRegion.set(key, region);
    }
    region.files.push(i);
  }

  for (const region of filesByRegion.values()) {
    const districts = new Map<string, Group[]>();
    for (const f of region.files) {
      const [, , name, path, size, changed] = nodes[f]!;
      const lots = (symbols.get(f) ?? []).map((s) =>
        leaf(s, nodes[s]![2], 1, "lot", nodes[s]![5] === 1),
      );
      const plot: Group = {
        ...leaf(
          f,
          name,
          Math.max(4, Math.sqrt(size || 16) * 2, lots.length * 1.2),
          "plot",
          changed === 1,
        ),
        children: stable(lots),
      };
      const dir = dirname(path!);
      districts.set(dir, [...(districts.get(dir) ?? []), plot]);
    }
    const prefix = region.base ? `${region.base}/` : "";
    // A region whose files share one folder holds them directly.
    const children = [...districts].flatMap(([dir, plots]) => {
      const relative =
        dir === region.base ? "" : dir.startsWith(prefix) ? dir.slice(prefix.length) : dir;
      return districts.size === 1
        ? plots
        : [group(byId.get(`dir:${dir}`) ?? -1, `${relative || "."}/`, "district", plots)];
    });
    regions.push(group(region.node, region.label, "region", children));
  }

  // Concepts, grouped under their broader concept; packages, by ecosystem.
  const mentions = (i: number) => (inn.get(i) ?? []).filter(([, k]) => k !== "part_of").length;
  const conceptGroups = new Map<number, Group[]>();
  const packageGroups = new Map<string, Group[]>();
  for (const [i, [id, kind, name, , , changed]] of nodes.entries()) {
    if (kind === "concept") {
      const parent = (out.get(i) ?? []).find(([, k]) => k === "part_of")?.[0] ?? -1;
      const plot = leaf(i, name, 2 + Math.sqrt(mentions(i)) * 2, "plot", changed === 1);
      conceptGroups.set(parent, [...(conceptGroups.get(parent) ?? []), plot]);
    } else if (kind === "package") {
      const ecosystem = id.split(":")[1] ?? "other";
      const plot = leaf(i, name, 2 + Math.sqrt(mentions(i)) * 2, "plot", changed === 1);
      packageGroups.set(ecosystem, [...(packageGroups.get(ecosystem) ?? []), plot]);
    }
  }
  // A broad concept is itself a plot elsewhere; here it names a district.
  const conceptDistricts = [...conceptGroups].map(([parent, plots]) =>
    group(parent, parent >= 0 ? nodes[parent]![2] : "Other concepts", "district", plots),
  );
  if (conceptDistricts.length) regions.push(group(-1, "Concepts", "region", conceptDistricts));
  if (packageGroups.size)
    regions.push(
      group(
        -1,
        "Dependencies",
        "region",
        [...packageGroups].map(([eco, plots]) => group(-1, eco, "district", plots)),
      ),
    );

  const root: Cell = {
    node: byId.get("repo") ?? -1,
    level: "region",
    label: "",
    x: 0,
    y: 0,
    w: WORLD_W,
    h: WORLD_H,
    header: 0,
    changed: false,
    children: [],
    parent: null,
  };
  const cellOf = new Map<number, Cell>();
  if (root.node >= 0) cellOf.set(root.node, root);
  place(stable(regions), root, cellOf);
  // Zoom stops when the median smallest entry (a symbol, else a file) is ~150px
  // wide: enough to read its name and line, before tiles turn into empty boxes.
  const smallest = [...cellOf.values()].filter((c) => c.level === "lot");
  const sample = (
    smallest.length ? smallest : [...cellOf.values()].filter((c) => c.level === "plot")
  )
    .map((c) => c.w)
    .sort((a, b) => a - b);
  const median = sample[sample.length >> 1] ?? 10;
  const maxScale = Math.max(4, 150 / Math.max(median, 0.01));
  return { root, width: WORLD_W, height: WORLD_H, cellOf, out, in: inn, byId, maxScale };
}

/** The deepest cell under a world point, no deeper than `maxLevel`. */
export function cellAt(atlas: Atlas, x: number, y: number, maxLevel: CellLevel): Cell | null {
  const depth: Record<CellLevel, number> = { region: 0, district: 1, plot: 2, lot: 3 };
  let current: Cell | null = null;
  let children = atlas.root.children;
  for (;;) {
    const hit = children.find((c) => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
    if (!hit) return current;
    current = hit;
    if (depth[hit.level] >= depth[maxLevel] || !hit.children.length) return current;
    children = hit.children;
  }
}

/** The world rectangle for a node: its cell, or the files under a directory. */
export function boundsOf(atlas: Atlas, map: KnowledgeMap, node: number) {
  const cell = atlas.cellOf.get(node);
  if (cell) return { x: cell.x, y: cell.y, w: cell.w, h: cell.h };
  const [, kind, , path] = map.nodes[node] ?? [];
  if (kind === "directory" && path) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [i, n] of map.nodes.entries()) {
      if (n[1] !== "file" || !n[3]?.startsWith(`${path}/`)) continue;
      const c = atlas.cellOf.get(i);
      if (!c) continue;
      x0 = Math.min(x0, c.x);
      y0 = Math.min(y0, c.y);
      x1 = Math.max(x1, c.x + c.w);
      y1 = Math.max(y1, c.y + c.h);
    }
    if (x0 < Infinity) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return null;
}
