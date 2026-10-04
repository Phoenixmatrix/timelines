// The one-off orphan sweep (CORE-199): what repositories deleted before the
// purge pipeline existed left behind. Their rows are gone, so their ids come
// from what still names them:
//
// - search: AI Search items, whose keys start `${repoId}/` (and whose metadata
//   says `repo`), listed page by page;
// - sources: atlas_spend, do_instances, and the registry's package_sources
//   and publishes, for repository ids no repos row has.
//
// Each unknown id becomes a repo_deletions row (`source = 'orphan-sweep'`)
// and goes through the purge phases that need no repository row (repo-
// deletion.ts): its coordinator, vectors (Vectorize's metadata filter on
// `repo`), search items, Durable Objects and links. Last:
//
// - artifacts: Artifacts repositories no repos row names, created more than
//   a day ago (a repository being created has its Artifacts repository a
//   moment before its row), are deleted.
//
// Vectorize can't be listed from a Worker, so vectors of a deleted repository
// that nothing else names can't be found: the sweep records the index's
// vector count beside the count live repositories account for, so the
// difference is known. Bounded per call and resumable (job_cursors
// `repo-orphans`); once done it does nothing. Only where the providers'
// namespaces are this deployment's own: production's cron, or an isolated
// agent environment's /api/dev/repo-orphans.

import { db, nowIso } from "../schema.ts";
import { SEARCH_INSTANCE } from "../knowledge/indexes.ts";
import { launchPurge } from "./repo-deletion.ts";

const CURSOR = "repo-orphans";
const REPO_ID = /^[A-Za-z0-9_-]{1,100}$/;
const EMBEDDED_KINDS = ["repository", "file", "symbol", "component", "concept"];

export interface OrphanSweep {
  stage: "search" | "sources" | "artifacts" | "launch" | "done";
  /** The next AI Search page (1-based). */
  page: number;
  artifactsCursor?: string;
  /** Unknown repository ids found, and Artifacts repositories deleted. */
  orphans: number;
  artifacts: number;
  /** The first Artifacts repositories it deleted, for the record (at most 50). */
  deletedArtifacts?: string[];
  /** Vectors in the index, and how many the live repositories' graphs account for. */
  vectors?: { indexed: number; expected: number };
  startedAt: string;
  finishedAt?: string;
}

export const ORPHAN_LIMITS = {
  /** AI Search items per page (its most), and pages per call. */
  perPage: 50,
  pages: 40,
  /** Artifacts repositories per page, and pages per call. */
  artifactsPerPage: 200,
  artifactsPages: 10,
  /** Artifacts repositories younger than this are never touched. */
  minAgeMs: 24 * 60 * 60_000,
  /** Orphan purges started per call (the cron restarts the rest). */
  launches: 50,
};

async function load(env: Env): Promise<OrphanSweep> {
  const row = await db(env.DB)
    .selectFrom("job_cursors")
    .select("cursor")
    .where("name", "=", CURSOR)
    .executeTakeFirst();
  if (row?.cursor) {
    try {
      return JSON.parse(row.cursor) as OrphanSweep;
    } catch {
      // Start over.
    }
  }
  return { stage: "search", page: 1, orphans: 0, artifacts: 0, startedAt: nowIso() };
}

async function save(env: Env, state: OrphanSweep): Promise<void> {
  const cursor = JSON.stringify(state);
  await db(env.DB)
    .insertInto("job_cursors")
    .values({ name: CURSOR, cursor, updated_at: nowIso() })
    .onConflict((oc) => oc.column("name").doUpdateSet({ cursor, updated_at: nowIso() }))
    .execute();
}

/** Forget the sweep's state, so it runs again (development and tests). */
export async function resetOrphanSweep(env: Env): Promise<void> {
  await db(env.DB).deleteFrom("job_cursors").where("name", "=", CURSOR).execute();
}

/** Of these repository ids, the ones nothing knows: no repos row, no deletion. */
async function unknownIds(env: Env, ids: string[]): Promise<string[]> {
  const candidates = [...new Set(ids.filter((id) => REPO_ID.test(id)))];
  const unknown: string[] = [];
  for (let i = 0; i < candidates.length; i += 50) {
    const chunk = candidates.slice(i, i + 50);
    const marks = chunk.map(() => "?").join(",");
    const { results } = await env.DB.prepare(
      `SELECT id FROM repos WHERE id IN (${marks})
       UNION SELECT repo_id FROM repo_deletions WHERE repo_id IN (${marks})`,
    )
      .bind(...chunk, ...chunk)
      .all<{ id: string }>();
    const known = new Set(results.map((r) => r.id));
    unknown.push(...chunk.filter((id) => !known.has(id)));
  }
  return unknown;
}

/** Record unknown ids as orphan deletions (the purge picks them up). */
async function register(env: Env, ids: string[]): Promise<number> {
  let added = 0;
  // Old updated_at: the cron's resumeDeletions starts any this call doesn't.
  for (const id of ids) {
    const result = await env.DB.prepare(
      `INSERT INTO repo_deletions
         (repo_id, owner_id, full_name, source, requested_at, phase, updated_at)
       VALUES (?1, '', '', 'orphan-sweep', ?2, 'stop', '1970-01-01T00:00:00.000Z')
       ON CONFLICT (repo_id) DO NOTHING`,
    )
      .bind(id, nowIso())
      .run();
    added += result.meta.changes ?? 0;
  }
  return added;
}

/** The repository id an AI Search item belongs to. */
function itemRepo(item: AiSearchItemInfo): string | null {
  const repo = item.metadata?.repo;
  if (typeof repo === "string" && repo) return repo;
  const slash = item.key.indexOf("/");
  return slash > 0 ? item.key.slice(0, slash) : null;
}

async function searchStage(
  env: Env,
  state: OrphanSweep,
  limits: typeof ORPHAN_LIMITS,
): Promise<void> {
  if (!env.SEARCH) {
    state.stage = "sources";
    return;
  }
  const items = env.SEARCH.get(SEARCH_INSTANCE).items;
  for (let n = 0; n < limits.pages; n++) {
    const page = await items.list({ page: state.page, per_page: limits.perPage });
    const ids = page.result.map(itemRepo).filter((id): id is string => Boolean(id));
    state.orphans += await register(env, await unknownIds(env, ids));
    if (page.result.length < limits.perPage) {
      state.stage = "sources";
      return;
    }
    state.page++;
  }
}

async function sourcesStage(env: Env, state: OrphanSweep): Promise<void> {
  const { results: local } = await env.DB.prepare(
    `SELECT DISTINCT repo_id AS id FROM atlas_spend WHERE repo_id IS NOT NULL
     UNION SELECT DISTINCT repo_id FROM do_instances WHERE repo_id IS NOT NULL AND purged_at IS NULL
     UNION SELECT name FROM do_instances WHERE class = 'KnowledgeCoordinator' AND purged_at IS NULL`,
  ).all<{ id: string }>();
  const { results: registry } = await env.REGISTRY_DB.prepare(
    `SELECT DISTINCT git_repo_id AS id FROM package_sources
     UNION SELECT DISTINCT git_repo_id FROM publishes WHERE git_repo_id IS NOT NULL`,
  ).all<{ id: string }>();
  const ids = [...local, ...registry].map((row) => row.id);
  state.orphans += await register(env, await unknownIds(env, ids));
  if (env.VECTORS) {
    const info = (await env.VECTORS.describe()) as Partial<VectorizeIndexInfo> &
      Partial<VectorizeIndexDetails>;
    const expected = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM kg_nodes
        WHERE kind IN (${EMBEDDED_KINDS.map(() => "?").join(",")}) AND summary != ''`,
    )
      .bind(...EMBEDDED_KINDS)
      .first<{ n: number }>();
    state.vectors = {
      indexed: info.vectorCount ?? info.vectorsCount ?? 0,
      expected: expected?.n ?? 0,
    };
  }
  state.stage = "artifacts";
}

async function artifactsStage(
  env: Env,
  state: OrphanSweep,
  limits: typeof ORPHAN_LIMITS,
  now: number,
): Promise<void> {
  for (let n = 0; n < limits.artifactsPages; n++) {
    const page = await env.ARTIFACTS.list({
      limit: limits.artifactsPerPage,
      ...(state.artifactsCursor ? { cursor: state.artifactsCursor } : {}),
    });
    const old = page.repos.filter(
      (repo) => now - Date.parse(repo.createdAt) > limits.minAgeMs && repo.name,
    );
    // D1 binds at most 100 parameters a statement.
    for (let i = 0; i < old.length; i += 30) {
      const names = old.slice(i, i + 30).map((repo) => repo.name);
      const marks = names.map(() => "?").join(",");
      const { results } = await env.DB.prepare(
        `SELECT artifacts_name AS name FROM repos WHERE artifacts_name IN (${marks})
         UNION SELECT artifacts_name FROM repo_deletions
          WHERE artifacts_name IN (${marks}) AND finished_at IS NULL
         UNION SELECT artifacts_name FROM timeline_work_sources
          WHERE artifacts_name IN (${marks})`,
      )
        .bind(...names, ...names, ...names)
        .all<{ name: string }>();
      const known = new Set(results.map((r) => r.name));
      for (const name of names)
        if (!known.has(name) && (await env.ARTIFACTS.delete(name))) {
          state.artifacts++;
          if ((state.deletedArtifacts ??= []).length < 50) state.deletedArtifacts.push(name);
        }
    }
    if (!page.cursor) {
      state.stage = "launch";
      return;
    }
    state.artifactsCursor = page.cursor;
  }
}

async function launchStage(
  env: Env,
  state: OrphanSweep,
  limits: typeof ORPHAN_LIMITS,
  waitUntil: (work: Promise<unknown>) => void,
): Promise<void> {
  const rows = await db(env.DB)
    .selectFrom("repo_deletions")
    .select("repo_id")
    .where("source", "=", "orphan-sweep")
    .where("finished_at", "is", null)
    .where("workflow_id", "is", null)
    .where("attempts", "=", 0)
    .limit(limits.launches)
    .execute();
  for (const row of rows) await launchPurge(env, row.repo_id, waitUntil);
  if (rows.length < limits.launches) {
    state.stage = "done";
    state.finishedAt = nowIso();
  }
}

/** One bounded call of the sweep; its state after. */
export async function sweepRepoOrphans(
  env: Env,
  options: {
    waitUntil: (work: Promise<unknown>) => void;
    now?: number;
    limits?: Partial<typeof ORPHAN_LIMITS>;
  },
): Promise<OrphanSweep> {
  const limits = { ...ORPHAN_LIMITS, ...options.limits };
  const state = await load(env);
  if (state.stage === "done") return state;
  try {
    if (state.stage === "search") await searchStage(env, state, limits);
    if (state.stage === "sources") await sourcesStage(env, state);
    if (state.stage === "artifacts")
      await artifactsStage(env, state, limits, options.now ?? Date.now());
    if (state.stage === "launch") await launchStage(env, state, limits, options.waitUntil);
  } finally {
    await save(env, state);
  }
  return state;
}

/** Whether the cron sweeps here: only production owns its providers' namespaces outright. */
export function sweepsOrphans(env: Env): boolean {
  return Reflect.get(env, "DEV_MODE") !== "true" && Reflect.get(env, "PREVIEW_MODE") !== "true";
}

/**
 * Orphans as a repository deleted before the purge existed left them
 * (development: the E2E plants them, then sweeps): an AI Search item and a
 * vector naming a repository id no row has, and an Artifacts repository no
 * row names.
 */
export async function plantOrphans(env: Env): Promise<{
  repoId: string;
  artifactsName: string;
  itemId: string | null;
  vectorId: string | null;
}> {
  const repoId = `repo_orphan_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const artifactsName = `r-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  await env.ARTIFACTS.create(artifactsName, { setDefaultBranch: "main" });
  let itemId: string | null = null;
  if (env.SEARCH) {
    const item = await env.SEARCH.get(SEARCH_INSTANCE).items.upload(
      `${repoId}/file:orphan.md`,
      "# orphan.md\n\nLeft behind by a repository deleted before its purge existed.\n",
      { metadata: { repo: repoId, kind: "code", path: "orphan.md", commit: "", lang: "markdown" } },
    );
    itemId = item.id;
  }
  let vectorId: string | null = null;
  if (env.VECTORS) {
    const info = (await env.VECTORS.describe()) as Partial<VectorizeIndexInfo> &
      Partial<VectorizeIndexDetails>;
    const config = info.config as { dimensions?: number } | undefined;
    const dimensions = info.dimensions ?? config?.dimensions ?? 0;
    vectorId = `orphan-${repoId}`;
    await env.VECTORS.upsert([
      {
        id: vectorId,
        values: Array.from({ length: dimensions }, (_, i) => Math.sin(i + 1)),
        metadata: { repo: repoId, kind: "file", node: "file:orphan.md", path: "orphan.md" },
      },
    ]);
  }
  return { repoId, artifactsName, itemId, vectorId };
}
