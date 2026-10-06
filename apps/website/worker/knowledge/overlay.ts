// Knowledge overlays (CORE-83): each timeline's graph diff against main.
//
// Every push to an owned timeline work source recomputes that timeline's
// overlay; its logical timeline ref is a display/storage key, never a canonical Git ref.
// Main's graph, concepts and wiki are never written. An overlay is:
//
//   1. the files the timeline changed: its tree against the merge base with
//      main's indexed commit, so work main did since the fork doesn't read as
//      the timeline undoing it;
//   2. main's indexed snapshot with those changes applied;
//   3. both graphs built in memory from cached analyses, main's concept model
//      and main's stored syntheses (so only the timeline's own changes differ),
//      then diffed node by node.
//
// The only model calls are file analyses for blobs nothing has analyzed yet,
// cached by blob like a build's, so the same blobs cost nothing when the
// timeline lands. No concept alignment, synthesis, indexing or wiki: a concept
// the timeline introduces shows as added under its own name, unaligned.
//
// When a work source is archived (the timeline landed or was abandoned), its last
// overlay is kept read-only and late workflow publications are fenced in D1.

import type {
  KnowledgeOverlayChange,
  KnowledgeOverlayEndReason,
  KnowledgeOverlaySummary,
  OverlayLink,
} from "../../shared/api.ts";
import { timelineSlugOf, type TimelineStatus } from "../../shared/timelines.ts";
import type { Selectable } from "kysely";
import { db, nowIso, type Database } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";
import type { FileAnalysis, FileToAnalyze } from "./analyze.ts";
import { loadAnalyses } from "./analyze.ts";
import { loadConceptModel } from "./concepts.ts";
import {
  buildGraph,
  loadSnapshot,
  storedSyntheses,
  type BuiltGraph,
  type GraphNode,
  type SnapshotFile,
  type Syntheses,
} from "./graph.ts";
import { runBatched, type Statement } from "./util.ts";
import { dropTimelineRegrouping, storeTimelineRegrouping } from "../atlas/timelineGrouping.ts";

/** Commits read looking for the merge base before comparing trees directly. */
export const MAX_HISTORY_READS = 2000;
/** Changes stored per overlay; a timeline that rewrites more reports `truncated`. */
export const MAX_CHANGES = 2000;
/** Links listed per changed node. */
const MAX_LINKS = 40;
/** Overlays in flight per repository; the rest wait for one to finish. */
export const MAX_OVERLAYS = 3;

/** Kinds an overlay reports. Directories and the repository node only echo their files. */
const REPORTED: readonly GraphNode["kind"][] = [
  "component",
  "concept",
  "file",
  "symbol",
  "package",
];

/** `refs/heads/timeline/<slug>` from `timeline/<slug>` or the full name; null if it isn't one. */
export function overlayRef(ref: string): string | null {
  const full = ref.startsWith("refs/heads/") ? ref : `refs/heads/${ref}`;
  return timelineSlugOf(full) ? full : null;
}

// ---- history and trees ------------------------------------------------------

interface CommitReader {
  commit(oid: string): Promise<ArtifactsCommitMetadata | null>;
}

interface TreeReader {
  tree(oid: string): Promise<ArtifactsTreeEntry[] | null>;
}

const SIDE_A = 1;
const SIDE_B = 2;

/**
 * The newest commit both `a` and `b` reach, found as git does: both sides are
 * painted in committer-date order until a commit carries both colors. Null
 * when they share no history, or `truncated` when it took too many reads.
 */
export async function mergeBase(
  reader: CommitReader,
  a: string,
  b: string,
  max = MAX_HISTORY_READS,
): Promise<{ base: string | null; truncated: boolean }> {
  if (a === b) return { base: a, truncated: false };
  const flags = new Map<string, number>();
  const loaded = new Map<string, ArtifactsCommitMetadata>();
  // Oldest first, so pop() takes the newest.
  const queue: ArtifactsCommitMetadata[] = [];
  const paint = async (oid: string, flag: number) => {
    const had = flags.get(oid) ?? 0;
    if ((had & flag) === flag) return;
    flags.set(oid, had | flag);
    let commit = loaded.get(oid);
    if (!commit) {
      const read = await reader.commit(oid);
      if (!read) return;
      loaded.set(oid, (commit = read));
    }
    let at = queue.length;
    while (at > 0 && queue[at - 1]!.committedAt > commit.committedAt) at--;
    queue.splice(at, 0, commit);
  };
  await paint(a, SIDE_A);
  await paint(b, SIDE_B);
  let reads = 0;
  while (queue.length) {
    const commit = queue.pop()!;
    const flag = flags.get(commit.hash)!;
    if (flag === (SIDE_A | SIDE_B)) return { base: commit.hash, truncated: false };
    if (reads++ >= max) return { base: null, truncated: true };
    for (const parent of commit.parents) await paint(parent, flag);
  }
  return { base: null, truncated: false };
}

/** A path whose content differs between two trees. */
export interface FileChange {
  path: string;
  /** The new blob; null when the path was deleted. */
  blob: string | null;
  /** The old blob; null when the path was added. */
  before: string | null;
  mode: string;
}

const isFile = (entry: ArtifactsTreeEntry) => entry.type === "blob" || entry.type === "exec";

/** Files that differ between two trees, skipping subtrees whose ids match. */
export async function diffTrees(
  reader: TreeReader,
  before: string | null,
  after: string | null,
  prefix = "",
): Promise<FileChange[]> {
  if (before === after) return [];
  const read = async (oid: string | null) => {
    if (!oid) return new Map<string, ArtifactsTreeEntry>();
    const entries = await reader.tree(oid);
    if (!entries) throw new Error(`Tree ${oid} not found`);
    return new Map(entries.map((e) => [e.name, e]));
  };
  const [old, now] = await Promise.all([read(before), read(after)]);
  const out: FileChange[] = [];
  for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const o = old.get(name);
    const n = now.get(name);
    const path = prefix ? `${prefix}/${name}` : name;
    const oTree = o?.type === "tree" ? o.hash : null;
    const nTree = n?.type === "tree" ? n.hash : null;
    if (oTree !== nTree) out.push(...(await diffTrees(reader, oTree, nTree, path)));
    const oBlob = o && isFile(o) ? o.hash : null;
    const nBlob = n && isFile(n) ? n.hash : null;
    if (oBlob !== nBlob) out.push({ path, blob: nBlob, before: oBlob, mode: (n ?? o)!.mode });
  }
  return out.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
}

/** Main's snapshot with the timeline's file changes applied. */
export function applyChanges(files: SnapshotFile[], changes: FileChange[]): SnapshotFile[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const change of changes) {
    if (change.blob)
      byPath.set(change.path, { path: change.path, blob: change.blob, mode: change.mode });
    else byPath.delete(change.path);
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Changed files whose content nothing has analyzed yet, with main's blob for cheap reuse. */
export function toAnalyze(
  changes: FileChange[],
  main: SnapshotFile[],
  known: Map<string, FileAnalysis>,
): FileToAnalyze[] {
  const previous = new Map(main.map((f) => [f.path, f.blob]));
  const seen = new Set<string>();
  const out: FileToAnalyze[] = [];
  for (const change of changes) {
    if (!change.blob || known.has(change.blob) || seen.has(change.blob)) continue;
    seen.add(change.blob);
    out.push({ path: change.path, blob: change.blob, previousBlob: previous.get(change.path) });
  }
  return out;
}

// ---- graph diff -------------------------------------------------------------

/** What a node is, minus what moves with unrelated edits (a symbol's line). */
function comparable(node: GraphNode): Record<string, unknown> {
  const data = { ...node.data };
  if (node.kind === "symbol") delete data.line;
  return { name: node.name, path: node.path, summary: node.summary, ...data };
}

function changedFields(before: GraphNode, after: GraphNode): string[] {
  const a = comparable(before);
  const b = comparable(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]))
    .sort();
}

/** Outgoing links per reported node: kind + target, weights ignored. */
function linksOf(graph: BuiltGraph, reported: Set<string>): Map<string, Map<string, OverlayLink>> {
  const out = new Map<string, Map<string, OverlayLink>>();
  for (const edge of graph.edges) {
    if (!reported.has(edge.src)) continue;
    const links = out.get(edge.src) ?? new Map<string, OverlayLink>();
    links.set(`${edge.kind}\u0000${edge.dst}`, { id: edge.dst, kind: edge.kind });
    out.set(edge.src, links);
  }
  return out;
}

const KIND_RANK = new Map(REPORTED.map((kind, i) => [kind, i]));

/** The nodes `head` adds, changes or removes compared with `base`. */
export function diffGraphs(base: BuiltGraph, head: BuiltGraph): KnowledgeOverlayChange[] {
  const kinds = new Set<string>(REPORTED);
  const baseNodes = new Map(base.nodes.filter((n) => kinds.has(n.kind)).map((n) => [n.id, n]));
  const headNodes = new Map(head.nodes.filter((n) => kinds.has(n.kind)).map((n) => [n.id, n]));
  const baseLinks = linksOf(base, new Set(baseNodes.keys()));
  const headLinks = linksOf(head, new Set(headNodes.keys()));
  const none = new Map<string, OverlayLink>();
  const out: KnowledgeOverlayChange[] = [];
  const entry = (
    node: GraphNode,
    change: KnowledgeOverlayChange["change"],
    fields: string[],
    added: OverlayLink[],
    removed: OverlayLink[],
  ): KnowledgeOverlayChange => ({
    id: node.id,
    kind: node.kind,
    change,
    name: node.name,
    path: node.path,
    summary: node.summary,
    fields,
    links: { added: added.slice(0, MAX_LINKS), removed: removed.slice(0, MAX_LINKS) },
  });
  for (const [id, node] of headNodes) {
    const before = baseNodes.get(id);
    const now = headLinks.get(id) ?? none;
    const then = baseLinks.get(id) ?? none;
    const added = [...now].filter(([k]) => !then.has(k)).map(([, l]) => l);
    const removed = [...then].filter(([k]) => !now.has(k)).map(([, l]) => l);
    if (!before) {
      out.push(entry(node, "added", [], added, []));
      continue;
    }
    const fields = changedFields(before, node);
    if (added.length || removed.length) fields.push("links");
    if (fields.length) out.push(entry(node, "changed", fields, added, removed));
  }
  for (const [id, node] of baseNodes) {
    if (!headNodes.has(id)) out.push(entry(node, "removed", [], [], []));
  }
  return out.sort(
    (a, b) =>
      KIND_RANK.get(a.kind)! - KIND_RANK.get(b.kind)! ||
      (a.path ?? "").localeCompare(b.path ?? "") ||
      a.name.localeCompare(b.name),
  );
}

export function countChanges(changes: KnowledgeOverlayChange[]): KnowledgeOverlaySummary["counts"] {
  const counts: KnowledgeOverlaySummary["counts"] = {};
  for (const c of changes) {
    const row = (counts[c.kind] ??= { added: 0, changed: 0, removed: 0 });
    row[c.change] += 1;
  }
  return counts;
}

// ---- computing and storing --------------------------------------------------

export interface OverlayPlan {
  /** Main's indexed commit the overlay is measured against. */
  base: string;
  mergeBase: string | null;
  historyTruncated: boolean;
  changes: FileChange[];
}

/** The files a timeline commit changed relative to its merge base with main's indexed commit. */
export async function planOverlay(
  reader: CommitReader & TreeReader,
  commit: string,
  base: string,
  logicalBase?: { commit: string; tree: string },
): Promise<OverlayPlan> {
  const found = logicalBase
    ? { base: logicalBase.commit, truncated: false }
    : await mergeBase(reader, commit, base);
  const head = await reader.commit(commit);
  if (!head) throw new Error(`Commit ${commit} not found`);
  // No shared history found: compare with main's indexed tree directly.
  const from = logicalBase
    ? { treeHash: logicalBase.tree }
    : await reader.commit(found.base ?? base);
  if (!from) throw new Error(`Commit ${found.base ?? base} not found`);
  return {
    base,
    mergeBase: found.base,
    historyTruncated: found.truncated,
    changes: await diffTrees(reader, from.treeHash, head.treeHash),
  };
}

/** What an overlay compares: main's indexed graph, and main with a timeline's changes. */
export interface OverlayGraphs {
  main: BuiltGraph;
  timeline: BuiltGraph;
  /** Main's indexed files with the timeline's changes applied. */
  files: SnapshotFile[];
  analyses: Map<string, FileAnalysis>;
  /** Main's stored syntheses: only the timeline's own changes differ. */
  syntheses: Syntheses;
}

/**
 * Both graphs, built in memory from cached analyses, main's concept model and
 * main's stored syntheses. Nothing is written and no model is called.
 */
export async function overlayGraphs(
  d1: D1Database,
  repo: { id: string; full_name: string },
  changes: FileChange[],
  snapshot = "current",
): Promise<OverlayGraphs> {
  const main = await loadSnapshot(d1, repo.id, snapshot);
  const files = applyChanges(main, changes);
  const analyses = await loadAnalyses(d1, [
    ...main.map((f) => f.blob),
    ...changes.flatMap((c) => (c.blob ? [c.blob] : [])),
  ]);
  const [concepts, syntheses] = await Promise.all([
    loadConceptModel(d1, repo.id),
    storedSyntheses(d1, repo.id),
  ]);
  const mainGraph = buildGraph(repo.full_name, main, analyses, syntheses, concepts);
  return {
    main: mainGraph,
    // Main's topic labels: a timeline's spelling only names topics main lacks.
    timeline: buildGraph(repo.full_name, files, analyses, syntheses, concepts, {
      topicNames: mainGraph.topicNames,
    }),
    files,
    analyses,
    syntheses,
  };
}

/**
 * Diff main's indexed graph against main plus the timeline's changes, and
 * store it as the timeline's current overlay. Returns the base it measured.
 */
export async function computeOverlay(
  d1: D1Database,
  repo: { id: string; full_name: string },
  ref: string,
  overlayId: string,
  commit: string,
  plan: OverlayPlan,
  stats: Record<string, unknown>,
  snapshot?: string,
): Promise<{ base: string | null; counts: KnowledgeOverlaySummary["counts"]; stored: number }> {
  // The commit first, then its files: if a main build lands in between, the
  // coordinator sees a newer base and computes the overlay again.
  const state = await db(d1)
    .selectFrom("kg_state")
    .select("indexed_commit")
    .where("repo_id", "=", repo.id)
    .executeTakeFirst();
  const base = snapshot ? plan.base : (state?.indexed_commit ?? null);
  const graphs = await overlayGraphs(d1, repo, plan.changes, snapshot);
  const changes = diffGraphs(graphs.main, graphs.timeline);
  const stored = await storeOverlay(
    d1,
    repo.id,
    ref,
    overlayId,
    commit,
    base,
    plan,
    changes,
    stats,
  );
  // How grouping would place the timeline's files, kept with the overlay
  // (CORE-186): from the graphs already in memory, never on browse.
  if (stored.kept) await storeTimelineRegrouping(d1, repo.id, overlayId, graphs, changes);
  return stored;
}

/**
 * Store a timeline's diff as its current overlay: its first MAX_CHANGES
 * changes, then the pointer to them, then drop the previous ones. An ended
 * overlay is read-only: a late run leaves it as it was (and stores nothing).
 */
export async function storeOverlay(
  d1: D1Database,
  repoId: string,
  ref: string,
  overlayId: string,
  commit: string,
  base: string | null,
  plan: Pick<OverlayPlan, "mergeBase" | "historyTruncated" | "changes">,
  changes: KnowledgeOverlayChange[],
  stats: Record<string, unknown>,
): Promise<{
  base: string | null;
  counts: KnowledgeOverlaySummary["counts"];
  stored: number;
  /** It's the timeline's overlay now (false: the overlay had ended, so nothing was kept). */
  kept: boolean;
}> {
  const counts = countChanges(changes);
  const sourceId = typeof stats.sourceId === "string" ? stats.sourceId : "canonical";
  const kept = changes.slice(0, MAX_CHANGES);
  const k = db(d1);
  const published = await k
    .selectFrom("kg_overlays")
    .select(["overlay_id", "ended_at"])
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .where("ref", "=", ref)
    .executeTakeFirst();
  // A step replay after publication must not delete the snapshot readers already use.
  // In particular, archiving between publication and the workflow acknowledgement
  // leaves that exact snapshot immutable even when the same workflow retries.
  if (published?.ended_at) return { base, counts, stored: 0, kept: false };
  if (published?.overlay_id === overlayId) return { base, counts, stored: kept.length, kept: true };
  const statements: Statement[] = [
    // A retried step starts over.
    k
      .deleteFrom("kg_overlay_changes")
      .where("repo_id", "=", repoId)
      .where("overlay_id", "=", overlayId),
    ...kept.map((c) =>
      k.insertInto("kg_overlay_changes").values({
        repo_id: repoId,
        overlay_id: overlayId,
        node_id: c.id,
        kind: c.kind,
        change: c.change,
        name: c.name,
        path: c.path,
        summary: c.summary,
        detail: JSON.stringify({ fields: c.fields, links: c.links }),
      }),
    ),
  ];
  await runBatched(d1, statements);
  const allStats = {
    ...stats,
    filesChanged: plan.changes.length,
    historyTruncated: plan.historyTruncated || undefined,
    counts,
    changes: changes.length,
    stored: kept.length,
  };
  const previous = await k
    .selectFrom("kg_overlays")
    .select("overlay_id")
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .where("ref", "=", ref)
    .executeTakeFirst();
  // Point at the new changes, then drop the old ones: readers never see half.
  const pointed = await k
    .insertInto("kg_overlays")
    .values({
      repo_id: repoId,
      source_id: typeof stats.sourceId === "string" ? stats.sourceId : "canonical",
      ref,
      overlay_id: overlayId,
      head_commit: commit,
      base_commit: base,
      merge_base: plan.mergeBase,
      stats: JSON.stringify(allStats),
      updated_at: nowIso(),
      status: "succeeded",
      attempted_commit: commit,
      error: null,
    })
    .onConflict((oc) =>
      oc
        .columns(["repo_id", "source_id", "ref"])
        .doUpdateSet((eb) => ({
          overlay_id: eb.ref("excluded.overlay_id"),
          source_id: eb.ref("excluded.source_id"),
          head_commit: eb.ref("excluded.head_commit"),
          base_commit: eb.ref("excluded.base_commit"),
          merge_base: eb.ref("excluded.merge_base"),
          stats: eb.ref("excluded.stats"),
          updated_at: eb.ref("excluded.updated_at"),
          status: eb.ref("excluded.status"),
          attempted_commit: eb.ref("excluded.attempted_commit"),
          error: eb.ref("excluded.error"),
        }))
        // An ended overlay is read-only: a late run leaves it as it was.
        .where("kg_overlays.ended_at", "is", null),
    )
    .returning("overlay_id")
    .executeTakeFirst();
  if (!pointed) {
    await k
      .deleteFrom("kg_overlay_changes")
      .where("repo_id", "=", repoId)
      .where("overlay_id", "=", overlayId)
      .execute();
    return { base, counts, stored: 0, kept: false };
  }
  if (previous?.overlay_id && previous.overlay_id !== overlayId) {
    await k
      .deleteFrom("kg_overlay_changes")
      .where("repo_id", "=", repoId)
      .where("overlay_id", "=", previous.overlay_id)
      .execute();
    // Its regrouping (CORE-186) goes with it.
    await dropTimelineRegrouping(d1, repoId, previous.overlay_id);
  }
  return { base, counts, stored: kept.length, kept: true };
}

/**
 * Where one timeline's overlay stands, from its stored row (if any), the
 * bookmark's tip now, main's indexed commit and a running computation.
 */
export function overlayState(
  stored: Selectable<Database["kg_overlays"]> | undefined,
  head: string | null,
  indexed: string | null,
  running: boolean,
): KnowledgeOverlaySummary["state"] {
  // Ended overlays are kept as they were; nothing computes them again.
  if (stored?.ended_at) return "ended";
  if (!indexed) return "waiting";
  if (running) return "building";
  if (stored?.status === "failed" && stored.attempted_commit === head) return "failed";
  if (stored?.head_commit === head && stored?.base_commit === indexed) return "up-to-date";
  return "queued";
}

/** Record a failed attempt, keeping the last good overlay's changes. */
export async function overlayFailed(
  d1: D1Database,
  repoId: string,
  ref: string,
  commit: string,
  error: string,
  sourceId = "canonical",
) {
  await db(d1)
    .insertInto("kg_overlays")
    .values({
      repo_id: repoId,
      source_id: sourceId,
      ref,
      status: "failed",
      attempted_commit: commit,
      error: error.slice(0, 2000),
      updated_at: nowIso(),
    })
    .onConflict((oc) =>
      oc
        .columns(["repo_id", "source_id", "ref"])
        .doUpdateSet((eb) => ({
          status: eb.ref("excluded.status"),
          attempted_commit: eb.ref("excluded.attempted_commit"),
          error: eb.ref("excluded.error"),
        }))
        .where("kg_overlays.ended_at", "is", null),
    )
    .execute();
}

/** Why a timeline's overlay ended, from its status; null while the timeline goes on. */
export function endReason(
  status: TimelineStatus | null | undefined,
): "landed" | "abandoned" | null {
  return status === "landed" || status === "abandoned" ? status : null;
}

/**
 * Whether the timeline behind a bookmark has landed or been abandoned, from
 * its record in the account's tracker; null when it goes on, has no record,
 * or the tracker can't be reached.
 */
export async function timelineEnd(
  env: Env,
  ownerId: string,
  ref: string,
): Promise<"landed" | "abandoned" | null> {
  const slug = timelineSlugOf(ref);
  if (!slug) return null;
  try {
    const reply = await trackerObject(env, ownerId).timeline(slug, 0, 1);
    return reply.ok ? endReason(reply.value.timeline.status) : null;
  } catch (error) {
    console.warn("Knowledge: looking up a timeline failed", { slug, error });
    return null;
  }
}

/**
 * The bookmarks are gone: keep each last overlay, read-only, with why it
 * ended. A bookmark that never had an overlay leaves nothing behind.
 */
export async function endOverlays(
  d1: D1Database,
  repoId: string,
  reasons: Map<string, KnowledgeOverlayEndReason>,
) {
  if (!reasons.size) return;
  const k = db(d1);
  const at = nowIso();
  await runBatched(d1, [
    ...[...reasons].map(([ref, reason]) =>
      k
        .updateTable("kg_overlays")
        .set({ ended_at: at, ended_reason: reason })
        .where("repo_id", "=", repoId)
        .where("ref", "=", ref)
        .where("overlay_id", "is not", null)
        .where("ended_at", "is", null),
    ),
    ...[...reasons.keys()].map((ref) =>
      k
        .deleteFrom("kg_overlays")
        .where("repo_id", "=", repoId)
        .where("ref", "=", ref)
        .where("overlay_id", "is", null),
    ),
  ]);
}

/** The repository's ended overlays, by bookmark, with why each ended. */
export async function endedOverlays(
  d1: D1Database,
  repoId: string,
): Promise<Map<string, KnowledgeOverlayEndReason>> {
  const rows = await db(d1)
    .selectFrom("kg_overlays")
    .select(["ref", "ended_reason"])
    .where("repo_id", "=", repoId)
    .where("source_id", "!=", "canonical")
    .where("ended_at", "is not", null)
    .execute();
  return new Map(rows.map((r) => [r.ref, r.ended_reason ?? "ended"]));
}

/** Record a later answer about why an overlay ended. */
export async function setEndReason(
  d1: D1Database,
  repoId: string,
  ref: string,
  reason: "landed" | "abandoned",
) {
  await db(d1)
    .updateTable("kg_overlays")
    .set({ ended_reason: reason })
    .where("repo_id", "=", repoId)
    .where("ref", "=", ref)
    .where("ended_at", "is not", null)
    .execute();
}

/**
 * A bookmark is back for a timeline the tracker never said had ended (it was
 * deleted by hand, or isn't a tracked timeline): its overlay is live again.
 */
export async function reopenOverlay(
  d1: D1Database,
  repoId: string,
  ref: string,
  sourceId = "canonical",
) {
  await db(d1)
    .updateTable("kg_overlays")
    // Live again. If retention removed its changes (CORE-201), forget the
    // commit they described so the overlay is computed afresh.
    .set((eb) => ({
      ended_at: null,
      ended_reason: null,
      removed_at: null,
      head_commit: eb
        .case()
        .when("removed_at", "is not", null)
        .then(null)
        .else(eb.ref("head_commit"))
        .end(),
    }))
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .where("ref", "=", ref)
    .where("ended_reason", "=", "ended")
    .execute();
}

// ---- scheduling (the coordinator's state) ------------------------------------

export interface OverlayRun {
  buildId: string;
  sourceId?: string;
  /** The timeline commit it covers. */
  commit: string;
  /** Main's indexed commit when it started. */
  base: string;
  startedAt: number;
}

export interface OverlayState {
  running: OverlayRun | null;
  /** What the last finished attempt covered; a scan skips a bookmark still there. */
  done: { commit: string; base: string | null; sourceId?: string } | null;
  retries: number;
  lastError: string | null;
  /** The bookmark's latest tip and when this coordinator first saw it (CORE-238's quiet period). */
  seen?: { commit: string; at: number } | null;
}

/** When the overlay scan waits for a timeline's pushes to pause (CORE-238). */
export interface OverlayQuiet {
  now: number;
  /** The quiet period; 0 starts overlays right away. */
  ms: number;
  /** Bookmarks a checkpoint wants now, quiet or not. */
  now_refs?: Set<string>;
}

/**
 * Which timeline bookmarks need an overlay now: those whose tip or main's
 * indexed commit moved since their last one, a few at a time; and which
 * bookmarks are gone. Nothing starts before main has a graph to compare with.
 */
export function scanOverlays(
  overlays: Record<string, OverlayState>,
  tips: Map<string, string>,
  indexed: string | null,
  max = MAX_OVERLAYS,
  quiet: OverlayQuiet = { now: 0, ms: 0 },
): {
  gone: string[];
  start: [string, string][];
  deferred: boolean;
  /** Tips first seen in this scan, to remember with when. */
  seen: [string, string][];
  /** When the earliest bookmark still in its quiet period is due; null if none. */
  wakeAt: number | null;
} {
  const gone = Object.keys(overlays).filter((ref) => !tips.has(ref) && !overlays[ref]!.running);
  const start: [string, string][] = [];
  const seen: [string, string][] = [];
  let wakeAt: number | null = null;
  let deferred = false;
  if (!indexed) return { gone, start, deferred, seen, wakeAt };
  let inFlight = Object.values(overlays).filter((o) => o.running).length;
  for (const [ref, commit] of tips) {
    const overlay = overlays[ref];
    if (overlay?.running) continue;
    if (overlay?.done?.commit === commit && overlay.done.base === indexed) continue;
    // A moved tip waits until the timeline's pushes pause, unless a checkpoint wants it now.
    if (quiet.ms > 0 && overlay?.done?.commit !== commit && !quiet.now_refs?.has(ref)) {
      const since = overlay?.seen?.commit === commit ? overlay.seen.at : quiet.now;
      if (overlay?.seen?.commit !== commit) seen.push([ref, commit]);
      if (quiet.now - since < quiet.ms) {
        const due = since + quiet.ms;
        wakeAt = wakeAt === null ? due : Math.min(wakeAt, due);
        continue;
      }
    }
    if (inFlight >= max) {
      deferred = true;
      continue;
    }
    start.push([ref, commit]);
    inFlight += 1;
  }
  return { gone, start, deferred, seen, wakeAt };
}
