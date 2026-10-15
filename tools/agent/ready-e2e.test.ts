import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runE2E, runPool } from "./e2e.ts";
import {
  agentScenarioNames,
  areaOnlyScenarios,
  areaScenarios,
  browserScenarios,
  e2eAreas,
  e2eScenarioNames,
  e2eWorkers,
  expandE2EScenarios,
  mainOnlyScenarios,
  prerequisites,
  resources,
  scenarioAreas,
  scenarioResources,
  schedule,
  selectReadyE2E,
  selectsE2E,
  type Access,
  type Resource,
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

await test("every scenario declares the shared resources it reads or writes", () => {
  assert.deepEqual(Object.keys(scenarioResources).sort(), [...e2eScenarioNames].sort());
  for (const name of e2eScenarioNames) {
    const declared = scenarioResources[name];
    for (const [resource, access] of Object.entries(declared)) {
      assert((resources as readonly string[]).includes(resource), `${name}: ${resource}`);
      assert(["read", "write"].includes(access), `${name}: ${resource} ${access}`);
    }
    // orbit/engine is in orbit: orbit-wide retention must wait for its users.
    if (declared.engine) assert(declared["space:orbit"], `${name} uses engine but not orbit`);
  }
  // The Instance-wide writers found in e2e.ts and its helpers.
  assert.deepEqual(
    e2eScenarioNames.filter((name) => scenarioResources[name].instance === "write"),
    [
      "agent-capabilities-self-reporting-and-claim-identity",
      "ai-gateway-log-bodies-site-default-and-account-override",
      "browser-data-retention-account-and-site",
      "registry-retention-keeps-installs-working",
      "auth-hygiene-keeps-sign-in-and-tokens-working",
      "source-retention-expiry-orphan-and-canonical-purge",
    ],
  );
  // The long CI slot holders found in e2e.ts and its helpers: one at a time, so
  // the other runner slots (one at two workers, two from three) stay free.
  assert.deepEqual(
    e2eScenarioNames.filter((name) => scenarioResources[name]["ci-runner-hold"]),
    [
      "ci-cancellation-and-job-token-lifetime",
      "queue-concurrency-failure-fencing-and-push-recovery",
      "repository-deletion-purges-everything-and-resumes",
      "source-retention-expiry-orphan-and-canonical-purge",
    ],
  );
  for (const name of e2eScenarioNames)
    if (scenarioResources[name]["ci-runner-hold"])
      assert.equal(scenarioResources[name]["ci-runner-hold"], "write", name);
  assert.equal(browserScenarios.length, 12);
});

type Declared = Record<ScenarioName, Partial<Record<Resource, Access>>>;
const none = Object.fromEntries(e2eScenarioNames.map((name) => [name, {}])) as Declared;
const independent = Object.fromEntries(
  e2eScenarioNames.map((name): [ScenarioName, ScenarioName[]] => [name, []]),
) as Record<ScenarioName, ScenarioName[]>;
const waits = (selected: ScenarioName[], declared: Declared, needs = independent) =>
  Object.fromEntries(
    [...schedule(selected, declared, needs).waitsFor].map(([name, set]) => [name, [...set]]),
  );

await test("schedule waits for conflicts, prerequisites and Instance-wide writers, in suite order", () => {
  const [a, b, c, d] = [
    "authorization-and-token-revocation",
    "gm-clone-commit-push-and-denied-push",
    "repository-file-history-and-attribution",
    "tracker-claim-sync-complete-and-blocked-transitions",
  ] as const;
  // Nothing shared and no prerequisites: everything at once.
  assert.deepEqual(waits([a, b, c, d], none), { [a]: [], [b]: [], [c]: [], [d]: [] });
  assert(
    [...schedule(e2eScenarioNames, none, independent).waitsFor.values()].every(
      (set) => set.size === 0,
    ),
  );
  // Readers share; a writer waits for and is waited for by each other user.
  const declared: Declared = {
    ...none,
    [a]: { engine: "read" },
    [b]: { engine: "read" },
    [c]: { engine: "write" },
    [d]: { engine: "read", "space:sam": "write" },
  };
  assert.deepEqual(waits([a, b, c, d], declared), { [a]: [], [b]: [], [c]: [a, b], [d]: [c] });
  // A prerequisite is waited for even without a shared resource.
  assert.deepEqual(waits([a, b, c, d], none, { ...independent, [d]: [a] }), {
    [a]: [],
    [b]: [],
    [c]: [],
    [d]: [a],
  });
  // An Instance-wide writer runs alone, last unless something needs it.
  const alone: Declared = { ...none, [b]: { instance: "write" } };
  assert.deepEqual(schedule([a, b, c, d], alone, independent).order, [a, c, d, b]);
  assert.deepEqual(waits([a, b, c, d], alone), { [a]: [], [c]: [], [d]: [], [b]: [a, c, d] });
  const needed = { ...independent, [c]: [b] };
  assert.deepEqual(schedule([a, b, c, d], alone, needed).order, [a, b, c, d]);
  assert.deepEqual(waits([a, b, c, d], alone, needed), {
    [a]: [],
    [b]: [a],
    [c]: [b],
    [d]: [b],
  });
  // The real declarations: engine's writers one after another; queue (its own
  // repositories) beside them, but after the tracker scenario's gm state.
  const real = schedule([
    "gm-clone-commit-push-and-denied-push",
    "tracker-claim-sync-complete-and-blocked-transitions",
    "package-upload-download-and-write-boundary",
    "queue-concurrency-failure-fencing-and-push-recovery",
  ]);
  assert.deepEqual(Object.fromEntries([...real.waitsFor].map(([name, set]) => [name, [...set]])), {
    "gm-clone-commit-push-and-denied-push": [],
    "tracker-claim-sync-complete-and-blocked-transitions": [],
    "package-upload-download-and-write-boundary": ["gm-clone-commit-push-and-denied-push"],
    "queue-concurrency-failure-fencing-and-push-recovery": [
      "tracker-claim-sync-complete-and-blocked-transitions",
    ],
  });
});

/** List scheduling as runE2E's pool does it, over historical durations (seconds). */
function makespan(
  selected: readonly ScenarioName[],
  workers: number,
  seconds: Record<ScenarioName, number>,
  declared: Declared = scenarioResources,
  needs = prerequisites,
): number {
  const { order, waitsFor } = schedule(selected, declared, needs);
  const left = new Map(order.map((name) => [name, seconds[name]]));
  const pending = [...order];
  const running = new Set<ScenarioName>();
  const done = new Set<ScenarioName>();
  let now = 0;
  while (done.size < order.length) {
    // A copy: starting or blocking a scenario removes it from pending.
    for (const name of pending.slice()) {
      if (running.size >= workers) break;
      if (![...waitsFor.get(name)!].every((need) => done.has(need))) continue;
      const browsers = [...running].filter((other) => browserScenarios.includes(other)).length;
      if (browserScenarios.includes(name) && browsers >= 2) continue;
      pending.splice(pending.indexOf(name), 1);
      running.add(name);
    }
    const step = Math.min(...[...running].map((name) => left.get(name)!));
    now += step;
    for (const name of running) {
      left.set(name, left.get(name)! - step);
      if (left.get(name)! <= 0) {
        running.delete(name);
        done.add(name);
      }
    }
  }
  return now;
}

await test("four workers more than halve the suite over its historical scenario medians", async () => {
  const seconds = JSON.parse(
    await readFile(new URL("fixtures/e2e-scenario-medians.json", import.meta.url), "utf8"),
  ) as Record<ScenarioName, number>;
  assert.deepEqual(Object.keys(seconds), [...e2eScenarioNames]);
  for (const selected of [e2eScenarioNames, agentScenarioNames]) {
    const serial = selected.reduce((sum, name) => sum + seconds[name], 0);
    assert.equal(makespan(selected, 1, seconds), serial, "One worker is the serial suite");
    const parallel = makespan(selected, 4, seconds);
    // Measured with these declarations: 1249 → 591 s (full), 405 → 222 s (agents').
    assert(parallel < serial * 0.6, `${parallel} s of ${serial} s`);
  }
  // Nothing shared: the longest scenario bounds the run.
  assert.equal(
    makespan(e2eScenarioNames, e2eScenarioNames.length, seconds, none, independent),
    Math.max(...Object.values(seconds)),
  );
});

await test("GITMATRIX_E2E_WORKERS defaults to one and refuses anything but a positive integer", () => {
  assert.equal(e2eWorkers({}), 1);
  assert.equal(e2eWorkers({ GITMATRIX_E2E_WORKERS: "" }), 1);
  assert.equal(e2eWorkers({ GITMATRIX_E2E_WORKERS: "4" }), 4);
  for (const value of ["0", "-1", "2.5", "two"])
    assert.throws(() => e2eWorkers({ GITMATRIX_E2E_WORKERS: value }), /positive integer/);
});

await test("side by side, unselected scenarios are still separate skip events and nothing runs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ready-e2e-workers-"));
  const events: unknown[] = [];
  t.mock.method(console, "log", (line: string) => events.push(JSON.parse(line)));
  const before = process.env.GITMATRIX_E2E_WORKERS;
  process.env.GITMATRIX_E2E_WORKERS = "4";
  try {
    const { ctx, fixtures } = emptyFixture(directory);
    await runE2E(ctx, fixtures, []);
    assert.deepEqual(
      events,
      e2eScenarioNames.map((scenario) => ({ event: "e2e-scenario-skipped", scenario })),
    );
    assert.deepEqual(await readdir(ctx.artifacts), []);
  } finally {
    if (before === undefined) delete process.env.GITMATRIX_E2E_WORKERS;
    else process.env.GITMATRIX_E2E_WORKERS = before;
    await rm(directory, { recursive: true, force: true });
  }
});

// The suite's scenarios with no-op bodies: runPool hands each to its `run`.
const registry = e2eScenarioNames.map((name) => ({ name, body: async () => {} }));

await test("one worker runs in suite order and stops at the first failure, as before", async (t) => {
  const events: unknown[] = [];
  t.mock.method(console, "log", (line: string) => events.push(JSON.parse(line)));
  const ran: string[] = [];
  const failure = new Error("gm-clone-commit-push-and-denied-push: boom");
  const selected = new Set<string>([
    "authorization-and-token-revocation",
    "gm-clone-commit-push-and-denied-push",
    "package-upload-download-and-write-boundary",
  ]);
  await assert.rejects(
    runPool(registry, selected, 1, async (name) => {
      ran.push(name);
      if (name === "gm-clone-commit-push-and-denied-push") throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(ran, [
    "authorization-and-token-revocation",
    "gm-clone-commit-push-and-denied-push",
  ]);
  // Skips print as the suite reaches them; nothing after the failure.
  assert.deepEqual(events, []);
});

await test("side by side a failure stops only what waits for it; failures are thrown together", async (t) => {
  const events: { event: string; scenario: string; failed?: string }[] = [];
  t.mock.method(console, "log", (line: string) => events.push(JSON.parse(line)));
  const ran: string[] = [];
  const selected = new Set<string>([
    "gm-clone-commit-push-and-denied-push",
    "tracker-claim-sync-complete-and-blocked-transitions",
    "package-upload-download-and-write-boundary",
    "ci-push-triggered-local-dag-and-provenance",
    "queue-concurrency-failure-fencing-and-push-recovery",
  ]);
  const failure = new Error("gm-clone-commit-push-and-denied-push: boom");
  await assert.rejects(
    runPool(registry, selected, 4, async (name) => {
      ran.push(name);
      await delay(5);
      if (name === "gm-clone-commit-push-and-denied-push") throw failure;
    }),
    (error) => error === failure,
  );
  assert.deepEqual(ran.toSorted(), [
    "gm-clone-commit-push-and-denied-push",
    "queue-concurrency-failure-fencing-and-push-recovery",
    "tracker-claim-sync-complete-and-blocked-transitions",
  ]);
  assert.deepEqual(
    events.filter((event) => event.event === "e2e-scenario-blocked"),
    [
      {
        event: "e2e-scenario-blocked",
        scenario: "package-upload-download-and-write-boundary",
        failed: "gm-clone-commit-push-and-denied-push",
      },
      {
        event: "e2e-scenario-blocked",
        scenario: "ci-push-triggered-local-dag-and-provenance",
        failed: "gm-clone-commit-push-and-denied-push",
      },
    ],
  );
  assert.equal(
    events.filter((event) => event.event === "e2e-scenario-skipped").length,
    e2eScenarioNames.length - selected.size,
  );
  // Two independent failures: both reported, neither hides the other.
  const both = new Set<string>([
    "gm-clone-commit-push-and-denied-push",
    "tracker-claim-sync-complete-and-blocked-transitions",
  ]);
  await assert.rejects(
    runPool(registry, both, 4, async (name) => {
      throw new Error(`${name}: boom`);
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      /gm-clone.*boom; tracker-claim.*boom/.test(error.message),
  );
});

await test("side by side at most `workers` scenarios and two browser scenarios run at once", async () => {
  // Independent of each other: they overlap as far as the limits allow.
  const browsers = [
    "browser-timeline-scope-round-trip",
    "assistant-chats-expire",
    "password-accounts-admin-create-sign-in-and-reset",
    "browser-atlas-smoke",
  ];
  const others = [
    "durable-objects-register-and-purge",
    "source-push-recovery-fences-late-writes",
    "source-late-sync-lineage-conflicts-guard-and-expiry",
  ];
  let most = 0,
    mostBrowsers = 0;
  const open = new Set<string>();
  await runPool(registry, new Set([...browsers, ...others]), 3, async (name) => {
    open.add(name);
    most = Math.max(most, open.size);
    const browsing = [...open].filter((other) => browsers.includes(other)).length;
    mostBrowsers = Math.max(mostBrowsers, browsing);
    await delay(5);
    open.delete(name);
  });
  assert.equal(most, 3);
  assert.equal(mostBrowsers, 2);
});
