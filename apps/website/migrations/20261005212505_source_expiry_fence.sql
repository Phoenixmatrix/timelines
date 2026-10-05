-- Policy expiry closes admission before outstanding consumers drain. Tracker
-- remains authoritative for lifecycle/version; projection cannot remove this fence.
ALTER TABLE timeline_work_sources ADD COLUMN expiry_requested_at TEXT DEFAULT NULL;

CREATE TRIGGER source_expiry_fence_monotonic BEFORE UPDATE OF expiry_requested_at ON timeline_work_sources
WHEN OLD.expiry_requested_at IS NOT NULL AND NEW.expiry_requested_at IS NOT OLD.expiry_requested_at
BEGIN SELECT RAISE(ABORT, 'Source expiry fence cannot be cleared or replaced'); END;

-- Guard the shared claim table, including SQL-triggered CI/deployment claims.
-- INSERT ... ON CONFLICT retries are allowed only for the exact admitted identity.
CREATE TRIGGER source_root_expiry_insert BEFORE INSERT ON timeline_source_roots
WHEN EXISTS (
  SELECT 1 FROM timeline_work_sources s WHERE s.repo_id=NEW.repo_id
    AND s.source_id=NEW.source_id AND s.expiry_requested_at IS NOT NULL
) AND NOT EXISTS (
  SELECT 1 FROM timeline_source_roots r WHERE r.repo_id=NEW.repo_id
    AND r.source_id=NEW.source_id AND r.consumer_kind=NEW.consumer_kind
    AND r.consumer_id=NEW.consumer_id AND r.commit_oid=NEW.commit_oid
)
BEGIN SELECT RAISE(ABORT, 'Source expired; new consumer admission is closed'); END;

CREATE TRIGGER source_root_expiry_update
BEFORE UPDATE OF repo_id,source_id,consumer_kind,consumer_id,commit_oid ON timeline_source_roots
WHEN EXISTS (
  SELECT 1 FROM timeline_work_sources s WHERE s.repo_id=NEW.repo_id
    AND s.source_id=NEW.source_id AND s.expiry_requested_at IS NOT NULL
) AND NOT EXISTS (
  SELECT 1 FROM timeline_source_roots r WHERE r.repo_id=NEW.repo_id
    AND r.source_id=NEW.source_id AND r.consumer_kind=NEW.consumer_kind
    AND r.consumer_id=NEW.consumer_id AND r.commit_oid=NEW.commit_oid
)
BEGIN SELECT RAISE(ABORT, 'Source expired; new consumer admission is closed'); END;
