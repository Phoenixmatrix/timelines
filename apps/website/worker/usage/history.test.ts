import { describe, expect, onTestFinished, test } from "vite-plus/test";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { aiUsageTotals, usageTotals } from "./history.ts";
import type { UsageScope } from "../../shared/usage.ts";

describe("scoped usage history", () => {
  test("daily and monthly rows retain person/Space identity even when IDs match", async () => {
    const fresh = await createFreshSpaceTestEnvironment();
    onTestFinished(fresh.close);
    const {
      sqlite,
      env: { DB: database },
    } = fresh;
    const scopes: UsageScope[] = [
      { kind: "space", id: "same-id" },
      { kind: "person", id: "same-id" },
      { kind: "instance", id: "" },
    ];
    for (const [index, scope] of scopes.entries()) {
      const n = index + 1;
      sqlite
        .prepare(`INSERT INTO usage_snapshots
        (day, scope_kind, scope_id, construct, item, metric, kind, quantity, estimated, method, collected_at)
        VALUES ('2026-02-01', ?, ?, 'workers_ai', 'model', 'calls', 'activity', ?, 0, 'measured', '2026-02-02')`)
        .run(scope.kind, scope.id, n);
      sqlite
        .prepare(`INSERT INTO usage_monthly
        (month, scope_kind, scope_id, construct, item, metric, kind, quantity, days, estimated, last_day, last_quantity, method)
        VALUES ('2026-01', ?, ?, 'workers_ai', 'model', 'calls', 'activity', ?, 31, 0, '2026-01-31', 0, 'measured')`)
        .run(scope.kind, scope.id, n * 10);
      sqlite
        .prepare(`INSERT INTO ai_usage
        (day, scope_kind, scope_id, feature, model, calls, input_tokens, output_tokens, total_tokens)
        VALUES ('2026-02-01', ?, ?, 'assistant', 'model', ?, ?, ?, ?)`)
        .run(scope.kind, scope.id, n, n * 2, n * 3, n * 5);
      sqlite
        .prepare(`INSERT INTO ai_usage_monthly
        (month, scope_kind, scope_id, feature, model, calls, input_tokens, output_tokens, total_tokens)
        VALUES ('2026-01', ?, ?, 'assistant', 'model', ?, ?, ?, ?)`)
        .run(scope.kind, scope.id, n * 10, n * 20, n * 30, n * 50);
    }
    for (const [index, scope] of scopes.entries()) {
      const n = index + 1;
      expect(await usageTotals(database, scope, "2026-01", "2026-02")).toEqual([
        {
          construct: "workers_ai",
          item: "model",
          metric: "calls",
          kind: "activity",
          quantity: n * 11,
          days: 32,
        },
      ]);
      expect(await aiUsageTotals(database, scope, "2026-01", "2026-02")).toEqual([
        {
          feature: "assistant",
          model: "model",
          calls: n * 11,
          input_tokens: n * 22,
          output_tokens: n * 33,
          total_tokens: n * 55,
        },
      ]);
    }
    expect(
      await usageTotals(database, { kind: "space", id: "absent" }, "2026-01", "2026-02"),
    ).toEqual([]);
  });
});
