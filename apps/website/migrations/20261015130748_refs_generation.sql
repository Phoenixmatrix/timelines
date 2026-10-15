-- Each Artifacts repository's refs generation (CORE-444): the Worker adds one
-- after every ref write it makes or proxies (worker/objects.ts invalidateRefs),
-- once the write is over and before its client sees it end. The interactive
-- read API keeps ref listings in the colo's Cache API keyed by generation, so
-- a read that loads the row after a write never gets refs listed before it.
-- A canonical repository's Artifacts repository is the repos row's; a timeline
-- work source's is its timeline_work_sources row's.
ALTER TABLE repos ADD COLUMN refs_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE timeline_work_sources ADD COLUMN refs_generation INTEGER NOT NULL DEFAULT 0;
