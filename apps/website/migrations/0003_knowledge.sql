-- Knowledge graph, its build history, and the wiki generated from it.

-- What one version of one file says, analyzed once and reused by every commit
-- and repository that contains the same content. Bump the analyzer version
-- in code to re-analyze everything.
CREATE TABLE kg_blob_analysis (
  blob_oid TEXT NOT NULL,
  analyzer TEXT NOT NULL,
  language TEXT NOT NULL,
  -- JSON: summary, responsibilities, symbols, concepts, imports (see analyze.ts).
  data TEXT NOT NULL,
  model TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (blob_oid, analyzer)
);

-- Cached LLM syntheses (component and repository summaries), keyed by a hash
-- of everything they were written from.
CREATE TABLE kg_synthesis (
  key TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  model TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The graph of a repository at its last indexed commit.
CREATE TABLE kg_nodes (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  -- Stable ids: repo, dir:<path>, file:<path>, sym:<path>#<name>,
  -- pkg:<ecosystem>:<name>, concept:<slug>, component:<path>.
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  path TEXT,
  summary TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  -- Changes when anything a consumer would care about changes.
  content_hash TEXT NOT NULL,
  -- The commit at which this node last changed.
  changed_in TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, id)
);
CREATE INDEX kg_nodes_kind ON kg_nodes (repo_id, kind);

CREATE TABLE kg_edges (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  -- contains, defines, imports, depends_on, mentions, part_of, documents.
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (repo_id, src, dst, kind)
);
CREATE INDEX kg_edges_dst ON kg_edges (repo_id, dst);

CREATE TABLE kg_builds (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  from_commit TEXT,
  to_commit TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  phase TEXT NOT NULL DEFAULT 'queued',
  -- JSON counters: files analyzed, nodes changed, pages written, tokens…
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
CREATE INDEX kg_builds_repo ON kg_builds (repo_id, started_at);

-- The change feed: what each build did to the graph, for consumers that react
-- to changes instead of re-reading everything.
CREATE TABLE kg_changes (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  build_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  change TEXT NOT NULL CHECK (change IN ('added', 'changed', 'removed')),
  PRIMARY KEY (repo_id, build_id, node_id)
);

-- Where each repository's graph stands.
CREATE TABLE kg_state (
  repo_id TEXT PRIMARY KEY REFERENCES repos (id) ON DELETE CASCADE,
  indexed_commit TEXT,
  indexed_at TEXT,
  last_build_id TEXT
);

CREATE TABLE wiki_pages (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  section TEXT NOT NULL,
  position INTEGER NOT NULL,
  -- The graph node the page is about.
  node_id TEXT,
  body TEXT NOT NULL,
  -- JSON list of repo paths the page draws on.
  sources TEXT NOT NULL DEFAULT '[]',
  -- Hash of everything the page was written from; a page is rewritten only
  -- when this changes.
  inputs_hash TEXT NOT NULL,
  generated_in TEXT NOT NULL,
  model TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, slug)
);
