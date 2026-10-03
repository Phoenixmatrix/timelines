-- Capability grouping (CORE-163): each file's placement for a snapshot being
-- built, written by the grouping step and read by the projection batches.
-- Transient: removed when the snapshot publishes or is rolled back.
CREATE TABLE atlas_assignments (
  scope TEXT NOT NULL REFERENCES atlas_scopes (scope) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  entity_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  -- JSON membership: capability, area, rationale, crossCutting, unclassified.
  data TEXT NOT NULL,
  PRIMARY KEY (scope, seq, entity_id)
);
