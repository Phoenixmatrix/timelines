-- Retention of usage history (CORE-225): daily figures past their policy are
-- rolled up into one row per month, keeping their sums, so totals over any
-- whole months stay exactly what they were.

-- usage_snapshots rolled up by UTC month (YYYY-MM).
CREATE TABLE usage_monthly (
  month TEXT NOT NULL,
  account_id TEXT NOT NULL,
  construct TEXT NOT NULL,
  item TEXT NOT NULL,
  metric TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('storage', 'activity')),
  -- The sum of the daily figures rolled up: activity's total over those days,
  -- storage's quantity-days (divide by `days` for the month's average).
  quantity REAL NOT NULL,
  days INTEGER NOT NULL,
  -- The latest day rolled up and its figure (storage as the month ended).
  last_day TEXT NOT NULL,
  last_quantity REAL NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0 CHECK (estimated IN (0, 1)),
  method TEXT NOT NULL,
  PRIMARY KEY (month, account_id, construct, item, metric)
);
CREATE INDEX usage_monthly_account ON usage_monthly (account_id, month);

-- ai_usage rolled up by UTC month, per account, feature and model.
CREATE TABLE ai_usage_monthly (
  month TEXT NOT NULL,
  account_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, account_id, feature, model)
);

-- The registry's purged rows, found by when they were purged.
CREATE INDEX do_instances_purged ON do_instances (purged_at) WHERE purged_at IS NOT NULL;
