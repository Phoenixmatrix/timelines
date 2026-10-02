-- Physical generations outlive logical digest locators while snapshots depend on them.
CREATE TABLE blob_representations (
  key TEXT PRIMARY KEY, digest TEXT NOT NULL, base_key TEXT,
  state TEXT NOT NULL DEFAULT 'live' CHECK(state IN ('live','retired','deleting')),
  retired_at TEXT
);
CREATE INDEX blob_representation_base ON blob_representations(base_key);
CREATE INDEX blob_representation_retirement ON blob_representations(state,retired_at);
-- Test existence explicitly: an enclosing UPSERT can override a trigger's OR IGNORE.
CREATE TRIGGER blob_representation_insert AFTER INSERT ON blobs BEGIN
  INSERT INTO blob_representations(key,digest) SELECT NEW.r2_key,NEW.digest
    WHERE NOT EXISTS(SELECT 1 FROM blob_representations WHERE key=NEW.r2_key);
END;
CREATE TRIGGER blob_representation_update AFTER UPDATE OF r2_key ON blobs WHEN OLD.r2_key != NEW.r2_key BEGIN
  INSERT INTO blob_representations(key,digest) SELECT OLD.r2_key,OLD.digest
    WHERE NOT EXISTS(SELECT 1 FROM blob_representations WHERE key=OLD.r2_key);
  UPDATE blob_representations SET state='retired',retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key=OLD.r2_key;
  INSERT INTO blob_representations(key,digest) SELECT NEW.r2_key,NEW.digest
    WHERE NOT EXISTS(SELECT 1 FROM blob_representations WHERE key=NEW.r2_key);
  UPDATE blob_representations SET state='live',retired_at=NULL WHERE key=NEW.r2_key AND state!='deleting';
END;
CREATE TRIGGER blob_representation_delete AFTER DELETE ON blobs BEGIN
  INSERT INTO blob_representations(key,digest) SELECT OLD.r2_key,OLD.digest
    WHERE NOT EXISTS(SELECT 1 FROM blob_representations WHERE key=OLD.r2_key);
  UPDATE blob_representations SET state='retired',retired_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE key=OLD.r2_key;
END;
CREATE TABLE artifact_publications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL, lineage TEXT NOT NULL, version TEXT NOT NULL,
  source TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', snapshot_key TEXT
);
CREATE INDEX artifact_publication_lineage ON artifact_publications(repo_id,lineage,created_at,id);
CREATE INDEX artifact_publication_pending ON artifact_publications(repo_id,lineage,created_at,id) WHERE status='pending';
CREATE INDEX artifact_publication_pending_digest ON artifact_publications(digest,id) WHERE status='pending';
CREATE INDEX artifact_publication_snapshot ON artifact_publications(repo_id,lineage,created_at,id) WHERE snapshot_key IS NOT NULL;
CREATE INDEX artifact_publication_digest ON artifact_publications(digest);
CREATE INDEX artifact_publication_source ON artifact_publications(source,repo_id,created_at,id);
-- At most two rows per lineage; never count a version's entire successor history.
CREATE TABLE artifact_hot_versions (
  repo_id TEXT NOT NULL, lineage TEXT NOT NULL, version TEXT NOT NULL,
  publication_id INTEGER NOT NULL UNIQUE, created_at TEXT NOT NULL,
  PRIMARY KEY(repo_id,lineage,version)
);
CREATE TRIGGER artifact_publication_insert AFTER INSERT ON artifact_publications BEGIN
  UPDATE artifact_publications SET status='gone' WHERE repo_id=NEW.repo_id AND source=NEW.source
    AND status='pending' AND (created_at,id)<(NEW.created_at,NEW.id);
  UPDATE artifact_publications SET status='gone' WHERE id=NEW.id AND EXISTS(
    SELECT 1 FROM artifact_publications p WHERE p.repo_id=NEW.repo_id AND p.source=NEW.source
      AND (p.created_at,p.id)>(NEW.created_at,NEW.id));
  INSERT INTO artifact_hot_versions(repo_id,lineage,version,publication_id,created_at)
    VALUES(NEW.repo_id,NEW.lineage,NEW.version,NEW.id,NEW.created_at)
    ON CONFLICT(repo_id,lineage,version) DO UPDATE SET
      publication_id=excluded.publication_id,created_at=excluded.created_at
    WHERE (excluded.created_at,excluded.publication_id)>(artifact_hot_versions.created_at,artifact_hot_versions.publication_id);
  DELETE FROM artifact_hot_versions WHERE repo_id=NEW.repo_id AND lineage=NEW.lineage
    AND publication_id NOT IN (SELECT publication_id FROM artifact_hot_versions
      WHERE repo_id=NEW.repo_id AND lineage=NEW.lineage ORDER BY created_at DESC,publication_id DESC LIMIT 2);
END;
CREATE TRIGGER artifact_generic_delete AFTER DELETE ON files BEGIN
  UPDATE artifact_publications SET status='gone' WHERE repo_id=OLD.repo_id AND source=OLD.path AND status='pending';
END;
CREATE TRIGGER artifact_release_delete AFTER DELETE ON release_assets BEGIN
  UPDATE artifact_publications SET status='gone' WHERE source=OLD.release_id || '/' || OLD.name
    AND lineage LIKE 'release:%' AND status='pending';
END;
-- A deduplicated historical re-upload must not strand the promoted raw generation.
CREATE TRIGGER artifact_raw_promotion AFTER UPDATE OF r2_key ON blobs
WHEN OLD.r2_key LIKE 'c/%' AND NEW.r2_key NOT LIKE 'c/%' BEGIN
  UPDATE artifact_publications SET status='pending' WHERE id=(
    SELECT id FROM artifact_live_publications WHERE digest=NEW.digest AND status='done'
    ORDER BY created_at DESC,id DESC LIMIT 1);
END;
-- Publication recording is part of attachment, not a best-effort post-upload callback.
CREATE TRIGGER artifact_generic_insert AFTER INSERT ON files
WHEN EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND format='generic')
 AND instr(NEW.path,'/')>0 AND instr(substr(NEW.path,instr(NEW.path,'/')+1),'/')>0
BEGIN
  INSERT OR IGNORE INTO artifact_publications(repo_id,lineage,version,source,digest,created_at)
  SELECT NEW.repo_id,'generic:' || substr(NEW.path,1,instr(NEW.path,'/')-1) || '/' || substr(rest,instr(rest,'/')+1),
    substr(rest,1,instr(rest,'/')-1),NEW.path,NEW.digest,NEW.created_at
  FROM (SELECT substr(NEW.path,instr(NEW.path,'/')+1) AS rest);
END;
CREATE TRIGGER artifact_generic_update AFTER UPDATE OF digest ON files WHEN OLD.digest!=NEW.digest
 AND EXISTS(SELECT 1 FROM repositories WHERE id=NEW.repo_id AND format='generic')
 AND instr(NEW.path,'/')>0 AND instr(substr(NEW.path,instr(NEW.path,'/')+1),'/')>0
BEGIN
  INSERT OR IGNORE INTO artifact_publications(repo_id,lineage,version,source,digest,created_at)
  SELECT NEW.repo_id,'generic:' || substr(NEW.path,1,instr(NEW.path,'/')-1) || '/' || substr(rest,instr(rest,'/')+1),
    substr(rest,1,instr(rest,'/')-1),NEW.path,NEW.digest,NEW.created_at
  FROM (SELECT substr(NEW.path,instr(NEW.path,'/')+1) AS rest);
END;
CREATE TRIGGER artifact_release_insert AFTER INSERT ON release_assets BEGIN
  INSERT OR IGNORE INTO artifact_publications(repo_id,lineage,version,source,digest,created_at)
  SELECT repo_id,'release:' || project || '/' || NEW.name,tag,id || '/' || NEW.name,NEW.digest,NEW.created_at FROM releases WHERE id=NEW.release_id;
END;
CREATE TRIGGER artifact_release_update AFTER UPDATE OF digest ON release_assets WHEN OLD.digest!=NEW.digest BEGIN
  INSERT OR IGNORE INTO artifact_publications(repo_id,lineage,version,source,digest,created_at)
  SELECT repo_id,'release:' || project || '/' || NEW.name,tag,id || '/' || NEW.name,NEW.digest,NEW.created_at FROM releases WHERE id=NEW.release_id;
END;
CREATE TABLE artifact_backfill (name TEXT PRIMARY KEY, cursor INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0);
INSERT INTO artifact_backfill(name) VALUES('blobs'),('files'),('release_assets');
CREATE TABLE blob_compactions (
  id TEXT PRIMARY KEY, publication_id INTEGER NOT NULL UNIQUE, digest TEXT NOT NULL UNIQUE,
  source_key TEXT NOT NULL, base_key TEXT, size INTEGER NOT NULL,
  frame INTEGER NOT NULL DEFAULT 0, hash_state TEXT NOT NULL,
  full_bytes INTEGER NOT NULL DEFAULT 0, delta_bytes INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL DEFAULT 'build', cleanup_cursor TEXT,
  result_key TEXT,
  fence TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX blob_compaction_source ON blob_compactions(source_key);
CREATE INDEX blob_compaction_base ON blob_compactions(base_key);
CREATE INDEX blob_compaction_generation_key ON blob_compactions('c/' || id || '/index.json');
CREATE INDEX blob_compaction_lease ON blob_compactions(lease_until);
CREATE TABLE blob_compaction_frames (
  work_id TEXT NOT NULL, frame INTEGER NOT NULL,
  full_frame TEXT NOT NULL, delta_frame TEXT,
  PRIMARY KEY(work_id,frame), FOREIGN KEY(work_id) REFERENCES blob_compactions(id) ON DELETE CASCADE
);
CREATE TRIGGER blob_compaction_generation AFTER INSERT ON blob_compactions BEGIN
  INSERT INTO blob_representations(key,digest,base_key,state,retired_at)
    VALUES('c/' || NEW.id || '/index.json',NEW.digest,NEW.base_key,'retired',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE VIEW artifact_live_publications AS
SELECT p.* FROM artifact_publications p WHERE
 NOT EXISTS(SELECT 1 FROM artifact_publications newer WHERE newer.repo_id=p.repo_id
   AND newer.source=p.source AND newer.lineage=p.lineage AND (newer.created_at,newer.id)>(p.created_at,p.id))
 AND ((p.lineage LIKE 'generic:%' AND EXISTS(SELECT 1 FROM files f WHERE f.repo_id=p.repo_id AND f.path=p.source AND f.digest=p.digest))
 OR (p.lineage LIKE 'release:%' AND EXISTS(SELECT 1 FROM release_assets a
   WHERE a.release_id=substr(p.source,1,instr(p.source,'/')-1)
     AND a.name=substr(p.source,instr(p.source,'/')+1) AND a.digest=p.digest)));
CREATE VIEW artifact_hot_digests AS
-- Fix join order: a digest may occur in millions of cold publications.
-- Start from the two hot rows per lineage, then look up publications by primary key.
SELECT DISTINCT p.digest FROM artifact_hot_versions h
CROSS JOIN artifact_live_publications p ON p.id=h.publication_id;
