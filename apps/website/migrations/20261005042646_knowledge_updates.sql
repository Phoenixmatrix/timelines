-- Knowledge updates (CORE-286). Pushes to main mark Knowledge pending; one
-- update runs at the latest head once pushes have paused for the quiet period,
-- or at most the longest wait after the first pending push. Per account.
ALTER TABLE account_settings ADD COLUMN knowledge_quiet_minutes INTEGER NOT NULL DEFAULT 10
  CHECK (knowledge_quiet_minutes BETWEEN 0 AND 1440);
ALTER TABLE account_settings ADD COLUMN knowledge_max_wait_minutes INTEGER NOT NULL DEFAULT 30
  CHECK (knowledge_max_wait_minutes BETWEEN 0 AND 1440);

-- Each build's model calls by model, as they happen (retried steps included):
-- {"<model>": {"calls": n, "input": n, "output": n, "total": n}}.
ALTER TABLE kg_builds ADD COLUMN ai_usage TEXT;

-- The pipeline version the indexed Knowledge was built with. A different one
-- means the next build is a full rebuild; NULL (built before versions were
-- recorded) counts as the current version.
ALTER TABLE kg_state ADD COLUMN pipeline TEXT;
