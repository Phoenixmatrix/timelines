// The knowledge API: what other features (and the wiki) build on.
//
//   GET  /status                 where the graph stands, live build progress
//   POST /rebuild                build now even if HEAD is indexed (admin)
//   GET  /graph?kind=&q=&limit=  nodes
//   GET  /graph/node?id=         one node with its neighbors
//   GET  /graph/export           the whole graph (nodes + edges)
//   GET  /graph/map              the whole graph, lean, for the atlas (ETag per graph version)
//   GET  /changes?build=         the change feed for a build (default: latest)
//   GET  /search?q=              entities (Vectorize) + passages (AI Search)
//   GET  /wiki                   the catalog
//   GET  /wiki/page?slug=        one page

import { Hono, type Context } from "hono";
import { sql, type Selectable } from "kysely";
import type {
  GraphLink,
  GraphNode,
  GraphNodeDetail,
  KnowledgeBuild,
  KnowledgeMap,
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
import { db, type Database } from "../schema.ts";
import { coordinator, notifyKnowledge } from "./coordinator.ts";
import { SEARCH_INSTANCE } from "./indexes.ts";
import { embed } from "./models.ts";

export const knowledge = new Hono<AppEnv>();

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const toBuild = (row: Selectable<Database["kg_builds"]>): KnowledgeBuild => ({
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

/** Changes when the stored graph does, or when a build lands (which moves the "changed" marks). */
const graphVersion = (
  state: { indexed_commit: string | null; graph_at: string | null } | undefined,
) => `${state?.indexed_commit ?? "none"}.${state?.graph_at ?? "none"}`;

const NODE_COLUMNS = ["id", "kind", "name", "path", "summary", "data", "changed_in"] as const;

type NodeRow = Pick<Selectable<Database["kg_nodes"]>, (typeof NODE_COLUMNS)[number]>;

const toNode = (row: NodeRow): GraphNode => ({
  id: row.id,
  kind: row.kind as GraphNode["kind"],
  name: row.name,
  path: row.path,
  summary: row.summary,
  data: JSON.parse(row.data) as Record<string, unknown>,
  changedIn: row.changed_in,
});

async function status(c: Context<AppEnv>, row: RepoRow): Promise<KnowledgeStatus> {
  const reader = new RepoReader(
    c.env,
    row.artifacts_name,
    row.artifacts_remote,
    c.get("timing"),
    (w) => c.executionCtx.waitUntil(w),
  );
  const [state, builds, counts, refs, coordination] = await Promise.all([
    db(c.env.DB)
      .selectFrom("kg_state")
      .select(["indexed_commit", "indexed_at", "graph_at"])
      .where("repo_id", "=", row.id)
      .executeTakeFirst(),
    db(c.env.DB)
      .selectFrom("kg_builds")
      .selectAll()
      .where("repo_id", "=", row.id)
      .orderBy("started_at", "desc")
      .limit(5)
      .execute(),
    db(c.env.DB)
      .selectFrom("kg_nodes")
      .select((eb) => ["kind", eb.fn.countAll<number>().as("n")])
      .where("repo_id", "=", row.id)
      .groupBy("kind")
      .execute(),
    reader.refs().catch(() => null),
    coordinator(c.env, row.id).status(),
  ]);
  await reader.close();
  const recent = builds.map(toBuild);
  const current = recent.find((b) => b.status === "running") ?? null;
  const head = refs?.head ?? null;
  const indexed = state?.indexed_commit ?? null;

  // A build of this very commit already failed; the next push tries again,
  // not every page view.
  const failedHere = recent[0]?.status === "failed" && recent[0].toCommit === head;

  // Repos that existed before the knowledge graph, or whose push we missed,
  // get built the first time someone looks.
  if (
    head &&
    head !== indexed &&
    !failedHere &&
    !current &&
    !coordination.running &&
    !coordination.pending
  ) {
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
          ? failedHere
            ? "failed"
            : "queued"
          : indexed
            ? "up-to-date"
            : "empty",
    graphVersion: graphVersion(state),
    current,
    recent,
    counts: Object.fromEntries(counts.map((r) => [r.kind, r.n])),
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
  if (!c.env.AI)
    return fail(c, 503, "Knowledge AI is disabled in this automatic test environment.");
  await notifyKnowledge(c.env, row.id, { force: true });
  return c.json(await status(c, row), 202);
});

knowledge.get("/graph", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const kind = c.req.query("kind");
  const q = c.req.query("q")?.trim();
  const limit = Math.min(500, Number(c.req.query("limit") ?? "100") || 100);
  let query = db(c.env.DB)
    .selectFrom("kg_nodes")
    .select(NODE_COLUMNS)
    .where("repo_id", "=", row.id);
  if (kind) query = query.where("kind", "=", kind);
  if (q) {
    query = query.where((eb) =>
      eb.or([
        eb("name", "like", `%${q}%`),
        eb("path", "like", `%${q}%`),
        eb("summary", "like", `%${q}%`),
      ]),
    );
  }
  const results = await query
    .orderBy("kind")
    .orderBy("path")
    .orderBy("name")
    .limit(limit)
    .execute();
  return c.json({ nodes: results.map(toNode) });
});

knowledge.get("/graph/node", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const id = c.req.query("id") ?? "";
  const node = await db(c.env.DB)
    .selectFrom("kg_nodes")
    .select(NODE_COLUMNS)
    .where("repo_id", "=", row.id)
    .where("id", "=", id)
    .executeTakeFirst();
  if (!node) return fail(c, 404, "No such node.");
  const links = async (direction: "out" | "in") => {
    const [self, other] =
      direction === "out" ? (["src", "dst"] as const) : (["dst", "src"] as const);
    const results = await db(c.env.DB)
      .selectFrom("kg_edges as e")
      .innerJoin("kg_nodes as n", (join) =>
        join.onRef("n.repo_id", "=", "e.repo_id").onRef("n.id", "=", `e.${other}`),
      )
      .select([
        "e.kind as edge_kind",
        "e.weight",
        "n.id",
        "n.kind",
        "n.name",
        "n.path",
        "n.summary",
      ])
      .where("e.repo_id", "=", row.id)
      .where(`e.${self}`, "=", id)
      .orderBy("e.kind")
      .orderBy("e.weight", "desc")
      .orderBy("n.name")
      .limit(300)
      .execute();
    return results.map((r): GraphLink => ({
      kind: r.edge_kind,
      weight: r.weight,
      node: {
        id: r.id,
        kind: r.kind as GraphNode["kind"],
        name: r.name,
        path: r.path,
        summary: r.summary,
      },
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
    db(c.env.DB)
      .selectFrom("kg_nodes")
      .select(NODE_COLUMNS)
      .where("repo_id", "=", row.id)
      .execute(),
    db(c.env.DB)
      .selectFrom("kg_edges")
      .select(["src", "dst", "kind", "weight"])
      .where("repo_id", "=", row.id)
      .execute(),
    db(c.env.DB)
      .selectFrom("kg_state")
      .select("indexed_commit")
      .where("repo_id", "=", row.id)
      .executeTakeFirst(),
  ]);
  return c.json({
    commit: state?.indexed_commit ?? null,
    nodes: nodes.map(toNode),
    edges,
  });
});

knowledge.get("/graph/map", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const state = await db(c.env.DB)
    .selectFrom("kg_state")
    .select(["indexed_commit", "graph_at"])
    .where("repo_id", "=", row.id)
    .executeTakeFirst();
  const commit = state?.indexed_commit ?? null;
  const version = graphVersion(state);
  // The map only changes when a build writes the graph, so a revalidation is usually free.
  const etag = `W/"map-${row.id}-${version}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", "private, no-cache");
  if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
  const [nodes, edges] = await Promise.all([
    db(c.env.DB)
      .selectFrom("kg_nodes")
      .select([
        "id",
        "kind",
        "name",
        "path",
        "changed_in",
        sql<
          number | null
        >`coalesce(json_extract(data, '$.lines'), json_extract(data, '$.line'))`.as("size"),
      ])
      .where("repo_id", "=", row.id)
      .orderBy("path")
      .orderBy("name")
      .execute(),
    db(c.env.DB)
      .selectFrom("kg_edges")
      .select(["src", "dst", "kind"])
      .where("repo_id", "=", row.id)
      .execute(),
  ]);
  const at = new Map(nodes.map((n, i) => [n.id, i]));
  const body: KnowledgeMap = {
    commit,
    version,
    nodes: nodes.map((n) => [
      n.id,
      n.kind as GraphNode["kind"],
      n.name,
      n.path,
      Number(n.size) || 0,
      commit && n.changed_in === commit ? 1 : 0,
    ]),
    edges: edges.flatMap((e) => {
      const a = at.get(e.src);
      const b = at.get(e.dst);
      return a === undefined || b === undefined ? [] : [[a, b, e.kind] as [number, number, string]];
    }),
  };
  return c.json(body);
});

knowledge.get("/changes", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const buildId =
    c.req.query("build") ??
    (
      await db(c.env.DB)
        .selectFrom("kg_builds")
        .select("id")
        .where("repo_id", "=", row.id)
        .where("status", "=", "succeeded")
        .orderBy("started_at", "desc")
        .limit(1)
        .executeTakeFirst()
    )?.id;
  if (!buildId) return c.json({ build: null, changes: [] });
  const [build, changes] = await Promise.all([
    db(c.env.DB)
      .selectFrom("kg_builds")
      .selectAll()
      .where("repo_id", "=", row.id)
      .where("id", "=", buildId)
      .executeTakeFirst(),
    db(c.env.DB)
      .selectFrom("kg_changes")
      .select(["node_id as node", "kind", "change"])
      .where("repo_id", "=", row.id)
      .where("build_id", "=", buildId)
      .orderBy("kind")
      .orderBy("node_id")
      .execute(),
  ]);
  return c.json({ build: build ? toBuild(build) : null, changes });
});

knowledge.get("/search", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  if (!c.env.AI)
    return fail(c, 503, "Knowledge AI is disabled in this automatic test environment.");
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
    const results = await db(c.env.DB)
      .selectFrom("kg_nodes")
      .select(["id", "kind", "name", "path", "summary"])
      .where("repo_id", "=", row.id)
      .where("id", "in", ids)
      .execute();
    const byId = new Map(results.map((r) => [r.id, r]));
    return matches.matches.flatMap((m) => {
      const node = byId.get(text(m.metadata?.node));
      return node ? [{ ...node, kind: node.kind as GraphNode["kind"], score: m.score }] : [];
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

type PageRow = Pick<
  Selectable<Database["wiki_pages"]>,
  "slug" | "title" | "section" | "position" | "node_id" | "updated_at"
>;

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
  const results = await db(c.env.DB)
    .selectFrom("wiki_pages")
    .select(["slug", "title", "section", "position", "node_id", "updated_at"])
    .where("repo_id", "=", row.id)
    .orderBy("position")
    .execute();
  const body: WikiCatalog = { pages: results.map(toSummary), status: await status(c, row) };
  return c.json(body);
});

knowledge.get("/wiki/page", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const page = await db(c.env.DB)
    .selectFrom("wiki_pages")
    .selectAll()
    .where("repo_id", "=", row.id)
    .where("slug", "=", c.req.query("slug") ?? "overview")
    .executeTakeFirst();
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
