-- Knowledge overlays (CORE-83): each timeline's graph diff against main,
-- recomputed on every push to its bookmark. Main's graph (kg_nodes, kg_edges)
-- and wiki are never written by an overlay.

-- The latest overlay per timeline bookmark, and how its last attempt went.
CREATE TABLE kg_overlays (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  -- The bookmark: refs/heads/timeline/<slug>.
  ref TEXT NOT NULL,
  -- The overlay whose changes are current (kg_overlay_changes.overlay_id);
  -- null until one has succeeded.
  overlay_id TEXT,
  -- The timeline commit those changes describe.
  head_commit TEXT,
  -- Main's indexed commit they are measured against.
  base_commit TEXT,
  -- Where the timeline's own changes are counted from; null when no shared
  -- history was found and the trees were compared directly.
  merge_base TEXT,
  -- JSON: files changed and analyzed, per-kind counts.
  stats TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT,
  -- The last attempt, which may be newer than the stored changes.
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  attempted_commit TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (repo_id, ref)
);

-- The nodes an overlay adds, changes or removes compared with main.
CREATE TABLE kg_overlay_changes (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  overlay_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('added', 'changed', 'removed')),
  name TEXT NOT NULL,
  path TEXT,
  summary TEXT NOT NULL DEFAULT '',
  -- JSON: { fields, links: { added, removed } }.
  detail TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (repo_id, overlay_id, node_id)
);
