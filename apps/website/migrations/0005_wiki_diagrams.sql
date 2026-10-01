-- Diagrams are drawn from the graph on every build (cheap and exact), so they
-- live apart from the model-written body, which is only rewritten when needed.
ALTER TABLE wiki_pages ADD COLUMN diagram TEXT NOT NULL DEFAULT '';
