// The knowledge API: what other features (and the wiki) build on.
//
//   GET  /status                 where the graph stands, live build progress
//   POST /rebuild                build now even if HEAD is indexed (admin)
//   GET  /graph?kind=&q=&limit=  nodes
//   GET  /graph/node?id=         one node with its neighbors
//   GET  /graph/export           the whole graph (nodes + edges), on explicit request only
//   GET  /changes?build=         the change feed for a build (default: latest)
//   GET  /search?q=              entities (Vectorize) + passages (AI Search)
//   GET  /wiki                   the catalog
//   GET  /wiki/page?slug=        one page
//   GET  /overlays               every timeline's graph diff against main, in brief,
//                                ended timelines' last ones included (read-only)
//   GET  /overlay?ref=timeline/<slug>&limit=   one timeline's diff, with its changes
//                                and its newest wiki page sets
//   GET  /overlay/pages?ref=timeline/<slug>[&checkpoint=]   its wiki page sets (CORE-84)
//   POST /overlay/pages?ref=timeline/<slug>[&checkpoint=]   write its pages now, at the
//                                bookmark's tip (or retry a checkpoint's failed set) (write)
//   GET  /overlay/page?ref=timeline/<slug>&slug=[&set=]     one timeline page in full

import { Hono, type Context } from "hono";
import type { Selectable } from "kysely";
import type {
  GraphLink,
  GraphNode,
  GraphNodeDetail,
  KnowledgeBuild,
  KnowledgeOverlay,
  KnowledgeOverlayChange,
  KnowledgeOverlaySummary,
  KnowledgePageSets,
  KnowledgeSearchResults,
  KnowledgeTimelinePage,
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
import { coordinator, notifyKnowledge, requestPages } from "./coordinator.ts";
import { PASSAGE_CANDIDATES, SEARCH_INSTANCE, selectPassages } from "./indexes.ts";
import { embed } from "./models.ts";
import { overlayRef, overlayState, setEndReason, timelineEnd } from "./overlay.ts";
import { commitKey, listSets, overlayEnded, timelinePage } from "./pages.ts";
import { timelineSlugOf } from "../../shared/timelines.ts";

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

async function repoOrFail(c: Context<AppEnv>, needed: "read" | "write" | "admin" = "read") {
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
        retrieval: {
          retrieval_type: "hybrid",
          max_num_results: PASSAGE_CANDIDATES,
          filters: { repo: row.id },
        },
        // Ordering only: selectPassages applies the relevance bar.
        reranking: { enabled: true, match_threshold: 0 },
        cache: { enabled: false },
      },
    });
    return selectPassages(result.chunks).map((chunk) => ({
      kind: (chunk.item.metadata?.kind === "wiki" ? "wiki" : "code") as "code" | "wiki",
      path: text(chunk.item.metadata?.path) || chunk.item.key,
      text: chunk.text,
      score: chunk.score,
    }));
  })();

  // The index's state, read directly: status() would also start a build.
  const index = (async () => {
    const [state, running] = await Promise.all([
      db(c.env.DB)
        .selectFrom("kg_state")
        .select("indexed_commit")
        .where("repo_id", "=", row.id)
        .executeTakeFirst(),
      db(c.env.DB)
        .selectFrom("kg_builds")
        .select("id")
        .where("repo_id", "=", row.id)
        .where("status", "=", "running")
        .executeTakeFirst(),
    ]);
    const indexedCommit = state?.indexed_commit ?? null;
    return {
      state: running
        ? ("building" as const)
        : indexedCommit
          ? ("ready" as const)
          : ("none" as const),
      indexedCommit,
    };
  })();

  const [e, p, i] = await Promise.allSettled([entities, passages, index]);
  for (const [name, result] of [
    ["entities", e],
    ["passages", p],
  ] as const)
    if (result.status === "rejected")
      console.error(`knowledge search: ${name} failed`, result.reason);
  const body: KnowledgeSearchResults = {
    query,
    entities: e.status === "fulfilled" ? e.value : [],
    passages: p.status === "fulfilled" ? p.value : [],
    providers: {
      entities: e.status === "fulfilled" ? "ok" : "failed",
      passages: p.status === "fulfilled" ? "ok" : "failed",
    },
    index: i.status === "fulfilled" ? i.value : { state: "ready", indexedCommit: null },
  };
  return c.json(body);
});

type PageRow = Pick<
  Selectable<Database["wiki_pages"]>,
  "slug" | "title" | "section" | "position" | "node_id" | "updated_at" | "generated_in"
>;

const toSummary = (r: PageRow): WikiPageSummary => ({
  slug: r.slug,
  title: r.title,
  section: r.section,
  position: r.position,
  nodeId: r.node_id,
  updatedAt: r.updated_at,
  generatedIn: r.generated_in,
});

knowledge.get("/wiki", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const results = await db(c.env.DB)
    .selectFrom("wiki_pages")
    .select(["slug", "title", "section", "position", "node_id", "updated_at", "generated_in"])
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

// ---- timeline overlays --------------------------------------------------------

const OVERLAY_KINDS = ["component", "concept", "file", "symbol", "package"];
/**
 * An overlay that ended before the tracker said why (a landing that finished
 * after its bookmark went) is asked again for this long, a few per request.
 */
const RECHECK_ENDED_MS = 2 * 24 * 60 * 60 * 1000;
const RECHECK_ENDED = 5;

type OverlayRow = Selectable<Database["kg_overlays"]>;

/** Ask the tracker again why recently ended overlays ended, and keep the answer. */
async function recheckEnded(c: Context<AppEnv>, row: RepoRow, rows: OverlayRow[]) {
  const since = Date.now() - RECHECK_ENDED_MS;
  const unsure = rows
    .filter((r) => r.ended_reason === "ended" && Date.parse(r.ended_at ?? "") > since)
    .slice(0, RECHECK_ENDED);
  await Promise.all(
    unsure.map(async (r) => {
      const reason = await timelineEnd(c.env, row.owner_id, r.ref);
      if (!reason) return;
      r.ended_reason = reason;
      await setEndReason(c.env.DB, row.id, r.ref, reason);
    }),
  );
}

/** Where each timeline's overlay stands, for every bookmark or just `only`. */
async function overlaySummaries(
  c: Context<AppEnv>,
  row: RepoRow,
  only?: string,
): Promise<{ summary: KnowledgeOverlaySummary; overlayId: string | null; stored: number }[]> {
  const reader = new RepoReader(
    c.env,
    row.artifacts_name,
    row.artifacts_remote,
    c.get("timing"),
    (w) => c.executionCtx.waitUntil(w),
  );
  let query = db(c.env.DB).selectFrom("kg_overlays").selectAll().where("repo_id", "=", row.id);
  if (only) query = query.where("ref", "=", only);
  const [refs, rows, state, coordination] = await Promise.all([
    reader.refs().catch(() => null),
    query.execute(),
    db(c.env.DB)
      .selectFrom("kg_state")
      .select("indexed_commit")
      .where("repo_id", "=", row.id)
      .executeTakeFirst(),
    c.env.AI ? coordinator(c.env, row.id).status() : null,
  ]);
  await reader.close();
  await recheckEnded(c, row, rows);
  const indexed = state?.indexed_commit ?? null;
  const tips = new Map(
    (refs?.branches ?? [])
      .filter((b) => timelineSlugOf(b.name) && (!only || b.name === only))
      .map((b) => [b.name, b.oid]),
  );
  const byRef = new Map(rows.map((r) => [r.ref, r]));
  let stale = false;
  const out = [...new Set([...tips.keys(), ...byRef.keys()])].sort().map((ref) => {
    const head = tips.get(ref) ?? null;
    const stored = byRef.get(ref);
    const stats = JSON.parse(stored?.stats ?? "{}") as {
      counts?: KnowledgeOverlaySummary["counts"];
      stored?: number;
    };
    const running = Boolean(coordination?.overlays[ref]?.running);
    const state = overlayState(stored, head, indexed, running);
    if (state === "queued" && head) stale = true;
    return {
      overlayId: stored?.overlay_id ?? null,
      stored: stats.stored ?? 0,
      summary: {
        ref: ref.replace(/^refs\/heads\//, ""),
        timeline: timelineSlugOf(ref) ?? ref,
        head,
        commit: stored?.head_commit ?? null,
        baseCommit: stored?.base_commit ?? null,
        mergeBase: stored?.merge_base ?? null,
        state,
        counts: stats.counts ?? {},
        updatedAt: stored?.updated_at ?? null,
        error: stored?.status === "failed" ? stored.error : null,
        ended: stored?.ended_at
          ? { reason: stored.ended_reason ?? "ended", at: stored.ended_at }
          : null,
      },
    };
  });
  // A bookmark pushed before overlays existed, or a missed ping: compare it now.
  if (stale && coordination && !coordination.overlayScanPending)
    c.executionCtx.waitUntil(notifyKnowledge(c.env, row.id));
  return out;
}

knowledge.get("/overlays", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const list = await overlaySummaries(c, row);
  return c.json({ overlays: list.map((o) => o.summary) });
});

knowledge.get("/overlay", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const ref = overlayRef(c.req.query("ref") ?? "");
  if (!ref) return fail(c, 400, "Pass ref=timeline/<slug>.");
  const limit = Math.min(2000, Math.max(1, Number(c.req.query("limit") ?? "500") || 500));
  const [found] = await overlaySummaries(c, row, ref);
  if (!found) return fail(c, 404, "No such timeline bookmark.");
  const rows = found.overlayId
    ? await db(c.env.DB)
        .selectFrom("kg_overlay_changes")
        .select(["node_id", "kind", "change", "name", "path", "summary", "detail"])
        .where("repo_id", "=", row.id)
        .where("overlay_id", "=", found.overlayId)
        .execute()
    : [];
  const rank = (kind: string) => {
    const i = OVERLAY_KINDS.indexOf(kind);
    return i === -1 ? OVERLAY_KINDS.length : i;
  };
  const changes = rows
    .map((r): KnowledgeOverlayChange => {
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
    .sort(
      (a, b) =>
        rank(a.kind) - rank(b.kind) ||
        (a.path ?? "").localeCompare(b.path ?? "") ||
        a.name.localeCompare(b.name),
    );
  const totalChanges = Object.values(found.summary.counts).reduce(
    (n, k) => n + k.added + k.changed + k.removed,
    0,
  );
  const body: KnowledgeOverlay = {
    ...found.summary,
    changes: changes.slice(0, limit),
    truncated: changes.length > limit || totalChanges > found.stored,
    pageSets: await listSets(c.env.DB, row.id, ref, { limit: 5 }),
  };
  return c.json(body);
});

// ---- timeline wiki pages (CORE-84) ---------------------------------------------

knowledge.get("/overlay/pages", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const ref = overlayRef(c.req.query("ref") ?? "");
  if (!ref) return fail(c, 400, "Pass ref=timeline/<slug>.");
  const key = c.req.query("checkpoint") || undefined;
  const [sets, ended] = await Promise.all([
    listSets(c.env.DB, row.id, ref, { key }),
    overlayEnded(c.env.DB, row.id, ref),
  ]);
  const body: KnowledgePageSets = {
    ref: ref.replace(/^refs\/heads\//, ""),
    timeline: timelineSlugOf(ref) ?? ref,
    ended,
    sets,
  };
  return c.json(body);
});

knowledge.post("/overlay/pages", async (c) => {
  const row = await repoOrFail(c, "write");
  if (row instanceof Response) return row;
  if (!c.env.AI)
    return fail(c, 503, "Knowledge AI is disabled in this automatic test environment.");
  const ref = overlayRef(c.req.query("ref") ?? "");
  if (!ref) return fail(c, 400, "Pass ref=timeline/<slug>.");
  if (await overlayEnded(c.env.DB, row.id, ref))
    return fail(c, 409, "This timeline has ended: its pages are kept read-only.");
  const checkpoint = c.req.query("checkpoint");
  let request: Parameters<typeof requestPages>[1];
  if (checkpoint) {
    // A checkpoint's set is queued when the checkpoint is made; asking again retries a failed one.
    const [set] = await listSets(c.env.DB, row.id, ref, { key: checkpoint, limit: 1 });
    if (!set) return fail(c, 404, "No pages were asked for at that checkpoint.");
    request = {
      repoId: row.id,
      ref,
      key: set.key,
      commit: set.commit,
      checkpoint: set.checkpoint && { id: set.checkpoint.id, number: set.checkpoint.number ?? 0 },
      requestedBy: c.get("actor")?.id ?? null,
    };
  } else {
    const reader = new RepoReader(
      c.env,
      row.artifacts_name,
      row.artifacts_remote,
      c.get("timing"),
      (w) => c.executionCtx.waitUntil(w),
    );
    const refs = await reader.refs().finally(() => reader.close());
    const tip = refs.branches.find((b) => b.name === ref)?.oid;
    if (!tip) return fail(c, 404, "No such timeline bookmark.");
    request = {
      repoId: row.id,
      ref,
      key: commitKey(tip),
      commit: tip,
      checkpoint: null,
      requestedBy: c.get("actor")?.id ?? null,
    };
  }
  await requestPages(c.env, request);
  const [set] = await listSets(c.env.DB, row.id, ref, { key: request.key, limit: 1 });
  return c.json(set, 202);
});

knowledge.get("/overlay/page", async (c) => {
  const row = await repoOrFail(c);
  if (row instanceof Response) return row;
  const ref = overlayRef(c.req.query("ref") ?? "");
  if (!ref) return fail(c, 400, "Pass ref=timeline/<slug>.");
  const found = await timelinePage(
    c.env.DB,
    row.id,
    ref,
    c.req.query("slug") ?? "",
    c.req.query("set") || undefined,
  );
  if (!found) return fail(c, 404, "This timeline has no such page.");
  const { page, set } = found;
  const { pages: _pages, counts: _counts, ...brief } = set;
  const body: KnowledgeTimelinePage = {
    slug: page.slug,
    title: page.title,
    section: page.section,
    position: page.position,
    nodeId: page.node_id,
    updatedAt: page.updated_at,
    body: page.body,
    diagram: page.diagram,
    sources: JSON.parse(page.sources) as string[],
    generatedIn: set.commit,
    model: page.model,
    timeline: set.timeline,
    set: brief,
    kind: page.kind,
    change: page.change,
    outcome: page.outcome,
  };
  return c.json(body);
});
