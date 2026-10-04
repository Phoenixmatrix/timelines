-- Steps (CORE-226, CORE-231): the context an agent attaches to a commit it
-- makes at a meaningful step in a timeline. One row per (change, commit): a
-- change's context follows its change ID across amend and rebase, and each
-- incarnation keeps its own version. Rows are written by gm on push.
CREATE TABLE step_contexts (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  change_id TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  -- Who made it: an agent's id, or the person's; and the person accountable.
  author_id TEXT NOT NULL,
  accountable_id TEXT NOT NULL,
  timeline TEXT,
  issue_key TEXT,
  summary TEXT NOT NULL DEFAULT '',
  -- The record itself (instructions, steering, why, challenges, tests,
  -- coverage, harness/model), JSON, at most 256 KiB.
  context TEXT NOT NULL DEFAULT '{}',
  -- When gm made the commit, and when a push showed Gitmatrix the commit:
  -- null means reported but not yet seen ("local, unverified").
  committed_at TEXT NOT NULL,
  verified_at TEXT,
  -- Deleted or redacted by a repository admin: the text is gone, this stays.
  deleted_at TEXT,
  deleted_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, change_id, commit_oid)
);
CREATE INDEX step_contexts_timeline ON step_contexts (repo_id, timeline, committed_at);
CREATE INDEX step_contexts_commit ON step_contexts (repo_id, commit_oid);
