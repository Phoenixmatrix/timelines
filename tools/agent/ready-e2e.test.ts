import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runE2E } from "./e2e.ts";
import { e2eScenarioNames, expandE2EScenarios, selectReadyE2E } from "./ready-e2e.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";

await test("frontend selection preserves browser journeys but omits unrelated E2E and mirror", () => {
  const selection = selectReadyE2E(["apps/website/src/routes/repo/Repo.tsx"], false);
  assert.equal(selection.mirror, false);
  assert(selection.scenarios);
  for (const required of [
    "ci-retention-removes-logs-and-runs",
    "browser-usage-and-costs-account-and-site",
    "browser-data-retention-account-and-site",
    "tracker-retention-removes-closed-issues-and-replicas-converge",
    "assistant-chats-expire",
    "auth-hygiene-keeps-sign-in-and-tokens-working",
    "browser-personas-persisted-product-state",
    "browser-atlas-smoke",
    "browser-timeline-scope-round-trip",
    "browser-expired-source-without-timeline-history",
    "browser-chronicle-scrub-range-span-and-links",
  ]) {
    assert(selection.scenarios.includes(required), `Browser journey omitted: ${required}`);
  }
  for (const unrelated of [
    "queue-concurrency-failure-fencing-and-push-recovery",
    "ci-cancellation-and-job-token-lifetime",
    "registry-retention-keeps-installs-working",
    "retention-concurrent-with-pushes-builds-and-chats",
    "source-retention-expiry-orphan-and-canonical-purge",
  ]) {
    assert(!selection.scenarios.includes(unrelated), unrelated);
  }
  assert.deepEqual(selectReadyE2E(["apps/website/public/favicon.svg"], false), selection);
});

await test("browser prerequisites expand transitively in execution order without duplicates", () => {
  assert.deepEqual(
    expandE2EScenarios([
      "browser-personas-persisted-product-state",
      "browser-personas-persisted-product-state",
    ]),
    [
      "gm-clone-commit-push-and-denied-push",
      "tracker-claim-sync-complete-and-blocked-transitions",
      "package-upload-download-and-write-boundary",
      "ci-push-triggered-local-dag-and-provenance",
      "browser-personas-persisted-product-state",
    ],
  );
  assert.deepEqual(expandE2EScenarios(["browser-usage-and-costs-account-and-site"]), [
    "gm-clone-commit-push-and-denied-push",
    "tracker-claim-sync-complete-and-blocked-transitions",
    "usage-metering-collects-per-account",
    "browser-usage-and-costs-account-and-site",
  ]);
});

await test("audited route selection keeps every traversing journey and its prerequisites", () => {
  const usage = "apps/website/src/routes/UsageCosts.tsx";
  const retention = "apps/website/src/routes/DataRetention.tsx";
  const both = expandE2EScenarios([
    "browser-usage-and-costs-account-and-site",
    "browser-data-retention-account-and-site",
  ]);
  assert.deepEqual(selectReadyE2E([usage], false), { scenarios: both, mirror: false });
  assert.deepEqual(selectReadyE2E([retention], false), {
    scenarios: expandE2EScenarios(["browser-data-retention-account-and-site"]),
    mirror: false,
  });
  assert.deepEqual(selectReadyE2E([retention, usage, usage], false), {
    scenarios: both,
    mirror: false,
  });
  // Selection consumes diff paths, never filesystem existence: a deleted mapped
  // endpoint still selects its witnesses; an unknown rename endpoint widens.
  assert.deepEqual(selectReadyE2E([usage], false).scenarios, both);
  const broad = selectReadyE2E(["apps/website/src/App.tsx"], false);
  for (const path of [
    "apps/website/src/routes/RenamedUsageCosts.tsx",
    "apps/website/src/appRoutes.tsx",
    "apps/website/src/components/SettingsPage.tsx",
    "apps/website/src/components/UsageReportView.tsx",
    "apps/website/src/components/RetentionView.tsx",
    "apps/website/src/lib/retention-links.ts",
    "apps/website/src/app.css",
    "apps/website/src/tokens.css",
    "apps/website/public/favicon.svg",
  ]) {
    assert.deepEqual(selectReadyE2E([usage, path], false), broad, path);
    assert.deepEqual(selectReadyE2E([path, retention], false), broad, path);
  }
  assert.deepEqual(selectReadyE2E([usage, "apps/website/worker/api/repos.ts"], false), {
    scenarios: null,
    mirror: true,
  });
});

await test("expired browser fixture is independently selectable while full inventory keeps backend matrix", () => {
  assert.deepEqual(expandE2EScenarios(["browser-expired-source-without-timeline-history"]), [
    "browser-expired-source-without-timeline-history",
  ]);
});

await test("unaudited scenario dependencies widen to the full suite", () => {
  assert.deepEqual(expandE2EScenarios(["source-late-sync-lineage-conflicts-guard-and-expiry"]), [
    ...e2eScenarioNames,
  ]);
});

await test("docs and unit/browser test changes do not widen frontend selection", () => {
  const frontend = "apps/website/src/routes/repo/Repo.tsx";
  assert.deepEqual(
    selectReadyE2E(
      [
        frontend,
        "README.md",
        "apps/website/README.md",
        "apps/cli/src/transport.test.ts",
        "tools/agent/environment.test.ts",
        "apps/website/src/routes/repo/Repo.browser.test.tsx",
      ],
      false,
    ),
    selectReadyE2E([frontend], false),
  );
  assert.deepEqual(selectReadyE2E(["README.md", "tools/agent/environment.test.ts"], false), {
    scenarios: [],
    mirror: false,
  });
});

await test("all, unknown paths, configuration and unaudited production domains retain full coverage", () => {
  const complete = { scenarios: null, mirror: true };
  assert.deepEqual(selectReadyE2E([], true), complete);
  assert.deepEqual(selectReadyE2E(["apps/website/src/App.tsx"], true), complete);
  for (const path of [
    "apps/website/server/main.ts",
    "apps/website/shared/api.ts",
    "apps/cli/src/main.ts",
    "apps/website/package.json",
    "apps/website/wrangler.jsonc",
    "tools/agent/e2e.ts",
    "tools/agent/source-auth-e2e.ts",
    "docs/config.json",
    "docs/architecture.md",
    "unknown/README.md",
    "apps/new-workspace/example.test.ts",
    "new-production-module.ts",
  ]) {
    assert.deepEqual(selectReadyE2E(["apps/website/src/App.tsx", path], false), complete, path);
  }
});

await test("invalid scenario names fail before any E2E filesystem or runtime side effects", async () => {
  assert.throws(() => expandE2EScenarios(["browser-atlas-smkoe"]), /Unknown E2E scenario/);
  // Unknown names must still fail when another selected domain would widen to all.
  assert.throws(
    () => expandE2EScenarios(["source-late-sync-lineage-conflicts-guard-and-expiry", "unknown"]),
    /Unknown E2E scenario: unknown/,
  );
  const directory = await mkdtemp(join(tmpdir(), "ready-e2e-invalid-"));
  try {
    const { ctx, fixtures } = emptyFixture(directory);
    await assert.rejects(runE2E(ctx, fixtures, ["unknown"]), /Unknown E2E scenario: unknown/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

await test("skipped scenario bodies and prerequisite-dependent setup never run; skips are separate events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ready-e2e-empty-"));
  const events: unknown[] = [];
  t.mock.method(console, "log", (line: string) => events.push(JSON.parse(line)));
  try {
    const { ctx, fixtures } = emptyFixture(directory);
    // Deliberately unavailable origin and executable: any unguarded client work fails.
    await runE2E(ctx, fixtures, []);
    assert.deepEqual(
      events,
      e2eScenarioNames.map((scenario) => ({
        event: "e2e-scenario-skipped",
        scenario,
      })),
    );
    assert.deepEqual(await readdir(ctx.artifacts), [], "No fake pass/skip report records");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function emptyFixture(directory: string): { ctx: HarnessContext; fixtures: SeedManifest } {
  const origin = "http://127.0.0.1:1";
  return {
    ctx: {
      root: directory,
      dir: directory,
      work: join(directory, "work"),
      origin,
      gm: join(directory, "missing-gm"),
      env: {},
      artifacts: join(directory, "artifacts"),
    },
    fixtures: {
      version: 1,
      origin,
      readToken: "",
      tokens: { priya: "", marco: "", jun: "", sam: "" },
      repos: [
        { owner: "orbit", name: "engine", visibility: "private" },
        { owner: "sam", name: "private", visibility: "private" },
        { owner: "orbit", name: "public", visibility: "public" },
      ],
      tracker: { owner: "orbit", team: "", ready: "", blocked: "", blocker: "" },
    },
  };
}
