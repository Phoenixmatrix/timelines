CREATE TABLE timeline_work_sources (
  source_id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, timeline_id TEXT NOT NULL,
  timeline_slug TEXT NOT NULL, owner_id TEXT NOT NULL, artifacts_name TEXT NOT NULL UNIQUE,
  artifacts_remote TEXT, state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  allocation_operation_id TEXT NOT NULL UNIQUE,
  fork_source_id TEXT NOT NULL, fork_commit TEXT NOT NULL, fork_tree TEXT NOT NULL,
  fork_ref TEXT NOT NULL, work_ref TEXT NOT NULL DEFAULT 'refs/heads/work',
  initial_source_id TEXT NOT NULL, initial_commit TEXT NOT NULL,
  initial_tree TEXT NOT NULL, initial_ref TEXT NOT NULL,
  initial_token_revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, error TEXT,
  UNIQUE(timeline_id, repo_id)
);
CREATE INDEX timeline_work_sources_repo ON timeline_work_sources(repo_id,state);
CREATE TABLE source_operations (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, timeline_id TEXT NOT NULL,
  repo_id TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL,
  state TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX source_operations_repo ON source_operations(repo_id,state);
CREATE TABLE source_progress_members (
  repo_id TEXT NOT NULL, source_id TEXT NOT NULL, commit_oid TEXT NOT NULL,
  operation_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(repo_id,source_id,commit_oid)
);
CREATE TABLE source_integration_receipts (
  id TEXT PRIMARY KEY, landing_id TEXT NOT NULL, checkpoint_id TEXT NOT NULL,
  repo_id TEXT NOT NULL, source_id TEXT NOT NULL, source_commit TEXT NOT NULL,
  source_tree TEXT NOT NULL, logical_base_json TEXT NOT NULL, dependencies_json TEXT NOT NULL,
  canonical_base TEXT NOT NULL, canonical_commit TEXT NOT NULL, canonical_tree TEXT NOT NULL,
  noop INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE(landing_id,repo_id)
);
CREATE TABLE source_integration_members (
  receipt_id TEXT NOT NULL, repo_id TEXT NOT NULL, source_id TEXT NOT NULL, commit_oid TEXT NOT NULL,
  PRIMARY KEY(receipt_id,source_id,commit_oid)
);
CREATE INDEX source_integration_members_lookup ON source_integration_members(repo_id,source_id,commit_oid);
