// A timeline in Atlas terms (CORE-176): the timeline's knowledge overlay
// (CORE-83, worker/knowledge/overlay.ts) read against a main snapshot, so a
// reviewer sees which capabilities and areas a timeline touches, what it adds
// to each, which capabilities its imports newly reach, and the wiki pages
// about them, instead of a flat list of graph nodes. Types and the contract
// are in shared/atlas.ts ("timeline change understanding").
//
// It reads only what is already stored: the overlay's changes (at most
// MAX_CHANGES), the snapshot's rows for the files they name, one range read
// per new file's folder (at most MAX_FOLDERS), the newest wiki page set and
// main's pages about the changed nodes. No model, no overlay computation: an
// ended overlay stays exactly as it was kept (CORE-139), and reading a live
// one doesn't start one either (the Knowledge tab's overlay route does that).
//
// Placement is main's. A file the timeline changes or removes sits where the
// snapshot put it. Where grouping would put the timeline's files is the
// timeline's regrouping (CORE-186, timelineGrouping.ts), computed when the
// overlay was stored and read here: it places a new file, says where a
// changed one would move, and which touched capabilities would split or
// merge. Without it (not computed yet, or not computable) a new file is
// provisional (the capability most of its folder's files are in, as an
// inference) or unclassified. Nothing is computed here.

import type { Selectable } from "kysely";
import { HTTPException } from "hono/http-exception";
import type { KnowledgeOverlayChange, KnowledgePageSet } from "../../shared/api.ts";
import {
  ATLAS_TIMELINE_REGIONS,
  type AtlasChangeClass,
  type AtlasChangeRef,
  type AtlasMainPageRef,
  type AtlasMainRelation,
  type AtlasSnapshotRef,
  type AtlasTimelineCaveat,
  type AtlasTimelineFile,
  type AtlasTimelinePageRef,
  type AtlasTimelinePlacement,
  type AtlasTimelineRegion,
  type AtlasTimelineRepo,
  type AtlasTimelineWiki,
} from "../../shared/atlas.ts";
import { languageAdapters } from "../../shared/semantic/index.ts";
import type { RepoRow } from "../db.ts";
import { coordinator } from "../knowledge/coordinator.ts";
import { overlayState } from "../knowledge/overlay.ts";
import { listSets } from "../knowledge/pages.ts";
import { knowledgeRepo, timelineKnowledgeSource } from "../knowledge/sources.ts";
import { RepoReader } from "../objects.ts";
import { readTimelineRegrouping, type StoredRegrouping } from "./timelineGrouping.ts";
import { db, type Database } from "../schema.ts";
import type { Timing } from "../timing.ts";

/** New files' folders read for a provisional placement, at most; the rest are unclassified. */
export const MAX_FOLDERS = 50;
/** Import targets resolved to capabilities, at most. */
export const MAX_IMPORT_TARGETS = 1000;
/** Main wiki pages looked up for the changed nodes, at most. */
const MAX_MAIN_PAGES = 200;
/** Ids per `json_each` lookup. */
const CHUNK = 400;
const UNCLASSIFIED = "group:unclassified";

type OverlayRow = Selectable<Database["kg_overlays"]>;

/** What the overlay route would say about the timeline, read without side effects. */
export interface TimelineState {
  ref: string;
  sourceId: string;
  row: OverlayRow | undefined;
  head: string | null;
  headKnown: boolean;
  indexed: string | null;
  running: boolean;
}

/**
 * The stored overlay, the bookmark's tip and main's indexed commit. Null when
 * there's neither a bookmark nor a kept overlay.
 */
export async function readTimelineState(
  env: Env,
  repo: RepoRow,
  ref: string,
  timing: Timing,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<TimelineState | null> {
  const owned = await timelineKnowledgeSource(env, repo.id, ref);
  const row = await db(env.DB)
    .selectFrom("kg_overlays")
    .selectAll()
    .where("repo_id", "=", repo.id)
    .where("source_id", "=", owned?.source_id ?? "canonical")
    .where("ref", "=", ref)
    .executeTakeFirst();
  if (!owned && !row) {
    const orphan = await db(env.DB)
      .selectFrom("kg_overlays")
      .select("source_id")
      .where("repo_id", "=", repo.id)
      .where("ref", "=", ref)
      .executeTakeFirst();
    if (orphan) throw new HTTPException(409, { message: "Timeline source migration required" });
    return null;
  }
  if (!owned && !row?.ended_at)
    throw new HTTPException(409, { message: "Timeline source migration required" });
  const sourceId = owned?.source_id ?? row!.source_id;
  // Ended pre-migration overlays are historical canonical evidence; never read
  // an active canonical timeline bookmark as a substitute for an owned source.
  const physical = await knowledgeRepo(env, repo.id, sourceId);
  if (!physical) return null;
  const reader = new RepoReader(
    env,
    physical.artifacts_name,
    physical.artifacts_remote,
    timing,
    waitUntil,
    owned?.work_ref,
  );
  const [refs, state, status] = await Promise.all([
    owned && !row?.ended_at ? reader.refs().catch(() => null) : null,
    db(env.DB)
      .selectFrom("kg_state")
      .select("indexed_commit")
      .where("repo_id", "=", repo.id)
      .executeTakeFirst(),
    env.AI
      ? coordinator(env, repo.id)
          .status()
          .catch(() => null)
      : null,
  ]);
  await reader.close();
  const head = refs?.branches.find((b) => b.name === owned?.work_ref)?.oid ?? null;
  if (!row && !head) return null;
  return {
    ref,
    sourceId,
    row,
    head,
    headKnown: Boolean(row?.ended_at) || refs !== null,
    indexed: state?.indexed_commit ?? null,
    running: Boolean(status?.overlays[ref]?.running),
  };
}

// ---- reading the snapshot ----------------------------------------------------------

const at = (t: string, n: number) =>
  `${t}.scope = ?1 AND ${t}.from_seq <= ?${n} AND (${t}.to_seq IS NULL OR ${t}.to_seq > ?${n})`;

interface Placed {
  capability: string | null;
  area: string | null;
}

/** Where snapshot `seq` places each of `ids` (files): absent ids aren't in it. */
async function placementsAt(
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

const folderOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * For a folder, the capability (and its commonest area there) holding most of
 * the folder's own files in snapshot `seq`, and how many files it has.
 */
async function folderGuess(
  d1: D1Database,
  scope: string,
  seq: number,
  folder: string,
): Promise<{ capability: string; area: string | null; files: number; of: number } | null> {
  const from = folder ? `file:${folder}/` : "file:";
  // The first id past every `from…` one: the prefix's last character, plus one.
  const to = from.slice(0, -1) + String.fromCharCode(from.charCodeAt(from.length - 1) + 1);
  const rows = await d1
    .prepare(
      `SELECT e.capability, json_extract(e.data, '$.membership.area') AS area, count(*) AS n
       FROM atlas_entities e
       WHERE e.entity_id >= ?2 AND e.entity_id < ?4 AND e.kind = 'file' AND ${at("e", 3)}
         AND instr(substr(e.entity_id, length(?2) + 1), '/') = 0
       GROUP BY e.capability, area`,
    )
    .bind(scope, from, seq, to)
    .all<{ capability: string | null; area: string | null; n: number }>();
  let of = 0;
  const byCapability = new Map<string, { files: number; areas: Map<string | null, number> }>();
  for (const r of rows.results) {
    const n = Number(r.n);
    of += n;
    if (!r.capability) continue;
    const entry = byCapability.get(r.capability) ?? { files: 0, areas: new Map() };
    entry.files += n;
    entry.areas.set(r.area, (entry.areas.get(r.area) ?? 0) + n);
    byCapability.set(r.capability, entry);
  }
  const best = [...byCapability].sort(
    (a, b) => b[1].files - a[1].files || (a[0] < b[0] ? -1 : 1),
  )[0];
  if (!best) return null;
  const area = [...best[1].areas].sort(
    (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])),
  )[0]![0];
  return { capability: best[0], area, files: best[1].files, of };
}

/** Names (and a capability's concept ids) of `ids` in snapshot `seq`. */
async function regionsAt(
  d1: D1Database,
  scope: string,
  seq: number,
  ids: string[],
): Promise<Map<string, { name: string; concepts: string[] }>> {
  const out = new Map<string, { name: string; concepts: string[] }>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const rows = await d1
      .prepare(
        `SELECT e.entity_id, e.name, json_extract(e.data, '$.concepts') AS concepts
         FROM atlas_entities e
         WHERE e.entity_id IN (SELECT value FROM json_each(?2)) AND ${at("e", 3)}`,
      )
      .bind(scope, JSON.stringify(ids.slice(i, i + CHUNK)), seq)
      .all<{ entity_id: string; name: string; concepts: string | null }>();
    for (const r of rows.results) {
      const concepts = r.concepts ? (JSON.parse(r.concepts) as { id?: string }[]) : [];
      out.set(r.entity_id, {
        name: r.name,
        concepts: Array.isArray(concepts)
          ? concepts.flatMap((c) => (typeof c?.id === "string" ? [c.id] : []))
          : [],
      });
    }
  }
  return out;
}

/**
 * Where main commit `commit` sits relative to `snapshot`, for `repoId`: the
 * same commit, or older or newer by the snapshot that projected it. Unknown
 * when no published snapshot was built from it.
 */
export async function mainRelation(
  d1: D1Database,
  scope: string,
  snapshot: AtlasSnapshotRef,
  repoId: string,
  commit: string | null,
): Promise<AtlasMainRelation> {
  if (!commit) return "unknown";
  if (snapshot.vector.find((v) => v.repoId === repoId)?.commit === commit) return "same";
  const row = await d1
    .prepare(
      `SELECT s.seq FROM atlas_snapshots s
       WHERE s.scope = ?1 AND s.status IN ('published', 'expired')
         AND EXISTS (SELECT 1 FROM json_each(s.vector) v
                     WHERE json_extract(v.value, '$.repoId') = ?2
                       AND json_extract(v.value, '$.commit') = ?3)
       ORDER BY s.seq DESC LIMIT 1`,
    )
    .bind(scope, repoId, commit)
    .first<{ seq: number }>();
  if (!row) return "unknown";
  const seq = Number(row.seq);
  return seq === snapshot.seq ? "same" : seq < snapshot.seq ? "older" : "newer";
}

// ---- the timeline in Atlas terms -----------------------------------------------------

const SUMMARY_FIELDS = new Set(["summary", "name", "responsibilities"]);
const SYNTAX = new Set(languageAdapters.flatMap((a) => a.extensions));
const extensionOf = (path: string) =>
  path.includes(".") ? path.slice(path.lastIndexOf(".")).toLowerCase() : "";

function classesOf(change: KnowledgeOverlayChange): AtlasChangeClass[] {
  if (change.change !== "changed" || change.fields.includes("blob")) return ["source"];
  if (change.fields.some((f) => SUMMARY_FIELDS.has(f))) return ["summary"];
  return ["other"];
}

export interface TimelineView {
  repo: AtlasTimelineRepo;
  /** Every file record, by path. */
  files: AtlasTimelineFile[];
  regions: AtlasTimelineRegion[];
  regionCount: number;
  wiki: AtlasTimelineWiki | null;
  caveats: AtlasTimelineCaveat[];
  /** The overlay the records come from (null: none stored yet). */
  overlayId: string | null;
}

interface Stats {
  counts?: Record<string, { added: number; changed: number; removed: number }>;
  stored?: number;
  changes?: number;
  historyTruncated?: boolean;
}

/** The timeline's overlay, placed in snapshot `snapshot` of `scope`. */
export async function timelineView(
  d1: D1Database,
  scope: string,
  snapshot: AtlasSnapshotRef,
  repo: RepoRow,
  state: TimelineState,
  knowledgeOn: boolean,
): Promise<TimelineView> {
  const { row } = state;
  const overlayId = row?.overlay_id ?? null;
  const stored: KnowledgeOverlayChange[] = overlayId
    ? (
        await db(d1)
          .selectFrom("kg_overlay_changes")
          .select(["node_id", "kind", "change", "name", "path", "summary", "detail"])
          .where("repo_id", "=", repo.id)
          .where("overlay_id", "=", overlayId)
          .execute()
      ).map((r) => {
        const detail = JSON.parse(r.detail) as Partial<
          Pick<KnowledgeOverlayChange, "fields" | "links">
        >;
        return {
          id: r.node_id,
          kind: r.kind as KnowledgeOverlayChange["kind"],
          change: r.change,
          name: r.name,
          path: r.path,
          summary: r.summary,
          fields: detail.fields ?? [],
          links: detail.links ?? { added: [], removed: [] },
        };
      })
    : [];
  const fileChanges = stored
    .filter((c) => c.kind === "file" && c.path)
    .sort((a, b) => (a.path! < b.path! ? -1 : a.path! > b.path! ? 1 : 0));

  // Placements: main's where the snapshot has the file, else the timeline's
  // regrouping's, else inferred from its folder.
  const seq = snapshot.seq;
  const placed = await placementsAt(
    d1,
    scope,
    seq,
    fileChanges.map((c) => c.id),
  );
  const kept: StoredRegrouping | null = overlayId
    ? await readTimelineRegrouping(d1, repo.id, overlayId)
    : null;
  const regrouped = kept?.state === "computed" ? kept.data : null;
  const proposed = (id: string | null | undefined) => Boolean(id && regrouped?.groups[id]);
  const computed = (id: string) => {
    const r = regrouped?.files[id];
    return r && !placed.has(id) && !proposed(r.capability) ? r : null;
  };
  const unplacedFolders = [
    ...new Set(
      fileChanges
        .filter((c) => !placed.has(c.id) && !regrouped?.files[c.id])
        .map((c) => folderOf(c.path!)),
    ),
  ].sort();
  const guesses = new Map<string, Awaited<ReturnType<typeof folderGuess>>>();
  for (const folder of unplacedFolders.slice(0, MAX_FOLDERS))
    guesses.set(folder, await folderGuess(d1, scope, seq, folder));

  const placementOf = new Map<
    string,
    Omit<AtlasTimelinePlacement, "capability" | "area"> & Placed
  >();
  for (const c of fileChanges) {
    const p = placed.get(c.id);
    const r = computed(c.id);
    if (p)
      placementOf.set(c.id, {
        state: p.capability ? "projected" : "unclassified",
        capability: p.capability,
        area: p.area,
        basis: null,
      });
    else if (r)
      placementOf.set(c.id, {
        state: r.capability ? "computed" : "unclassified",
        capability: r.capability,
        area: r.area,
        basis: null,
      });
    else if (regrouped?.files[c.id])
      // A new file the regrouping puts in a group main doesn't have.
      placementOf.set(c.id, { state: "computed", capability: null, area: null, basis: null });
    else {
      const folder = folderOf(c.path!);
      const guess = guesses.get(folder);
      placementOf.set(
        c.id,
        guess
          ? {
              state: "provisional",
              capability: guess.capability,
              area: guess.area,
              basis: { folder, files: guess.files, of: guess.of },
            }
          : { state: "unclassified", capability: null, area: null, basis: null },
      );
    }
  }

  // Imports the timeline adds or drops, to the capabilities they reach.
  const targets = new Set<string>();
  let importsPartial = false;
  for (const c of fileChanges)
    for (const link of [...c.links.added, ...c.links.removed])
      if (link.kind === "imports" && link.id.startsWith("file:") && !placementOf.has(link.id)) {
        if (targets.size >= MAX_IMPORT_TARGETS) importsPartial = true;
        else targets.add(link.id);
      }
  const targetPlaced = await placementsAt(d1, scope, seq, [...targets]);
  const capabilityOf = (id: string) =>
    placementOf.get(id)?.capability ?? targetPlaced.get(id)?.capability ?? null;

  // Names, and capabilities' concepts for the wiki pages about concepts.
  const ids = new Set<string>();
  for (const p of placementOf.values()) {
    if (p.capability) ids.add(p.capability);
    if (p.area) ids.add(p.area);
  }
  for (const p of targetPlaced.values()) if (p.capability) ids.add(p.capability);
  for (const r of Object.values(regrouped?.files ?? {})) {
    if (r.capability && !proposed(r.capability)) ids.add(r.capability);
    if (r.area) ids.add(r.area);
  }
  for (const r of regrouped?.regions ?? []) {
    ids.add(r.id);
    for (const into of r.into) if (!proposed(into.id)) ids.add(into.id);
  }
  for (const g of Object.values(regrouped?.groups ?? {}))
    for (const from of g.from) ids.add(from.id);
  const named = await regionsAt(d1, scope, seq, [...ids]);
  const ref = (id: string): AtlasChangeRef => ({
    id,
    name: named.get(id)?.name ?? regrouped?.groups[id]?.name ?? null,
  });

  const files: AtlasTimelineFile[] = fileChanges.map((c) => {
    const p = placementOf.get(c.id)!;
    const own = p.capability;
    const reach = (links: KnowledgeOverlayChange["links"]["added"]) => [
      ...new Set(
        links.flatMap((l) => {
          if (l.kind !== "imports") return [];
          const cap = capabilityOf(l.id);
          return cap && cap !== own ? [cap] : [];
        }),
      ),
    ];
    const r = regrouped?.files[c.id];
    const regrouping = r
      ? {
          capability: r.capability
            ? { ...ref(r.capability), proposed: proposed(r.capability) }
            : null,
          area: r.area ? ref(r.area) : null,
          moved: r.moved,
        }
      : null;
    const classes = classesOf(c);
    return {
      id: c.id,
      path: c.path!,
      change: c.change,
      classes: r?.moved ? [...classes, "regrouping" as const] : classes,
      fields: c.change === "changed" ? c.fields : [],
      placement: {
        state: p.state,
        capability: p.capability ? ref(p.capability) : null,
        area: p.area ? ref(p.area) : null,
        basis: p.basis,
      },
      regrouping,
      imports: { added: reach(c.links.added).map(ref), removed: reach(c.links.removed).map(ref) },
    };
  });

  // The capabilities touched: those its files are in (or would form), and
  // those its regrouping wouldn't keep as they are.
  const byRegion = new Map<string, AtlasTimelineFile[]>();
  for (const f of files) {
    const id =
      f.placement.capability?.id ??
      (f.regrouping?.capability?.proposed && f.change === "added"
        ? f.regrouping.capability.id
        : UNCLASSIFIED);
    byRegion.set(id, [...(byRegion.get(id) ?? []), f]);
  }
  for (const r of regrouped?.regions ?? []) if (!byRegion.has(r.id)) byRegion.set(r.id, []);

  // Wiki: the newest timeline page set, and main's pages about changed nodes.
  const [newest] = await listSets(d1, repo.id, state.ref, { limit: 1, sourceId: state.sourceId });
  const nodes = stored.filter((c) => c.kind === "component" || c.kind === "concept");
  const mainRows = nodes.length
    ? await db(d1)
        .selectFrom("wiki_pages")
        .select(["slug", "title", "node_id", "generated_in", "updated_at"])
        .where("repo_id", "=", repo.id)
        .where(
          "node_id",
          "in",
          nodes.slice(0, MAX_MAIN_PAGES).map((n) => n.id),
        )
        .execute()
    : [];
  const relations = new Map<string, AtlasMainRelation>();
  const relationOf = async (commit: string | null) => {
    if (!commit) return "unknown" as const;
    if (!relations.has(commit))
      relations.set(commit, await mainRelation(d1, scope, snapshot, repo.id, commit));
    return relations.get(commit)!;
  };
  const mainPages: AtlasMainPageRef[] = [];
  for (const r of mainRows)
    if (r.node_id)
      mainPages.push({
        slug: r.slug,
        title: r.title,
        nodeId: r.node_id,
        generatedIn: r.generated_in,
        updatedAt: r.updated_at,
        relation: await relationOf(r.generated_in),
      });

  /** The touched capabilities a component or concept is about. */
  const nodePaths = new Map(stored.map((c) => [c.id, c.path]));
  const regionsAbout = (nodeId: string): string[] => {
    if (nodeId.startsWith("concept:")) {
      const out = new Set<string>();
      for (const f of fileChanges)
        if ([...f.links.added, ...f.links.removed].some((l) => l.id === nodeId))
          out.add(placementOf.get(f.id)?.capability ?? UNCLASSIFIED);
      for (const id of byRegion.keys()) if (named.get(id)?.concepts.includes(nodeId)) out.add(id);
      return [...out];
    }
    const dir = nodePaths.get(nodeId);
    if (dir === undefined || dir === null) return [];
    return [
      ...new Set(
        files
          .filter((f) => (dir ? f.path.startsWith(`${dir}/`) : !f.path.includes("/")))
          .map((f) => f.placement.capability?.id ?? UNCLASSIFIED),
      ),
    ];
  };
  const pagesBy = new Map<string, AtlasTimelinePageRef[]>();
  for (const page of newest?.pages ?? [])
    if (page.nodeId)
      for (const id of regionsAbout(page.nodeId))
        pagesBy.set(id, [
          ...(pagesBy.get(id) ?? []),
          {
            slug: page.slug,
            title: page.title,
            set: newest!.key,
            change: page.change,
            outcome: page.outcome,
          },
        ]);
  const mainPagesBy = new Map<string, AtlasMainPageRef[]>();
  for (const page of mainPages)
    for (const id of regionsAbout(page.nodeId))
      mainPagesBy.set(id, [...(mainPagesBy.get(id) ?? []), page]);

  const regions: AtlasTimelineRegion[] = [...byRegion].map(([id, members]) => {
    const tally = { added: 0, changed: 0, removed: 0 };
    const classes = { source: 0, summary: 0, other: 0, regrouping: 0 };
    const areas = new Map<string, AtlasChangeRef>();
    const added = new Map<string, number>();
    const removed = new Map<string, number>();
    for (const f of members) {
      tally[f.change]++;
      for (const cls of f.classes) if (cls in classes) classes[cls as keyof typeof classes]++;
      if (f.placement.area) areas.set(f.placement.area.id, f.placement.area);
      for (const r of f.imports.added) added.set(r.id, (added.get(r.id) ?? 0) + 1);
      for (const r of f.imports.removed) removed.set(r.id, (removed.get(r.id) ?? 0) + 1);
    }
    const top = (m: Map<string, number>) =>
      [...m]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, 5)
        .map(([cap]) => ref(cap));
    const group = regrouped?.groups[id];
    const verdict = regrouped?.regions.find((r) => r.id === id);
    return {
      id,
      name: id === UNCLASSIFIED ? "Unclassified" : (named.get(id)?.name ?? group?.name ?? id),
      proposed: group
        ? {
            change: group.change,
            from: group.from.map((f) => ({ ...ref(f.id), share: f.share })),
          }
        : null,
      regrouping: verdict
        ? {
            change: verdict.change,
            into: verdict.into.map((t) => ({
              ...ref(t.id),
              share: t.share,
              proposed: proposed(t.id),
            })),
          }
        : null,
      files: tally,
      provisional: members.filter((f) => f.placement.state === "provisional").length,
      classes,
      areas: [...areas.values()].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? "")),
      imports: { added: top(added), removed: top(removed) },
      pages: pagesBy.get(id) ?? [],
      mainPages: mainPagesBy.get(id) ?? [],
    };
  });
  const size = (r: AtlasTimelineRegion) => r.files.added + r.files.changed + r.files.removed;
  regions.sort(
    (a, b) =>
      Number(a.id === UNCLASSIFIED) - Number(b.id === UNCLASSIFIED) ||
      size(b) - size(a) ||
      a.name.localeCompare(b.name),
  );

  // The repository's part, each value as known.
  const projectionCommit = snapshot.vector.find((v) => v.repoId === repo.id)?.commit ?? null;
  const base = await relationOf(row?.base_commit ?? null);
  const repoPart = factsOf(repo, state, knowledgeOn, {
    projectionCommit,
    base,
    stored: stored.length,
    paths: files.map((f) => f.path),
  });

  const caveats: AtlasTimelineCaveat[] = [regroupingCaveat(kept, snapshot)];
  if (row?.base_commit && base !== "same")
    caveats.push({
      code: "base",
      relation: base,
      baseCommit: row.base_commit,
      projectionCommit,
    });
  if (repoPart.changes.stored < repoPart.changes.total)
    caveats.push({
      code: "truncated",
      stored: repoPart.changes.stored,
      total: repoPart.changes.total,
    });
  if (overlayId && repoPart.mergeBaseState !== "found")
    caveats.push({
      code: "merge-base",
      state: repoPart.mergeBaseState === "truncated" ? "truncated" : "none",
    });
  if (!row?.ended_at && row?.head_commit && state.head && row.head_commit !== state.head)
    caveats.push({ code: "behind", commit: row.head_commit, head: state.head });
  if (importsPartial || unplacedFolders.length > MAX_FOLDERS)
    caveats.push({ code: "imports-partial" });

  const wiki: AtlasTimelineWiki | null = newest ? await wikiOf(newest, relationOf) : null;
  return {
    repo: repoPart,
    files,
    regions: regions.slice(0, ATLAS_TIMELINE_REGIONS),
    regionCount: regions.length,
    wiki,
    caveats,
    overlayId,
  };
}

/** What the view can say about the timeline's regrouping. */
function regroupingCaveat(
  kept: StoredRegrouping | null,
  snapshot: AtlasSnapshotRef,
): AtlasTimelineCaveat {
  if (!kept) return { code: "regrouping", state: "pending" };
  if (kept.state !== "computed" || !kept.data || kept.seq === null)
    return {
      code: "regrouping",
      state: "skipped",
      reason: kept.reason === "too-large" || kept.reason === "no-snapshot" ? kept.reason : "error",
    };
  return {
    code: "regrouping",
    state: "computed",
    seq: kept.seq,
    basis: kept.seq === snapshot.seq ? "same" : kept.seq < snapshot.seq ? "older" : "newer",
    capabilities: kept.data.neighbourhood.capabilities.length,
    files: kept.data.neighbourhood.files,
  };
}

/** One repository's part in a timeline, each value as known. */
function factsOf(
  repo: RepoRow,
  state: TimelineState,
  knowledgeOn: boolean,
  read: {
    projectionCommit: string | null;
    base: AtlasMainRelation;
    /** Changes read from the overlay. */
    stored: number;
    /** The changed files' paths. */
    paths: string[];
  },
): AtlasTimelineRepo {
  const { row } = state;
  const stats = JSON.parse(row?.stats ?? "{}") as Stats;
  const counts = stats.counts ?? {};
  const total =
    stats.changes ?? Object.values(counts).reduce((n, k) => n + k.added + k.changed + k.removed, 0);
  return {
    repoId: repo.id,
    sourceId: state.sourceId,
    owner: repo.owner_slug,
    name: repo.name,
    ref: state.ref.replace(/^refs\/heads\//, ""),
    state:
      !row && !knowledgeOn
        ? "unavailable"
        : overlayState(row, state.head, state.indexed, state.running),
    head: state.head,
    headKnown: state.headKnown,
    commit: row?.head_commit ?? null,
    baseCommit: row?.base_commit ?? null,
    mergeBase: row?.merge_base ?? null,
    mergeBaseState: row?.merge_base
      ? "found"
      : stats.historyTruncated
        ? "truncated"
        : row?.overlay_id
          ? "none"
          : "unknown",
    updatedAt: row?.updated_at ?? null,
    error: row?.status === "failed" ? row.error : null,
    ended: row?.ended_at
      ? { reason: row.ended_reason ?? "ended", at: row.ended_at, removedAt: row.removed_at }
      : null,
    projectionCommit: read.projectionCommit,
    base: read.base,
    changes: { total, stored: stats.stored ?? read.stored },
    coverage: {
      files: read.paths.length,
      syntax: read.paths.filter((path) => SYNTAX.has(extensionOf(path))).length,
    },
    graph: Object.fromEntries(Object.entries(counts).filter(([kind]) => kind !== "file")),
  };
}

/**
 * A repository's part in a timeline where it has no Atlas to place files in
 * (a workspace member without a published map): the facts, no placements.
 */
export async function timelineFacts(
  d1: D1Database,
  repo: RepoRow,
  state: TimelineState,
  knowledgeOn: boolean,
): Promise<AtlasTimelineRepo> {
  const overlayId = state.row?.overlay_id ?? null;
  const paths = overlayId
    ? (
        await db(d1)
          .selectFrom("kg_overlay_changes")
          .select("path")
          .where("repo_id", "=", repo.id)
          .where("overlay_id", "=", overlayId)
          .where("kind", "=", "file")
          .execute()
      ).flatMap((r) => (r.path ? [r.path] : []))
    : [];
  return factsOf(repo, state, knowledgeOn, {
    projectionCommit: null,
    base: "unknown",
    stored: paths.length,
    paths,
  });
}

/** A repository with neither the timeline's bookmark nor a kept overlay of it. */
export function timelineAbsent(
  repo: Pick<RepoRow, "id" | "owner_slug" | "name">,
  ref: string,
  projectionCommit: string | null,
): AtlasTimelineRepo {
  return {
    repoId: repo.id,
    sourceId: null,
    owner: repo.owner_slug,
    name: repo.name,
    ref: ref.replace(/^refs\/heads\//, ""),
    state: "none",
    head: null,
    headKnown: true,
    commit: null,
    baseCommit: null,
    mergeBase: null,
    mergeBaseState: "unknown",
    updatedAt: null,
    error: null,
    ended: null,
    projectionCommit,
    base: "unknown",
    changes: { total: 0, stored: 0 },
    coverage: { files: 0, syntax: 0 },
    graph: {},
  };
}

async function wikiOf(
  set: KnowledgePageSet,
  relationOf: (commit: string | null) => Promise<AtlasMainRelation>,
): Promise<AtlasTimelineWiki> {
  return {
    key: set.key,
    sourceId: set.sourceId,
    checkpoint: set.checkpoint,
    commit: set.commit,
    baseCommit: set.baseCommit,
    base: await relationOf(set.baseCommit),
    state: set.state,
    finishedAt: set.finishedAt,
    pages: set.pages.length,
  };
}
