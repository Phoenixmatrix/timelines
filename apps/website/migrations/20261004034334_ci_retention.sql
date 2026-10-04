-- CI retention (CORE-200): the "ci-logs" and "ci-runs" categories
-- (worker/retention/cleanups/ci-logs.ts, ci-runs.ts).

-- When retention removed a finished job's log text: the run page and
-- `gm runs logs` say so instead of showing an empty log.
ALTER TABLE ci_jobs ADD COLUMN logs_removed_at TEXT;

-- The latest runs of each ref are kept: counting the newer runs of a ref
-- (also what the run list filtered by ?ref= reads).
CREATE INDEX ci_runs_ref ON ci_runs (repo_id, ref, number);

-- A run a deployment's teardown came from is kept while the record exists.
CREATE INDEX deployments_teardown_run ON deployments (teardown_run_id)
  WHERE teardown_run_id IS NOT NULL;
