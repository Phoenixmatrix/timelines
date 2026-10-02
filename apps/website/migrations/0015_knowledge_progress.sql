-- When a knowledge build last finished a step. The coordinator's watchdog stops
-- builds that stop making progress, rather than builds that merely run long.
ALTER TABLE kg_builds ADD COLUMN progress_at TEXT;
