import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_AGE_MS,
  contentHashes,
  gateFingerprint,
  gatePaths,
  gateWorkspace,
  mirrorFingerprint,
  mirrorOutcome,
  parseHistory,
  recordAttempts,
  resumeDecision,
  scenarioFingerprints,
  scenarioOutcomes,
  type Attempt,
  type ReadyHistory,
} from "./ready-history.ts";
import { parseReadyOptions, type ReadyPlan } from "./ready-plan.ts";
import { selectsE2E } from "./ready-e2e.ts";

const root = "/work/tree";
const base = "a".repeat(40);
const now = Date.parse("2026-10-14T12:00:00Z");
const earlier = new Date(now - 60 * 60_000).toISOString();
const dependencies = {
  "apps/website": ["packages/formats", "packages/utils"],
  "apps/cli": [],
  "tools/agent": ["apps/website", "packages/formats", "packages/utils"],
};
const websiteTests: ReadyPlan["gates"][number] = {
  name: "website-tests",
  binary: "node",
  args: ["../../tools/agent/website-tests.ts", "--project", "unit"],
  cwd: "website",
};
const cliCheck: ReadyPlan["gates"][number] = {
  name: "cli-check",
  binary: "vp",
  args: ["run", "--no-cache", "cli#check"],
  cwd: "root",
};
const CLONE = "gm-clone-commit-push-and-denied-push";
const HISTORY = "repository-file-history-and-attribution";
const ACCOUNTS = "password-accounts-admin-create-sign-in-and-reset";

const gatePrint = (
  gate: ReadyPlan["gates"][number],
  hashes: Record<string, string>,
  options: { base?: string; deps?: ReadyPlan["dependencies"] } = {},
) =>
  gateFingerprint({
    base: options.base ?? base,
    gate,
    changed: Object.keys(hashes),
    hashes,
    dependencies: "deps" in options ? options.deps : dependencies,
  });
const scenarioPrint = (name: string, hashes: Record<string, string>, at = base) =>
  scenarioFingerprints({ base: at, scenarios: [name], changed: Object.keys(hashes), hashes })[
    name
  ]!;
const attempt = (
  kind: Attempt["kind"],
  name: string,
  fingerprint: string,
  outcome: Attempt["outcome"] = "passed",
  finishedAt = earlier,
): Attempt => ({
  kind,
  name,
  fingerprint,
  base,
  outcome,
  finishedAt,
  evidence: `/evidence/${name}`,
});
const history = (...attempts: Attempt[]): ReadyHistory => recordAttempts(null, root, attempts, now);
const decide = (
  recorded: ReadyHistory | null,
  gates: { name: string; fingerprint: string }[],
  scenarios: { name: string; fingerprint: string }[] = [],
  extra: { base?: string | null; problem?: string; mirror?: string } = {},
) =>
  resumeDecision({
    history: recorded,
    root,
    base: "base" in extra ? extra.base! : base,
    gates,
    scenarios,
    now,
    ...(extra.problem ? { problem: extra.problem } : {}),
    ...(extra.mirror !== undefined ? { mirror: extra.mirror } : {}),
  });

await test("gates map to the workspace whose code they check", () => {
  assert.equal(gateWorkspace("website-tests"), "apps/website");
  assert.equal(gateWorkspace("website-readme-tests"), "apps/website");
  assert.equal(gateWorkspace("website-browser-tests"), "apps/website");
  assert.equal(gateWorkspace("bindings"), "apps/website");
  assert.equal(gateWorkspace("types"), "tools/agent");
  assert.equal(gateWorkspace("remote-types"), "tools/remote");
  assert.equal(gateWorkspace("cli-check"), "apps/cli");
  assert.equal(gateWorkspace("formats-types"), "packages/formats");
  for (const whole of ["check", "tests", "build", "something-new"])
    assert.equal(gateWorkspace(whole), null, whole);
});

await test("a gate reads its workspace closure and every path outside a workspace", () => {
  const changed = [
    "apps/cli/src/main.rs",
    "apps/website/worker/app.ts",
    "packages/formats/src/index.ts",
    "pnpm-lock.yaml",
    "tools/preview/main.ts",
  ];
  assert.deepEqual(gatePaths("website-tests", changed, dependencies), [
    "apps/website/worker/app.ts",
    "packages/formats/src/index.ts",
    "pnpm-lock.yaml",
  ]);
  assert.deepEqual(gatePaths("cli-check", changed, dependencies), [
    "apps/cli/src/main.rs",
    "pnpm-lock.yaml",
  ]);
  assert.deepEqual(gatePaths("check", changed, dependencies), changed);
  // No task graph (a full-coverage fallback): every change counts.
  assert.deepEqual(gatePaths("cli-check", changed, undefined), changed);
});

await test("gate fingerprints: same inputs reused, closure and command changes rerun", () => {
  const hashes = { "apps/website/worker/app.ts": "1", "apps/cli/src/main.rs": "2" };
  const print = gatePrint(websiteTests, hashes);
  const recorded = history(attempt("gate", "website-tests", print));
  assert.deepEqual(decide(recorded, [{ name: "website-tests", fingerprint: print }]).gates, []);

  // A changed file in the gate's closure.
  const edited = gatePrint(websiteTests, { ...hashes, "apps/website/worker/app.ts": "3" });
  assert.notEqual(edited, print);
  const rerun = decide(recorded, [{ name: "website-tests", fingerprint: edited }]);
  assert.deepEqual(rerun.gates, ["website-tests"]);
  assert.match(rerun.rerun["website-tests"]!, /differs/);
  // A dependency's change, a root path, and a path leaving the change list all count.
  assert.notEqual(gatePrint(websiteTests, { ...hashes, "packages/utils/src/a.ts": "4" }), print);
  assert.notEqual(gatePrint(websiteTests, { ...hashes, "tsconfig.json": "4" }), print);
  assert.notEqual(gatePrint(websiteTests, { "apps/cli/src/main.rs": "2" }), print);

  // An unrelated change keeps the reuse.
  assert.equal(gatePrint(websiteTests, { ...hashes, "apps/cli/src/main.rs": "9" }), print);
  assert.equal(gatePrint(websiteTests, { ...hashes, "apps/cli/src/new.rs": "deleted" }), print);

  // A different argv (Vitest's --changed selection, say).
  assert.notEqual(
    gatePrint({ ...websiteTests, args: [...websiteTests.args, "--changed=HEAD"] }, hashes),
    print,
  );
  assert.notEqual(gatePrint({ ...websiteTests, binary: "vp" }, hashes), print);
  // Without a task graph the unrelated change counts too.
  assert.notEqual(
    gatePrint(websiteTests, { ...hashes, "apps/cli/src/main.rs": "9" }, { deps: undefined }),
    gatePrint(websiteTests, hashes, { deps: undefined }),
  );
  assert.equal(
    gatePrint(cliCheck, { "apps/cli/src/main.rs": "2", "apps/website/worker/app.ts": "5" }),
    gatePrint(cliCheck, hashes),
  );
});

await test("a different merge base reruns", () => {
  const hashes = { "apps/website/worker/app.ts": "1" };
  const print = gatePrint(websiteTests, hashes);
  assert.notEqual(gatePrint(websiteTests, hashes, { base: "b".repeat(40) }), print);
  assert.notEqual(scenarioPrint(ACCOUNTS, hashes, "b".repeat(40)), scenarioPrint(ACCOUNTS, hashes));
  // Even with an identical fingerprint, the recorded base must match.
  const recorded = history(attempt("gate", "website-tests", print));
  const moved = decide(recorded, [{ name: "website-tests", fingerprint: print }], [], {
    base: "b".repeat(40),
  });
  assert.deepEqual(moved.gates, ["website-tests"]);
  assert.match(moved.rerun["website-tests"]!, /merge base moved/);
  const none = decide(recorded, [{ name: "website-tests", fingerprint: print }], [], {
    base: null,
  });
  assert.deepEqual(none.gates, ["website-tests"]);
});

await test("a failed attempt reruns, and so does the bindings gate", () => {
  const recorded = history(
    attempt("gate", "check", "p1", "failed"),
    attempt("gate", "bindings", "p2"),
    attempt("gate", "types", "p3"),
  );
  const decision = decide(recorded, [
    { name: "bindings", fingerprint: "p2" },
    { name: "check", fingerprint: "p1" },
    { name: "types", fingerprint: "p3" },
  ]);
  assert.deepEqual(decision.gates, ["bindings", "check"]);
  assert.match(decision.rerun.check!, /last attempt failed \(\/evidence\/check\)/);
  assert.deepEqual(
    decision.reused.map(({ kind, name, evidence }) => [kind, name, evidence]),
    [["gate", "types", "/evidence/types"]],
  );
});

await test("scenario fingerprints follow the paths that select them or a prerequisite", () => {
  const hashes = { "apps/website/src/routes/Accounts.tsx": "1" };
  const print = scenarioPrint(ACCOUNTS, hashes);
  assert.equal(scenarioPrint(ACCOUNTS, { ...hashes, "apps/site/src/index.ts": "2" }), print);
  assert.notEqual(scenarioPrint(ACCOUNTS, { "apps/website/src/routes/Accounts.tsx": "2" }), print);
  // apps/cli/Cargo.toml selects the gm area: the clone journey, which the history journey needs.
  const historyPrint = scenarioPrint(HISTORY, {});
  assert.notEqual(scenarioPrint(HISTORY, { "apps/cli/Cargo.toml": "1" }), historyPrint);
  assert.notEqual(scenarioPrint(CLONE, { "apps/cli/Cargo.toml": "1" }), scenarioPrint(CLONE, {}));
  // A route that selects only another browser journey.
  assert.equal(
    scenarioPrint(ACCOUNTS, { "apps/website/src/routes/DataRetention.tsx": "1" }),
    scenarioPrint(ACCOUNTS, {}),
  );
});

await test("AGENTS_FULL paths invalidate every scenario", () => {
  for (const path of ["pnpm-lock.yaml", "apps/website/worker/schema.ts", "tools/agent/e2e.ts"])
    for (const name of [ACCOUNTS, CLONE, HISTORY])
      assert.notEqual(scenarioPrint(name, { [path]: "1" }), scenarioPrint(name, {}), path);
});

await test("a rerun scenario brings its prerequisites, reused or not", () => {
  const recorded = history(
    attempt("scenario", CLONE, "c"),
    attempt("scenario", HISTORY, "h", "failed"),
    attempt("scenario", ACCOUNTS, "a"),
  );
  const decision = decide(
    recorded,
    [],
    [
      { name: CLONE, fingerprint: "c" },
      { name: HISTORY, fingerprint: "h" },
      { name: ACCOUNTS, fingerprint: "a" },
    ],
  );
  assert.deepEqual(decision.scenarios, [CLONE, HISTORY]);
  assert.match(decision.rerun[CLONE]!, new RegExp(`prerequisite of ${HISTORY}`));
  assert.deepEqual(
    decision.reused.map(({ name }) => name),
    [ACCOUNTS],
  );
  // Everything passed with the same inputs: nothing runs.
  const all = decide(
    history(attempt("scenario", CLONE, "c"), attempt("scenario", HISTORY, "h")),
    [],
    [
      { name: CLONE, fingerprint: "c" },
      { name: HISTORY, fingerprint: "h" },
    ],
  );
  assert.deepEqual(all.scenarios, []);
  assert.equal(all.reused.length, 2);
});

await test("old entries, other worktrees and unreadable histories reuse nothing", () => {
  const stale = new Date(now - MAX_AGE_MS - 1).toISOString();
  const gates = [{ name: "types", fingerprint: "p" }];
  const old = decide(
    { root, attempts: { "gate:types": attempt("gate", "types", "p", "passed", stale) } },
    gates,
  );
  assert.deepEqual(old.gates, ["types"]);
  assert.match(old.rerun.types!, /older than 24 hours/);
  // Recording drops expired attempts.
  assert.deepEqual(
    recordAttempts(
      { root, attempts: { "gate:types": attempt("gate", "types", "p", "passed", stale) } },
      root,
      [],
      now,
    ).attempts,
    {},
  );
  const recorded = history(attempt("gate", "types", "p"));
  assert.deepEqual(decide(recorded, gates).gates, []);
  assert.deepEqual(decide({ ...recorded, root: "/other" }, gates).gates, ["types"]);
  const parsed = parseHistory(JSON.stringify(recorded), "/other");
  assert.ok("problem" in parsed && /another worktree/.test(parsed.problem));
  for (const text of [
    "{",
    "[]",
    JSON.stringify({ root, attempts: { "gate:x": { kind: "gate" } } }),
  ])
    assert.ok("problem" in parseHistory(text, root), text);
  assert.deepEqual(parseHistory(null, root), { history: { root, attempts: {} } });
  assert.deepEqual(parseHistory(JSON.stringify(recorded), root), { history: recorded });
  const unreadable = decide(null, gates, [], { problem: "the ready history is unreadable" });
  assert.deepEqual(unreadable.gates, ["types"]);
  assert.match(unreadable.rerun.types!, /unreadable/);
});

await test("recording replaces each last attempt and keeps unreached ones", () => {
  const first = history(attempt("gate", "check", "p"), attempt("scenario", CLONE, "c"));
  const next = recordAttempts(first, root, [attempt("gate", "check", "q", "failed")], now);
  assert.equal(next.attempts["gate:check"]!.outcome, "failed");
  assert.equal(next.attempts[`scenario:${CLONE}`]!.fingerprint, "c");
  // Another worktree's history is not merged.
  assert.deepEqual(
    Object.keys(recordAttempts({ ...first, root: "/other" }, root, [], now).attempts),
    [],
  );
});

await test("scenario outcomes come from e2e.json; unreached scenarios have none", () => {
  assert.deepEqual(
    scenarioOutcomes([
      { scenario: CLONE, status: "passed", elapsedMs: 1 },
      { scenario: HISTORY, status: "failed", elapsedMs: 2 },
      { scenario: 3, status: "passed" },
      null,
    ]),
    { [CLONE]: "passed", [HISTORY]: "failed" },
  );
  assert.deepEqual(scenarioOutcomes({}), {});
});

await test("content hashes mark deleted paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ready-history-"));
  try {
    await mkdir(join(directory, "a"));
    await writeFile(join(directory, "a/file.ts"), "one");
    const hashes = await contentHashes(directory, ["a/file.ts", "a/gone.ts", "a"]);
    assert.match(hashes["a/file.ts"]!, /^[a-f0-9]{64}$/);
    assert.equal(hashes["a/gone.ts"], "deleted");
    assert.equal(hashes.a, "directory");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("--resume is refused with --all", () => {
  assert.equal(parseReadyOptions(["--resume"]).resume, true);
  assert.equal(parseReadyOptions(["--resume", "--dry-run"]).dryRun, true);
  assert.throws(() => parseReadyOptions(["--all", "--resume"]), /--all .* cannot --resume/);
  assert.throws(() => parseReadyOptions(["--resume", "--resume"]), /Duplicate/);
});

const mirrorPrint = (hashes: Record<string, string>) =>
  mirrorFingerprint({ base, changed: Object.keys(hashes), hashes });

await test("the mirror is reused while the paths that select it are unchanged", () => {
  const hashes = {
    "apps/website/worker/git/smart-http.ts": "1",
    "apps/website/src/routes/Accounts.tsx": "1",
  };
  const print = mirrorPrint(hashes);
  // A path that selects only a browser journey leaves the mirror's inputs alone.
  assert.equal(mirrorPrint({ ...hashes, "apps/website/src/routes/Accounts.tsx": "2" }), print);
  const recorded = history(attempt("mirror", "mirror", print));
  const reused = decide(recorded, [], [], { mirror: print });
  assert.equal(reused.mirror, false);
  assert.deepEqual(
    reused.reused.map(({ kind, name }) => [kind, name]),
    [["mirror", "mirror"]],
  );
  // Not selected: no verdict either way.
  assert.equal(decide(recorded, []).mirror, false);
  assert.equal(decide(recorded, []).reused.length, 0);
});

await test("a transport or agents' full set change reruns the mirror", () => {
  const hashes = { "apps/website/worker/git/smart-http.ts": "1" };
  const print = mirrorPrint(hashes);
  const recorded = history(attempt("mirror", "mirror", print));
  for (const changed of [
    { "apps/website/worker/git/smart-http.ts": "2" },
    { ...hashes, "apps/website/worker/refs/update.ts": "1" },
    { ...hashes, "pnpm-lock.yaml": "1" },
  ]) {
    const next = mirrorPrint(changed);
    assert.notEqual(next, print, JSON.stringify(changed));
    const decision = decide(recorded, [], [], { mirror: next });
    assert.equal(decision.mirror, true);
    assert.match(decision.rerun.mirror!, /selects it differs/);
  }
  const failed = decide(history(attempt("mirror", "mirror", print, "failed")), [], [], {
    mirror: print,
  });
  assert.equal(failed.mirror, true);
});

await test("everything reused provisions nothing", () => {
  const recorded = history(
    attempt("gate", "check", "g"),
    attempt("scenario", CLONE, "c"),
    attempt("scenario", HISTORY, "h"),
    attempt("mirror", "mirror", "m"),
  );
  const decision = decide(
    recorded,
    [{ name: "check", fingerprint: "g" }],
    [
      { name: CLONE, fingerprint: "c" },
      { name: HISTORY, fingerprint: "h" },
    ],
    { mirror: "m" },
  );
  assert.deepEqual(decision.gates, []);
  assert.deepEqual(decision.rerun, {});
  assert.equal(decision.reused.length, 4);
  assert.equal(selectsE2E({ scenarios: decision.scenarios, mirror: decision.mirror }), false);
  // A rerun mirror alone still needs an environment.
  const mirrorOnly = decide(recorded, [], [{ name: CLONE, fingerprint: "c" }], { mirror: "x" });
  assert.equal(selectsE2E({ scenarios: mirrorOnly.scenarios, mirror: mirrorOnly.mirror }), true);
});

await test("the mirror's outcome comes from mirror-e2e.json", () => {
  assert.equal(mirrorOutcome({ outcome: "passed", stages: [] }), "passed");
  assert.equal(mirrorOutcome({ outcome: "failed", failedStage: "mirror" }), "failed");
  for (const report of [{}, { outcome: "running" }, null, []])
    assert.equal(mirrorOutcome(report), null, JSON.stringify(report));
  assert.ok(
    "history" in parseHistory(JSON.stringify(history(attempt("mirror", "mirror", "m"))), root),
  );
});
