-- Knowledge retention (CORE-201): the "knowledge-builds",
-- "ended-timeline-data", "analysis-caches" and "ai-spend" categories
-- (worker/retention/cleanups/).

-- When a build (or an overlay or page set) last used a cached analysis or
-- synthesis. Written at most once a day per entry (worker/knowledge/
-- analyze.ts, synthesize.ts); null means not used since this column was added
-- (USED_SINCE in worker/knowledge/cache-use.ts stands in for it).
ALTER TABLE kg_blob_analysis ADD COLUMN used_at TEXT;
ALTER TABLE kg_synthesis ADD COLUMN used_at TEXT;

-- An ended overlay whose changes, regrouping and page sets retention removed:
-- the row stays so the timeline view can say so.
ALTER TABLE kg_overlays ADD COLUMN removed_at TEXT;

-- Atlas spend per account and UTC day, rolled up from atlas_spend rows older
-- than the "ai-spend" policy. Budget checks add it to atlas_spend's own rows
-- for that day, so a rolled-up day answers exactly as before.
CREATE TABLE atlas_spend_daily (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  -- Calls that weren't released (what run caps count).
  calls INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  rolled_up_at TEXT NOT NULL,
  PRIMARY KEY (account_id, day)
);
