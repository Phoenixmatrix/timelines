ALTER TABLE account_settings ADD COLUMN release_highlights_interval_hours
  INTEGER NOT NULL DEFAULT 24 CHECK (release_highlights_interval_hours BETWEEN 1 AND 168);

-- Summaries belong to a person viewer, not to all readers of a scope.
-- source_hash identifies generation input; source_manifest revalidates only
-- summarized sources so unrelated additions do not bypass the refresh cadence.
CREATE TABLE release_highlights (
  scope TEXT NOT NULL CHECK (scope IN ('site', 'tracker', 'repo')),
  scope_id TEXT NOT NULL,
  viewer_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  source_manifest TEXT NOT NULL DEFAULT '[]',
  body TEXT NOT NULL,
  model TEXT,
  status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'generating', 'ready', 'failed')),
  error TEXT,
  generated_at TEXT,
  updated_at TEXT NOT NULL,
  due_at INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  ai_snapshot TEXT,
  PRIMARY KEY (scope, scope_id, viewer_id)
);
CREATE INDEX release_highlights_due ON release_highlights(due_at, lease_until);

-- A projection can cite a source account other than its billing owner/viewer.
CREATE TRIGGER release_highlights_account_deleted AFTER DELETE ON accounts BEGIN
  DELETE FROM release_highlights
  WHERE EXISTS (
    SELECT 1 FROM json_each(release_highlights.source_manifest) AS source
    WHERE json_extract(source.value, '$.ownerAccountId') = OLD.id
       OR json_extract(source.value, '$.trackerOwnerId') = OLD.id
  );
END;
CREATE TRIGGER release_highlights_repo_deleted AFTER DELETE ON repos BEGIN
  DELETE FROM release_highlights
  WHERE (scope = 'repo' AND scope_id = OLD.id)
     OR EXISTS (
       SELECT 1 FROM json_each(release_highlights.source_manifest) AS source
       WHERE json_extract(source.value, '$.repoId') = OLD.id
     );
END;
