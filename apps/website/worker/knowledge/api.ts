// The knowledge API: what other features (and the wiki) build on.
//
//   GET  /status                 where the graph stands, live build progress
//   POST /rebuild                build now even if HEAD is indexed (admin)
//   GET  /graph?kind=&q=&limit=  nodes
//   GET  /graph/node?id=         one node with its neighbors
//   GET  /graph/export           the whole graph (nodes + edges)
//   GET  /changes?build=         the change feed for a build (default: latest)
//   GET  /search?q=              entities (Vectorize) + passages (AI Search)
//   GET  /wiki                   the catalog
//   GET  /wiki/page?slug=        one page

import { Hono, type Context } from "hono";
import type {
  GraphLink,
  GraphNode,
  GraphNodeDetail,
  KnowledgeBuild,
  KnowledgeSearchResults,
  KnowledgeStatus,
  WikiCatalog,
  WikiPage,
  WikiPageSummary,
} from "../../shared/api.ts";
import { fail } from "../api/http.ts";
import { loadRepo } from "../api/repos.ts";
import type { AppEnv } from "../auth.ts";
import type { RepoRow } from "../db.ts";
import { RepoReader } from "../objects.ts";
import { coordinator, notifyKnowledge } from "./coordinator.ts";
import { SEARCH_INSTANCE } from "./indexes.ts";
import { embed } from "./models.ts";

export const knowledge = new Hono<AppEnv>();

const text = (value: unknown): string => (typeof value === "string" ? value : "");

interface BuildRow {
  id: string;
  from_commit: string | null;
  to_commit: string;
  status: KnowledgeBuild["status"];
  phase: string;
  stats: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const toBuild = (row: BuildRow): KnowledgeBuild => ({
  id: row.id,
  fromCommit: row.from_commit,
  toCommit: row.to_commit,
  status: row.status,
  phase: row.phase,
  stats: JSON.parse(row.stats) as Record<string, unknown>,
  error: row.error,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
});

interface NodeRow {
  id: string;
  kind: GraphNode["kind"];
  name: string;
  path: string | null;
  summary: string;
  data: string;
  changed_in: string;
}

const toNode = (row: NodeRow): GraphNode => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  path: row.path,
  summary: row.summary,
  data: JSON.parse(row.data) as Record<string, unknown>,
  changedIn: row.changed_in,
});

async function status(c: Context<AppEnv>, row: RepoRow): Promise<KnowledgeStatus> {
  const db = c.env.DB;
  const reader = new RepoReader(
    c.env,
    row.artifacts_name,
    row.artifacts_remote,
    c.get("timing"),
    (w) => c.executionCtx.waitUntil(w),
  );
  const [state, builds, counts, refs, coordination] = await Promise.all([
    db
      .prepare("SELECT indexed_commit, indexed_at FROM kg_state WHERE repo_id = ?")
      .bind(row.id)
      .first<{ indexed_commit: string; indexed_at: string }>(),
    db
      .prepare("SELECT * FROM kg_builds WHERE repo_id = ? ORDER BY started_at DESC LIMIT 5")
      .bind(row.id)
      .all<BuildRow>(),
    db
      .prepare("SELECT kind, count(*) AS n FROM kg_nodes WHERE repo_id = ? GROUP BY kind")
      .bind(row.id)
      .all<{ kind: string; n: number }>(),
    reader.refs().catch(() => null),
    coordinator(c.env, row.id).status(),
  ]);
  await reader.close();
  const recent = builds.results.map(toBuild);
  const current = recent.find((b) => b.status === "running") ?? null;
  const head = refs?.head ?? null;
  const indexed = state?.indexed_commit ?? null;

  // Repos that existed before the knowledge graph, or whose push we missed,
  // get built the first time someone looks.
  if (head && head !== indexed && !current && !coordination.running && !coordination.pending) {
    c.executionCtx.waitUntil(notifyKnowledge(c.env, row.id));
  }
  return {
    indexedCommit: indexed,
    indexedAt: state?.indexed_at ?? null,
    head,
    state:
      current || coordination.running
        ? "building"
        : head && head !== indexed
          ? recent[0]?.status === "failed" && recent[0].toCommit === head
            ? "failed"
            : "queued"
          : indexed
            ? "up-to-date"
            : "empty",
    current,
    recent,
    counts: Object.fromEntries(counts.results.map((r) => [r.kind, r.n])),
  };
}

async function repoOrFail(c: Context<AppEnv>, needed: "read" | "admin" = "read") {
  const loaded = await loadRepo(c, needed);
  return loaded instanceof Response ? loaded : loaded.row;
}

knowledge.get("/status", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  return c.json(await status(c, row));
});

knowledge.post("/rebuild", async (c) => {
  const row = await repoOrFail(c, "admin");
  if (row instanceof Response) return row;
  await notifyKnowledge(c.env, row.id, { force: true });
  return c.json(await status(c, row), 202);
});

knowledge.get("/graph", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const kind = c.req.query("kind");
  const q = c.req.query("q")?.trim();
  const limit = Math.min(500, Number(c.req.query("limit") ?? "100") || 100);
  const where = ["repo_id = ?"];
  const binds: unknown[] = [row.id];
  if (kind) {
    where.push("kind = ?");
    binds.push(kind);
  }
  if (q) {
    where.push("(name LIKE ? OR path LIKE ? OR summary LIKE ?)");
    binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, name, path, summary, data, changed_in FROM kg_nodes WHERE ${where.join(" AND ")}
     ORDER BY kind, path, name LIMIT ?`,
  )
    .bind(...binds, limit)
    .all<NodeRow>();
  return c.json({ nodes: results.map(toNode) });
});

knowledge.get("/graph/node", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const id = c.req.query("id") ?? "";
  const node = await c.env.DB.prepare(
    "SELECT id, kind, name, path, summary, data, changed_in FROM kg_nodes WHERE repo_id = ? AND id = ?",
  )
    .bind(row.id, id)
    .first<NodeRow>();
  if (!node) return fail(c, 404, "No such node.");
  const links = async (direction: "out" | "in") => {
    const [self, other] = direction === "out" ? ["src", "dst"] : ["dst", "src"];
    const { results } = await c.env.DB.prepare(
      `SELECT e.kind AS edge_kind, e.weight, n.id, n.kind, n.name, n.path, n.summary
       FROM kg_edges e JOIN kg_nodes n ON n.repo_id = e.repo_id AND n.id = e.${other}
       WHERE e.repo_id = ? AND e.${self} = ? ORDER BY e.kind, e.weight DESC, n.name LIMIT 300`,
    )
      .bind(row.id, id)
      .all<{ edge_kind: string; weight: number } & Omit<NodeRow, "data" | "changed_in">>();
    return results.map((r): GraphLink => ({
      kind: r.edge_kind,
      weight: r.weight,
      node: { id: r.id, kind: r.kind, name: r.name, path: r.path, summary: r.summary },
    }));
  };
  const [outgoing, incoming] = await Promise.all([links("out"), links("in")]);
  const body: GraphNodeDetail = { node: toNode(node), outgoing, incoming };
  return c.json(body);
});

knowledge.get("/graph/export", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const [nodes, edges, state] = await Promise.all([
    c.env.DB.prepare(
      "SELECT id, kind, name, path, summary, data, changed_in FROM kg_nodes WHERE repo_id = ?",
    )
      .bind(row.id)
      .all<NodeRow>(),
    c.env.DB.prepare("SELECT src, dst, kind, weight FROM kg_edges WHERE repo_id = ?")
      .bind(row.id)
      .all(),
    c.env.DB.prepare("SELECT indexed_commit FROM kg_state WHERE repo_id = ?")
      .bind(row.id)
      .first<{ indexed_commit: string }>(),
  ]);
  return c.json({
    commit: state?.indexed_commit ?? null,
    nodes: nodes.results.map(toNode),
    edges: edges.results,
  });
});

knowledge.get("/changes", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const buildId =
    c.req.query("build") ??
    (
      await c.env.DB.prepare(
        "SELECT id FROM kg_builds WHERE repo_id = ? AND status = 'succeeded' ORDER BY started_at DESC LIMIT 1",
      )
        .bind(row.id)
        .first<{ id: string }>()
    )?.id;
  if (!buildId) return c.json({ build: null, changes: [] });
  const [build, changes] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM kg_builds WHERE repo_id = ? AND id = ?")
      .bind(row.id, buildId)
      .first<BuildRow>(),
    c.env.DB.prepare(
      "SELECT node_id AS node, kind, change FROM kg_changes WHERE repo_id = ? AND build_id = ? ORDER BY kind, node_id",
    )
      .bind(row.id, buildId)
      .all(),
  ]);
  return c.json({ build: build ? toBuild(build) : null, changes: changes.results });
});

knowledge.get("/search", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const query = c.req.query("q")?.trim() ?? "";
  if (!query) return fail(c, 400, "Pass a query: ?q=…");
  const kinds = c.req.query("kinds")?.split(",").filter(Boolean);

  const entities = (async () => {
    const [vector] = await embed(c.env, [query]);
    const matches = await c.env.VECTORS.query(vector as number[], {
      topK: 12,
      filter: { repo: row.id, ...(kinds?.length ? { kind: { $in: kinds } } : {}) },
      returnMetadata: "all",
    });
    const ids = matches.matches.map((m) => text(m.metadata?.node));
    if (!ids.length) return [];
    const { results } = await c.env.DB.prepare(
      `SELECT id, kind, name, path, summary FROM kg_nodes WHERE repo_id = ? AND id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(row.id, ...ids)
      .all<Omit<NodeRow, "data" | "changed_in">>();
    const byId = new Map(results.map((r) => [r.id, r]));
    return matches.matches.flatMap((m) => {
      const node = byId.get(text(m.metadata?.node));
      return node ? [{ ...node, score: m.score }] : [];
    });
  })();

  const passages = (async () => {
    const result = await c.env.SEARCH.get(SEARCH_INSTANCE).search({
      query,
      ai_search_options: {
        retrieval: { retrieval_type: "hybrid", max_num_results: 10, filters: { repo: row.id } },
        reranking: { enabled: true },
        cache: { enabled: false },
      },
    });
    return result.chunks.map((chunk) => ({
      kind: (chunk.item.metadata?.kind === "wiki" ? "wiki" : "code") as "code" | "wiki",
      path: text(chunk.item.metadata?.path) || chunk.item.key,
      text: chunk.text,
      score: chunk.score,
    }));
  })();

  const [e, p] = await Promise.allSettled([entities, passages]);
  const body: KnowledgeSearchResults = {
    query,
    entities: e.status === "fulfilled" ? e.value : [],
    passages: p.status === "fulfilled" ? p.value : [],
  };
  return c.json(body);
});

interface PageRow {
  slug: string;
  title: string;
  section: string;
  position: number;
  node_id: string | null;
  updated_at: string;
}

const toSummary = (r: PageRow): WikiPageSummary => ({
  slug: r.slug,
  title: r.title,
  section: r.section,
  position: r.position,
  nodeId: r.node_id,
  updatedAt: r.updated_at,
});

knowledge.get("/wiki", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const { results } = await c.env.DB.prepare(
    "SELECT slug, title, section, position, node_id, updated_at FROM wiki_pages WHERE repo_id = ? ORDER BY position",
  )
    .bind(row.id)
    .all<PageRow>();
  const body: WikiCatalog = { pages: results.map(toSummary), status: await status(c, row) };
  return c.json(body);
});

knowledge.get("/wiki/page", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const page = await c.env.DB.prepare("SELECT * FROM wiki_pages WHERE repo_id = ? AND slug = ?")
    .bind(row.id, c.req.query("slug") ?? "overview")
    .first<
      PageRow & {
        body: string;
        diagram: string;
        sources: string;
        generated_in: string;
        model: string | null;
      }
    >();
  if (!page) return fail(c, 404, "No such page yet.");
  const body: WikiPage = {
    ...toSummary(page),
    body: page.body,
    diagram: page.diagram,
    sources: JSON.parse(page.sources) as string[],
    generatedIn: page.generated_in,
    model: page.model,
  };
  return c.json(body);
});
