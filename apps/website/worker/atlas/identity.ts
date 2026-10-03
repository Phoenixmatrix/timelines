// Stable capability identity, lineage and layout slots (CORE-165).
//
// Grouping (grouping.ts) recomputes capabilities from scratch on every build,
// so its ids can't be the public ones: a shifted anchor would rename an
// unchanged capability. Each build reconciles the new groups against the
// previous snapshot's capabilities by primary membership instead:
//
// - A new group keeps a prior id only on a unique reciprocal match with more
//   than half of both sides in common. Ties break by overlap, then size, then
//   id; ambiguous continuity is never pretended.
// - Any other group gets a new opaque id, derived from the scope, the snapshot
//   and its anchor so a retried Workflow step reuses it, never from its title
//   or its whole member set. It records the prior capabilities it came from:
//   a split or a merge.
// - A prior capability with no continuation is retired with its successors,
//   so an old link can say where its members went (or that they're gone).
//
// Layout: every region gets a slot in a fixed-width grid under its parent.
// Continuing regions keep their slot and new ones take the lowest free slot,
// so a region appearing, growing or leaving never moves another one. Size is
// shown inside the cell from a bucket of its primary file count, which
// doesn't depend on any other region either.

/** Overlap needed on BOTH sides to keep an id. */
export const KEEP_OVERLAP = 0.5;
/** Overlap with a prior capability that makes it a recorded predecessor. */
export const LINEAGE_OVERLAP = 0.2;
/** Grid widths: slot k sits at column k % width, row floor(k / width). */
export const GRID_WIDTH = { top: 4, nested: 3 } as const;

export interface PriorGroup {
  id: string;
  members: string[];
  slot: number | null;
}

export interface NextGroup {
  /** The grouping pass's own id (anchor-derived, not public). */
  key: string;
  members: string[];
}

export interface Lineage {
  /** Prior ids this group continues from, with the share of each it took. */
  predecessors: { id: string; share: number }[];
  /** kept: same id; split, merge or new otherwise. */
  change: "kept" | "split" | "merge" | "new";
}

export interface Retired {
  id: string;
  successors: { id: string; share: number }[];
  /** split: its members went to several; merged: into one; removed: nowhere. */
  change: "split" | "merged" | "removed";
}

export interface Reconciled {
  /** grouping key -> public id */
  ids: Map<string, string>;
  /** public id -> slot in its parent's grid */
  slots: Map<string, number>;
  lineage: Map<string, Lineage>;
  retired: Retired[];
}

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Match `next` groups to `prior` ones by primary membership. `mint(key)` makes
 * the opaque id for a group that doesn't continue one.
 */
export function reconcile(
  prior: PriorGroup[],
  next: NextGroup[],
  mint: (key: string) => string,
): Reconciled {
  const priorOf = new Map<string, string>();
  for (const p of prior) for (const m of p.members) priorOf.set(m, p.id);
  const size = new Map(prior.map((p) => [p.id, p.members.length]));

  // overlap[next key][prior id] = shared members
  const overlap = new Map<string, Map<string, number>>();
  for (const n of next) {
    const counts = new Map<string, number>();
    for (const m of n.members) {
      const p = priorOf.get(m);
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    overlap.set(n.key, counts);
  }
  const nextSize = new Map(next.map((n) => [n.key, n.members.length]));

  // Best counterpart on each side, by overlap, then size, then id.
  const bestPriorOf = new Map<string, string>();
  for (const n of next) {
    const ranked = [...overlap.get(n.key)!].sort(
      (a, b) => b[1] - a[1] || (size.get(b[0]) ?? 0) - (size.get(a[0]) ?? 0) || byId(a[0], b[0]),
    );
    if (ranked[0]) bestPriorOf.set(n.key, ranked[0][0]);
  }
  const bestNextOf = new Map<string, string>();
  for (const p of prior) {
    let best: [string, number] | null = null;
    for (const n of next) {
      const shared = overlap.get(n.key)!.get(p.id) ?? 0;
      if (!shared) continue;
      if (
        !best ||
        shared > best[1] ||
        (shared === best[1] &&
          ((nextSize.get(n.key) ?? 0) > (nextSize.get(best[0]) ?? 0) ||
            ((nextSize.get(n.key) ?? 0) === (nextSize.get(best[0]) ?? 0) &&
              byId(n.key, best[0]) < 0)))
      )
        best = [n.key, shared];
    }
    if (best) bestNextOf.set(p.id, best[0]);
  }

  const ids = new Map<string, string>();
  const lineage = new Map<string, Lineage>();
  const kept = new Set<string>();
  for (const n of [...next].sort((a, b) => byId(a.key, b.key))) {
    const p = bestPriorOf.get(n.key);
    const shared = p ? (overlap.get(n.key)!.get(p) ?? 0) : 0;
    const reciprocal = p !== undefined && bestNextOf.get(p) === n.key;
    if (
      p &&
      reciprocal &&
      !kept.has(p) &&
      shared > KEEP_OVERLAP * (size.get(p) ?? 0) &&
      shared > KEEP_OVERLAP * n.members.length
    ) {
      ids.set(n.key, p);
      kept.add(p);
      lineage.set(p, { predecessors: [{ id: p, share: 1 }], change: "kept" });
    }
  }
  for (const n of next) {
    if (ids.has(n.key)) continue;
    const id = mint(n.key);
    ids.set(n.key, id);
    const predecessors = [...overlap.get(n.key)!]
      .filter(([p, shared]) => shared >= LINEAGE_OVERLAP * (size.get(p) ?? 1))
      .sort((a, b) => b[1] - a[1] || byId(a[0], b[0]))
      .map(([p, shared]) => ({ id: p, share: round(shared / (size.get(p) ?? 1)) }));
    lineage.set(id, {
      predecessors,
      change: predecessors.length > 1 ? "merge" : predecessors.length === 1 ? "split" : "new",
    });
  }

  // Retired: prior ids no group continues.
  const retired: Retired[] = [];
  for (const p of [...prior].sort((a, b) => byId(a.id, b.id))) {
    if (kept.has(p.id)) continue;
    const successors = next
      .map((n) => ({ id: ids.get(n.key)!, shared: overlap.get(n.key)!.get(p.id) ?? 0 }))
      .filter((s) => s.shared > 0)
      .sort((a, b) => b.shared - a.shared || byId(a.id, b.id))
      .map((s) => ({ id: s.id, share: round(s.shared / Math.max(1, p.members.length)) }));
    retired.push({
      id: p.id,
      successors,
      change: successors.length > 1 ? "split" : successors.length === 1 ? "merged" : "removed",
    });
  }

  // Slots: continuing ids keep theirs; new ones take the lowest free slot,
  // in a stable order (largest first, then id).
  const slots = new Map<string, number>();
  const taken = new Set<number>();
  for (const p of prior)
    if (kept.has(p.id) && p.slot !== null && !taken.has(p.slot)) {
      slots.set(p.id, p.slot);
      taken.add(p.slot);
    }
  const unslotted = next
    .map((n) => ids.get(n.key)!)
    .filter((id) => !slots.has(id))
    .sort(
      (a, b) =>
        (nextSize.get(keyOf(ids, b)) ?? 0) - (nextSize.get(keyOf(ids, a)) ?? 0) || byId(a, b),
    );
  let free = 0;
  for (const id of unslotted) {
    while (taken.has(free)) free++;
    slots.set(id, free);
    taken.add(free);
  }
  return { ids, slots, lineage, retired };
}

function keyOf(ids: Map<string, string>, id: string): string {
  for (const [key, value] of ids) if (value === id) return key;
  return id;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** A region's cell in its parent's grid, and how much of the cell its size fills. */
export function cell(slot: number, files: number, width: number) {
  // Size buckets (powers of two) keep small changes from resizing anything.
  const bucket = files > 0 ? Math.ceil(Math.log2(files + 1)) : 0;
  return {
    slot,
    col: slot % width,
    row: Math.floor(slot / width),
    bucket,
    fill: Math.min(1, 0.3 + 0.07 * bucket),
  };
}

/** The most recent retirement of `id` in `scope` at or before snapshot `seq`. */
export async function lineageOf(
  d1: D1Database,
  scope: string,
  id: string,
  seq: number,
): Promise<{
  id: string;
  kind: string;
  name: string;
  retiredSeq: number;
  change: "split" | "merged" | "removed";
  successors: { id: string; share: number }[];
} | null> {
  const row = await d1
    .prepare(
      `SELECT entity_id, kind, name, retired_seq, change, successors FROM atlas_lineage
       WHERE scope = ? AND entity_id = ? AND retired_seq <= ? ORDER BY retired_seq DESC LIMIT 1`,
    )
    .bind(scope, id, seq)
    .first<{
      entity_id: string;
      kind: string;
      name: string;
      retired_seq: number;
      change: string;
      successors: string;
    }>();
  if (!row) return null;
  return {
    id: row.entity_id,
    kind: row.kind,
    name: row.name,
    retiredSeq: Number(row.retired_seq),
    change: row.change as "split" | "merged" | "removed",
    successors: JSON.parse(row.successors) as { id: string; share: number }[],
  };
}
