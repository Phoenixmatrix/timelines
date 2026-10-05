// Reconciling the application's AI usage with the AI Gateway's logs
// (CORE-285): per account, feature and model, from ai_usage (via
// /api/dev/ai-usage) and from Gateway log metadata, which models.ts labels
// with the same account and feature.

export interface UsageRow {
  account_id: string;
  slug: string | null;
  feature: string;
  model: string;
  calls: number;
  failed: number;
  input: number;
  output: number;
}

/**
 * The application's ai_usage against the owned gateway's logs, per feature and
 * model, for one account (CORE-285). Every attempt is on both sides: the app's
 * calls plus failed attempts equal the gateway's logs. A call the app cut off
 * at its deadline may still have completed, and been billed, upstream: the
 * gateway may hold more successes than the app, never fewer, and tokens must
 * match exactly wherever the successes do (and the gateway reports tokens;
 * it reports none for clef).
 */
export function reconcileUsage(
  usage: UsageRow[],
  logs: {
    success: boolean;
    cached: boolean;
    model: string;
    account?: string;
    feature?: string;
    tokensIn: number;
    tokensOut: number;
  }[],
  account: string,
) {
  const keys = new Map<
    string,
    {
      feature: string;
      model: string;
      app: { calls: number; failed: number; input: number; output: number };
      gateway: { calls: number; failed: number; input: number; output: number };
    }
  >();
  const entry = (feature: string, model: string) => {
    const key = `${feature}\u0000${model}`;
    let found = keys.get(key);
    if (!found) {
      const zero = () => ({ calls: 0, failed: 0, input: 0, output: 0 });
      found = { feature, model, app: zero(), gateway: zero() };
      keys.set(key, found);
    }
    return found;
  };
  for (const row of usage) {
    if (row.account_id !== account) continue;
    const e = entry(row.feature, row.model);
    e.app.calls += row.calls;
    e.app.failed += row.failed;
    e.app.input += row.input;
    e.app.output += row.output;
  }
  for (const log of logs) {
    if (log.account !== account || log.cached) continue;
    const e = entry(log.feature ?? "?", log.model);
    if (log.success) {
      e.gateway.calls += 1;
      e.gateway.input += log.tokensIn ?? 0;
      e.gateway.output += log.tokensOut ?? 0;
    } else e.gateway.failed += 1;
  }
  const rows = [...keys.values()];
  const mismatched = rows.filter((r) => {
    const attempts = r.app.calls + r.app.failed === r.gateway.calls + r.gateway.failed;
    const successes =
      r.app.calls <= r.gateway.calls && r.gateway.calls - r.app.calls <= r.app.failed;
    const exact = r.app.calls === r.gateway.calls;
    const tokens =
      !exact ||
      ((r.gateway.input === 0 || r.app.input === r.gateway.input) &&
        (r.gateway.output === 0 || r.app.output === r.gateway.output));
    return !attempts || !successes || !tokens;
  });
  return { rows, mismatched };
}
