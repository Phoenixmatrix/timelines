-- Heavy work per timeline waits for a quiet period (CORE-238): a push run on a
-- timeline bookmark starts this long after its push, unless a newer push
-- covers it first or a checkpoint releases it now. Null: starts right away.
ALTER TABLE ci_runs ADD COLUMN quiet_until TEXT;

