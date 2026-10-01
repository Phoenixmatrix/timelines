-- Users and organizations share one namespace of owner slugs, like on GitHub.
CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user', 'org')),
  slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  is_site_admin INTEGER NOT NULL DEFAULT 0,
  -- Orgs only: the role every member gets on every repo the org owns.
  member_repo_role TEXT CHECK (member_repo_role IN ('none', 'read', 'write')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE org_members (
  org_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE repos (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES accounts (id),
  name TEXT NOT NULL COLLATE NOCASE,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  default_branch TEXT NOT NULL DEFAULT 'main',
  -- Opaque storage name, so renames and transfers never touch Artifacts.
  artifacts_name TEXT NOT NULL UNIQUE,
  artifacts_remote TEXT NOT NULL,
  imported_from TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  pushed_at TEXT,
  UNIQUE (owner_id, name)
);

CREATE TABLE repo_collaborators (
  repo_id TEXT NOT NULL REFERENCES repos (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('read', 'write', 'admin')),
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (repo_id, user_id)
);

-- Personal access tokens for git over HTTPS. Only a SHA-256 of the secret is kept.
CREATE TABLE access_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('read', 'write')),
  token_hash TEXT NOT NULL UNIQUE,
  last_four TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT
);

CREATE INDEX access_tokens_user ON access_tokens (user_id);
CREATE INDEX repo_collaborators_user ON repo_collaborators (user_id);
CREATE INDEX org_members_user ON org_members (user_id);
