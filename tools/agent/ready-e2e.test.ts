import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runE2E } from "./e2e.ts";
import {
  agentScenarioNames,
  areaOnlyScenarios,
  areaScenarios,
  e2eAreas,
  e2eScenarioNames,
  expandE2EScenarios,
  mainOnlyScenarios,
  prerequisites,
  scenarioAreas,
  selectReadyE2E,
  selectsE2E,
  type ScenarioName,
} from "./ready-e2e.ts";
import type { HarnessContext, SeedManifest } from "./types.ts";

const agentsFull = { scenarios: [...agentScenarioNames], mirror: true };
const nothing = { scenarios: [], mirror: false };
const select = (...paths: string[]) => selectReadyE2E(paths, false);
const agentsSelection = (...names: ScenarioName[]) =>
  expandE2EScenarios(names).filter((name) => !mainOnlyScenarios.has(name));

await test("every scenario declares audited prerequisites that run before it, and areas", () => {
  assert.deepEqual(Object.keys(prerequisites).sort(), [...e2eScenarioNames].sort());
  assert.deepEqual(Object.keys(scenarioAreas).sort(), [...e2eScenarioNames].sort());
  for (const name of e2eScenarioNames) {
    for (const dependency of prerequisites[name])
      assert(
        e2eScenarioNames.indexOf(dependency) < e2eScenarioNames.indexOf(name),
        `${name}: prerequisite ${dependency} must run first`,
      );
    assert(scenarioAreas[name].length > 0, `${name} has no area`);
  }
  for (const area of e2eAreas)
    assert(
      areaScenarios(area).some((name) => !mainOnlyScenarios.has(name)),
      `${area} selects no agents' scenario`,
    );
});

await test("no area expands to the whole suite and no prerequisite is main-only", () => {
  for (const area of e2eAreas) {
    const expanded = expandE2EScenarios(areaScenarios(area));
    assert(expanded.length < agentScenarioNames.length, `${area} selects everything`);
  }
  for (const name of e2eScenarioNames) {
    const expanded = expandE2EScenarios([name]);
    assert(expanded.length < e2eScenarioNames.length / 2, `${name} expands too far`);
    if (!mainOnlyScenarios.has(name))
      for (const dependency of expanded)
        assert(!mainOnlyScenarios.has(dependency), `${name} needs main-only ${dependency}`);
  }
});

await test("main-only scenarios are never selected for agents but run with --all", () => {
  assert.deepEqual(
    [...mainOnlyScenarios],
    [
      "source-multi-repository-landing-and-durable-recovery",
      "source-finite-legacy-migration-and-partial-revert",
    ],
  );
  for (const paths of [
    ["apps/website/worker/schema.ts"],
    ["apps/website/worker/timelines/landing.ts"],
    ["apps/website/worker/api/dev-landing-fixtures.ts"],
    ["tools/agent/source-landing-e2e.ts", "tools/agent/source-migration-e2e.ts"],
    ["tools/agent/queue-e2e.ts"],
    ["apps/cli/src/main.rs"],
    ["new-production-module.ts"],
  ]) {
    const { scenarios } = selectReadyE2E(paths, false);
    assert(scenarios, paths.join());
    for (const name of mainOnlyScenarios)
      assert(!scenarios.includes(name), `${paths.join()}: ${name}`);
  }
  assert.deepEqual(select("apps/website/worker/schema.ts"), agentsFull);
  assert.equal(
    agentScenarioNames.length,
    e2eScenarioNames.length - mainOnlyScenarios.size - areaOnlyScenarios.size,
  );
  // --all (and no change list): null runs every scenario, main-only ones included.
  assert.deepEqual(selectReadyE2E(["apps/website/src/App.tsx"], true), {
    scenarios: null,
    mirror: true,
  });
  assert.deepEqual(selectReadyE2E([], true), { scenarios: null, mirror: true });
  // Explicit selections (runE2E) keep main-only scenarios: only agents' paths drop them.
  assert.deepEqual(expandE2EScenarios(["source-finite-legacy-migration-and-partial-revert"]), [
    "source-finite-legacy-migration-and-partial-revert",
  ]);
});

await test("representative paths select their areas' journeys", () => {
  const landing = select("apps/website/worker/timelines/landing.ts");
  assert.deepEqual(landing, {
    scenarios: agentsSelection(...areaScenarios("timelines-landing"), ...areaScenarios("sources")),
    mirror: false,
  });
  for (const name of [
    "timeline-compact-landing-gates-receipt-and-native-source",
    "timeline-nested-admission-and-canonical-revert",
    "source-late-sync-lineage-conflicts-guard-and-expiry",
    "browser-timeline-scope-round-trip",
  ] as const)
    assert(landing.scenarios!.includes(name), name);
  for (const name of [
    "queue-concurrency-failure-fencing-and-push-recovery",
    "browser-usage-and-costs-account-and-site",
    "package-upload-download-and-write-boundary",
  ] as const)
    assert(!landing.scenarios!.includes(name), name);

  const tracker = select("apps/website/worker/tracker/store.ts");
  assert.deepEqual(tracker, {
    scenarios: agentsSelection(...areaScenarios("tracker"), ...areaScenarios("timelines-landing")),
    mirror: false,
  });
  for (const name of [
    "tracker-claim-sync-complete-and-blocked-transitions",
    "tags-one-vocabulary-and-old-spellings",
    "browser-chronicle-scrub-range-span-and-links",
    "timeline-compact-landing-gates-receipt-and-native-source",
  ] as const)
    assert(tracker.scenarios!.includes(name), name);
  for (const name of [
    "queue-concurrency-failure-fencing-and-push-recovery",
    "source-retention-expiry-orphan-and-canonical-purge",
    "browser-usage-and-costs-account-and-site",
  ] as const)
    assert(!tracker.scenarios!.includes(name), name);

  assert.deepEqual(select("apps/website/worker/usage/report.ts"), {
    scenarios: [
      "gm-clone-commit-push-and-denied-push",
      "tracker-claim-sync-complete-and-blocked-transitions",
      "usage-metering-collects-per-account",
      "browser-usage-and-costs-account-and-site",
      "browser-data-retention-account-and-site",
      "push-log-retention-and-unreachable-git",
    ],
    mirror: false,
  });

  const cli = select("apps/cli/src/main.rs");
  assert.deepEqual(cli, { scenarios: agentsSelection(...areaScenarios("gm")), mirror: false });
  for (const name of [
    "authorization-and-token-revocation",
    "profile-picture-upload-serve-and-remove",
    "durable-objects-register-and-purge",
    "browser-usage-and-costs-account-and-site",
    "browser-personas-persisted-product-state",
    "browser-timeline-scope-round-trip",
    "browser-chronicle-scrub-range-span-and-links",
  ] as const)
    assert(!cli.scenarios!.includes(name), name);
  const pkg = select("apps/cli/src/commands/pkg.rs");
  assert.deepEqual(pkg, {
    scenarios: agentsSelection(...areaScenarios("packages")),
    mirror: false,
  });
  assert(pkg.scenarios!.includes("registry-retention-keeps-installs-working"));
  assert(!pkg.scenarios!.includes("tracker-retention-removes-closed-issues-and-replicas-converge"));
  assert.deepEqual(select("apps/cli/src/meta.rs"), {
    scenarios: [
      "gm-clone-commit-push-and-denied-push",
      "tracker-claim-sync-complete-and-blocked-transitions",
    ],
    mirror: false,
  });

  assert.deepEqual(select("apps/website/src/routes/tracker/Story.tsx"), {
    scenarios: expandE2EScenarios([
      "ci-retention-removes-logs-and-runs",
      "browser-usage-and-costs-account-and-site",
      "browser-data-retention-account-and-site",
      "tracker-retention-removes-closed-issues-and-replicas-converge",
      "assistant-chats-expire",
      "auth-hygiene-keeps-sign-in-and-tokens-working",
      "password-accounts-admin-create-sign-in-and-reset",
      "browser-personas-persisted-product-state",
      "browser-atlas-smoke",
      "browser-timeline-scope-round-trip",
      "browser-expired-source-without-timeline-history",
      "browser-chronicle-scrub-range-span-and-links",
    ]),
    mirror: false,
  });
});

await test("AI-only code, the docs site and prose select nothing; nothing provisions nothing", () => {
  for (const path of [
    "apps/website/worker/release-notes/feed.ts",
    "apps/website/worker/knowledge/build.ts",
    "apps/website/worker/semantic/index.ts",
    "apps/website/shared/release-notes.ts",
    "apps/cli/src/commands/ask.rs",
    "apps/site/src/x.tsx",
    "apps/site/package.json",
    "apps/site/cloudflare.config.ts",
    "DESIGN.md",
    "PRODUCT.md",
    "LICENSE",
    "TIMELINES-RESEARCH.md",
    "apps/website/DESIGN.md",
    ".claude/agents/runner.md",
    ".claude/hooks/check.sh",
    ".agents/skills/gitmatrix-graph-work/SKILL.md",
    ".gitmatrix/ci.yml",
    "tools/preview/preview.ts",
    "tools/agent/deploy.ts",
    "tools/agent/main-e2e.ts",
    "tools/agent/ai-stages.ts",
    "packages/testing/src/fixtures.ts",
  ]) {
    assert.deepEqual(select(path), nothing, path);
    assert.equal(selectsE2E(select(path)), false, path);
  }
  assert.equal(selectsE2E({ scenarios: null, mirror: true }), true);
  assert.equal(selectsE2E({ scenarios: [], mirror: true }), true);
});

await test("transport and mirror paths run the mirror stage; helpers select their journeys", () => {
  for (const path of [
    "apps/website/worker/git/receive-pack.ts",
    "apps/website/worker/refs/resolve.ts",
    "apps/website/worker/artifacts.ts",
    "apps/website/worker/objects.ts",
  ]) {
    const selection = select(path);
    assert.equal(selection.mirror, true, path);
    assert(selection.scenarios!.includes("queue-concurrency-failure-fencing-and-push-recovery"));
    assert(selection.scenarios!.includes("source-push-recovery-fences-late-writes"));
  }
  assert.deepEqual(select("apps/website/worker/mirror/sync.ts"), { scenarios: [], mirror: true });
  assert.deepEqual(select("tools/agent/source-auth-e2e.ts"), {
    scenarios: ["source-authorization-native-and-canonical-separation"],
    mirror: false,
  });
  assert.deepEqual(select("tools/agent/queue-e2e.ts").scenarios, [
    "queue-concurrency-failure-fencing-and-push-recovery",
    "source-push-recovery-fences-late-writes",
    "source-late-sync-lineage-conflicts-guard-and-expiry",
  ]);
  assert.deepEqual(select("tools/agent/chronicle-e2e.ts").scenarios, [
    "gm-clone-commit-push-and-denied-push",
    "package-upload-download-and-write-boundary",
    "ci-push-triggered-local-dag-and-provenance",
    "browser-chronicle-scrub-range-span-and-links",
  ]);
});

await test("an unnamed Worker or shared module selects the core journeys, not everything", () => {
  for (const path of [
    "apps/website/worker/new-module.ts",
    "apps/website/worker/api/new-route.ts",
    "apps/website/shared/api.ts",
  ]) {
    const selection = select(path);
    assert(selection.scenarios!.length < agentScenarioNames.length, path);
    assert(selection.scenarios!.includes("tracker-claim-sync-complete-and-blocked-transitions"));
    assert(selection.scenarios!.includes("authorization-and-token-revocation"));
    for (const slow of [
      "queue-concurrency-failure-fencing-and-push-recovery",
      "source-retention-expiry-orphan-and-canonical-purge",
      "timeline-nested-admission-and-canonical-revert",
    ] as const)
      assert(!selection.scenarios!.includes(slow), `${path}: ${slow}`);
  }
});

await test("frontend selection preserves browser journeys but omits unrelated E2E and mirror", () => {
  const selection = select("apps/website/src/routes/repo/Repo.tsx");
  assert.equal(selection.mirror, false);
  assert(selection.scenarios);
  for (const unrelated of [
    "queue-concurrency-failure-fencing-and-push-recovery",
    "ci-cancellation-and-job-token-lifetime",
    "registry-retention-keeps-installs-working",
    "retention-concurrent-with-pushes-builds-and-chats",
    "source-retention-expiry-orphan-and-canonical-purge",
  ]) {
    assert(!selection.scenarios.includes(unrelated), unrelated);
  }
  assert.deepEqual(select("apps/website/public/favicon.svg"), selection);
  assert.deepEqual(select("apps/website/index.html"), selection);
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
  assert.deepEqual(expandE2EScenarios(["agent-identity-provisioned-on-first-use"]), [
    "gm-clone-commit-push-and-denied-push",
    "ci-failing-prerequisite-skips-dependent",
    "agent-identity-provisioned-on-first-use",
  ]);
  assert.deepEqual(expandE2EScenarios(["source-late-sync-lineage-conflicts-guard-and-expiry"]), [
    "source-late-sync-lineage-conflicts-guard-and-expiry",
  ]);
});

await test("audited route selection keeps every traversing journey and its prerequisites", () => {
  const usage = "apps/website/src/routes/UsageCosts.tsx";
  const retention = "apps/website/src/routes/DataRetention.tsx";
  const both = expandE2EScenarios([
    "browser-usage-and-costs-account-and-site",
    "browser-data-retention-account-and-site",
  ]);
  assert.deepEqual(select(usage), { scenarios: both, mirror: false });
  assert.deepEqual(select(retention), {
    scenarios: expandE2EScenarios(["browser-data-retention-account-and-site"]),
    mirror: false,
  });
  assert.deepEqual(select(retention, usage, usage), { scenarios: both, mirror: false });
  // Selection consumes diff paths, never filesystem existence: a deleted mapped
  // endpoint still selects its witnesses; an unknown rename endpoint widens.
  const broad = select("apps/website/src/App.tsx");
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
    assert.deepEqual(select(usage, path), broad, path);
    assert.deepEqual(select(path, retention), broad, path);
  }
  // Backend paths add their areas' journeys to the frontend's.
  const withUsage = select(usage, "apps/website/worker/usage/report.ts");
  assert.deepEqual(withUsage, {
    scenarios: expandE2EScenarios([...both, ...areaScenarios("usage")]),
    mirror: false,
  });
  assert.deepEqual(select(usage, "apps/website/worker/schema.ts"), agentsFull);
});

await test("docs and unit/browser test changes do not widen frontend selection", () => {
  const frontend = "apps/website/src/routes/repo/Repo.tsx";
  assert.deepEqual(
    select(
      frontend,
      "README.md",
      "apps/website/README.md",
      "apps/cli/src/transport.test.ts",
      "tools/agent/environment.test.ts",
      "apps/website/src/routes/repo/Repo.browser.test.tsx",
    ),
    select(frontend),
  );
  assert.deepEqual(select("README.md", "tools/agent/environment.test.ts"), nothing);
});

await test("runtime, configuration, harness and unknown paths select agents' full set", () => {
  for (const path of [
    "apps/website/worker/app.ts",
    "apps/website/worker/index.ts",
    "apps/website/worker/schema.ts",
    "apps/website/worker/db.ts",
    "apps/website/worker/auth.ts",
    "apps/website/worker/api/dev.ts",
    "apps/website/migrations/20261012222238_deployment_provenance.sql",
    "apps/website/seed/0001_dev.sql",
    "apps/website/cloudflare.config.ts",
    "apps/website/vite/plugin.ts",
    "apps/website/vite.config.ts",
    "apps/website/package.json",
    "apps/website/tsconfig.worker.json",
    "apps/website/wrangler.jsonc",
    "apps/website/server/main.ts",
    "apps/website/shared/worker-first.ts",
    "vite.config.ts",
    "package.json",
    "pnpm-lock.yaml",
    "patches/cf.patch",
    "packages/utils/src/index.ts",
    "tools/agent/e2e.ts",
    "tools/agent/seed.ts",
    "tools/agent/environment.ts",
    "tools/agent/ready-e2e.ts",
    "tools/agent/new-harness.ts",
    "tools/remote/worker.ts",
    "docs/config.json",
    "docs/architecture.md",
    "unknown/README.md",
    "apps/new-workspace/example.test.ts",
    "new-production-module.ts",
  ]) {
    assert.deepEqual(select("apps/website/src/App.tsx", path), agentsFull, path);
  }
});

await test("invalid scenario names fail before any E2E filesystem or runtime side effects", async () => {
  assert.throws(() => expandE2EScenarios(["browser-atlas-smkoe"]), /Unknown E2E scenario/);
  // Unknown names must still fail beside valid ones.
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
      version: 4,
      origin,
      readToken: "",
      tokens: { priya: "", marco: "", jun: "", sam: "" },
      repos: [
        { space: "orbit", name: "engine", visibility: "private" },
        { space: "sam", name: "private", visibility: "private" },
        { space: "orbit", name: "public", visibility: "public" },
      ],
      tracker: { space: "orbit", team: "", ready: "", blocked: "", blocker: "" },
    },
  };
}

await test("area-only journeys run for their own area but not in agents' full set (CORE-406)", () => {
  for (const name of areaOnlyScenarios) {
    assert(!agentScenarioNames.includes(name), name);
    for (const [scenario, needs] of Object.entries(prerequisites))
      assert(!needs.includes(name), `${scenario} needs area-only ${name}`);
  }
  assert(
    selectReadyE2E(["apps/website/worker/merge-queue/scheduler.ts"], false).scenarios?.includes(
      "queue-concurrency-failure-fencing-and-push-recovery",
    ),
  );
  const global = selectReadyE2E(["apps/website/worker/schema.ts"], false).scenarios ?? [];
  for (const name of areaOnlyScenarios) assert(!global.includes(name), name);
});

await test("gm modules every command runs select every gm journey; permissions widen to agents' full set (CORE-406)", () => {
  for (const path of [
    "apps/cli/src/agent.rs",
    "apps/cli/src/profile.rs",
    "apps/cli/src/commands/server.rs",
  ])
    assert.deepEqual(
      select(path),
      { scenarios: agentsSelection(...areaScenarios("gm")), mirror: false },
      path,
    );
  assert.deepEqual(select("apps/website/worker/permissions.ts"), agentsFull);
  assert.deepEqual(select("apps/cli/src/agent/setup.rs"), {
    scenarios: agentsSelection(...areaScenarios("agents")),
    mirror: false,
  });
});

await test("an agents-full path adds to the other paths' selection instead of replacing it (CORE-406)", () => {
  const both = selectReadyE2E(
    [
      "apps/website/worker/merge-queue/scheduler.ts",
      "apps/website/migrations/20260101000000_x.sql",
    ],
    false,
  );
  assert.equal(both.mirror, true);
  for (const name of agentScenarioNames) assert(both.scenarios!.includes(name), name);
  assert(both.scenarios!.includes("queue-concurrency-failure-fencing-and-push-recovery"));
  assert(!both.scenarios!.includes("source-multi-repository-landing-and-durable-recovery"));
  assert.deepEqual(select("tools/agent/e2e.ts"), agentsFull);
});
