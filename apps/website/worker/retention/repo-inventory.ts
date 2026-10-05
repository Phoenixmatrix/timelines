// What a repository holds in every store (CORE-199): the before/after
// inventory repository deletion is verified with, in tests and in the real
// runtime (/api/dev/repo-inventory). It reads; it deletes nothing.

import { instanceStorage } from "../durable/registry.ts";
import type { StorageReport } from "../durable/contract.ts";
import type { DurableClass } from "../durable/classes.ts";
import { isArtifactsError } from "../artifacts.ts";
import { deletionStatus, repoSearchItems, repoVectorIds } from "./repo-deletion.ts";

/**
 * Every gitmatrix table with a repo_id column (a test holds this to the
 * migrations), and those that reach a repository through another table.
 */
export const REPO_TABLES = [
  "atlas_feed",
  "atlas_scopes",
  "atlas_spend",
  "atlas_timeline_regroupings",
  "change_refs",
  "ci_jobs",
  "ci_refs",
  "ci_runs",
  "ci_secrets",
  "deployments",
  "do_instances",
  "kg_builds",
  "kg_changes",
  "kg_concept_links",
  "kg_concept_pairs",
  "kg_concept_reviews",
  "kg_concepts",
  "kg_edges",
  "kg_files",
  "kg_nodes",
  "kg_overlay_changes",
  "kg_overlays",
  "kg_page_set_pages",
  "kg_page_sets",
  "kg_search_items",
  "kg_state",
  "merge_queue",
  "ref_updates",
  "release_note_entries",
  "release_note_mentions",
  "release_note_state",
  "release_notes",
  "repo_collaborators",
  "repo_mirrors",
  "repo_refs",
  "step_contexts",
  "source_operations",
  "source_progress_members",
  "source_revision_origins",
  "source_integration_receipts",
  "source_integration_inputs",
  "source_integration_members",
  "timeline_work_sources",
  "timeline_source_roots",
  "tracker_repo_subscriptions",
  "wiki_pages",
];
/** The deletion's own record, which outlives the repository by design. */
export const KEPT_TABLES = ["repo_deletions"];
export const INDIRECT_TABLES: Record<string, string> = {
  ci_logs: "job_id IN (SELECT id FROM ci_jobs WHERE repo_id = ?1)",
  ci_steps: "job_id IN (SELECT id FROM ci_jobs WHERE repo_id = ?1)",
  atlas_snapshots: "scope IN (SELECT scope FROM atlas_scopes WHERE repo_id = ?1)",
  atlas_current: "scope IN (SELECT scope FROM atlas_scopes WHERE repo_id = ?1)",
  atlas_entities: "scope IN (SELECT scope FROM atlas_scopes WHERE repo_id = ?1)",
  atlas_edges: "scope IN (SELECT scope FROM atlas_scopes WHERE repo_id = ?1)",
  atlas_assignments: "scope IN (SELECT scope FROM atlas_scopes WHERE repo_id = ?1)",
  atlas_lineage: "scope IN (SELECT scope FROM atlas_scopes WHERE repo_id = ?1)",
};

export interface RepoInventory {
  repoId: string;
  /** The repository row: null once it's gone. */
  repo: { name: string; deletedAt: string | null } | null;
  /** Rows per table that still name the repository (tables with none are left out). */
  d1: Record<string, number>;
  registry: { packageSources: number; publishes: number };
  /** Registered Durable Object instances it owns, with what each holds now. */
  durable: {
    class: string;
    name: string;
    purgedAt: string | null;
    storage: StorageReport | null;
  }[];
  artifacts: { name: string | null; exists: boolean | null };
  /** Vectors the metadata filter finds (at most 100), null without Vectorize. */
  vectors: number | null;
  /** AI Search items listed for it (not being deleted), null without AI Search. */
  searchItems: number | null;
  /** Live timeline previews, and teardown runs not finished. */
  previews: { live: number; teardownsOpen: number };
  deletion: Awaited<ReturnType<typeof deletionStatus>>;
}

async function count(d1: D1Database, sql: string, repoId: string): Promise<number> {
  const row = await d1.prepare(sql).bind(repoId).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function repoInventory(env: Env, repoId: string): Promise<RepoInventory> {
  const d1: Record<string, number> = {};
  for (const table of REPO_TABLES) {
    // A purged instance's registry row stays (it records the purge): count live ones.
    const where = table === "do_instances" ? "repo_id = ?1 AND purged_at IS NULL" : "repo_id = ?1";
    const n = await count(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, repoId);
    if (n) d1[table] = n;
  }
  for (const [table, where] of Object.entries(INDIRECT_TABLES)) {
    const n = await count(env.DB, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, repoId);
    if (n) d1[table] = n;
  }
  const row = await env.DB.prepare("SELECT name, deleted_at FROM repos WHERE id = ?")
    .bind(repoId)
    .first<{ name: string; deleted_at: string | null }>();
  if (row) d1.repos = 1;
  const deletion = await deletionStatus(env, repoId);
  const artifactsName =
    (await env.DB.prepare("SELECT artifacts_name FROM repos WHERE id = ?")
      .bind(repoId)
      .first<string>("artifacts_name")) ?? (await artifactsOf(env, repoId));

  const registry = {
    packageSources: await count(
      env.REGISTRY_DB,
      "SELECT COUNT(*) AS n FROM package_sources WHERE git_repo_id = ?1",
      repoId,
    ),
    publishes: await count(
      env.REGISTRY_DB,
      "SELECT COUNT(*) AS n FROM publishes WHERE git_repo_id = ?1",
      repoId,
    ),
  };

  const { results: instances } = await env.DB.prepare(
    `SELECT class, name, purged_at FROM do_instances
      WHERE repo_id = ?1 OR (class = 'KnowledgeCoordinator' AND name = ?1)
      ORDER BY class, name`,
  )
    .bind(repoId)
    .all<{ class: DurableClass; name: string; purged_at: string | null }>();
  const durable: RepoInventory["durable"] = [];
  for (const instance of instances) {
    let storage: StorageReport | null = null;
    // Only the classes that keep storage, and only where they're bound.
    if (instance.class === "KnowledgeCoordinator" && Reflect.get(env, "KNOWLEDGE_COORDINATOR"))
      storage = await instanceStorage(env, instance.class, instance.name).catch(() => null);
    durable.push({
      class: instance.class,
      name: instance.name,
      purgedAt: instance.purged_at,
      storage,
    });
  }

  let exists: boolean | null = null;
  if (artifactsName) {
    try {
      await env.ARTIFACTS.get(artifactsName);
      exists = true;
    } catch (error) {
      // Through the development remote proxy the error keeps its message, not its code.
      if (isArtifactsError(error, "NOT_FOUND") || /Repository not found/i.test(String(error)))
        exists = false;
      else throw error;
    }
  }

  return {
    repoId,
    repo: row ? { name: row.name, deletedAt: row.deleted_at } : null,
    d1,
    registry,
    durable,
    artifacts: { name: artifactsName, exists },
    vectors: env.VECTORS ? (await repoVectorIds(env, repoId)).length : null,
    searchItems: env.SEARCH ? (await repoSearchItems(env, repoId)).length : null,
    previews: {
      live: await count(
        env.DB,
        "SELECT COUNT(*) AS n FROM deployments WHERE repo_id = ?1 AND status IN ('active', 'sleeping') AND timeline_slug IS NOT NULL",
        repoId,
      ),
      teardownsOpen: await count(
        env.DB,
        "SELECT COUNT(*) AS n FROM ci_runs WHERE repo_id = ?1 AND preview_action = 'teardown' AND status IN ('queued', 'running')",
        repoId,
      ),
    },
    deletion,
  };
}

async function artifactsOf(env: Env, repoId: string): Promise<string | null> {
  return (
    (await env.DB.prepare("SELECT artifacts_name FROM repo_deletions WHERE repo_id = ?")
      .bind(repoId)
      .first<string | null>("artifacts_name")) ?? null
  );
}
