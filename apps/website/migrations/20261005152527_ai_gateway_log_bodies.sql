-- Whether AI Gateway logs keep model request and response bodies (CORE-290),
-- per component (shared/ai.ts AI_LOG_COMPONENTS). Without a site row a
-- component follows the environment's default (AI_LOG_BODIES: off once
-- deployed, on in development); without an account row it follows the site.
CREATE TABLE site_ai_log_bodies (
  component TEXT PRIMARY KEY,
  keep INTEGER NOT NULL CHECK (keep IN (0, 1)),
  updated_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- An account's override for its own calls (the call's account decides).
CREATE TABLE account_ai_log_bodies (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  component TEXT NOT NULL,
  keep INTEGER NOT NULL CHECK (keep IN (0, 1)),
  updated_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (account_id, component)
);
