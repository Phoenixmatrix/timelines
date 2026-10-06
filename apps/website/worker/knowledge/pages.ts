// Wiki pages for timelines (CORE-84): written when a checkpoint is made, or
// on demand, never on every push (TIMELINES-RESEARCH.md, Decisions). At a
// gate they help review what a timeline adds or changes in components and
// concepts.
//
// A page set belongs to one timeline bookmark and one checkpoint (or, on
// demand, one commit), so asking twice for the same checkpoint is the same
// set. Its pages come from the timeline's graph diff against main, computed
// the way an overlay is (overlay.ts) at the set's own commit:
//
//   - a page per component the timeline adds or changes, the most changed
//     first, at most MAX_COMPONENT_PAGES;
//   - Architecture, when the timeline adds or removes components;
//   - a glossary of the concepts it adds or changes, drawn without a model.
//
// Pages are written by main's wiki code (wiki.ts) from the timeline's graph,
// and stored in kg_page_set_pages, never in wiki_pages. Before writing, a
// page is copied from the timeline's previous set when its inputs are the
// same, or `kept` when main's page still holds (clef decides, as for main's
// wiki); every set stops writing at MAX_SET_TOKENS. Once the timeline's
// overlay has ended (CORE-139) its sets are read-only: none is started, and a
// set still being written stops, keeping what it has.

import type {
  KnowledgeOverlayChange,
  KnowledgePageSet,
  KnowledgeTimelinePageSummary,
} from "../../shared/api.ts";
import { LEGACY_AI_SNAPSHOT, type AiModels } from "../../shared/ai.ts";
import type { WorkflowStep } from "cloudflare:workers";
import { sql } from "kysely";
import { timelineSlugOf } from "../../shared/timelines.ts";
import type { RepoReader } from "../objects.ts";
import { db, nowIso } from "../schema.ts";
import { analyzeFiles, loadAnalyses } from "./analyze.ts";
import type { BuiltGraph, Syntheses, SnapshotFile } from "./graph.ts";
import { countChanges, diffGraphs, overlayGraphs, planOverlay, toAnalyze } from "./overlay.ts";
import type { KnowledgePolicy } from "./policy.ts";
import { chunk, pool, sha256 } from "./util.ts";
import {
  diagramFor,
  glossaryBody,
  isStale,
  pageInputs,
  planPages,
  writePage,
  type GlossaryEntry,
  type PageInputs,
  type PlannedPage,
  type WikiSource,
} from "./wiki.ts";
import { getWorkSource } from "../timelines/sources.ts";
import { releaseKnowledgeBase } from "./source-reader.ts";
import { releaseSourceRoots } from "../retention/work-sources.ts";

/** Component pages per set; the rest are counted as skipped. */
export const MAX_COMPONENT_PAGES = 12;
/** Model tokens one set may spend; pages past it are skipped. */
export const MAX_SET_TOKENS = 80_000;
/** Page sets being written per repository at once; the rest wait their turn. */
export const MAX_PAGE_JOBS = 2;
/** Pages per workflow step: a few model calls, far inside the step timeout. */
export const PAGES_PER_STEP = 3;
/** Timeline changes listed on one page's material. */
const MAX_PAGE_CHANGES = 40;
/** Sets listed per timeline. */
const MAX_SETS = 20;

const WRITER = "t1";

/** The key of an on-demand set at one commit. */
export const commitKey = (commit: string) => `commit:${commit}`;

// ---- choosing pages ------------------------------------------------------------

export interface ChosenPage {
  slug: string;
  change: "added" | "changed";
}

/**
 * The pages a timeline affects, from its graph diff against main: changed and
 * added components (added first, then the most changed), Architecture when
 * components come or go, and the glossary when concepts do or change.
 */
export function choosePages(
  graph: BuiltGraph,
  syntheses: Syntheses,
  diff: KnowledgeOverlayChange[],
  max = MAX_COMPONENT_PAGES,
): { pages: ChosenPage[]; skipped: number } {
  const planned = planPages(graph, syntheses);
  const touched = new Map(
    diff
      .filter((c) => c.kind === "component" && c.change !== "removed")
      .map((c) => [c.id, c.change as "added" | "changed"]),
  );
  const components = planned
    .filter((p) => p.kind === "component" && p.nodeId && touched.has(p.nodeId))
    .map((p) => {
      const files = new Set(p.component?.files ?? []);
      const weight = diff.filter(
        (c) => (c.kind === "file" || c.kind === "symbol") && c.path && files.has(c.path),
      ).length;
      return { page: p, change: touched.get(p.nodeId!)!, weight };
    })
    .sort(
      (a, b) =>
        Number(b.change === "added") - Number(a.change === "added") ||
        b.weight - a.weight ||
        a.page.position - b.page.position,
    );
  const pages: ChosenPage[] = [];
  const reshaped = diff.some(
    (c) => c.kind === "component" && (c.change === "added" || c.change === "removed"),
  );
  if (reshaped) pages.push({ slug: "architecture", change: "changed" });
  pages.push(...components.slice(0, max).map((c) => ({ slug: c.page.slug, change: c.change })));
  if (diff.some((c) => c.kind === "concept")) pages.push({ slug: "glossary", change: "changed" });
  return { pages, skipped: Math.max(0, components.length - max) };
}

/** What the timeline changes inside one page's subject, for its material. */
function changesFor(page: PlannedPage, diff: KnowledgeOverlayChange[]) {
  const files = new Set(page.component?.files ?? []);
  const relevant =
    page.kind === "component"
      ? diff.filter(
          (c) =>
            c.id === page.nodeId ||
            ((c.kind === "file" || c.kind === "symbol") && c.path && files.has(c.path)),
        )
      : diff.filter((c) => c.kind === "component");
  return relevant.slice(0, MAX_PAGE_CHANGES).map((c) => ({
    change: c.change,
    kind: c.kind,
    name: c.name,
    path: c.path,
    summary: c.summary,
  }));
}

/** The glossary of concepts a timeline adds or changes, and the ones it stops using. */
export function timelineGlossary(graph: BuiltGraph, diff: KnowledgeOverlayChange[]): PageInputs {
  const touched = new Map(diff.filter((c) => c.kind === "concept").map((c) => [c.id, c]));
  const nameOf = new Map(
    graph.nodes.filter((n) => n.kind === "concept").map((n) => [n.id, n.name] as const),
  );
  const concepts: (GlossaryEntry & { change: string })[] = graph.nodes
    .filter((n) => n.kind === "concept" && touched.has(n.id))
    .map((n) => ({
      name: n.name,
      change: touched.get(n.id)!.change,
      definition:
        n.summary ||
        "New in this timeline. It gets a definition when the timeline lands and main's knowledge build aligns it.",
      aliases: (n.data.aliases as string[] | undefined) ?? [],
      partOf: graph.edges
        .filter((e) => e.kind === "part_of" && e.src === n.id && nameOf.has(e.dst))
        .map((e) => nameOf.get(e.dst)!)
        .sort(),
      includes: graph.edges
        .filter((e) => e.kind === "part_of" && e.dst === n.id && nameOf.has(e.src))
        .map((e) => nameOf.get(e.src)!)
        .sort(),
      files: graph.conceptFiles.get(n.id.slice(8)) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const removed = diff
    .filter((c) => c.kind === "concept" && c.change === "removed")
    .map((c) => c.name)
    .sort();
  return { writer: WRITER, kind: "glossary", concepts, removed };
}

function timelineGlossaryBody(inputs: PageInputs): string {
  const concepts = inputs.concepts as GlossaryEntry[];
  const removed = inputs.removed as string[];
  const parts = concepts.length ? [glossaryBody(inputs)] : [];
  if (removed.length) parts.push(`**No longer used in this timeline:** ${removed.join(", ")}.`);
  return parts.join("\n\n") || "This timeline adds or changes no concepts.";
}

/** Asked of the writer on a timeline's pages, after main's instruction. */
const ALSO =
  "The material describes the code as a timeline (a parallel line of work not yet on main) leaves it; " +
  "`timeline_changes` lists what the timeline adds, changes and removes compared with main. Describe the " +
  "code as the timeline has it, and end with a ## What this timeline changes section that explains those " +
  "changes for a reviewer.";

// ---- writing --------------------------------------------------------------------

export interface PageSetRef {
  repoId: string;
  ref: string;
  key: string;
  sourceId?: string;
}

export interface PageSetStats {
  written: number;
  kept: number;
  copied: number;
  unchanged: number;
  /** Over the token budget. */
  skipped: number;
  failed: number;
  tokens: number;
  errors: string[];
}

export const emptyStats = (): PageSetStats => ({
  written: 0,
  kept: 0,
  copied: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  tokens: 0,
  errors: [],
});

export function addStats(into: PageSetStats, from: PageSetStats) {
  into.written += from.written;
  into.kept += from.kept;
  into.copied += from.copied;
  into.unchanged += from.unchanged;
  into.skipped += from.skipped;
  into.failed += from.failed;
  into.tokens += from.tokens;
  into.errors.push(...from.errors.slice(0, Math.max(0, 3 - into.errors.length)));
}

/**
 * Settle the given pages of a set from the timeline's graph (`source`, at the
 * set's commit) and its diff against main. Each page is saved when settled,
 * so a retried step only redoes the ones it hadn't finished.
 */
export async function writeSetPages(
  env: Env,
  models: AiModels,
  set: PageSetRef,
  source: WikiSource,
  diff: KnowledgeOverlayChange[],
  chosen: ChosenPage[],
  budget = MAX_SET_TOKENS,
  provenance?: { baseCommit: string; changedPaths: ReadonlySet<string> },
): Promise<PageSetStats> {
  const stats = emptyStats();
  const k = db(env.DB);
  const pages = planPages(source.graph, source.syntheses);
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const changedNodes = new Set(diff.map((c) => c.id));
  const slugs = chosen.map((c) => c.slug);
  const [own, main] = await Promise.all([
    k
      .selectFrom("kg_page_set_pages")
      .select(["slug", "inputs_hash", "tokens"])
      .where("repo_id", "=", set.repoId)
      .where("source_id", "=", set.sourceId ?? "canonical")
      .where("ref", "=", set.ref)
      .where("set_key", "=", set.key)
      .execute(),
    slugs.length
      ? k
          .selectFrom("wiki_pages")
          .select(["slug", "title", "body", "inputs_hash"])
          .where("repo_id", "=", set.repoId)
          .where("slug", "in", slugs)
          .execute()
      : [],
  ]);
  const settled = new Map(own.map((p) => [p.slug, p.inputs_hash]));
  const mainPages = new Map(main.map((p) => [p.slug, p]));
  // Spent by this set so far, a retried step's pages included.
  let spent = own.reduce((n, p) => n + p.tokens, 0);

  const save = (
    page: PlannedPage,
    change: ChosenPage["change"],
    hash: string,
    row: { outcome: "written" | "kept"; body: string; model: string | null; tokens: number },
  ) =>
    k
      .insertInto("kg_page_set_pages")
      .values({
        repo_id: set.repoId,
        source_id: set.sourceId ?? "canonical",
        ref: set.ref,
        set_key: set.key,
        slug: page.slug,
        title: page.title,
        section: page.section,
        position: page.position,
        node_id: page.nodeId,
        kind: page.kind as "component" | "architecture" | "glossary",
        change,
        outcome: row.outcome,
        body: row.body,
        diagram: row.outcome === "written" ? diagramFor(page, source.graph, source.syntheses) : "",
        sources: JSON.stringify(page.component?.files ?? []),
        source_locations: JSON.stringify(
          (page.component?.files ?? []).map((path) => ({
            path,
            sourceId:
              provenance && !provenance.changedPaths.has(path)
                ? "canonical"
                : (set.sourceId ?? "canonical"),
            commit:
              provenance && !provenance.changedPaths.has(path)
                ? provenance.baseCommit
                : source.commit,
          })),
        ),
        inputs_hash: hash,
        model: row.model,
        tokens: row.tokens,
        updated_at: nowIso(),
      })
      .onConflict((oc) =>
        oc.columns(["repo_id", "source_id", "ref", "set_key", "slug"]).doUpdateSet((eb) => ({
          title: eb.ref("excluded.title"),
          section: eb.ref("excluded.section"),
          position: eb.ref("excluded.position"),
          node_id: eb.ref("excluded.node_id"),
          change: eb.ref("excluded.change"),
          outcome: eb.ref("excluded.outcome"),
          body: eb.ref("excluded.body"),
          diagram: eb.ref("excluded.diagram"),
          sources: eb.ref("excluded.sources"),
          source_locations: eb.ref("excluded.source_locations"),
          inputs_hash: eb.ref("excluded.inputs_hash"),
          model: eb.ref("excluded.model"),
          tokens: eb.ref("excluded.tokens"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .execute();

  const settle = async ({ slug, change }: ChosenPage) => {
    const page = bySlug.get(slug);
    if (!page || page.kind === "overview") return;
    if (page.kind === "glossary") {
      const inputs = timelineGlossary(source.graph, diff);
      const hash = await sha256(JSON.stringify(inputs));
      if (settled.get(slug) === hash) return void stats.unchanged++;
      await save(page, change, hash, {
        outcome: "written",
        body: timelineGlossaryBody(inputs),
        model: null,
        tokens: 0,
      });
      stats.written++;
      return;
    }
    const base = await pageInputs(source, page, pages);
    const inputs: PageInputs = { ...base.inputs, timeline_changes: changesFor(page, diff) };
    const hash = await sha256(JSON.stringify(inputs));
    if (settled.get(slug) === hash) return void stats.unchanged++;

    // The timeline's earlier set wrote this page from the same material: reuse it.
    const prior = await k
      .selectFrom("kg_page_set_pages")
      .select(["outcome", "body", "model"])
      .where("repo_id", "=", set.repoId)
      .where("source_id", "=", set.sourceId ?? "canonical")
      .where("ref", "=", set.ref)
      .where("slug", "=", slug)
      .where("inputs_hash", "=", hash)
      .where("set_key", "!=", set.key)
      .orderBy("updated_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (prior) {
      await save(page, change, hash, { ...prior, tokens: 0 });
      stats.copied++;
      return;
    }
    // Main's page still holds: same material, or clef finds the changes don't matter to it.
    const before = mainPages.get(slug);
    if (
      before &&
      (before.inputs_hash === base.hash ||
        !(await isStale(env, models, page, before, changedNodes, source.graph)))
    ) {
      await save(page, change, hash, { outcome: "kept", body: "", model: null, tokens: 0 });
      stats.kept++;
      return;
    }
    if (spent >= budget) return void stats.skipped++;
    const written = await writePage(env, models, page, inputs, ALSO);
    spent += written.tokens;
    await save(page, change, hash, { outcome: "written", ...written });
    stats.written++;
    stats.tokens += written.tokens;
  };

  // One at a time: the budget is checked before each model call.
  await pool(chosen, 1, async (page) => {
    try {
      await settle(page);
    } catch (error) {
      stats.failed++;
      const message = error instanceof Error ? error.message : String(error);
      if (stats.errors.length < 3) stats.errors.push(`${page.slug}: ${message.slice(0, 300)}`);
    }
  });
  return stats;
}

// ---- the queue -------------------------------------------------------------------

export interface PageRequest extends PageSetRef {
  commit: string;
  checkpoint: { id: string; number: number } | null;
  requestedBy: string | null;
}

/** Whether a timeline's overlay has ended: its pages are read-only. */
export async function overlayEnded(
  d1: D1Database,
  repoId: string,
  ref: string,
  sourceId = "canonical",
) {
  const row = await db(d1)
    .selectFrom("kg_overlays")
    .select("ended_at")
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .where("ref", "=", ref)
    .executeTakeFirst();
  return Boolean(row?.ended_at);
}

/**
 * Queue a set unless it exists: the same checkpoint (or commit) is the same
 * set. A failed one is queued again. Returns the set's status, or `ended`
 * when the timeline's overlay has ended and nothing was queued.
 */
export async function queueSet(
  d1: D1Database,
  request: PageRequest,
): Promise<{ status: KnowledgePageSet["state"]; queued: boolean }> {
  const k = db(d1);
  const existing = await k
    .selectFrom("kg_page_sets")
    .select("status")
    .where("repo_id", "=", request.repoId)
    .where("source_id", "=", request.sourceId ?? "canonical")
    .where("ref", "=", request.ref)
    .where("set_key", "=", request.key)
    .executeTakeFirst();
  if (existing && existing.status !== "failed") return { status: existing.status, queued: false };
  if (await overlayEnded(d1, request.repoId, request.ref, request.sourceId))
    return { status: "ended", queued: false };
  if (existing) {
    await k
      .updateTable("kg_page_sets")
      .set({ status: "queued", build_id: null, error: null, finished_at: null })
      .where("repo_id", "=", request.repoId)
      .where("source_id", "=", request.sourceId ?? "canonical")
      .where("ref", "=", request.ref)
      .where("set_key", "=", request.key)
      .where("status", "=", "failed")
      .execute();
    return { status: "queued", queued: true };
  }
  const inserted = await k
    .insertInto("kg_page_sets")
    .values({
      repo_id: request.repoId,
      source_id: request.sourceId ?? "canonical",
      ref: request.ref,
      set_key: request.key,
      checkpoint_id: request.checkpoint?.id ?? null,
      checkpoint_number: request.checkpoint?.number ?? null,
      commit_oid: request.commit,
      status: "queued",
      requested_by: request.requestedBy,
      requested_at: nowIso(),
    })
    .onConflict((oc) => oc.columns(["repo_id", "source_id", "ref", "set_key"]).doNothing())
    .returning("status")
    .executeTakeFirst();
  if (inserted) return { status: "queued", queued: true };
  const current = await k
    .selectFrom("kg_page_sets")
    .select("status")
    .where("repo_id", "=", request.repoId)
    .where("source_id", "=", request.sourceId ?? "canonical")
    .where("ref", "=", request.ref)
    .where("set_key", "=", request.key)
    .executeTakeFirst();
  return { status: current?.status ?? "ended", queued: false };
}

/** A set being written, as the coordinator tracks it. */
export interface PageRun {
  buildId: string;
  ref: string;
  key: string;
  sourceId?: string;
  startedAt: number;
}

/**
 * Which queued sets start now: oldest first, one per timeline bookmark, and
 * at most `max` per repository in flight. `more` when some had to wait.
 */
export function schedulePages(
  running: PageRun[],
  queued: { ref: string; key: string; sourceId?: string }[],
  max = MAX_PAGE_JOBS,
): { start: { ref: string; key: string; sourceId?: string }[]; more: boolean } {
  const busy = new Set(running.map((r) => r.ref));
  let room = max - running.length;
  const start: { ref: string; key: string; sourceId?: string }[] = [];
  let more = false;
  for (const set of queued) {
    if (busy.has(set.ref) || room <= 0) {
      more = true;
      continue;
    }
    busy.add(set.ref);
    start.push(set);
    room -= 1;
  }
  return { start, more };
}

/** Queued sets of a repository, oldest first. */
export async function queuedSets(d1: D1Database, repoId: string, limit = 20) {
  return db(d1)
    .selectFrom("kg_page_sets")
    .select(["ref", "set_key as key", "source_id as sourceId"])
    .where("repo_id", "=", repoId)
    .where("status", "=", "queued")
    .orderBy("requested_at")
    .limit(limit)
    .execute();
}

/** Mark a queued set as being written by `buildId`; false if someone else took it. */
export async function claimSet(
  d1: D1Database,
  set: PageSetRef,
  buildId: string,
  policy: KnowledgePolicy,
) {
  const row = await db(d1)
    .updateTable("kg_page_sets")
    .set({ status: "writing", build_id: buildId, ai_snapshot: JSON.stringify(policy) })
    .where("repo_id", "=", set.repoId)
    .where("source_id", "=", set.sourceId ?? "canonical")
    .where("ref", "=", set.ref)
    .where("set_key", "=", set.key)
    .where("status", "=", "queued")
    .returning("set_key")
    .executeTakeFirst();
  return Boolean(row);
}

/** The set `buildId` is writing, or null when it no longer is (it was retried or closed). */
export async function setFor(d1: D1Database, set: PageSetRef, buildId: string) {
  return (
    (await db(d1)
      .selectFrom("kg_page_sets")
      .selectAll()
      .where("repo_id", "=", set.repoId)
      .where("source_id", "=", set.sourceId ?? "canonical")
      .where("ref", "=", set.ref)
      .where("set_key", "=", set.key)
      .where("build_id", "=", buildId)
      .where("status", "=", "writing")
      .executeTakeFirst()) ?? null
  );
}

/** Merge into a set's stats (and set its base), while `buildId` writes it. */
export async function recordSet(
  d1: D1Database,
  set: PageSetRef,
  buildId: string,
  values: { base?: string; stats: Record<string, unknown> },
) {
  const row = await setFor(d1, set, buildId);
  if (!row) return;
  await db(d1)
    .updateTable("kg_page_sets")
    .set({
      ...(values.base ? { base_commit: values.base } : {}),
      stats: JSON.stringify({ ...JSON.parse(row.stats), ...values.stats }),
    })
    .where("repo_id", "=", set.repoId)
    .where("source_id", "=", set.sourceId ?? "canonical")
    .where("ref", "=", set.ref)
    .where("set_key", "=", set.key)
    .where("build_id", "=", buildId)
    .where("status", "=", "writing")
    .execute();
}

/** Close a set `buildId` was writing: succeeded, failed, or ended with its timeline. */
export async function closeSet(
  d1: D1Database,
  set: PageSetRef,
  buildId: string,
  status: "succeeded" | "failed" | "ended",
  values: { stats?: Record<string, unknown>; error?: string | null } = {},
) {
  const row = await setFor(d1, set, buildId);
  if (!row) return;
  await db(d1)
    .updateTable("kg_page_sets")
    .set({
      status,
      error: values.error?.slice(0, 2000) ?? null,
      stats: JSON.stringify({ ...JSON.parse(row.stats), ...values.stats }),
      finished_at: nowIso(),
    })
    .where("repo_id", "=", set.repoId)
    .where("source_id", "=", set.sourceId ?? "canonical")
    .where("ref", "=", set.ref)
    .where("set_key", "=", set.key)
    .where("build_id", "=", buildId)
    .where("status", "=", "writing")
    .execute();
}

/** A set whose workflow vanished, crashed or ran too long (the coordinator's watchdog). */
export async function abandonSet(d1: D1Database, set: PageSetRef, buildId: string, error: string) {
  await closeSet(d1, set, buildId, "failed", { error });
}

// ---- the workflow -----------------------------------------------------------------

// Model calls already wait out rate limits; step retries cover the rest.
const STEP = {
  retries: { limit: 4, delay: "20 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;
const ANALYZE_BATCH = 32;

/** What the knowledge Workflow lends a page set. */
export interface PageSetDeps<R extends { id: string; full_name: string }> {
  repo(repoId: string, ref: string, sourceId?: string): Promise<R | null>;
  withReader<T>(row: R, work: (reader: RepoReader) => Promise<T>, snapshot?: string): Promise<T>;
  pinBase(repoId: string, commit: string, snapshot: string): Promise<SnapshotFile[]>;
  /** Tell the coordinator the set's run is over. */
  finished(buildId: string): Promise<void>;
}

/**
 * Write one queued page set, as durable steps: plan the timeline's changes at
 * the set's commit (against main's indexed commit, from their merge base),
 * analyze blobs nothing has analyzed (cached by blob, so usually none after
 * the overlay), choose the affected pages, then write them a few per step.
 * Writes only kg_page_sets, kg_page_set_pages and the analysis cache.
 */
export async function runPageSet<R extends { id: string; full_name: string }>(
  env: Env,
  params: {
    repoId: string;
    buildId: string;
    pages: { ref: string; key: string; sourceId?: string };
    policy?: KnowledgePolicy;
  },
  step: WorkflowStep,
  deps: PageSetDeps<R>,
) {
  const { repoId, buildId } = params;
  // Only payloads admitted before account AI settings lack their frozen policy.
  const { models } = params.policy?.ai ?? LEGACY_AI_SNAPSHOT;
  const set: PageSetRef = { repoId, ...params.pages };
  const snapshot = `knowledge:${buildId}`;
  const done = (status: "succeeded" | "failed" | "ended", values = {}) =>
    step.do(`pages-${status}`, STEP, async () => {
      await closeSet(env.DB, set, buildId, status, values);
      await releaseSourceRoots(env, "knowledge-pages-build", buildId);
      await releaseKnowledgeBase(env, repoId, snapshot);
      await deps.finished(buildId);
      return null;
    });
  try {
    const stored = await setFor(env.DB, set, buildId);
    if (!stored) {
      await releaseSourceRoots(env, "knowledge-pages-build", buildId);
      await releaseKnowledgeBase(env, repoId, snapshot);
      await deps.finished(buildId);
      return { status: "gone" };
    }
    const repo = await deps.repo(repoId, set.ref, stored.source_id);
    if (!repo) throw new Error("Repository not found");
    const plan = await step.do("pages-plan", STEP, async () => {
      const row = await setFor(env.DB, set, buildId);
      // Retried or closed meanwhile: nothing to do.
      if (!row) return { state: "gone" as const };
      if (await overlayEnded(env.DB, repoId, set.ref, set.sourceId))
        return { state: "ended" as const };
      const kg = await db(env.DB)
        .selectFrom("kg_state")
        .select("indexed_commit")
        .where("repo_id", "=", repoId)
        .executeTakeFirst();
      if (!kg?.indexed_commit) throw new Error("Main has no knowledge graph yet");
      const base = kg.indexed_commit;
      const work = await getWorkSource(env, repoId, row.source_id);
      if (!work || work.state !== "ready") return { state: "ended" as const };
      const plan = await deps.withReader(repo, (reader) =>
        planOverlay(reader, row.commit_oid, base, {
          commit: work.fork_commit,
          tree: work.fork_tree,
        }),
      );
      const main = await deps.pinBase(repoId, base, snapshot);
      const known = await loadAnalyses(
        env.DB,
        plan.changes.flatMap((c) => (c.blob ? [c.blob] : [])),
      );
      await recordSet(env.DB, set, buildId, {
        base,
        stats: { filesChanged: plan.changes.length },
      });
      return {
        state: "planned" as const,
        base,
        commit: row.commit_oid,
        changes: plan.changes,
        pending: toAnalyze(plan.changes, main, known),
      };
    });
    if (plan.state === "gone") {
      await done("ended");
      return { status: "gone" };
    }
    if (plan.state === "ended") {
      await done("ended");
      return { status: "ended" };
    }
    const { commit, changes } = plan;
    for (const [i, group] of chunk(plan.pending, ANALYZE_BATCH).entries()) {
      await step.do(`pages-analyze-${i}`, STEP, () =>
        deps.withReader(repo, (reader) => analyzeFiles(env, models, reader, group)),
      );
    }
    // Rebuilt in each step from D1, as main's wiki steps do: nothing large crosses steps.
    const graphsAt = async (reader: RepoReader) => {
      const graphs = await overlayGraphs(env.DB, repo, changes, snapshot);
      const source: WikiSource = {
        repoId,
        commit,
        reader,
        graph: graphs.timeline,
        syntheses: graphs.syntheses,
        files: graphs.files,
        analyses: graphs.analyses,
        readme: "",
      };
      return { graphs, source, diff: diffGraphs(graphs.main, graphs.timeline) };
    };
    const chosen = await step.do("pages-choose", STEP, () =>
      deps.withReader(
        repo,
        async (reader) => {
          const { graphs, diff } = await graphsAt(reader);
          const picked = choosePages(graphs.timeline, graphs.syntheses, diff);
          await recordSet(env.DB, set, buildId, {
            stats: {
              counts: countChanges(diff),
              planned: picked.pages.length,
              capped: picked.skipped,
            },
          });
          return picked.pages;
        },
        snapshot,
      ),
    );
    const totals = emptyStats();
    let ended = false;
    for (const [i, batch] of chunk(chosen, PAGES_PER_STEP).entries()) {
      const stats = await step.do(`pages-write-${i}`, STEP, async () => {
        // An ended timeline's pages are read-only: stop, keeping what's written.
        if (await overlayEnded(env.DB, repoId, set.ref, set.sourceId)) return null;
        return deps.withReader(
          repo,
          async (reader) => {
            const { diff, source } = await graphsAt(reader);
            return writeSetPages(env, models, set, source, diff, batch, MAX_SET_TOKENS, {
              baseCommit: plan.base,
              changedPaths: new Set(changes.map((change) => change.path)),
            });
          },
          snapshot,
        );
      });
      if (!stats) {
        ended = true;
        break;
      }
      addStats(totals, stats);
    }
    const { errors, ...counted } = totals;
    const summary = { ...counted, ...(errors.length ? { errors } : {}) };
    if (ended) {
      await done("ended", { stats: summary });
      return { status: "ended" };
    }
    // A set that could settle nothing it tried means the provider is down.
    if (totals.failed > 0 && totals.written + totals.kept + totals.copied === 0)
      throw new Error(`No timeline page could be written: ${errors[0] ?? "unknown error"}`);
    await done("succeeded", { stats: summary });
    return { status: "succeeded", ...counted };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await done("failed", { error: message });
    throw error;
  }
}

// ---- reading -----------------------------------------------------------------------

/** A page's opening paragraph, as plain text, for a review card. */
export function excerpt(body: string, max = 240): string {
  const paragraph =
    body
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith("#") && !p.startsWith("```") && !p.startsWith("|")) ?? "";
  const plain = paragraph
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

type SetRow = {
  repo_id: string;
  source_id?: string;
  ref: string;
  set_key: string;
  checkpoint_id: string | null;
  checkpoint_number: number | null;
  commit_oid: string;
  base_commit: string | null;
  status: KnowledgePageSet["state"];
  stats: string;
  error: string | null;
  requested_at: string;
  finished_at: string | null;
};

export function toSet(row: SetRow, pages: KnowledgeTimelinePageSummary[]): KnowledgePageSet {
  const stats = JSON.parse(row.stats) as {
    counts?: KnowledgePageSet["counts"];
    capped?: number;
    skipped?: number;
  };
  return {
    sourceId: row.source_id ?? "canonical",
    ref: row.ref.replace(/^refs\/heads\//, ""),
    timeline: timelineSlugOf(row.ref) ?? row.ref,
    key: row.set_key,
    checkpoint: row.checkpoint_id ? { id: row.checkpoint_id, number: row.checkpoint_number } : null,
    commit: row.commit_oid,
    baseCommit: row.base_commit,
    state: row.status,
    counts: stats.counts ?? {},
    pages,
    skipped: (stats.capped ?? 0) + (stats.skipped ?? 0),
    error: row.status === "failed" ? row.error : null,
    requestedAt: row.requested_at,
    finishedAt: row.finished_at,
  };
}

/** Sets with their pages in brief, for one repository's bookmarks. */
async function withPages(d1: D1Database, rows: SetRow[]): Promise<KnowledgePageSet[]> {
  if (!rows.length) return [];
  const keys = [...new Set(rows.map((r) => r.set_key))];
  const pages = await db(d1)
    .selectFrom("kg_page_set_pages")
    .select([
      "repo_id",
      "source_id",
      "ref",
      "set_key",
      "slug",
      "title",
      "section",
      "position",
      "kind",
      "change",
      "outcome",
      "node_id",
      "model",
      "updated_at",
      // Enough for an excerpt, without the whole page.
      sql<string>`substr(body, 1, 1200)`.as("head"),
    ])
    .where("repo_id", "in", [...new Set(rows.map((r) => r.repo_id))])
    .where("set_key", "in", keys)
    .orderBy("position")
    .execute();
  return rows.map((row) =>
    toSet(
      row,
      pages
        .filter(
          (p) =>
            p.repo_id === row.repo_id &&
            p.source_id === (row.source_id ?? "canonical") &&
            p.ref === row.ref &&
            p.set_key === row.set_key,
        )
        .map((p) => ({
          slug: p.slug,
          title: p.title,
          section: p.section,
          kind: p.kind,
          change: p.change,
          outcome: p.outcome,
          nodeId: p.node_id,
          excerpt: excerpt(p.head),
          model: p.model,
          updatedAt: p.updated_at,
        })),
    ),
  );
}

const SET_COLUMNS = [
  "repo_id",
  "source_id",
  "ref",
  "set_key",
  "checkpoint_id",
  "checkpoint_number",
  "commit_oid",
  "base_commit",
  "status",
  "stats",
  "error",
  "requested_at",
  "finished_at",
] as const;

/** A timeline bookmark's sets, newest first, or just the one for `key`. */
export async function listSets(
  d1: D1Database,
  repoId: string,
  ref: string,
  options: { key?: string; limit?: number; sourceId?: string } = {},
): Promise<KnowledgePageSet[]> {
  let query = db(d1)
    .selectFrom("kg_page_sets")
    .select(SET_COLUMNS)
    .where("repo_id", "=", repoId)
    .where("ref", "=", ref);
  if (options.key) query = query.where("set_key", "=", options.key);
  if (options.sourceId) query = query.where("source_id", "=", options.sourceId);
  const rows = await query
    .orderBy("requested_at", "desc")
    .limit(Math.min(options.limit ?? MAX_SETS, MAX_SETS))
    .execute();
  return withPages(d1, rows);
}

/** The sets written for one checkpoint, per repository. */
export async function checkpointSets(
  d1: D1Database,
  checkpointId: string,
  repoIds: string[],
  ref: string,
): Promise<(KnowledgePageSet & { repoId: string })[]> {
  if (!repoIds.length) return [];
  const rows = await db(d1)
    .selectFrom("kg_page_sets")
    .select(SET_COLUMNS)
    .where("repo_id", "in", repoIds)
    .where("ref", "=", ref)
    .where("set_key", "=", checkpointId)
    .execute();
  const sets = await withPages(d1, rows);
  return sets.map((set, i) => ({ ...set, repoId: rows[i]!.repo_id }));
}

/**
 * One page of a timeline's set in full, with its set: of `key`, or of the
 * newest set that has the page.
 */
export async function timelinePage(
  d1: D1Database,
  repoId: string,
  ref: string,
  slug: string,
  key?: string,
  sourceId?: string,
) {
  let query = db(d1)
    .selectFrom("kg_page_set_pages as p")
    .innerJoin("kg_page_sets as s", (join) =>
      join
        .onRef("s.repo_id", "=", "p.repo_id")
        .onRef("s.source_id", "=", "p.source_id")
        .onRef("s.ref", "=", "p.ref")
        .onRef("s.set_key", "=", "p.set_key"),
    )
    .selectAll("p")
    .where("p.repo_id", "=", repoId)
    .where("p.ref", "=", ref)
    .where("p.slug", "=", slug);
  if (key) query = query.where("p.set_key", "=", key);
  if (sourceId) query = query.where("s.source_id", "=", sourceId);
  const page = await query.orderBy("s.requested_at", "desc").limit(1).executeTakeFirst();
  if (!page) return null;
  const set = await db(d1)
    .selectFrom("kg_page_sets")
    .select(SET_COLUMNS)
    .where("repo_id", "=", repoId)
    .where("source_id", "=", page.source_id)
    .where("ref", "=", ref)
    .where("set_key", "=", page.set_key)
    .executeTakeFirstOrThrow();
  return { page, set: toSet(set, []) };
}
