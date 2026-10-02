CREATE TABLE archive_caches (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  digest TEXT NOT NULL REFERENCES blobs(digest) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  ready INTEGER NOT NULL DEFAULT 0,
  UNIQUE(repo_id, digest)
);
CREATE TABLE archive_members (
  cache_id TEXT NOT NULL REFERENCES archive_caches(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  parent TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('file', 'directory')),
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  digest TEXT,
  PRIMARY KEY(cache_id, path)
);
CREATE INDEX archive_members_directory ON archive_members(cache_id, parent, kind, path);

-- Retire derived bytes through the existing physical GC, including feed deletion.
-- The digest identifies the source archive; this key is never a logical blob locator.
CREATE TRIGGER archive_cache_delete AFTER DELETE ON archive_caches
WHEN OLD.r2_key != '' BEGIN
  INSERT INTO blob_representations(key, digest, state, retired_at)
    VALUES(OLD.r2_key, OLD.digest, 'retired', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
