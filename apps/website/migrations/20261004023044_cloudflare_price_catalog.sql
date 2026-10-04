-- The Cloudflare price catalog (CORE-208): Cloudflare's published list prices
-- per product and metric, versioned. A version is never edited: a refresh or a
-- site administrator's edit adds a new one, and a new version for the same
-- metric and effective date supersedes the old (kept, with superseded_at).
-- The price in effect on a day is the unsuperseded version with the latest
-- effective_from on or before it.

-- Every change to the catalog, and every refresh or scheduled check, whether
-- applied or not: the audit trail. `diff` and `pages` are JSON
-- (shared/usage.ts PriceDiffEntry[], PricePageResult[]).
CREATE TABLE cloudflare_price_changes (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('seed', 'refresh', 'check', 'manual')),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'applied', 'discarded', 'rejected', 'unchanged', 'superseded')
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  -- The catalog version (last applied change) a refresh's diff was computed against.
  base_version INTEGER,
  pages TEXT NOT NULL DEFAULT '[]',
  diff TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  decided_at TEXT,
  decided_by TEXT REFERENCES accounts (id) ON DELETE SET NULL
);
CREATE INDEX cloudflare_price_changes_status ON cloudflare_price_changes (status, id);

CREATE TABLE cloudflare_prices (
  id INTEGER PRIMARY KEY,
  change_id INTEGER NOT NULL REFERENCES cloudflare_price_changes (id),
  product TEXT NOT NULL,
  metric TEXT NOT NULL,
  unit TEXT NOT NULL,
  -- The price is unit_price_usd per unit_quantity units (e.g. $1.00 per 1,000,000 rows).
  unit_quantity REAL NOT NULL CHECK (unit_quantity > 0),
  unit_price_usd REAL NOT NULL CHECK (unit_price_usd >= 0),
  -- The account-wide allowance before billing; null when the metric has none of its own.
  included_quantity REAL CHECK (included_quantity >= 0),
  included_period TEXT CHECK (included_period IN ('month', 'day')),
  effective_from TEXT NOT NULL,
  source_url TEXT NOT NULL,
  -- When the source page says it last changed, and when it was fetched (null for edits).
  source_updated TEXT,
  fetched_at TEXT,
  provenance TEXT NOT NULL CHECK (provenance IN ('seed', 'refresh', 'manual')),
  recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  recorded_by TEXT REFERENCES accounts (id) ON DELETE SET NULL,
  note TEXT,
  superseded_at TEXT,
  superseded_by INTEGER REFERENCES cloudflare_prices (id)
);
CREATE UNIQUE INDEX cloudflare_prices_active
  ON cloudflare_prices (product, metric, effective_from) WHERE superseded_at IS NULL;

-- The seed: the pricing pages as read on 2026-10-04 (worker/usage/seed.ts, the
-- same rows; catalog.test.ts checks they match).
INSERT INTO cloudflare_price_changes (id, kind, status, created_at, note, decided_at) VALUES
  (1, 'seed', 'applied', '2026-10-04T02:24:00.000Z',
   'Cloudflare''s published Workers Paid prices as of 2026-10-04', '2026-10-04T02:24:00.000Z');

INSERT INTO cloudflare_prices (change_id, product, metric, unit, unit_quantity, unit_price_usd,
  included_quantity, included_period, effective_from, source_url, source_updated, provenance,
  fetched_at, recorded_at) VALUES
  (1, 'd1', 'rows_read', 'row', 1000000, 0.001, 25000000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/d1/platform/pricing/', '2026-04-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'd1', 'rows_written', 'row', 1000000, 1, 50000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/d1/platform/pricing/', '2026-04-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'd1', 'storage', 'GB-month', 1, 0.75, 5, 'month', '2026-10-04', 'https://developers.cloudflare.com/d1/platform/pricing/', '2026-04-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'durable_objects', 'requests', 'request', 1000000, 0.15, 1000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/durable-objects/platform/pricing/', '2026-09-30', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'durable_objects', 'duration', 'GB-second', 1000000, 12.5, 400000, 'month', '2026-10-04', 'https://developers.cloudflare.com/durable-objects/platform/pricing/', '2026-09-30', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'durable_objects', 'sqlite_rows_read', 'row', 1000000, 0.001, 25000000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/durable-objects/platform/pricing/', '2026-09-30', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'durable_objects', 'sqlite_rows_written', 'row', 1000000, 1, 50000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/durable-objects/platform/pricing/', '2026-09-30', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'durable_objects', 'sqlite_storage', 'GB-month', 1, 0.2, 5, 'month', '2026-10-04', 'https://developers.cloudflare.com/durable-objects/platform/pricing/', '2026-09-30', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'r2', 'standard_storage', 'GB-month', 1, 0.015, 10, 'month', '2026-10-04', 'https://developers.cloudflare.com/r2/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'r2', 'standard_class_a', 'request', 1000000, 4.5, 1000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/r2/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'r2', 'standard_class_b', 'request', 1000000, 0.36, 10000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/r2/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'r2', 'ia_storage', 'GB-month', 1, 0.01, 0, 'month', '2026-10-04', 'https://developers.cloudflare.com/r2/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'r2', 'ia_class_a', 'request', 1000000, 9, 0, 'month', '2026-10-04', 'https://developers.cloudflare.com/r2/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'r2', 'ia_class_b', 'request', 1000000, 0.9, 0, 'month', '2026-10-04', 'https://developers.cloudflare.com/r2/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'r2', 'ia_retrieval', 'GB', 1, 0.01, 0, 'month', '2026-10-04', 'https://developers.cloudflare.com/r2/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'artifacts', 'operations', 'operation', 1000, 0.15, 10000, 'month', '2026-10-14', 'https://developers.cloudflare.com/artifacts/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'artifacts', 'storage', 'GB-month', 1, 0.5, 1, 'month', '2026-10-14', 'https://developers.cloudflare.com/artifacts/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'vectorize', 'queried_dimensions', 'vector dimension', 1000000, 0.01, 50000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/vectorize/platform/pricing/', '2026-04-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'vectorize', 'stored_dimensions', 'vector dimension', 100000000, 0.05, 10000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/vectorize/platform/pricing/', '2026-04-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'ai_search', 'ingestion_tokens', 'token', 1000000, 0.75, 5000000, 'month', '2026-11-01', 'https://developers.cloudflare.com/ai-search/platform/limits-pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'ai_search', 'storage', 'GB-month', 1, 2, 10, 'month', '2026-11-01', 'https://developers.cloudflare.com/ai-search/platform/limits-pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'ai_search', 'semantic_queries', 'query', 1000, 0.75, 1000, 'month', '2026-11-01', 'https://developers.cloudflare.com/ai-search/platform/limits-pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'ai_search', 'fulltext_queries', 'query', 1000, 0.1, 1000, 'month', '2026-11-01', 'https://developers.cloudflare.com/ai-search/platform/limits-pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workflows', 'requests', 'request', 1000000, 0.3, 10000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/workflows/reference/pricing/', '2026-09-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workflows', 'cpu_time', 'CPU millisecond', 1000000, 0.02, 30000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/workflows/reference/pricing/', '2026-09-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workflows', 'storage', 'GB-month', 1, 0.2, 1, 'month', '2026-10-04', 'https://developers.cloudflare.com/workflows/reference/pricing/', '2026-09-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workflows', 'steps', 'step', 100000, 0.8, 500000, 'month', '2026-10-04', 'https://developers.cloudflare.com/workflows/reference/pricing/', '2026-09-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'queues', 'operations', 'operation', 1000000, 0.4, 1000000, 'month', '2026-10-04', 'https://developers.cloudflare.com/queues/platform/pricing/', '2026-04-21', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', 'neurons', 'neuron', 1000, 0.011, 10000, 'day', '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/zai-org/glm-5.3-flash:input', 'token', 1000000, 0.15, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/zai-org/glm-5.3-flash:cached_input', 'token', 1000000, 0.03, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/zai-org/glm-5.3-flash:output', 'token', 1000000, 0.5, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/zai-org/glm-5.3:input', 'token', 1000000, 1.4, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/zai-org/glm-5.3:cached_input', 'token', 1000000, 0.26, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/zai-org/glm-5.3:output', 'token', 1000000, 4.4, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/qwen/qwen3.8-27b:input', 'token', 1000000, 0.45, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/qwen/qwen3.8-27b:output', 'token', 1000000, 3.2, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/google/gemma-4-26b-a4b-it:input', 'token', 1000000, 0.1, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/google/gemma-4-26b-a4b-it:output', 'token', 1000000, 0.3, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/cloudflare/clef:input', 'token', 1000000, 0.24, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/cloudflare/clef-flash:input', 'token', 1000000, 0.09, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/qwen/qwen3-embedding-0.6b:input', 'token', 1000000, 0.012, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/ibm-granite/granite-4.0-h-micro:input', 'token', 1000000, 0.017, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/ibm-granite/granite-4.0-h-micro:output', 'token', 1000000, 0.112, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/black-forest-labs/flux-1-schnell:tile', 'tile', 1, 0.0000528, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z'),
  (1, 'workers_ai', '@cf/black-forest-labs/flux-1-schnell:step', 'step', 1, 0.0001056, NULL, NULL, '2026-10-04', 'https://developers.cloudflare.com/workers-ai/platform/pricing/', '2026-10-01', 'seed', '2026-10-04T02:24:00.000Z', '2026-10-04T02:24:00.000Z');
