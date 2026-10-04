ALTER TABLE ci_runs ADD COLUMN queue_id TEXT;
CREATE INDEX ci_runs_queue ON ci_runs(repo_id, queue_id);
CREATE TABLE merge_queue (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','merging','testing','advancing','landed','failed','cancelled','covered')),
  version INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  merge_run_id TEXT,
  gate_run_id TEXT,
  base TEXT,
  candidate TEXT,
  covered_by TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  swept_at TEXT NOT NULL DEFAULT '',
  recovered_at TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(repo_id,id)
);
-- This constraint, not a Worker-local lock, owns the repository's active slot.
CREATE UNIQUE INDEX merge_queue_active ON merge_queue(repo_id)
  WHERE status IN ('merging','testing','advancing');
CREATE INDEX merge_queue_pending ON merge_queue(status,updated_at);
