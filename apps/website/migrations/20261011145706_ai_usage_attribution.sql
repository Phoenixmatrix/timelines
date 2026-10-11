-- Who AI usage was for (CORE-222): the person, the agent acting for them, and
-- the timeline, when the work that ran the model knows them ('' otherwise),
-- so the usage report can show costs by person, agent and timeline. Rows
-- recorded before keep '' and count as not attributed.
ALTER TABLE ai_usage RENAME TO ai_usage_legacy;
CREATE TABLE ai_usage (
  day TEXT NOT NULL,
  account_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  actor_id TEXT NOT NULL DEFAULT '',
  agent_id TEXT NOT NULL DEFAULT '',
  timeline TEXT NOT NULL DEFAULT '',
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Calls whose provider reported only a total, or nothing (images, embeddings).
  total_tokens INTEGER NOT NULL DEFAULT 0,
  failed_calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, account_id, feature, model, actor_id, agent_id, timeline)
);
INSERT INTO ai_usage (day, account_id, feature, model, calls, input_tokens, output_tokens,
  total_tokens, failed_calls)
SELECT day, account_id, feature, model, calls, input_tokens, output_tokens, total_tokens,
  failed_calls
FROM ai_usage_legacy;
DROP TABLE ai_usage_legacy;

-- The usage report reads each window's sandbox jobs by when they finished
-- (worker/usage/attribution.ts) on every view, not only in the daily collection.
CREATE INDEX ci_jobs_sandbox_finished ON ci_jobs(finished_at) WHERE runner = 'sandbox';
