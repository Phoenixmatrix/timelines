ALTER TABLE ref_updates ADD COLUMN source_id TEXT NOT NULL DEFAULT 'canonical';
DROP INDEX ref_updates_ref;
CREATE INDEX ref_updates_ref ON ref_updates (repo_id, source_id, ref, id);

CREATE TABLE source_repo_refs (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL DEFAULT 'canonical',
  ref TEXT NOT NULL,
  oid TEXT NOT NULL,
  PRIMARY KEY(repo_id, source_id, ref)
);
INSERT INTO source_repo_refs(repo_id, ref, oid) SELECT repo_id, ref, oid FROM repo_refs;
DROP TABLE repo_refs;
ALTER TABLE source_repo_refs RENAME TO repo_refs;

CREATE TABLE source_change_refs (
  repo_id TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL DEFAULT 'canonical',
  change_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  first_commit_oid TEXT NOT NULL,
  first_update_id INTEGER NOT NULL REFERENCES ref_updates(id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_commit_oid TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY(repo_id, source_id, change_id, ref)
);
INSERT INTO source_change_refs(repo_id,change_id,ref,first_commit_oid,first_update_id,first_seen_at,last_commit_oid,last_seen_at)
SELECT repo_id,change_id,ref,first_commit_oid,first_update_id,first_seen_at,last_commit_oid,last_seen_at FROM change_refs;
DROP TABLE change_refs;
ALTER TABLE source_change_refs RENAME TO change_refs;
CREATE INDEX change_refs_ref ON change_refs(repo_id,source_id,ref,first_seen_at);
CREATE INDEX change_refs_first_commit ON change_refs(repo_id,source_id,first_commit_oid);
CREATE INDEX change_refs_last_commit ON change_refs(repo_id,source_id,last_commit_oid);
CREATE INDEX change_refs_first_update ON change_refs(first_update_id);

-- Compact release grouping survives expiry of the physical work source.
CREATE TABLE source_integration_inputs (
  receipt_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  commits_json TEXT NOT NULL
);
CREATE INDEX source_integration_inputs_repo ON source_integration_inputs(repo_id);

ALTER TABLE release_note_entries ADD COLUMN provenance TEXT NOT NULL DEFAULT '[]';
ALTER TABLE release_note_entries ADD COLUMN regeneration_inputs TEXT NOT NULL DEFAULT '{}';
