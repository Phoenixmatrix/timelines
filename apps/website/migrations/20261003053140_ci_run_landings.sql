-- Landing runs (CORE-77): a landing's merge job and the gates on its merge.
-- Like preview runs (CORE-79), they're stored with trigger 'manual', since
-- widening ci_runs.trigger's CHECK would mean rebuilding ci_runs (dropping it
-- cascades to every job, step and log); this names the landing, and readers
-- report such a run's trigger as 'landing' (worker/ci/api.ts, worker/ci/jobs.ts).
ALTER TABLE ci_runs ADD COLUMN landing_id TEXT;
