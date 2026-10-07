export interface ReadyE2ESelection {
  scenarios: string[] | null;
  mirror: boolean;
}

// Execution order is owned by runE2E; its scenario names use ScenarioName so new
// journeys must join this inventory and have their frontend coverage considered.
export const e2eScenarioNames = [
  "authorization-and-token-revocation",
  "gm-clone-commit-push-and-denied-push",
  "repository-file-history-and-attribution",
  "tracker-claim-sync-complete-and-blocked-transitions",
  "chronicle-history-and-linked-work-over-api",
  "timeline-fork-owned-source-and-abandon-permissions",
  "gm-timeline-start-push-and-abandon",
  "agent-capabilities-self-reporting-and-claim-identity",
  "tags-one-vocabulary-and-old-spellings",
  "tightening-requirements-on-a-claimed-issue",
  "agent-durable-interventions-and-resume",
  "tracker-handoff-to-an-agent-created-after-sync",
  "package-upload-download-and-write-boundary",
  "ci-push-triggered-local-dag-and-provenance",
  "ci-failing-prerequisite-skips-dependent",
  "ci-job-records-and-updates-a-deployment",
  "ci-cancellation-and-job-token-lifetime",
  "ci-retention-removes-logs-and-runs",
  "timeline-compact-landing-gates-receipt-and-native-source",
  "steps-context-hook-live-run-landing-and-access",
  "timeline-landing-conflict-asks-for-a-sync",
  "timeline-nested-admission-and-canonical-revert",
  "queue-concurrency-failure-fencing-and-push-recovery",
  "agent-setup-memorable-persistent-identities",
  "agent-identity-provisioned-on-first-use",
  "profile-picture-upload-serve-and-remove",
  "durable-objects-register-and-purge",
  "usage-metering-collects-per-account",
  "ai-gateway-log-bodies-site-default-and-account-override",
  "browser-usage-and-costs-account-and-site",
  "browser-data-retention-account-and-site",
  "tracker-retention-removes-closed-issues-and-replicas-converge",
  "registry-retention-keeps-installs-working",
  "repository-deletion-purges-everything-and-resumes",
  "assistant-chats-expire",
  "auth-hygiene-keeps-sign-in-and-tokens-working",
  "push-log-retention-and-unreachable-git",
  "browser-personas-persisted-product-state",
  "browser-atlas-smoke",
  "atlas-revocation-reads-like-a-missing-repository",
  "browser-timeline-scope-round-trip",
  "retention-concurrent-with-pushes-builds-and-chats",
  "source-authorization-native-and-canonical-separation",
  "source-multi-repository-landing-and-durable-recovery",
  "source-late-sync-lineage-conflicts-guard-and-expiry",
  "source-finite-legacy-migration-and-partial-revert",
  "source-retention-expiry-orphan-and-canonical-purge",
  "browser-chronicle-scrub-range-span-and-links",
] as const;

export type ScenarioName = (typeof e2eScenarioNames)[number];

// Only these scenarios have audited independent setup. Other domains keep the
// complete suite rather than guessing at dependencies on preceding mutations.
const prerequisites: Partial<Record<ScenarioName, readonly ScenarioName[]>> = {
  "gm-clone-commit-push-and-denied-push": [],
  "tracker-claim-sync-complete-and-blocked-transitions": [],
  "package-upload-download-and-write-boundary": [],
  // The job uses the checkout/file from clone and the registry grant from package.
  "ci-push-triggered-local-dag-and-provenance": [
    "gm-clone-commit-push-and-denied-push",
    "package-upload-download-and-write-boundary",
  ],
  "ci-retention-removes-logs-and-runs": ["gm-clone-commit-push-and-denied-push"],
  // Metering asserts both pushed pack bytes and an instantiated account Tracker.
  "usage-metering-collects-per-account": [
    "gm-clone-commit-push-and-denied-push",
    "tracker-claim-sync-complete-and-blocked-transitions",
  ],
  "browser-usage-and-costs-account-and-site": ["usage-metering-collects-per-account"],
  "browser-data-retention-account-and-site": ["usage-metering-collects-per-account"],
  "tracker-retention-removes-closed-issues-and-replicas-converge": [],
  "assistant-chats-expire": [],
  "auth-hygiene-keeps-sign-in-and-tokens-working": [],
  // Browser asserts the completed issue's note, successful CI run and package 2.0.0.
  "browser-personas-persisted-product-state": [
    "tracker-claim-sync-complete-and-blocked-transitions",
    "ci-push-triggered-local-dag-and-provenance",
  ],
  "browser-atlas-smoke": [],
  "browser-timeline-scope-round-trip": [],
  // The expired-source browser page is embedded in this independently seeded journey.
  "source-retention-expiry-orphan-and-canonical-purge": [],
  // Chronicle seeds its own history but links to an existing pushed CI commit.
  "browser-chronicle-scrub-range-span-and-links": ["ci-push-triggered-local-dag-and-provenance"],
};

const browserScenarios: readonly ScenarioName[] = [
  "ci-retention-removes-logs-and-runs",
  "browser-usage-and-costs-account-and-site",
  "browser-data-retention-account-and-site",
  "tracker-retention-removes-closed-issues-and-replicas-converge",
  "assistant-chats-expire",
  "auth-hygiene-keeps-sign-in-and-tokens-working",
  "browser-personas-persisted-product-state",
  "browser-atlas-smoke",
  "browser-timeline-scope-round-trip",
  "source-retention-expiry-orphan-and-canonical-purge",
  "browser-chronicle-scrub-range-span-and-links",
];

/** Validate before any E2E side effects; add prerequisites in suite execution order. */
export function expandE2EScenarios(selected: readonly string[]): ScenarioName[] {
  const known: readonly string[] = e2eScenarioNames;
  for (const name of selected) {
    if (!known.includes(name)) throw new Error(`Unknown E2E scenario: ${name}`);
  }
  const included = new Set<ScenarioName>();
  function include(name: ScenarioName) {
    if (included.has(name)) return;
    included.add(name);
    const dependencies = prerequisites[name];
    if (dependencies === undefined) {
      for (const scenario of e2eScenarioNames) included.add(scenario);
      return;
    }
    for (const dependency of dependencies) include(dependency);
  }
  for (const name of selected) include(name as ScenarioName);
  return e2eScenarioNames.filter((name) => included.has(name));
}

/** Pure path selection: an unfamiliar production/configuration path always widens. */
export function selectReadyE2E(changed: readonly string[], full: boolean): ReadyE2ESelection {
  if (full) return { scenarios: null, mirror: true };
  const selected: string[] = [];
  for (const path of changed) {
    if (/^apps\/website\/(src|public)\//.test(path)) {
      selected.push(...browserScenarios);
    } else if (
      /^(?:(?:apps\/(?:cli|website)|tools\/(?:agent|preview)|packages\/(?:formats|testing|utils))\/)?(?:README|CHANGELOG|CONTRIBUTING|AGENTS)\.md$/.test(
        path,
      ) ||
      /^(?:apps\/(?:cli|website)|tools\/(?:agent|preview)|packages\/(?:formats|testing|utils))\/.*\.(test|spec)\.[cm]?[jt]sx?$/.test(
        path,
      ) ||
      /^apps\/cli\/tests\/.*\.rs$/.test(path)
    ) {
      continue;
    } else {
      return { scenarios: null, mirror: true };
    }
  }
  return { scenarios: expandE2EScenarios(selected), mirror: false };
}
