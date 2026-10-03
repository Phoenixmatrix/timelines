-- The relationship lens (CORE-169): a file's capability, indexed, so the
-- imports behind one capability-to-capability relation can be listed without
-- scanning every edge.
ALTER TABLE atlas_entities ADD COLUMN capability TEXT
  GENERATED ALWAYS AS (json_extract(data, '$.membership.capability')) VIRTUAL;
CREATE INDEX atlas_entities_capability ON atlas_entities (scope, capability) WHERE capability IS NOT NULL;
