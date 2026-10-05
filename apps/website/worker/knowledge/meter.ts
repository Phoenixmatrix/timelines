// What one Knowledge build (an update or a full rebuild) spent on models
// (CORE-286). Every call a build's steps make is added to its kg_builds row as
// it happens (retried steps included, since they are real calls), by model;
// when the build ends its totals and list-price cost land in its stats, and
// the usage report adds them up per update.

import type { CatalogPrice } from "../../shared/usage.ts";
import { priceOn, priceTimeline, utcDay } from "../usage/prices.ts";

export interface ModelUsage {
  calls: number;
  /** Attempts that returned nothing: errors, timeouts, a stopped build (CORE-285). */
  failed?: number;
  input: number;
  output: number;
  total: number;
}

/** A build's model usage, priced at list prices (the usage report's catalog). */
export interface BuildAiUsage {
  calls: number;
  /** Attempts that failed (not in `calls`); their tokens, if any were reported, are priced. */
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** USD at the catalog's list prices on the build's day; free allowances not deducted. */
  costUsd: number;
  byModel: Record<string, ModelUsage & { costUsd: number | null }>;
  /** Models with calls but no catalog price (their cost is left out of `costUsd`). */
  unpriced: string[];
}

/** Add calls to a build's running usage. One statement, so concurrent calls add up. */
export async function meterBuildCall(
  d1: D1Database,
  buildId: string,
  model: string,
  usage: ModelUsage,
): Promise<void> {
  const path = `$."${model.replace(/"/g, "")}"`;
  await d1
    .prepare(
      `UPDATE kg_builds SET ai_usage = json_set(coalesce(ai_usage, '{}'), ?2, json_object(
         'calls', coalesce(json_extract(ai_usage, ?2 || '.calls'), 0) + ?3,
         'failed', coalesce(json_extract(ai_usage, ?2 || '.failed'), 0) + ?7,
         'input', coalesce(json_extract(ai_usage, ?2 || '.input'), 0) + ?4,
         'output', coalesce(json_extract(ai_usage, ?2 || '.output'), 0) + ?5,
         'total', coalesce(json_extract(ai_usage, ?2 || '.total'), 0) + ?6))
       WHERE id = ?1`,
    )
    .bind(buildId, path, usage.calls, usage.input, usage.output, usage.total, usage.failed ?? 0)
    .run();
}

/** Price stored usage (`kg_builds.ai_usage`) with the catalog in effect on `day`. */
export function priceUsage(
  stored: string | null,
  timeline: readonly CatalogPrice[],
  day: string,
): BuildAiUsage {
  const raw = stored ? (JSON.parse(stored) as Record<string, Partial<ModelUsage>>) : {};
  const out: BuildAiUsage = {
    calls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    byModel: {},
    unpriced: [],
  };
  for (const [model, usage] of Object.entries(raw).sort(([a], [b]) => a.localeCompare(b))) {
    const u: ModelUsage = {
      calls: usage.calls ?? 0,
      failed: usage.failed ?? 0,
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      total: usage.total ?? 0,
    };
    const price = (metric: string) => priceOn(timeline, "workers_ai", `${model}:${metric}`, day);
    const input = price("input");
    const output = price("output");
    // A provider that reports only a total is priced as input, as the usage report does.
    const inputTokens = u.input || (u.output ? 0 : u.total);
    const cost =
      input || output
        ? (input ? (inputTokens * input.unitPriceUsd) / input.unitQuantity : 0) +
          (output ? (u.output * output.unitPriceUsd) / output.unitQuantity : 0)
        : null;
    if (cost === null && u.calls + (u.failed ?? 0) > 0) out.unpriced.push(model);
    out.byModel[model] = { ...u, costUsd: cost === null ? null : round(cost) };
    out.calls += u.calls;
    out.failedCalls += u.failed ?? 0;
    out.inputTokens += inputTokens;
    out.outputTokens += u.output;
    out.costUsd += cost ?? 0;
  }
  out.costUsd = round(out.costUsd);
  return out;
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;

/** A build's usage so far, priced. */
export async function buildAiUsage(
  d1: D1Database,
  buildId: string,
  now = new Date(),
): Promise<BuildAiUsage> {
  const [row, timeline] = await Promise.all([
    d1.prepare("SELECT ai_usage FROM kg_builds WHERE id = ?1").bind(buildId).first<{
      ai_usage: string | null;
    }>(),
    priceTimeline(d1),
  ]);
  return priceUsage(row?.ai_usage ?? null, timeline, utcDay(now));
}
