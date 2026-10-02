-- When a build last changed the stored graph. Builds write the graph early and
-- finish much later; the map is cached by this, so it shows new structure as
-- soon as it lands instead of when (or if) the build finishes.
ALTER TABLE kg_state ADD COLUMN graph_at TEXT;
