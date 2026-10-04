-- Repository deletion (CORE-199): tombstone, then purge everywhere.
--
-- Deleting a repository sets `deleted_at` at once: from then on it is missing
-- to every reader (selectRepos and the other lookups skip it), while its rows
-- stay so the purge can still find what it owns outside D1 (Vectorize
-- vectors from kg_nodes, AI Search items from kg_search_items, live previews
-- from deployments, Durable Objects from do_instances). The RepoPurge
-- Workflow (worker/retention/repo-purge.ts) removes those, then the row,
-- whose cascade takes the rest. The name stays taken until then.
ALTER TABLE repos ADD COLUMN deleted_at TEXT;

-- One row per deletion, kept after the repository row is gone: what was
-- asked, by whom, which phase the purge reached and what it removed. No
-- foreign keys, so it outlives the repository. The orphan sweep records the
-- unknown repository ids it cleaned up here too (`source = 'orphan-sweep'`).
CREATE TABLE repo_deletions (
  repo_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  -- owner/name when it was deleted ('' for an orphan nobody named).
  full_name TEXT NOT NULL,
  artifacts_name TEXT,
  source TEXT NOT NULL DEFAULT 'delete' CHECK (source IN ('delete', 'orphan-sweep')),
  requested_by TEXT,
  requested_at TEXT NOT NULL,
  -- The next phase to run (repo-purge.ts PHASES), 'done' at the end.
  phase TEXT NOT NULL,
  -- JSON: per phase counts, preview teardown groups and runs, cursors.
  progress TEXT NOT NULL DEFAULT '{}',
  -- The Workflow instance purging it, and how many were started.
  workflow_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  error TEXT
);
CREATE INDEX repo_deletions_open ON repo_deletions (finished_at, updated_at);
CREATE INDEX repo_deletions_owner ON repo_deletions (owner_id);
