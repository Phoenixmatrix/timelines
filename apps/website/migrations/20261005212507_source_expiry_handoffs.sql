-- Published deployment records outlive the source bytes. Only previews with
-- actual teardown work retain a source claim, and exact admitted parents may
-- hand their claim to their output/teardown without reopening general admission.
ALTER TABLE ci_runs ADD COLUMN preview_teardown_of INTEGER;
ALTER TABLE deployments ADD COLUMN teardown_completed_at TEXT;
ALTER TABLE deployments ADD COLUMN teardown_unmanaged_at TEXT;

DROP TRIGGER ci_work_source_admission;
CREATE TRIGGER ci_work_source_admission BEFORE INSERT ON ci_runs
WHEN NEW.source_id != 'canonical'
BEGIN
  SELECT RAISE(ABORT, 'CI source unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM timeline_work_sources s JOIN repos p ON p.id=s.repo_id
    WHERE s.source_id=NEW.source_id AND s.repo_id=NEW.repo_id AND s.state IN ('ready','archived')
      AND (p.deleted_at IS NULL OR (NEW.preview_action='teardown' AND EXISTS (
        SELECT 1 FROM deployments d JOIN timeline_source_roots r
          ON r.consumer_kind='deployment' AND r.consumer_id=CAST(d.id AS TEXT)
        WHERE d.id=NEW.preview_teardown_of AND d.repo_id=NEW.repo_id
          AND d.source_id=NEW.source_id AND d.commit_oid=NEW.commit_oid
          AND d.status='expired' AND d.teardown_run_id IS NULL
          AND d.teardown_completed_at IS NULL AND d.teardown_unmanaged_at IS NULL
          AND r.repo_id=d.repo_id AND r.source_id=d.source_id AND r.commit_oid=d.commit_oid
      )))
  );
END;

DROP TRIGGER deployment_work_source_admission;
CREATE TRIGGER deployment_work_source_admission BEFORE INSERT ON deployments
WHEN NEW.source_id != 'canonical'
BEGIN
  SELECT RAISE(ABORT, 'Deployment source unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM timeline_work_sources s JOIN repos p ON p.id=s.repo_id
    WHERE s.source_id=NEW.source_id AND s.repo_id=NEW.repo_id
      AND s.state IN ('ready','archived') AND p.deleted_at IS NULL
      AND (s.expiry_requested_at IS NULL OR EXISTS (
        SELECT 1 FROM ci_jobs j JOIN timeline_source_roots r
          ON r.consumer_kind='ci' AND r.consumer_id=j.run_id
        JOIN ci_runs c ON c.id=j.run_id AND c.status IN ('queued','running')
        WHERE j.id=NEW.job_id AND j.run_id=NEW.run_id AND j.repo_id=NEW.repo_id
          AND j.source_id=NEW.source_id AND j.status='running'
          AND r.repo_id=NEW.repo_id AND r.source_id=NEW.source_id AND r.commit_oid=NEW.commit_oid
      ))
  );
END;

DROP TRIGGER source_root_expiry_insert;
CREATE TRIGGER source_root_expiry_insert BEFORE INSERT ON timeline_source_roots
WHEN EXISTS (SELECT 1 FROM timeline_work_sources s WHERE s.repo_id=NEW.repo_id
  AND s.source_id=NEW.source_id AND s.expiry_requested_at IS NOT NULL)
AND NOT EXISTS (SELECT 1 FROM timeline_source_roots r WHERE r.repo_id=NEW.repo_id
  AND r.source_id=NEW.source_id AND r.consumer_kind=NEW.consumer_kind
  AND r.consumer_id=NEW.consumer_id AND r.commit_oid=NEW.commit_oid)
AND NOT (NEW.consumer_kind='deployment' AND EXISTS (
  SELECT 1 FROM deployments d JOIN ci_jobs j ON j.id=d.job_id AND j.run_id=d.run_id
  JOIN timeline_source_roots r ON r.consumer_kind='ci' AND r.consumer_id=d.run_id
  JOIN ci_runs parent ON parent.id=j.run_id AND parent.status IN ('queued','running')
  WHERE CAST(d.id AS TEXT)=NEW.consumer_id AND d.repo_id=NEW.repo_id
    AND d.source_id=NEW.source_id AND d.commit_oid=NEW.commit_oid
    AND j.repo_id=d.repo_id AND j.source_id=d.source_id AND j.status='running'
    AND r.repo_id=d.repo_id AND r.source_id=d.source_id AND r.commit_oid=d.commit_oid
))
AND NOT (NEW.consumer_kind='ci' AND EXISTS (
  SELECT 1 FROM ci_runs c JOIN deployments d ON d.id=c.preview_teardown_of
  JOIN timeline_source_roots r ON r.consumer_kind='deployment' AND r.consumer_id=CAST(d.id AS TEXT)
  WHERE c.id=NEW.consumer_id AND c.repo_id=NEW.repo_id AND c.source_id=NEW.source_id
    AND c.commit_oid=NEW.commit_oid AND c.preview_action='teardown'
    AND d.repo_id=c.repo_id AND d.source_id=c.source_id AND d.commit_oid=c.commit_oid
    AND d.timeline_slug=c.timeline_slug AND d.checkpoint_id IS c.checkpoint_id
    AND d.status='expired' AND d.teardown_completed_at IS NULL AND d.teardown_unmanaged_at IS NULL
    AND (d.teardown_run_id IS NULL OR d.teardown_run_id=c.id)
    AND r.repo_id=d.repo_id AND r.source_id=d.source_id AND r.commit_oid=d.commit_oid
))
BEGIN SELECT RAISE(ABORT, 'Source expired; new consumer admission is closed'); END;

-- Claim the exact teardown parent in the same transaction as CI admission.
-- The claim may be set before or after ci_work_source_pin fires.
CREATE TRIGGER preview_teardown_parent_admission BEFORE INSERT ON ci_runs
WHEN NEW.preview_teardown_of IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Teardown requires an unclaimed exact deployment parent') WHERE NEW.preview_action IS NOT 'teardown' OR NOT EXISTS (
    SELECT 1 FROM deployments d WHERE d.id=NEW.preview_teardown_of
      AND d.repo_id=NEW.repo_id AND d.source_id=NEW.source_id AND d.commit_oid=NEW.commit_oid
      AND d.timeline_slug=NEW.timeline_slug AND d.checkpoint_id IS NEW.checkpoint_id
      AND d.status='expired' AND d.teardown_completed_at IS NULL AND d.teardown_unmanaged_at IS NULL
      AND d.teardown_run_id IS NULL
  );
END;
CREATE TRIGGER preview_teardown_parent_claim AFTER INSERT ON ci_runs
WHEN NEW.preview_teardown_of IS NOT NULL
BEGIN
  UPDATE deployments SET teardown_run_id=NEW.id
  WHERE repo_id=NEW.repo_id AND source_id=NEW.source_id AND timeline_slug=NEW.timeline_slug
    AND status='expired' AND teardown_completed_at IS NULL AND teardown_unmanaged_at IS NULL
    AND teardown_run_id IS NULL;
END;
DROP TRIGGER deployment_work_source_pin;
CREATE TRIGGER deployment_work_source_pin AFTER INSERT ON deployments
WHEN NEW.source_id != 'canonical' AND NEW.timeline_slug IS NOT NULL
  AND NEW.status IN ('active','sleeping')
BEGIN
  INSERT INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
  VALUES(NEW.repo_id,NEW.source_id,'deployment',CAST(NEW.id AS TEXT),NEW.commit_oid,NEW.created_at);
END;

-- Records without a claim cannot revive a preview after expiry.
CREATE TRIGGER deployment_work_source_reactivate BEFORE UPDATE OF status ON deployments
WHEN NEW.source_id != 'canonical' AND NEW.timeline_slug IS NOT NULL
  AND NEW.status IN ('active','sleeping') AND OLD.status NOT IN ('active','sleeping')
BEGIN
  INSERT OR IGNORE INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
  VALUES(NEW.repo_id,NEW.source_id,'deployment',CAST(NEW.id AS TEXT),NEW.commit_oid,NEW.created_at);
END;

CREATE TRIGGER deployment_work_source_finished AFTER UPDATE OF teardown_completed_at,teardown_unmanaged_at,status ON deployments
WHEN NEW.teardown_completed_at IS NOT NULL OR NEW.teardown_unmanaged_at IS NOT NULL OR NEW.status='failed'
BEGIN
  DELETE FROM timeline_source_roots WHERE consumer_kind='deployment' AND consumer_id=CAST(NEW.id AS TEXT);
END;

CREATE TRIGGER preview_teardown_source_complete AFTER UPDATE OF status ON ci_runs
WHEN NEW.preview_action='teardown' AND NEW.status='succeeded'
  AND NOT EXISTS (SELECT 1 FROM ci_jobs j WHERE j.run_id=NEW.id
    AND (j.status NOT IN ('succeeded','skipped') OR j.source_completion_pending=1))
BEGIN
  UPDATE deployments SET teardown_completed_at=COALESCE(teardown_completed_at,NEW.finished_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  WHERE teardown_run_id=NEW.id AND status='expired';
END;

-- Backfill only proven completion; expired status/torn_down_at alone means the
-- scheduler asked for teardown, not that remote resources were removed.
UPDATE deployments SET teardown_completed_at=(SELECT finished_at FROM ci_runs WHERE id=teardown_run_id)
WHERE status='expired' AND EXISTS (SELECT 1 FROM ci_runs c WHERE c.id=teardown_run_id
  AND c.status='succeeded' AND c.finished_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ci_jobs j WHERE j.run_id=c.id
    AND (j.status NOT IN ('succeeded','skipped') OR j.source_completion_pending=1)));
DELETE FROM timeline_source_roots WHERE consumer_kind='deployment' AND EXISTS (
  SELECT 1 FROM deployments d WHERE CAST(d.id AS TEXT)=timeline_source_roots.consumer_id
    AND (d.timeline_slug IS NULL OR d.status='failed' OR d.teardown_completed_at IS NOT NULL)
);
