-- Landing merges in release notes (CORE-72): timelines land as real merges
-- into the default branch. Each entry records the timeline its work landed
-- with, and a landing's commits that cite no issue share one 'landing' entry.
-- SQLite can't widen a CHECK constraint in place, so the table is rebuilt.

CREATE TABLE release_note_entries_new (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  release TEXT NOT NULL,
  -- 'issue:<tracker owner id>:<key>', 'commit:<oid>' or 'landing:<merge oid>':
  -- stable within a release.
  subject TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'commit', 'landing')),
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
  -- The merge that landed the entry's work; null when it was committed to the
  -- default branch directly.
  landing_oid TEXT,
  -- The timeline it landed: its record (once timelines are recorded) and the
  -- branch git or the push log named.
  timeline_id TEXT,
  timeline_branch TEXT,
  UNIQUE (repo_id, release, subject),
  FOREIGN KEY (repo_id, release) REFERENCES release_notes(repo_id, release) ON DELETE CASCADE
);
INSERT INTO release_note_entries_new (
  id, repo_id, release, subject, kind, category, title, summary, tracker_owner_id, issue_id,
  issue_key, team_id, team_key, issue_type, labels, workspace_ids, commits, changes, shipped_at,
  model, inputs_hash, updated_at
)
SELECT
  id, repo_id, release, subject, kind, category, title, summary, tracker_owner_id, issue_id,
  issue_key, team_id, team_key, issue_type, labels, workspace_ids, commits, changes, shipped_at,
  model, inputs_hash, updated_at
FROM release_note_entries;
DROP TABLE release_note_entries;
ALTER TABLE release_note_entries_new RENAME TO release_note_entries;
CREATE INDEX release_note_entries_hash ON release_note_entries(repo_id, inputs_hash);
CREATE INDEX release_note_entries_shipped ON release_note_entries(shipped_at);
CREATE INDEX release_note_entries_team ON release_note_entries(team_id, shipped_at);

-- Landings are found by the merged commit's pushes.
CREATE INDEX ref_updates_new_oid ON ref_updates(repo_id, new_oid);
