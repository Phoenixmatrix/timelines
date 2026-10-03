-- Previews as primitives (CORE-78, TIMELINES-RESEARCH.md "Previews: primitives,
-- not hosting"): Gitmatrix deploys nothing; it records where deployments are.
-- Environments are named per repository (`production`, `timeline/<slug>`, or
-- any name a project uses) and exist through their deployments. A record
-- outlives its preview: expiring changes the status, never deletes the row.
CREATE TABLE deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  -- The timeline it previews: the slug as recorded, and the tracker's id when
  -- the timeline existed at the time. Null outside timelines.
  timeline_slug TEXT,
  timeline_id TEXT,
  -- A timeline checkpoint (CORE-76), as the recorder named it.
  checkpoint_id TEXT,
  commit_oid TEXT NOT NULL,
  -- Null only for a deployment that failed before it had an address.
  url TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'sleeping', 'expired', 'failed')),
  -- Who recorded it: the CI job (and its run) when a job's credential did,
  -- and the person, with the agent acting for them, accountable for it.
  run_id TEXT REFERENCES ci_runs (id) ON DELETE SET NULL,
  job_id TEXT REFERENCES ci_jobs (id) ON DELETE SET NULL,
  actor_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
  -- When the preview is due to be torn down; null for no expiry.
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX deployments_repo ON deployments (repo_id, id);
CREATE INDEX deployments_environment ON deployments (repo_id, environment, id);
CREATE INDEX deployments_timeline ON deployments (repo_id, timeline_slug, id);
CREATE INDEX deployments_commit ON deployments (repo_id, commit_oid);
CREATE INDEX deployments_run ON deployments (run_id);

-- Settings per account (user or org); a missing row means the defaults.
CREATE TABLE account_settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  -- Previews are torn down this many days after their timeline lands or is
  -- abandoned (enforced by CORE-79).
  preview_ended_days INTEGER NOT NULL DEFAULT 2 CHECK (preview_ended_days BETWEEN 0 AND 365),
  -- ...and after this many days without pushes.
  preview_idle_days INTEGER NOT NULL DEFAULT 7 CHECK (preview_idle_days BETWEEN 1 AND 365),
  updated_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
