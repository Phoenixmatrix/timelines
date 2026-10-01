import { Kysely, type Generated } from "kysely";
import { D1Dialect } from "kysely-d1";

/**
 * Gitmatrix's database (the DB binding) for Kysely. The SQL migrations in
 * `migrations/` are the source of truth; every migration updates this
 * interface in the same change. `Generated` marks columns with a default.
 * Timestamps are ISO strings; JSON columns are TEXT, parsed at the edges.
 * (The package registry keeps its own database: registry/core/db.ts.)
 */
export interface Database {
  accounts: {
    id: string;
    kind: "user" | "org";
    slug: string;
    display_name: string;
    bio: Generated<string>;
    is_site_admin: Generated<number>;
    /** Orgs only: the role every member gets on every repo the org owns. */
    member_repo_role: "none" | "read" | "write" | null;
    created_at: Generated<string>;
  };
  org_members: {
    org_id: string;
    user_id: string;
    role: "owner" | "member";
  };
  repos: {
    id: string;
    owner_id: string;
    name: string;
    description: Generated<string>;
    visibility: "public" | "private";
    default_branch: Generated<string>;
    artifacts_name: string;
    artifacts_remote: string;
    imported_from: string | null;
    created_at: Generated<string>;
    pushed_at: string | null;
  };
  repo_collaborators: {
    repo_id: string;
    user_id: string;
    role: "read" | "write" | "admin";
    added_at: Generated<string>;
  };
  access_tokens: {
    id: string;
    user_id: string;
    name: string;
    scope: "read" | "write";
    token_hash: string;
    last_four: string;
    created_at: Generated<string>;
    last_used_at: string | null;
    expires_at: string | null;
    ssh_key_id: string | null;
  };
  ssh_keys: {
    id: string;
    user_id: string;
    title: string;
    key_type: string;
    public_key: string;
    fingerprint: string;
    scope: "read" | "write";
    created_at: Generated<string>;
    last_used_at: string | null;
  };
  ssh_challenges: {
    nonce: string;
    key_id: string;
    origin: string;
    expires_at: string;
  };
  kg_blob_analysis: {
    blob_oid: string;
    analyzer: string;
    language: string;
    data: string;
    model: string | null;
    tokens: Generated<number>;
    created_at: Generated<string>;
  };
  kg_synthesis: {
    key: string;
    data: string;
    model: string | null;
    tokens: Generated<number>;
    created_at: Generated<string>;
  };
  kg_nodes: {
    repo_id: string;
    id: string;
    kind: string;
    name: string;
    path: string | null;
    summary: Generated<string>;
    data: Generated<string>;
    content_hash: string;
    changed_in: string;
    updated_at: Generated<string>;
  };
  kg_edges: {
    repo_id: string;
    src: string;
    dst: string;
    kind: string;
    weight: Generated<number>;
  };
  kg_builds: {
    id: string;
    repo_id: string;
    from_commit: string | null;
    to_commit: string;
    status: "running" | "succeeded" | "failed";
    phase: Generated<string>;
    stats: Generated<string>;
    error: string | null;
    started_at: Generated<string>;
    finished_at: string | null;
  };
  kg_changes: {
    repo_id: string;
    build_id: string;
    node_id: string;
    kind: string;
    change: "added" | "changed" | "removed";
  };
  kg_state: {
    repo_id: string;
    indexed_commit: string | null;
    indexed_at: string | null;
    last_build_id: string | null;
  };
  kg_files: {
    repo_id: string;
    snapshot: string;
    path: string;
    blob_oid: string;
    mode: string;
  };
  kg_search_items: {
    repo_id: string;
    key: string;
    item_id: string;
    version: string;
  };
  kg_concept_pairs: {
    repo_id: string;
    a: string;
    b: string;
    version: string;
    score: number;
    a_in_b: number;
    b_in_a: number;
  };
  kg_concepts: {
    repo_id: string;
    key: string;
    canonical: string;
    recurring: number | null;
    salient: number | null;
    salience_hash: string | null;
  };
  kg_concept_links: {
    repo_id: string;
    narrower: string;
    broader: string;
  };
  kg_concept_reviews: {
    repo_id: string;
    a: string;
    b: string;
    score: number;
    inputs_hash: string;
  };
  wiki_pages: {
    repo_id: string;
    slug: string;
    title: string;
    section: string;
    position: number;
    node_id: string | null;
    body: string;
    sources: Generated<string>;
    inputs_hash: string;
    generated_in: string;
    model: string | null;
    updated_at: Generated<string>;
    diagram: Generated<string>;
  };
  ci_refs: {
    repo_id: string;
    ref: string;
    oid: string;
  };
  ci_runs: {
    id: string;
    repo_id: string;
    number: number;
    commit_oid: string;
    ref: string;
    trigger: "push" | "manual";
    actor_id: string | null;
    title: Generated<string>;
    status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
    config_error: string | null;
    created_at: Generated<string>;
    started_at: string | null;
    finished_at: string | null;
  };
  ci_jobs: {
    id: string;
    run_id: string;
    repo_id: string;
    name: string;
    spec: string;
    status: "pending" | "queued" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
    runner: string;
    claimed_by: string | null;
    exit_code: number | null;
    error: string | null;
    started_at: string | null;
    finished_at: string | null;
  };
  ci_steps: {
    job_id: string;
    position: number;
    name: string;
    status: "pending" | "running" | "succeeded" | "failed" | "skipped" | "cancelled";
    exit_code: number | null;
    started_at: string | null;
    finished_at: string | null;
  };
  ci_logs: {
    job_id: string;
    seq: number;
    step: number;
    text: string;
  };
  ci_secrets: {
    repo_id: string;
    name: string;
    value: string;
    updated_at: Generated<string>;
  };
  repo_mirrors: {
    repo_id: string;
    url: string;
    username: Generated<string>;
    token_sealed: string | null;
    enabled: Generated<number>;
    prune: Generated<number>;
    status: Generated<"pending" | "syncing" | "ok" | "failed">;
    last_error: string | null;
    last_attempt_at: string | null;
    last_synced_at: string | null;
    last_synced_commit: string | null;
    lease_until: string | null;
    created_at: Generated<string>;
    updated_at: Generated<string>;
  };
  ci_job_tokens: {
    token_hash: string;
    job_id: string;
    expires_at: string;
  };
}

export type DB = Kysely<Database>;

/**
 * Kysely over a D1 binding. Built per call: it is cheap, and the runtime ties
 * a binding's I/O to the request that made it, so an instance cached across
 * requests fails with "Cannot perform I/O on behalf of a different request".
 */
export function db(d1: D1Database): DB {
  return new Kysely<Database>({ dialect: new D1Dialect({ database: d1 }) });
}

/** SQLite's ISO timestamp, matching the columns' defaults. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * D1 runs a batch as one transaction; Kysely over D1 has no transactions, so
 * atomic multi-statement writes compile their queries and send them here.
 */
export async function batch(
  d1: D1Database,
  queries: { compile(): { sql: string; parameters: readonly unknown[] } }[],
): Promise<D1Result[]> {
  if (queries.length === 0) return [];
  return d1.batch(
    queries.map((q) => {
      const { sql, parameters } = q.compile();
      return d1.prepare(sql).bind(...parameters);
    }),
  );
}
