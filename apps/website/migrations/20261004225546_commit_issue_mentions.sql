-- Commit-message mentions of tracker issues (CORE-22): when a push makes a
-- commit newly reachable from a branch or tag, every issue key its message
-- names (worker/release-notes/keys.ts) is resolved to an issue in a Gitmatrix
-- tracker and recorded here, once per (repository, commit, key). An issue's
-- linked work lists them as "Mentioned in", apart from explicit evidence.
--
-- A key that resolves in more than one tracker with none preferred is kept
-- as 'ambiguous', with no tracker or issue. Keys that resolve nowhere (an
-- external tracker's, or `UTF-8`) aren't recorded.
CREATE TABLE commit_issue_mentions (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  commit_oid TEXT NOT NULL,
  -- The key as the message wrote it.
  issue_key TEXT NOT NULL,
  -- gm's change-id header, when the commit had one and was read from a pack.
  change_id TEXT,
  resolution TEXT NOT NULL CHECK (resolution IN ('linked', 'ambiguous')),
  -- The tracker's account and the issue: null unless linked.
  tracker_owner_id TEXT,
  issue_id TEXT,
  -- The message's first line, and the committer's time.
  title TEXT NOT NULL DEFAULT '',
  committed_at TEXT,
  -- The ref whose update first made the commit reachable (null for a backfill
  -- that read history), and when it was seen.
  first_ref TEXT,
  pushed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, commit_oid, issue_key)
);
CREATE INDEX commit_issue_mentions_issue
  ON commit_issue_mentions (tracker_owner_id, issue_id, committed_at);

-- Repositories whose recent history was read for mentions once (the hourly
-- sweep's bounded backfill): pushes index everything after.
CREATE TABLE commit_mention_backfills (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id) ON DELETE CASCADE,
  commits INTEGER NOT NULL DEFAULT 0,
  -- Why it stopped early, if it did (an empty repository, a read failure).
  note TEXT,
  done_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
