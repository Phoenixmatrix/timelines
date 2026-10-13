import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  acquireLockFile,
  buildTitle,
  checkoutProblem,
  decideOutcome,
  decideReport,
  decideStuck,
  decideStuckReport,
  e2eGraceMs,
  e2eTimeoutMs,
  failureNames,
  installTimeoutMs,
  parseRunLog,
  serviceUnit,
  shouldSkipRetest,
  stuckIssuesToClose,
  stuckTitle,
  unitTimeoutMinutes,
  type MainE2EResult,
  type TrackedIssue,
} from "./main-e2e.ts";

const result = (overrides: Partial<MainE2EResult> = {}): MainE2EResult => ({
  sha: "a".repeat(40),
  success: false,
  failedStages: ["scenarios"],
  failedScenarios: ["b-scenario", "a-scenario"],
  evidence: "/evidence",
  log: "/log",
  finishedAt: "2026-01-01T00:00:00Z",
  ...overrides,
});

await test("parses scenario failures and the completion event, ignoring other lines", () => {
  const log = [
    "plain output",
    JSON.stringify({ scenario: "one", status: "passed" }),
    JSON.stringify({ scenario: "two", status: "failed" }),
    JSON.stringify({ scenario: "two", status: "failed" }),
    "{not json",
    JSON.stringify({
      event: "e2e.complete",
      success: false,
      failedStages: ["scenarios"],
      evidence: "/e",
    }),
  ].join("\n");
  const parsed = parseRunLog(log);
  assert.deepEqual(parsed.failedScenarios, ["two"]);
  assert.deepEqual(parsed.complete, {
    success: false,
    failedStages: ["scenarios"],
    evidence: "/e",
  });
  assert.equal(parsed.limitRefused, false);
});

await test("detects the installation environment limit", () => {
  const log = `Error: Installation environment limit reached (4/4). Destroy unused\n${JSON.stringify({ event: "e2e.complete", success: false, failedStages: ["provision"], evidence: "/e" })}`;
  assert.equal(parseRunLog(log).limitRefused, true);
  assert.equal(parseRunLog("").complete, null);
});

await test("titles name the sorted failing set, falling back to stages", () => {
  assert.deepEqual(failureNames(result()), ["a-scenario", "b-scenario"]);
  assert.equal(buildTitle(result()), "Main E2E failing: a-scenario, b-scenario");
  assert.equal(
    buildTitle(result({ failedScenarios: [], failedStages: ["start"] })),
    "Main E2E failing: stage start",
  );
  assert.equal(
    buildTitle(result({ failedScenarios: [], failedStages: [] })),
    "Main E2E failing: run did not complete",
  );
  const many = Array.from({ length: 12 }, (_, i) => `scenario-number-${i}`);
  assert.match(
    buildTitle(result({ failedScenarios: many })),
    /12 failures starting scenario-number-0/,
  );
});

const issue = (key: string, title: string, status = "todo"): TrackedIssue => ({
  key,
  title,
  status,
});

await test("creates an issue unless an open one names the same failing set", () => {
  const title = buildTitle(result());
  assert.deepEqual(decideReport(result(), false, []), { kind: "create", title });
  const same = decideReport(result(), true, [issue("CORE-1", title)]);
  assert.equal(same.kind, "comment");
  assert.equal(same.kind === "comment" && same.issue, "CORE-1");
  assert.equal(decideReport(result(), true, [issue("CORE-1", title, "done")]).kind, "create");
  assert.equal(
    decideReport(result(), true, [issue("CORE-2", "Main E2E failing: other")]).kind,
    "create",
  );
});

await test("comments on every open issue when main passes again, never when it never failed", () => {
  const passing = result({ success: true, failedScenarios: [], failedStages: [] });
  const issues = [
    issue("CORE-1", "x"),
    issue("CORE-2", "y", "in_progress"),
    issue("CORE-3", "z", "done"),
  ];
  assert.deepEqual(decideReport(passing, true, issues), {
    kind: "recovered",
    issues: ["CORE-1", "CORE-2"],
    body: `Passing again at ${passing.sha}.`,
  });
  assert.deepEqual(decideReport(passing, false, issues), { kind: "none" });
  assert.deepEqual(decideReport(passing, true, []), { kind: "none" });
});

await test("coalesces unchanged heads but retries a pending report", () => {
  assert.equal(shouldSkipRetest("a", { lastTested: "a" }), true);
  assert.equal(shouldSkipRetest("b", { lastTested: "a" }), false);
  assert.equal(shouldSkipRetest("a", {}), false);
  assert.equal(
    shouldSkipRetest("a", {
      lastTested: "a",
      reportPending: { result: result(), previousFailed: false },
    }),
    false,
  );
});

await test("detects the machine environment limit as well (CORE-406)", () => {
  const machine =
    "Error: Machine environment limit reached (4). Destroy unused environments or use gm settings environments set --local --max N.";
  assert.equal(parseRunLog(machine).limitRefused, true);
  assert.equal(parseRunLog("Machine environment limit reached (x)").limitRefused, false);
});

const finished = (overrides: Partial<Parameters<typeof decideOutcome>[0]> = {}) =>
  decideOutcome({
    sha: "s",
    code: 1,
    timedOut: false,
    parsed: parseRunLog(""),
    log: "/log",
    finishedAt: "now",
    ...overrides,
  });

await test("either environment limit retries later without a result; a timeout is a failure of its own", () => {
  for (const message of [
    "Installation environment limit reached (4/4).",
    "Machine environment limit reached (4).",
  ]) {
    const parsed = parseRunLog(
      `${message}\n${JSON.stringify({ event: "e2e.complete", success: false, failedStages: ["provision"] })}`,
    );
    assert.deepEqual(finished({ parsed }), { kind: "retry-later" });
  }
  const timeout = finished({ code: null, timedOut: true });
  assert.equal(timeout.kind, "result");
  const result = timeout.kind === "result" ? timeout.result : null;
  assert.deepEqual(result?.failedStages, ["timeout"]);
  assert.equal(result?.success, false);
  assert.equal(buildTitle(result!), "Main E2E failing: timeout");
  assert.equal(decideReport(result!, false, []).kind, "create");
  // A clean exit with a success event passes; a nonzero exit without one fails.
  const ok = parseRunLog(
    JSON.stringify({ event: "e2e.complete", success: true, failedStages: [] }),
  );
  const passed = finished({ code: 0, parsed: ok });
  assert.equal(passed.kind === "result" && passed.result.success, true);
});

await test("budgets fit under the unit timeout, with room for the grace period", () => {
  assert(installTimeoutMs + e2eTimeoutMs + e2eGraceMs < unitTimeoutMinutes * 60_000);
  assert(e2eGraceMs >= 3 * 60_000);
});

await test("the service unit writes WorkingDirectory unquoted, absolute and escaped", () => {
  const unit = serviceUnit({
    checkout: "/home/u/.local/state/main-e2e/checkout",
    node: "/usr/bin/node",
    entry: "/home/u/.local/state/main-e2e/checkout/tools/agent/entry.ts",
    path: "/usr/bin:/bin",
  });
  assert.match(unit, /^WorkingDirectory=\/home\/u\/\.local\/state\/main-e2e\/checkout$/m);
  assert.match(unit, /^ExecStart="\/usr\/bin\/node" "/m);
  assert.match(unit, /^TimeoutStartSec=120min$/m);
  assert.match(
    serviceUnit({ checkout: "/a/100%/c", node: "/n", entry: "/e", path: "/p" }),
    /^WorkingDirectory=\/a\/100%%\/c$/m,
  );
  for (const bad of ["/a b/c", "/a\nb", "relative/path"])
    assert.throws(
      () => serviceUnit({ checkout: bad, node: "/n", entry: "/e", path: "/p" }),
      /absolute/,
    );
});

await test("a checkout is a problem if sync failed, it has local or untracked files, or differs", () => {
  assert.equal(checkoutProblem({ syncFailed: null, porcelain: "", diffCode: 0 }), null);
  assert.equal(
    checkoutProblem({ syncFailed: "boom", porcelain: "", diffCode: 0 })?.reason,
    "gm sync failed",
  );
  assert.equal(
    checkoutProblem({ syncFailed: null, porcelain: "?? stray.txt\n", diffCode: 0 })?.reason,
    "checkout has local changes",
  );
  assert.equal(
    checkoutProblem({ syncFailed: null, porcelain: "", diffCode: 1 })?.reason,
    "checkout does not match origin/main",
  );
});

await test("stuck is entered once, reported once by title, and cleared with a comment on recovery", () => {
  const problem = { reason: "gm sync failed", detail: "boom" };
  const entered = decideStuck(undefined, problem, "t0");
  assert.equal(entered.kind, "enter");
  const stuck = entered.kind === "enter" ? entered.stuck : null!;
  assert.deepEqual(stuck, { ...problem, since: "t0", reported: false });
  assert.deepEqual(decideStuck({ ...stuck, reported: true }, problem, "t1"), { kind: "none" });
  assert.deepEqual(decideStuck(stuck, problem, "t1"), { kind: "retry-report" });
  assert.equal(decideStuck(stuck, { reason: "other", detail: "" }, "t2").kind, "enter");
  assert.deepEqual(decideStuck(stuck, null, "t3"), { kind: "recover", since: "t0" });
  assert.deepEqual(decideStuck(undefined, null, "t3"), { kind: "none" });

  const title = stuckTitle(problem.reason);
  assert.equal(title, "Main E2E watcher stuck: gm sync failed");
  assert.deepEqual(decideStuckReport(problem.reason, []), { kind: "create", title });
  assert.deepEqual(decideStuckReport(problem.reason, [issue("C-1", title)]), { kind: "none" });
  assert.equal(decideStuckReport(problem.reason, [issue("C-1", title, "done")]).kind, "create");
  assert.deepEqual(
    stuckIssuesToClose([
      issue("C-1", title),
      issue("C-2", "Main E2E failing: x"),
      issue("C-3", title, "done"),
    ]),
    ["C-1"],
  );
});

await test("the lock is taken atomically with its pid, and a stale one is replaced once", () => {
  const dir = mkdtempSync(join(tmpdir(), "main-e2e-lock-"));
  try {
    const lock = join(dir, "tick.lock");
    const alive = new Set<number>();
    const isAlive = (pid: number) => alive.has(pid);
    assert.equal(acquireLockFile(lock, 100, isAlive), true);
    assert.equal(readFileSync(lock, "utf8"), "100");
    // Held by a live process: refused, and the holder's pid is untouched.
    alive.add(100);
    assert.equal(acquireLockFile(lock, 200, isAlive), false);
    assert.equal(readFileSync(lock, "utf8"), "100");
    // The holder died: the stale lock is replaced by the new pid.
    alive.delete(100);
    assert.equal(acquireLockFile(lock, 300, isAlive), true);
    assert.equal(readFileSync(lock, "utf8"), "300");
    // A second remover that finds the replacement live gives up and leaves it alone.
    alive.add(300);
    assert.equal(acquireLockFile(lock, 400, isAlive), false);
    assert.equal(readFileSync(lock, "utf8"), "300");
    // An unreadable pid counts as stale.
    rmSync(lock);
    writeFileSync(lock, "");
    assert.equal(acquireLockFile(lock, 500, isAlive), true);
    assert.equal(readFileSync(lock, "utf8"), "500");
    // No temporary or graveyard files are left behind.
    assert.deepEqual(readdirSync(dir), ["tick.lock"]);
    assert.equal(existsSync(`${lock}.stale.500`), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
