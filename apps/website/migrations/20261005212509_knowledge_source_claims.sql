-- Published knowledge is retained output, not a live Git consumer. Queued page
-- requests hand their exact source claim to a distinct workflow attempt. Ending
-- or deleting page metadata cannot acknowledge that an in-flight attempt stopped.
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
AND NOT (NEW.consumer_kind='knowledge-pages-build' AND EXISTS (
  SELECT 1 FROM kg_page_sets p JOIN timeline_source_roots r
    ON r.repo_id=p.repo_id AND r.source_id=p.source_id AND r.consumer_kind='knowledge-pages'
    AND r.consumer_id=p.repo_id||':'||p.source_id||':'||p.ref||':'||p.set_key
    AND r.commit_oid=p.commit_oid
  WHERE p.repo_id=NEW.repo_id AND p.source_id=NEW.source_id
    AND p.build_id=NEW.consumer_id AND p.commit_oid=NEW.commit_oid
))
BEGIN SELECT RAISE(ABORT, 'Source expired; new consumer admission is closed'); END;

CREATE TRIGGER knowledge_pages_source_admission_insert BEFORE INSERT ON kg_page_sets
WHEN NEW.source_id!='canonical' AND NEW.status='queued'
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM timeline_work_sources s JOIN repos p ON p.id=s.repo_id
    WHERE s.repo_id=NEW.repo_id AND s.source_id=NEW.source_id
      AND s.state='ready' AND s.expiry_requested_at IS NULL AND p.deleted_at IS NULL
  ) THEN RAISE(ABORT, 'Knowledge source unavailable') END;
END;
CREATE TRIGGER knowledge_pages_source_admission_update BEFORE UPDATE OF status,build_id ON kg_page_sets
WHEN NEW.source_id!='canonical' AND NEW.status IN ('queued','writing')
  AND (NEW.status IS NOT OLD.status OR NEW.build_id IS NOT OLD.build_id)
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM timeline_work_sources s JOIN repos p ON p.id=s.repo_id
    WHERE s.repo_id=NEW.repo_id AND s.source_id=NEW.source_id
      AND s.state='ready' AND s.expiry_requested_at IS NULL AND p.deleted_at IS NULL
  ) THEN RAISE(ABORT, 'Knowledge source unavailable') END;
END;
CREATE TRIGGER knowledge_pages_source_queue_insert AFTER INSERT ON kg_page_sets
WHEN NEW.source_id!='canonical' AND NEW.status='queued'
BEGIN
  INSERT INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
  VALUES(NEW.repo_id,NEW.source_id,'knowledge-pages',
    NEW.repo_id||':'||NEW.source_id||':'||NEW.ref||':'||NEW.set_key,NEW.commit_oid,NEW.requested_at);
END;
CREATE TRIGGER knowledge_pages_source_queue_update AFTER UPDATE OF status ON kg_page_sets
WHEN NEW.source_id!='canonical' AND NEW.status='queued' AND OLD.status!='queued'
BEGIN
  INSERT INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
  VALUES(NEW.repo_id,NEW.source_id,'knowledge-pages',
    NEW.repo_id||':'||NEW.source_id||':'||NEW.ref||':'||NEW.set_key,NEW.commit_oid,NEW.requested_at);
END;
CREATE TRIGGER knowledge_pages_source_start AFTER UPDATE OF status,build_id ON kg_page_sets
WHEN NEW.source_id!='canonical' AND NEW.status='writing' AND NEW.build_id IS NOT NULL
  AND (OLD.status!='writing' OR OLD.build_id IS NOT NEW.build_id)
BEGIN
  INSERT INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
  SELECT NEW.repo_id,NEW.source_id,'knowledge-pages-build',NEW.build_id,NEW.commit_oid,NEW.requested_at
  FROM timeline_source_roots r WHERE r.repo_id=NEW.repo_id AND r.source_id=NEW.source_id
    AND r.consumer_kind='knowledge-pages' AND r.commit_oid=NEW.commit_oid
    AND r.consumer_id=NEW.repo_id||':'||NEW.source_id||':'||NEW.ref||':'||NEW.set_key;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM timeline_source_roots r WHERE r.repo_id=NEW.repo_id AND r.source_id=NEW.source_id
      AND r.consumer_kind='knowledge-pages-build' AND r.consumer_id=NEW.build_id AND r.commit_oid=NEW.commit_oid
  ) THEN RAISE(ABORT, 'Page workflow requires an admitted exact source claim') END;
  DELETE FROM timeline_source_roots WHERE consumer_kind='knowledge-pages'
    AND repo_id=NEW.repo_id AND source_id=NEW.source_id
    AND consumer_id=NEW.repo_id||':'||NEW.source_id||':'||NEW.ref||':'||NEW.set_key;
END;
CREATE TRIGGER knowledge_pages_source_unqueue AFTER UPDATE OF status ON kg_page_sets
WHEN NEW.source_id!='canonical' AND OLD.status='queued' AND NEW.status NOT IN ('queued','writing')
BEGIN
  DELETE FROM timeline_source_roots WHERE consumer_kind='knowledge-pages'
    AND repo_id=NEW.repo_id AND source_id=NEW.source_id
    AND consumer_id=NEW.repo_id||':'||NEW.source_id||':'||NEW.ref||':'||NEW.set_key;
END;
CREATE TRIGGER knowledge_pages_source_delete AFTER DELETE ON kg_page_sets
WHEN OLD.source_id!='canonical'
BEGIN
  DELETE FROM timeline_source_roots WHERE consumer_kind='knowledge-pages'
    AND repo_id=OLD.repo_id AND source_id=OLD.source_id
    AND consumer_id=OLD.repo_id||':'||OLD.source_id||':'||OLD.ref||':'||OLD.set_key;
END;

-- Preserve unknown started attempts, including metadata ended by another caller.
INSERT OR IGNORE INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
SELECT p.repo_id,p.source_id,'knowledge-pages-build',p.build_id,p.commit_oid,r.created_at
FROM kg_page_sets p JOIN timeline_source_roots r
  ON r.repo_id=p.repo_id AND r.source_id=p.source_id AND r.consumer_kind='knowledge-pages'
  AND r.consumer_id=p.repo_id||':'||p.source_id||':'||p.ref||':'||p.set_key AND r.commit_oid=p.commit_oid
WHERE p.build_id IS NOT NULL AND p.status IN ('writing','failed','ended');
DELETE FROM timeline_source_roots WHERE consumer_kind='knowledge-pages' AND EXISTS (
  SELECT 1 FROM kg_page_sets p WHERE p.repo_id=timeline_source_roots.repo_id
    AND p.source_id=timeline_source_roots.source_id
    AND timeline_source_roots.consumer_id=p.repo_id||':'||p.source_id||':'||p.ref||':'||p.set_key
    AND p.status!='queued'
);
-- An overlay_id is the last successfully materialized diff, even if a newer
-- attempt failed. Its published data keeps its own policy, not a Git-byte pin.
DELETE FROM timeline_source_roots WHERE consumer_kind='knowledge-overlay' AND EXISTS (
  SELECT 1 FROM kg_overlays o WHERE o.repo_id=timeline_source_roots.repo_id
    AND o.source_id=timeline_source_roots.source_id
    AND timeline_source_roots.consumer_id=o.repo_id||':'||o.source_id||':'||o.overlay_id
);
