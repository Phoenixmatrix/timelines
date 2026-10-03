-- The history git doesn't keep (CORE-68): every ref update a push made, and
-- which refs each change (gm's `change-id` commit header) reached.

-- Branches and tags as the push log last saw them, so each update is recorded
-- exactly once even when pushes race. Seeded from CI's view of the branches.
CREATE TABLE repo_refs (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  -- Full name: refs/heads/main, refs/tags/v1.
  ref TEXT NOT NULL,
  oid TEXT NOT NULL,
  PRIMARY KEY (repo_id, ref)
);
INSERT INTO repo_refs (repo_id, ref, oid) SELECT repo_id, 'refs/heads/' || ref, oid FROM ci_refs;

CREATE TABLE ref_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  -- Null when the push created the ref.
  old_oid TEXT,
  -- Null when the push deleted it.
  new_oid TEXT,
  -- 1 when the old commit isn't an ancestor of the new one (a force push);
  -- null until the commits were read, or when they couldn't be.
  forced INTEGER,
  -- The person who pushed, and the agent that pushed for them.
  actor_id TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX ref_updates_ref ON ref_updates (repo_id, ref, id);

-- The refs a change reached: first when a push made one of its commits
-- reachable from the ref, and the latest commit of it that did.
CREATE TABLE change_refs (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  change_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  first_commit_oid TEXT NOT NULL,
  first_update_id INTEGER NOT NULL REFERENCES ref_updates (id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_commit_oid TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, change_id, ref)
);
CREATE INDEX change_refs_ref ON change_refs (repo_id, ref, first_seen_at);
