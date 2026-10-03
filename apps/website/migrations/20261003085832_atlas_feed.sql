-- Incremental Atlas projection (CORE-166): what changed in a repository's
-- knowledge graph since its Atlas last published, so a push projects only
-- that. applyGraph appends a row per changed node and edge before writing the
-- graph; a published snapshot deletes the rows it reflects. When too much
-- changed to list, a single `full` row stands for everything.
CREATE TABLE atlas_feed (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  -- node (src: the node id), edge (src, dst, edge_kind) or full.
  kind TEXT NOT NULL CHECK (kind IN ('node', 'edge', 'full')),
  src TEXT NOT NULL DEFAULT '',
  dst TEXT NOT NULL DEFAULT '',
  edge_kind TEXT NOT NULL DEFAULT ''
);
CREATE INDEX atlas_feed_repo ON atlas_feed (repo_id, kind, id);

-- The feed position a snapshot reflects (NULL: projected without the feed, so
-- the next projection reads the whole graph), and the position it started
-- from (NULL: it read the whole graph).
ALTER TABLE atlas_snapshots ADD COLUMN feed_mark INTEGER;
ALTER TABLE atlas_snapshots ADD COLUMN feed_base INTEGER;
