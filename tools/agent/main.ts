import { spawn } from "node:child_process";
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
  validateEnvironment,
} from "./environment.ts";
import type { Environment } from "./environment.ts";
import type { HarnessContext } from "./types.ts";
import { installMaintenance, maintenanceStatus, uninstallMaintenance } from "./maintenance.ts";
import { pruneBrowsers } from "./browsers.ts";
import { seed } from "./seed.ts";
import { runE2E } from "./e2e.ts";
import { runProviderE2E, type AiRun } from "./provider-e2e.ts";
import { ATLAS_PROVIDER_CONFIG } from "./atlas-provider-e2e.ts";
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
  vp run agent up                 Run the scoped app and CI dispatcher in the foreground
  vp run agent status             List owned environments (no secrets)
  vp run agent seed               Reconcile deterministic fixtures against the live environment
  vp run agent gm -- <args>       Use this worktree's binary, server, credentials and replica
  vp run agent exec -- <command>  Run another tool with isolated Git/XDG/GM settings
  vp run agent inspect [db|registry] [SQL]  Read local data; defaults to table inventory
  vp run agent check              Uncached quality gates plus fresh non-AI CLI/API/browser/mirror E2E
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
  vp run agent prune-browsers [--dry-run] [--include-other-installs]
                                  Delete Playwright browser revisions no worktree or other live install uses
24-hour hard lifetime; four live environments per user. Setup installs hourly user-systemd cleanup.
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
  const child = spawn("vp", ["dev"], {
    cwd: website,
    env: serverEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
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

function superviseEnvironment(env: Environment): EnvironmentSupervisor {
  let interrupted = false;
  let stopping: Promise<void> | undefined;
  let stopFailure: unknown;
  const stop = () => {
    interrupted = true;
    stopping ??= stopEnvironment(env).catch((error: unknown) => {
      stopFailure = error;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const expiry = setTimeout(stop, Math.max(1, env.expires - Date.now()));
  return {
    assertRunning() {
      if (interrupted) throw new Error("Environment interrupted or expired.");
    },
    async close() {
      clearTimeout(expiry);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await stopping;
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
    reusable: options.resume ? reusableStages(history.at(-1), base, prints) : undefined,
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
          ? "Every selected stage passed in the previous run with the same inputs."
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

async function liveTest(ai = false, options?: TestAiOptions): Promise<void> {
  let run: AiRun | undefined;
  if (ai) {
    const selection = await selectAiStages(options ?? parseTestAiOptions([]));
    if (!selection) return;
    run = { selection, outcomes: {} };
  }
  const started = Date.now();
  let artifacts = join(
    root,
    ".gitmatrix-agent",
    "artifacts",
    `test-${ai ? "ai" : "non-ai"}-${started}`,
  );
  const timings: { stage: string; elapsedMs: number; outcome: string }[] = [];
  const timed = async <T>(stage: string, action: () => Promise<T>): Promise<T> => {
    const began = Date.now();
    let outcome = "failed";
    try {
      const result = await action();
      outcome = "passed";
      return result;
    } finally {
      timings.push({ stage, elapsedMs: Date.now() - began, outcome });
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
          : [runE2E(ctx, fixtures), runProviderE2E(ctx, fixtures, "mirror")],
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
      elapsedMs: Date.now() - started,
      cleanup: env?.status ?? "provision-not-completed",
      resources: env ? Object.keys(env.resources).filter((name) => ai || name === "artifacts") : [],
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
      report = (report as { scenario: string; status: string; elapsedMs: number }[]).map(
        ({ scenario, status, elapsedMs }) => ({ scenario, status, elapsedMs }),
      );
    }
    await privateJson(join(destination, name), JSON.parse(redact(JSON.stringify(report))));
  }
}

async function gates(): Promise<void> {
  const directory = join(root, ".gitmatrix-agent", "artifacts", `gates-${Date.now()}`);
  const steps: [string, string, string[]][] = [
    ["bindings", "cf", ["workers", "types"]],
    ["check", "vp", ["check"]],
    ["cli-check", "vp", ["run", "--no-cache", "cli#check"]],
    ["types", "vp", ["run", "--no-cache", "@gitmatrix/agent#typecheck"]],
    ["preview-types", "vp", ["run", "--no-cache", "@gitmatrix/preview#typecheck"]],
    ["website-types", "vp", ["run", "--no-cache", "website#typecheck"]],
    ["tests", "vp", ["run", "-r", "--concurrency-limit", "1", "--no-cache", "test"]],
    ["build", "vp", ["run", "-r", "--concurrency-limit", "1", "--no-cache", "build"]],
  ];
  for (const [name, binary, commandArgs] of steps) {
    console.log(JSON.stringify({ event: "gate.start", name }));
    await command(binary, commandArgs, {
      cwd: name === "bindings" ? website : root,
      timeout: 1_800_000,
      log: join(directory, `${name}.log`),
    });
    console.log(JSON.stringify({ event: "gate.pass", name }));
  }
  await liveTest();
  await privateJson(join(directory, "completion.json"), {
    success: true,
    gates: steps.map(([name]) => name),
    completed: new Date().toISOString(),
  });
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
    else throw new Error("Use maintenance install|status|uninstall.");
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
  else if (operation === "check") await gates();
  else {
    const env = await loadEnvironment(root);
    const ctx = await context(env);
    if (operation === "up") {
      const handle = await start(env, ctx);
      if (!handle.owned) throw new Error("Environment already running; use status for its origin.");
      const supervisor = superviseEnvironment(env);
      try {
        const code = await handle.exited;
        if (code && code !== 143) process.exitCode = code;
      } finally {
        await supervisor.close();
        await stopEnvironment(env);
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
      console.log(
        await command(binary, args, {
          cwd: operation === "gm" ? ctx.work : root,
          env: ctx.env,
          timeout: 1_800_000,
        }),
      );
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
