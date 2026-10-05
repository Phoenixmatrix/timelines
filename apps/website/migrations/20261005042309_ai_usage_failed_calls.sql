-- Model calls that failed or were cut off (timeouts, rate limits, provider
-- errors, a stopped build): attempts the gateway logs but that returned no
-- usage (CORE-285). `calls` stays the successful calls.
ALTER TABLE ai_usage ADD COLUMN failed_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ai_usage_monthly ADD COLUMN failed_calls INTEGER NOT NULL DEFAULT 0;
