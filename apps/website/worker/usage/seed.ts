// The price catalog's seed (CORE-208): Cloudflare's published Workers Paid
// prices, read from the pricing pages on 2026-10-04 (UTC) by exactly the
// parsers a refresh uses (pages.ts); the saved pages are in fixtures/ and
// catalog.test.ts checks that parsing them still yields these. The migration
// that creates the catalog inserts the same rows (also checked), and Atlas
// budgets take their model prices from here (knowledge/budget.ts), so there is
// one source of truth.
//
// Containers (CI sandboxes) joined the catalog later the same day (CORE-210),
// as a second seed change.
//
// Artifacts are billed from 2026-10-14 and AI Search from 2026-11-01: those
// prices take effect then.

import type { PriceProduct, PriceUnit, PublishedPrice } from "../../shared/usage.ts";
import { pricingPage } from "./pages.ts";

/** The day (UTC) the seed was read. */
export const SEED_DATE = "2026-10-04";
/** When the pages were fetched. */
export const SEED_FETCHED_AT = "2026-10-04T02:24:00.000Z";

type Row = [
  metric: string,
  unit: PriceUnit,
  unitQuantity: number,
  unitPriceUsd: number,
  includedQuantity: number | null,
  includedPeriod: "month" | "day" | null,
  effectiveFrom: string,
];

const page = (product: PriceProduct, sourceUpdated: string, rows: Row[]): PublishedPrice[] =>
  rows.map(
    ([
      metric,
      unit,
      unitQuantity,
      unitPriceUsd,
      includedQuantity,
      includedPeriod,
      effectiveFrom,
    ]) => ({
      product,
      metric,
      unit,
      unitQuantity,
      unitPriceUsd,
      includedQuantity,
      includedPeriod,
      effectiveFrom,
      sourceUrl: pricingPage(product).url,
      sourceUpdated,
    }),
  );

export const SEED_PRICES: readonly PublishedPrice[] = [
  ...page("d1", "2026-04-21", [
    ["rows_read", "row", 1000000, 0.001, 25000000000, "month", "2026-10-04"],
    ["rows_written", "row", 1000000, 1, 50000000, "month", "2026-10-04"],
    ["storage", "GB-month", 1, 0.75, 5, "month", "2026-10-04"],
  ]),
  ...page("durable_objects", "2026-09-30", [
    ["requests", "request", 1000000, 0.15, 1000000, "month", "2026-10-04"],
    ["duration", "GB-second", 1000000, 12.5, 400000, "month", "2026-10-04"],
    ["sqlite_rows_read", "row", 1000000, 0.001, 25000000000, "month", "2026-10-04"],
    ["sqlite_rows_written", "row", 1000000, 1, 50000000, "month", "2026-10-04"],
    ["sqlite_storage", "GB-month", 1, 0.2, 5, "month", "2026-10-04"],
  ]),
  ...page("r2", "2026-10-01", [
    ["standard_storage", "GB-month", 1, 0.015, 10, "month", "2026-10-04"],
    ["standard_class_a", "request", 1000000, 4.5, 1000000, "month", "2026-10-04"],
    ["standard_class_b", "request", 1000000, 0.36, 10000000, "month", "2026-10-04"],
    ["ia_storage", "GB-month", 1, 0.01, 0, "month", "2026-10-04"],
    ["ia_class_a", "request", 1000000, 9, 0, "month", "2026-10-04"],
    ["ia_class_b", "request", 1000000, 0.9, 0, "month", "2026-10-04"],
    ["ia_retrieval", "GB", 1, 0.01, 0, "month", "2026-10-04"],
  ]),
  ...page("artifacts", "2026-10-01", [
    ["operations", "operation", 1000, 0.15, 10000, "month", "2026-10-14"],
    ["storage", "GB-month", 1, 0.5, 1, "month", "2026-10-14"],
  ]),
  ...page("vectorize", "2026-04-21", [
    ["queried_dimensions", "vector dimension", 1000000, 0.01, 50000000, "month", "2026-10-04"],
    ["stored_dimensions", "vector dimension", 100000000, 0.05, 10000000, "month", "2026-10-04"],
  ]),
  ...page("ai_search", "2026-10-01", [
    ["ingestion_tokens", "token", 1000000, 0.75, 5000000, "month", "2026-11-01"],
    ["storage", "GB-month", 1, 2, 10, "month", "2026-11-01"],
    ["semantic_queries", "query", 1000, 0.75, 1000, "month", "2026-11-01"],
    ["fulltext_queries", "query", 1000, 0.1, 1000, "month", "2026-11-01"],
  ]),
  ...page("workflows", "2026-09-21", [
    ["requests", "request", 1000000, 0.3, 10000000, "month", "2026-10-04"],
    ["cpu_time", "CPU millisecond", 1000000, 0.02, 30000000, "month", "2026-10-04"],
    ["storage", "GB-month", 1, 0.2, 1, "month", "2026-10-04"],
    ["steps", "step", 100000, 0.8, 500000, "month", "2026-10-04"],
  ]),
  ...page("queues", "2026-04-21", [
    ["operations", "operation", 1000000, 0.4, 1000000, "month", "2026-10-04"],
  ]),
  ...page("workers_ai", "2026-10-01", [
    ["neurons", "neuron", 1000, 0.011, 10000, "day", "2026-10-04"],
    ["@cf/zai-org/glm-5.3-flash:input", "token", 1000000, 0.15, null, null, "2026-10-04"],
    ["@cf/zai-org/glm-5.3-flash:cached_input", "token", 1000000, 0.03, null, null, "2026-10-04"],
    ["@cf/zai-org/glm-5.3-flash:output", "token", 1000000, 0.5, null, null, "2026-10-04"],
    ["@cf/zai-org/glm-5.3:input", "token", 1000000, 1.4, null, null, "2026-10-04"],
    ["@cf/zai-org/glm-5.3:cached_input", "token", 1000000, 0.26, null, null, "2026-10-04"],
    ["@cf/zai-org/glm-5.3:output", "token", 1000000, 4.4, null, null, "2026-10-04"],
    ["@cf/qwen/qwen3.8-27b:input", "token", 1000000, 0.45, null, null, "2026-10-04"],
    ["@cf/qwen/qwen3.8-27b:output", "token", 1000000, 3.2, null, null, "2026-10-04"],
    ["@cf/google/gemma-4-26b-a4b-it:input", "token", 1000000, 0.1, null, null, "2026-10-04"],
    ["@cf/google/gemma-4-26b-a4b-it:output", "token", 1000000, 0.3, null, null, "2026-10-04"],
    ["@cf/cloudflare/clef:input", "token", 1000000, 0.24, null, null, "2026-10-04"],
    ["@cf/cloudflare/clef-flash:input", "token", 1000000, 0.09, null, null, "2026-10-04"],
    ["@cf/qwen/qwen3-embedding-0.6b:input", "token", 1000000, 0.012, null, null, "2026-10-04"],
    [
      "@cf/ibm-granite/granite-4.0-h-micro:input",
      "token",
      1000000,
      0.017,
      null,
      null,
      "2026-10-04",
    ],
    [
      "@cf/ibm-granite/granite-4.0-h-micro:output",
      "token",
      1000000,
      0.112,
      null,
      null,
      "2026-10-04",
    ],
    ["@cf/black-forest-labs/flux-1-schnell:tile", "tile", 1, 0.0000528, null, null, "2026-10-04"],
    ["@cf/black-forest-labs/flux-1-schnell:step", "step", 1, 0.0001056, null, null, "2026-10-04"],
  ]),
  // Added by CORE-210 (migration 20261004071417_containers_prices), read the same day.
  ...page("containers", "2026-08-28", [
    ["vcpu", "vCPU-second", 1, 0.00002, 22500, "month", "2026-10-04"],
    ["memory", "GiB-second", 1, 0.0000025, 90000, "month", "2026-10-04"],
    ["disk", "GB-second", 1, 0.00000007, 720000, "month", "2026-10-04"],
  ]),
];

/** A seeded price; throws for one the seed doesn't have (a programming error). */
export function seedPrice(product: PriceProduct, metric: string): PublishedPrice {
  const price = SEED_PRICES.find((p) => p.product === product && p.metric === metric);
  if (!price) throw new Error(`No seeded price for ${product} ${metric}`);
  return price;
}
