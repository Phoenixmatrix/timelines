-- An account's own AI providers (CORE-294): one per kind, its API key sealed
-- with REGISTRY_KEK (registry/core/seal.ts). The key never leaves the server.
CREATE TABLE ai_providers (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('typesafe', 'openrouter')),
  key_sealed TEXT NOT NULL,
  key_last_four TEXT NOT NULL,
  updated_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (account_id, kind)
);

-- The provider's models the account made available, with what the provider
-- published about them when they were added (prices in USD per million tokens).
CREATE TABLE ai_provider_models (
  provider_id TEXT NOT NULL REFERENCES ai_providers (id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  name TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('classification', 'generation')),
  -- JSON: shared/ai.ts AiModelOption's prices, release date and URL.
  details TEXT NOT NULL,
  context_length INTEGER,
  json_mode INTEGER NOT NULL DEFAULT 1 CHECK (json_mode IN (0, 1)),
  added_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (provider_id, model)
);

-- Model choices may now name a provider model (`openrouter:<model>`), so the
-- curated CHECK constraints go: the API validates against the account's catalog.
ALTER TABLE account_settings ADD COLUMN ai_classification_model_v2 TEXT NOT NULL DEFAULT 'clef';
ALTER TABLE account_settings ADD COLUMN ai_fast_model_v2 TEXT NOT NULL DEFAULT 'glm-5.3-flash';
ALTER TABLE account_settings ADD COLUMN ai_task_model_v2 TEXT NOT NULL DEFAULT 'glm-5.3-flash';
UPDATE account_settings SET
  ai_classification_model_v2 = ai_classification_model,
  ai_fast_model_v2 = ai_fast_model,
  ai_task_model_v2 = ai_task_model;
ALTER TABLE account_settings DROP COLUMN ai_classification_model;
ALTER TABLE account_settings DROP COLUMN ai_fast_model;
ALTER TABLE account_settings DROP COLUMN ai_task_model;
ALTER TABLE account_settings RENAME COLUMN ai_classification_model_v2 TO ai_classification_model;
ALTER TABLE account_settings RENAME COLUMN ai_fast_model_v2 TO ai_fast_model;
ALTER TABLE account_settings RENAME COLUMN ai_task_model_v2 TO ai_task_model;
