// Geometry and loading for the capability territory map (CORE-168).
//
// The map draws only what the bounded Atlas API returned: the overview's
// regions, and the children of regions someone expanded. Positions come from
// each region's stable layout slot (CORE-165), never from a layout over
// everything loaded, so loading children, filtering or a region growing
// elsewhere never moves a region. Sizes come from a power-of-two bucket of
// primary file counts: area means "how many files live here", not
// complexity, importance or quality.

import type { AtlasEntitySummary, AtlasLayout, AtlasRegion } from "../../../shared/atlas.ts";

/** World units: one grid cell, and the gap between cells. */
export const CELL = 300;
export const GAP = 28;
/** Capabilities sit in a grid this wide; areas inside a capability in a narrower one. */
export const TOP_WIDTH = 4;
export const NESTED_WIDTH = 3;
/** Inner padding of an expanded region, and the band its title takes. */
const PAD = 12;
const HEADER = 34;

export interface Territory {
  /** Every drawn cell, parents before children. */
  cells: TerritoryCell[];
  byId: Map<string, TerritoryCell>;
  width: number;
  height: number;
}

export interface TerritoryCell {
  id: string;
  entity: AtlasEntitySummary;
  /** 0: overview region; 1: its child; 2: a grandchild. */
  depth: number;
  parent: string | null;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Structural groups (unclassified, concepts, …) aren't capabilities. */
  structural: boolean;
  /** Changed in the snapshot being shown. */
  changed: boolean;
}

/** Children loaded for an expanded region, in API order. */
export type Expanded = ReadonlyMap<string, readonly AtlasEntitySummary[]>;

/** How much of its cell a region's size covers: the layout's, or one from its files. */
function fillOf(entity: AtlasEntitySummary): number {
  if (entity.layout) return entity.layout.fill;
  const files = entity.counts.files ?? 0;
  const bucket = files > 0 ? Math.ceil(Math.log2(files + 1)) : 0;
  return Math.min(1, 0.3 + 0.07 * bucket);
}

/** A square of `fill` share of the cell's area, centered in the cell. */
function inCell(x: number, y: number, size: number, fill: number) {
  const side = size * Math.sqrt(Math.max(0.05, Math.min(1, fill)));
  return { x: x + (size - side) / 2, y: y + (size - side) / 2, w: side, h: side };
}

/**
 * Lay out the overview's regions and any expanded children. Capabilities
 * take their stable slot; regions without one (structural groups, or a
 * snapshot from before stable layout) go in a band below, in API order.
 */
export function buildTerritory(
  regions: readonly AtlasRegion[],
  expanded: Expanded,
  snapshotSeq: number,
): Territory {
  const cells: TerritoryCell[] = [];
  const byId = new Map<string, TerritoryCell>();
  const add = (cell: TerritoryCell) => {
    cells.push(cell);
    byId.set(cell.id, cell);
  };
  // A first snapshot has nothing to compare with: everything in it is new, so
  // nothing is marked.
  const changed = (e: AtlasEntitySummary) =>
    snapshotSeq > 1 && e.since !== undefined && e.since === snapshotSeq;

  const placed = regions.filter((r) => r.layout && !r.structural);
  const band = regions.filter((r) => !r.layout || r.structural);
  const step = CELL + GAP;
  let maxRow = -1;
  for (const region of placed) {
    const layout = region.layout as AtlasLayout;
    const col = layout.slot % TOP_WIDTH;
    const row = Math.floor(layout.slot / TOP_WIDTH);
    maxRow = Math.max(maxRow, row);
    add({
      id: region.id,
      entity: region,
      depth: 0,
      parent: null,
      ...inCell(col * step, row * step, CELL, fillOf(region)),
      structural: false,
      changed: changed(region),
    });
  }
  // The structural band: lower, flatter cells, apart from the capabilities.
  const bandTop = (maxRow + 1) * step + (placed.length ? GAP * 2 : 0);
  band.forEach((region, i) => {
    add({
      id: region.id,
      entity: region,
      depth: 0,
      parent: null,
      x: (i % TOP_WIDTH) * step,
      y: bandTop + Math.floor(i / TOP_WIDTH) * (CELL / 2 + GAP),
      w: CELL,
      h: CELL / 2,
      structural: region.structural,
      changed: changed(region),
    });
  });

  // Expanded children nest inside their parent, laid out from their own slots
  // (areas) or, without one, a small grid in API order (files): local either way.
  const nest = (parent: TerritoryCell, depth: number) => {
    const children = expanded.get(parent.id);
    if (!children?.length) return;
    const innerW = parent.w - PAD * 2;
    const innerH = parent.h - PAD - HEADER;
    if (innerW <= 0 || innerH <= 0) return;
    const slotted = children.every((c) => c.layout);
    if (slotted) {
      // Size cells by the rows and columns in use: only this expanded region reflows.
      const slots = children.map((c) => (c.layout as AtlasLayout).slot);
      const rows = Math.max(...slots.map((slot) => Math.floor(slot / NESTED_WIDTH))) + 1;
      const cols =
        rows > 1 ? NESTED_WIDTH : Math.max(...slots.map((slot) => slot % NESTED_WIDTH)) + 1;
      const size = Math.min(innerW / cols, innerH / rows);
      for (const child of children) {
        const layout = child.layout as AtlasLayout;
        const col = layout.slot % NESTED_WIDTH;
        const row = Math.floor(layout.slot / NESTED_WIDTH);
        const cell: TerritoryCell = {
          id: child.id,
          entity: child,
          depth,
          parent: parent.id,
          ...inCell(
            parent.x + PAD + col * size,
            parent.y + HEADER + row * size,
            size,
            fillOf(child),
          ),
          structural: child.structural,
          changed: changed(child),
        };
        add(cell);
        nest(cell, depth + 1);
      }
      return;
    }
    const cols = Math.max(1, Math.ceil(Math.sqrt(children.length * (innerW / innerH))));
    const rows = Math.ceil(children.length / cols);
    const size = Math.min(innerW / cols, innerH / rows);
    children.forEach((child, i) => {
      const gap = size * 0.12;
      const cell: TerritoryCell = {
        id: child.id,
        entity: child,
        depth,
        parent: parent.id,
        x: parent.x + PAD + (i % cols) * size + gap / 2,
        y: parent.y + HEADER + Math.floor(i / cols) * size + gap / 2,
        w: size - gap,
        h: size - gap,
        structural: child.structural,
        changed: changed(child),
      };
      add(cell);
      nest(cell, depth + 1);
    });
  };
  // Only the top-level regions here: nest() appends their children as it goes.
  const regionCount = cells.length;
  for (let i = 0; i < regionCount; i++) nest(cells[i]!, 1);

  let width = 0;
  let height = 0;
  for (const c of cells) {
    width = Math.max(width, c.x + c.w);
    height = Math.max(height, c.y + c.h);
  }
  return { cells, byId, width, height };
}

/** The deepest drawn cell under a world point. */
export function cellAt(territory: Territory, x: number, y: number): TerritoryCell | null {
  let hit: TerritoryCell | null = null;
  for (const c of territory.cells)
    if (x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h)
      if (!hit || c.depth >= hit.depth) hit = c;
  return hit;
}

// ---- loading -------------------------------------------------------------------

export type Load =
  | { state: "loading" }
  | { state: "ready"; items: AtlasEntitySummary[]; next: string | null; total: number | null }
  | { state: "error"; message: string };

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
