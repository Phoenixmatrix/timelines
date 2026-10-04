-- CI history is retained output, not a source-byte consumer. Only outstanding
-- runs or children own claims. Parent cancellation is not child completion.
ALTER TABLE ci_jobs ADD COLUMN source_completion_pending INTEGER NOT NULL DEFAULT 0;
-- Earlier cancellation/dispatch timeout code wrote terminal status before the
-- runner acknowledged stopping. Started cancellations, and started failures
-- without an exit code, are ambiguous: preserve their claims until report(done).
-- Never-dispatched work and terminal jobs with exit evidence can be released.
UPDATE ci_jobs SET source_completion_pending=1
WHERE source_id != 'canonical' AND started_at IS NOT NULL
  AND (status='cancelled' OR (status='failed' AND exit_code IS NULL));

DROP TRIGGER ci_work_source_pin;
CREATE TRIGGER ci_work_source_pin AFTER INSERT ON ci_runs
WHEN NEW.source_id != 'canonical' AND NEW.status IN ('queued','running')
BEGIN
  INSERT INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
  VALUES(NEW.repo_id,NEW.source_id,'ci',NEW.id,NEW.commit_oid,NEW.created_at);
END;

CREATE TRIGGER ci_work_source_reconcile AFTER UPDATE OF status ON ci_runs
WHEN NEW.source_id != 'canonical'
BEGIN
  -- The preceding expiry migration guards root admission. A still-owned exact
  -- claim can drain/retry; resurrection after release must reacquire admission.
  INSERT OR IGNORE INTO timeline_source_roots(repo_id,source_id,consumer_kind,consumer_id,commit_oid,created_at)
  SELECT NEW.repo_id,NEW.source_id,'ci',NEW.id,NEW.commit_oid,NEW.created_at
  WHERE NEW.status IN ('queued','running') OR EXISTS (
    SELECT 1 FROM ci_jobs WHERE run_id=NEW.id
      AND (status IN ('pending','queued','running') OR source_completion_pending=1)
  );
  DELETE FROM timeline_source_roots
  WHERE repo_id=NEW.repo_id AND source_id=NEW.source_id
    AND consumer_kind='ci' AND consumer_id=NEW.id AND commit_oid=NEW.commit_oid
    AND NEW.status IN ('succeeded','failed','cancelled')
    AND NOT EXISTS (
      SELECT 1 FROM ci_jobs WHERE run_id=NEW.id
        AND (status IN ('pending','queued','running') OR source_completion_pending=1)
    );
END;

-- Reuse the same reconciliation for child transitions, including cancelled
-- parents whose last runner reports completion later. No clock or lease frees
-- a claim. Updating the status to itself changes no public CI metadata.
CREATE TRIGGER ci_job_work_source_insert AFTER INSERT ON ci_jobs
BEGIN
  UPDATE ci_runs SET status=status WHERE id=NEW.run_id AND source_id != 'canonical';
END;
CREATE TRIGGER ci_job_work_source_update AFTER UPDATE OF status,run_id,source_completion_pending ON ci_jobs
BEGIN
  UPDATE ci_runs SET status=status WHERE id IN (OLD.run_id,NEW.run_id) AND source_id != 'canonical';
END;
CREATE TRIGGER ci_job_work_source_delete AFTER DELETE ON ci_jobs
BEGIN
  UPDATE ci_runs SET status=status WHERE id=OLD.run_id AND source_id != 'canonical';
END;

-- Historical pins predate lifecycle release. Reconcile only proven terminal
-- runs; preserve queued/running parents and every unfinished child, as well as
-- unrelated consumer roots. CI history, landing receipts and logs stay intact.
DELETE FROM timeline_source_roots
WHERE consumer_kind='ci' AND EXISTS (
  SELECT 1 FROM ci_runs r
  WHERE r.id=timeline_source_roots.consumer_id
    AND r.repo_id=timeline_source_roots.repo_id
    AND r.source_id=timeline_source_roots.source_id
    AND r.commit_oid=timeline_source_roots.commit_oid
    AND r.status IN ('succeeded','failed','cancelled')
    AND NOT EXISTS (
      SELECT 1 FROM ci_jobs j WHERE j.run_id=r.id
        AND (j.status IN ('pending','queued','running') OR j.source_completion_pending=1)
    )
);
