-- Wiki pages for timelines (CORE-84): written when a checkpoint is made, or
-- on demand, never on every push. They describe what a timeline adds or
-- changes in components and concepts, and live apart from main's wiki_pages,
-- which nothing here writes. Once a timeline's overlay has ended (CORE-139)
-- its page sets are kept, read-only, and no new one is started.

-- One set of pages per timeline bookmark and checkpoint (or on-demand commit).
CREATE TABLE kg_page_sets (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  -- The bookmark: refs/heads/timeline/<slug>.
  ref TEXT NOT NULL,
  -- What it was written for: a checkpoint's id, or `commit:<oid>` on demand.
  -- A second request for the same key is the same set (idempotent).
  set_key TEXT NOT NULL,
  checkpoint_id TEXT,
  checkpoint_number INTEGER,
  -- The timeline commit the pages describe.
  commit_oid TEXT NOT NULL,
  -- Main's indexed commit they were measured against, once planned.
  base_commit TEXT,
  status TEXT NOT NULL
    CHECK (status IN ('queued', 'writing', 'succeeded', 'failed', 'ended')),
  -- The workflow instance writing it.
  build_id TEXT,
  -- JSON: the overlay's per-kind counts, pages planned, written, kept, copied, skipped, tokens.
  stats TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  requested_by TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT,
  PRIMARY KEY (repo_id, ref, set_key)
);

CREATE INDEX kg_page_sets_queue ON kg_page_sets (repo_id, status, requested_at);

-- The pages of a set: written for the timeline, or `kept` when main's page
-- still holds (no body; read main's).
CREATE TABLE kg_page_set_pages (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  ref TEXT NOT NULL,
  set_key TEXT NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  section TEXT NOT NULL,
  position INTEGER NOT NULL,
  node_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('component', 'architecture', 'glossary')),
  -- Whether the timeline adds the page's subject or changes it.
  change TEXT NOT NULL CHECK (change IN ('added', 'changed')),
  outcome TEXT NOT NULL CHECK (outcome IN ('written', 'kept')),
  body TEXT NOT NULL DEFAULT '',
  diagram TEXT NOT NULL DEFAULT '',
  sources TEXT NOT NULL DEFAULT '[]',
  inputs_hash TEXT NOT NULL,
  model TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, ref, set_key, slug)
);
