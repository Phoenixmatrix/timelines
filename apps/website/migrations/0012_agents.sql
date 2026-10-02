-- Agents: identities that act on their own (claiming tracker work, commenting)
-- with a human accountable for them. An agent authenticates with its own
-- access tokens; it keeps its human's permissions, but its actions are
-- attributed to the agent.
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  accountable_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);

CREATE UNIQUE INDEX agents_name ON agents (accountable_id, name);

-- A token with an agent_id acts as that agent; user_id stays its human.
ALTER TABLE access_tokens ADD COLUMN agent_id TEXT REFERENCES agents (id) ON DELETE CASCADE;

CREATE INDEX access_tokens_agent ON access_tokens (agent_id);
