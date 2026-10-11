-- CORE-329: Workers AI classifier prices read on 2026-10-11 (UTC) from
-- https://developers.cloudflare.com/workers-ai/platform/pricing/index.md
-- (last updated 2026-10-09), saved as fixtures/workers_ai_2026-10-11.txt.
-- Flash costs $0.038/M input tokens; Omni costs $0.150/M. Output is free.
-- Effective from observation, not the page's update date: this is not evidence
-- of when Cloudflare changed its rates. Keep the 2026-10-04 Flash version and
-- all unrelated products' original provenance intact.
INSERT INTO cloudflare_price_changes (kind, status, created_at, note, decided_at) VALUES
  ('seed', 'applied', '2026-10-11T05:22:18.000Z',
   'CORE-329: Cloudflare Clef Flash and Omni input prices observed 2026-10-11; output free',
   '2026-10-11T05:22:18.000Z');

INSERT INTO cloudflare_prices (change_id, product, metric, unit, unit_quantity, unit_price_usd,
  included_quantity, included_period, effective_from, source_url, source_updated, provenance,
  fetched_at, recorded_at)
SELECT c.id, 'workers_ai', p.metric, 'token', 1000000, p.unit_price_usd,
       NULL, NULL, '2026-10-11', 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
       '2026-10-09', 'seed', '2026-10-11T05:22:18.000Z', '2026-10-11T05:22:18.000Z'
  FROM (SELECT MAX(id) AS id FROM cloudflare_price_changes WHERE kind = 'seed') AS c,
       (SELECT '@cf/cloudflare/clef-flash:input' AS metric, 0.038 AS unit_price_usd, 1 AS ord
        UNION ALL SELECT '@cf/cloudflare/clef-omni:input', 0.15, 2) AS p
 ORDER BY p.ord;
