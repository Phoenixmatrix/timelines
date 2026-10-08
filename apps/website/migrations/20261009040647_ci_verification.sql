-- Candidate verification is positive provenance, never an executed success.
ALTER TABLE ci_runs ADD COLUMN queue_attempt INTEGER;
ALTER TABLE ci_jobs ADD COLUMN execution_identity TEXT;
ALTER TABLE ci_jobs ADD COLUMN verified_by TEXT;
