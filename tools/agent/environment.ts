import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, readdir, rm, realpath, lstat } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { HarnessContext } from "./types.ts";
import { withFileLock } from "./heavy.ts";
import {
  advanceQuota,
  parseEnvironmentLimits,
  readEnvironmentLimits,
  reserveQuota,
  releaseQuota,
} from "./quota.ts";
import type { QuotaReservation } from "./quota.ts";
import { prunable, sweepReservations } from "./reservations.ts";

const TTL = 24 * 60 * 60 * 1000;
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
  resources: Record<Exclude<Resource, "artifacts">, "pending" | "created" | "deleted"> & {
    /** `orphaned`: Cloudflare refuses to delete a namespace with no listable repos (CORE-302). */
    artifacts: "pending" | "created" | "deleted" | "orphaned";
    // Missing in pre-Gateway v1 journals: no gateway is owned or eligible for deletion.
    gateway?: "pending" | "created" | "deleted";
  };
  /**
   * `orphaned`: everything is deleted except a namespace Cloudflare refuses to
   * delete. It holds no slot; cleanup keeps retrying it and keeps its journal.
   */
  status: "provisioning" | "ready" | "deleting" | "deleted" | "orphaned";
  /** Why an orphaned resource is still there, for whoever cleans it up later. */
  orphan?: { namespace: string; at: string; reason: string };
  server?: { pid: number; start: string };
  /**
   * Whether this environment has paid AI (Workers AI, AI Gateway, Vectorize,
   * AI Search). Setup leaves it off unless `--ai` (CORE-284). Journals written
   * before the field derive it from their resources.
   */
  ai?: boolean;
  /** Explicit installation authority, never derived from scoped product credentials. */
  quota?: QuotaReservation;
}

/** Acknowledged cleanup release survives an interrupted terminal status write. */
function retired(env: Environment): boolean {
  return (
    env.status === "deleted" ||
    env.status === "orphaned" ||
    (env.status === "deleting" && env.quota?.state === "released")
  );
}

/** Whether the environment binds paid AI: Knowledge builds and other model calls run. */
export function aiEnabled(env: Environment): boolean {
  return env.ai ?? !(env.resources.vectors === "deleted" && env.resources.search === "deleted");
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
    if (
      !["pending", "created", "deleted"].includes(value.resources[key]) &&
      !(key === "artifacts" && value.resources[key] === "orphaned")
    )
      throw new Error("Invalid resource ownership journal.");
  if (
    Object.hasOwn(value.resources, "gateway") &&
    !["pending", "created", "deleted"].includes(value.resources.gateway as string)
  )
    throw new Error("Invalid resource ownership journal.");
  if (Object.hasOwn(value, "ai") && typeof value.ai !== "boolean")
    throw new Error("Invalid environment AI flag.");
  if (Object.hasOwn(value, "quota")) {
    if (!value.quota || typeof value.quota.authority !== "string")
      throw new Error("Invalid pinned environment quota authority.");
    parseEnvironmentLimits({ maximum: 4, authority: value.quota.authority });
    if (!["pending", "reserved", "released"].includes(value.quota.state))
      throw new Error("Invalid environment reservation journal.");
  }
}

function requireGateway(env: Environment): void {
  if (
    (env.resources.vectors !== "deleted" || env.resources.search !== "deleted") &&
    env.resources.gateway !== "created"
  )
    throw new Error(
      "AI environment has no owned AI Gateway; run destroy then setup to recreate it.",
    );
}

const hostedTokens = new Set<string>(
  process.env.GITMATRIX_REMOTE_HOSTED === "1" && process.env.CLOUDFLARE_API_TOKEN
    ? [process.env.CLOUDFLARE_API_TOKEN]
    : [],
);
if (process.env.GITMATRIX_ENVIRONMENT_QUOTA_TOKEN)
  hostedTokens.add(process.env.GITMATRIX_ENVIRONMENT_QUOTA_TOKEN);
export function redact(text: string): string {
  for (const token of hostedTokens) text = text.replaceAll(token, "[REDACTED]");
  return text
    .replace(/\b(?:gmx_|gmj_)[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(Bearer\s+)[^\s"']+/gi, "$1[REDACTED]");
}

/** Unit fixtures must not inherit a live app identity or provider capability. */
export function unitTestEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env))
    if (/^(GITMATRIX_|GM_|CLOUDFLARE_|CF_)/.test(key)) delete env[key];
  return env;
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
  if (childEnv.GITMATRIX_REMOTE_HOSTED === "1") {
    const channel = childEnv.GITMATRIX_REMOTE_CREDENTIALS_FILE;
    if (channel) {
      const { env: credentials } = JSON.parse(await readFile(channel, "utf8")) as {
        env: {
          CLOUDFLARE_API_TOKEN: string;
          CLOUDFLARE_ACCOUNT_ID: string;
          GITMATRIX_ENVIRONMENT_QUOTA_TOKEN?: string;
        };
      };
      if (
        typeof credentials?.CLOUDFLARE_API_TOKEN !== "string" ||
        !credentials.CLOUDFLARE_API_TOKEN ||
        !/^[a-f0-9]{32}$/.test(credentials.CLOUDFLARE_ACCOUNT_ID)
      )
        throw new Error("Hosted Cloudflare credential channel is invalid.");
      if (
        childEnv.CLOUDFLARE_ACCOUNT_ID &&
        childEnv.CLOUDFLARE_ACCOUNT_ID !== credentials.CLOUDFLARE_ACCOUNT_ID
      )
        throw new Error("Hosted Cloudflare credential account changed.");
      hostedTokens.add(credentials.CLOUDFLARE_API_TOKEN);
      if (credentials.GITMATRIX_ENVIRONMENT_QUOTA_TOKEN)
        hostedTokens.add(credentials.GITMATRIX_ENVIRONMENT_QUOTA_TOKEN);
      childEnv.CLOUDFLARE_API_TOKEN = credentials.CLOUDFLARE_API_TOKEN;
      childEnv.CLOUDFLARE_ACCOUNT_ID = credentials.CLOUDFLARE_ACCOUNT_ID;
    }
  }
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
  if (previous && (retired(previous) || previous.status === "deleting")) {
    if (env.status === "ready") env.status = previous.status;
    for (const resource of ["artifacts", "vectors", "search", "gateway"] as const)
      if (previous.resources[resource] === "deleted") env.resources[resource] = "deleted";
  }
  // A stale in-memory copy never moves the journal's reservation backwards (CORE-368).
  const quota = advanceQuota(previous?.quota, env.quota);
  if (quota) env.quota = quota;
  // Central journal survives worktree removal and is committed before local state.
  await privateJson(join(registry, "environments", `${env.id}.json`), env);
  if (process.env.GITMATRIX_REMOTE_HOSTED === "1") {
    // The external journal must commit before any provisioning call: container
    // loss must never erase the only record of resources we may have created.
    const environment = {
      id: env.id,
      account: env.account,
      created: env.created,
      expires: env.expires,
      resources: env.resources,
      status: env.status,
      ai: aiEnabled(env),
      ...(env.quota ? { quota: env.quota } : {}),
    };
    const response = await fetch("http://127.0.0.1:8787/ownership", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Remote ownership journal failed (${response.status}).`);
  }
  if ((await realpath(env.root).catch(() => null)) === env.root) {
    try {
      await safeLocalDirectory(env);
      const local = await recordAt(join(env.dir, "environment.json"));
      if (!local || local.id === env.id || (retired(local) && env.status === "provisioning"))
        await privateJson(join(env.dir, "environment.json"), env);
    } catch (error) {
      if (env.status !== "deleting" && !retired(env)) throw error;
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
  requireGateway(value);
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
  // could be written.
  return withFileLock(join(registry, "registry.lock"), 300, action);
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
/** Pauses before retrying a cleanup call that Cloudflare refused for authentication (CORE-316). */
const AUTH_RETRY_MS = [1_000, 3_000];
function authRefused(error: unknown): boolean {
  return /\b401\b|Authentication error/i.test(String(error));
}
/** Whether `cf` still holds a valid login: a refusal then was transient, not a logout. */
async function loginValid(env: Environment): Promise<boolean> {
  try {
    const identity = JSON.parse(
      await command("cf", ["auth", "whoami", ...(env.profile ? ["--profile", env.profile] : [])], {
        env: cfEnv(env),
      }),
    ) as { authenticated?: boolean; tokenValid?: boolean };
    return identity.authenticated === true && identity.tokenValid === true;
  } catch {
    return false;
  }
}
/**
 * One `cf` call. Cleanup (`retryAuth`) retries a 401 a moment later while the
 * login is still valid: Cloudflare has refused a valid token briefly, failing
 * sweeps that then worked seconds later. A real logout is never retried.
 */
async function cf(env: Environment, args: string[], retryAuth = false): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await command("cf", [...args, ...(env.profile ? ["--profile", env.profile] : [])], {
        env: cfEnv(env),
        timeout: 180_000,
      });
    } catch (error) {
      const wait = AUTH_RETRY_MS[attempt];
      if (!retryAuth || wait === undefined || !authRefused(error) || !(await loginValid(env)))
        throw error;
      console.warn(
        JSON.stringify({
          event: "environment.cleanup_auth_retry",
          id: env.id,
          attempt: attempt + 1,
        }),
      );
      await delay(wait);
    }
  }
}
async function cfJson<T>(env: Environment, args: string[], retryAuth = false): Promise<T> {
  return JSON.parse(await cf(env, args, retryAuth)) as T;
}
function absent(error: unknown): boolean {
  // Only explicit resource absence is idempotent, never permission/network failures.
  return /\b404\b|resource not found|namespace not found|index not found|instance not found|gateway not found/i.test(
    String(error),
  );
}
/** Cloudflare's refusal to delete a namespace that still counts a repository (CORE-302). */
function refusedNotEmpty(error: unknown): boolean {
  return /namespace is not empty/i.test(String(error));
}
async function deleteIfPresent(env: Environment, args: string[]): Promise<void> {
  try {
    await cf(env, args, true);
  } catch (error) {
    if (!absent(error)) throw error;
  }
}

/** Stop a fenced session, not just its launcher: vp may exit before Vite/workerd. */
export async function terminateProcessGroup(pid: number, start?: string): Promise<void> {
  const initial = await processStart(pid);
  if (start !== undefined && initial !== start) return;
  if (initial === null) return;
  const births = new Map<string, string>([[String(pid), initial]]);
  const running = async () => {
    const leader = await processStart(pid);
    if (leader !== null && leader !== initial)
      throw new Error("Process group leader was replaced; refusing to signal it.");
    const members: { pid: string; start: string; state: string }[] = [];
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = await readFile(`/proc/${entry}/stat`, "utf8").catch(() => null);
      if (!stat) continue;
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[2] === String(pid) && fields[3] === String(pid) && fields[19])
        members.push({ pid: entry, start: fields[19], state: fields[0]! });
    }
    if (!members.length) return false;
    if (!members.some((member) => births.get(member.pid) === member.start))
      throw new Error("No fenced process group member remains; refusing to signal a reused group.");
    // Capture descendants before TERM and extend only while an original birth
    // identity anchors the session; a recycled PGID alone is not ownership.
    for (const member of members) births.set(member.pid, member.start);
    // Zombies retain the group identity but cannot execute or hold app ports.
    return members.some((member) => member.state !== "Z");
  };
  const signal = (value: NodeJS.Signals) => {
    try {
      process.kill(-pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  if (!(await running())) return;
  signal("SIGTERM");
  const deadline = Date.now() + 20_000;
  while (await running()) {
    if (Date.now() >= deadline) {
      signal("SIGKILL");
      const killedDeadline = Date.now() + 5_000;
      while (await running()) {
        if (Date.now() >= killedDeadline)
          throw new Error("Owned process group did not stop after SIGKILL; retaining its journal.");
        await delay(100);
      }
      return;
    }
    await delay(100);
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
  await terminateProcessGroup(pid, start);
  delete env.server;
  await persist(env);
}

export async function destroyEnvironment(env: Environment): Promise<void> {
  validateEnvironment(env);
  if (env.status === "deleted") return;
  await stopEnvironment(env);
  if (!retired(env)) env.status = "deleting";
  else if (env.resources.artifacts === "orphaned") env.status = "orphaned";
  await persist(env);
  const failures: string[] = [];
  // Continue independent deletions even if one provider is unavailable.
  for (const resource of ["search", "gateway", "vectors", "artifacts"] as const) {
    if (env.resources[resource] === undefined || env.resources[resource] === "deleted") continue;
    try {
      if (resource === "search") {
        // Parent owns the namespace, including every instance created inside it.
        for (;;) {
          let instances: { id: string }[];
          try {
            instances = await cfJson(
              env,
              ["ai-search", "list", "--name", env.id, "--per-page", "100"],
              true,
            );
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
      } else if (resource === "gateway") {
        await deleteIfPresent(env, ["ai-gateway", "gateways", "delete", env.id, "--force"]);
      } else if (resource === "vectors") {
        await deleteIfPresent(env, ["vectorize", "delete", env.id, "--force"]);
      } else {
        const listed = async () => {
          try {
            return await cfJson<{ name: string }[]>(
              env,
              ["artifacts", "namespaces", "repos", "list", "--namespace", env.id, "--limit", "100"],
              true,
            );
          } catch (error) {
            if (absent(error)) return null;
            throw error;
          }
        };
        for (;;) {
          const repos = await listed();
          if (!repos?.length) break;
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
        try {
          await deleteIfPresent(env, ["artifacts", "namespaces", "delete", env.id, "--force"]);
          delete env.orphan;
        } catch (error) {
          // A known Artifacts bug: the namespace counts a repository that no list
          // shows. Rather than hold a slot forever, orphan it once nothing listable
          // is left: the journal keeps it, and every cleanup retries it.
          if (!refusedNotEmpty(error) || (await listed())?.length) throw error;
          env.resources.artifacts = "orphaned";
          env.orphan ??= {
            namespace: env.id,
            at: new Date().toISOString(),
            reason: redact(String(error)).slice(0, 500),
          };
          await persist(env);
          console.error(
            JSON.stringify({
              event: "environment.orphaned",
              id: env.id,
              namespace: env.id,
              message:
                "Cloudflare refuses to delete this Artifacts namespace although it lists no repositories; its ownership journal is retained for cleanup retries.",
            }),
          );
          continue;
        }
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
        // test-ai's run history outlives environments: --resume and the failure cooldown.
        if (["artifacts", "environment.json", "runs", "test-ai"].includes(name)) continue;
        await rm(join(env.dir, name), { recursive: true, force: true });
      }
    }
  }
  await rm(join(registry, "workspaces", env.id), { recursive: true, force: true });
  // Retire compute capacity only after all other cleanup has succeeded. An
  // unlistable Artifacts orphan remains journaled and retried, not called deleted.
  await releaseQuota(env, persist);
  env.status = env.resources.artifacts === "orphaned" ? "orphaned" : "deleted";
  await persist(env);
  console.log(JSON.stringify({ event: `environment.${env.status}`, id: env.id }));
}

export async function cleanupExpired(): Promise<void> {
  // Best effort, and before taking the registry lock: its network calls must not
  // stall every setup on this machine. Pruning after it stays safe because ids
  // are random and a released reservation is never re-reserved, so a row the
  // listing did not show cannot reappear.
  const listing = await sweepReservations();
  if (!listing)
    console.error(
      JSON.stringify({
        event: "cleanup.prune_skipped",
        message:
          "Reservations could not be listed; deleted journals are kept until a sweep can confirm their reservations are gone.",
      }),
    );
  await registryLock(async () => {
    const failures: string[] = [];
    for (const env of await inventory()) {
      if (env.status === "deleted" && Date.now() - env.expires > 7 * TTL) {
        // A journal whose row may still be reserved stays: it is the only
        // record that can release that row.
        if (prunable(env.quota, env.id, listing))
          await rm(join(registry, "environments", `${env.id}.json`));
        continue;
      }
      // An orphaned namespace is retried on every sweep, expired or not.
      if (
        env.status === "deleted" ||
        (env.status !== "deleting" && env.status !== "orphaned" && env.expires > Date.now())
      )
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

/**
 * Provisions an owned environment, or returns this worktree's existing one.
 * Paid AI resources (AI Gateway, Vectorize, AI Search) only when `ai`.
 */
/**
 * Sweep expired environments before creating one, without letting a stuck one
 * block everyone (CORE-292): a namespace Cloudflare refuses to delete would
 * otherwise stop every agent's setup on the machine. The failing journals stay
 * for the next sweep (hourly maintenance retries them); this reports and goes on.
 */
export async function sweepBeforeCreate(): Promise<void> {
  try {
    await cleanupExpired();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "environment.cleanup_deferred",
        message: "Some expired environments could not be destroyed yet; continuing.",
        detail: String(error instanceof Error ? error.message : error),
      }),
    );
  }
}

export async function createEnvironment(
  root: string,
  ephemeral = false,
  ai = false,
): Promise<Environment> {
  root = await realpath(root);
  await sweepBeforeCreate();
  return registryLock(async () => {
    const existing = await inventory();
    const limits = await readEnvironmentLimits();
    if (!limits.authority)
      throw new Error(
        "Set an explicit shared quota authority before setup: gm settings environments set --local --authority https://YOUR-GITMATRIX. Upgrade/sign in to that authority; there is no offline or 404 fallback.",
      );
    // Adopt legacy journals before admitting anything new. Other hosts must do
    // the same during rollout; a local journal cannot discover offline hosts.
    for (const current of existing)
      if (!retired(current)) await reserveQuota(current, "local", persist);
    if (!ephemeral) {
      const current = existing.find(
        (e) => e.root === root && e.dir === join(root, ".gitmatrix-agent") && !retired(e),
      );
      if (current) {
        if (current.status !== "ready")
          throw new Error("Partial environment exists; run destroy before setup.");
        requireGateway(current);
        if (ai && !aiEnabled(current))
          throw new Error(
            "This worktree's environment has no AI. Run `vp run agent destroy`, then `vp run agent setup --ai`.",
          );
        return current;
      }
    }
    if (existing.filter((e) => !retired(e)).length >= limits.maximum)
      throw new Error(
        `Machine environment limit reached (${limits.maximum}). Destroy unused environments or use gm settings environments set --local --max N. Raising it cannot override the installation quota.`,
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
    const port =
      process.env.GITMATRIX_REMOTE_HOSTED === "1" && !ephemeral ? 5270 : await allocatePort();
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
        gateway: ai ? "pending" : "deleted",
      },
      status: "provisioning",
      ai,
    };
    await persist(env);
    try {
      await reserveQuota(env, "local", persist);
      await cf(env, ["artifacts", "namespaces", "create", "--namespace", id]);
      env.resources.artifacts = "created";
      await persist(env);
      if (ai) {
        await cf(env, [
          "ai-gateway",
          "gateways",
          "create",
          "--body",
          JSON.stringify({
            id,
            authentication: true,
            collect_logs: true,
            cache_ttl: 0,
            cache_invalidate_on_update: false,
            rate_limiting_interval: 0,
            rate_limiting_limit: 0,
            workers_ai_billing_mode: "postpaid",
          }),
        ]);
        env.resources.gateway = "created";
        await persist(env);
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
            ai_gateway_id: id,
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
          ai,
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
  requireGateway(env);
  await registryLock(async () => {
    const current = await recordAt(join(registry, "environments", `${env.id}.json`));
    if (
      (current && current.status !== "ready") ||
      env.status !== "ready" ||
      env.expires <= Date.now()
    )
      throw new Error("Environment is expired or being destroyed; run destroy then setup.");
    // Re-read under the same lock as cleanup, never resurrect a released slot,
    // whether the release is in the journal or only in memory (CORE-368).
    const quota = advanceQuota(current?.quota, env.quota);
    if (quota) env.quota = quota;
    if (quota?.state === "released")
      throw new Error(
        "This environment's installation reservation was already released; run destroy then setup.",
      );
    await reserveQuota(env, "local", persist);
  });
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
  const hosted = process.env.GITMATRIX_REMOTE_HOSTED === "1";
  const preview = hosted && env.dir === join(env.root, ".gitmatrix-agent");
  if (hosted) {
    vars.GITMATRIX_REMOTE_HOSTED = "1";
    vars.GITMATRIX_AGENT_EXECUTION = "local";
    vars.GITMATRIX_REMOTE_CREDENTIALS_FILE = process.env.GITMATRIX_REMOTE_CREDENTIALS_FILE;
    if (preview) {
      const origin = process.env.GITMATRIX_REMOTE_ORIGIN;
      if (!origin || new URL(origin).protocol !== "https:" || new URL(origin).origin !== origin)
        throw new Error("Hosted preview requires an exact HTTPS GITMATRIX_REMOTE_ORIGIN.");
      vars.GITMATRIX_REMOTE_ORIGIN = origin;
    }
  }
  Object.assign(vars, {
    GITMATRIX_AGENT_ID: env.id,
    GITMATRIX_AGENT_SECRET: env.secret,
    GITMATRIX_CI_DISPATCH_SECRET: env.dispatchSecret,
    GITMATRIX_PORT: String(env.port),
    GITMATRIX_PUBLIC_URL: preview ? vars.GITMATRIX_REMOTE_ORIGIN : env.origin,
    GITMATRIX_STATE_DIR: join(env.dir, "state"),
    GITMATRIX_ARTIFACTS_NAMESPACE: env.id,
    GITMATRIX_AGENT_AI: aiEnabled(env) ? "enabled" : "disabled",
    GITMATRIX_VECTORIZE_INDEX: env.id,
    GITMATRIX_SEARCH_NAMESPACE: env.id,
    GITMATRIX_AI_GATEWAY: env.id,
    GITMATRIX_GM: gm,
    GITMATRIX_CI_RUNNER: "local",
    GITMATRIX_CI_RUNNERS: "2",
    // A timeline's full CI and overlays wait for its pushes to pause (CORE-238):
    // seconds here, so scenarios exercise the wait without spending minutes on it.
    GITMATRIX_TIMELINE_QUIET_SECONDS: "3",
    // Main's pushes settle before one Knowledge update (CORE-286): seconds
    // here, unless the caller chose its own (a batching measurement does).
    GITMATRIX_KNOWLEDGE_QUIET_SECONDS: process.env.GITMATRIX_KNOWLEDGE_QUIET_SECONDS ?? "2",
    GITMATRIX_KNOWLEDGE_MAX_WAIT_SECONDS: process.env.GITMATRIX_KNOWLEDGE_MAX_WAIT_SECONDS ?? "8",
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
      ai: aiEnabled(e),
      resources: e.resources,
      ...(e.orphan ? { orphan: e.orphan } : {}),
    }));
}
