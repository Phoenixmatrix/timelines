import assert from "node:assert/strict";
import { test } from "node:test";
import { collectGatewayLogs, reconcileUsage, type UsageRow } from "./usage-reconciliation.ts";

const row = (feature: string, model: string, calls: number, input = 0, output = 0): UsageRow => ({
  account_id: "acc_o",
  slug: "orbit",
  feature,
  model,
  calls,
  failed: 0,
  input,
  output,
});
const log = (feature: string, model: string, extra: Record<string, unknown> = {}) => ({
  success: true,
  cached: false,
  model,
  account: "acc_o",
  feature,
  tokensIn: 0,
  tokensOut: 0,
  ...extra,
});

await test("app usage matching the gateway per feature and model reconciles", () => {
  const usage = [
    { ...row("knowledge", "@cf/cloudflare/clef", 2, 80), failed: 1 },
    row("wiki", "glm", 1, 10, 5),
  ];
  const logs = [
    log("knowledge", "@cf/cloudflare/clef"),
    log("knowledge", "@cf/cloudflare/clef"),
    // A rate-limited attempt: logged as failed, never a successful call.
    log("knowledge", "@cf/cloudflare/clef", { success: false }),
    log("wiki", "glm", { tokensIn: 10, tokensOut: 5 }),
    // Another account's call is not this account's.
    log("knowledge", "@cf/cloudflare/clef", { account: "acc_x" }),
  ];
  const result = reconcileUsage(usage, logs, "acc_o");
  assert.deepEqual(result.mismatched, []);
  assert.equal(result.rows.find((r) => r.feature === "knowledge")?.gateway.failed, 1);
});

await test("calls the app didn't record, or recorded elsewhere, are mismatches", () => {
  // The step-context bug: the gateway saw the owner's knowledge calls, the
  // app recorded them under the site.
  const usage = [{ ...row("unattributed", "@cf/cloudflare/clef", 2), account_id: "" }];
  const logs = [log("knowledge", "@cf/cloudflare/clef"), log("knowledge", "@cf/cloudflare/clef")];
  const result = reconcileUsage(usage, logs, "acc_o");
  assert.equal(result.mismatched.length, 1);
  assert.deepEqual(result.mismatched[0]!.app.calls, 0);

  // Token disagreement where the gateway reports tokens.
  const tokens = reconcileUsage(
    [row("wiki", "glm", 1, 9, 5)],
    [log("wiki", "glm", { tokensIn: 10, tokensOut: 5 })],
    "acc_o",
  );
  assert.equal(tokens.mismatched.length, 1);
});

await test("a call cut off by the app but billed upstream is an attempt on both sides", () => {
  // The app aborted one write at its deadline (failed) and retried it; the
  // gateway saw both complete.
  const usage = [{ ...row("wiki", "glm", 1, 516, 694), failed: 1 }];
  const logs = [
    log("wiki", "glm", { tokensIn: 516, tokensOut: 5251 }),
    log("wiki", "glm", { tokensIn: 516, tokensOut: 694 }),
  ];
  assert.deepEqual(reconcileUsage(usage, logs, "acc_o").mismatched, []);
  // An attempt the gateway never saw is not.
  const missing = reconcileUsage(
    [{ ...row("wiki", "glm", 1, 516, 694), failed: 2 }],
    logs.slice(1),
    "acc_o",
  );
  assert.equal(missing.mismatched.length, 1);
});

await test("reconciliation reads past sparse and empty filtered pages without counting overlaps twice", async () => {
  const first = { id: "first", ...log("knowledge", "glm", { tokensIn: 10, tokensOut: 5 }) };
  const last = { id: "last", ...log("knowledge", "gemma", { tokensIn: 20, tokensOut: 8 }) };
  const requested: number[] = [];
  const logs = await collectGatewayLogs(async (page) => {
    requested.push(page);
    switch (page) {
      case 1:
        return { logs: [first], rawCount: 50 };
      case 2:
        return { logs: [], rawCount: 50 };
      case 3:
        return { logs: [first, last], rawCount: 2 };
      default:
        throw new Error("Read beyond the final provider page");
    }
  });
  assert.deepEqual(requested, [1, 2, 3]);
  const result = reconcileUsage(
    [row("knowledge", "glm", 1, 10, 5), row("knowledge", "gemma", 1, 20, 8)],
    logs,
    "acc_o",
  );
  assert.deepEqual(result.mismatched, []);
});

await test("an unbounded Gateway listing fails rather than accepting truncated usage", async () => {
  let pages = 0;
  await assert.rejects(
    collectGatewayLogs(async () => {
      pages++;
      return { logs: [], rawCount: 50 };
    }),
    /More Gateway logs than reconciliation reads/,
  );
  assert.equal(pages, 40);
});
