-- Retention (CORE-205): when a proxy cache entry was last served, so entries
-- nobody used for a while can be dropped and garbage collection can reclaim
-- their blobs. Touched at most once a day per entry; existing entries start
-- from when they were fetched.
ALTER TABLE remote_entries ADD COLUMN used_at TEXT;
UPDATE remote_entries SET used_at = fetched_at;
CREATE INDEX remote_entries_used ON remote_entries (used_at);

-- Derived objects (R2 `d/<repo>/<sha256>`) are found by key when deciding
-- whether any derived file still refers to one.
CREATE INDEX derived_files_r2_key ON derived_files (r2_key);
