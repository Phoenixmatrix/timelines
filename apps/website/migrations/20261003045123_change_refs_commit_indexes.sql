-- "Why did this change?" (CORE-85) finds a blamed commit's change id in the
-- push log by commit: the first or latest commit a change had on a ref.
CREATE INDEX IF NOT EXISTS change_refs_last_commit ON change_refs (repo_id, last_commit_oid);
CREATE INDEX IF NOT EXISTS change_refs_first_commit ON change_refs (repo_id, first_commit_oid);
