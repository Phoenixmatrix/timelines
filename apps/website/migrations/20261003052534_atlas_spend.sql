-- Atlas paid-synthesis budgets (CORE-162, worker/knowledge/budget.ts). One row
-- per Atlas model call, reserved before the call at its maximum cost and
-- reconciled to the provider's reported usage after. Upstream Knowledge
-- inference (kg_synthesis, wiki, concepts) is never recorded here, so the two
-- are attributed separately.
CREATE TABLE atlas_spend (
  id TEXT PRIMARY KEY,
  -- The repository's owning account: the daily ceiling's key, whatever the
  -- scope or principal that asked.
  account_id TEXT NOT NULL,
  -- UTC day (YYYY-MM-DD) the call is charged to: the day it was reserved.
  day TEXT NOT NULL,
  -- `build`: a repository's Knowledge build (run_id = kg_builds.id);
  -- `grouping`: an account grouping pass (run_id chosen by the pass).
  scope TEXT NOT NULL CHECK (scope IN ('build', 'grouping')),
  run_id TEXT NOT NULL,
  repo_id TEXT,
  -- What the call was for, e.g. `capability_summary`.
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  -- reserved: in flight, charged at its maximum; settled: reconciled to actual
  -- usage; failed: the call failed, kept at its maximum (it may have been
  -- billed); released: never called, charged nothing.
  status TEXT NOT NULL CHECK (status IN ('reserved', 'settled', 'failed', 'released')),
  -- What counts against the caps now: the reservation until settled.
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  reserved_input_tokens INTEGER NOT NULL,
  reserved_output_tokens INTEGER NOT NULL,
  reserved_micro_usd INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  settled_at TEXT
);
CREATE INDEX atlas_spend_day ON atlas_spend (account_id, day);
CREATE INDEX atlas_spend_run ON atlas_spend (scope, run_id);

-- The first cap a reservation ran into, per day (account ceiling) or run.
-- Once recorded, that day or run takes no more paid work: no retries.
CREATE TABLE atlas_budget_exhaustions (
  -- `day:<account>:<day>`, `build:<account>:<run>` or `grouping:<account>:<run>`
  key TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('day', 'build', 'grouping')),
  run_id TEXT,
  day TEXT,
  cap TEXT NOT NULL CHECK (cap IN ('daily_usd', 'calls', 'input_tokens', 'output_tokens')),
  exhausted_at TEXT NOT NULL,
  -- Next UTC midnight for the daily ceiling; null for a run (a new run starts fresh).
  resets_at TEXT
);
