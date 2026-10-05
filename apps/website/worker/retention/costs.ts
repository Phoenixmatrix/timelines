// What a cleanup run's bytes cost a month (CORE-210): the "estimated cost" of
// a dry run's preview and a run's history, from CORE-208's price catalog.
//
// Each category's records live in one store, priced at that store's storage
// list price in effect on the run's day (a GB is 10^9 bytes). Bytes are the
// cleanups' own estimates, so every cost is estimated. A store whose price
// isn't billed yet carries `startsOn`, as in the usage report.

import { GB, PRICE_PRODUCTS, metricLabel, priceCost } from "../../shared/usage.ts";
import type { CatalogPrice, PriceProduct, UsageCost } from "../../shared/usage.ts";
import { priceOn } from "../usage/prices.ts";
import type { CategoryId } from "./categories.ts";

const D1 = { product: "d1", metric: "storage" } as const;
const DURABLE = { product: "durable_objects", metric: "sqlite_storage" } as const;
const R2 = { product: "r2", metric: "standard_storage" } as const;

/** Where each category's records are stored, for pricing. */
// Owned work Git has no measured reclaimable-byte estimate; leave its cost unknown.
const CATEGORY_STORAGE: Partial<Record<CategoryId, { product: PriceProduct; metric: string }>> = {
  "ci-logs": D1,
  "step-steering": D1,
  "step-artifacts": D1,
  "step-feed": DURABLE,
  "ci-runs": D1,
  "preview-records": D1,
  "knowledge-builds": D1,
  "ended-timeline-data": D1,
  "push-log": D1,
  "release-notes": D1,
  "analysis-caches": D1,
  "registry-audit": D1,
  "auth-hygiene": D1,
  "ai-spend": D1,
  "usage-history": D1,
  "ai-usage": D1,
  "durable-registry": D1,
  // Tracker and assistant data live in their Durable Objects' SQLite storage.
  "closed-issues": DURABLE,
  "tracker-activity": DURABLE,
  "assistant-chats": DURABLE,
  // Mostly the cached blobs and derived files garbage collection then reclaims.
  "registry-proxy-cache": R2,
};

/** The monthly storage cost of `bytes` of a category's data, as of `day` (YYYY-MM-DD). */
export function categoryCost(
  timeline: readonly CatalogPrice[],
  categoryId: string,
  bytes: number,
  day: string,
): UsageCost | null {
  const where = CATEGORY_STORAGE[categoryId as CategoryId];
  if (!where) return null;
  const versions = timeline.filter((p) => p.product === where.product && p.metric === where.metric);
  const inEffect = priceOn(versions, where.product, where.metric, day);
  const price =
    inEffect ??
    versions
      .filter((p) => p.effectiveFrom > day)
      .toSorted((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))[0];
  if (!price) return null;
  const quantity = bytes / GB;
  return {
    product: where.product,
    metric: where.metric,
    label: `${PRICE_PRODUCTS[where.product]} ${metricLabel(where.product, where.metric).toLowerCase()}`,
    figure: "bytes",
    quantity,
    unit: price.unit,
    unitPriceUsd: price.unitPriceUsd,
    unitQuantity: price.unitQuantity,
    includedQuantity: price.includedQuantity,
    includedPeriod: price.includedPeriod,
    effectiveFrom: price.effectiveFrom,
    sourceUrl: price.sourceUrl,
    monthlyUsd: priceCost(price, quantity),
    startsOn: inEffect ? null : price.effectiveFrom,
    estimated: true,
  };
}
