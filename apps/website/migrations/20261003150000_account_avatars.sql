-- Profile pictures for people (CORE-116). The image lives in the AVATARS R2
-- bucket under a content-hashed key; null shows initials.
ALTER TABLE accounts ADD COLUMN avatar_key TEXT;

-- Generated avatar options: made once per person, never again (no rerolls).
-- The row is claimed before any model runs, so concurrent requests can't
-- generate twice; `status` records how that one generation went.
CREATE TABLE avatar_generations (
  user_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('generating', 'ready', 'failed')),
  -- JSON array of R2 keys, in display order, once ready.
  options TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);
