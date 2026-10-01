-- Homebrew taps are generated git repositories. Each row is one object:
-- `data` is base64 of the zlib-deflated content without the loose-object
-- header, which is exactly a pack entry's payload. `seq` is the number of the
-- commit that introduced the object; the commit with the highest `seq` is
-- refs/heads/main.
CREATE TABLE brew_git_objects (
  repo_id TEXT NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  oid TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('commit', 'tree', 'blob')),
  size INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (repo_id, oid)
);
CREATE INDEX brew_git_objects_seq ON brew_git_objects (repo_id, type, seq);
