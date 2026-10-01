-- CI/CD: runs of a repository's pipeline (.gitmatrix/ci.yml), their jobs,
-- steps and logs.

-- The last commit each branch was seen at, so a push starts exactly one run
-- per branch it moved, even when pushes race.
CREATE TABLE ci_refs (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  oid TEXT NOT NULL,
  PRIMARY KEY (repo_id, ref)
);

CREATE TABLE ci_runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  -- Per-repository run number (#1, #2, …).
  number INTEGER NOT NULL,
  commit_oid TEXT NOT NULL,
  ref TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('push', 'manual')),
  actor_id TEXT,
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- Set when .gitmatrix/ci.yml couldn't be read; the run fails without jobs.
  config_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (repo_id, number)
);
CREATE INDEX ci_runs_commit ON ci_runs (repo_id, commit_oid);

CREATE TABLE ci_jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES ci_runs (id) ON DELETE CASCADE,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- JSON: the job as declared (needs, if, image, env, secrets, steps, timeout).
  spec TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
  -- sandbox or local
  runner TEXT NOT NULL,
  -- Which local runner took the job.
  claimed_by TEXT,
  exit_code INTEGER,
  error TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (run_id, name)
);
CREATE INDEX ci_jobs_queue ON ci_jobs (runner, status);

CREATE TABLE ci_steps (
  job_id TEXT NOT NULL REFERENCES ci_jobs (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled')),
  exit_code INTEGER,
  started_at TEXT,
  finished_at TEXT,
  PRIMARY KEY (job_id, position)
);

-- Job output, appended in chunks as it arrives.
CREATE TABLE ci_logs (
  job_id TEXT NOT NULL REFERENCES ci_jobs (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  -- -1 for setup (checkout), otherwise the step position.
  step INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

-- Values a job can ask for by name (secrets: [NAME]). Stored as given in
-- this prototype; encrypt or move to Secrets Store before real use.
CREATE TABLE ci_secrets (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, name)
);
