-- Auxiliary recent observations, not an activity history or permanent attribution.
CREATE TABLE agent_presence (
  id INTEGER PRIMARY KEY,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('ci-run', 'deployment', 'commit', 'timeline')),
  scope_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  last_seen_at TEXT NOT NULL,
  UNIQUE (target_kind, scope_id, resource_id, source_id, agent_id)
);
CREATE INDEX agent_presence_target_recent
  ON agent_presence (target_kind, scope_id, resource_id, source_id, last_seen_at DESC, agent_id);
CREATE INDEX agent_presence_stale ON agent_presence (last_seen_at);
