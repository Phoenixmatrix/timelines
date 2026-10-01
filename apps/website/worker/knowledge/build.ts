// The build pipeline, as a Workflow: durable steps with retries, so a failed
// model call retries that step instead of the whole build, and progress
// survives restarts. Steps are ordered so cheap, exact results land first:
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
//   wiki        rewrite only the pages whose inputs changed and matter
//   finish      promote the snapshot, record stats, tell the coordinator

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { sql } from "kysely";
import { invalidateRefs, RepoReader } from "../objects.ts";
import { db, nowIso } from "../schema.ts";
import { Timing } from "../timing.ts";
import { analyzeFiles, loadAnalyses, type FileToAnalyze } from "./analyze.ts";
import {
  applyGraph,
  buildGraph,
  loadSnapshot,
  saveSnapshot,
  type ComponentSynthesis,
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
import { chunk } from "./util.ts";
import { updateWiki } from "./wiki.ts";

export interface BuildParams {
  repoId: string;
  buildId: string;
  /** Rebuild even when HEAD is already indexed. */
  force?: boolean;
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

async function setPhase(
  d1: D1Database,
  buildId: string,
  phase: string,
  stats?: Record<string, unknown>,
) {
  await db(d1)
    .updateTable("kg_builds")
    .set(stats ? { phase, stats: patchStats(stats) } : { phase })
    .where("id", "=", buildId)
    .execute();
}

/** Fallback meaning from the stored graph, used until new syntheses land. */
async function storedSyntheses(d1: D1Database, repoId: string): Promise<Syntheses> {
  const results = await db(d1)
    .selectFrom("kg_nodes")
    .select(["id", "kind", "name", "summary", "data"])
    .where("repo_id", "=", repoId)
    .where("kind", "in", ["repository", "component", "concept"])
    .execute();
  const out: Syntheses = { components: new Map(), concepts: new Map() };
  for (const row of results) {
    const data = JSON.parse(row.data) as Record<string, unknown>;
    if (row.kind === "repository" && row.summary) {
      out.repo = {
        title: row.name,
        summary: row.summary,
        techStack: (data.techStack as string[]) ?? [],
      };
    } else if (row.kind === "component" && row.summary) {
      out.components.set(row.id, {
        title: row.name,
        summary: row.summary,
        responsibilities: (data.responsibilities as string[]) ?? [],
        keyFiles: (data.keyFiles as ComponentSynthesis["keyFiles"]) ?? [],
      });
    } else if (row.kind === "concept" && row.summary) {
      out.concepts.set(row.id.slice(8), row.summary);
    }
  }
  return out;
}

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

  async run(event: Readonly<WorkflowEvent<BuildParams>>, step: WorkflowStep) {
    const { repoId, buildId, force } = event.payload;
    const env = this.env;
    try {
      const start = await step.do("start", STEP, async () => {
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
        await this.#finish(step, repoId, buildId, head, { upToDate: true });
        return { status: "up-to-date" };
      }

      const toAnalyze = await step.do("snapshot", STEP, async () =>
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
          await setPhase(env.DB, buildId, "analyze", {
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
        const stats = await step.do(`analyze-${i}`, STEP, () =>
          this.#withReader(row, (reader) => analyzeFiles(env, reader, group)),
        );
        analyzed += stats.analyzed;
        reused += stats.reused;
        failed += stats.failed;
        await step.do(`progress-${i}`, async () => {
          await setPhase(env.DB, buildId, "analyze", {
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
      const firstPass = await step.do("graph", STEP, () =>
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
          await setPhase(env.DB, buildId, "align", {
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
      const decidedBefore = await step.do("align-start", STEP, async () => {
        const row = await db(env.DB)
          .selectFrom("kg_concept_pairs")
          .select((eb) => eb.fn.countAll<number>().as("n"))
          .where("repo_id", "=", repoId)
          .executeTakeFirst();
        return row?.n ?? 0;
      });
      let pairsAsked = 0;
      for (let round = 0; round < 25; round++) {
        const aligned = await step.do(`align-${round}`, STEP, async () => {
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
      const conceptStats = await step.do("concepts", STEP, async () => {
        const files = await loadSnapshot(env.DB, repoId, buildId);
        const analyses = await loadAnalyses(
          env.DB,
          files.map((f) => f.blob),
        );
        const stats = await settleConcepts(env, repoId, files, analyses);
        await setPhase(env.DB, buildId, "synthesize", {
          conceptPairsAsked: pairsAsked,
          concepts: stats.groups,
          conceptsMerged: stats.merged,
          conceptsTrimmed: stats.trimmed,
          conceptLinks: stats.links,
        });
        return stats;
      });

      const synthesis = await step.do("synthesize", STEP, () =>
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
      const review = await step.do("review", STEP, () =>
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

      await step.do("graph-final", STEP, () =>
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
          await setPhase(env.DB, buildId, "index", {
            synthesized: synthesis.components + synthesis.concepts + (synthesis.repo ? 1 : 0),
          });
          return null;
        }),
      );

      await step.do("index", STEP, () =>
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
          await setPhase(env.DB, buildId, "wiki", {
            vectorsUpserted: vectors.upserted,
            searchUploaded: search.uploaded,
          });
          return null;
        }),
      );

      const wiki = await step.do("wiki", STEP, () =>
        this.#withReader(row, async (reader) => {
          const files = await loadSnapshot(env.DB, repoId, buildId);
          const analyses = await loadAnalyses(
            env.DB,
            files.map((f) => f.blob),
          );
          const concepts = await loadConceptModel(env.DB, repoId);
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
          const results = await db(env.DB)
            .selectFrom("kg_changes")
            .select("node_id")
            .distinct()
            .where("repo_id", "=", repoId)
            .where("build_id", "=", buildId)
            .execute();
          const stats = await updateWiki(
            env,
            reader,
            repoId,
            head,
            graph,
            syntheses,
            files,
            analyses,
            readme,
            new Set(results.map((r) => r.node_id)),
          );
          const pages = await db(env.DB)
            .selectFrom("wiki_pages")
            .select(["slug", "title", "body", "inputs_hash"])
            .where("repo_id", "=", repoId)
            .execute();
          await syncSearchPages(env, repoId, head, pages);
          return stats;
        }),
      );

      await this.#finish(step, repoId, buildId, head, {
        analyzed,
        reused,
        graph: firstPass,
        conceptPairsAsked: pairsAsked,
        conceptSalienceAsked: conceptStats.askedSalience,
        conceptReviewsAsked: review.asked,
        conceptReviewMerges: review.newMerges,
        pagesWritten: wiki.written,
        pagesKept: wiki.kept,
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
      await db(env.DB)
        .updateTable("kg_builds")
        .set({
          status: "succeeded",
          phase: "done",
          stats: patchStats(stats),
          finished_at: nowIso(),
        })
        .where("id", "=", buildId)
        .execute();
      await coordinator(env, repoId).finished(buildId, true, null);
      return null;
    });
  }
}
