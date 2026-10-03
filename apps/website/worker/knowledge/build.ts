// The build pipeline, as a Workflow: durable steps with retries, so a failed
// model call retries that step instead of the whole build, and progress
// survives restarts. Each step records when it finished (progress_at) for the
// coordinator's watchdog. Steps are ordered so cheap, exact results land first:
//
//   start       resolve HEAD, record the build
//   snapshot    list the commit's files; find what changed since last time
//   analyze-N   per-file analysis for changed content (cached by blob)
//   graph       structure + cached meaning: the graph is current in ~seconds
//   align-N     clef decides about new candidate concept pairs (same / part of)
//   concepts    merge concept groups, link narrower/broader, trim noise (clef)
//   synthesize  component / repository / concept syntheses that changed
//   review      related kept concepts, asked again with definitions (clef)
//   graph-final apply the new syntheses
//   index       Vectorize (entities) and AI Search (passages)
//   wiki-plan   keep pages whose inputs are unchanged; list the rest
//   wiki-N      rewrite the listed pages that matter, a few per step
//   wiki-search index the pages for AI Search
//   finish      promote the snapshot, record stats, tell the coordinator
//
// The same Workflow computes timeline overlays (overlay.ts), when started
// with `overlay`: plan (merge base, changed files), analyze-N for blobs
// nothing has analyzed, then diff. Those steps write only kg_overlays,
// kg_overlay_changes and the shared per-blob analysis cache.
//
// And a timeline's wiki page set (pages.ts, CORE-84), when started with
// `pages`: plan the timeline's changes at the set's commit, analyze-N as for
// an overlay, choose the affected pages, then write them a few per step.
// Those steps write only kg_page_sets, kg_page_set_pages and the analysis cache.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { sql } from "kysely";
import {
  beginRepoProjection,
  currentSnapshot,
  failProjection,
  projectEdges,
  projectEntities,
  publishProjection,
  repoScope,
  type EdgeCursor,
} from "../atlas/projection.ts";
import { invalidateRefs, RepoReader } from "../objects.ts";
import { db, nowIso } from "../schema.ts";
import { Timing } from "../timing.ts";
import { analyzeFiles, loadAnalyses, type FileToAnalyze } from "./analyze.ts";
import { atlasRunSpend } from "./budget.ts";
import {
  applyGraph,
  buildGraph,
  loadSnapshot,
  saveSnapshot,
  storedSyntheses,
  type SnapshotFile,
  type Syntheses,
} from "./graph.ts";
import {
  alignPairs,
  loadConceptModel,
  reviewConcepts,
  settleConcepts,
  type ConceptModel,
} from "./concepts.ts";
import { syncSearchFiles, syncSearchPages, syncVectors } from "./indexes.ts";
import { synthesize } from "./synthesize.ts";
import { coordinator } from "./coordinator.ts";
import { computeOverlay, overlayFailed, planOverlay, toAnalyze } from "./overlay.ts";
import { runPageSet } from "./pages.ts";
import { chunk } from "./util.ts";
import { planWiki, updatePages, type WikiSource, type WikiStats } from "./wiki.ts";

export interface BuildParams {
  repoId: string;
  buildId: string;
  /** Rebuild even when HEAD is already indexed. */
  force?: boolean;
  /** Compute a timeline's overlay instead of building main's graph. */
  overlay?: { ref: string; commit: string };
  /** Write a timeline's wiki page set (queued in kg_page_sets) instead. */
  pages?: { ref: string; key: string };
}

interface RepoRow {
  id: string;
  artifacts_name: string;
  artifacts_remote: string;
  full_name: string;
}

// Model calls already wait out rate limits; step retries cover the rest.
const STEP = {
  retries: { limit: 4, delay: "20 seconds", backoff: "exponential" },
  timeout: "15 minutes",
} as const;
const ANALYZE_BATCH = 32;
/** Wiki pages per step: a few model calls, far inside the step timeout. */
const WIKI_BATCH = 6;

async function repoRow(d1: D1Database, repoId: string): Promise<RepoRow | null> {
  const row = await db(d1)
    .selectFrom("repos as r")
    .innerJoin("accounts as o", "o.id", "r.owner_id")
    .select(["r.id", "r.artifacts_name", "r.artifacts_remote", "o.slug", "r.name"])
    .where("r.id", "=", repoId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    artifacts_name: row.artifacts_name,
    artifacts_remote: row.artifacts_remote,
    full_name: `${row.slug}/${row.name}`,
  };
}

/** Merge `stats` into a build's stats JSON. */
const patchStats = (stats: Record<string, unknown>) =>
  sql<string>`json_patch(stats, ${JSON.stringify(stats)})`;

/** The phase a build is in, set as each step starts (so labels never lag). */
async function setPhase(d1: D1Database, buildId: string, phase: string) {
  await db(d1).updateTable("kg_builds").set({ phase }).where("id", "=", buildId).execute();
}

/** Merge `stats` into a build's stats, leaving its phase alone. */
async function recordStats(d1: D1Database, buildId: string, stats: Record<string, unknown>) {
  await db(d1)
    .updateTable("kg_builds")
    .set({ stats: patchStats(stats) })
    .where("id", "=", buildId)
    .execute();
}

/** A durable step that records its phase and progress (see `run`). */
type Progress = <T extends Rpc.Serializable<T>>(
  name: string,
  phase: string,
  work: () => Promise<T>,
) => Promise<T>;

function merge(base: Syntheses, over: Syntheses): Syntheses {
  return {
    repo: over.repo ?? base.repo,
    components: new Map([...base.components, ...over.components]),
    concepts: new Map([...base.concepts, ...over.concepts]),
  };
}

export class KnowledgeBuild extends WorkflowEntrypoint<Env, BuildParams> {
  #reader(row: RepoRow) {
    return new RepoReader(
      this.env,
      row.artifacts_name,
      row.artifacts_remote,
      new Timing(),
      (work) => this.ctx.waitUntil(work),
    );
  }

  async #withReader<T>(row: RepoRow, work: (reader: RepoReader) => Promise<T>): Promise<T> {
    const reader = this.#reader(row);
    try {
      return await work(reader);
    } finally {
      await reader.close();
    }
  }

  async #readme(reader: RepoReader, files: SnapshotFile[]): Promise<string> {
    const file = files.find((f) => /^readme(\.md|\.markdown|\.txt)?$/i.test(f.path));
    const blob = file ? await reader.blob(file.blob) : null;
    return blob ? new TextDecoder().decode(blob.bytes) : "";
  }

  /** The build's files and graph with stored syntheses: what wiki pages are written from. */
  async #wikiSource(
    reader: RepoReader,
    row: RepoRow,
    buildId: string,
    head: string,
  ): Promise<WikiSource> {
    const env = this.env;
    const files = await loadSnapshot(env.DB, row.id, buildId);
    const analyses = await loadAnalyses(
      env.DB,
      files.map((f) => f.blob),
    );
    const concepts = await loadConceptModel(env.DB, row.id);
    const readme = await this.#readme(reader, files);
    const { syntheses } = await synthesize(
      env,
      row.full_name,
      files,
      analyses,
      buildGraph(
        row.full_name,
        files,
        analyses,
        {
          components: new Map(),
          concepts: new Map(),
        },
        concepts,
      ),
      readme,
      true,
    );
    const graph = buildGraph(row.full_name, files, analyses, syntheses, concepts);
    return { repoId: row.id, commit: head, reader, graph, syntheses, files, analyses, readme };
  }

  async run(event: Readonly<WorkflowEvent<BuildParams>>, step: WorkflowStep) {
    if (event.payload.overlay) return this.#overlay(event.payload, step);
    if (event.payload.pages)
      return runPageSet(this.env, { ...event.payload, pages: event.payload.pages }, step, {
        repo: (id) => repoRow(this.env.DB, id),
        withReader: (row, work) => this.#withReader(row, work),
        finished: (buildId) => coordinator(this.env, event.payload.repoId).pagesFinished(buildId),
      });
    const { repoId, buildId, force } = event.payload;
    const env = this.env;
    // A durable step that shows its phase while it runs, and records when it
    // finished so the coordinator's watchdog can tell a slow build from a stuck one.
    const progress = <T extends Rpc.Serializable<T>>(
      name: string,
      phase: string,
      work: () => Promise<T>,
    ) =>
      step.do(name, STEP, async () => {
        await setPhase(env.DB, buildId, phase);
        const result = await work();
        await db(env.DB)
          .updateTable("kg_builds")
          .set({ progress_at: nowIso() })
          .where("id", "=", buildId)
          .execute();
        return result;
      });
    try {
      const start = await progress("start", "snapshot", async () => {
        const row = await repoRow(env.DB, repoId);
        if (!row) return null;
        invalidateRefs(row.artifacts_name);
        const refs = await this.#withReader(row, (reader) => reader.refs());
        const state = await db(env.DB)
          .selectFrom("kg_state")
          .select("indexed_commit")
          .where("repo_id", "=", repoId)
          .executeTakeFirst();
        await db(env.DB)
          .insertInto("kg_builds")
          .values({
            id: buildId,
            repo_id: repoId,
            from_commit: state?.indexed_commit ?? null,
            to_commit: refs.head ?? "",
            status: "running",
            phase: "snapshot",
          })
          .onConflict((oc) => oc.column("id").doNothing())
          .execute();
        return { row, head: refs.head, previous: state?.indexed_commit ?? null };
      });
      if (!start?.head) {
        await this.#finish(step, repoId, buildId, null, { empty: true });
        return { status: "empty" };
      }
      const { row, head } = start;
      if (head === start.previous && !force) {
        // Repositories indexed before the Atlas existed get their first projection now.
        const missing = await step.do(
          "atlas-check",
          STEP,
          async () => !(await currentSnapshot(env.DB, repoScope(repoId))),
        );
        const atlas = missing ? await this.#project(step, progress, repoId, buildId, head) : {};
        await this.#finish(step, repoId, buildId, head, { upToDate: true, ...atlas });
        return { status: "up-to-date" };
      }

      const toAnalyze = await progress("snapshot", "snapshot", async () =>
        this.#withReader(row, async (reader) => {
          const commit = await reader.commit(head);
          if (!commit) throw new Error(`Commit ${head} not found`);
          const files: SnapshotFile[] = [];
          const walk = async (tree: string, prefix: string) => {
            for (const entry of (await reader.tree(tree)) ?? []) {
              const path = prefix ? `${prefix}/${entry.name}` : entry.name;
              if (entry.type === "tree") await walk(entry.hash, path);
              else if (entry.type === "blob" || entry.type === "exec")
                files.push({ path, blob: entry.hash, mode: entry.mode });
            }
          };
          await walk(commit.treeHash, "");
          await saveSnapshot(env.DB, repoId, buildId, files);
          const previous = new Map(
            (await loadSnapshot(env.DB, repoId, "current")).map((f) => [f.path, f.blob]),
          );
          const known = await loadAnalyses(
            env.DB,
            files.map((f) => f.blob),
          );
          const pending: FileToAnalyze[] = files
            .filter((f) => !known.has(f.blob))
            .map((f) => ({ path: f.path, blob: f.blob, previousBlob: previous.get(f.path) }));
          await recordStats(env.DB, buildId, {
            files: files.length,
            changedFiles: files.filter((f) => previous.get(f.path) !== f.blob).length,
            removedFiles: [...previous.keys()].filter((p) => !files.some((f) => f.path === p))
              .length,
            toAnalyze: pending.length,
          });
          return pending;
        }),
      );

      let analyzed = 0;
      let reused = 0;
      let failed = 0;
      for (const [i, group] of chunk(toAnalyze, ANALYZE_BATCH).entries()) {
        const stats = await progress(`analyze-${i}`, "analyze", () =>
          this.#withReader(row, (reader) => analyzeFiles(env, reader, group)),
        );
        analyzed += stats.analyzed;
        reused += stats.reused;
        failed += stats.failed;
        await progress(`progress-${i}`, "analyze", async () => {
          await recordStats(env.DB, buildId, {
            analyzed,
            reused,
            failed,
            analyzeDone: Math.min((i + 1) * ANALYZE_BATCH, toAnalyze.length),
          });
          return null;
        });
      }

      // The graph goes live with exact structure and whatever meaning is cached,
      // before any slow synthesis runs.
      const firstPass = await progress("graph", "graph", () =>
        this.#withReader(row, async (reader) => {
          const files = await loadSnapshot(env.DB, repoId, buildId);
          const analyses = await loadAnalyses(
            env.DB,
            files.map((f) => f.blob),
          );
          const concepts = await loadConceptModel(env.DB, repoId);
          const readme = await this.#readme(reader, files);
          const draft = buildGraph(
            row.full_name,
            files,
            analyses,
            {
              components: new Map(),
              concepts: new Map(),
            },
            concepts,
          );
          const { syntheses } = await synthesize(
            env,
            row.full_name,
            files,
            analyses,
            draft,
            readme,
            true,
          );
          const graph = buildGraph(
            row.full_name,
            files,
            analyses,
            merge(await storedSyntheses(env.DB, repoId), syntheses),
            concepts,
          );
          const diff = await applyGraph(env.DB, repoId, buildId, head, graph);
          await recordStats(env.DB, buildId, {
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            graphAdded: diff.added.length,
            graphChanged: diff.changed.length,
            graphRemoved: diff.removed.length,
          });
          return {
            added: diff.added.length,
            changed: diff.changed.length,
            removed: diff.removed.length,
          };
        }),
      );

      // Concepts: align names and trim noise with clef. After the first build
      // only the concepts a push introduced cost model calls.
      // Counted from what is stored, so calls made by a retried step count too.
      const decidedBefore = await progress("align-start", "align", async () => {
        const row = await db(env.DB)
          .selectFrom("kg_concept_pairs")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("repo_id", "=", repoId)
          .executeTakeFirst();
        return row?.n ?? 0;
      });
      let pairsAsked = 0;
      for (let round = 0; round < 25; round++) {
        const aligned = await progress(`align-${round}`, "align", async () => {
          const files = await loadSnapshot(env.DB, repoId, buildId);
          const analyses = await loadAnalyses(
            env.DB,
            files.map((f) => f.blob),
          );
          return alignPairs(env, repoId, files, analyses);
        });
        pairsAsked = Math.max(0, aligned.decided - decidedBefore);
        if (aligned.remaining === 0) break;
      }
      const conceptStats = await progress("concepts", "align", async () => {
        const files = await loadSnapshot(env.DB, repoId, buildId);
        const analyses = await loadAnalyses(
          env.DB,
          files.map((f) => f.blob),
        );
        const stats = await settleConcepts(env, repoId, files, analyses);
        await recordStats(env.DB, buildId, {
          conceptPairsAsked: pairsAsked,
          concepts: stats.groups,
          conceptsMerged: stats.merged,
          conceptsTrimmed: stats.trimmed,
          conceptLinks: stats.links,
        });
        return stats;
      });

      const synthesis = await progress("synthesize", "synthesize", () =>
        this.#withReader(row, async (reader) => {
          const files = await loadSnapshot(env.DB, repoId, buildId);
          const analyses = await loadAnalyses(
            env.DB,
            files.map((f) => f.blob),
          );
          const concepts = await loadConceptModel(env.DB, repoId);
          const draft = buildGraph(
            row.full_name,
            files,
            analyses,
            {
              components: new Map(),
              concepts: new Map(),
            },
            concepts,
          );
          const { stats } = await synthesize(
            env,
            row.full_name,
            files,
            analyses,
            draft,
            await this.#readme(reader, files),
          );
          return stats;
        }),
      );

      // With definitions written, related pairs of kept concepts get a second
      // look; any merge it finds regroups concepts and defines the new group.
      const review = await progress("review", "synthesize", () =>
        this.#withReader(row, async (reader) => {
          const files = await loadSnapshot(env.DB, repoId, buildId);
          const analyses = await loadAnalyses(
            env.DB,
            files.map((f) => f.blob),
          );
          const readme = await this.#readme(reader, files);
          const graphWith = async (model: ConceptModel) => {
            const draft = buildGraph(
              row.full_name,
              files,
              analyses,
              { components: new Map(), concepts: new Map() },
              model,
            );
            const { syntheses } = await synthesize(
              env,
              row.full_name,
              files,
              analyses,
              draft,
              readme,
              true,
            );
            return { draft, graph: buildGraph(row.full_name, files, analyses, syntheses, model) };
          };
          const { graph } = await graphWith(await loadConceptModel(env.DB, repoId));
          const stats = await reviewConcepts(env, repoId, graph);
          if (stats.newMerges > 0) {
            await settleConcepts(env, repoId, files, analyses);
            const { draft } = await graphWith(await loadConceptModel(env.DB, repoId));
            await synthesize(env, row.full_name, files, analyses, draft, readme);
          }
          return stats;
        }),
      );

      await progress("graph-final", "synthesize", () =>
        this.#withReader(row, async (reader) => {
          const files = await loadSnapshot(env.DB, repoId, buildId);
          const analyses = await loadAnalyses(
            env.DB,
            files.map((f) => f.blob),
          );
          const concepts = await loadConceptModel(env.DB, repoId);
          const readme = await this.#readme(reader, files);
          const draft = buildGraph(
            row.full_name,
            files,
            analyses,
            {
              components: new Map(),
              concepts: new Map(),
            },
            concepts,
          );
          const { syntheses } = await synthesize(
            env,
            row.full_name,
            files,
            analyses,
            draft,
            readme,
            true,
          );
          const graph = buildGraph(row.full_name, files, analyses, syntheses, concepts);
          await applyGraph(env.DB, repoId, buildId, head, graph);
          await recordStats(env.DB, buildId, {
            synthesized: synthesis.components + synthesis.concepts + (synthesis.repo ? 1 : 0),
          });
          return null;
        }),
      );
      const atlas = await this.#project(step, progress, repoId, buildId, head);

      await progress("index", "index", () =>
        this.#withReader(row, async (reader) => {
          const files = await loadSnapshot(env.DB, repoId, buildId);
          const analyses = await loadAnalyses(
            env.DB,
            files.map((f) => f.blob),
          );
          const concepts = await loadConceptModel(env.DB, repoId);
          const results = await db(env.DB)
            .selectFrom("kg_changes")
            .select(["node_id", "change"])
            .distinct()
            .where("repo_id", "=", repoId)
            .where("build_id", "=", buildId)
            .execute();
          const diff = {
            added: results.filter((r) => r.change === "added").map((r) => r.node_id),
            changed: results.filter((r) => r.change === "changed").map((r) => r.node_id),
            removed: results.filter((r) => r.change === "removed").map((r) => r.node_id),
          };
          const { syntheses } = await synthesize(
            env,
            row.full_name,
            files,
            analyses,
            buildGraph(
              row.full_name,
              files,
              analyses,
              {
                components: new Map(),
                concepts: new Map(),
              },
              concepts,
            ),
            "",
            true,
          );
          const graph = buildGraph(
            row.full_name,
            files,
            analyses,
            merge(await storedSyntheses(env.DB, repoId), syntheses),
            concepts,
          );
          const vectors = await syncVectors(env, repoId, graph.nodes, diff);
          const search = await syncSearchFiles(env, reader, repoId, head, files, analyses);
          await recordStats(env.DB, buildId, {
            vectorsUpserted: vectors.upserted,
            searchUploaded: search.uploaded,
          });
          return null;
        }),
      );

      // The wiki, a few pages per step. Each page is saved as soon as it is
      // settled, so a retried step or a restarted build resumes where it stopped.
      const plan = await progress("wiki-plan", "wiki", () =>
        this.#withReader(row, async (reader) =>
          planWiki(env, await this.#wikiSource(reader, row, buildId, head)),
        ),
      );
      const wiki: WikiStats = {
        written: 0,
        kept: 0,
        unchanged: plan.unchanged,
        failed: 0,
        tokens: 0,
        errors: [],
      };
      for (const [i, slugs] of chunk(plan.pending, WIKI_BATCH).entries()) {
        const stats = await progress(`wiki-${i}`, "wiki", () =>
          this.#withReader(row, async (reader) => {
            const results = await db(env.DB)
              .selectFrom("kg_changes")
              .select("node_id")
              .distinct()
              .where("repo_id", "=", repoId)
              .where("build_id", "=", buildId)
              .execute();
            const stats = await updatePages(
              env,
              await this.#wikiSource(reader, row, buildId, head),
              slugs,
              new Set(results.map((r) => r.node_id)),
            );
            await recordStats(env.DB, buildId, {
              wikiPages: plan.pending.length,
              wikiDone: Math.min((i + 1) * WIKI_BATCH, plan.pending.length),
            });
            return stats;
          }),
        );
        wiki.written += stats.written;
        wiki.kept += stats.kept;
        wiki.unchanged += stats.unchanged;
        wiki.failed += stats.failed;
        wiki.tokens += stats.tokens;
        wiki.errors.push(...stats.errors.slice(0, 3 - wiki.errors.length));
      }
      // Pages that fail keep their old text and are retried by the next build,
      // but a wiki that could not write anything means the provider is down.
      if (wiki.failed > 0 && wiki.written + wiki.kept === 0) {
        throw new Error(`No wiki page could be written: ${wiki.errors[0] ?? "unknown error"}`);
      }
      await progress("wiki-search", "wiki", async () => {
        const pages = await db(env.DB)
          .selectFrom("wiki_pages")
          .select(["slug", "title", "body", "inputs_hash"])
          .where("repo_id", "=", repoId)
          .execute();
        await syncSearchPages(env, repoId, head, pages);
        return null;
      });

      await this.#finish(step, repoId, buildId, head, {
        ...atlas,
        analyzed,
        reused,
        graph: firstPass,
        conceptPairsAsked: pairsAsked,
        conceptSalienceAsked: conceptStats.askedSalience,
        conceptReviewsAsked: review.asked,
        conceptReviewMerges: review.newMerges,
        pagesWritten: wiki.written,
        pagesKept: wiki.kept,
        pagesRemoved: plan.removed,
        ...(wiki.failed ? { pagesFailed: wiki.failed, pageErrors: wiki.errors } : {}),
      });
      return { status: "succeeded", head };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("fail", async () => {
        await db(env.DB)
          .updateTable("kg_builds")
          .set({ status: "failed", error: message.slice(0, 2000), finished_at: nowIso() })
          .where("id", "=", buildId)
          .execute();
        await coordinator(env, repoId).finished(buildId, false, message);
        return null;
      });
      throw error;
    }
  }

  /** A timeline's overlay: its graph diff against main's indexed graph. */
  async #overlay(params: BuildParams, step: WorkflowStep) {
    const { repoId, buildId } = params;
    const { ref, commit } = params.overlay!;
    const env = this.env;
    try {
      const plan = await step.do("overlay-plan", STEP, async () => {
        const row = await repoRow(env.DB, repoId);
        const state = await db(env.DB)
          .selectFrom("kg_state")
          .select("indexed_commit")
          .where("repo_id", "=", repoId)
          .executeTakeFirst();
        if (!row || !state?.indexed_commit) return null;
        const base = state.indexed_commit;
        const plan = await this.#withReader(row, (reader) => planOverlay(reader, commit, base));
        const main = await loadSnapshot(env.DB, repoId, "current");
        const known = await loadAnalyses(
          env.DB,
          plan.changes.flatMap((c) => (c.blob ? [c.blob] : [])),
        );
        return { row, plan, pending: toAnalyze(plan.changes, main, known) };
      });
      if (!plan) {
        await step.do("overlay-finish", STEP, async () => {
          await coordinator(env, repoId).overlayFinished(ref, buildId, true, null, null);
          return null;
        });
        return { status: "waiting" };
      }
      const { row } = plan;
      let analyzed = 0;
      let reused = 0;
      let failed = 0;
      for (const [i, group] of chunk(plan.pending, ANALYZE_BATCH).entries()) {
        const stats = await step.do(`overlay-analyze-${i}`, STEP, () =>
          this.#withReader(row, (reader) => analyzeFiles(env, reader, group)),
        );
        analyzed += stats.analyzed;
        reused += stats.reused;
        failed += stats.failed;
      }
      const result = await step.do("overlay-diff", STEP, () =>
        computeOverlay(env.DB, row, ref, buildId, commit, plan.plan, {
          analyzed,
          reused,
          failed,
        }),
      );
      await step.do("overlay-finish", STEP, async () => {
        await coordinator(env, repoId).overlayFinished(ref, buildId, true, null, result.base);
        return null;
      });
      return { status: "succeeded", commit, counts: result.counts };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("overlay-fail", async () => {
        await overlayFailed(env.DB, repoId, ref, commit, message);
        await coordinator(env, repoId).overlayFinished(ref, buildId, false, message, null);
        return null;
      });
      throw error;
    }
  }

  /**
   * Materialize the stored graph (complete after `graph-final`) as an immutable
   * Atlas snapshot and publish it (CORE-158). Batches are idempotent, so step
   * retries are safe. A failure is rolled back and recorded in the build's
   * stats; it never fails the knowledge build, and the published snapshot
   * stays current.
   */
  async #project(
    step: WorkflowStep,
    progress: Progress,
    repoId: string,
    buildId: string,
    head: string,
  ): Promise<Record<string, unknown>> {
    const env = this.env;
    const scope = repoScope(repoId);
    const begun = await progress("atlas-start", "atlas", () =>
      beginRepoProjection(env.DB, repoId, [{ repoId, commit: head, buildId }]),
    );
    try {
      let after: string | null = null;
      for (let i = 0; ; i++) {
        const cursor: string | null = after;
        const batch: { next: string | null; written: number } = await progress(
          `atlas-entities-${i}`,
          "atlas",
          () => projectEntities(env.DB, repoId, begun.snapshotId, begun.seq, cursor),
        );
        after = batch.next;
        if (!after) break;
      }
      let edges: EdgeCursor = null;
      for (let i = 0; ; i++) {
        const cursor: EdgeCursor = edges;
        const batch: { next: EdgeCursor; written: number } = await progress(
          `atlas-edges-${i}`,
          "atlas",
          () => projectEdges(env.DB, repoId, begun.snapshotId, begun.seq, cursor),
        );
        edges = batch.next;
        if (!edges) break;
      }
      await progress("atlas-publish", "atlas", async () => {
        await publishProjection(env.DB, scope, begun.snapshotId, begun.seq);
        return null;
      });
      return { atlasSnapshot: begun.snapshotId, atlasSeq: begun.seq };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await step.do("atlas-fail", STEP, async () => {
        await failProjection(env.DB, scope, begun.snapshotId, message);
        return null;
      });
      return { atlasError: message.slice(0, 500) };
    }
  }

  async #finish(
    step: WorkflowStep,
    repoId: string,
    buildId: string,
    head: string | null,
    stats: Record<string, unknown>,
  ) {
    const env = this.env;
    await step.do("finish", STEP, async () => {
      if (head) {
        // The build's file list becomes the indexed snapshot.
        const files = await loadSnapshot(env.DB, repoId, buildId);
        if (files.length) {
          await saveSnapshot(env.DB, repoId, "current", files);
          await db(env.DB)
            .deleteFrom("kg_files")
            .where("repo_id", "=", repoId)
            .where("snapshot", "=", buildId)
            .execute();
        }
        await db(env.DB)
          .insertInto("kg_state")
          .values({
            repo_id: repoId,
            indexed_commit: head,
            indexed_at: nowIso(),
            last_build_id: buildId,
          })
          .onConflict((oc) =>
            oc.column("repo_id").doUpdateSet((eb) => ({
              indexed_commit: eb.ref("excluded.indexed_commit"),
              indexed_at: eb.ref("excluded.indexed_at"),
              last_build_id: eb.ref("excluded.last_build_id"),
            })),
          )
          .execute();
      }
      // Atlas paid synthesis is attributed apart from upstream Knowledge tokens.
      const atlasSpend = await atlasRunSpend(env.DB, "build", buildId);
      await db(env.DB)
        .updateTable("kg_builds")
        .set({
          status: "succeeded",
          phase: "done",
          stats: patchStats({ ...stats, atlasSpend }),
          finished_at: nowIso(),
        })
        .where("id", "=", buildId)
        .execute();
      await coordinator(env, repoId).finished(buildId, true, null);
      return null;
    });
  }
}
