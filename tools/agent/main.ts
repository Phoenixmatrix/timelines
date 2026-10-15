import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, createWriteStream, openSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import {
  aiEnabled,
  cleanupExpired,
  command,
  context,
  createEnvironment,
  destroyEnvironment,
  destroyExclusively,
  listEnvironments,
  loadEnvironment,
  markDeleting,
  markServer,
  privateJson,
  redact,
  registry,
  registryLock,
  stopEnvironment,
  terminateProcessGroup,
  unitTestEnvironment,
  validateEnvironment,
} from "./environment.ts";
import type { Environment } from "./environment.ts";
import type { HarnessContext } from "./types.ts";
import { installMaintenance, maintenanceStatus, uninstallMaintenance } from "./maintenance.ts";
import { installMainE2E, mainE2EStatus, tick, uninstallMainE2E } from "./main-e2e.ts";
import { parseReservationArgs, reconcileReservations } from "./reservations.ts";
import { pruneBrowsers } from "./browsers.ts";
import { seed } from "./seed.ts";
import {
  backgroundCleanupSpawn,
  cleanupMode,
  gatesWriteBindingTypes,
  overlapSetup,
  seedMayBeAffected,
  type CleanupMode,
} from "./live-run.ts";
import { runE2E } from "./e2e.ts";
import { runProviderE2E, type AiRun } from "./provider-e2e.ts";
import { ATLAS_PROVIDER_CONFIG } from "./atlas-provider-e2e.ts";
import {
  localGates,
  localReasons,
  parseReadyOptions,
  readinessPlan,
  type ReadyOptions,
} from "./ready-plan.ts";
import {
  e2eScenarioNames,
  selectReadyE2E,
  selectsE2E,
  type ReadyE2ESelection,
} from "./ready-e2e.ts";
import {
  contentHashes,
  gateFingerprint,
  readHistory as readReadyHistory,
  recordAttempts,
  resumeDecision,
  scenarioFingerprints,
  mirrorFingerprint,
  mirrorOutcome,
  scenarioOutcomes,
  writeHistory,
  type Attempt,
  type ResumeDecision,
} from "./ready-history.ts";
import {
  AI_STAGES,
  appendHistory,
  changedPaths,
  fingerprints,
  parseSetupOptions,
  parseTestAiOptions,
  readHistory,
  refusal,
  reusableStages,
  selectStages,
  snapshotInputs,
  type Reason,
  type Selection,
  type TestAiOptions,
} from "./ai-stages.ts";

const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const args = process.argv.slice(2);
const operation = args.shift() ?? "help";
const website = join(root, "apps", "website");
const help = `Gitmatrix agent workflow (Linux, Node 24+, cf login, Rust, Vite+)
  vp run agent setup [--ai]       Build gm, install Chromium's headless shell, provision/migrate/seed isolated dev environment.
                                  No paid AI unless --ai (knowledge, wiki, embeddings, AI Search, assistant,
                                  release notes, avatars, Atlas descriptions); --ai needs a fresh environment
  vp run agent up [--sandbox]     Run the scoped app and CI dispatcher in the foreground; --sandbox exercises
                                  local Docker CI instead of host runners
  vp run agent status             List owned environments (no secrets)
  vp run agent seed               Reconcile deterministic fixtures against the live environment
  vp run agent gm -- <args>       Use this worktree's binary, server, credentials and replica
  vp run agent exec -- <command>  Run another tool with isolated Git/XDG/GM settings
  vp run agent inspect [db|registry] [SQL]  Read local data; defaults to table inventory
  vp run agent check [--all] [--resume] [--dry-run] [--base <ref>] [--foreground-cleanup]
                                  Change-aware uncached readiness (also vp run ready): E2E journeys of the
                                  changed areas; --all runs every gate and every non-AI E2E journey,
                                  --resume reuses this worktree's passed gates and journeys whose inputs
                                  are unchanged (in a fresh environment), --dry-run explains selection
                                  without running or provisioning;
                                  the E2E environment is destroyed in a detached process after the
                                  result unless --foreground-cleanup
  vp run agent test               Fresh non-AI E2E; no AI resources or inference
  vp run agent test-ai [--stage <id>[,<id>]] [--all] [--resume] [--force] [--dry-run] [--base <ref>]
                                  Paid real-provider verification of the stages your changes (against
                                  origin/main) map to; --dry-run shows the selection. Stages:
                                  ${AI_STAGES.map((stage) => stage.id).join(", ")}
  vp run agent stop               Stop only the owned dev server and its runners
  vp run agent reset [--ai]       Destroy/recreate this environment; never touch canonical dev state
  vp run agent destroy            Delete owned remote resources and local credentials/state
  vp run agent cleanup --expired  Sweep all expired owned environments, including removed worktrees
  vp run agent maintenance install|status|uninstall
  vp run agent maintenance reservations [--release [--expired]]
                                  List your installation reservations against this machine's journals
                                  (live, released-locally, own-orphan, expired-foreign, foreign); --release
                                  frees only released-locally and own-orphan rows, as the hourly sweep does.
                                  --expired also frees expired-foreign rows: no journal here and more
                                  than a day past their expiry. Never in sweeps; live rows are never freed
  vp run agent main-e2e install|status|uninstall
                                  Trusted host only: a systemd timer runs the complete non-AI E2E suite on each
                                  new origin/main commit in its own checkout and files failures as P0 issues
  vp run agent prune-browsers [--dry-run] [--include-other-installs]
                                  Delete Playwright browser revisions no worktree or other live install uses
24-hour hard lifetime; default limits: four installation-wide and four local per OS user/machine.
Configure the shared quota authority before setup. Setup installs hourly user-systemd cleanup.
Canonical source publication uses ordinary gm outside 'agent gm'. Never point test commands at port 5180.
`;

async function prepare({
  skipTypes = false,
  overlapped = false,
  signal,
}: { skipTypes?: boolean; overlapped?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  await installMaintenance();
  console.log(JSON.stringify({ event: "prepare", step: "gm-build" }));
  const target = process.env.CARGO_TARGET_DIR
    ? resolve(root, process.env.CARGO_TARGET_DIR)
    : join(root, "apps/cli/target");
  await command(
    "cargo",
    ["build", "--manifest-path", join(root, "apps/cli/Cargo.toml"), "--target-dir", target],
    {
      cwd: root,
      // Beside the gates, cli-check (clippy) contends for the target-dir lock: wait as long as a gate may.
      timeout: overlapped ? 1_800_000 : 900_000,
      log: join(root, ".gitmatrix-agent", "artifacts", "cargo-build.log"),
      signal,
    },
  );
  const scopedTarget = join(root, "apps/cli/target");
  if (target !== scopedTarget) {
    await mkdir(join(scopedTarget, "debug"), { recursive: true });
    const temporary = join(scopedTarget, "debug", `.gm-${process.pid}-${Date.now()}`);
    try {
      await copyFile(join(target, "debug", "gm"), temporary);
      await rename(temporary, join(scopedTarget, "debug", "gm"));
    } finally {
      await rm(temporary, { force: true });
    }
  }
  // A gate of the same run (website-types, bindings) regenerates .cloudflare/types; two writers race.
  if (!skipTypes) await command("cf", ["workers", "types"], { cwd: website, signal });
  // Every scenario launches headless, which Playwright serves from the headless
  // shell; full Chromium (~400 MB a revision) is only for headed or channel launches.
  await command("vp", ["exec", "playwright", "install", "--only-shell", "chromium"], {
    cwd: join(root, "tools/agent"),
    timeout: 300_000,
    signal,
  });
  signal?.throwIfAborted();
  // Fail before provisioning if the shell or its system dependencies are unavailable,
  // exercising the emulation the browser scenarios rely on.
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      isMobile: true,
      hasTouch: true,
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.setContent("<button>ok</button>");
    await page.getByRole("button").tap();
    const media = await page.evaluate(() => [
      matchMedia("(prefers-reduced-motion: reduce)").matches,
      matchMedia("(pointer: coarse)").matches,
    ]);
    if (!media.every(Boolean)) throw new Error("Headless shell ignored touch/motion emulation.");
    await page.screenshot();
  } finally {
    await browser.close();
  }
}

async function migrate(env: Environment, signal?: AbortSignal): Promise<void> {
  for (const [id, directory] of [
    ["00000000000000000000000000000000", "migrations"],
    ["00000000000000000000000000000001", "registry/migrations"],
  ])
    await command(
      "cf",
      [
        "d1",
        "migrations",
        "apply",
        id!,
        "--local",
        "--persist-to",
        join(env.dir, "state"),
        "--dir",
        directory!,
      ],
      { cwd: website, signal },
    );
}

async function seedDatabase(env: Environment, signal?: AbortSignal): Promise<void> {
  // The authenticated readiness request completes real canonical-v4 bootstrap.
  // Never apply persona SQL to a legacy or not-yet-initialized installation.
  if (!(await identity(env)))
    throw new Error(
      "Database seed requires the owned server with canonical-v4 readiness. Start it after ordinary migrations; legacy data requires a reviewed migration or an explicit reset.",
    );
  // Development data (personas, Orbit Labs) lives in seed/, applied like
  // migrations but only here and in local dev, so a deployed database starts empty.
  await command(
    "cf",
    [
      "d1",
      "migrations",
      "apply",
      "00000000000000000000000000000000",
      "--local",
      "--persist-to",
      join(env.dir, "state"),
      "--dir",
      "seed",
    ],
    { cwd: website, signal },
  );
}

async function identity(env: Environment): Promise<boolean> {
  try {
    const response = await fetch(`${env.origin}/api/dev/environment`, {
      headers: { Authorization: `Bearer ${env.secret}` },
      signal: AbortSignal.timeout(2000),
      redirect: "error",
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { id: string; ready: boolean };
    return body.id === env.id && body.ready;
  } catch {
    return false;
  }
}

async function start(
  env: Environment,
  ctx: HarnessContext,
  lifecycle?: { assertRunning(): void; spawned(child: ChildProcess): void },
): Promise<{ owned: boolean; exited: Promise<number | null> }> {
  if (await identity(env)) return { owned: false, exited: Promise.resolve(0) };
  if (env.server)
    throw new Error(
      "An owned server record exists but readiness failed; run stop before restarting.",
    );
  await mkdir(ctx.artifacts, { recursive: true, mode: 0o700 });
  const log = createWriteStream(join(ctx.artifacts, "server.log"), { flags: "a", mode: 0o600 });
  const serverEnv: NodeJS.ProcessEnv = { ...ctx.env, HOME: process.env.HOME };
  for (const [xdg, runner] of [
    ["XDG_CONFIG_HOME", "GITMATRIX_RUNNER_CONFIG_HOME"],
    ["XDG_CACHE_HOME", "GITMATRIX_RUNNER_CACHE_HOME"],
    ["XDG_DATA_HOME", "GITMATRIX_RUNNER_DATA_HOME"],
  ]) {
    serverEnv[runner!] = ctx.env[xdg!];
    if (process.env[xdg!] === undefined) delete serverEnv[xdg!];
    else serverEnv[xdg!] = process.env[xdg!];
  }
  lifecycle?.assertRunning();
  const child = spawn("vp", ["dev"], {
    cwd: website,
    env: serverEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  lifecycle?.spawned(child);
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.stdout.on("data", (data: Buffer) => log.write(redact(data.toString())));
  child.stderr.on("data", (data: Buffer) => log.write(redact(data.toString())));
  const exited = new Promise<number | null>((accept) =>
    child.once("close", (code) => {
      log.end();
      accept(code);
    }),
  );
  if (!child.pid) throw new Error("Failed to spawn Vite.");
  await markServer(env, child.pid);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    lifecycle?.assertRunning();
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Vite exited before readiness. See ${ctx.artifacts}/server.log`);
    if (await identity(env)) {
      console.log(
        JSON.stringify({
          event: "server.ready",
          id: env.id,
          origin: env.origin,
          ai: aiEnabled(env),
          log: join(ctx.artifacts, "server.log"),
          ...(ctx.env.GITMATRIX_REMOTE_ORIGIN
            ? {
                publicOrigin: ctx.env.GITMATRIX_REMOTE_ORIGIN,
                inspector: `${ctx.env.GITMATRIX_REMOTE_ORIGIN}/__remote/ports/9229/json`,
                sourceRoot: root,
              }
            : {}),
        }),
      );
      return { owned: true, exited };
    }
    await delay(250);
  }
  throw new Error(
    `Server identity/canonical-v4 readiness timed out. Existing legacy data requires a reviewed migration or an explicit reset. See ${ctx.artifacts}/server.log`,
  );
}

interface EnvironmentSupervisor {
  assertRunning(): void;
  close(): Promise<void>;
}

/** Stops the owned server on SIGINT, SIGTERM, expiry or an abort of `signal`. */
function superviseEnvironment(
  env: Environment,
  stopOwned: () => Promise<void> = () => stopEnvironment(env),
  signal?: AbortSignal,
): EnvironmentSupervisor {
  let interrupted = false;
  let stopping: Promise<void> | undefined;
  let stopFailure: unknown;
  const stop = () => {
    interrupted = true;
    stopping ??= stopOwned().catch((error: unknown) => {
      stopFailure = error;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  const expiry = setTimeout(stop, Math.max(1, env.expires - Date.now()));
  return {
    assertRunning() {
      if (interrupted) throw new Error("Environment interrupted or expired.");
    },
    async close() {
      clearTimeout(expiry);
      await stopping;
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      signal?.removeEventListener("abort", stop);
      if (stopFailure) throw stopFailure;
    },
  };
}

const AI_OFF =
  "AI is off: no Workers AI, AI Gateway, Vectorize or AI Search, so Knowledge builds, wiki, " +
  "search, the assistant, release notes, avatars and Atlas descriptions show their AI-off states " +
  "and spend nothing. Only for changes to those: vp run agent destroy, then vp run agent setup --ai.";

async function setup(options: { ai: boolean }): Promise<void> {
  await prepare();
  const env = await createEnvironment(root, false, options.ai);
  const ctx = await context(env);
  const supervisor = superviseEnvironment(env);
  let owned = true;
  try {
    await migrate(env);
    owned = (await start(env, ctx)).owned;
    supervisor.assertRunning();
    await seedDatabase(env);
    supervisor.assertRunning();
    await seed(ctx);
    supervisor.assertRunning();
    console.log(
      JSON.stringify({
        event: "environment.seeded",
        id: env.id,
        origin: env.origin,
        ai: aiEnabled(env),
        ...(aiEnabled(env) ? {} : { note: AI_OFF }),
        next: "vp run agent up",
      }),
    );
  } finally {
    await supervisor.close();
    if (owned) await stopEnvironment(env);
  }
}

/** One line per stage: why it runs (changed paths, a flag, or a stage that needs it). */
function describeReasons(reasons: Reason[]): string {
  return reasons
    .map((reason) =>
      reason.kind === "changed"
        ? `changed: ${reason.paths.slice(0, 3).join(", ")}${reason.paths.length > 3 ? ` (+${reason.paths.length - 3} more)` : ""}`
        : reason.kind === "required"
          ? `required by ${reason.by.join(", ")}`
          : reason.kind === "all"
            ? "--all"
            : "--stage",
    )
    .join("; ");
}

/** The test-ai stages to run, or null when there is nothing to run (or a dry run). */
async function selectAiStages(options: TestAiOptions): Promise<Selection | null> {
  const { base, changed, prints, sourceSnapshot } = await changedPaths(root, options.base)
    .then(async ({ base, changed }) => ({
      base,
      changed,
      prints: await fingerprints(root, base, changed),
      sourceSnapshot: undefined as string | undefined,
    }))
    .catch(async (error: unknown) => {
      const credentials = process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE;
      if (process.env.GITMATRIX_REMOTE_HOSTED !== "1" || !credentials) throw error;
      // The runtime keeps the committed manifest beside credentials, outside
      // synchronized source. Read the manifest only, never the credentials.
      return snapshotInputs(root, join(dirname(credentials), "manifest.json"));
    });
  const history = await readHistory(root);
  const selection = selectStages({
    changed,
    requested: options.stages,
    all: options.all || sourceSnapshot !== undefined,
    reusable: options.resume ? reusableStages(history, base, prints) : undefined,
    base,
    fingerprints: prints,
  });
  if (sourceSnapshot) selection.sourceSnapshot = sourceSnapshot;
  console.log(
    JSON.stringify(
      {
        event: "test-ai.selection",
        base,
        sourceSnapshot,
        changed: changed.length,
        stages: Object.fromEntries(
          selection.stages.map((id) => [id, describeReasons(selection.reasons[id]!)]),
        ),
        skipped: selection.skipped,
      },
      null,
      2,
    ),
  );
  if (options.dryRun) return null;
  if (!selection.stages.length) {
    console.log(
      JSON.stringify({
        event: "test-ai.nothing-to-run",
        reason: options.resume
          ? "Every selected stage has unchanged successful evidence."
          : "No changed path maps to an AI stage; nothing is provisioned or spent.",
        next: "Name stages with --stage <id> or use --all when a change needs them anyway.",
      }),
    );
    return null;
  }
  const refused = options.force ? null : refusal(history, selection);
  if (refused) throw new Error(refused);
  return selection;
}

interface LiveOptions {
  ai: boolean;
  run?: AiRun;
  readyE2E?: ReadyE2ESelection;
  /** Skip `cf workers types`: a gate of the same run regenerates `.cloudflare/types`. */
  skipTypes?: boolean;
  /** Setup runs beside the gates, so the cargo build may wait on a target-dir lock. */
  overlapped?: boolean;
  /** Run the seed's idempotency check (always, unless every changed path cannot reach the seed). */
  repeatSeed: boolean;
  cleanup: CleanupMode;
  /** The setup is a repeat after the environment quota refused the overlapped one. */
  quotaFallback?: boolean;
  /** Aborted when a gate fails during an overlapped setup: kills the step in flight. */
  signal?: AbortSignal;
}

interface LiveState extends LiveOptions {
  started: number;
  executionStarted: number;
  artifacts: string;
  timings: { stage: string; elapsedMs: number; outcome: string }[];
  timed: <T>(stage: string, action: () => Promise<T>) => Promise<T>;
  env?: Environment;
  ctx?: HarnessContext;
  fixtures?: Awaited<ReturnType<typeof seed>>;
  supervisor?: EnvironmentSupervisor;
  /** Everything that went wrong so far, in order. */
  failures: unknown[];
  /** The error that ended setup (prepare through seed), if any; also the first of `failures`. */
  setupFailure?: unknown;
  /** Set once a detached cleanup process owns the environment's deletion. */
  cleanupLog?: string;
}

async function liveTest(
  ai = false,
  options?: TestAiOptions,
  readyE2E?: ReadyE2ESelection,
): Promise<void> {
  let run: AiRun | undefined;
  if (ai) {
    const selection = await selectAiStages(options ?? parseTestAiOptions([]));
    if (!selection) return;
    run = { selection, outcomes: {} };
  }
  // test, test-ai and the main watcher: sequential, always repeat the seed, wait for cleanup.
  await finishLive(
    await startLive({
      ai,
      ...(run ? { run } : {}),
      ...(readyE2E ? { readyE2E } : {}),
      repeatSeed: true,
      cleanup: "foreground",
    }),
  );
}

/**
 * Prepare, provision, migrate, start and seed. Never rejects: a failure is kept for finishLive.
 * An abort of `options.signal` kills the step in flight and ends the setup with its reason.
 */
async function startLive(options: LiveOptions): Promise<LiveState> {
  const { ai, signal } = options;
  const started = Date.now();
  const timings: LiveState["timings"] = [];
  const state: LiveState = {
    ...options,
    started,
    executionStarted: performance.now(),
    artifacts: join(
      root,
      ".gitmatrix-agent",
      "artifacts",
      `test-${ai ? "ai" : "non-ai"}-${started}`,
    ),
    timings,
    timed: async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
      const began = performance.now();
      let outcome = "failed";
      try {
        const result = await action();
        outcome = "passed";
        return result;
      } finally {
        timings.push({ stage, elapsedMs: Math.round(performance.now() - began), outcome });
      }
    },
    failures: [],
  };
  const { timed } = state;
  try {
    await timed("prepare", () =>
      prepare({ skipTypes: options.skipTypes, overlapped: options.overlapped, signal }),
    );
    signal?.throwIfAborted();
    // Not interruptible: a failed provisioning destroys what it made in the foreground, and the
    // remote calls take seconds. Whatever it made is torn down with the rest after an abort.
    const env = (state.env = await timed("provision", () => createEnvironment(root, true, ai)));
    signal?.throwIfAborted();
    const ctx = (state.ctx = await context(env));
    // Atlas settings per owning account: the degraded providers test-ai verifies.
    if (ai) ctx.env.GITMATRIX_ATLAS_CONFIG = JSON.stringify(ATLAS_PROVIDER_CONFIG);
    state.artifacts = ctx.artifacts;
    // An abort stops the server too, so the readiness wait and the seed's requests end at once.
    const supervisor = (state.supervisor = superviseEnvironment(env, undefined, signal));
    await timed("migrate", () => migrate(env, signal));
    supervisor.assertRunning();
    await timed("start", () =>
      start(env, ctx, { assertRunning: () => supervisor.assertRunning(), spawned: () => {} }),
    );
    supervisor.assertRunning();
    state.fixtures = await timed("seed", async () => {
      await seedDatabase(env, signal);
      supervisor.assertRunning();
      const fixtures = await seed(ctx);
      // Bootstrap remains repeatable against real data. The second run only guards the
      // seed's own idempotency, so ready skips it when no changed path can reach the seed.
      if (!ai && options.repeatSeed) {
        supervisor.assertRunning();
        await seed(ctx);
      }
      return fixtures;
    });
  } catch (error) {
    // After an abort, whatever failed did so because of it: report the abort.
    const failure = signal?.aborted ? signal.reason : error;
    state.setupFailure = failure;
    state.failures.push(failure);
  }
  return state;
}

/** Stops the server and destroys the environment, in the foreground, collecting failures. */
async function teardownLive(state: LiveState, mode: CleanupMode): Promise<void> {
  const { env, timed, failures } = state;
  try {
    await timed("shutdown", async () => {
      try {
        await state.supervisor?.close();
      } finally {
        if (env) await stopEnvironment(env);
      }
    });
  } catch (error) {
    failures.push(error);
  }
  try {
    await timed("cleanup", async () => {
      if (!env) return;
      if (mode === "background" && (await startBackgroundCleanup(state, env))) return;
      await registryLock(() => destroyEnvironment(env));
    });
  } catch (error) {
    failures.push(error);
  }
}

/**
 * Destroys the environment in a detached child so the result is not held for the 11-48 s of
 * remote deletions. The server is already stopped; the journal is marked "deleting" before the
 * spawn, so a child that dies at any point leaves it to the next sweep (the hourly janitor's,
 * or any setup's on this machine), which finishes the destroy.
 */
async function startBackgroundCleanup(state: LiveState, env: Environment): Promise<boolean> {
  const log = join(state.artifacts, "cleanup.log");
  try {
    const { command: binary, args: spawnArgs } = backgroundCleanupSpawn({
      execPath: process.execPath,
      execArgv: process.execArgv,
      script: fileURLToPath(import.meta.url),
      id: env.id,
    });
    await markDeleting(env);
    await mkdir(state.artifacts, { recursive: true, mode: 0o700 });
    const descriptor = openSync(log, "a", 0o600);
    try {
      const child = spawn(binary, spawnArgs, {
        cwd: root,
        env: process.env,
        detached: true,
        stdio: ["ignore", descriptor, descriptor],
      });
      await new Promise<void>((accept, reject) => {
        child.once("error", reject);
        child.once("spawn", accept);
      });
      child.unref();
      state.cleanupLog = log;
      console.log(JSON.stringify({ event: "cleanup.background", id: env.id, pid: child.pid, log }));
    } finally {
      closeSync(descriptor);
    }
    return true;
  } catch (error) {
    console.error(
      redact(`Background cleanup could not start (${String(error)}); cleaning up now.`),
    );
    return false;
  }
}

/**
 * A gate failed while the setup was running: stop it and hand the environment to cleanup (the
 * detached one, unless this run cleans up in the foreground), writing no verdict.
 */
async function abortLive(state: LiveState): Promise<void> {
  await teardownLive(state, state.cleanup);
  const teardown = state.failures.slice(state.setupFailure === undefined ? 0 : 1);
  if (teardown.length) throw new AggregateError(teardown, "Live E2E teardown failed");
}

/** Scenarios, shutdown, cleanup and the completion record. Throws when anything failed. */
async function finishLive(state: LiveState, overlapped = false): Promise<void> {
  const { ai, run, readyE2E, timed, timings, failures, env, supervisor } = state;
  try {
    if (state.setupFailure === undefined) {
      const ctx = state.ctx!;
      const runtime = env!;
      const fixtures = state.fixtures!;
      const restartRuntime = async () => {
        supervisor!.assertRunning();
        const before = runtime.server;
        if (!before) throw new Error("Cold verification requires the owned running server.");
        await stopEnvironment(runtime);
        const restarted = await start(runtime, ctx);
        supervisor!.assertRunning();
        const after = runtime.server;
        if (
          !restarted.owned ||
          !after ||
          (before.pid === after.pid && before.start === after.start)
        )
          throw new Error("Cold verification did not observe a new owned server process.");
        return { environmentId: runtime.id, origin: runtime.origin, before, after };
      };
      await timed("scenarios", async () => {
        // Independent repositories and reports; neither failure tears down the other's server.
        const results = await Promise.allSettled(
          ai
            ? [runProviderE2E(ctx, fixtures, "ai", run, restartRuntime)]
            : [
                runE2E(ctx, fixtures, readyE2E?.scenarios ?? undefined),
                ...(readyE2E?.mirror === false ? [] : [runProviderE2E(ctx, fixtures, "mirror")]),
              ],
        );
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) throw new AggregateError(errors, "E2E scenarios failed");
      });
      supervisor!.assertRunning();
    }
  } catch (error) {
    failures.push(error);
  } finally {
    await teardownLive(state, state.cleanup);
    const background = state.cleanupLog !== undefined;
    const completion = {
      success: failures.length === 0,
      mode: ai ? "ai" : "non-ai",
      id: env?.id ?? null,
      // From the start of setup: includes the gates it overlapped.
      elapsedMs: Math.round(performance.now() - state.executionStarted),
      cleanup: background ? "background" : (env?.status ?? "provision-not-completed"),
      ...(background ? { cleanupLog: state.cleanupLog } : {}),
      setupOverlappedGates: overlapped,
      ...(state.quotaFallback ? { setupQuotaFallback: true } : {}),
      resources: env ? Object.keys(env.resources).filter((name) => ai || name === "artifacts") : [],
      ...(!ai ? { scenarios: readyE2E?.scenarios ?? "all", mirror: readyE2E?.mirror ?? true } : {}),
      failedStages: timings
        .filter((stage) => stage.outcome === "failed")
        .map((stage) => stage.stage),
      ...(run
        ? {
            aiStages: run.selection.stages,
            aiStageOutcomes: run.outcomes,
            failedAiStages: Object.keys(run.outcomes).filter((id) => run.outcomes[id] === "failed"),
          }
        : {}),
    };
    const artifacts = state.artifacts;
    await privateJson(join(artifacts, "timings.json"), timings);
    await privateJson(join(artifacts, "completion.json"), completion);
    if (run)
      // For --resume and the failure cooldown (ai-stages.ts).
      await appendHistory(root, {
        startedAt: new Date(state.started).toISOString(),
        finishedAt: new Date().toISOString(),
        success: completion.success,
        base: run.selection.base,
        stages: run.selection.stages,
        fingerprints: run.selection.fingerprints,
        outcomes: run.outcomes,
        failedStages: [
          ...completion.failedStages,
          ...Object.keys(run.outcomes).filter((id) => run.outcomes[id] === "failed"),
        ],
        evidence: artifacts,
      });
    await retainReports(artifacts);
    console.log(JSON.stringify({ event: "e2e.complete", ...completion, evidence: artifacts }));
  }
  if (failures.length) throw new AggregateError(failures, "Agent verification failed");
}

async function retainReports(artifacts: string): Promise<void> {
  const destination = process.env.GITMATRIX_CI_ARTIFACTS_DIR;
  if (!destination) return;
  if (!isAbsolute(destination)) throw new Error("GITMATRIX_CI_ARTIFACTS_DIR must be absolute.");
  if (resolve(destination) === root || resolve(destination).startsWith(`${root}/`))
    throw new Error("Retained CI artifacts must live outside the disposable checkout.");
  // Explicit files only: never copy logs, tokens, ownership journals or browser storage.
  for (const name of [
    "completion.json",
    "timings.json",
    "e2e.json",
    "mirror-e2e.json",
    "ai-e2e.json",
  ]) {
    let report: unknown;
    try {
      report = JSON.parse(await readFile(join(artifacts, name), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (name === "e2e.json") {
      report = (
        report as {
          scenario: string;
          status: string;
          elapsedMs: number;
          observations?: unknown[];
        }[]
      ).map(({ scenario, status, elapsedMs, observations }) => ({
        scenario,
        status,
        elapsedMs,
        phases: (Array.isArray(observations) ? observations : [])
          .flatMap((value) => {
            if (!value || typeof value !== "object") return [];
            const phase = value as Record<string, unknown>;
            if (
              phase.event !== "e2e.phase" ||
              typeof phase.name !== "string" ||
              !/^source-landing\.(fixture|failing-gate|moving-before-cas|before-cas|after-cas|before-finalize|retry-partial|cancel-partial|unknown-rewrite|unknown-base-reset|cleanup)$/.test(
                phase.name,
              ) ||
              typeof phase.elapsedMs !== "number" ||
              !Number.isFinite(phase.elapsedMs) ||
              phase.elapsedMs < 0 ||
              (phase.outcome !== "passed" && phase.outcome !== "failed")
            )
              return [];
            return [
              {
                event: "e2e.phase",
                name: phase.name,
                elapsedMs: phase.elapsedMs,
                outcome: phase.outcome,
              },
            ];
          })
          .slice(0, 11),
      }));
    }
    await privateJson(join(destination, name), JSON.parse(redact(JSON.stringify(report))));
  }
}

async function gates(options: ReadyOptions, foregroundCleanup = false): Promise<void> {
  const plan = await readinessPlan(root, options);
  if (!options.all) {
    const slim = await localGates(root, plan);
    // Failed change discovery and global paths keep the full gates (localGates returns them as is).
    if (slim !== plan.gates) {
      plan.gates = slim;
      plan.reasons = localReasons(plan.reasons);
    }
  }
  // Only explicit --all (or no change list) runs main-only journeys; other full
  // fallbacks still select journeys by path.
  const e2e = plan.e2e ? selectReadyE2E(plan.changed, plan.e2eAll) : null;
  // Every run records its verdicts; --resume reuses those whose inputs are unchanged.
  let prints:
    | { gates: Record<string, string>; scenarios: Record<string, string>; mirror: string }
    | undefined;
  try {
    const hashes = await contentHashes(root, plan.changed);
    prints = {
      gates: Object.fromEntries(
        plan.gates.map((gate) => [
          gate.name,
          gateFingerprint({
            base: plan.base,
            gate,
            changed: plan.changed,
            hashes,
            dependencies: plan.dependencies,
          }),
        ]),
      ),
      scenarios: scenarioFingerprints({
        base: plan.base,
        scenarios: e2e?.scenarios ?? e2eScenarioNames,
        changed: plan.changed,
        hashes,
      }),
      mirror: mirrorFingerprint({ base: plan.base, changed: plan.changed, hashes }),
    };
  } catch (error) {
    console.error(redact(`Ready history disabled: cannot hash changed paths (${String(error)})`));
  }
  const read = options.resume ? await readReadyHistory(root) : undefined;
  const resume: ResumeDecision | undefined =
    read &&
    resumeDecision({
      history: "history" in read ? read.history : null,
      problem: prints
        ? "problem" in read
          ? read.problem
          : undefined
        : "changed paths cannot be hashed",
      root,
      base: plan.base,
      gates: plan.gates.map(({ name }) => ({ name, fingerprint: prints?.gates[name] ?? "" })),
      scenarios: (e2e?.scenarios ?? []).map((name) => ({
        name,
        fingerprint: prints?.scenarios[name] ?? "",
      })),
      ...(e2e?.mirror ? { mirror: prints?.mirror ?? "" } : {}),
    });
  const gatesToRun = resume
    ? plan.gates.filter(({ name }) => resume.gates.includes(name))
    : plan.gates;
  const liveE2E = resume && e2e ? { scenarios: resume.scenarios, mirror: resume.mirror } : e2e;
  const selection = { ...plan, e2e, ...(resume ? { resume } : {}) };
  console.log(JSON.stringify({ event: "ready.selection", ...selection }, null, 2));
  if (resume)
    console.log(
      JSON.stringify(
        {
          event: "ready.resume",
          reused: Object.fromEntries(
            resume.reused.map(({ name, reason, evidence }) => [name, `${reason}: ${evidence}`]),
          ),
          rerun: resume.rerun,
          gates: gatesToRun.map(({ name }) => name),
          e2e: liveE2E,
        },
        null,
        2,
      ),
    );
  if (options.dryRun) return;
  const directory = join(root, ".gitmatrix-agent", "artifacts", `gates-${Date.now()}`);
  await privateJson(join(directory, "selection.json"), selection);
  const started = performance.now();
  const timings: {
    name: string;
    elapsedMs: number | null;
    wallMs: number;
    outcome: "passed" | "failed";
  }[] = [];
  const runGates = async (): Promise<void> => {
    for (const { name, binary, args: commandArgs, cwd } of gatesToRun) {
      const gateStarted = performance.now();
      let elapsedMs: number | null = null;
      let outcome: "passed" | "failed" = "failed";
      console.log(JSON.stringify({ event: "gate.start", name }));
      const run = async () => {
        const executionStarted = performance.now();
        try {
          return await command(binary, commandArgs, {
            cwd: cwd === "website" ? website : root,
            ...(name === "tests" || name.endsWith("-tests")
              ? { env: unitTestEnvironment(process.env) }
              : {}),
            // The full test gate runs every workspace serially; individual test
            // deadlines still apply inside each workspace.
            timeout: name === "tests" ? 3_600_000 : 1_800_000,
            log: join(directory, `${name}.log`),
          });
        } finally {
          elapsedMs = performance.now() - executionStarted;
        }
      };
      try {
        await run();
        outcome = "passed";
      } finally {
        const timing = { name, elapsedMs, wallMs: performance.now() - gateStarted, outcome };
        timings.push(timing);
        console.log(
          JSON.stringify({ event: outcome === "passed" ? "gate.pass" : "gate.fail", ...timing }),
        );
      }
    }
  };
  let success = false;
  let failure: unknown;
  let overlap: { overlapped: boolean; quotaFallback: boolean } | undefined;
  // The latest live setup: the quota fallback starts a second one.
  let live: LiveState | undefined;
  try {
    // An empty selection, or one --resume reused entirely, provisions no environment.
    if (liveE2E && selectsE2E(liveE2E)) {
      // The environment's setup (about a minute, several when the machine is loaded) needs
      // nothing from the gates, so it starts first and the scenarios start when both are done.
      let attempt = 0;
      overlap = await overlapSetup<LiveState>({
        runGates,
        startLive: async (signal) =>
          (live = await startLive({
            ai: false,
            readyE2E: liveE2E,
            // Only the first attempt overlaps the gates; the quota fallback runs after them.
            skipTypes: ++attempt === 1 && gatesWriteBindingTypes(gatesToRun),
            overlapped: attempt === 1,
            quotaFallback: attempt > 1,
            // The repeat seed guards the bootstrap, which most paths reach; an unreliable
            // change list keeps it.
            repeatSeed: plan.e2eAll || plan.full || seedMayBeAffected(plan.changed),
            cleanup: cleanupMode({
              ready: true,
              foregroundFlag: foregroundCleanup,
              hosted: process.env.GITMATRIX_REMOTE_HOSTED === "1",
            }),
            ...(signal ? { signal } : {}),
          })),
        setupFailure: (state) => state.setupFailure,
        finishLive: (state, overlapped) => finishLive(state, overlapped),
        abortLive,
      });
    } else await runGates();
    success = true;
    if (resume && !gatesToRun.length && !(liveE2E && selectsE2E(liveE2E)))
      console.log(
        JSON.stringify({
          event: "ready.reused",
          reason: "Every selected gate and journey passed earlier with unchanged inputs.",
          evidence: Object.fromEntries(resume.reused.map(({ name, evidence }) => [name, evidence])),
        }),
      );
  } catch (error) {
    failure = error;
  }
  if (prints)
    try {
      await recordReadyHistory(plan.base, prints, directory, timings, live);
    } catch (error) {
      // History I/O must not replace the original gate or E2E failure, nor fail a passing run.
      console.error(redact(`Could not record ready history: ${String(error)}`));
    }
  try {
    await privateJson(join(directory, "completion.json"), {
      success,
      gates: gatesToRun.map(({ name }) => name),
      ...(resume ? { reused: resume.reused } : {}),
      timings,
      elapsedMs: performance.now() - started,
      e2e: liveE2E,
      ...(overlap
        ? { setupOverlappedGates: overlap.overlapped, setupQuotaFallback: overlap.quotaFallback }
        : {}),
      completed: new Date().toISOString(),
    });
  } catch (error) {
    // Evidence I/O must not replace the original gate or E2E failure.
    if (success) throw error;
    console.error(redact(`Could not retain gate completion evidence: ${String(error)}`));
  }
  if (!success) throw failure;
}

/**
 * Records this run's gate, scenario and mirror attempts (ready-history.ts). A scenario the
 * run never reached keeps its earlier attempt; e2e.json and mirror-e2e.json are copied beside
 * the gate logs because the live artifacts directory is reused by the next run.
 */
async function recordReadyHistory(
  base: string | null,
  prints: { gates: Record<string, string>; scenarios: Record<string, string>; mirror: string },
  directory: string,
  timings: { name: string; outcome: "passed" | "failed" }[],
  live: LiveState | undefined,
): Promise<void> {
  const finishedAt = new Date().toISOString();
  const attempts: Attempt[] = timings.map(({ name, outcome }) => ({
    kind: "gate",
    name,
    fingerprint: prints.gates[name]!,
    base,
    outcome,
    finishedAt,
    evidence: join(directory, `${name}.log`),
  }));
  if (live && live.setupFailure === undefined) {
    const setup = live;
    // A report older than this setup is an earlier run's: the live artifacts directory is shared.
    const report = async (name: string): Promise<{ value: unknown; evidence: string } | null> => {
      const path = join(setup.artifacts, name);
      let text: string;
      try {
        if ((await stat(path)).mtimeMs < setup.started) return null;
        text = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      const evidence = join(directory, name);
      await writeFile(evidence, text, { mode: 0o600 });
      return { value: JSON.parse(text), evidence };
    };
    const scenarios = setup.readyE2E?.scenarios;
    const e2e = scenarios?.length ? await report("e2e.json") : null;
    if (scenarios && e2e) {
      const outcomes = scenarioOutcomes(e2e.value);
      for (const name of scenarios)
        if (outcomes[name] && prints.scenarios[name])
          attempts.push({
            kind: "scenario",
            name,
            fingerprint: prints.scenarios[name],
            base,
            outcome: outcomes[name],
            finishedAt,
            evidence: e2e.evidence,
          });
    }
    const mirror = setup.readyE2E?.mirror ? await report("mirror-e2e.json") : null;
    const outcome = mirror && mirrorOutcome(mirror.value);
    if (mirror && outcome)
      attempts.push({
        kind: "mirror",
        name: "mirror",
        fingerprint: prints.mirror,
        base,
        outcome,
        finishedAt,
        evidence: mirror.evidence,
      });
  }
  if (!attempts.length) return;
  const read = await readReadyHistory(root);
  await writeHistory(root, recordAttempts("history" in read ? read.history : null, root, attempts));
}

async function destroyCurrent(): Promise<void> {
  const env = JSON.parse(
    await readFile(join(root, ".gitmatrix-agent", "environment.json"), "utf8"),
  ) as Environment;
  validateEnvironment(env);
  if (env.root !== root || env.dir !== join(root, ".gitmatrix-agent"))
    throw new Error("Refusing foreign environment deletion.");
  await registryLock(() => destroyEnvironment(env));
}

/**
 * The detached cleanup that `ready` starts after it has its result (see startBackgroundCleanup).
 * It takes no registry lock: destroyEnvironment is idempotent per resource and its journal
 * writes merge deleted resources, and holding the lock for the 11-48 s of remote deletions
 * would stall the next setup on this machine.
 */
async function destroyById(id: string | undefined): Promise<void> {
  if (!id || !/^gma-[a-z0-9]{8,10}-[a-f0-9]{12}$/.test(id))
    throw new Error("Use destroy-environment <environment id>.");
  const env = JSON.parse(
    await readFile(join(registry, "environments", `${id}.json`), "utf8"),
  ) as Environment;
  validateEnvironment(env);
  if (env.id !== id) throw new Error("Mismatched ownership journal.");
  await destroyExclusively(env);
}

try {
  if (operation === "help" || operation === "--help") console.log(help);
  else if (operation === "setup") await setup(parseSetupOptions(args));
  else if (operation === "status") console.log(JSON.stringify(await listEnvironments(), null, 2));
  else if (operation === "cleanup") {
    if (args.length !== 1 || args[0] !== "--expired")
      throw new Error("Use cleanup --expired; explicit destroy handles the current environment.");
    await cleanupExpired();
  } else if (operation === "maintenance") {
    if (args[0] === "install") await installMaintenance();
    else if (args[0] === "uninstall") await uninstallMaintenance();
    else if (args[0] === "status") console.log(await maintenanceStatus());
    else if (args[0] === "reservations") {
      const { release, expired } = parseReservationArgs(args.slice(1));
      console.log(JSON.stringify(await reconcileReservations(release, { expired }), null, 2));
    } else
      throw new Error(
        "Use maintenance install|status|uninstall|reservations [--release [--expired]].",
      );
  } else if (operation === "main-e2e") {
    if (args[0] === "install") await installMainE2E();
    else if (args[0] === "uninstall") await uninstallMainE2E();
    else if (args[0] === "status") console.log(await mainE2EStatus());
    else if (args[0] === "tick") await tick();
    else throw new Error("Use main-e2e install|status|uninstall.");
  } else if (operation === "prune-browsers") {
    const flags = new Set(args);
    for (const flag of flags)
      if (flag !== "--dry-run" && flag !== "--include-other-installs")
        throw new Error("Use prune-browsers [--dry-run] [--include-other-installs].");
    const report = await pruneBrowsers({
      root,
      dryRun: flags.has("--dry-run"),
      includeOtherInstalls: flags.has("--include-other-installs"),
    });
    console.log(JSON.stringify({ event: "browsers.prune", ...report }, null, 2));
  } else if (operation === "destroy") await destroyCurrent();
  else if (operation === "reset") {
    const options = parseSetupOptions(args);
    await destroyCurrent();
    await setup(options);
  } else if (operation === "test") await liveTest();
  else if (operation === "test-ai") await liveTest(true, parseTestAiOptions(args));
  else if (operation === "check") {
    // Cleanup of the ready path's environment is detached unless asked to wait.
    const foreground = args.filter((argument) => argument !== "--foreground-cleanup");
    await gates(parseReadyOptions(foreground), foreground.length !== args.length);
  } else if (operation === "destroy-environment") await destroyById(args[0]);
  else {
    const env = await loadEnvironment(root);
    const ctx = await context(env);
    if (operation === "up") {
      if (args.length) {
        if (args.length !== 1 || args[0] !== "--sandbox") throw new Error("Use up [--sandbox].");
        if (process.env.GITMATRIX_REMOTE_HOSTED === "1")
          throw new Error(
            "Hosted CI runs inside the Cloudflare container; --sandbox requires local Docker and is not supported.",
          );
        await command("docker", ["info"], { cwd: root });
        ctx.env.GITMATRIX_CI_RUNNER = "sandbox";
      }
      if (process.env.GITMATRIX_REMOTE_HOSTED === "1") {
        // Install handlers before startup yields, but never stop a server this
        // invocation merely discovered. A signal during markServer is retried
        // by finally after the ownership record has finished persisting.
        let ownedChild: ChildProcess | undefined;
        let cleanup = Promise.resolve();
        const stopOwned = () => {
          cleanup = cleanup.then(async () => {
            if (!ownedChild?.pid) return;
            if (env.server?.pid === ownedChild.pid) await stopEnvironment(env);
            else if (ownedChild.exitCode === null && ownedChild.signalCode === null)
              await terminateProcessGroup(ownedChild.pid);
          });
          return cleanup;
        };
        const supervisor = superviseEnvironment(env, stopOwned);
        try {
          const handle = await start(env, ctx, {
            assertRunning: () => supervisor.assertRunning(),
            spawned: (child) => {
              ownedChild = child;
            },
          });
          supervisor.assertRunning();
          if (!handle.owned)
            throw new Error("Environment already running; use status for its origin.");
          const code = await handle.exited;
          if (code && code !== 143) process.exitCode = code;
        } finally {
          try {
            await stopOwned();
          } finally {
            await supervisor.close();
          }
        }
      } else {
        const handle = await start(env, ctx);
        if (!handle.owned)
          throw new Error("Environment already running; use status for its origin.");
        const supervisor = superviseEnvironment(env);
        try {
          const code = await handle.exited;
          if (code && code !== 143) process.exitCode = code;
        } finally {
          await supervisor.close();
          await stopEnvironment(env);
        }
      }
    } else if (operation === "stop") await stopEnvironment(env);
    else if (operation === "seed") {
      await seed(ctx);
      console.log(JSON.stringify({ event: "seed.complete", id: env.id }));
    } else if (operation === "gm" || operation === "exec") {
      if (args[0] === "--") args.shift();
      const binary = operation === "gm" ? ctx.gm : args.shift();
      if (!binary) throw new Error("Missing command.");
      if (!(await identity(env))) throw new Error("Scoped server is not ready; run agent up.");
      const output = await command(binary, args, {
        cwd: operation === "gm" ? ctx.work : root,
        env: ctx.env,
        timeout: 1_800_000,
      });
      console.log(process.env.GITMATRIX_REMOTE_HOSTED === "1" ? redact(output) : output);
    } else if (operation === "inspect") {
      const database = args.shift() ?? "db";
      if (!["db", "registry"].includes(database))
        throw new Error("Database must be db or registry.");
      const sql =
        args.join(" ") || "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
      if (!/^\s*(SELECT|PRAGMA\s+table_info)\b/i.test(sql) || /;\s*\S/.test(sql))
        throw new Error("Inspect accepts a single read-only query.");
      const id =
        database === "db" ? "00000000000000000000000000000000" : "00000000000000000000000000000001";
      console.log(
        await command(
          "cf",
          ["d1", "raw", id, "--local", "--persist-to", join(env.dir, "state"), "--sql", sql],
          { cwd: website },
        ),
      );
    } else throw new Error(`Unknown command ${operation}.\n${help}`);
  }
} catch (error) {
  console.error(
    redact(
      error instanceof AggregateError
        ? error.errors.map(String).join("\n")
        : error instanceof Error
          ? (error.stack ?? error.message)
          : JSON.stringify(error),
    ),
  );
  process.exitCode = 1;
}
