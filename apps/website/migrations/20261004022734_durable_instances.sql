-- The Durable Object instance registry (CORE-197). Every instance the Worker
-- reaches goes through worker/durable/registry.ts, which records it here, so
-- an instance can be found and purged from outside after whatever named it is
-- gone. No foreign keys on purpose: a row outlives its account or repository,
-- which is exactly when the instance needs purging.
CREATE TABLE do_instances (
  -- The class's export name in cloudflare.config.ts (Tracker, Assistant…).
  class TEXT NOT NULL,
  -- The name the instance is addressed by (getByName / idFromName).
  name TEXT NOT NULL,
  account_id TEXT,
  repo_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- Throttled: at most about once an hour per instance and isolate.
  last_active_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- ctx.storage.sql.databaseSize, as last reported by the instance.
  storage_bytes INTEGER,
  sized_at TEXT,
  -- retire(): the instance purges itself once its in-flight work ends.
  retiring_at TEXT,
  purged_at TEXT,
  purge_reason TEXT,
  PRIMARY KEY (class, name)
);
CREATE INDEX do_instances_account ON do_instances (account_id, class);
CREATE INDEX do_instances_repo ON do_instances (repo_id);
CREATE INDEX do_instances_activity ON do_instances (last_active_at);

-- Where a bounded, resumable cron pass left off (keyed by pass name).
CREATE TABLE job_cursors (
  name TEXT PRIMARY KEY,
  cursor TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Backfill: the instances the D1 rows name today. Registry repositories live
-- in the registry's database; the cron registers those (worker/durable/sweep.ts).
INSERT OR IGNORE INTO do_instances (class, name, account_id, created_at, last_active_at)
  SELECT 'Tracker', id, id, created_at, created_at FROM accounts;
INSERT OR IGNORE INTO do_instances (class, name, account_id, created_at, last_active_at)
  SELECT 'Assistant', user_id || ':' || id, user_id, created_at, updated_at FROM assistant_chats;
INSERT OR IGNORE INTO do_instances (class, name, account_id, repo_id, created_at, last_active_at)
  SELECT 'KnowledgeCoordinator', id, owner_id, id, created_at, COALESCE(pushed_at, created_at)
  FROM repos;
INSERT OR IGNORE INTO do_instances (class, name, account_id, repo_id, created_at, last_active_at)
  SELECT 'CiSandbox', j.id, r.owner_id, j.repo_id, j.started_at,
         COALESCE(j.finished_at, j.started_at)
  FROM ci_jobs j JOIN repos r ON r.id = j.repo_id
  WHERE j.runner = 'sandbox' AND j.started_at IS NOT NULL;
