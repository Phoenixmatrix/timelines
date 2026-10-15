import assert from "node:assert/strict";

export interface ReadyE2ESelection {
  /** null runs every scenario, main-only ones included (explicit `--all`). */
  scenarios: string[] | null;
  mirror: boolean;
}

// Execution order is owned by runE2E; its scenario names use ScenarioName so new
// journeys must join this inventory, its prerequisites and its areas.
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
  "password-accounts-admin-create-sign-in-and-reset",
  "push-log-retention-and-unreachable-git",
  "browser-personas-persisted-product-state",
  "browser-atlas-smoke",
  "atlas-revocation-reads-like-a-missing-repository",
  "browser-timeline-scope-round-trip",
  "retention-concurrent-with-pushes-builds-and-chats",
  "source-authorization-native-and-canonical-separation",
  "source-multi-repository-landing-and-durable-recovery",
  "source-push-recovery-fences-late-writes",
  "source-late-sync-lineage-conflicts-guard-and-expiry",
  "source-finite-legacy-migration-and-partial-revert",
  "source-retention-expiry-orphan-and-canonical-purge",
  "browser-expired-source-without-timeline-history",
  "browser-chronicle-scrub-range-span-and-links",
] as const;

export type ScenarioName = (typeof e2eScenarioNames)[number];

/**
 * What each scenario reads that an earlier one created, audited against e2e.ts
 * and its helpers. Every other scenario makes its own fixtures (a fresh tracker
 * team, agent, timeline, `orbit/queue-*`, `sam/*`, `jun/*` or Atlas repository)
 * or reads only the seed. Timelines land on orbit/engine's main from wherever it
 * is: each reads its own main tip and writes its own .gitmatrix/ci.yml, and a
 * landing without gate jobs skips the gates. Each claim of the seed's
 * agent-blocker issue is released by the scenario that made it.
 */
export const prerequisites: Readonly<Record<ScenarioName, readonly ScenarioName[]>> = {
  "authorization-and-token-revocation": [],
  "gm-clone-commit-push-and-denied-push": [],
  // Reads the agent-e2e bookmark that clone pushed: exactly two commits.
  "repository-file-history-and-attribution": ["gm-clone-commit-push-and-denied-push"],
  "tracker-claim-sync-complete-and-blocked-transitions": [],
  "chronicle-history-and-linked-work-over-api": [],
  "timeline-fork-owned-source-and-abandon-permissions": [],
  "gm-timeline-start-push-and-abandon": [],
  // Runs gm with clone's checkout as its working directory.
  "agent-capabilities-self-reporting-and-claim-identity": ["gm-clone-commit-push-and-denied-push"],
  "tags-one-vocabulary-and-old-spellings": [],
  "tightening-requirements-on-a-claimed-issue": [],
  "agent-durable-interventions-and-resume": [],
  "tracker-handoff-to-an-agent-created-after-sync": [],
  "package-upload-download-and-write-boundary": [],
  // CI pipelines commit in clone's checkout. The success DAG publishes through
  // package's grant; the cancellation scenario's job token reads that package.
  "ci-push-triggered-local-dag-and-provenance": [
    "gm-clone-commit-push-and-denied-push",
    "package-upload-download-and-write-boundary",
  ],
  "ci-failing-prerequisite-skips-dependent": ["gm-clone-commit-push-and-denied-push"],
  "ci-job-records-and-updates-a-deployment": ["gm-clone-commit-push-and-denied-push"],
  "ci-cancellation-and-job-token-lifetime": [
    "gm-clone-commit-push-and-denied-push",
    "package-upload-download-and-write-boundary",
  ],
  "ci-retention-removes-logs-and-runs": ["gm-clone-commit-push-and-denied-push"],
  "timeline-compact-landing-gates-receipt-and-native-source": [],
  "steps-context-hook-live-run-landing-and-access": [],
  "timeline-landing-conflict-asks-for-a-sync": [],
  "timeline-nested-admission-and-canonical-revert": [],
  "queue-concurrency-failure-fencing-and-push-recovery": [],
  "agent-setup-memorable-persistent-identities": [],
  // `gm runs start --ref agent-ci-failure`: the branch and pipeline ci-failing pushed.
  "agent-identity-provisioned-on-first-use": ["ci-failing-prerequisite-skips-dependent"],
  "profile-picture-upload-serve-and-remove": [],
  "durable-objects-register-and-purge": [],
  // Metering asserts both pushed pack bytes and an instantiated account Tracker.
  "usage-metering-collects-per-account": [
    "gm-clone-commit-push-and-denied-push",
    "tracker-claim-sync-complete-and-blocked-transitions",
  ],
  "ai-gateway-log-bodies-site-default-and-account-override": [],
  // Both read the usage report day that the metering collection produced.
  "browser-usage-and-costs-account-and-site": ["usage-metering-collects-per-account"],
  "browser-data-retention-account-and-site": ["usage-metering-collects-per-account"],
  "tracker-retention-removes-closed-issues-and-replicas-converge": [],
  // Installs the package scenario's executable 1.0.0 and 2.0.0 after collection.
  "registry-retention-keeps-installs-working": ["package-upload-download-and-write-boundary"],
  "repository-deletion-purges-everything-and-resumes": [],
  "assistant-chats-expire": [],
  "auth-hygiene-keeps-sign-in-and-tokens-working": [],
  "password-accounts-admin-create-sign-in-and-reset": [],
  "push-log-retention-and-unreachable-git": [],
  // Browser asserts the completed issue's note, successful CI run and package 2.0.0.
  "browser-personas-persisted-product-state": [
    "tracker-claim-sync-complete-and-blocked-transitions",
    "ci-push-triggered-local-dag-and-provenance",
  ],
  "browser-atlas-smoke": [],
  "atlas-revocation-reads-like-a-missing-repository": [],
  "browser-timeline-scope-round-trip": [],
  "retention-concurrent-with-pushes-builds-and-chats": [],
  "source-authorization-native-and-canonical-separation": [],
  "source-multi-repository-landing-and-durable-recovery": [],
  "source-push-recovery-fences-late-writes": [],
  "source-late-sync-lineage-conflicts-guard-and-expiry": [],
  "source-finite-legacy-migration-and-partial-revert": [],
  "source-retention-expiry-orphan-and-canonical-purge": [],
  "browser-expired-source-without-timeline-history": [],
  // Chronicle seeds its own history but links to an existing pushed CI commit.
  "browser-chronicle-scrub-range-span-and-links": ["ci-push-triggered-local-dag-and-provenance"],
};

/**
 * Shared state scenarios read or write, for running them side by side
 * (GITMATRIX_E2E_WORKERS > 1): two scenarios that touch one resource, one of
 * them writing it, never overlap. `engine` is orbit/engine (its refs, timelines,
 * sources, CI and secrets) and clone's checkout; `space:*` a Space's repositories,
 * tracker, packages and Space-wide retention ("daysAhead" ages the whole Space);
 * `person:jun` jun's account (avatar, chats, personal retention); `gm-state` the
 * one gm configuration, tracker replicas and lease store every gm shares
 * (XDG_DATA_HOME), and with it the seed's tracker issues and marco's agents;
 * `ci-runner-hold` a CI runner slot held for a minute or more (written by the
 * scenarios that park a job on a barrier or a long sleep); `instance` everything
 * (a write means the scenario needs the environment alone).
 */
export const resources = [
  "engine",
  "space:orbit",
  "space:sam",
  "space:jun",
  "person:jun",
  "gm-state",
  "ci-runner-hold",
  "instance",
] as const;

export type Resource = (typeof resources)[number];
export type Access = "read" | "write";

// orbit/engine lives in orbit: whoever uses it reads that Space, so orbit-wide
// retention (a write) waits for them.
const engineRead = { engine: "read", "space:orbit": "read" } as const;
const engineWrite = { engine: "write", "space:orbit": "read" } as const;

/**
 * What each scenario touches, audited against e2e.ts and its helpers. Fresh
 * fixtures of its own (a timeline, a tracker team, an `orbit/queue-*` or Atlas
 * repository) count as reading their Space. When unsure, write: over-serializing
 * is safe. Every repository shares the environment's CI runner slots
 * (GITMATRIX_CI_RUNNERS: two, three from three workers). Short jobs just queue
 * for them; a scenario that holds one for a minute or more writes
 * `ci-runner-hold`, so at most one such hold runs at a time and the other slots
 * stay free for everyone else's pipelines.
 */
export const scenarioResources: Readonly<
  Record<ScenarioName, Readonly<Partial<Record<Resource, Access>>>>
> = {
  // Sets and deletes a CI secret on engine.
  "authorization-and-token-revocation": engineWrite,
  "gm-clone-commit-push-and-denied-push": engineWrite,
  "repository-file-history-and-attribution": engineRead,
  // Claims and completes the seed's ready issue; `tracker use` saves gm's selection.
  "tracker-claim-sync-complete-and-blocked-transitions": {
    "space:orbit": "read",
    "gm-state": "write",
  },
  "chronicle-history-and-linked-work-over-api": { "space:orbit": "read", "gm-state": "write" },
  // Asserts the fork is main's tip and main never moves: nobody may push it meanwhile.
  "timeline-fork-owned-source-and-abandon-permissions": engineWrite,
  "gm-timeline-start-push-and-abandon": engineWrite,
  // `agent configure` keeps a token in the shared gm.json, which gm rewrites in
  // place while every other gm reads it: alone. It also runs gm in clone's
  // checkout, claims the seed's blocker issue and creates marco's agents.
  "agent-capabilities-self-reporting-and-claim-identity": {
    ...engineWrite,
    "gm-state": "write",
    instance: "write",
  },
  // Issue commands write the shared replica and its outbox.
  "tags-one-vocabulary-and-old-spellings": { "space:orbit": "read", "gm-state": "write" },
  "tightening-requirements-on-a-claimed-issue": { "space:orbit": "read", "gm-state": "write" },
  // Edits the lease store's files directly.
  "agent-durable-interventions-and-resume": { "space:orbit": "read", "gm-state": "write" },
  "tracker-handoff-to-an-agent-created-after-sync": { "space:orbit": "read", "gm-state": "write" },
  // Grants the package to engine.
  "package-upload-download-and-write-boundary": engineWrite,
  "ci-push-triggered-local-dag-and-provenance": engineWrite,
  "ci-failing-prerequisite-skips-dependent": engineWrite,
  "ci-job-records-and-updates-a-deployment": engineWrite,
  // Parks a job on its collector for up to 60 s while the run is cancelled.
  "ci-cancellation-and-job-token-lifetime": { ...engineWrite, "ci-runner-hold": "write" },
  // Retention runs over orbit's CI logs and runs.
  "ci-retention-removes-logs-and-runs": { engine: "write", "space:orbit": "write" },
  // Tracker-activity retention on orbit, 179 days ahead.
  "timeline-compact-landing-gates-receipt-and-native-source": {
    engine: "write",
    "space:orbit": "write",
  },
  // `gm hook` reads held leases and records when it last checked in the lease store.
  "steps-context-hook-live-run-landing-and-access": { ...engineWrite, "gm-state": "write" },
  "timeline-landing-conflict-asks-for-a-sync": engineWrite,
  "timeline-nested-admission-and-canonical-revert": engineWrite,
  // Its own orbit repositories; claims a remediation issue. Its deletion phase
  // holds a landing gate in a 60 s sleep.
  "queue-concurrency-failure-fencing-and-push-recovery": {
    "space:orbit": "read",
    "gm-state": "write",
    "ci-runner-hold": "write",
  },
  // Counts marco's agents exactly; its own HOME and XDG_CONFIG_HOME, but the shared XDG_DATA_HOME.
  "agent-setup-memorable-persistent-identities": { "space:orbit": "read", "gm-state": "write" },
  // Claims the seed's blocker issue; `gm runs start` on engine's agent-ci-failure.
  "agent-identity-provisioned-on-first-use": { ...engineWrite, "gm-state": "write" },
  // jun's picture and orbit's Organization icon, which nothing else reads.
  "profile-picture-upload-serve-and-remove": { "person:jun": "write", "space:orbit": "read" },
  // Fresh instances of every class, purged.
  "durable-objects-register-and-purge": {},
  // Collects orbit's usage (lower bounds on what the earlier scenarios stored):
  // never beside push-log retention's collection in jun's Space.
  "usage-metering-collects-per-account": { ...engineRead, "space:jun": "read" },
  // Changes the Instance's AI settings.
  "ai-gateway-log-bodies-site-default-and-account-override": { instance: "write" },
  // Compares the Instance report's subjects with the page: no Space's usage may be collected meanwhile.
  "browser-usage-and-costs-account-and-site": {
    "space:orbit": "read",
    "space:sam": "read",
    "space:jun": "read",
  },
  // The retention cron and Instance retention, marco's chats and settings.
  "browser-data-retention-account-and-site": { instance: "write" },
  // Tracker retention on sam's Space, 400 days ahead; sam's replica.
  "tracker-retention-removes-closed-issues-and-replicas-converge": {
    "space:sam": "write",
    "gm-state": "write",
  },
  // Instance registry retention and garbage collection, 400 days ahead.
  "registry-retention-keeps-installs-working": { instance: "write" },
  // Its own orbit repository, preview and grant; its teardown job waits on a
  // barrier for up to ~170 s.
  "repository-deletion-purges-everything-and-resumes": {
    "space:orbit": "read",
    "ci-runner-hold": "write",
  },
  // jun's chats and personal retention, 100 days ahead.
  "assistant-chats-expire": { "person:jun": "write" },
  // Instance-wide auth hygiene; asserts nothing is left after its run.
  "auth-hygiene-keeps-sign-in-and-tokens-working": { instance: "write" },
  "password-accounts-admin-create-sign-in-and-reset": {},
  // Push log retention on jun's Space, 400 days ahead, and its usage collection.
  "push-log-retention-and-unreachable-git": { "space:jun": "write" },
  // Edits the seed's ready issue, which only its prerequisite also touches.
  "browser-personas-persisted-product-state": engineRead,
  "browser-atlas-smoke": { "space:orbit": "read" },
  "atlas-revocation-reads-like-a-missing-repository": { "space:orbit": "read" },
  // Asserts the new timeline's source is main's tip.
  "browser-timeline-scope-round-trip": engineWrite,
  // Retention on jun's Space and person, 400 days ahead, again and again.
  "retention-concurrent-with-pushes-builds-and-chats": {
    "space:jun": "write",
    "person:jun": "write",
  },
  // Repositories and timelines in sam's Space (and marco's).
  "source-authorization-native-and-canonical-separation": { "space:sam": "read" },
  "source-multi-repository-landing-and-durable-recovery": { "space:orbit": "read" },
  "source-push-recovery-fences-late-writes": { "space:orbit": "read" },
  "source-late-sync-lineage-conflicts-guard-and-expiry": { "space:orbit": "read" },
  "source-finite-legacy-migration-and-partial-revert": { "space:orbit": "read" },
  // Source retention on sam's Space and the Instance-wide orphan sweep. Also
  // holds a preview job on a barrier, which running alone already covers.
  "source-retention-expiry-orphan-and-canonical-purge": {
    instance: "write",
    "ci-runner-hold": "write",
  },
  // Tracker-activity retention on sam's Space, 181 days ahead.
  "browser-expired-source-without-timeline-history": { "space:sam": "write" },
  // Links a month of seeded orbit history to an engine CI run.
  "browser-chronicle-scrub-range-span-and-links": engineRead,
};

function conflicts(
  a: Readonly<Partial<Record<Resource, Access>>>,
  b: Readonly<Partial<Record<Resource, Access>>>,
): boolean {
  if (a.instance === "write" || b.instance === "write") return true;
  return resources.some(
    (name) => a[name] && b[name] && (a[name] === "write" || b[name] === "write"),
  );
}

export interface Schedule {
  /** The serialization order: suite order, independent Instance-wide scenarios last. */
  order: ScenarioName[];
  /** For each scenario, the earlier ones in `order` it must wait for. */
  waitsFor: Map<ScenarioName, Set<ScenarioName>>;
}

/**
 * Which selected scenarios each must wait for, so that any overlap is
 * conflict-serializable in suite order: every earlier one it conflicts with,
 * its prerequisites, and around an Instance-wide writer everything. Those
 * writers run last unless a selected scenario needs them.
 */
export function schedule(
  selected: readonly ScenarioName[],
  declared: Readonly<
    Record<ScenarioName, Readonly<Partial<Record<Resource, Access>>>>
  > = scenarioResources,
  needs: Readonly<Record<ScenarioName, readonly ScenarioName[]>> = prerequisites,
): Schedule {
  const inSuite = e2eScenarioNames.filter((name) => selected.includes(name));
  const needed = new Set(inSuite.flatMap((name) => needs[name]));
  const last = (name: ScenarioName) => declared[name].instance === "write" && !needed.has(name);
  const order = [...inSuite.filter((name) => !last(name)), ...inSuite.filter(last)];
  const waitsFor = new Map<ScenarioName, Set<ScenarioName>>();
  order.forEach((name, index) => {
    const before = order.slice(0, index);
    for (const dependency of needs[name])
      assert(before.includes(dependency), `${name} needs ${dependency} selected before it`);
    waitsFor.set(
      name,
      new Set(
        before.filter(
          (earlier) =>
            needs[name].includes(earlier) || conflicts(declared[earlier], declared[name]),
        ),
      ),
    );
  });
  return { order, waitsFor };
}

/** GITMATRIX_E2E_WORKERS: scenarios run at once (experimental; 1, the default, is the serial suite). */
export function e2eWorkers(env: NodeJS.ProcessEnv = process.env): number {
  const value = env.GITMATRIX_E2E_WORKERS?.trim() || "1";
  if (!/^[1-9]\d*$/.test(value))
    throw new Error(`GITMATRIX_E2E_WORKERS must be a positive integer, not ${value}`);
  return Number(value);
}

/**
 * The slowest journeys, whose domains other scenarios also cover: agents'
 * `vp run ready` never selects them. The complete suite (`vp run agent test`,
 * `vp run ready --all` and the main E2E watcher) still runs them. Neither is a
 * prerequisite of another scenario.
 */
export const mainOnlyScenarios: ReadonlySet<ScenarioName> = new Set<ScenarioName>([
  "source-multi-repository-landing-and-durable-recovery",
  "source-finite-legacy-migration-and-partial-revert",
]);

/**
 * Heavy journeys an agent runs only when its change reaches their own area
 * (a merge-queue change still runs the queue journey): a change that widens to
 * agents' full set leaves them to the main E2E watcher, which keeps a global
 * change's ready within about 15 minutes (CORE-406). Neither is a prerequisite.
 */
export const areaOnlyScenarios: ReadonlySet<ScenarioName> = new Set<ScenarioName>([
  "queue-concurrency-failure-fencing-and-push-recovery",
  "source-retention-expiry-orphan-and-canonical-purge",
  "timeline-nested-admission-and-canonical-revert",
  "source-push-recovery-fences-late-writes",
]);

/** Agents' full set: every scenario except the main-only and area-only ones. */
export const agentScenarioNames: readonly ScenarioName[] = e2eScenarioNames.filter(
  (name) => !mainOnlyScenarios.has(name) && !areaOnlyScenarios.has(name),
);

export const e2eAreas = [
  /** Tokens, sign-in, collaborator and repository authorization. */
  "auth",
  /** The scenario drives the real gm binary. */
  "gm",
  /** The two cheapest journeys: gm starts, pushes and reaches the tracker. */
  "gm-smoke",
  /** Smart HTTP, refs, objects, Artifacts and native Git access. */
  "git-transport",
  /** Repository API: detail, history, collaborators, creation and deletion. */
  "repos",
  /** `gm why` and its provenance chains. */
  "why",
  "tracker",
  /** Agent identities, capabilities, setup and interventions. */
  "agents",
  /** Timelines: forks, checkpoints, landing and its gates. */
  "timelines-landing",
  /** Owned work sources: lineage, recovery, authorization and retention. */
  "sources",
  "merge-queue",
  "ci",
  "deployments",
  "steps",
  /** The registry: uploads, installs and grants. */
  "packages",
  "retention",
  "usage",
  /** The Durable Object instance registry and its purges. */
  "durable",
  /** AI settings that need no model (gateway log bodies). */
  "settings",
  /** Profiles and avatars. */
  "accounts",
  /** Assistant chat lists and expiry (no model). */
  "assistant",
  "atlas",
] as const;

export type E2EArea = (typeof e2eAreas)[number];

/** What each scenario exercises; changed paths select areas (rules below). */
export const scenarioAreas: Readonly<Record<ScenarioName, readonly E2EArea[]>> = {
  "authorization-and-token-revocation": ["auth", "repos", "ci"],
  "gm-clone-commit-push-and-denied-push": ["gm", "gm-smoke", "git-transport", "auth"],
  "repository-file-history-and-attribution": ["repos", "git-transport"],
  "tracker-claim-sync-complete-and-blocked-transitions": ["gm", "gm-smoke", "tracker"],
  "chronicle-history-and-linked-work-over-api": ["gm", "tracker"],
  "timeline-fork-owned-source-and-abandon-permissions": ["timelines-landing", "sources"],
  "gm-timeline-start-push-and-abandon": ["gm", "timelines-landing", "sources", "git-transport"],
  "agent-capabilities-self-reporting-and-claim-identity": ["gm", "agents", "tracker"],
  "tags-one-vocabulary-and-old-spellings": ["gm", "tracker"],
  "tightening-requirements-on-a-claimed-issue": ["gm", "tracker", "agents"],
  "agent-durable-interventions-and-resume": ["gm", "agents", "tracker"],
  "tracker-handoff-to-an-agent-created-after-sync": ["gm", "tracker", "agents"],
  "package-upload-download-and-write-boundary": ["gm", "packages"],
  "ci-push-triggered-local-dag-and-provenance": ["gm", "ci", "packages"],
  "ci-failing-prerequisite-skips-dependent": ["gm", "ci"],
  "ci-job-records-and-updates-a-deployment": ["gm", "ci", "deployments"],
  "ci-cancellation-and-job-token-lifetime": ["gm", "ci", "packages"],
  "ci-retention-removes-logs-and-runs": ["gm", "ci", "retention"],
  "timeline-compact-landing-gates-receipt-and-native-source": [
    "gm",
    "timelines-landing",
    "sources",
    "ci",
    "deployments",
    "git-transport",
    "why",
  ],
  "steps-context-hook-live-run-landing-and-access": [
    "gm",
    "steps",
    "timelines-landing",
    "ci",
    "why",
  ],
  "timeline-landing-conflict-asks-for-a-sync": ["gm", "timelines-landing", "sources", "ci"],
  "timeline-nested-admission-and-canonical-revert": [
    "gm",
    "timelines-landing",
    "sources",
    "git-transport",
  ],
  "queue-concurrency-failure-fencing-and-push-recovery": [
    "gm",
    "merge-queue",
    "ci",
    "deployments",
    "steps",
    "git-transport",
  ],
  "agent-setup-memorable-persistent-identities": ["gm", "agents"],
  "agent-identity-provisioned-on-first-use": ["gm", "agents", "tracker", "ci"],
  "profile-picture-upload-serve-and-remove": ["accounts"],
  "durable-objects-register-and-purge": ["durable"],
  "usage-metering-collects-per-account": ["usage", "durable"],
  "ai-gateway-log-bodies-site-default-and-account-override": ["gm", "settings"],
  "browser-usage-and-costs-account-and-site": ["usage"],
  "browser-data-retention-account-and-site": ["gm", "retention", "usage", "assistant"],
  "tracker-retention-removes-closed-issues-and-replicas-converge": ["gm", "retention", "tracker"],
  "registry-retention-keeps-installs-working": ["gm", "retention", "packages"],
  "repository-deletion-purges-everything-and-resumes": [
    "gm",
    "repos",
    "retention",
    "ci",
    "deployments",
    "packages",
    "durable",
  ],
  "assistant-chats-expire": ["retention", "assistant", "durable"],
  "auth-hygiene-keeps-sign-in-and-tokens-working": ["gm", "auth", "retention"],
  "password-accounts-admin-create-sign-in-and-reset": ["gm", "auth"],
  "push-log-retention-and-unreachable-git": ["git-transport", "retention", "usage"],
  "browser-personas-persisted-product-state": ["tracker", "ci", "packages", "repos"],
  "browser-atlas-smoke": ["gm", "atlas"],
  "atlas-revocation-reads-like-a-missing-repository": ["gm", "atlas", "auth"],
  "browser-timeline-scope-round-trip": ["timelines-landing", "sources", "repos"],
  "retention-concurrent-with-pushes-builds-and-chats": [
    "git-transport",
    "retention",
    "ci",
    "assistant",
  ],
  "source-authorization-native-and-canonical-separation": [
    "gm",
    "sources",
    "auth",
    "git-transport",
  ],
  "source-multi-repository-landing-and-durable-recovery": [
    "gm",
    "sources",
    "timelines-landing",
    "ci",
  ],
  "source-push-recovery-fences-late-writes": ["gm", "sources", "git-transport"],
  "source-late-sync-lineage-conflicts-guard-and-expiry": ["gm", "sources", "timelines-landing"],
  "source-finite-legacy-migration-and-partial-revert": ["gm", "sources", "timelines-landing"],
  "source-retention-expiry-orphan-and-canonical-purge": ["gm", "sources", "retention"],
  "browser-expired-source-without-timeline-history": ["gm", "sources", "retention"],
  "browser-chronicle-scrub-range-span-and-links": ["tracker"],
};

/** The scenarios that open a browser (sharedBrowser in e2e.ts refuses any other). */
export const browserScenarios: readonly ScenarioName[] = [
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
];

// Audited route-module witnesses, not a dependency graph or a CSS ownership map.
// appRoutes mounts the Space/person/Instance exports from each module. Usage's
// journey covers settings navigation, denied access and Instance→Space; retention's
// journey also traverses UsageCosts before its settings link and category deep link.
// DataRetention's Space/person/Instance, denial and cleanup links are all in that journey.
// Only appRoutes imports these modules. Their shared imports (SettingsPage, ui,
// API/session, report/retention views), palette, router and assets stay broad.
const routeScenarios: Readonly<Record<string, readonly ScenarioName[]>> = {
  "apps/website/src/routes/UsageCosts.tsx": [
    "browser-usage-and-costs-account-and-site",
    "browser-data-retention-account-and-site",
  ],
  "apps/website/src/routes/DataRetention.tsx": ["browser-data-retention-account-and-site"],
  // Creates an account and sets a new password, then signs in with each.
  "apps/website/src/routes/Accounts.tsx": ["password-accounts-admin-create-sign-in-and-reset"],
};

/** A changed path's E2E consumers: areas, specific scenarios and the mirror stage. */
export interface E2ETarget {
  areas?: readonly E2EArea[];
  scenarios?: readonly ScenarioName[];
  mirror?: boolean;
}
/** Agents' full set: every scenario but the main-only ones, and the mirror. */
export const AGENTS_FULL = "agents-full";
const NONE: E2ETarget = {};

const gitTransport: E2ETarget = {
  areas: ["git-transport", "sources", "merge-queue", "timelines-landing"],
  mirror: true,
};
/**
 * Worker code no rule names (a new module, a shared helper): the core API
 * journeys, which are quick, rather than the slow landing, source and queue ones.
 */
const workerCore: E2ETarget = {
  areas: ["auth", "repos", "tracker", "agents", "packages", "gm-smoke"],
};

const W = "apps/website/worker/";
const SHARED = "apps/website/shared/";
const CLI = "apps/cli/";
const worker = (pattern: string) => new RegExp(`^${W}${pattern}`);
const shared = (pattern: string) => new RegExp(`^${SHARED}${pattern}`);
const cli = (pattern: string) => new RegExp(`^${CLI}${pattern}`);
const helper = (name: string) => new RegExp(`^tools/agent/${name}-e2e\\.ts$`);

/**
 * Path → consumers; the first match wins. The "everything runs on these" group,
 * the E2E harness and any path no rule names select agents' full set; an
 * unnamed Worker or shared module selects the core API journeys. Exempt
 * documentation and tests, and the browser source (apps/website/src|public),
 * are handled before these rules.
 */
const rules: readonly (readonly [RegExp, E2ETarget | typeof AGENTS_FULL])[] = [
  // Not the product the E2E runs, configuration included: the docs site, preview
  // and visuals tooling, agent instructions, this repository's pipeline settings,
  // design notes, and prose at the repository root or an app's root.
  [/^(?:apps\/site|tools\/(?:preview|visuals)|\.claude|\.agents|\.gitmatrix)\//, NONE],
  [/^(?:\.gitignore|\.worktreeinclude|LICENSE)$/, NONE],
  [/^(?:apps\/[^/]+\/)?[^/]+\.md$/, NONE],
  // gm's own manifests change only gm: every journey that runs it. Its assets
  // (instructions, skill and harness mod, configuration included) are what
  // `gm agent setup` writes.
  [/^apps\/cli\/(?:Cargo\.toml|Cargo\.lock|package\.json)$/, { areas: ["gm"] }],
  [/^apps\/cli\/assets\//, { areas: ["agents"] }],
  // Everything runs on these: the Worker entry, schema and auth, the development
  // API that serves the seed and most fixtures, migrations and seed data, build
  // and runtime configuration, dependencies, shared packages and request routing.
  [worker("(?:app|index|schema|db|auth)\\.ts$"), AGENTS_FULL],
  [worker("api/(?:dev|http)\\.ts$"), AGENTS_FULL],
  [/^apps\/website\/(?:migrations|seed|vite)\//, AGENTS_FULL],
  [shared("worker-first\\.ts$"), AGENTS_FULL],
  [
    /(?:^|\/)(?:cloudflare\.config\.ts|vite\.config\.ts|package\.json|tsconfig[\w.-]*\.json)$/,
    AGENTS_FULL,
  ],
  [/(?:^|\/)(?:pnpm-lock\.yaml|pnpm-workspace\.yaml|Cargo\.toml|Cargo\.lock)$/, AGENTS_FULL],
  // Shared test helpers never reach the running product (ready-plan builds nothing for them).
  [/^packages\/testing\//, NONE],
  [/^(?:patches|packages)\//, AGENTS_FULL],

  // AI-only Worker code: no non-AI journey reaches it (`vp run agent test-ai` does).
  [worker("(?:release-notes|knowledge|semantic|search|ai-providers)/"), NONE],
  [worker("api/dev-knowledge-fixtures\\.ts$"), NONE],
  [worker("atlas/"), { areas: ["atlas"] }],
  // Chat lists and expiry, avatars and gateway log settings need no model.
  [worker("(?:assistant/|api/assistant\\.ts$)"), { areas: ["assistant"] }],
  [worker("avatars/"), { areas: ["accounts"] }],
  [worker("(?:settings/|ai-gateway\\.ts$)"), { areas: ["settings"] }],

  [worker("timelines/"), { areas: ["timelines-landing", "sources"] }],
  [worker("tracker/"), { areas: ["tracker", "timelines-landing"] }],
  [worker("mentions/"), { areas: ["tracker"] }],
  [worker("merge-queue/"), { areas: ["merge-queue"] }],
  [worker("retention/work-sources\\.ts$"), { areas: ["retention", "sources"] }],
  [worker("retention/repo-"), { areas: ["retention", "repos"] }],
  [worker("retention/"), { areas: ["retention"] }],
  [worker("usage/"), { areas: ["usage"] }],
  [worker("ci/(?:landing|compact-script)\\.ts$"), { areas: ["ci", "timelines-landing"] }],
  [worker("ci/queue-"), { areas: ["ci", "merge-queue"] }],
  [worker("ci/source"), { areas: ["ci", "sources"] }],
  [worker("ci/registry\\.ts$"), { areas: ["ci", "packages"] }],
  [worker("ci/"), { areas: ["ci"] }],
  [worker("deployments/"), { areas: ["ci", "deployments"] }],
  [worker("steps/"), { areas: ["steps"] }],
  [worker("why/"), { areas: ["why"] }],
  [worker("(?:history/|compare\\.ts$)"), { areas: ["repos"] }],
  [worker("(?:git/|refs/|ref-log/|artifacts\\.ts$|objects\\.ts$)"), gitTransport],
  [worker("mirror/"), { mirror: true }],
  [worker("durable/"), { areas: ["durable"] }],
  [worker("testing/"), NONE],
  [worker("(?:agents|agent-presence)\\.ts$"), { areas: ["agents"] }],
  [worker("names\\.ts$"), { areas: ["accounts", "repos", "agents"] }],
  // One repository-access rule used by the tracker, CI, timelines, git and refs (CORE-406).
  [worker("permissions\\.ts$"), AGENTS_FULL],
  [worker("(?:better-auth|ssh|preview|preview-gate)\\.ts$"), { areas: ["auth"] }],
  [worker("api/repos\\.ts$"), { areas: ["repos", "sources"] }],
  [worker("api/(?:agents|personal-skills|environments)\\.ts$"), { areas: ["agents"] }],
  [worker("api/(?:tokens|invites|ssh|admin-accounts)\\.ts$"), { areas: ["auth"] }],
  [worker("api/accounts\\.ts$"), { areas: ["accounts", "auth"] }],
  [worker("api/bytes\\.ts$"), { areas: ["accounts", "steps"] }],
  // Fixture endpoints of particular journeys (landing and legacy sources are main-only).
  [
    worker("api/dev-source-auth\\.ts$"),
    { scenarios: ["source-authorization-native-and-canonical-separation"] },
  ],
  [
    worker("api/dev-source-retention\\.ts$"),
    {
      scenarios: [
        "source-retention-expiry-orphan-and-canonical-purge",
        "browser-expired-source-without-timeline-history",
      ],
    },
  ],
  [
    worker("api/dev-source-push-fixtures\\.ts$"),
    { scenarios: ["source-push-recovery-fences-late-writes"] },
  ],
  [
    worker("api/dev-landing-fixtures\\.ts$"),
    { scenarios: ["source-multi-repository-landing-and-durable-recovery"] },
  ],
  [
    worker("api/dev-source-fixtures\\.ts$"),
    { scenarios: ["source-finite-legacy-migration-and-partial-revert"] },
  ],
  [worker(""), workerCore],

  // Types and pure helpers the Worker and the browser share, by domain.
  [shared("tracker\\.ts$"), { areas: ["tracker", "timelines-landing"] }],
  [shared("(?:tracker-query|requirements|chronicle)\\.ts$"), { areas: ["tracker"] }],
  [
    shared("(?:timelines|timeline-graph|landings|code-source)\\.ts$"),
    { areas: ["timelines-landing", "sources"] },
  ],
  [shared("usage\\.ts$"), { areas: ["usage"] }],
  [shared("retention\\.ts$"), { areas: ["retention"] }],
  [shared("(?:packages|packageContents)\\.ts$"), { areas: ["packages"] }],
  [shared("deployments\\.ts$"), { areas: ["ci", "deployments"] }],
  [shared("steps\\.ts$"), { areas: ["steps"] }],
  [shared("why\\.ts$"), { areas: ["why"] }],
  [shared("merge-queue\\.ts$"), { areas: ["merge-queue"] }],
  [shared("(?:atlas|atlasFixture)\\.ts$"), { areas: ["atlas"] }],
  [shared("agent-presence\\.ts$"), { areas: ["agents"] }],
  [shared("refs\\.ts$"), { areas: ["git-transport"] }],
  [shared("diff\\.ts$"), { areas: ["repos"] }],
  [shared("ai\\.ts$"), { areas: ["settings"] }],
  [shared("assistant(?:-skills)?\\.ts$"), { areas: ["assistant"] }],
  [shared("(?:(?:release-notes|search)\\.ts$|semantic/)"), NONE],
  [shared(""), workerCore],

  [/^apps\/website\/registry\//, { areas: ["packages"] }],
  [/^apps\/website\/index\.html$/, { scenarios: browserScenarios }],
  // The production CI sandbox image and developer scripts never run in local E2E
  // (sandbox changes need their deployment-boundary check instead).
  [/^apps\/website\/(?:ci|scripts)\//, NONE],

  // gm by command module. Modules every command shares select every gm journey.
  [cli("src/commands/(?:ask|semantic|release)\\.rs$"), NONE],
  // These run for every command (agent detection, profile and timeline binding, git
  // credentials and the current repository), so they select every gm journey (CORE-406).
  [cli("src/(?:agent|profile)\\.rs$"), { areas: ["gm"] }],
  [cli("src/commands/server\\.rs$"), { areas: ["gm"] }],
  [cli("src/agent/"), { areas: ["agents"] }],
  [cli("src/commands/(?:agent_setup|agents|claude_mod)\\.rs$"), { areas: ["agents"] }],
  [
    cli("src/(?:tracker_cli\\.rs|commands/(?:tracker|lease_updates|requirements)\\.rs)$"),
    { areas: ["tracker"] },
  ],
  [cli("src/commands/timeline\\.rs$"), { areas: ["timelines-landing", "sources"] }],
  [cli("src/commands/ci\\.rs$"), { areas: ["ci"] }],
  [cli("src/commands/deploy\\.rs$"), { areas: ["ci", "deployments"] }],
  [cli("src/commands/(?:steps|hooks|test)\\.rs$"), { areas: ["steps"] }],
  [cli("src/commands/pkg\\.rs$"), { areas: ["packages"] }],
  [cli("src/commands/queue\\.rs$"), { areas: ["merge-queue"] }],
  [cli("src/commands/retention\\.rs$"), { areas: ["retention"] }],
  [cli("src/commands/settings\\.rs$"), { areas: ["settings"] }],
  [cli("src/commands/why\\.rs$"), { areas: ["why"] }],
  // Help text and search manifest, the text-only log graph and worktrees: no
  // journey reads them beyond gm starting at all.
  [
    cli("src/(?:meta\\.rs|graph\\.rs|commands/worktree(?:_include)?\\.rs)$"),
    { areas: ["gm-smoke"] },
  ],
  [cli(""), { areas: ["gm"] }],

  // Scenario helpers run only in the journeys that import them.
  [helper("atlas"), { areas: ["atlas"] }],
  [helper("chronicle"), { scenarios: ["browser-chronicle-scrub-range-span-and-links"] }],
  [
    helper("queue"),
    {
      scenarios: [
        "queue-concurrency-failure-fencing-and-push-recovery",
        "source-multi-repository-landing-and-durable-recovery",
        "source-push-recovery-fences-late-writes",
        "source-late-sync-lineage-conflicts-guard-and-expiry",
        "source-finite-legacy-migration-and-partial-revert",
      ],
    },
  ],
  [helper("source-auth"), { scenarios: ["source-authorization-native-and-canonical-separation"] }],
  [
    helper("source-landing"),
    { scenarios: ["source-multi-repository-landing-and-durable-recovery"] },
  ],
  [helper("source-push-recovery"), { scenarios: ["source-push-recovery-fences-late-writes"] }],
  [helper("source-sync"), { scenarios: ["source-late-sync-lineage-conflicts-guard-and-expiry"] }],
  [
    helper("source-migration"),
    { scenarios: ["source-finite-legacy-migration-and-partial-revert"] },
  ],
  [
    helper("source-retention"),
    {
      scenarios: [
        "source-retention-expiry-orphan-and-canonical-purge",
        "browser-expired-source-without-timeline-history",
      ],
    },
  ],
  [helper("source-expired"), { scenarios: ["browser-expired-source-without-timeline-history"] }],
  // The mirror stage, beside the scenarios.
  [/^tools\/agent\/provider-e2e\.ts$/, { mirror: true }],
  // The harness a local non-AI run executes: provisioning, limits and cleanup,
  // seeding, the scenarios and their selection.
  [
    /^tools\/agent\/(?:main|entry|environment|cloudflare-delete|heavy|quota|reservations|types|seed|e2e|ready-plan|ready-e2e)\.ts$/,
    AGENTS_FULL,
  ],
  // Harness no local non-AI run executes: AI stages (`vp run agent test-ai`),
  // cloud execution, deploys, publishing, CI build planning, maintenance, the
  // main E2E watcher, browser pruning and tooling. Their unit tests and types
  // run in the full code gates every tools/agent change selects.
  [
    /^tools\/agent\/(?:ai-stages|atlas-provider-e2e|queue-ai-e2e|index-visibility|search-item-status|usage-reconciliation|model-failure-evidence|remote[\w-]*|deploy|publish-cli|ci-build|ci-image|maintenance|main-e2e|browsers|website-tests|typecheck|visuals|ready-e2e-replay)\.ts$/,
    NONE,
  ],
  // Any other harness file, and the remote execution backend, can affect any journey.
  [/^tools\/(?:agent|remote)\//, AGENTS_FULL],
];

function exempt(path: string): boolean {
  return (
    /^(?:(?:apps\/(?:cli|website)|tools\/(?:agent|preview)|packages\/(?:formats|testing|utils))\/)?(?:README|CHANGELOG|CONTRIBUTING|AGENTS)\.md$/.test(
      path,
    ) ||
    /^(?:apps\/(?:cli|website|site)|tools\/(?:agent|preview|remote)|packages\/(?:formats|testing|utils))\/.*\.(test|spec)\.[cm]?[jt]sx?$/.test(
      path,
    ) ||
    /^apps\/cli\/tests\/.*\.rs$/.test(path)
  );
}

/** Whether a changed path's target selects the mirror stage: git transport or agents' full set. */
export function selectsMirror(target: E2ETarget | typeof AGENTS_FULL): boolean {
  return target === AGENTS_FULL || !!target.mirror || !!target.areas?.includes("git-transport");
}

/** A changed path's E2E consumers, or AGENTS_FULL when it can affect any journey. */
export function e2eTarget(path: string): E2ETarget | typeof AGENTS_FULL {
  if (exempt(path)) return NONE;
  if (/^apps\/website\/(src|public)\//.test(path))
    return { scenarios: routeScenarios[path] ?? browserScenarios };
  for (const [pattern, target] of rules) if (pattern.test(path)) return target;
  return AGENTS_FULL;
}

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
    for (const dependency of prerequisites[name]) include(dependency);
  }
  for (const name of selected) include(name as ScenarioName);
  return e2eScenarioNames.filter((name) => included.has(name));
}

/** The scenarios tagged with an area, in suite order. */
export function areaScenarios(area: E2EArea): ScenarioName[] {
  return e2eScenarioNames.filter((name) => scenarioAreas[name].includes(area));
}

/**
 * Pure path selection for agents' `vp run ready`: each changed path selects its
 * areas' journeys and their prerequisites; main-only journeys are left to the
 * complete suite on main. `full` (explicit `--all`, or no reliable change list)
 * runs everything, main-only journeys included.
 */
export function selectReadyE2E(changed: readonly string[], full: boolean): ReadyE2ESelection {
  if (full) return { scenarios: null, mirror: true };
  const selected = new Set<ScenarioName>();
  let mirror = false;
  let agentsFull = false;
  for (const path of changed) {
    const target = e2eTarget(path);
    if (selectsMirror(target)) mirror = true;
    if (target === AGENTS_FULL) {
      agentsFull = true;
      continue;
    }
    for (const area of target.areas ?? [])
      for (const name of areaScenarios(area)) selected.add(name);
    for (const name of target.scenarios ?? []) selected.add(name);
  }
  // A path that can affect any journey adds the agents' full set to what the others select.
  if (agentsFull) for (const name of agentScenarioNames) selected.add(name);
  return {
    scenarios: expandE2EScenarios([...selected]).filter((name) => !mainOnlyScenarios.has(name)),
    mirror,
  };
}

/** Whether a selection runs anything: an empty one provisions no environment. */
export function selectsE2E(selection: ReadyE2ESelection): boolean {
  return selection.scenarios === null || selection.scenarios.length > 0 || selection.mirror;
}
