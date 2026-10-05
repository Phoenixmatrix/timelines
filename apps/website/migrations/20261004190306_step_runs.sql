-- Step runs (CORE-235): each push to a timeline bookmark also starts a light
-- run of the jobs that list `on: step`. They're marked here so a push's own
-- run, coalescing, landing checks and commit status never mistake one for
-- full CI.
ALTER TABLE ci_runs ADD COLUMN step INTEGER NOT NULL DEFAULT 0;

-- What a step run produced, attached to the step by commit: a test summary
-- for now; screenshots and documents later (an R2 object in `object_key`).
CREATE TABLE step_artifacts (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  commit_oid TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES ci_runs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('test-summary', 'screenshot', 'document')),
  -- JSON: for test-summary, StepTestSummary (shared/steps.ts).
  data TEXT NOT NULL,
  object_key TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX step_artifacts_commit ON step_artifacts (repo_id, commit_oid);
CREATE INDEX step_artifacts_run ON step_artifacts (run_id);
