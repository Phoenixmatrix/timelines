CREATE TABLE mention_backfill_jobs (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  authority TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending', 'blocked')),
  error TEXT,
  CHECK (authority IS NOT NULL OR state = 'blocked')
);

-- Historical pushes carry identity but not a reusable initiating credential.
-- Preserve this backlog explicitly until an authorized Space writer resumes it.
INSERT INTO mention_backfill_jobs (repo_id, authority, state, error)
SELECT r.id, NULL, 'blocked', 'originating_authority_unavailable'
FROM repos r
WHERE r.deleted_at IS NULL AND r.pushed_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM commit_mention_backfills b WHERE b.repo_id = r.id);
