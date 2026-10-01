-- How the artifact store fits gitmatrix: packages remember where they came
-- from, and repositories are granted the right to publish them.

-- Repositories allowed to publish a package: their CI jobs, and people with
-- write access to them. A package with no sources is open to anyone who may
-- publish to its owner; its first CI publish names that repository a source.
CREATE TABLE package_sources (
  package_id TEXT NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  -- gitmatrix repos.id (another database: no foreign key).
  git_repo_id TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (package_id, git_repo_id)
);
CREATE INDEX package_sources_repo ON package_sources (git_repo_id);

-- Every publish, in every format, with where it came from. This is the
-- package's history and the stream the console queries: one row per version
-- pushed (npm/pypi/cargo... version, OCI tag or digest, release asset,
-- generic file), at tens of thousands a day.
CREATE TABLE publishes (
  id TEXT PRIMARY KEY,
  feed_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  package_id TEXT NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  -- sha256:… of the primary file or manifest, when there is one.
  digest TEXT,
  size INTEGER,
  action TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'yanked', 'deprecated', 'deleted')),
  -- Where it came from (all null for a person publishing by hand).
  git_repo_id TEXT,
  commit_oid TEXT,
  ref TEXT,
  ci_run_id TEXT,
  ci_job_id TEXT,
  run_number INTEGER,
  -- `user:<account id>` or `job:<ci job id>`, and how they signed in.
  actor TEXT NOT NULL,
  actor_label TEXT NOT NULL,
  via TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX publishes_package_at ON publishes (package_id, at);
CREATE INDEX publishes_package_version ON publishes (package_id, version);
CREATE INDEX publishes_feed_at ON publishes (feed_id, at);
CREATE INDEX publishes_commit ON publishes (git_repo_id, commit_oid);
CREATE INDEX publishes_run ON publishes (ci_run_id);

