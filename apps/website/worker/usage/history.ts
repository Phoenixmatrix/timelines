// Usage history across retention's roll-ups (CORE-225): daily rows
// (usage_snapshots, ai_usage) and the monthly rows retention rolls older
// days into (usage_monthly, ai_usage_monthly). A rolled-up month keeps the
// sums of its days, so totals over any whole months are the same before and
// after a roll-up. The report (report.ts) reads only its last 30 days, which
// retention never rolls up ("usage-history" keeps at least 32 days).
//
// Ranges are whole UTC months, YYYY-MM, inclusive.
import type { UsageScope } from "../../shared/usage.ts";

export interface UsageTotal {
  construct: string;
  item: string;
  metric: string;
  kind: "storage" | "activity";
  /** Activity: the total. Storage: quantity-days (÷ days for the average). */
  quantity: number;
  days: number;
}

/** One explicit scope's usage summed over whole months. */
export async function usageTotals(
  d1: D1Database,
  scope: UsageScope,
  from: string,
  to: string,
): Promise<UsageTotal[]> {
  const { results } = await d1
    .prepare(
      `SELECT construct, item, metric, kind, sum(quantity) AS quantity, sum(days) AS days FROM (
         SELECT construct, item, metric, kind, quantity, 1 AS days FROM usage_snapshots
         WHERE scope_kind = ?1 AND scope_id = ?2 AND substr(day, 1, 7) BETWEEN ?3 AND ?4
         UNION ALL
         SELECT construct, item, metric, kind, quantity, days FROM usage_monthly
         WHERE scope_kind = ?1 AND scope_id = ?2 AND month BETWEEN ?3 AND ?4)
       GROUP BY construct, item, metric, kind ORDER BY construct, item, metric`,
    )
    .bind(scope.kind, scope.id, from, to)
    .all<UsageTotal>();
  return results;
}

export interface AiUsageTotal {
  feature: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** One explicit scope's AI calls and tokens summed over whole months. */
export async function aiUsageTotals(
  d1: D1Database,
  scope: UsageScope,
  from: string,
  to: string,
): Promise<AiUsageTotal[]> {
  const { results } = await d1
    .prepare(
      `SELECT feature, model, sum(calls) AS calls, sum(input_tokens) AS input_tokens,
         sum(output_tokens) AS output_tokens, sum(total_tokens) AS total_tokens FROM (
         SELECT feature, model, calls, input_tokens, output_tokens, total_tokens FROM ai_usage
         WHERE scope_kind = ?1 AND scope_id = ?2 AND substr(day, 1, 7) BETWEEN ?3 AND ?4
         UNION ALL
         SELECT feature, model, calls, input_tokens, output_tokens, total_tokens FROM ai_usage_monthly
         WHERE scope_kind = ?1 AND scope_id = ?2 AND month BETWEEN ?3 AND ?4)
       GROUP BY feature, model ORDER BY feature, model`,
    )
    .bind(scope.kind, scope.id, from, to)
    .all<AiUsageTotal>();
  return results;
}
