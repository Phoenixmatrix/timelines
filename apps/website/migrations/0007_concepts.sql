-- Concept alignment and trimming (worker/knowledge/concepts.ts).

-- clef's decision about one candidate pair of concept keys (a < b).
CREATE TABLE kg_concept_pairs (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  version TEXT NOT NULL,
  -- 0 different, 1 related but separate, 2 the same concept (expected level).
  score REAL NOT NULL,
  -- P(a is a part, kind or aspect of b), and the reverse.
  a_in_b REAL NOT NULL,
  b_in_a REAL NOT NULL,
  PRIMARY KEY (repo_id, a, b)
);

-- Every concept key seen, the canonical key it merges into (itself when it
-- leads its group), and for canonical keys whether it earns a glossary entry.
CREATE TABLE kg_concepts (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  canonical TEXT NOT NULL,
  -- P(glossary-worthy) from clef; NULL when not asked (aliases, well-used concepts).
  recurring REAL,
  salient INTEGER,
  -- What `recurring` was judged from, so it is asked again only when that changes.
  salience_hash TEXT,
  PRIMARY KEY (repo_id, key)
);

-- Narrower concept -> broader concept, between canonical keys.
CREATE TABLE kg_concept_links (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  narrower TEXT NOT NULL,
  broader TEXT NOT NULL,
  PRIMARY KEY (repo_id, narrower, broader)
);

-- Second opinion on related pairs of kept concepts (canonical keys a < b),
-- asked with their definitions; it overrides the first pass for that pair.
CREATE TABLE kg_concept_reviews (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  score REAL NOT NULL,
  -- Both names and definitions it was judged from.
  inputs_hash TEXT NOT NULL,
  PRIMARY KEY (repo_id, a, b)
);
