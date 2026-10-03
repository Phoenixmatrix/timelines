-- Atlas retention (CORE-159, worker/atlas/retention.ts): the current snapshot
-- plus at most 20 prior per scope, priors expiring 7 days after they were
-- superseded or earlier under storage pressure, within 2 GiB per repository.

-- Why an expired snapshot expired: age (7 days as a prior), count (more than
-- 20 priors) or storage (evicted, oldest first, to fit the cap). expires_at
-- holds when it expired.
ALTER TABLE atlas_snapshots ADD COLUMN expired_reason TEXT;
-- Why a failed snapshot failed, when a reader should know: `capacity` means it
-- didn't fit the storage cap and the previous snapshot stayed current (stale).
ALTER TABLE atlas_snapshots ADD COLUMN failure TEXT;
-- 1 while a scope has retention work left (rows to reclaim, or over its cap
-- with priors left), so the hourly sweep resumes it.
ALTER TABLE atlas_scopes ADD COLUMN retention_pending INTEGER NOT NULL DEFAULT 0;

-- `bytes` becomes the estimated stored size of the rows a snapshot opened
-- (from_seq = its seq) that still exist: the UTF-8 length of every text column
-- plus a fixed per-row overhead for keys, sequence numbers and index entries
-- (ENTITY_BYTES_SQL / EDGE_BYTES_SQL in worker/atlas/projection.ts). A scope's
-- storage is then the sum over its snapshots. Recompute existing snapshots
-- under that definition (failed ones were rolled back, so they come to 0).
UPDATE atlas_snapshots SET bytes =
  coalesce((
    SELECT sum(
      length(CAST(e.entity_id AS BLOB)) + length(CAST(e.kind AS BLOB))
      + coalesce(length(CAST(e.parent_id AS BLOB)), 0) + length(CAST(e.sort_key AS BLOB))
      + length(CAST(e.name AS BLOB)) + coalesce(length(CAST(e.path AS BLOB)), 0)
      + length(CAST(e.summary AS BLOB)) + length(CAST(e.data AS BLOB))
      + length(CAST(e.content_hash AS BLOB)) + 160)
    FROM atlas_entities e WHERE e.scope = atlas_snapshots.scope AND e.from_seq = atlas_snapshots.seq
  ), 0)
  + coalesce((
    SELECT sum(length(CAST(g.src AS BLOB)) + length(CAST(g.dst AS BLOB)) + length(CAST(g.kind AS BLOB)) + 96)
    FROM atlas_edges g WHERE g.scope = atlas_snapshots.scope AND g.from_seq = atlas_snapshots.seq
  ), 0);

-- Superseded snapshots get their expiry (7 days after the next one published).
UPDATE atlas_snapshots SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', (
    SELECT min(n.published_at) FROM atlas_snapshots n
    WHERE n.scope = atlas_snapshots.scope AND n.status = 'published' AND n.seq > atlas_snapshots.seq
  ), '+7 days')
WHERE status = 'published' AND expires_at IS NULL
  AND id NOT IN (SELECT snapshot_id FROM atlas_current);
