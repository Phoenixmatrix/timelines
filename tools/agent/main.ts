import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
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
  listEnvironments,
  loadEnvironment,
  markServer,
  privateJson,
  redact,
  registryLock,
  stopEnvironment,
  terminateProcessGroup,
  unitTestEnvironment,
  validateEnvironment,
} from "./environment.ts";
import type { Environment } from "./environment.ts";
import type { HarnessContext } from "./types.ts";
import { installMaintenance, maintenanceStatus, uninstallMaintenance } from "./maintenance.ts";
import { parseReservationArgs, reconcileReservations } from "./reservations.ts";
import { pruneBrowsers } from "./browsers.ts";
import { seed } from "./seed.ts";
import { runE2E } from "./e2e.ts";
import { runProviderE2E, type AiRun } from "./provider-e2e.ts";
import { ATLAS_PROVIDER_CONFIG } from "./atlas-provider-e2e.ts";
import { parseReadyOptions, readinessPlan, type ReadyOptions } from "./ready-plan.ts";
import { selectReadyE2E, type ReadyE2ESelection } from "./ready-e2e.ts";
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
  vp run agent check [--all] [--dry-run] [--base <ref>]
                                  Change-aware uncached readiness (also vp run ready); --all runs every gate
                                  and non-AI E2E, --dry-run explains selection without running or provisioning
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
  vp run agent prune-browsers [--dry-run] [--include-other-installs]
                                  Delete Playwright browser revisions no worktree or other live install uses
24-hour hard lifetime; default limits: four installation-wide and four local per OS user/machine.
Configure the shared quota authority before setup. Setup installs hourly user-systemd cleanup.
Canonical source publication uses ordinary gm outside 'agent gm'. Never point test commands at port 5180.
`;

async function prepare(): Promise<void> {
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
      timeout: 900_000,
      log: join(root, ".gitmatrix-agent", "artifacts", "cargo-build.log"),
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
  await command("cf", ["workers", "types"], { cwd: website });
  // Every scenario launches headless, which Playwright serves from the headless
  // shell; full Chromium (~400 MB a revision) is only for headed or channel launches.
  await command("vp", ["exec", "playwright", "install", "--only-shell", "chromium"], {
    cwd: join(root, "tools/agent"),
    timeout: 300_000,
  });
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

async function migrate(env: Environment): Promise<void> {
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
      { cwd: website },
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
    { cwd: website },
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
  throw new Error(`Server identity/readiness timed out. See ${ctx.artifacts}/server.log`);
}

interface EnvironmentSupervisor {
  assertRunning(): void;
  close(): Promise<void>;
}

function superviseEnvironment(
  env: Environment,
  stopOwned: () => Promise<void> = () => stopEnvironment(env),
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
  const { base, changed } = await changedPaths(root, options.base);
  const prints = await fingerprints(root, base, changed);
  const history = await readHistory(root);
  const selection = selectStages({
    changed,
    requested: options.stages,
    all: options.all,
    reusable: options.resume ? reusableStages(history, base, prints) : undefined,
    base,
    fingerprints: prints,
  });
  console.log(
    JSON.stringify(
      {
        event: "test-ai.selection",
        base,
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
  const started = Date.now();
  const executionStarted = performance.now();
  let artifacts = join(
    root,
    ".gitmatrix-agent",
    "artifacts",
    `test-${ai ? "ai" : "non-ai"}-${started}`,
  );
  const timings: { stage: string; elapsedMs: number; outcome: string }[] = [];
  const timed = async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
    const began = performance.now();
    let outcome = "failed";
    try {
      const result = await action();
      outcome = "passed";
      return result;
    } finally {
      timings.push({ stage, elapsedMs: Math.round(performance.now() - began), outcome });
    }
  };
  let env: Environment | undefined;
  let supervisor: EnvironmentSupervisor | undefined;
  const failures: unknown[] = [];
  try {
    await timed("prepare", prepare);
    env = await timed("provision", () => createEnvironment(root, true, ai));
    const ctx = await context(env);
    // Atlas settings per owning account: the degraded providers test-ai verifies.
    if (ai) ctx.env.GITMATRIX_ATLAS_CONFIG = JSON.stringify(ATLAS_PROVIDER_CONFIG);
    artifacts = ctx.artifacts;
    supervisor = superviseEnvironment(env);
    await timed("migrate", () => migrate(env!));
    await timed("start", () => start(env!, ctx));
    supervisor.assertRunning();
    const fixtures = await timed("seed", async () => {
      const fixtures = await seed(ctx);
      if (!ai) await seed(ctx); // Bootstrap remains repeatable against real data.
      return fixtures;
    });
    await timed("scenarios", async () => {
      // Independent repositories and reports; neither failure tears down the other's server.
      const results = await Promise.allSettled(
        ai
          ? [runProviderE2E(ctx, fixtures, "ai", run)]
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
    supervisor.assertRunning();
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await timed("shutdown", async () => {
        try {
          await supervisor?.close();
        } finally {
          if (env) await stopEnvironment(env);
        }
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await timed("cleanup", async () => {
        if (env) await registryLock(() => destroyEnvironment(env!));
      });
    } catch (error) {
      failures.push(error);
    }
    const completion = {
      success: failures.length === 0,
      mode: ai ? "ai" : "non-ai",
      id: env?.id ?? null,
      elapsedMs: Math.round(performance.now() - executionStarted),
      cleanup: env?.status ?? "provision-not-completed",
      resources: env ? Object.keys(env.resources).filter((name) => ai || name === "artifacts") : [],
      ...(!ai ? { scenarios: readyE2E?.scenarios ?? "all", mirror: readyE2E?.mirror ?? true } : {}),
      failedStages: timings
        .filter((stage) => stage.outcome === "failed")
        .map((stage) => stage.stage),
      ...(run
        ? {
            aiStages: run.selection.stages,
            aiStageOutcomes: run.outcomes,
            failedAiStages: Object.keys(run.outcomes).filter(
              (id) => run!.outcomes[id] === "failed",
            ),
          }
        : {}),
    };
    await privateJson(join(artifacts, "timings.json"), timings);
    await privateJson(join(artifacts, "completion.json"), completion);
    if (run)
      // For --resume and the failure cooldown (ai-stages.ts).
      await appendHistory(root, {
        startedAt: new Date(started).toISOString(),
        finishedAt: new Date().toISOString(),
        success: completion.success,
        base: run.selection.base,
        stages: run.selection.stages,
        fingerprints: run.selection.fingerprints,
        outcomes: run.outcomes,
        failedStages: [
          ...completion.failedStages,
          ...Object.keys(run.outcomes).filter((id) => run!.outcomes[id] === "failed"),
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

async function gates(options: ReadyOptions): Promise<void> {
  const plan = await readinessPlan(root, options);
  const e2e = plan.e2e ? selectReadyE2E(plan.changed, plan.full) : null;
  const selection = { ...plan, e2e };
  console.log(JSON.stringify({ event: "ready.selection", ...selection }, null, 2));
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
  let success = false;
  let failure: unknown;
  try {
    for (const { name, binary, args: commandArgs, cwd } of plan.gates) {
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
            timeout: 1_800_000,
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
    if (e2e) await liveTest(false, undefined, e2e);
    success = true;
  } catch (error) {
    failure = error;
  }
  try {
    await privateJson(join(directory, "completion.json"), {
      success,
      gates: plan.gates.map(({ name }) => name),
      timings,
      elapsedMs: performance.now() - started,
      e2e,
      completed: new Date().toISOString(),
    });
  } catch (error) {
    // Evidence I/O must not replace the original gate or E2E failure.
    if (success) throw error;
    console.error(redact(`Could not retain gate completion evidence: ${String(error)}`));
  }
  if (!success) throw failure;
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
  else if (operation === "check") await gates(parseReadyOptions(args));
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
