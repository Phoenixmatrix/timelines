-- Commit mentions know the code source whose push recorded them (CORE-296).
-- A timeline's work lives in its own work source until a compact commit lands
-- on main, so a mention of a work commit is the source's: it links to the
-- commit in that source, and goes when the source's retention purges it. The
-- compact landing commit carries the source's issue keys, so main's index keeps
-- the mention after the work commits are gone.
ALTER TABLE commit_issue_mentions ADD COLUMN source_id TEXT NOT NULL DEFAULT 'canonical';
CREATE INDEX commit_issue_mentions_source ON commit_issue_mentions (repo_id, source_id);

-- Mentions recorded before: a commit a work source introduced was first seen there.
UPDATE commit_issue_mentions
SET source_id = (
  SELECT o.source_id FROM source_revision_origins o
  WHERE o.repo_id = commit_issue_mentions.repo_id AND o.commit_oid = commit_issue_mentions.commit_oid
)
WHERE EXISTS (
  SELECT 1 FROM source_revision_origins o
  WHERE o.repo_id = commit_issue_mentions.repo_id
    AND o.commit_oid = commit_issue_mentions.commit_oid
    AND o.source_id != 'canonical'
);
