-- The agent that pushed or started a run, when one did; actor_id stays its
-- person, who is accountable for it.
ALTER TABLE ci_runs ADD COLUMN agent_id TEXT REFERENCES agents (id) ON DELETE SET NULL;
