// Every D1 table, in the group its usage is reported under (CORE-207), with
// how its rows find their account. Group ids match the retention category a
// group's data falls under (worker/retention/categories.ts) where there is one. A test fails when a migration adds a table
// that isn't listed here, so nothing goes unmetered.
//
// `owner` is a WHERE clause over the table's rows, with ?1 the account id; a
// site group's tables belong to no account and are measured whole.

export type Database = "db" | "registry";

export interface TableGroup {
  id: string;
  database: Database;
  scope: "account" | "site";
  label: string;
  tables: Record<string, string | null>;
}

// gitmatrix's database (DB).
const REPO = "repo_id IN (SELECT id FROM repos WHERE owner_id = ?1)";
const JOB =
  "job_id IN (SELECT j.id FROM ci_jobs j JOIN repos r ON r.id = j.repo_id WHERE r.owner_id = ?1)";
const SCOPE =
  "scope IN (SELECT s.scope FROM atlas_scopes s JOIN repos r ON r.id = s.repo_id WHERE r.owner_id = ?1)";
// The registry's database (REGISTRY_DB).
const FEED = "repo_id IN (SELECT id FROM repositories WHERE owner_id = ?1)";
const PACKAGE =
  "package_id IN (SELECT p.id FROM packages p JOIN repositories r ON r.id = p.repo_id WHERE r.owner_id = ?1)";

export const TABLE_GROUPS: TableGroup[] = [
  {
    id: "repositories",
    database: "db",
    scope: "account",
    label: "Repositories, collaborators, mirrors and refs",
    tables: {
      repos: "owner_id = ?1",
      repo_deletions: "owner_id = ?1",
      repo_collaborators: REPO,
      repo_mirrors: REPO,
      repo_refs: REPO,
    },
  },
  {
    id: "tracker-activity",
    database: "db",
    scope: "account",
    label: "Timeline work sources and integration evidence",
    tables: {
      timeline_work_sources: REPO,
      source_operations: REPO,
      source_progress_members: REPO,
      source_revision_origins: REPO,
      source_integration_receipts: REPO,
      source_integration_members: REPO,
      source_integration_inputs: REPO,
      timeline_source_roots: REPO,
      timeline_source_migrations: "owner_id = ?1",
    },
  },
  {
    id: "push-log",
    database: "db",
    scope: "account",
    label: "Push log and change refs",
    tables: { ref_updates: REPO, change_refs: REPO },
  },
  {
    // CORE-22; no retention category: one small row per mention.
    id: "issue-mentions",
    database: "db",
    scope: "account",
    label: "Issue mentions in commit messages",
    tables: { commit_issue_mentions: REPO, commit_mention_backfills: REPO },
  },
  {
    // CORE-231; its retention category arrives with CORE-244.
    id: "step-context",
    database: "db",
    scope: "account",
    label: "Step context (work context per commit)",
    tables: { step_contexts: REPO, step_artifacts: REPO },
  },
  {
    id: "ci-logs",
    database: "db",
    scope: "account",
    label: "CI logs",
    tables: { ci_logs: JOB },
  },
  {
    id: "ci-runs",
    database: "db",
    scope: "account",
    label: "CI runs, jobs, steps and settings",
    tables: {
      ci_runs: REPO,
      ci_jobs: REPO,
      ci_steps: JOB,
      ci_job_tokens: JOB,
      ci_refs: REPO,
      ci_secrets: REPO,
      merge_queue: REPO,
    },
  },
  {
    id: "preview-records",
    database: "db",
    scope: "account",
    label: "Deployment records",
    tables: { deployments: REPO },
  },
  {
    id: "knowledge-builds",
    database: "db",
    scope: "account",
    label: "Knowledge build history",
    tables: { kg_builds: REPO, kg_changes: REPO },
  },
  {
    id: "knowledge-graph",
    database: "db",
    scope: "account",
    label: "Knowledge graph, wiki and index records",
    tables: {
      kg_state: REPO,
      kg_files: REPO,
      kg_nodes: REPO,
      kg_edges: REPO,
      kg_concepts: REPO,
      kg_concept_links: REPO,
      kg_concept_pairs: REPO,
      kg_concept_reviews: REPO,
      kg_search_items: REPO,
      wiki_pages: REPO,
    },
  },
  {
    id: "ended-timeline-data",
    database: "db",
    scope: "account",
    label: "Timeline overlays and page sets",
    tables: {
      kg_overlays: REPO,
      kg_overlay_changes: REPO,
      kg_page_sets: REPO,
      kg_page_set_pages: REPO,
    },
  },
  {
    id: "atlas",
    database: "db",
    scope: "account",
    label: "Atlas projections",
    tables: {
      atlas_scopes: REPO,
      atlas_snapshots: SCOPE,
      atlas_current: SCOPE,
      atlas_entities: SCOPE,
      atlas_edges: SCOPE,
      atlas_assignments: SCOPE,
      atlas_lineage: SCOPE,
      atlas_feed: REPO,
      atlas_timeline_regroupings: REPO,
    },
  },
  {
    id: "ai-spend",
    database: "db",
    scope: "account",
    label: "Atlas model spend records",
    tables: {
      atlas_spend: "account_id = ?1",
      atlas_spend_daily: "account_id = ?1",
      atlas_budget_exhaustions: "account_id = ?1",
    },
  },
  {
    id: "release-notes",
    database: "db",
    scope: "account",
    label: "Release notes",
    tables: {
      release_notes: REPO,
      release_note_entries: REPO,
      release_note_mentions: REPO,
      release_note_state: REPO,
    },
  },
  {
    id: "assistant-chats",
    database: "db",
    scope: "account",
    label: "Assistant chat directory",
    tables: { assistant_chats: "user_id = ?1" },
  },
  {
    id: "account",
    database: "db",
    scope: "account",
    label: "Account, members, agents, keys and preferences",
    tables: {
      accounts: "id = ?1",
      account_settings: "account_id = ?1",
      assistant_personal_skills: "user_id = ?1",
      account_ai_log_bodies: "account_id = ?1",
      org_members: "org_id = ?1",
      agents: "accountable_id = ?1",
      access_tokens: "user_id = ?1",
      ssh_keys: "user_id = ?1",
      avatar_generations: "user_id = ?1",
      tracker_preferences: "owner_id = ?1",
      tracker_repo_subscriptions: "tracker_owner_id = ?1",
      do_instances: "account_id = ?1",
    },
  },
  {
    id: "usage",
    database: "db",
    scope: "account",
    label: "Usage records",
    tables: {
      usage_snapshots: "account_id = ?1",
      usage_monthly: "account_id = ?1",
      ai_usage: "account_id = ?1",
      ai_usage_monthly: "account_id = ?1",
    },
  },
  {
    id: "retention",
    database: "db",
    scope: "account",
    label: "Retention policies, their history and cleanup runs",
    tables: {
      retention_policies: "account_id = ?1",
      retention_policy_changes: "account_id = ?1",
      cleanup_runs: "account_id = ?1",
      cleanup_run_categories: "run_id IN (SELECT id FROM cleanup_runs WHERE account_id = ?1)",
    },
  },
  {
    id: "analysis-caches",
    database: "db",
    scope: "site",
    label: "Analysis caches (shared by content)",
    tables: { kg_blob_analysis: null, kg_synthesis: null },
  },
  {
    id: "auth-hygiene",
    database: "db",
    scope: "site",
    label: "Sign-in state",
    tables: {
      auth_users: null,
      auth_accounts: null,
      auth_sessions: null,
      auth_verifications: null,
      auth_device_codes: null,
      auth_invites: null,
      auth_lockouts: null,
      ssh_challenges: null,
    },
  },
  {
    id: "system",
    database: "db",
    scope: "site",
    label: "Background job state",
    tables: { job_cursors: null, retention_site_policies: null, site_ai_log_bodies: null },
  },
  {
    id: "price-catalog",
    database: "db",
    scope: "site",
    label: "Cloudflare price catalog and its changes",
    tables: { cloudflare_prices: null, cloudflare_price_changes: null },
  },
  {
    id: "packages",
    database: "registry",
    scope: "account",
    label: "Package feeds, versions and files",
    tables: {
      repositories: "owner_id = ?1",
      virtual_members: "virtual_id IN (SELECT id FROM repositories WHERE owner_id = ?1)",
      packages: FEED,
      versions: PACKAGE,
      dist_tags: PACKAGE,
      package_sources: PACKAGE,
      files: FEED,
      oci_blob_links: FEED,
      oci_manifests: FEED,
      oci_manifest_refs: FEED,
      oci_tags: FEED,
      releases: FEED,
      release_assets:
        "release_id IN (SELECT rl.id FROM releases rl JOIN repositories r ON r.id = rl.repo_id WHERE r.owner_id = ?1)",
      derived_files: FEED,
      signing_keys: FEED,
      brew_git_objects: FEED,
      archive_caches: FEED,
      archive_members:
        "cache_id IN (SELECT c.id FROM archive_caches c JOIN repositories r ON r.id = c.repo_id WHERE r.owner_id = ?1)",
      artifact_publications: FEED,
      artifact_hot_versions: FEED,
    },
  },
  {
    id: "registry-proxy-cache",
    database: "registry",
    scope: "account",
    label: "Package proxy cache entries",
    tables: { remote_entries: FEED },
  },
  {
    id: "registry-audit",
    database: "registry",
    scope: "account",
    label: "Package audit log and publishes",
    tables: {
      audit_log: FEED,
      publishes: "feed_id IN (SELECT id FROM repositories WHERE owner_id = ?1)",
    },
  },
  {
    id: "package-blobs",
    database: "registry",
    scope: "site",
    label: "Package blob catalog and compaction state",
    tables: {
      blobs: null,
      blob_representations: null,
      blob_compactions: null,
      blob_compaction_frames: null,
      artifact_backfill: null,
    },
  },
];

/** Tables whose payload bytes are measured exactly rather than sampled. */
export const MEASURED_TEXT: Record<string, string> = { ci_logs: "text" };
