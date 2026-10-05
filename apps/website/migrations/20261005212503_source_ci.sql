ALTER TABLE ci_runs ADD COLUMN source_id TEXT NOT NULL DEFAULT 'canonical';
ALTER TABLE ci_jobs ADD COLUMN source_id TEXT NOT NULL DEFAULT 'canonical';
ALTER TABLE deployments ADD COLUMN source_id TEXT NOT NULL DEFAULT 'canonical';
CREATE TABLE ci_refs_source (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL DEFAULT 'canonical',
  ref TEXT NOT NULL,
  oid TEXT NOT NULL,
  quiet_released TEXT,
  PRIMARY KEY(repo_id, source_id, ref)
);
INSERT INTO ci_refs_source(repo_id, source_id, ref, oid, quiet_released)
  SELECT repo_id, 'canonical', ref, oid, quiet_released FROM ci_refs;
DROP TABLE ci_refs;
ALTER TABLE ci_refs_source RENAME TO ci_refs;
CREATE INDEX ci_runs_source_commit ON ci_runs(repo_id, source_id, commit_oid);
CREATE INDEX deployments_source_commit ON deployments(repo_id, source_id, commit_oid);
CREATE TRIGGER ci_work_source_admission BEFORE INSERT ON ci_runs
WHEN NEW.source_id != 'canonical'
BEGIN
  SELECT RAISE(ABORT, 'CI source unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM timeline_work_sources s JOIN repos r ON r.id=s.repo_id
    WHERE s.source_id=NEW.source_id AND s.repo_id=NEW.repo_id
      AND s.state IN ('ready','archived') AND r.deleted_at IS NULL
  );
END;
CREATE TRIGGER ci_work_source_pin AFTER INSERT ON ci_runs
WHEN NEW.source_id != 'canonical'
BEGIN
  INSERT INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
  VALUES(NEW.repo_id,NEW.source_id,'ci',NEW.id,NEW.commit_oid,NEW.created_at);
END;
CREATE TRIGGER ci_work_source_release AFTER DELETE ON ci_runs
BEGIN
  DELETE FROM timeline_source_roots WHERE consumer_kind='ci' AND consumer_id=OLD.id;
END;
CREATE TRIGGER deployment_work_source_admission BEFORE INSERT ON deployments
WHEN NEW.source_id != 'canonical'
BEGIN
  SELECT RAISE(ABORT, 'Deployment source unavailable') WHERE NOT EXISTS (
    SELECT 1 FROM timeline_work_sources s JOIN repos r ON r.id=s.repo_id
    WHERE s.source_id=NEW.source_id AND s.repo_id=NEW.repo_id
      AND s.state IN ('ready','archived') AND r.deleted_at IS NULL
  );
END;
CREATE TRIGGER deployment_work_source_pin AFTER INSERT ON deployments
WHEN NEW.source_id != 'canonical'
BEGIN
  INSERT INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
  VALUES(NEW.repo_id,NEW.source_id,'deployment',CAST(NEW.id AS TEXT),NEW.commit_oid,NEW.created_at);
END;
CREATE TRIGGER deployment_work_source_release AFTER DELETE ON deployments
BEGIN
  DELETE FROM timeline_source_roots WHERE consumer_kind='deployment' AND consumer_id=CAST(OLD.id AS TEXT);
END;
