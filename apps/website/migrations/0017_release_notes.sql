-- Release notes (CORE-29): structured entries per release, kept current as
-- work lands. A release is a tag's range back to the previous tag, or
-- '@unreleased' for the default branch's work since the newest tag.

-- Which trackers subscribe a workspace to which repositories. The tracker
-- Durable Objects own subscriptions; this mirror lets server work find them
-- without an actor. The repository owner's tracker is always consulted too.
CREATE TABLE tracker_repo_subscriptions (
  tracker_owner_id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (tracker_owner_id, repo_id)
);
CREATE INDEX tracker_repo_subscriptions_repo ON tracker_repo_subscriptions(repo_id);

-- One row per release a repository has notes for.
CREATE TABLE release_notes (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  release TEXT NOT NULL,
  to_oid TEXT NOT NULL,
  from_tag TEXT,
  from_oid TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  -- A short AI-written introduction over the release's entries.
  intro TEXT NOT NULL DEFAULT '',
  intro_model TEXT,
  intro_inputs_hash TEXT NOT NULL DEFAULT '',
  -- Tracker accounts whose issues shaped the intro: only their readers see it.
  intro_trackers TEXT NOT NULL DEFAULT '[]',
  -- When the release's newest commit was authored (unreleased: head).
  released_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, release)
);

-- One shipped change: a tracker issue with its commits, or a commit that
-- mentions none.
CREATE TABLE release_note_entries (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  release TEXT NOT NULL,
  -- 'issue:<tracker owner id>:<key>' or 'commit:<oid>': stable within a release.
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'commit')),
  category TEXT NOT NULL CHECK (category IN ('feature', 'fix', 'improvement', 'internal')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tracker_owner_id TEXT,
  issue_id TEXT,
  issue_key TEXT,
  team_id TEXT,
  team_key TEXT,
  issue_type TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  workspace_ids TEXT NOT NULL DEFAULT '[]',
  commits TEXT NOT NULL DEFAULT '[]',
  -- Semantic code changes the entry was written from (bounded).
  changes TEXT NOT NULL DEFAULT '[]',
  -- When it shipped: issue completion, else its newest commit's authorship.
  shipped_at TEXT NOT NULL,
  model TEXT,
  inputs_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, release, subject),
  FOREIGN KEY (repo_id, release) REFERENCES release_notes(repo_id, release) ON DELETE CASCADE
);
CREATE INDEX release_note_entries_hash ON release_note_entries(repo_id, inputs_hash);
CREATE INDEX release_note_entries_shipped ON release_note_entries(shipped_at);
CREATE INDEX release_note_entries_team ON release_note_entries(team_id, shipped_at);

-- Issue keys each repository's commits mention, resolved or not, so tracker
-- changes to an issue refresh the repositories that cite it.
CREATE TABLE release_note_mentions (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  issue_key TEXT NOT NULL,
  PRIMARY KEY (repo_id, issue_key)
);
CREATE INDEX release_note_mentions_key ON release_note_mentions(issue_key);

-- Generation scheduling: one run per repository at a time; a change during a
-- run marks it dirty so another run follows.
CREATE TABLE release_note_state (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  dirty INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'idle',
  error TEXT,
  generated_at TEXT
);
