-- Atlas projections (CORE-158): immutable, snapshot-pinned views of the
-- knowledge graph. A scope ("repo:<id>" now, workspaces later) gets numbered
-- snapshots; entity and edge rows are valid for a range of them
-- [from_seq, to_seq), so a new snapshot writes only what changed and every
-- published snapshot keeps reading exactly what it published.

-- Every scope belongs to what it projects, so deleting a repository deletes
-- its Atlas rows too.
CREATE TABLE atlas_scopes (
  scope TEXT PRIMARY KEY,
  -- repo (one repository) now; workspace scopes come later.
  kind TEXT NOT NULL,
  repo_id TEXT REFERENCES repos (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE atlas_snapshots (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL REFERENCES atlas_scopes (scope) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  -- building, published, failed, expired
  status TEXT NOT NULL DEFAULT 'building',
  -- 1 when upstream analysis was incomplete (pending or skipped files).
  partial INTEGER NOT NULL DEFAULT 0,
  projection_version INTEGER NOT NULL,
  grouping_version INTEGER,
  -- JSON [{repoId, commit, buildId}]: one entry per repository, no common HEAD.
  vector TEXT NOT NULL,
  entities INTEGER NOT NULL DEFAULT 0,
  edges INTEGER NOT NULL DEFAULT 0,
  -- Bytes this snapshot added (rows it opened), for retention accounting.
  bytes INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  published_at TEXT,
  expires_at TEXT,
  UNIQUE (scope, seq)
);

-- The snapshot readers see for a scope; moved in one statement at publication.
CREATE TABLE atlas_current (
  scope TEXT PRIMARY KEY REFERENCES atlas_scopes (scope) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES atlas_snapshots (id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  published_at TEXT NOT NULL
);

CREATE TABLE atlas_entities (
  scope TEXT NOT NULL REFERENCES atlas_scopes (scope) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  -- NULL while still valid in the latest snapshot.
  to_seq INTEGER,
  kind TEXT NOT NULL,
  parent_id TEXT,
  -- Stable sibling order: lowercased name, then id.
  sort_key TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  summary TEXT NOT NULL DEFAULT '',
  -- JSON: source data plus deduplicated counts ({files, symbols, ...}).
  data TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (scope, entity_id, from_seq)
);
CREATE INDEX atlas_entities_children ON atlas_entities (scope, parent_id, sort_key);
CREATE INDEX atlas_entities_open ON atlas_entities (scope, to_seq);

CREATE TABLE atlas_edges (
  scope TEXT NOT NULL REFERENCES atlas_scopes (scope) ON DELETE CASCADE,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  kind TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  to_seq INTEGER,
  weight INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (scope, src, dst, kind, from_seq)
);
CREATE INDEX atlas_edges_incoming ON atlas_edges (scope, dst, kind);
CREATE INDEX atlas_edges_open ON atlas_edges (scope, to_seq);
