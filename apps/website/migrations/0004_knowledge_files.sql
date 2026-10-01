-- Files of the commit a build is indexing (too many to pass between workflow
-- steps), and of the last indexed commit for each repository.
CREATE TABLE kg_files (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  -- 'current' for the indexed commit, or a build id while it runs.
  snapshot TEXT NOT NULL,
  path TEXT NOT NULL,
  blob_oid TEXT NOT NULL,
  mode TEXT NOT NULL,
  PRIMARY KEY (repo_id, snapshot, path)
);

-- What is in AI Search for each repository: one item per indexed file or page.
CREATE TABLE kg_search_items (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  -- file:<path> or page:<slug>
  key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  -- Blob id or page inputs hash: re-uploaded only when it changes.
  version TEXT NOT NULL,
  PRIMARY KEY (repo_id, key)
);
