-- Preparation only: ordinary deployment neither backfills ownership nor changes
-- legacy authorization. The independently fenced operator participant sets this
-- column after approval and a complete recoverable registry checkpoint.
ALTER TABLE repositories ADD COLUMN space_id TEXT;
CREATE INDEX repositories_space ON repositories (space_id);

-- A receipt is not approval authority. The independent Instance journal owns
-- run/epoch/manifest admission, including the irreversible write boundary.
CREATE TABLE registry_space_migrations (
  legacy_owner_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL UNIQUE,
  organization_id TEXT NOT NULL,
  space_slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  run_id TEXT NOT NULL,
  migration_epoch INTEGER NOT NULL CHECK (migration_epoch > 0),
  manifest_digest TEXT NOT NULL,
  contract_version INTEGER NOT NULL CHECK (contract_version = 4),
  before_digest TEXT NOT NULL,
  after_digest TEXT NOT NULL,
  migrated_at TEXT NOT NULL
);

-- Storage-side admission survives business restoration. The independent
-- coordinator installs write-fence triggers and alone updates this adjunct.
-- Migration bypass is scoped to the same atomic D1 batch as its writes.
CREATE TABLE _space_cutover_fence (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  run_id TEXT,
  migration_epoch INTEGER,
  manifest_digest TEXT,
  fenced INTEGER NOT NULL DEFAULT 0 CHECK (fenced IN (0, 1)),
  authority_token TEXT NOT NULL DEFAULT '',
  bypass INTEGER NOT NULL DEFAULT 0 CHECK (bypass IN (0, 1))
);
INSERT INTO _space_cutover_fence (id, fenced, bypass) VALUES (1, 0, 0);
