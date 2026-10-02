import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, rm, realpath, lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessContext } from "./types.ts";

const TTL = 24 * 60 * 60 * 1000;
const MAX_ENVIRONMENTS = 4;
const ID = /^gma-[a-z0-9]{8,10}-[a-f0-9]{12}$/;
export const registry = join(homedir(), ".local", "state", "gitmatrix-agent");
type Resource = "artifacts" | "vectors" | "search";
class UnsafeLocalState extends Error {}
export interface Environment {
  version: 1;
  id: string;
  root: string;
  dir: string;
  origin: string;
  port: number;
  account: string;
  profile?: string;
  created: number;
  expires: number;
  secret: string;
  dispatchSecret: string;
  resources: Record<Resource, "pending" | "created" | "deleted">;
  status: "provisioning" | "ready" | "deleting" | "deleted";
  server?: { pid: number; start: string };
}

export function validateEnvironment(value: Environment): void {
  if (value.version !== 1 || !ID.test(value.id) || !/^[a-f0-9]{32}$/.test(value.account))
    throw new Error("Invalid environment ownership record; refusing resource operations.");
  const base = join(value.root, ".gitmatrix-agent");
  if (
    !isAbsolute(value.root) ||
    resolve(value.root) !== value.root ||
    (value.dir !== base && value.dir !== join(base, "runs", value.id))
  )
    throw new Error("Environment path is outside its owned worktree directory.");
  if (
    !Number.isInteger(value.port) ||
    value.port < 1024 ||
    value.port > 65535 ||
    value.port === 5180 ||
    value.origin !== `http://127.0.0.1:${value.port}`
  )
    throw new Error("Invalid isolated origin; canonical server access is forbidden.");
  if (
    !Number.isFinite(value.created) ||
    !Number.isFinite(value.expires) ||
    value.expires <= value.created ||
    value.expires - value.created > TTL
  )
    throw new Error("Invalid environment expiry; maximum lifetime is 24 hours.");
  if (!/^[a-f0-9]{64}$/.test(value.secret) || !/^[a-f0-9]{64}$/.test(value.dispatchSecret))
    throw new Error("Invalid environment capability.");
  for (const key of ["artifacts", "vectors", "search"] as const)
    if (!["pending", "created", "deleted"].includes(value.resources[key]))
      throw new Error("Invalid resource ownership journal.");
}

export function redact(text: string): string {
  return text
    .replace(/\b(?:gmx_|gmj_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
}

export async function command(
  binary: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeout?: number;
    log?: string;
  } = {},
): Promise<string> {
  const childEnv: NodeJS.ProcessEnv = { ...(options.env ?? process.env), NO_COLOR: "1" };
  delete childEnv.FORCE_COLOR;
  const result = await new Promise<{ code: number | null; output: string; stdout: string }>(
    (accept, reject) => {
      const child = spawn(binary, args, {
        cwd: options.cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      let output = "";
      let overflow = false;
      let stdout = "";
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const stop = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {
            /* exited */
          }
        }
      };
      const hardStop = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* exited */
          }
        }
      };
      const interrupt = () => {
        timedOut = true;
        stop();
        killTimer ??= setTimeout(hardStop, 10_000);
      };
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      const timer = setTimeout(interrupt, options.timeout ?? 120_000);
      const collect = (chunk: Buffer, standard: boolean) => {
        if (output.length + chunk.length > 16 * 1024 * 1024) {
          overflow = true;
          hardStop();
          return;
        }
        output += chunk.toString();
        if (standard) stdout += chunk.toString();
      };
      child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
      child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
      child.once("error", (error) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
        accept({ code: overflow || timedOut ? -1 : code, output, stdout });
      });
    },
  );
  if (options.log) {
    await mkdir(dirname(options.log), { recursive: true, mode: 0o700 });
    await writeFile(options.log, redact(result.output), { mode: 0o600 });
  }
  if (result.code !== 0)
    throw new Error(
      `${binary} ${args.slice(0, 4).join(" ")} failed (${result.code}):\n${redact(result.output).slice(-6000)}`,
    );
  return result.stdout;
}

export async function privateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function recordAt(path: string): Promise<Environment | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Environment;
    validateEnvironment(value);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function persist(env: Environment): Promise<void> {
  validateEnvironment(env);
  const previous = await recordAt(join(registry, "environments", `${env.id}.json`));
  if (previous?.status === "deleted" || previous?.status === "deleting") {
    if (env.status === "ready") env.status = previous.status;
    for (const resource of ["artifacts", "vectors", "search"] as const)
      if (previous.resources[resource] === "deleted") env.resources[resource] = "deleted";
  }
  // Central journal survives worktree removal and is committed before local state.
  await privateJson(join(registry, "environments", `${env.id}.json`), env);
  if ((await realpath(env.root).catch(() => null)) === env.root) {
    try {
      await safeLocalDirectory(env);
      const local = await recordAt(join(env.dir, "environment.json"));
      if (
        !local ||
        local.id === env.id ||
        (local.status === "deleted" && env.status === "provisioning")
      )
        await privateJson(join(env.dir, "environment.json"), env);
    } catch (error) {
      if (env.status !== "deleting" && env.status !== "deleted") throw error;
      console.error(
        JSON.stringify({
          event: "cleanup.local-state-skipped",
          id: env.id,
          reason: redact(String(error)),
        }),
      );
    }
  }
}

export async function loadEnvironment(root: string): Promise<Environment> {
  const value = JSON.parse(
    await readFile(join(root, ".gitmatrix-agent", "environment.json"), "utf8"),
  ) as Environment;
  validateEnvironment(value);
  if (value.root !== (await realpath(root)))
    throw new Error("Environment belongs to a different worktree; run setup here.");
  if (value.status !== "ready" || value.expires <= Date.now())
    throw new Error("Environment is expired or incomplete; run destroy then setup.");
  return value;
}

async function processStart(pid: number): Promise<string | null> {
  // Linux start ticks fence PID reuse. Other platforms refuse unattended process killing.
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  return stat?.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
}

export async function registryLock<T>(action: () => Promise<T>): Promise<T> {
  await mkdir(registry, { recursive: true, mode: 0o700 });
  // Kernel locks release on crashes, including the gap before an owner record
  // could be written. The helper holds the lock until its stdin closes.
  const child = spawn(
    "flock",
    [
      "--exclusive",
      "--wait",
      "300",
      join(registry, "registry.lock"),
      process.execPath,
      "-e",
      'process.stdout.write("locked\\n"); process.stdin.resume(); process.stdin.on("end", () => process.exit(0));',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    diagnostic += chunk.toString();
  });
  const closed = Promise.withResolvers<void>();
  child.once("close", () => closed.resolve());
  const ready = Promise.withResolvers<void>();
  child.once("error", ready.reject);
  child.once("exit", (code) =>
    ready.reject(new Error(`Registry lock failed (${code}): ${diagnostic}`)),
  );
  child.stdout.once("data", () => ready.resolve());
  await ready.promise;
  try {
    return await action();
  } finally {
    child.stdin.end();
    await closed.promise;
  }
}

async function inventory(): Promise<Environment[]> {
  const directory = join(registry, "environments");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records: Environment[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const value = JSON.parse(await readFile(join(directory, name), "utf8")) as Environment;
    validateEnvironment(value);
    if (name !== `${value.id}.json`) throw new Error("Mismatched ownership journal filename.");
    records.push(value);
  }
  return records;
}

function cfEnv(env: Pick<Environment, "account">): NodeJS.ProcessEnv {
  return { ...process.env, CLOUDFLARE_ACCOUNT_ID: env.account };
}
async function cf(env: Environment, args: string[]): Promise<string> {
  return command("cf", [...args, ...(env.profile ? ["--profile", env.profile] : [])], {
    env: cfEnv(env),
    timeout: 180_000,
  });
}
async function cfJson<T>(env: Environment, args: string[]): Promise<T> {
  return JSON.parse(await cf(env, args)) as T;
}
function absent(error: unknown): boolean {
  // Only explicit resource absence is idempotent, never permission/network failures.
  return /\b404\b|resource not found|namespace not found|index not found|instance not found/i.test(
    String(error),
  );
}
async function deleteIfPresent(env: Environment, args: string[]): Promise<void> {
  try {
    await cf(env, args);
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

export async function stopEnvironment(env: Environment): Promise<void> {
  if (!env.server) return;
  const { pid, start } = env.server;
  if ((await processStart(pid)) !== start) {
    delete env.server;
    await persist(env);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + 20_000;
  while ((await processStart(pid)) === start && Date.now() < deadline) await delay(100);
  if ((await processStart(pid)) === start) process.kill(-pid, "SIGKILL");
  delete env.server;
  await persist(env);
}

export async function destroyEnvironment(env: Environment): Promise<void> {
  validateEnvironment(env);
  if (env.status === "deleted") return;
  await stopEnvironment(env);
  env.status = "deleting";
  await persist(env);
  const failures: string[] = [];
  // Continue independent deletions even if one provider is unavailable.
  for (const resource of ["search", "vectors", "artifacts"] as const) {
    if (env.resources[resource] === "deleted") continue;
    try {
      if (resource === "search") {
        // Parent owns the namespace, including every instance created inside it.
        for (;;) {
          let instances: { id: string }[];
          try {
            instances = await cfJson(env, [
              "ai-search",
              "list",
              "--name",
              env.id,
              "--per-page",
              "100",
            ]);
          } catch (error) {
            if (absent(error)) break;
            throw error;
          }
          if (!instances.length) break;
          for (const instance of instances)
            await deleteIfPresent(env, [
              "ai-search",
              "delete",
              instance.id,
              "--name",
              env.id,
              "--force",
            ]);
        }
        await deleteIfPresent(env, ["ai-search", "namespace", "delete", env.id, "--force"]);
      } else if (resource === "vectors") {
        await deleteIfPresent(env, ["vectorize", "delete", env.id, "--force"]);
      } else {
        for (;;) {
          let repos: { name: string }[];
          try {
            repos = await cfJson(env, [
              "artifacts",
              "namespaces",
              "repos",
              "list",
              "--namespace",
              env.id,
              "--limit",
              "100",
            ]);
          } catch (error) {
            if (absent(error)) break;
            throw error;
          }
          if (!repos.length) break;
          for (const repo of repos)
            await deleteIfPresent(env, [
              "artifacts",
              "namespaces",
              "repos",
              "delete",
              repo.name,
              "--namespace",
              env.id,
              "--force",
            ]);
        }
        await deleteIfPresent(env, ["artifacts", "namespaces", "delete", env.id, "--force"]);
      }
      env.resources[resource] = "deleted";
      await persist(env);
    } catch (error) {
      failures.push(`${resource}: ${String(error)}`);
    }
  }
  if (failures.length)
    throw new Error(
      `Cleanup incomplete for ${env.id}; journal retained for next sweep:\n${failures.join("\n")}`,
    );
  // A removed worktree path may have been reused or redirected. Do not touch it.
  let localSafe = true;
  try {
    await safeLocalDirectory(env);
  } catch (error) {
    if (!(error instanceof UnsafeLocalState)) throw error;
    localSafe = false;
    console.error(
      JSON.stringify({
        event: "cleanup.local-state-skipped",
        id: env.id,
        reason: redact(String(error)),
      }),
    );
  }
  if (localSafe) {
    const local = await recordAt(join(env.dir, "environment.json"));
    if (local?.id === env.id) {
      for (const name of await readdir(env.dir)) {
        if (["artifacts", "environment.json", "runs"].includes(name)) continue;
        await rm(join(env.dir, name), { recursive: true, force: true });
      }
    }
  }
  await rm(join(registry, "workspaces", env.id), { recursive: true, force: true });
  env.status = "deleted";
  await persist(env);
  console.log(JSON.stringify({ event: "environment.deleted", id: env.id }));
}

export async function cleanupExpired(): Promise<void> {
  await registryLock(async () => {
    const failures: string[] = [];
    for (const env of await inventory()) {
      if (env.status === "deleted" && Date.now() - env.expires > 7 * TTL) {
        await rm(join(registry, "environments", `${env.id}.json`));
        continue;
      }
      if (env.status === "deleted" || (env.status !== "deleting" && env.expires > Date.now()))
        continue;
      try {
        await destroyEnvironment(env);
      } catch (error) {
        failures.push(String(error));
      }
    }
    if (failures.length) throw new Error(failures.join("\n"));
  });
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate loopback port.");
  await new Promise<void>((accept, reject) =>
    server.close((error) => (error ? reject(error) : accept())),
  );
  return address.port;
}

export async function createEnvironment(
  root: string,
  ephemeral = false,
  ai = true,
): Promise<Environment> {
  root = await realpath(root);
  await cleanupExpired();
  return registryLock(async () => {
    const existing = await inventory();
    if (!ephemeral) {
      const current = existing.find(
        (e) =>
          e.root === root && e.dir === join(root, ".gitmatrix-agent") && e.status !== "deleted",
      );
      if (current) {
        if (current.status !== "ready")
          throw new Error("Partial environment exists; run destroy before setup.");
        return current;
      }
    }
    if (existing.filter((e) => e.status !== "deleted").length >= MAX_ENVIRONMENTS)
      throw new Error(
        `At most ${MAX_ENVIRONMENTS} live agent environments per user. Destroy unused environments first.`,
      );
    const profile = process.env.GITMATRIX_CF_PROFILE;
    const identity = JSON.parse(
      await command("cf", ["auth", "whoami", ...(profile ? ["--profile", profile] : [])]),
    ) as {
      authenticated: boolean;
      tokenValid: boolean;
      accounts: { id: string }[];
    };
    if (!identity.authenticated || !identity.tokenValid)
      throw new Error("Cloudflare login is required: cf auth login.");
    const account =
      process.env.CLOUDFLARE_ACCOUNT_ID ??
      (identity.accounts.length === 1 ? identity.accounts[0]?.id : undefined);
    if (!account || !identity.accounts.some((a) => a.id === account))
      throw new Error("Set CLOUDFLARE_ACCOUNT_ID to an authorized development account.");
    const id = `gma-${Date.now().toString(36)}-${randomBytes(6).toString("hex")}`;
    const dir = ephemeral
      ? join(root, ".gitmatrix-agent", "runs", id)
      : join(root, ".gitmatrix-agent");
    const port = await allocatePort();
    const created = Date.now();
    const env: Environment = {
      version: 1,
      id,
      root,
      dir,
      origin: `http://127.0.0.1:${port}`,
      port,
      account,
      profile,
      created,
      expires: created + TTL,
      secret: randomBytes(32).toString("hex"),
      dispatchSecret: randomBytes(32).toString("hex"),
      resources: {
        artifacts: "pending",
        vectors: ai ? "pending" : "deleted",
        search: ai ? "pending" : "deleted",
      },
      status: "provisioning",
    };
    await persist(env);
    try {
      await cf(env, ["artifacts", "namespaces", "create", "--namespace", id]);
      env.resources.artifacts = "created";
      await persist(env);
      if (ai) {
        await cf(env, [
          "vectorize",
          "create",
          "--name",
          id,
          "--config-dimensions",
          "1024",
          "--config-metric",
          "cosine",
          "--description",
          `Gitmatrix agent; expires ${new Date(env.expires).toISOString()}`,
        ]);
        env.resources.vectors = "created";
        await persist(env);
        for (const property of ["repo", "kind", "path"])
          await cf(env, [
            "vectorize",
            "metadata-index",
            "create",
            id,
            "--property-name",
            property,
            "--index-type",
            "string",
          ]);
        await cf(env, [
          "ai-search",
          "namespace",
          "create",
          id,
          "--description",
          `Gitmatrix agent; expires ${new Date(env.expires).toISOString()}`,
        ]);
        env.resources.search = "created";
        await persist(env);
        await cf(env, [
          "ai-search",
          "create",
          id,
          "knowledge",
          "--body",
          JSON.stringify({
            id: "knowledge",
            embedding_model: "@cf/qwen/qwen3-embedding-0.6b",
            indexing_options: { keyword_tokenizer: "trigram" },
            custom_metadata: ["repo", "kind", "path", "commit", "lang"].map((field_name) => ({
              field_name,
              data_type: "text",
            })),
          }),
        ]);
      }
      env.status = "ready";
      await persist(env);
      console.log(
        JSON.stringify({
          event: "environment.created",
          id,
          origin: env.origin,
          expires: new Date(env.expires).toISOString(),
        }),
      );
      return env;
    } catch (error) {
      try {
        await destroyEnvironment(env);
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Provisioning failed and cleanup remains pending; see ownership journal.",
        );
      }
      throw error;
    }
  });
}

export async function context(env: Environment): Promise<HarnessContext> {
  validateEnvironment(env);
  await safeLocalDirectory(env);
  const vars: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(vars))
    if (/^(GM_|GITMATRIX_|GIT_|SSH_)/.test(key)) delete vars[key];
  for (const name of ["config", "cache", "data", "home", "artifacts", "state"]) {
    const directory = join(env.dir, name);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if ((await realpath(directory)) !== directory)
      throw new Error(`Refusing redirected environment directory: ${name}`);
  }
  const work = join(registry, "workspaces", env.id);
  await mkdir(work, { recursive: true, mode: 0o700 });
  if ((await realpath(work)) !== work) throw new Error("Refusing redirected disposable workspace.");
  const temporary = join(work, "tmp");
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  if ((await realpath(temporary)) !== temporary)
    throw new Error("Refusing redirected temporary workspace.");
  const gitConfig = join(env.dir, "config", "gitconfig");
  await writeFile(
    gitConfig,
    "[user]\n  name = Gitmatrix Agent\n  email = agent@example.test\n[init]\n  defaultBranch = main\n[credential]\n  helper =\n",
    { mode: 0o600 },
  );
  const gm = join(env.root, "apps", "cli", "target", "debug", "gm");
  Object.assign(vars, {
    GITMATRIX_AGENT_ID: env.id,
    GITMATRIX_AGENT_SECRET: env.secret,
    GITMATRIX_CI_DISPATCH_SECRET: env.dispatchSecret,
    GITMATRIX_PORT: String(env.port),
    GITMATRIX_PUBLIC_URL: env.origin,
    GITMATRIX_STATE_DIR: join(env.dir, "state"),
    GITMATRIX_ARTIFACTS_NAMESPACE: env.id,
    GITMATRIX_AGENT_AI: env.resources.vectors === "deleted" ? "disabled" : "enabled",
    GITMATRIX_VECTORIZE_INDEX: env.id,
    GITMATRIX_SEARCH_NAMESPACE: env.id,
    GITMATRIX_GM: gm,
    GITMATRIX_CI_RUNNER: "local",
    GITMATRIX_CI_RUNNERS: "2",
    HOME: join(env.dir, "home"),
    TMPDIR: temporary,
    XDG_CONFIG_HOME: join(env.dir, "config"),
    XDG_CACHE_HOME: join(env.dir, "cache"),
    XDG_DATA_HOME: join(env.dir, "data"),
    GM_SERVER: env.origin,
    GM_AGENT: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    CLOUDFLARE_ACCOUNT_ID: env.account,
  });
  return {
    root: env.root,
    dir: env.dir,
    work,
    origin: env.origin,
    gm,
    env: vars,
    artifacts: join(env.dir, "artifacts"),
  };
}

export async function markServer(env: Environment, pid: number): Promise<void> {
  const start = await processStart(pid);
  if (!start) throw new Error("Agent process supervision requires Linux /proc PID start identity.");
  env.server = { pid, start };
  await persist(env);
}

export async function safeLocalDirectory(env: Environment): Promise<void> {
  validateEnvironment(env);
  for (const path of [env.root, join(env.root, ".gitmatrix-agent"), env.dir]) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (info && (info.isSymbolicLink() || (await realpath(path)) !== path))
      throw new UnsafeLocalState(`Refusing symlink-owned state: ${path}`);
  }
}

export async function listEnvironments(): Promise<unknown[]> {
  return (await inventory())
    .filter((e) => e.status !== "deleted")
    .map((e) => ({
      id: e.id,
      root: e.root,
      origin: e.origin,
      expires: new Date(e.expires).toISOString(),
      status: e.status,
      resources: e.resources,
    }));
}
