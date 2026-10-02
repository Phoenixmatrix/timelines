-- Coalescing under load (on.push.coalesce_after in .gitmatrix/ci.yml): a push's
-- run waits (held_at) while enough runs are in flight on its branch; when one
-- finishes, the newest held run starts and the older ones are covered by it.
ALTER TABLE ci_runs ADD COLUMN held_at TEXT;
ALTER TABLE ci_runs ADD COLUMN covered_by INTEGER;
