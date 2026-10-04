// Geometry and loading for the capability map (CORE-168, CORE-47).
//
// The map is islands of hexagons, and every hexagon stands for something: a
// concept (one of a capability's areas), or a region with no areas, drawn as
// one. A capability is a country, a honeycomb of its concepts with the
// largest in the middle. Countries keep sea between them, and each is placed
// beside the ones it imports from or is imported by most (the overview's
// links, over the size of both), so related code sits together: what the web
// app is made of in one place, storage in another. Structural groups
// (unclassified, concepts, …) are single islands along the bottom. Zooming
// into a hexagon shows what's in it, its files, as small hexagons on it.
//
// Where everything goes depends only on the overview: its regions, their
// concepts and the links between them. Loading what's inside a hexagon never
// moves anything, and one snapshot always draws the same map. Another
// snapshot can move a country when its links change: the map shows how the
// code hangs together now, not where it once was.

import type { AtlasEntitySummary, AtlasRegion, AtlasRegionLink } from "../../../shared/atlas.ts";

/** Circumradius of a concept's hexagon, in world units. */
export const HEX = 60;
/** At most this many concepts drawn in a country (three rings), and things in one hexagon (five). */
const MAX_CONCEPTS = 37;
const MAX_INSIDE = 91;
/** How many of its strongest links place a country. */
const NEIGHBOURS = 3;

const SQ3 = Math.sqrt(3);

export interface Territory {
  /** Every drawn cell, parents before children. */
  cells: TerritoryCell[];
  byId: Map<string, TerritoryCell>;
  /** Every hexagon: a country's own, then the small ones drawn on them. */
  tiles: Tile[];
  /** The extent of the land: from left/top to width/height. */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Tile {
  x: number;
  y: number;
  /** Circumradius. */
  r: number;
  /** The cell it is. */
  cell: string;
  /** The top-level region (country or island) it belongs to. */
  region: string;
  /** The cell whose hexagon it's drawn on; null for a country's own hexagons. */
  host: string | null;
  /** How light it's drawn (0 to 2): a concept's by its share of its country's files. */
  shade: number;
}

export interface TerritoryCell {
  id: string;
  entity: AtlasEntitySummary;
  /** 0: overview region; 1: its child; 2: a grandchild. */
  depth: number;
  parent: string | null;
  /** The bounds of its hexagons. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Structural groups (unclassified, concepts, …) aren't capabilities. */
  structural: boolean;
  /** Changed in the snapshot being shown. */
  changed: boolean;
  /** How many hexagons it covers: none when its parent ran out of room. */
  size: number;
  /** Circumradius of its own hexagon; 0 for a country of several. */
  hex: number;
  /** Circumradius of the hexagons its children are drawn as; 0 while none are. */
  inner: number;
  /** Its outline: segments as x1, y1, x2, y2, in world units. */
  edges: number[];
  /** Where its label goes: its hexagon's middle, or its largest concept's. */
  anchor: { x: number; y: number };
  /** The hue (degrees) its country is drawn in, shared by everything inside it. */
  hue: number;
}

/** Children loaded for an expanded region, in API order. */
export type Expanded = ReadonlyMap<string, readonly AtlasEntitySummary[]>;

// ---- the hex lattice (pointy-top, axial coordinates) -------------------------------

const DIRS = [
  [1, 0],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [0, -1],
  [1, -1],
] as const;
// Axial coordinates packed into one number: places stay well inside ±32k of the origin.
const key = (q: number, r: number) => (q + 32768) * 65536 + (r + 32768);
const centreOf = (q: number, r: number, size: number): [number, number] => [
  size * SQ3 * (q + r / 2),
  size * 1.5 * r,
];
/** Corner j of a hexagon; the edge facing DIRS[j] runs from corner j to corner j + 1. */
const corner = (x: number, y: number, size: number, j: number): [number, number] => {
  const a = (Math.PI / 180) * (60 * j - 30);
  return [x + size * Math.cos(a), y + size * Math.sin(a)];
};
const ringOf = (q: number, r: number) => Math.max(Math.abs(q), Math.abs(r), Math.abs(q + r));
/** Rings around a middle that n places need. */
const ringsFor = (n: number) => {
  let g = 0;
  while (1 + 3 * g * (g + 1) < n) g++;
  return g;
};

const spirals = new Map<number, [number, number][]>();
/**
 * The first n places of a honeycomb, nearest the middle first, so a country
 * stays round. Of the places equally far out, a country that takes only
 * some spreads them evenly around instead of growing a bulge on one side.
 */
function spiral(n: number): [number, number][] {
  const known = spirals.get(n);
  if (known) return known;
  const out: [number, number][] = n ? [[0, 0]] : [];
  const reach = ringsFor(n);
  const shells = new Map<number, [number, number, number][]>();
  for (let q = -reach; q <= reach; q++)
    for (let r = -reach; r <= reach; r++) {
      const ring = ringOf(q, r);
      if (!ring || ring > reach) continue;
      const [x, y] = centreOf(q, r, 1);
      const far = Math.round(Math.hypot(x, y) * 1000);
      const shell = shells.get(far) ?? [];
      // Clockwise from straight up.
      shell.push([q, r, (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2)]);
      shells.set(far, shell);
    }
  for (const far of [...shells.keys()].sort((a, b) => a - b)) {
    if (out.length >= n) break;
    const around = shells.get(far)!.sort((a, b) => a[2] - b[2]);
    const want = Math.min(around.length, n - out.length);
    for (let i = 0; i < want; i++) {
      const [q, r] = around[Math.floor((i * around.length) / want)]!;
      out.push([q, r]);
    }
  }
  spirals.set(n, out);
  return out;
}

/**
 * Where n small hexagons go on one of circumradius `size`: a honeycomb of the
 * same orientation, as big as fits. A ring g out reaches (2g + 1)·r·√3/2 from
 * the middle across a flat side, which must stay inside the parent's
 * size·√3/2: r < size / (2g + 1).
 */
function packed(n: number, size: number): { r: number; at: [number, number][] } {
  const r = (size * 0.9) / (2 * ringsFor(n) + 1);
  return { r, at: spiral(n).map(([q, rr]) => centreOf(q, rr, r)) };
}

function hexEdges(x: number, y: number, size: number): number[] {
  const edges: number[] = [];
  for (let j = 0; j < 6; j++) {
    const a = corner(x, y, size, j);
    const b = corner(x, y, size, j + 1);
    edges.push(a[0], a[1], b[0], b[1]);
  }
  return edges;
}

/** Country hues in wheel order, none near the amber reserved for selection. */
const HUES = [130, 170, 210, 250, 290, 330, 10];

/** A capability's concepts, as loaded or as the overview listed them; a count when only that's known; null for one hexagon. */
function conceptsOf(
  region: AtlasRegion,
  expanded: Expanded,
): readonly AtlasEntitySummary[] | number | null {
  if (region.structural) return null;
  const known = expanded.get(region.id) ?? region.areas;
  if (known && known.length > 1 && known.every((e) => e.kind === "area")) return known;
  const areas = region.counts.areas ?? 0;
  return areas > 1 ? areas : null;
}

interface Country {
  region: AtlasRegion;
  /** Its hexagons' places around its middle, in fill order. */
  shape: [number, number][];
  isle: boolean;
}

/**
 * Where each country's middle goes on the lattice, and its hue. One at a
 * time: first the most connected, then whichever pulls hardest toward those
 * already placed, each at the free place nearest the ones it's linked to (and
 * a little toward the middle, so the land stays together). Free means none
 * of its hexagons touches another country's: there's always sea between.
 * Islands go last, in a row below.
 */
function place(countries: Country[], links: readonly AtlasRegionLink[]) {
  const index = new Map(countries.map((c, i) => [c.region.id, i]));
  const files = (c: Country) => Math.max(1, c.region.counts.files ?? c.region.size?.members ?? 1);
  // Imports both ways over the geometric mean of both sizes, so a hub that
  // everything imports a little doesn't pull everything to itself.
  const pairs = new Map<number, number>();
  for (const l of links) {
    const a = index.get(l.src);
    const b = index.get(l.dst);
    if (a === undefined || b === undefined || a === b) continue;
    if (countries[a]!.isle || countries[b]!.isle) continue;
    const k = Math.min(a, b) * 65536 + Math.max(a, b);
    pairs.set(k, (pairs.get(k) ?? 0) + l.weight);
  }
  const strength = countries.map(() => new Map<number, number>());
  for (const [k, w] of pairs) {
    const a = Math.floor(k / 65536);
    const b = k % 65536;
    const s = w / Math.sqrt(files(countries[a]!) * files(countries[b]!));
    strength[a]!.set(b, s);
    strength[b]!.set(a, s);
  }
  // Each follows only its strongest few: where everything imports a little of
  // everything, the rest would only pull it all to the middle.
  const kept = countries.map(() => new Map<number, number>());
  strength.forEach((m, a) => {
    for (const [b, s] of [...m].sort((x, y) => y[1] - x[1] || x[0] - y[0]).slice(0, NEIGHBOURS)) {
      kept[a]!.set(b, s);
      kept[b]!.set(a, s);
    }
  });

  const blocked = new Set<number>();
  const bounds = { q0: 0, q1: 0, r0: 0, r1: 0 };
  const at: ([number, number] | null)[] = countries.map(() => null);
  const centre: ([number, number] | null)[] = countries.map(() => null);
  const placed: number[] = [];
  const claim = (i: number, q: number, r: number) => {
    for (const [dq, dr] of countries[i]!.shape) {
      const cq = q + dq;
      const cr = r + dr;
      blocked.add(key(cq, cr));
      for (const [nq, nr] of DIRS) blocked.add(key(cq + nq, cr + nr));
      bounds.q0 = Math.min(bounds.q0, cq);
      bounds.q1 = Math.max(bounds.q1, cq);
      bounds.r0 = Math.min(bounds.r0, cr);
      bounds.r1 = Math.max(bounds.r1, cr);
    }
    at[i] = [q, r];
    centre[i] = centreOf(q, r, HEX);
    placed.push(i);
  };
  /** Place country i; `floor` keeps it at or below that row (islands, below the land). */
  const put = (i: number, floor: number | null) => {
    const shape = countries[i]!.shape;
    if (!placed.length) return claim(i, 0, 0);
    const reach = ringsFor(shape.length) + 2;
    const pulls = [...kept[i]!].filter(([j]) => centre[j]);
    const pull = pulls.reduce((s, [, w]) => s + w, 0);
    let mx = 0;
    let my = 0;
    for (const j of placed) {
      mx += centre[j]![0];
      my += centre[j]![1];
    }
    mx /= placed.length;
    my /= placed.length;
    let best = Infinity;
    let pick: [number, number] = [bounds.q0, bounds.r1 + reach + 1];
    for (let r = bounds.r0 - reach; r <= bounds.r1 + reach; r++) {
      if (floor !== null && r < floor) continue;
      for (let q = bounds.q0 - reach - Math.ceil(reach / 2); q <= bounds.q1 + reach; q++) {
        if (shape.some(([dq, dr]) => blocked.has(key(q + dq, r + dr)))) continue;
        const [x, y] = centreOf(q, r, HEX);
        const middle = Math.hypot(x - mx, y - my);
        let score = middle;
        if (floor !== null) score = Math.abs(x - mx) + (r - floor) * HEX * 4;
        else if (pull > 0) {
          let near = 0;
          for (const [j, w] of pulls) near += w * Math.hypot(x - centre[j]![0], y - centre[j]![1]);
          score = near / pull + 0.35 * middle;
        }
        if (score < best - 1e-6) {
          best = score;
          pick = [q, r];
        }
      }
    }
    claim(i, pick[0], pick[1]);
  };

  // The overview's order (largest first) breaks every tie.
  const pending = new Set(countries.flatMap((c, i) => (c.isle ? [] : [i])));
  while (pending.size) {
    let next = -1;
    let most = -1;
    for (const i of pending) {
      let s = 0;
      if (placed.length) for (const j of placed) s += kept[i]!.get(j) ?? 0;
      else for (const w of kept[i]!.values()) s += w;
      if (s > most) {
        most = s;
        next = i;
      }
    }
    pending.delete(next);
    put(next, null);
  }
  const floor = placed.length ? bounds.r1 + 2 : null;
  countries.forEach((c, i) => {
    if (c.isle) put(i, floor);
  });

  // Hues: each country takes the next on the wheel that no close neighbour has.
  const hues = countries.map(() => HUES[0]!);
  const taken = countries.map(() => -1);
  placed.forEach((i, n) => {
    const reach = (j: number) =>
      HEX * SQ3 * (ringsFor(countries[i]!.shape.length) + ringsFor(countries[j]!.shape.length) + 3);
    const near = new Set(
      placed
        .slice(0, n)
        .filter(
          (j) =>
            Math.hypot(centre[i]![0] - centre[j]![0], centre[i]![1] - centre[j]![1]) < reach(j),
        )
        .map((j) => taken[j]),
    );
    let h = (n * 3) % HUES.length;
    for (let s = 0; s < HUES.length; s++) {
      const c = (n * 3 + s) % HUES.length;
      if (!near.has(c)) {
        h = c;
        break;
      }
    }
    taken[i] = h;
    hues[i] = HUES[h]!;
  });
  return { at: at as [number, number][], hues };
}

/**
 * Lay out the overview's regions and whatever's open inside them: countries
 * of concepts, single hexagons for regions without, and inside any hexagon
 * whose children are loaded, its children as small hexagons.
 */
export function buildTerritory(
  regions: readonly AtlasRegion[],
  expanded: Expanded,
  snapshotSeq: number,
  links: readonly AtlasRegionLink[] = [],
): Territory {
  // A first snapshot has nothing to compare with: everything in it is new, so
  // nothing is marked.
  const changed = (e: AtlasEntitySummary) =>
    snapshotSeq > 1 && e.since !== undefined && e.since === snapshotSeq;

  const concepts = regions.map((r) => conceptsOf(r, expanded));
  const countries: Country[] = regions.map((region, i) => {
    const c = concepts[i];
    const n = c === null || c === undefined ? 1 : typeof c === "number" ? c : c.length;
    return { region, shape: spiral(Math.min(MAX_CONCEPTS, n)), isle: region.structural };
  });
  const { at, hues } = place(countries, links);

  const cells: TerritoryCell[] = [];
  const byId = new Map<string, TerritoryCell>();
  const tiles: Tile[] = [];
  const add = (cell: TerritoryCell) => {
    cells.push(cell);
    byId.set(cell.id, cell);
    return cell;
  };
  /** A cell of one hexagon at (x, y). */
  const hexCell = (
    entity: AtlasEntitySummary,
    depth: number,
    parent: TerritoryCell | null,
    x: number,
    y: number,
    size: number,
    hue: number,
  ): TerritoryCell =>
    add({
      id: entity.id,
      entity,
      depth,
      parent: parent?.id ?? null,
      x: x - (size * SQ3) / 2,
      y: y - size,
      w: size * SQ3,
      h: size * 2,
      structural: entity.structural,
      changed: changed(entity),
      size: 1,
      hex: size,
      inner: 0,
      edges: hexEdges(x, y, size),
      anchor: { x, y },
      hue,
    });
  /** No room left in its parent: it's listed in the outline, and sits at the parent's label. */
  const roomless = (entity: AtlasEntitySummary, depth: number, parent: TerritoryCell) =>
    add({
      id: entity.id,
      entity,
      depth,
      parent: parent.id,
      x: parent.anchor.x - 1,
      y: parent.anchor.y - 1,
      w: 2,
      h: 2,
      structural: entity.structural,
      changed: changed(entity),
      size: 0,
      hex: 0,
      inner: 0,
      edges: [],
      anchor: parent.anchor,
      hue: parent.hue,
    });
  /** A hexagon's loaded children, drawn on it. */
  const fill = (host: TerritoryCell, region: string) => {
    const children = expanded.get(host.id);
    if (!children?.length || host.depth >= 2) return;
    const n = Math.min(MAX_INSIDE, children.length);
    const { r, at: spots } = packed(n, host.hex);
    host.inner = r;
    children.forEach((child, i) => {
      if (i >= n) return void roomless(child, host.depth + 1, host);
      const x = host.anchor.x + spots[i]![0];
      const y = host.anchor.y + spots[i]![1];
      hexCell(child, host.depth + 1, host, x, y, r, host.hue);
      tiles.push({ x, y, r, cell: child.id, region, host: host.id, shade: i % 3 });
    });
  };

  const inside: TerritoryCell[] = [];
  countries.forEach((country, ci) => {
    const { region } = country;
    const hue = hues[ci]!;
    const [q0, r0] = at[ci]!;
    const spots = country.shape.map(([dq, dr]) => [q0 + dq, r0 + dr] as [number, number]);
    const known = concepts[ci];
    if (known === null || known === undefined) {
      const [x, y] = centreOf(q0, r0, HEX);
      const cell = hexCell(region, 0, null, x, y, HEX, hue);
      tiles.push({ x, y, r: HEX, cell: region.id, region: region.id, host: null, shade: 1 });
      inside.push(cell);
      return;
    }
    // A country: the outline of its hexagons, its label on the middle one.
    const mine = new Set(spots.map(([q, r]) => key(q, r)));
    const edges: number[] = [];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [q, r] of spots) {
      const [x, y] = centreOf(q, r, HEX);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
      DIRS.forEach(([dq, dr], j) => {
        if (mine.has(key(q + dq, r + dr))) return;
        const a = corner(x, y, HEX, j);
        const b = corner(x, y, HEX, j + 1);
        edges.push(a[0], a[1], b[0], b[1]);
      });
    }
    const [ax, ay] = centreOf(q0, r0, HEX);
    const top = add({
      id: region.id,
      entity: region,
      depth: 0,
      parent: null,
      x: x0 - (HEX * SQ3) / 2,
      y: y0 - HEX,
      w: x1 - x0 + HEX * SQ3,
      h: y1 - y0 + HEX * 2,
      structural: false,
      changed: changed(region),
      size: spots.length,
      hex: 0,
      inner: HEX,
      edges,
      anchor: { x: ax, y: ay },
      hue,
    });
    if (typeof known === "number") {
      // Concepts not read yet: their hexagons, without names.
      for (const [q, r] of spots) {
        const [x, y] = centreOf(q, r, HEX);
        tiles.push({ x, y, r: HEX, cell: region.id, region: region.id, host: null, shade: 1 });
      }
      return;
    }
    // Largest in the middle, then ring by ring; lighter for more of the country's files.
    const order = [...known].sort((a, b) => (b.counts.files ?? 0) - (a.counts.files ?? 0));
    const most = Math.max(1, order[0]?.counts.files ?? 1);
    order.forEach((concept, i) => {
      if (i >= spots.length) return void roomless(concept, 1, top);
      const [x, y] = centreOf(spots[i]![0], spots[i]![1], HEX);
      const share = (concept.counts.files ?? 0) / most;
      const cell = hexCell(concept, 1, top, x, y, HEX, hue);
      tiles.push({
        x,
        y,
        r: HEX,
        cell: concept.id,
        region: region.id,
        host: null,
        shade: share >= 0.6 ? 2 : share >= 0.3 ? 1 : 0,
      });
      inside.push(cell);
    });
  });
  for (const cell of inside) {
    let root = cell;
    while (root.parent) root = byId.get(root.parent) ?? root;
    fill(cell, root.id);
  }

  let left = Infinity;
  let top = Infinity;
  let width = -Infinity;
  let height = -Infinity;
  for (const t of tiles) {
    if (t.host) continue;
    left = Math.min(left, t.x - (t.r * SQ3) / 2);
    top = Math.min(top, t.y - t.r);
    width = Math.max(width, t.x + (t.r * SQ3) / 2);
    height = Math.max(height, t.y + t.r);
  }
  if (!Number.isFinite(left)) left = top = width = height = 0;
  return { cells, byId, tiles, left, top, width, height };
}

/** A territory moved by (dx, dy): a workspace places each repository's in its band. */
export function shiftTerritory(t: Territory, dx: number, dy: number): Territory {
  const cells = t.cells.map((c) => ({
    ...c,
    x: c.x + dx,
    y: c.y + dy,
    anchor: { x: c.anchor.x + dx, y: c.anchor.y + dy },
    edges: c.edges.map((v, i) => v + (i % 2 ? dy : dx)),
  }));
  return {
    cells,
    byId: new Map(cells.map((c) => [c.id, c])),
    tiles: t.tiles.map((tile) => ({ ...tile, x: tile.x + dx, y: tile.y + dy })),
    left: t.left + dx,
    top: t.top + dy,
    width: t.width + dx,
    height: t.height + dy,
  };
}

const grids = new WeakMap<Territory, Map<string, Tile[]>>();
const BUCKET = HEX * 2;

/** Whether a world point is on a tile's hexagon. */
const onTile = (t: Tile, x: number, y: number) => {
  const dx = Math.abs(x - t.x);
  const dy = Math.abs(y - t.y);
  return dx <= (t.r * SQ3) / 2 && dy <= t.r - dx / SQ3;
};

/** The deepest cell under a world point: the smallest hexagon there. */
export function cellAt(territory: Territory, x: number, y: number): TerritoryCell | null {
  let grid = grids.get(territory);
  if (!grid) {
    grid = new Map();
    for (const tile of territory.tiles) {
      const k = `${Math.floor(tile.x / BUCKET)},${Math.floor(tile.y / BUCKET)}`;
      const list = grid.get(k) ?? [];
      list.push(tile);
      grid.set(k, list);
    }
    grids.set(territory, grid);
  }
  const gx = Math.floor(x / BUCKET);
  const gy = Math.floor(y / BUCKET);
  let hit: Tile | null = null;
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      for (const tile of grid.get(`${gx + i},${gy + j}`) ?? [])
        if (onTile(tile, x, y) && (!hit || tile.r < hit.r)) hit = tile;
  return hit ? (territory.byId.get(hit.cell) ?? null) : null;
}

// ---- loading -------------------------------------------------------------------

export type Load =
  | { state: "loading" }
  | { state: "ready"; items: AtlasEntitySummary[]; next: string | null; total: number | null }
  | { state: "error"; message: string; cause?: unknown };

/**
 * Children requests keyed by region, for one snapshot. A response is kept
 * only if it's still the newest request for that region in the same
 * snapshot: a late answer for an old selection or scope never replaces what's
 * on screen.
 */
export class ChildLoader {
  #snapshot: string;
  #generation = new Map<string, number>();
  #controllers = new Map<string, AbortController>();
  readonly #fetchPage: (
    id: string,
    cursor: string | null,
    signal: AbortSignal,
  ) => Promise<{ items: AtlasEntitySummary[]; next: string | null; total: number | null }>;
  readonly #onChange: (id: string, load: Load) => void;
  constructor(
    snapshot: string,
    fetchPage: (
      id: string,
      cursor: string | null,
      signal: AbortSignal,
    ) => Promise<{ items: AtlasEntitySummary[]; next: string | null; total: number | null }>,
    onChange: (id: string, load: Load) => void,
  ) {
    this.#snapshot = snapshot;
    this.#fetchPage = fetchPage;
    this.#onChange = onChange;
  }

  get snapshot() {
    return this.#snapshot;
  }

  /** Load (or continue, with `cursor`) a region's children. */
  async load(id: string, cursor: string | null = null, previous: AtlasEntitySummary[] = []) {
    const generation = (this.#generation.get(id) ?? 0) + 1;
    this.#generation.set(id, generation);
    this.#controllers.get(id)?.abort();
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    const snapshot = this.#snapshot;
    if (!cursor) this.#onChange(id, { state: "loading" });
    try {
      const page = await this.#fetchPage(id, cursor, controller.signal);
      if (snapshot !== this.#snapshot || this.#generation.get(id) !== generation) return;
      this.#onChange(id, {
        state: "ready",
        items: [...previous, ...page.items],
        next: page.next,
        total: page.total,
      });
    } catch (error) {
      if (snapshot !== this.#snapshot || this.#generation.get(id) !== generation) return;
      if (controller.signal.aborted) return;
      this.#onChange(id, {
        state: "error",
        message: error instanceof Error ? error.message : "Couldn't load this region.",
        cause: error,
      });
    }
  }

  /** A new snapshot or scope: drop everything in flight. */
  reset(snapshot: string) {
    this.#snapshot = snapshot;
    for (const controller of this.#controllers.values()) controller.abort();
    this.#controllers.clear();
    this.#generation.clear();
  }
}
