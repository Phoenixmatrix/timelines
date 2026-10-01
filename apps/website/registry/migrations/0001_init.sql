-- A feed: one format's registry for one gitmatrix owner. The owner's own
-- packages live in the feed whose key is the owner slug; remote caches and
-- virtual feeds are named `<owner>.<name>`.
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  format TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('local', 'remote', 'virtual')),
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'internal', 'private')),
  description TEXT NOT NULL DEFAULT '',
  -- Format- and kind-specific settings (upstream, TTLs, retention, pinned
  -- namespaces, default deploy repo...). Validated by zod in src/core/repos.ts.
  config TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (format, key)
);
CREATE INDEX repositories_owner ON repositories (owner_id);

CREATE TABLE virtual_members (
  virtual_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  include_patterns TEXT NOT NULL DEFAULT '[]',
  exclude_patterns TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (virtual_id, member_id)
);
CREATE INDEX virtual_members_member ON virtual_members (member_id);

-- Content-addressed catalog. Bytes live in R2 at an opaque key; `digest` is
-- `sha256:<hex>` and deduplicates across every repository and format.
CREATE TABLE blobs (
  digest TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  md5 TEXT,
  sha1 TEXT,
  sha512 TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (repo_id, normalized_name)
);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'yanked', 'deprecated')),
  status_reason TEXT,
  published_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (package_id, version)
);

-- Every stored artifact file, addressed by its repository path.
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  version_id TEXT REFERENCES versions (id) ON DELETE CASCADE,
  digest TEXT NOT NULL REFERENCES blobs (digest),
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  metadata TEXT NOT NULL DEFAULT '{}',
  downloads INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (repo_id, path)
);
CREATE INDEX files_version ON files (version_id);
CREATE INDEX files_digest ON files (digest);

CREATE TABLE dist_tags (
  package_id TEXT NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (package_id, tag)
);

-- OCI. Manifest bytes are blobs; blobs pushed to a repository are linked here
-- so cross-repository mounts never leak private layers.
CREATE TABLE oci_blob_links (
  repo_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  digest TEXT NOT NULL REFERENCES blobs (digest),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, name, digest)
);
CREATE INDEX oci_blob_links_digest ON oci_blob_links (digest);

CREATE TABLE oci_manifests (
  repo_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  digest TEXT NOT NULL REFERENCES blobs (digest),
  media_type TEXT NOT NULL,
  artifact_type TEXT,
  subject TEXT,
  size INTEGER NOT NULL,
  annotations TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, name, digest)
);
CREATE INDEX oci_manifests_subject ON oci_manifests (repo_id, name, subject);

CREATE TABLE oci_manifest_refs (
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  manifest TEXT NOT NULL,
  ref TEXT NOT NULL,
  PRIMARY KEY (repo_id, name, manifest, ref),
  FOREIGN KEY (repo_id, name, manifest) REFERENCES oci_manifests (repo_id, name, digest) ON DELETE CASCADE
);
CREATE INDEX oci_manifest_refs_ref ON oci_manifest_refs (ref);

CREATE TABLE oci_tags (
  repo_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  tag TEXT NOT NULL,
  digest TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, name, tag)
);

CREATE TABLE releases (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  project TEXT NOT NULL,
  tag TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  draft INTEGER NOT NULL DEFAULT 0,
  prerelease INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (repo_id, project, tag)
);

CREATE TABLE release_assets (
  release_id TEXT NOT NULL REFERENCES releases (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  digest TEXT NOT NULL REFERENCES blobs (digest),
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  downloads INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (release_id, name)
);

-- Generated index files (Packages, repomd.xml, index.yaml, git objects...),
-- rebuilt by the repository's RepoDO. `generation` lets by-hash readers find
-- recent copies after a rebuild.
CREATE TABLE derived_files (
  repo_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  content_type TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)
);

-- Remote repositories: what was fetched from upstream and until when it is fresh.
CREATE TABLE remote_entries (
  repo_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  digest TEXT,
  content_type TEXT,
  etag TEXT,
  last_modified TEXT,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)
);

CREATE TABLE signing_keys (
  repo_id TEXT PRIMARY KEY REFERENCES repositories (id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  public_key TEXT NOT NULL,
  private_key_sealed TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  repo_id TEXT,
  target TEXT,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_log_repo ON audit_log (repo_id, at);
CREATE INDEX audit_log_at ON audit_log (at);
