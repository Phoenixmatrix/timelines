-- A timeline's computed regrouping (CORE-186, worker/atlas/timelineGrouping.ts):
-- how grouping would place the timeline's files, computed over the
-- capabilities it touches when its knowledge overlay is stored, and kept per
-- overlay. A new overlay for the timeline replaces it; storeOverlay drops the
-- previous overlay's row with the previous overlay's changes.
CREATE TABLE atlas_timeline_regroupings (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  overlay_id TEXT NOT NULL,
  -- The main snapshot it was computed against (null: there was none).
  snapshot_id TEXT,
  seq INTEGER,
  version INTEGER NOT NULL,
  grouping_version INTEGER NOT NULL,
  -- computed | skipped (reason: no-snapshot, too-large, error)
  state TEXT NOT NULL,
  reason TEXT,
  data TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, overlay_id)
);
