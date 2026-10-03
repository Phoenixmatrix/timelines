-- A person's defaults for one tracker (CORE-119): team, layout and issue view,
-- kept on the server so they follow the person across browsers and devices,
-- one row per tracker. gm uses the team when nothing more specific sets one.
CREATE TABLE tracker_preferences (
  user_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  team_id TEXT,
  view TEXT NOT NULL DEFAULT 'list',
  query TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (user_id, owner_id)
);
