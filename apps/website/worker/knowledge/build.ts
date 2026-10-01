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
import { invalidateRefs, RepoReader } from "../objects.ts";
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

async function repoRow(db: D1Database, repoId: string): Promise<RepoRow | null> {
  return db
    .prepare(
      `SELECT r.id, r.artifacts_name, r.artifacts_remote, o.slug || '/' || r.name AS full_name
       FROM repos r JOIN accounts o ON o.id = r.owner_id WHERE r.id = ?`,
    )
    .bind(repoId)
    .first<RepoRow>();
}

async function setPhase(
  db: D1Database,
  buildId: string,
  phase: string,
  stats?: Record<string, unknown>,
) {
  if (stats) {
    await db
      .prepare("UPDATE kg_builds SET phase = ?, stats = json_patch(stats, ?) WHERE id = ?")
      .bind(phase, JSON.stringify(stats), buildId)
      .run();
  } else {
    await db.prepare("UPDATE kg_builds SET phase = ? WHERE id = ?").bind(phase, buildId).run();
  }
}

/** Fallback meaning from the stored graph, used until new syntheses land. */
async function storedSyntheses(db: D1Database, repoId: string): Promise<Syntheses> {
  const { results } = await db
    .prepare(
      "SELECT id, kind, name, summary, data FROM kg_nodes WHERE repo_id = ? AND kind IN ('repository','component','concept')",
    )
    .bind(repoId)
    .all<{ id: string; kind: string; name: string; summary: string; data: string }>();
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
        const state = await env.DB.prepare("SELECT indexed_commit FROM kg_state WHERE repo_id = ?")
          .bind(repoId)
          .first<{ indexed_commit: string | null }>();
        await env.DB.prepare(
          `INSERT INTO kg_builds (id, repo_id, from_commit, to_commit, status, phase) VALUES (?, ?, ?, ?, 'running', 'snapshot')
           ON CONFLICT (id) DO NOTHING`,
        )
          .bind(buildId, repoId, state?.indexed_commit ?? null, refs.head ?? "")
          .run();
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
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM kg_concept_pairs WHERE repo_id = ?",
        )
          .bind(repoId)
          .first<{ n: number }>();
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
          const { results } = await env.DB.prepare(
            "SELECT DISTINCT node_id, change FROM kg_changes WHERE repo_id = ? AND build_id = ?",
          )
            .bind(repoId, buildId)
            .all<{ node_id: string; change: string }>();
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
          const { results } = await env.DB.prepare(
            "SELECT DISTINCT node_id FROM kg_changes WHERE repo_id = ? AND build_id = ?",
          )
            .bind(repoId, buildId)
            .all<{ node_id: string }>();
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
          const { results: pages } = await env.DB.prepare(
            "SELECT slug, title, body, inputs_hash FROM wiki_pages WHERE repo_id = ?",
          )
            .bind(repoId)
            .all<{ slug: string; title: string; body: string; inputs_hash: string }>();
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
        await env.DB.prepare(
          "UPDATE kg_builds SET status = 'failed', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
        )
          .bind(message.slice(0, 2000), buildId)
          .run();
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
          await env.DB.prepare("DELETE FROM kg_files WHERE repo_id = ? AND snapshot = ?")
            .bind(repoId, buildId)
            .run();
        }
        await env.DB.prepare(
          `INSERT INTO kg_state (repo_id, indexed_commit, indexed_at, last_build_id)
           VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)
           ON CONFLICT (repo_id) DO UPDATE SET indexed_commit = excluded.indexed_commit,
             indexed_at = excluded.indexed_at, last_build_id = excluded.last_build_id`,
        )
          .bind(repoId, head, buildId)
          .run();
      }
      await env.DB.prepare(
        `UPDATE kg_builds SET status = 'succeeded', phase = 'done', stats = json_patch(stats, ?),
           finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      )
        .bind(JSON.stringify(stats), buildId)
        .run();
      await coordinator(env, repoId).finished(buildId, true, null);
      return null;
    });
  }
}
