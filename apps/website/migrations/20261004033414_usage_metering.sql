-- Per-account usage metering (CORE-207). The hourly cron writes one row per
-- figure: storage as it stood when collected (kind 'storage', the collection
-- day) and activity totals of a whole UTC day (kind 'activity', that day).
-- Estimates say so (estimated = 1) and how they were made (method).
CREATE TABLE usage_snapshots (
  -- UTC day (YYYY-MM-DD) the figure describes.
  day TEXT NOT NULL,
  -- '' for site-wide data no single account owns (global caches, sign-in state).
  account_id TEXT NOT NULL,
  construct TEXT NOT NULL CHECK (construct IN ('d1', 'durable_objects', 'r2', 'artifacts', 'vectorize', 'ai_search', 'workers_ai', 'ci')),
  -- Within the construct: a D1 table group, a Durable Object class, a model…
  item TEXT NOT NULL,
  -- rows, bytes, instances, objects, repositories, vectors, dimensions, items,
  -- calls, input_tokens, output_tokens, minutes.
  metric TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('storage', 'activity')),
  quantity REAL NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  method TEXT NOT NULL,
  collected_at TEXT NOT NULL,
  PRIMARY KEY (day, account_id, construct, item, metric)
);
CREATE INDEX usage_snapshots_account ON usage_snapshots (account_id, day);

-- Workers AI calls and tokens per UTC day, account, feature and model,
-- recorded as each call returns (worker/usage/ai.ts). account_id '' when a
-- call ran outside any account's work.
CREATE TABLE ai_usage (
  day TEXT NOT NULL,
  account_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  -- Calls whose provider reported only a total, or nothing (images, embeddings).
  total_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, account_id, feature, model)
);

-- Artifacts reports no repository sizes: count the pack bytes each push sends
-- through the proxy (worker/git/http.ts) from now on.
ALTER TABLE repos ADD COLUMN pushed_bytes INTEGER NOT NULL DEFAULT 0;

-- What each AI Search item weighed when uploaded; NULL for items uploaded before.
ALTER TABLE kg_search_items ADD COLUMN bytes INTEGER;
