-- Capability identity (CORE-165): where a retired capability or area went.
-- When a build stops continuing an id (split, merge or removal), it records
-- the successors so an old link can explain the change instead of resolving
-- to something unrelated.
CREATE TABLE atlas_lineage (
  scope TEXT NOT NULL REFERENCES atlas_scopes (scope) ON DELETE CASCADE,
  entity_id TEXT NOT NULL,
  -- The snapshot that no longer has it.
  retired_seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  -- Its name when it was last seen.
  name TEXT NOT NULL,
  -- split, merged or removed
  change TEXT NOT NULL,
  -- JSON [{id, share}]: where its members went, largest share first.
  successors TEXT NOT NULL,
  PRIMARY KEY (scope, entity_id, retired_seq)
);
