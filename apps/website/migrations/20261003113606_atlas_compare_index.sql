-- Main snapshot comparisons (CORE-175, worker/atlas/compare.ts): what changed
-- between two retained snapshots S < T is exactly the rows opened in (S, T]
-- (from_seq) and the rows closed in (S, T] (to_seq, already indexed by
-- atlas_entities_open). This indexes the opened side, so a comparison reads
-- only the rows that changed, never a whole snapshot.
CREATE INDEX atlas_entities_opened ON atlas_entities (scope, from_seq);
