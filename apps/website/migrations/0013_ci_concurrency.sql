-- Jobs in a concurrency group (jobs.<name>.concurrency in .gitmatrix/ci.yml, kept
-- in the job's spec) claim the group's single slot per repository before they run.
ALTER TABLE ci_jobs ADD COLUMN concurrency_claimed_at TEXT;
