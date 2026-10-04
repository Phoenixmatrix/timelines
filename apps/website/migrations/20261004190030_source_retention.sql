-- Consumer roots are acquired before publication and released after removal.
CREATE TABLE timeline_source_roots (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES timeline_work_sources(source_id) ON DELETE CASCADE,
  consumer_kind TEXT NOT NULL,
  consumer_id TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, source_id, consumer_kind, consumer_id, commit_oid)
);
CREATE INDEX timeline_source_roots_consumer ON timeline_source_roots(consumer_kind, consumer_id);

-- The frozen input is immutable across retries; no provider lookup chooses a new head.
CREATE TABLE timeline_source_migrations (
  owner_id TEXT NOT NULL,
  timeline_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('frozen', 'ready', 'cleaned')),
  input TEXT NOT NULL,
  output TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id, timeline_id)
);
