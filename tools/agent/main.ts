import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import {
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
import { seed } from "./seed.ts";
import { runE2E } from "./e2e.ts";

const root = await realpath(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const args = process.argv.slice(2);
const operation = args.shift() ?? "help";
const website = join(root, "apps", "website");
const help = `Gitmatrix agent workflow (Linux, Node 24+, cf login, Rust, Vite+)
  vp run agent setup              Build gm, install Chromium, provision/migrate/seed isolated dev environment
  vp run agent up                 Run the scoped app and CI dispatcher in the foreground
  vp run agent status             List owned environments (no secrets)
  vp run agent seed               Reconcile deterministic fixtures against the live environment
  vp run agent gm -- <args>       Use this worktree's binary, server, credentials and replica
  vp run agent exec -- <command>  Run another tool with isolated Git/XDG/GM settings
  vp run agent inspect [db|registry] [SQL]  Read local data; defaults to table inventory
  vp run agent check              Uncached quality gates plus fresh real-service CLI/API/browser/provider E2E
  vp run agent test               Fresh real-service E2E only; always destroy remote resources
  vp run agent stop               Stop only the owned dev server and its runners
  vp run agent reset              Destroy/recreate this environment; never touch canonical dev state
  vp run agent destroy            Delete owned remote resources and local credentials/state
  vp run agent cleanup --expired  Sweep all expired owned environments, including removed worktrees
  vp run agent maintenance install|status|uninstall
24-hour hard lifetime; four live environments per user. Setup installs hourly user-systemd cleanup.
Canonical source publication uses ordinary gm outside 'agent gm'. Never point test commands at port 5180.
`;

async function prepare(): Promise<void> {
  await installMaintenance();
  console.log(JSON.stringify({ event: "prepare", step: "gm-build" }));
  await command(
    "cargo",
    [
      "build",
      "--manifest-path",
      join(root, "apps/cli/Cargo.toml"),
      "--target-dir",
      join(root, "apps/cli/target"),
    ],
    {
      cwd: root,
      timeout: 900_000,
      log: join(root, ".gitmatrix-agent", "artifacts", "cargo-build.log"),
    },
  );
  await command("cf", ["workers", "types"], { cwd: website });
  await command("vp", ["exec", "playwright", "install", "chromium"], {
    cwd: join(root, "tools/agent"),
    timeout: 300_000,
  });
  // Fail before provisioning if Chromium system dependencies are unavailable.
  const browser = await chromium.launch({ headless: true });
  await browser.close();
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
          log: join(ctx.artifacts, "server.log"),
        }),
      );
      return { owned: true, exited };
    }
    await delay(250);
  }
  throw new Error(`Server identity/readiness timed out. See ${ctx.artifacts}/server.log`);
}

function superviseEnvironment(env: Environment) {
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

async function setup(): Promise<void> {
  await prepare();
  const env = await createEnvironment(root);
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
        next: "vp run agent up",
      }),
    );
  } finally {
    await supervisor.close();
    if (owned) await stopEnvironment(env);
  }
}

async function liveTest(): Promise<void> {
  await prepare();
  const env = await createEnvironment(root, true);
  const ctx = await context(env);
  const supervisor = superviseEnvironment(env);
  const started = Date.now();
  let failure: unknown;
  try {
    await migrate(env);
    await start(env, ctx);
    supervisor.assertRunning();
    const fixtures = await seed(ctx);
    await seed(ctx); // Bootstrap must be repeatable against the same real data.
    await runE2E(ctx, fixtures);
    supervisor.assertRunning();
  } catch (error) {
    failure = error;
  }
  try {
    await supervisor.close();
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "E2E and shutdown failed") : error;
  }
  try {
    await registryLock(() => destroyEnvironment(env));
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "E2E and cleanup failed") : error;
  }
  await privateJson(join(ctx.artifacts, "completion.json"), {
    success: !failure,
    id: env.id,
    elapsedMs: Date.now() - started,
    cleanup: env.status,
    error: failure
      ? redact(failure instanceof Error ? failure.message : JSON.stringify(failure))
      : null,
  });
  console.log(
    JSON.stringify({
      event: "e2e.complete",
      success: !failure,
      evidence: ctx.artifacts,
      cleanup: env.status,
    }),
  );
  if (failure) throw failure;
}

async function gates(): Promise<void> {
  const directory = join(root, ".gitmatrix-agent", "artifacts", `gates-${Date.now()}`);
  const steps: [string, string, string[]][] = [
    ["bindings", "cf", ["workers", "types"]],
    ["check", "vp", ["check"]],
    ["cli-check", "vp", ["run", "--no-cache", "cli#check"]],
    ["types", "vp", ["run", "--no-cache", "@gitmatrix/agent#typecheck"]],
    ["website-types", "vp", ["run", "--no-cache", "website#typecheck"]],
    ["tests", "vp", ["run", "-r", "--no-cache", "test"]],
    ["build", "vp", ["run", "-r", "--no-cache", "build"]],
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
  else if (operation === "setup") await setup();
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
  } else if (operation === "destroy") await destroyCurrent();
  else if (operation === "reset") {
    await destroyCurrent();
    await setup();
  } else if (operation === "test") await liveTest();
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
