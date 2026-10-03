// How grouping would place a timeline's files (CORE-186): a bounded,
// per-timeline Atlas regrouping, computed when the timeline's knowledge
// overlay is stored and kept with it.
//
// Main's grouping (grouping.ts) runs over the whole repository on every main
// build. A timeline changes a few files, so this reruns it only over the
// capabilities the timeline touches: the neighbourhood is every file main's
// snapshot places in a capability holding a changed or removed file, or one a
// changed file now imports or is imported by, plus the timeline's new files
// (at most MAX_REGROUP_CAPABILITIES capabilities and MAX_REGROUP_FILES files;
// beyond that it isn't computed, and says so). Its inputs are the graphs the
// overlay already built in memory (main's, and main with the timeline's
// changes), so nothing is extracted again and no model is called.
//
// Grouping a part of the graph isn't grouping all of it, so the timeline's
// grouping is never compared with main's directly. Main's neighbourhood is
// grouped the same way first (the baseline) and matched to main's
// capabilities; the timeline's groups are matched to the baseline's. The
// matching is identity's (identity.ts `reconcile`: a unique reciprocal match
// with more than half of both sides in common keeps a capability's id), so a
// difference is the timeline's changes, not the cut:
//
// - a file's computed capability is main's when its timeline group continues
//   one; otherwise it's a group main doesn't have (a split, a merge or new),
//   named from its concepts as main's grouping names an unnamed capability;
// - a changed file `moved` when that differs from where the baseline puts it;
// - a capability the timeline would split, merge away or empty is retired in
//   the matching, with where its files would go.
//
// Stored per overlay (atlas_timeline_regroupings, by overlay id) and dropped
// with it: a push computes a new overlay, and with it a new regrouping; an
// ended overlay keeps its own. Reading a timeline (timeline.ts) only reads it.

import type { BuiltGraph } from "../knowledge/graph.ts";
import type { KnowledgeOverlayChange } from "../../shared/api.ts";
import { currentSnapshot, repoScope } from "./projection.ts";
import { GROUPING_VERSION, groupCapabilities, type GroupingInput } from "./grouping.ts";
import { reconcile, type PriorGroup } from "./identity.ts";

/** Bump when what's computed or stored changes. */
export const REGROUP_VERSION = 1;
/** Capabilities a timeline's neighbourhood may span; more isn't computed. */
export const MAX_REGROUP_CAPABILITIES = 16;
/** Files a timeline's neighbourhood may hold; more isn't computed. */
export const MAX_REGROUP_FILES = 3000;
/** Ids per `json_each` lookup. */
const CHUNK = 400;

/** Where the timeline's grouping puts one changed file. */
export interface RegroupedFile {
  /** A main capability id, a proposed group's id (in `groups`), or null: unclassified. */
  capability: string | null;
  /** A main area id it would continue, if any. */
  area: string | null;
  /** A changed file the timeline's grouping puts somewhere else than main's neighbourhood does. */
  moved: boolean;
}

/** A group the timeline's grouping makes that main doesn't have. */
export interface ProposedGroup {
  name: string;
  files: number;
  change: "split" | "merge" | "new";
  /** Main capabilities its files come from, with the share of each. */
  from: { id: string; share: number }[];
}

/** A main capability the timeline's grouping wouldn't keep as it is. */
export interface RegroupedRegion {
  id: string;
  change: "split" | "merged" | "removed";
  /** Where its files would go: main capabilities or proposed groups, with shares. */
  into: { id: string; share: number }[];
}

export interface Regrouping {
  /** The capabilities grouped again, and how many files they hold with the timeline's new ones. */
  neighbourhood: { capabilities: string[]; files: number };
  files: Record<string, RegroupedFile>;
  groups: Record<string, ProposedGroup>;
  regions: RegroupedRegion[];
}

export type RegroupSkip = "no-snapshot" | "too-large" | "error";

const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The grouping input for `files`, from a graph built in memory. */
export function inputFrom(graph: BuiltGraph, files: ReadonlySet<string>): GroupingInput {
  const units: string[] = [];
  const conceptNames = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.kind === "concept") conceptNames.set(node.id, node.name);
    // Only analyzed files are units, as in main's grouping.
    else if (node.kind === "file" && files.has(node.id) && !node.data.pending && !node.data.skipped)
      units.push(node.id);
  }
  const unit = new Set(units);
  const imports: GroupingInput["imports"] = [];
  const mentions: GroupingInput["mentions"] = [];
  for (const e of graph.edges) {
    if (e.kind === "imports" && unit.has(e.src) && unit.has(e.dst))
      imports.push({ src: e.src, dst: e.dst });
    else if (e.kind === "mentions" && unit.has(e.src))
      mentions.push({ file: e.src, concept: e.dst });
  }
  return { files: units, imports, mentions, conceptNames };
}

interface Placed {
  capability: string | null;
  area: string | null;
}

/** Group members by a key, keyless members left out. */
function groupsOf(members: Iterable<[string, string | null]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, key] of members) {
    if (!key) continue;
    const list = out.get(key);
    if (list) list.push(file);
    else out.set(key, [file]);
  }
  return out;
}

const asPrior = (groups: Map<string, string[]>): PriorGroup[] =>
  [...groups]
    .sort((a, b) => byId(a[0], b[0]))
    .map(([id, members]) => ({ id, members, slot: null }));

/**
 * Regroup a neighbourhood: `main` and `timeline` are grouping inputs over the
 * same files (the timeline's with its changes), `placed` is main's snapshot
 * placement of the neighbourhood's files, `changed` the timeline's changed
 * and added files (removed ones have no placement to compute).
 */
export function regroup(
  main: GroupingInput,
  timeline: GroupingInput,
  placed: ReadonlyMap<string, Placed>,
  changed: readonly string[],
): Omit<Regrouping, "neighbourhood"> {
  const baseline = groupCapabilities(main);
  const next = groupCapabilities(timeline);
  const capOf = (g: typeof baseline) =>
    new Map(g.members.map((m) => [m.file, { capability: m.capability, area: m.area }] as const));
  const baseMember = capOf(baseline);
  const nextMember = capOf(next);

  // Baseline groups as main's capabilities (and areas) where they continue one.
  const mainCaps = groupsOf([...placed].map(([f, p]) => [f, p.capability]));
  const mainAreas = groupsOf([...placed].map(([f, p]) => [f, p.area]));
  const baseCaps = groupsOf([...baseMember].map(([f, m]) => [f, m.capability]));
  const baseAreas = groupsOf([...baseMember].map(([f, m]) => [f, m.area]));
  const asMain = reconcile(
    asPrior(mainCaps),
    [...baseCaps].map(([key, members]) => ({ key, members })),
    (key) => `baseline:${key}`,
  ).ids;
  const asMainArea = reconcile(
    asPrior(mainAreas),
    [...baseAreas].map(([key, members]) => ({ key, members })),
    (key) => `baseline:${key}`,
  ).ids;

  // The timeline's groups against the baseline's (named as main's).
  const baseByMain = new Map<string, string[]>();
  for (const [key, members] of baseCaps) baseByMain.set(asMain.get(key)!, members);
  const baseAreaByMain = new Map<string, string[]>();
  for (const [key, members] of baseAreas) baseAreaByMain.set(asMainArea.get(key)!, members);
  const nextCaps = groupsOf([...nextMember].map(([f, m]) => [f, m.capability]));
  const nextAreas = groupsOf([...nextMember].map(([f, m]) => [f, m.area]));
  const caps = reconcile(
    asPrior(baseByMain),
    [...nextCaps].map(([key, members]) => ({ key, members })),
    (key) => `proposed:${key}`,
  );
  const areas = reconcile(
    asPrior(baseAreaByMain),
    [...nextAreas].map(([key, members]) => ({ key, members })),
    (key) => `proposed:${key}`,
  ).ids;
  const isMain = (id: string | undefined) =>
    id !== undefined && !id.startsWith("proposed:") && !id.startsWith("baseline:");

  const files: Record<string, RegroupedFile> = {};
  for (const file of [...changed].sort(byId)) {
    const m = nextMember.get(file);
    if (!m) continue;
    const capability = m.capability ? caps.ids.get(m.capability)! : null;
    const area = m.area ? areas.get(m.area) : undefined;
    const before = baseMember.get(file);
    const was = before?.capability ? asMain.get(before.capability)! : null;
    files[file] = {
      capability: capability?.startsWith("baseline:") ? null : capability,
      area: isMain(area) ? area! : null,
      moved: before !== undefined && was !== capability,
    };
  }

  const names = new Map(next.capabilities.map((c) => [c.id, c.name]));
  const groups: Record<string, ProposedGroup> = {};
  for (const [key, members] of nextCaps) {
    const id = caps.ids.get(key)!;
    if (!id.startsWith("proposed:")) continue;
    const lineage = caps.lineage.get(id);
    groups[id] = {
      name: names.get(key) ?? key,
      files: members.length,
      change: lineage?.change === "merge" || lineage?.change === "split" ? lineage.change : "new",
      from: (lineage?.predecessors ?? []).filter((p) => isMain(p.id)),
    };
  }
  const regions: RegroupedRegion[] = caps.retired
    .filter((r) => isMain(r.id))
    .map((r) => ({
      id: r.id,
      change: r.change,
      into: r.successors.filter((s) => isMain(s.id) || s.id.startsWith("proposed:")),
    }));
  return { files, groups, regions };
}

// ---- computing it for an overlay, and keeping it -------------------------------------

const at = (t: string, n: number) =>
  `${t}.scope = ?1 AND ${t}.from_seq <= ?${n} AND (${t}.to_seq IS NULL OR ${t}.to_seq > ?${n})`;

async function placementsOf(
  d1: D1Database,
  scope: string,
  seq: number,
  ids: string[],
): Promise<Map<string, Placed>> {
  const out = new Map<string, Placed>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await d1
      .prepare(
        `SELECT e.entity_id, e.capability, json_extract(e.data, '$.membership.area') AS area
         FROM atlas_entities e
         WHERE e.entity_id IN (SELECT value FROM json_each(?2)) AND ${at("e", 3)}`,
      )
      .bind(scope, JSON.stringify(ids.slice(i, i + CHUNK)), seq)
      .all<{ entity_id: string; capability: string | null; area: string | null }>();
    for (const r of rows.results)
      out.set(r.entity_id, { capability: r.capability ?? null, area: r.area ?? null });
  }
  return out;
}

/** Every file the snapshot places in `capabilities`, at most `limit` + 1. */
async function filesIn(
  d1: D1Database,
  scope: string,
  seq: number,
  capabilities: string[],
  limit: number,
): Promise<Map<string, Placed>> {
  const rows = await d1
    .prepare(
      `SELECT e.entity_id, e.capability, json_extract(e.data, '$.membership.area') AS area
       FROM atlas_entities e
       WHERE e.capability IN (SELECT value FROM json_each(?2)) AND e.kind = 'file' AND ${at("e", 3)}
       LIMIT ?4`,
    )
    .bind(scope, JSON.stringify(capabilities), seq, limit + 1)
    .all<{ entity_id: string; capability: string; area: string | null }>();
  return new Map(
    rows.results.map((r) => [r.entity_id, { capability: r.capability, area: r.area ?? null }]),
  );
}

/**
 * Compute the timeline's regrouping for a stored overlay and keep it with the
 * overlay. `changes` are the overlay's (diffGraphs of `graphs`). Never throws:
 * a failure is kept as `error`, and the overlay stands without it.
 */
export async function storeTimelineRegrouping(
  d1: D1Database,
  repoId: string,
  overlayId: string,
  graphs: { main: BuiltGraph; timeline: BuiltGraph },
  changes: readonly KnowledgeOverlayChange[],
  limits = { capabilities: MAX_REGROUP_CAPABILITIES, files: MAX_REGROUP_FILES },
): Promise<{ state: "computed" | "skipped"; reason?: RegroupSkip }> {
  const scope = repoScope(repoId);
  const snapshot = await currentSnapshot(d1, scope).catch(() => null);
  const keep = async (
    state: "computed" | "skipped",
    data: Regrouping | null,
    reason: RegroupSkip | null,
  ) => {
    await d1
      .prepare(
        `INSERT INTO atlas_timeline_regroupings
           (repo_id, overlay_id, snapshot_id, seq, version, grouping_version, state, reason, data, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT (repo_id, overlay_id) DO UPDATE SET snapshot_id = excluded.snapshot_id,
           seq = excluded.seq, version = excluded.version, grouping_version = excluded.grouping_version,
           state = excluded.state, reason = excluded.reason, data = excluded.data,
           created_at = excluded.created_at`,
      )
      .bind(
        repoId,
        overlayId,
        snapshot?.id ?? null,
        snapshot?.seq ?? null,
        REGROUP_VERSION,
        GROUPING_VERSION,
        state,
        reason,
        data ? JSON.stringify(data) : null,
        new Date().toISOString(),
      )
      .run();
    return reason ? { state, reason } : { state };
  };
  try {
    if (!snapshot) return await keep("skipped", null, "no-snapshot");
    const files = changes.filter((c) => c.kind === "file");
    const touched = files.map((c) => c.id);
    const added = files.filter((c) => c.change === "added").map((c) => c.id);
    const present = files.filter((c) => c.change !== "removed").map((c) => c.id);

    // Files the changed ones import or are imported by, on the timeline.
    const touchedSet = new Set(touched);
    const linked = new Set<string>();
    for (const e of graphs.timeline.edges)
      if (e.kind === "imports" && e.src.startsWith("file:") && e.dst.startsWith("file:")) {
        if (touchedSet.has(e.src)) linked.add(e.dst);
        if (touchedSet.has(e.dst)) linked.add(e.src);
      }
    const near = await placementsOf(d1, scope, snapshot.seq, [...new Set([...touched, ...linked])]);
    const capabilities = [
      ...new Set([...near.values()].flatMap((p) => (p.capability ? [p.capability] : []))),
    ].sort(byId);
    if (capabilities.length > limits.capabilities) return await keep("skipped", null, "too-large");
    const placed = await filesIn(d1, scope, snapshot.seq, capabilities, limits.files);
    // The changed files themselves, wherever main has them (or doesn't).
    for (const id of touched) {
      const p = near.get(id);
      if (p && !placed.has(id)) placed.set(id, p);
    }
    const all = new Set([...placed.keys(), ...added]);
    if (all.size > limits.files) return await keep("skipped", null, "too-large");

    const result = regroup(
      inputFrom(graphs.main, all),
      inputFrom(graphs.timeline, all),
      placed,
      present,
    );
    return await keep(
      "computed",
      { neighbourhood: { capabilities, files: all.size }, ...result },
      null,
    );
  } catch (error) {
    console.error("timeline regrouping failed", error);
    return keep("skipped", null, "error").catch(() => ({ state: "skipped", reason: "error" }));
  }
}

/** The kept regrouping of an overlay, if any. */
export interface StoredRegrouping {
  snapshotId: string | null;
  seq: number | null;
  state: "computed" | "skipped";
  reason: RegroupSkip | null;
  data: Regrouping | null;
}

export async function readTimelineRegrouping(
  d1: D1Database,
  repoId: string,
  overlayId: string,
): Promise<StoredRegrouping | null> {
  const row = await d1
    .prepare(
      `SELECT snapshot_id, seq, version, state, reason, data FROM atlas_timeline_regroupings
       WHERE repo_id = ? AND overlay_id = ?`,
    )
    .bind(repoId, overlayId)
    .first<{
      snapshot_id: string | null;
      seq: number | null;
      version: number;
      state: "computed" | "skipped";
      reason: RegroupSkip | null;
      data: string | null;
    }>();
  // One kept by an older version of this pass reads as not computed.
  if (!row || Number(row.version) !== REGROUP_VERSION) return null;
  return {
    snapshotId: row.snapshot_id,
    seq: row.seq === null ? null : Number(row.seq),
    state: row.state,
    reason: row.reason,
    data: row.data ? (JSON.parse(row.data) as Regrouping) : null,
  };
}

/** Drop the regrouping kept for an overlay that's gone. */
export function dropTimelineRegrouping(d1: D1Database, repoId: string, overlayId: string) {
  return d1
    .prepare(`DELETE FROM atlas_timeline_regroupings WHERE repo_id = ? AND overlay_id = ?`)
    .bind(repoId, overlayId)
    .run();
}
