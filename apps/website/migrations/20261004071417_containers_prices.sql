-- Cloudflare Containers prices for CI sandboxes (CORE-210): vCPU, memory and
-- disk time on Workers Paid, read from
-- https://developers.cloudflare.com/containers/platform/pricing/index.md
-- (last updated 2026-08-28) on 2026-10-04, by the same parser a refresh uses
-- (worker/usage/pages.ts; the same rows as worker/usage/seed.ts, which
-- catalog.test.ts checks). One applied seed change, so the catalog's audit
-- trail says where they came from. The allowances are per month, in seconds
-- (375 vCPU-minutes, 25 GiB-hours, 200 GB-hours).
INSERT INTO cloudflare_price_changes (kind, status, created_at, note, decided_at) VALUES
  ('seed', 'applied', '2026-10-04T07:14:17.000Z',
   'Cloudflare''s published Containers prices (CI sandboxes) as of 2026-10-04', '2026-10-04T07:14:17.000Z');

INSERT INTO cloudflare_prices (change_id, product, metric, unit, unit_quantity, unit_price_usd,
  included_quantity, included_period, effective_from, source_url, source_updated, provenance,
  fetched_at, recorded_at)
SELECT c.id, p.product, p.metric, p.unit, p.unit_quantity, p.unit_price_usd, p.included_quantity,
       p.included_period, p.effective_from, p.source_url, p.source_updated, 'seed',
       '2026-10-04T07:14:17.000Z', '2026-10-04T07:14:17.000Z'
  FROM (SELECT MAX(id) AS id FROM cloudflare_price_changes WHERE kind = 'seed') AS c,
       (SELECT 'containers' AS product, 'vcpu' AS metric, 'vCPU-second' AS unit, 1 AS unit_quantity,
               0.00002 AS unit_price_usd, 22500 AS included_quantity, 'month' AS included_period,
               '2026-10-04' AS effective_from,
               'https://developers.cloudflare.com/containers/platform/pricing/' AS source_url,
               '2026-08-28' AS source_updated, 1 AS ord
        UNION ALL SELECT 'containers', 'memory', 'GiB-second', 1, 0.0000025, 90000, 'month',
               '2026-10-04', 'https://developers.cloudflare.com/containers/platform/pricing/',
               '2026-08-28', 2
        UNION ALL SELECT 'containers', 'disk', 'GB-second', 1, 0.00000007, 720000, 'month',
               '2026-10-04', 'https://developers.cloudflare.com/containers/platform/pricing/',
               '2026-08-28', 3) AS p
 ORDER BY p.ord;
