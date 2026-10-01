-- One-way mirrors: after every push, a repository's branches and tags are
-- pushed to another git host (GitHub, as a backup). Credentials are sealed
-- with the registry key (REGISTRY_KEK).
CREATE TABLE repo_mirrors (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id) ON DELETE CASCADE,
  -- HTTPS clone URL of the target, e.g. https://github.com/owner/name.git
  url TEXT NOT NULL,
  username TEXT NOT NULL DEFAULT 'x-access-token',
  token_sealed TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Delete target branches and tags the source no longer has.
  prune INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'syncing', 'ok', 'failed')),
  last_error TEXT,
  last_attempt_at TEXT,
  last_synced_at TEXT,
  -- The default branch's commit as of the last successful sync.
  last_synced_commit TEXT,
  -- One sync per repository at a time.
  lease_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
