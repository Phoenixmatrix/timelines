-- Cleanup runs (CORE-198; PRD CORE-195): the audit record of every retention
-- run, scheduled or manual, dry or real, and its progress, so a run resumes
-- where it stopped (worker/retention/runs.ts).
CREATE TABLE cleanup_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The account whose data it covers; NULL for a site run.
  account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  -- Who started a manual run.
  actor_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  -- The moment every selection is computed from, through every resume.
  as_of TEXT NOT NULL,
  -- Totals over its categories: records selected (dry run) or removed, and bytes.
  items INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  -- The failed categories' errors.
  error TEXT,
  -- The worker advancing it, until when.
  lease_token TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX cleanup_runs_account ON cleanup_runs (account_id, id);
CREATE INDEX cleanup_runs_schedule ON cleanup_runs (account_id, trigger, created_at);
CREATE INDEX cleanup_runs_open ON cleanup_runs (status, updated_at)
  WHERE status IN ('queued', 'running');

-- Each category of a run, in order: the thresholds it used, where it got to
-- (`cursor`, the cleanup's keyset position) and what it did.
CREATE TABLE cleanup_run_categories (
  run_id INTEGER NOT NULL REFERENCES cleanup_runs (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  category TEXT NOT NULL,
  thresholds TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  cursor TEXT,
  items INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  batches INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (run_id, category)
);
