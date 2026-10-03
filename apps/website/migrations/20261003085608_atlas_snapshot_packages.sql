-- Cross-repository composition (CORE-167, worker/atlas/compose.ts): the
-- packages a repository publishes, frozen into each repository snapshot when
-- it is built, so a pinned workspace view resolves dependencies against the
-- same facts on every page.
--
-- JSON {"status": "recorded", "packages": [...], "truncated": bool} from the
-- registry's CI publish provenance (package_sources, latest publish), or
-- {"status": "error"} when the registry couldn't be read. NULL: built before
-- this was recorded; such a repository resolves no dependency to itself.
ALTER TABLE atlas_snapshots ADD COLUMN packages TEXT;
