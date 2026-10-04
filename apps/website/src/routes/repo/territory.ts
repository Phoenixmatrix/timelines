// Geometry and loading for the capability map (CORE-168, CORE-47).
//
// The map is a continent of hex tiles. Each capability the bounded Atlas API
// returned is a country grown from its stable layout slot (CORE-165), never
// from a layout over everything loaded: loading children, filtering or a
// region elsewhere growing never moves it. A country's reach comes from its
// power-of-two bucket of primary files, so area means "how many files live
// here", not complexity, importance or quality. Where two reaches overlap
// the border falls between them (an additively weighted Voronoi split), so a
// region changing size moves only the borders it shares. Structural groups
// are islands offshore. Opening a region divides its own tiles among its
// children, so nothing outside it changes.

import type { AtlasEntitySummary, AtlasRegion } from "../../../shared/atlas.ts";

/** World units: one layout slot, and the gap between slots. */
export const CELL = 300;
export const GAP = 28;
/** Capabilities sit in slots this many wide. */
export const TOP_WIDTH = 4;
/** Children with a slot place their seed in a grid this wide inside their parent. */
export const NESTED_WIDTH = 3;
/** Circumradius of one hex tile, in world units. */
export const TILE = 11;

const STEP = CELL + GAP;
const SQ3 = Math.sqrt(3);
/** A country's reach, as a share of a slot step: by bucket, and at most. */
const REACH = { base: 0.16, perBucket: 0.075, max: 0.95 };
const WOBBLE = 0.14;
const JITTER = 0.1 * STEP;
/** How far past its slot a country can reach: the margin kept around the slot grid. */
export const OVERHANG = Math.ceil(REACH.max * STEP * (1 + WOBBLE) + JITTER + TILE - CELL / 2);
/** Islands: smaller, and never touching the continent or each other. */
const ISLE = { base: 0.14, perBucket: 0.03, max: 0.36 };

export interface Territory {
  /** Every drawn cell, parents before children. */
  cells: TerritoryCell[];
  byId: Map<string, TerritoryCell>;
  /** Every land tile, each owned by the deepest cell drawn there. */
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
  /** The deepest cell drawn on this tile. */
  cell: string;
  /** The top-level region (country or island) it belongs to. */
  region: string;
  /** Which of its country's areas it falls in, for alternating shades (0 to 2). */
  shade: number;
}

export interface TerritoryCell {
  id: string;
  entity: AtlasEntitySummary;
  /** 0: overview region; 1: its child; 2: a grandchild. */
  depth: number;
  parent: string | null;
  /** The bounds of its tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Structural groups (unclassified, concepts, …) aren't capabilities. */
  structural: boolean;
  /** Changed in the snapshot being shown. */
  changed: boolean;
  /** How many tiles it covers: none when its parent ran out of room. */
  size: number;
  /** Its outline along tile edges: segments as x1, y1, x2, y2, in world units. */
  edges: number[];
  /** Where its label goes: the middle of a tile inside it, near its centre. */
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
// Axial coordinates packed into one number: tiles stay well inside ±32k of the origin.
const key = (q: number, r: number) => (q + 32768) * 65536 + (r + 32768);
const centreOf = (q: number, r: number): [number, number] => [
  TILE * SQ3 * (q + r / 2),
  TILE * 1.5 * r,
];
/** Corner j of a tile; the edge facing DIRS[j] runs from corner j to corner j + 1. */
const corner = (x: number, y: number, j: number): [number, number] => {
  const a = (Math.PI / 180) * (60 * j - 30);
  return [x + TILE * Math.cos(a), y + TILE * Math.sin(a)];
};

const dist = (dx: number, dy: number) => Math.sqrt(dx * dx + dy * dy);

/** A stable number in [0, 1) from a string. */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Smooth noise in about [-1, 1], phased per region so each border has its own wobble. */
function wobble(x: number, y: number, phase: number): number {
  return (
    (Math.sin(x * 0.011 + phase) * Math.cos(y * 0.013 - phase * 1.7) +
      0.5 * Math.sin((x + y) * 0.027 + phase * 2.3) +
      0.25 * Math.sin(x * 0.061 - y * 0.053 + phase * 3.1)) /
    1.75
  );
}

const bucketOf = (entity: AtlasEntitySummary): number => {
  if (entity.layout) return entity.layout.bucket;
  const n = entity.counts.files ?? (entity as Partial<AtlasRegion>).size?.members ?? 0;
  return n > 0 ? Math.ceil(Math.log2(n + 1)) : 0;
};

/** Country hues in wheel order, none near the amber reserved for selection. */
const HUES = [130, 170, 210, 250, 290, 330, 10];

/**
 * A country's hue comes from its slot: (2·col + 3·row) mod 7 puts any two
 * slots side by side or diagonal two or three steps apart in HUES, so
 * neighbours never look alike, and a region keeps its colour while it keeps
 * its place.
 */
function hueOf(region: AtlasEntitySummary): number {
  const slot = region.layout?.slot;
  if (slot === undefined) return HUES[Math.floor(hash(region.id) * HUES.length)]!;
  const col = slot % TOP_WIDTH;
  const row = Math.floor(slot / TOP_WIDTH);
  return HUES[(2 * col + 3 * row) % HUES.length]!;
}

interface Grower {
  region: AtlasEntitySummary;
  x: number;
  y: number;
  reach: number;
  phase: number;
  /** Islands claim only what no one else reaches, and never compete. */
  isle: boolean;
}

/**
 * Lay out the overview's regions and any expanded children. Capabilities
 * grow from their stable slot; regions without one (structural groups, or a
 * snapshot from before stable layout) are islands below, in API order.
 */
export function buildTerritory(
  regions: readonly AtlasRegion[],
  expanded: Expanded,
  snapshotSeq: number,
): Territory {
  // A first snapshot has nothing to compare with: everything in it is new, so
  // nothing is marked.
  const changed = (e: AtlasEntitySummary) =>
    snapshotSeq > 1 && e.since !== undefined && e.since === snapshotSeq;

  const placed = regions.filter((r) => r.layout && !r.structural);
  const band = regions.filter((r) => !r.layout || r.structural);
  const growers: Grower[] = placed.map((region) => {
    const slot = region.layout!.slot;
    const col = slot % TOP_WIDTH;
    const row = Math.floor(slot / TOP_WIDTH);
    const h = hash(region.id);
    return {
      region,
      x: OVERHANG + col * STEP + CELL / 2 + (h - 0.5) * 2 * JITTER,
      y: OVERHANG + row * STEP + CELL / 2 + (hash(`${region.id}~`) - 0.5) * 2 * JITTER,
      reach: STEP * Math.min(REACH.max, REACH.base + REACH.perBucket * bucketOf(region)),
      phase: h * Math.PI * 2,
      isle: false,
    };
  });
  // The islands sit below the furthest any country could reach.
  let bandTop = OVERHANG;
  for (const g of growers)
    bandTop = Math.max(bandTop, g.y + g.reach * (1 + WOBBLE) + TILE + STEP * 0.3);
  band.forEach((region, i) => {
    const reach = STEP * Math.min(ISLE.max, ISLE.base + ISLE.perBucket * bucketOf(region));
    growers.push({
      region,
      x: OVERHANG + (i % TOP_WIDTH) * STEP + CELL / 2,
      y: bandTop + Math.floor(i / TOP_WIDTH) * STEP * 0.85 + STEP * ISLE.max * (1 + WOBBLE),
      reach,
      phase: hash(region.id) * Math.PI * 2,
      isle: true,
    });
  });

  // Each tile goes to the region whose reach covers it with the most to spare.
  const owner = new Map<number, { g: number; score: number; q: number; r: number }>();
  growers.forEach((g, gi) => {
    const limit = g.reach * (1 + WOBBLE);
    const r0 = Math.floor((g.y - limit) / (TILE * 1.5)) - 1;
    const r1 = Math.ceil((g.y + limit) / (TILE * 1.5)) + 1;
    for (let r = r0; r <= r1; r++) {
      const q0 = Math.floor((g.x - limit) / (TILE * SQ3) - r / 2) - 1;
      const q1 = Math.ceil((g.x + limit) / (TILE * SQ3) - r / 2) + 1;
      for (let q = q0; q <= q1; q++) {
        const [x, y] = centreOf(q, r);
        const reach = g.reach * (1 + WOBBLE * wobble(x, y, g.phase));
        const d = dist(x - g.x, y - g.y);
        if (d > reach) continue;
        const score = d - reach;
        const k = key(q, r);
        const had = owner.get(k);
        if (!had || score < had.score) owner.set(k, { g: gi, score, q, r });
      }
    }
  });
  // Lone tiles inside a neighbour read as noise: they join the neighbour.
  for (const [k, t] of owner) {
    const counts = new Map<number, number>();
    for (const [dq, dr] of DIRS) {
      const n = owner.get(key(t.q + dq, t.r + dr));
      if (n) counts.set(n.g, (counts.get(n.g) ?? 0) + 1);
    }
    if (counts.has(t.g)) continue;
    let best = -1;
    let most = 0;
    for (const [g, n] of counts)
      if (n > most || (n === most && g < best)) {
        best = g;
        most = n;
      }
    if (most >= 4) owner.set(k, { ...t, g: best });
  }

  const tiles: Tile[] = [];
  const index = new Map<number, number>();
  const lattice: [number, number][] = [];
  const own: number[][] = growers.map(() => []);
  // Sorted, so tile order (and every tie broken by it) doesn't depend on Map order.
  const ordered = [...owner.values()].sort((a, b) => a.r - b.r || a.q - b.q);
  for (const t of ordered) {
    const [x, y] = centreOf(t.q, t.r);
    const id = growers[t.g]!.region.id;
    index.set(key(t.q, t.r), tiles.length);
    own[t.g]!.push(tiles.length);
    lattice.push([t.q, t.r]);
    tiles.push({ x, y, cell: id, region: id, shade: 1 });
  }

  const cells: TerritoryCell[] = [];
  const byId = new Map<string, TerritoryCell>();
  const make = (
    entity: AtlasEntitySummary,
    depth: number,
    parent: TerritoryCell | null,
    members: number[],
    hue: number,
  ): TerritoryCell => {
    const cell: TerritoryCell = {
      id: entity.id,
      entity,
      depth,
      parent: parent?.id ?? null,
      structural: entity.structural,
      changed: changed(entity),
      hue,
      ...shapeOf(members, tiles, lattice, index, parent),
    };
    cells.push(cell);
    byId.set(cell.id, cell);
    for (const t of members) tiles[t]!.cell = cell.id;
    return cell;
  };

  // Children divide their parent's tiles; grandchildren divide their parent's.
  const nest = (parent: TerritoryCell, members: number[], depth: number) => {
    const children = expanded.get(parent.id);
    if (!children?.length) return;
    const shares = divide(children, members, tiles, lattice, index, parent);
    children.forEach((child, i) => {
      const mine = shares[i]!;
      if (depth === 1) for (const t of mine) tiles[t]!.shade = i % 3;
      const cell = make(child, depth, parent, mine, parent.hue);
      nest(cell, mine, depth + 1);
    });
  };
  const tops = growers.map((g, gi) => make(g.region, 0, null, own[gi]!, hueOf(g.region)));
  tops.forEach((cell, gi) => nest(cell, own[gi]!, 1));

  let left = Infinity;
  let top = Infinity;
  let width = 0;
  let height = 0;
  for (const c of cells) {
    if (!c.size) continue;
    left = Math.min(left, c.x);
    top = Math.min(top, c.y);
    width = Math.max(width, c.x + c.w);
    height = Math.max(height, c.y + c.h);
  }
  if (!Number.isFinite(left)) left = top = 0;
  return { cells, byId, tiles, left, top, width, height };
}

/** Bounds, outline and label anchor of a set of tiles. */
function shapeOf(
  members: number[],
  tiles: Tile[],
  lattice: [number, number][],
  index: Map<number, number>,
  parent: TerritoryCell | null,
) {
  if (!members.length) {
    // No room left in its parent: it's listed in the outline, and sits at the parent's label.
    const at = parent?.anchor ?? { x: 0, y: 0 };
    return {
      x: at.x - TILE,
      y: at.y - TILE,
      w: TILE * 2,
      h: TILE * 2,
      size: 0,
      edges: [],
      anchor: at,
    };
  }
  const mine = new Set(members);
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  let cx = 0;
  let cy = 0;
  const edges: number[] = [];
  const inner: number[] = [];
  for (const t of members) {
    const { x, y } = tiles[t]!;
    const [q, r] = lattice[t]!;
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
    cx += x;
    cy += y;
    let closed = true;
    DIRS.forEach(([dq, dr], j) => {
      const n = index.get(key(q + dq, r + dr));
      if (n !== undefined && mine.has(n)) return;
      closed = false;
      const a = corner(x, y, j);
      const b = corner(x, y, j + 1);
      edges.push(a[0], a[1], b[0], b[1]);
    });
    if (closed) inner.push(t);
  }
  cx /= members.length;
  cy /= members.length;
  let anchor = tiles[members[0]!]!;
  let best = Infinity;
  for (const t of inner.length ? inner : members) {
    const d = dist(tiles[t]!.x - cx, tiles[t]!.y - cy);
    if (d < best) {
      best = d;
      anchor = tiles[t]!;
    }
  }
  return {
    x: x0 - TILE,
    y: y0 - TILE,
    w: x1 - x0 + TILE * 2,
    h: y1 - y0 + TILE * 2,
    size: members.length,
    edges,
    anchor: { x: anchor.x, y: anchor.y },
  };
}

/**
 * Divide a parent's tiles among its children, each in one piece where it can
 * be: seeds from the children's own slots (or spread out, in API order),
 * then balanced growth toward each child's share of the files. More
 * children than tiles: the first ones get a tile each, the rest none.
 */
function divide(
  children: readonly AtlasEntitySummary[],
  members: number[],
  tiles: Tile[],
  lattice: [number, number][],
  index: Map<number, number>,
  parent: TerritoryCell,
): number[][] {
  const shares: number[][] = children.map(() => []);
  if (!members.length) return shares;
  const room = new Set(members);
  const taken = new Map<number, number>();
  const n = Math.min(children.length, members.length);
  const weights = children.slice(0, n).map((c) => Math.max(1, c.counts.files ?? 1));
  const total = weights.reduce((s, w) => s + w, 0);
  const quota = weights.map((w) => Math.max(1, Math.round((w / total) * members.length)));

  const free = (t: number) => room.has(t) && !taken.has(t);
  const nearest = (x: number, y: number) => {
    let hit = -1;
    let best = Infinity;
    for (const t of members) {
      if (!free(t)) continue;
      const d = dist(tiles[t]!.x - x, tiles[t]!.y - y);
      if (d < best) {
        best = d;
        hit = t;
      }
    }
    return hit;
  };
  const slotted = children.slice(0, n).every((c) => c.layout);
  const seeds: number[] = [];
  if (slotted) {
    const rows =
      Math.max(...children.slice(0, n).map((c) => Math.floor(c.layout!.slot / NESTED_WIDTH))) + 1;
    for (const c of children.slice(0, n)) {
      const col = c.layout!.slot % NESTED_WIDTH;
      const row = Math.floor(c.layout!.slot / NESTED_WIDTH);
      seeds.push(
        nearest(
          parent.x + ((col + 0.5) / NESTED_WIDTH) * parent.w,
          parent.y + ((row + 0.5) / rows) * parent.h,
        ),
      );
      taken.set(seeds.at(-1)!, seeds.length - 1);
    }
  } else {
    // Spread out: each next seed as far as it can be from the others.
    const gap = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      let pick = -1;
      if (i === 0) pick = nearest(parent.x, parent.y);
      else {
        let far = -1;
        for (const t of members) {
          if (!free(t)) continue;
          const d = gap.get(t) ?? Infinity;
          if (d > far) {
            far = d;
            pick = t;
          }
        }
      }
      seeds.push(pick);
      taken.set(pick, i);
      for (const t of members) {
        const d = dist(tiles[t]!.x - tiles[pick]!.x, tiles[t]!.y - tiles[pick]!.y);
        gap.set(t, Math.min(gap.get(t) ?? Infinity, d));
      }
    }
  }
  const frontier: Set<number>[] = seeds.map(() => new Set());
  const grow = (i: number, t: number) => {
    shares[i]!.push(t);
    taken.set(t, i);
    const [q, r] = lattice[t]!;
    for (const [dq, dr] of DIRS) {
      const nb = index.get(key(q + dq, r + dr));
      if (nb !== undefined && free(nb)) frontier[i]!.add(nb);
    }
  };
  seeds.forEach((t, i) => grow(i, t));
  const done = Array.from({ length: n }, () => false);
  for (;;) {
    let pick = -1;
    let ratio = Infinity;
    for (let i = 0; i < n; i++) {
      if (done[i] || shares[i]!.length >= quota[i]!) continue;
      const r = shares[i]!.length / quota[i]!;
      if (r < ratio) {
        ratio = r;
        pick = i;
      }
    }
    if (pick < 0) break;
    const seed = tiles[seeds[pick]!]!;
    let next = -1;
    let best = Infinity;
    for (const t of frontier[pick]!) {
      if (!free(t)) {
        frontier[pick]!.delete(t);
        continue;
      }
      const d = dist(tiles[t]!.x - seed.x, tiles[t]!.y - seed.y);
      if (d < best || (d === best && t < next)) {
        best = d;
        next = t;
      }
    }
    // Boxed in by its neighbours: it keeps what it has.
    if (next < 0) done[pick] = true;
    else grow(pick, next);
  }
  // Whatever no child reached joins the child beside it.
  for (let pass = 0; pass < members.length; pass++) {
    let moved = false;
    for (const t of members) {
      if (!free(t)) continue;
      const [q, r] = lattice[t]!;
      for (const [dq, dr] of DIRS) {
        const nb = index.get(key(q + dq, r + dr));
        const i = nb === undefined ? undefined : taken.get(nb);
        if (i === undefined) continue;
        shares[i]!.push(t);
        taken.set(t, i);
        moved = true;
        break;
      }
    }
    if (!moved) break;
  }
  return shares;
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

/** The deepest drawn cell under a world point: the cell of the tile there. */
export function cellAt(territory: Territory, x: number, y: number): TerritoryCell | null {
  let grid = grids.get(territory);
  if (!grid) {
    grid = new Map();
    for (const tile of territory.tiles) {
      const k = `${Math.floor(tile.x / (TILE * 2))},${Math.floor(tile.y / (TILE * 2))}`;
      const list = grid.get(k) ?? [];
      list.push(tile);
      grid.set(k, list);
    }
    grids.set(territory, grid);
  }
  const gx = Math.floor(x / (TILE * 2));
  const gy = Math.floor(y / (TILE * 2));
  let hit: Tile | null = null;
  let best = TILE;
  for (let i = -1; i <= 1; i++)
    for (let j = -1; j <= 1; j++)
      for (const tile of grid.get(`${gx + i},${gy + j}`) ?? []) {
        const d = dist(tile.x - x, tile.y - y);
        if (d <= best) {
          best = d;
          hit = tile;
        }
      }
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
