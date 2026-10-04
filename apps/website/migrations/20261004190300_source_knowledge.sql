ALTER TABLE kg_overlays RENAME TO kg_overlays_legacy;
CREATE TABLE kg_overlays (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ref TEXT NOT NULL, overlay_id TEXT, head_commit TEXT, base_commit TEXT, merge_base TEXT,
  stats TEXT NOT NULL DEFAULT '{}', updated_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('succeeded','failed')), attempted_commit TEXT NOT NULL,
  error TEXT, ended_at TEXT, ended_reason TEXT CHECK(ended_reason IN ('landed','abandoned','ended')),
  removed_at TEXT, source_id TEXT NOT NULL DEFAULT 'canonical',
  PRIMARY KEY(repo_id,source_id,ref)
);
INSERT INTO kg_overlays SELECT *, 'canonical' FROM kg_overlays_legacy;
DROP TABLE kg_overlays_legacy;

ALTER TABLE kg_page_sets RENAME TO kg_page_sets_legacy;
CREATE TABLE kg_page_sets (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ref TEXT NOT NULL, set_key TEXT NOT NULL, checkpoint_id TEXT, checkpoint_number INTEGER,
  commit_oid TEXT NOT NULL, base_commit TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','writing','succeeded','failed','ended')),
  build_id TEXT, stats TEXT NOT NULL DEFAULT '{}', error TEXT, requested_by TEXT,
  requested_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT, ai_snapshot TEXT, source_id TEXT NOT NULL DEFAULT 'canonical',
  PRIMARY KEY(repo_id,source_id,ref,set_key)
);
INSERT INTO kg_page_sets SELECT *, 'canonical' FROM kg_page_sets_legacy;
DROP TABLE kg_page_sets_legacy;
CREATE INDEX kg_page_sets_queue ON kg_page_sets(repo_id,status,requested_at);

ALTER TABLE kg_page_set_pages RENAME TO kg_page_set_pages_legacy;
CREATE TABLE kg_page_set_pages (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  ref TEXT NOT NULL, set_key TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL,
  section TEXT NOT NULL, position INTEGER NOT NULL, node_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('component','architecture','glossary')),
  change TEXT NOT NULL CHECK(change IN ('added','changed')),
  outcome TEXT NOT NULL CHECK(outcome IN ('written','kept')),
  body TEXT NOT NULL DEFAULT '', diagram TEXT NOT NULL DEFAULT '', sources TEXT NOT NULL DEFAULT '[]',
  inputs_hash TEXT NOT NULL, model TEXT, tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_id TEXT NOT NULL DEFAULT 'canonical',
  source_locations TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(repo_id,source_id,ref,set_key,slug)
);
INSERT INTO kg_page_set_pages SELECT *, 'canonical', '[]' FROM kg_page_set_pages_legacy;
DROP TABLE kg_page_set_pages_legacy;
CREATE INDEX kg_overlays_source ON kg_overlays(repo_id, source_id);
CREATE INDEX kg_page_sets_source ON kg_page_sets(repo_id, source_id);

-- Publication and ending share the D1 write transaction. A late Workflow cannot
-- resurrect or replace an archived source's last readable snapshot.
CREATE TRIGGER knowledge_source_ended AFTER UPDATE OF state ON timeline_work_sources
WHEN NEW.state IN ('archived', 'purging', 'purged') AND OLD.state = 'ready'
BEGIN
  UPDATE kg_overlays SET ended_at = COALESCE(ended_at, NEW.archived_at, NEW.updated_at),
    ended_reason = COALESCE(ended_reason, 'ended')
    WHERE repo_id = NEW.repo_id AND source_id = NEW.source_id;
  UPDATE kg_page_sets SET status = 'ended', finished_at = NEW.updated_at
    WHERE repo_id = NEW.repo_id AND source_id = NEW.source_id AND status IN ('queued', 'writing');
END;
CREATE TRIGGER knowledge_overlay_source_insert BEFORE INSERT ON kg_overlays
WHEN NEW.source_id <> 'canonical' AND NOT EXISTS (
  SELECT 1 FROM timeline_work_sources s JOIN repos r ON r.id = s.repo_id
  WHERE s.repo_id = NEW.repo_id AND s.source_id = NEW.source_id
    AND s.state = 'ready' AND r.deleted_at IS NULL
)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER knowledge_overlay_source_update BEFORE UPDATE ON kg_overlays
WHEN NEW.ended_at IS NULL AND NEW.source_id <> 'canonical' AND NOT EXISTS (
  SELECT 1 FROM timeline_work_sources s JOIN repos r ON r.id = s.repo_id
  WHERE s.repo_id = NEW.repo_id AND s.source_id = NEW.source_id
    AND s.state = 'ready' AND r.deleted_at IS NULL
)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER knowledge_pages_source_insert BEFORE INSERT ON kg_page_sets
WHEN NEW.source_id <> 'canonical' AND NOT EXISTS (
  SELECT 1 FROM timeline_work_sources s JOIN repos r ON r.id = s.repo_id
  WHERE s.repo_id = NEW.repo_id AND s.source_id = NEW.source_id
    AND s.state = 'ready' AND r.deleted_at IS NULL
)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER knowledge_page_source_insert BEFORE INSERT ON kg_page_set_pages
WHEN EXISTS (
  SELECT 1 FROM kg_page_sets p LEFT JOIN timeline_work_sources s
    ON s.repo_id = p.repo_id AND s.source_id = p.source_id
  WHERE p.repo_id = NEW.repo_id AND p.source_id = NEW.source_id AND p.ref = NEW.ref AND p.set_key = NEW.set_key
    AND (p.status <> 'writing' OR (p.source_id <> 'canonical' AND
      (s.state IS NULL OR s.state <> 'ready' OR NOT EXISTS (
        SELECT 1 FROM repos r WHERE r.id = p.repo_id AND r.deleted_at IS NULL))))
)
BEGIN SELECT RAISE(IGNORE); END;
CREATE TRIGGER knowledge_page_source_update BEFORE UPDATE ON kg_page_set_pages
WHEN EXISTS (
  SELECT 1 FROM kg_page_sets p LEFT JOIN timeline_work_sources s
    ON s.repo_id = p.repo_id AND s.source_id = p.source_id
  WHERE p.repo_id = NEW.repo_id AND p.source_id = NEW.source_id AND p.ref = NEW.ref AND p.set_key = NEW.set_key
    AND (p.status <> 'writing' OR (p.source_id <> 'canonical' AND
      (s.state IS NULL OR s.state <> 'ready' OR NOT EXISTS (
        SELECT 1 FROM repos r WHERE r.id = p.repo_id AND r.deleted_at IS NULL))))
)
BEGIN SELECT RAISE(IGNORE); END;
