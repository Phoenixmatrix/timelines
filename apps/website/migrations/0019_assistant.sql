-- Conversations with the assistant (CORE-25). The transcript lives in each
-- chat's Durable Object; this is the directory a person browses, from the web
-- or `gm assistant list`.
CREATE TABLE assistant_chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  -- Where it started: "web" or "cli".
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX assistant_chats_user ON assistant_chats (user_id, updated_at DESC);
