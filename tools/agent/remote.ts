import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Duplex } from "node:stream";
import {
  allocateRemote,
  currentRemote,
  inventory,
  persistRemote,
  remoteLock,
  validateOwnedResources,
  validateRemoteEnvironment,
  teardownRemote,
  ensureRemoteDeployment,
  remoteOutstanding,
  remoteQuotaAuthority,
  ensureRemoteAdmission,
} from "./remote-environment.ts";
import type { RemoteEnvironment, OwnedResources } from "./remote-environment.ts";
import { syncSources, retrieveArtifact } from "./remote-sync.ts";
import type { RemoteRequest } from "./remote-protocol.ts";
import { writeRemoteBuild } from "./remote-build.ts";
import { installRemoteMaintenance } from "./maintenance.ts";
import { advanceQuota, readEnvironmentLimits } from "./quota.ts";
import { parseReservationArgs, reconcileReservations, sweepReservations } from "./reservations.ts";

const secrets = new Set<string>();
const help = `Cloudflare execution (local agents/source; remote tooling, no local app build)
  node tools/agent/entry.ts --execution cloudflare <command>
  setup [--ai] | up | status | sync | run -- <argv> | logs [process-id]
  check [--dry-run] | test | test-ai [options] | seed | gm -- <args>
  exec -- <argv> | inspect [db|registry] [SQL] | debug [local-port]
  artifacts <remote-path> <destination-outside-worktree>
  stop | reset [--ai] | destroy | cleanup --expired
  maintenance reservations [--release [--expired]]
check uses normal readiness selection; missing remote base history selects full coverage.
Requires Node 24+, git, flock and authenticated cf CLI only. No local install/build.
Mode: --execution > GITMATRIX_AGENT_EXECUTION > .gitmatrix/development.json > local;
existing ownership pins execution until destroy. Never falls back to local tools.
One standard-4 container per worktree; installation-wide quota admission;
24-hour absolute compute lifetime. Running containers, Worker/DO requests/storage,
Artifacts and opt-in AI incur normal Cloudflare charges, even while disconnected.
Stop discards the remote disk; setup reinstalls it. Destroy removes owned resources.
Expiry stops compute only; cleanup --expired removes Worker and owned app resources.
cf's current access token is trusted to the disposable runtime; refresh credentials
stay on this host. Connected commands renew the credential channel through cf;
connected up restarts the app when its access token changes.
Sources only upload; generated artifacts require an explicit safe destination.
`;

function safeMessage(error: unknown): string {
  let text = error instanceof Error ? error.message : "Remote operation failed.";
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text.replace(/(Bearer\s+)\S+/gi, "$1[redacted]");
}
/** Keep a suffix so a credential split between log pages is never printed. */
function logWriter(): (text: string, done?: boolean) => void {
  let pending = "";
  return (text, done = false) => {
    pending += text;
    let keep = 256;
    for (const secret of secrets) keep = Math.max(keep, secret.length);
    let end = done ? pending.length : Math.max(0, pending.length - keep);
    for (const secret of secrets) {
      let start = pending.indexOf(secret);
      while (start >= 0 && start < end) {
        if (start + secret.length > end) end = start;
        start = pending.indexOf(secret, start + 1);
      }
    }
    process.stdout.write(safeMessage(new Error(pending.slice(0, end))));
    pending = pending.slice(end);
  };
}
async function cf(
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; profile?: string } = {},
): Promise<string> {
  if (process.env.CLOUDFLARE_API_TOKEN) secrets.add(process.env.CLOUDFLARE_API_TOKEN);
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const child = spawn("cf", [...args, ...(options.profile ? ["--profile", options.profile] : [])], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let diagnostic = "";
  child.stdout.on("data", (data: Buffer) => {
    output += data.toString();
    if (output.length > 32 * 1024 * 1024) child.kill();
  });
  child.stderr.on("data", (data: Buffer) => {
    diagnostic = (diagnostic + data.toString()).slice(-8000);
  });
  child.once("error", () =>
    reject(
      new Error(
        "cf CLI is unavailable; install/authenticate cf on the host. No local fallback is allowed.",
      ),
    ),
  );
  child.once("close", (code) =>
    code === 0
      ? resolve(output.trim())
      : reject(
          new Error(
            safeMessage(
              new Error(`cf ${args.slice(0, 3).join(" ")} failed (${code}): ${diagnostic}`),
            ),
          ),
        ),
  );
  return promise;
}
interface Credentials {
  token: string;
  account: string;
  expires?: number;
}
export async function quotaCredentials(
  record?: RemoteEnvironment,
): Promise<Record<string, string>> {
  const authority = await remoteQuotaAuthority(record);
  const url = new URL(authority);
  const explicitToken = process.env.GITMATRIX_ENVIRONMENT_QUOTA_TOKEN;
  const explicitAuthority = process.env.GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY;
  if (explicitToken !== undefined || explicitAuthority !== undefined) {
    if (
      !explicitToken ||
      explicitAuthority !== authority ||
      (await readEnvironmentLimits()).authority !== authority
    )
      throw new Error("Quota credential authority does not match the selected reservation.");
    secrets.add(explicitToken);
    return {
      GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY: authority,
      GITMATRIX_ENVIRONMENT_QUOTA_TOKEN: explicitToken,
    };
  }
  const quotaEnv: NodeJS.ProcessEnv = { ...process.env, GM_SERVER: authority };
  delete quotaEnv.GM_TOKEN;
  delete quotaEnv.GITMATRIX_TOKEN;
  const child = spawn("gm", ["auth", "git-credential", "get"], {
    cwd: record?.root,
    env: quotaEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text: string) => {
    output += text;
  });
  // Never surface credential-helper diagnostics or output.
  child.stderr.resume();
  const done = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  child.stdin.end(`protocol=${url.protocol.slice(0, -1)}\nhost=${url.host}\n\n`);
  const code = await done;
  const token = /^password=(.+)$/m.exec(output)?.[1];
  if (code !== 0 || !token)
    throw new Error(
      "gm auth git-credential did not provide a quota authority credential; sign in to the selected authority.",
    );
  secrets.add(token);
  return {
    GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY: authority,
    GITMATRIX_ENVIRONMENT_QUOTA_TOKEN: token,
  };
}
export function credentialFile(authSource: string): string | undefined {
  const match = /(?:OAuth token|API token) from (.+)$/.exec(authSource);
  if (!match) return undefined;
  if (!isAbsolute(match[1]!)) throw new Error("cf reported a non-absolute credential file.");
  return match[1];
}
export async function authenticate(
  record?: RemoteEnvironment,
  run: typeof cf = cf,
): Promise<Credentials> {
  const profile = record?.profile ?? process.env.GITMATRIX_CF_PROFILE;
  for (let attempt = 0; attempt < 2; attempt++) {
    // whoami acquires OAuth through cf's refresh-and-persist path. cf refreshes at
    // actual expiry, not our former 60-second margin; never refresh OAuth ourselves.
    const identity = JSON.parse(await run(["auth", "whoami"], { profile })) as {
      authenticated?: boolean;
      tokenValid?: boolean;
      authSource?: string;
      accounts?: { id: string }[];
    };
    if (!identity.authenticated || !identity.tokenValid)
      throw new Error("Current cf authentication is invalid; remote execution fails closed.");
    const accounts = identity.accounts ?? [];
    const account =
      record?.account ??
      process.env.CLOUDFLARE_ACCOUNT_ID ??
      (accounts.length === 1 ? accounts[0]?.id : undefined);
    if (!account || !accounts.some((item) => item.id === account))
      throw new Error("Choose an authorized development account with CLOUDFLARE_ACCOUNT_ID.");
    const source = identity.authSource ?? "";
    const path = credentialFile(source);
    let token: string | undefined;
    let expires: number | undefined;
    if (path) {
      // Read the persisted current access token AFTER cf's operation; never export refresh_token.
      const data = JSON.parse(await readFile(path, "utf8")) as {
        oauth_token?: string;
        api_token?: string;
        expiration_time?: string;
      };
      token = source.startsWith("OAuth") ? data.oauth_token : data.api_token;
      if (data.expiration_time) expires = Date.parse(data.expiration_time);
    } else if (/CLOUDFLARE_API_TOKEN/.test(source)) token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token || (expires !== undefined && !Number.isFinite(expires)))
      throw new Error(
        "cf did not expose a usable current access token; remote execution fails closed.",
      );
    if (expires !== undefined && expires <= Date.now()) {
      // The token can expire between whoami and this read. Let cf handle that race once.
      if (source.startsWith("OAuth") && attempt === 0) continue;
      throw new Error("cf did not renew the expired access token; remote execution fails closed.");
    }
    secrets.add(token);
    return { token, account, expires };
  }
  throw new Error("cf authentication could not establish a current access token.");
}

export function nextCredentialRefresh(credentials: Credentials, now = Date.now()): number {
  return Math.min(now + 30_000, credentials.expires ?? Infinity);
}

export class RemoteResponseError extends Error {
  readonly status: number;
  constructor(status: number, method: string, path: string) {
    super(`Remote ${method} ${path.split("?")[0]} failed (${status}); no local fallback.`);
    this.status = status;
  }
}

export function remoteRequest(
  record: RemoteEnvironment,
  timing: {
    now: () => number;
    pause: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  } = {
    now: Date.now,
    pause: (milliseconds, signal) => delay(milliseconds, undefined, { signal }),
  },
): RemoteRequest {
  if (!record.origin)
    throw new Error(
      "Remote Worker was not deployed; destroy this partial environment before setup.",
    );
  const origin = record.origin;
  secrets.add(record.token);
  secrets.add(record.previewToken);
  return async (path, init = {}, replay) => {
    const pathname = path.split("?", 1)[0]!;
    if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes(".."))
      throw new Error("Invalid remote control path.");
    const deadline = Math.min(timing.now() + 30_000, record.expires);
    const callerSignal = init.signal;
    let current = init;
    let recoverySignal: AbortSignal | undefined;
    for (let attempt = 0; ; attempt++) {
      callerSignal?.throwIfAborted();
      recoverySignal?.throwIfAborted();
      const headers = new Headers(current.headers);
      headers.set("authorization", `Bearer ${record.token}`);
      const response = await fetch(`${origin}/__remote${path}`, {
        ...current,
        headers,
        signal: recoverySignal ?? callerSignal,
        redirect: "error",
      });
      if (response.ok) return response;
      // Only the observed edge route-propagation response is safe to replay.
      // Runtime failures are JSON; never inspect or echo arbitrary error bodies.
      const edgeNotFound =
        response.status === 404 &&
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
          "text/html" &&
        Boolean(response.headers.get("cf-ray"));
      await response.body?.cancel();
      const error = new RemoteResponseError(response.status, init.method ?? "GET", path);
      const backoff = 250 * 2 ** attempt;
      if (
        !edgeNotFound ||
        attempt === 5 ||
        (current.body instanceof ReadableStream && !replay) ||
        timing.now() + backoff >= deadline
      )
        throw error;
      if (!recoverySignal) {
        const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(deadline - timing.now())));
        recoverySignal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
      }
      await timing.pause(backoff, recoverySignal);
      recoverySignal.throwIfAborted();
      if (timing.now() >= deadline) throw error;
      if (replay) current = replay();
    }
  };
}

/** Only fresh read-only readiness also tolerates Worker/DO attachment propagation. */
export async function waitForRemoteDeployment(
  record: RemoteEnvironment,
  request: RemoteRequest,
  pause: (milliseconds: number, signal?: AbortSignal) => Promise<void> = (milliseconds, signal) =>
    delay(milliseconds, undefined, { signal }),
): Promise<void> {
  // All probes and their edge retries share this deadline, rather than restarting it.
  const signal = AbortSignal.timeout(30_000);
  for (let attempt = 0; attempt < 30; attempt++) {
    signal.throwIfAborted();
    try {
      const response = await request("/status", { signal });
      const status: unknown = await response.json();
      if (
        !status ||
        typeof status !== "object" ||
        !("expiresAt" in status) ||
        status.expiresAt !== record.expires ||
        !("running" in status) ||
        typeof status.running !== "boolean"
      )
        throw new Error(
          "Deployed remote status does not match this environment's absolute expiry.",
        );
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof RemoteResponseError) ||
        (error.status !== 404 && (error.status < 500 || error.status >= 600))
      )
        throw error;
      if (attempt === 29)
        throw new Error("Remote deployment route is not ready; origin retained. Retry setup.");
    }
    await pause(2000, signal);
  }
}
async function json<T>(
  request: RemoteRequest,
  path: string,
  body?: unknown,
  method = "POST",
): Promise<T> {
  const response = await request(
    path,
    body === undefined
      ? {}
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  return response.json() as Promise<T>;
}
async function collectOwnership(record: RemoteEnvironment, request: RemoteRequest): Promise<void> {
  const data = await json<{ environments: OwnedResources[] }>(request, "/ownership");
  if (!Array.isArray(data.environments))
    throw new Error("Invalid remote resource metadata response.");
  for (const item of data.environments) {
    validateOwnedResources(item, record.account);
    const clean: OwnedResources = {
      id: item.id,
      account: item.account,
      resources: { ...item.resources },
      ...(item.expires !== undefined ? { expires: item.expires } : {}),
      ...(item.quota ? { quota: { ...item.quota } } : {}),
    };
    const index = record.resources.findIndex((old) => old.id === item.id);
    const previous = record.resources[index];
    if (previous?.quota) {
      if (clean.quota && clean.quota.authority !== previous.quota.authority)
        throw new Error("Remote child quota authority changed; refusing ownership replacement.");
      // Forward-only: a lagging ownership record never undoes a reservation
      // or release this host already recorded (CORE-368).
      const quota = advanceQuota(previous.quota, clean.quota)!;
      if (!clean.quota || quota.state !== clean.quota.state) clean.expires = previous.expires;
      clean.quota = quota;
    }
    if (index < 0) record.resources.push(clean);
    else record.resources[index] = clean;
  }
  await persistRemote(record);
}
async function publishCredentials(
  request: RemoteRequest,
  credentials: Credentials,
  record: RemoteEnvironment,
): Promise<void> {
  await json(request, "/credentials", {
    env: {
      CLOUDFLARE_API_TOKEN: credentials.token,
      CLOUDFLARE_ACCOUNT_ID: credentials.account,
      ...(await quotaCredentials(record)),
    },
  });
}
async function launch(
  record: RemoteEnvironment,
  request: RemoteRequest,
  argv: string[],
  kind = "foreground",
): Promise<string> {
  const credentials = await authenticate(record);
  await publishCredentials(request, credentials, record);
  const id = randomBytes(16).toString("hex");
  await json(request, "/commands", {
    id,
    argv,
    cwd: "/workspace/repo",
    kind,
    env: {
      CLOUDFLARE_API_TOKEN: credentials.token,
      CLOUDFLARE_ACCOUNT_ID: credentials.account,
      GITMATRIX_REMOTE_HOSTED: "1",
      GITMATRIX_REMOTE_ORIGIN: record.origin,
      GITMATRIX_AGENT_EXECUTION: "local",
      // Match CI's non-deploy build contract; hosted workspaces do not run Docker.
      GITMATRIX_CONTAINER_IMAGES: "skip",
    },
    timeoutMs: Math.max(1, record.expires - Date.now()),
  });
  record.lastProcess = id;
  await persistRemote(record);
  console.log(
    JSON.stringify({
      event: "remote.command",
      id,
      reconnect: `node tools/agent/entry.ts logs ${id}`,
    }),
  );
  return id;
}
interface LogChunk {
  text: string;
  nextOffset: number;
  done: boolean;
  exitCode?: number;
}
export function commandExit(chunk: LogChunk): number {
  if (
    !chunk.done ||
    !Number.isInteger(chunk.exitCode) ||
    chunk.exitCode! < 0 ||
    chunk.exitCode! > 255
  )
    throw new Error("Remote command ended without a valid exit status; refusing to infer success.");
  return chunk.exitCode!;
}
async function follow(
  record: RemoteEnvironment,
  request: RemoteRequest,
  id: string,
  locked = false,
): Promise<number> {
  let offset = 0;
  let nextAuth = 0;
  const write = logWriter();
  try {
    for (;;) {
      const chunk = await json<LogChunk>(
        request,
        `/processes/${encodeURIComponent(id)}/logs?offset=${offset}`,
      );
      write(chunk.text, chunk.done);
      if (!Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset < offset)
        throw new Error("Invalid remote log cursor.");
      offset = chunk.nextOffset;
      if (locked) await collectOwnership(record, request);
      else
        await remoteLock(record.root, async () => {
          const current = await currentRemote(record.root);
          if (current && current.id === record.id) await collectOwnership(current, request);
        });
      if (chunk.done) return commandExit(chunk);
      if (Date.now() >= nextAuth) {
        const refresh = async () => {
          const credentials = await authenticate(record);
          await publishCredentials(request, credentials, record);
          nextAuth = nextCredentialRefresh(credentials);
        };
        // Setup already owns this non-reentrant lock for the whole command.
        if (locked) await refresh();
        else await remoteLock(record.root, refresh);
      }
      await delay(750);
    }
  } finally {
    write("", true);
  }
}
async function deploy(record: RemoteEnvironment, root: string): Promise<void> {
  const env = { CLOUDFLARE_ACCOUNT_ID: record.account };
  const data = JSON.parse(
    await cf(["workers", "deployments", "list", "--worker", "gitmatrix"], {
      env,
      profile: record.profile,
    }),
  ) as { deployments: { versions: { version_id: string; percentage: number }[] }[] };
  const version = data.deployments[0]?.versions.toSorted((a, b) => b.percentage - a.percentage)[0];
  if (!version)
    throw new Error(
      "No deployed CI image is available; remote mode will not build Docker locally.",
    );
  const detail = JSON.parse(
    await cf(["workers", "versions", "get", version.version_id, "--worker-id", "gitmatrix"], {
      env,
      profile: record.profile,
    }),
  ) as { containers?: { images: { default?: string } }[] };
  const image = detail.containers?.[0]?.images.default;
  if (!image || !/@sha256:[a-f0-9]{64}$/.test(image))
    throw new Error(
      "The deployed CI image is not digest-pinned; refusing a local build or mutable image.",
    );
  const directory = await mkdtemp(join(tmpdir(), "gitmatrix-remote-"));
  try {
    const path = join(directory, "secrets.json");
    await writeFile(
      path,
      JSON.stringify({ CONTROL_TOKEN: record.token, PREVIEW_TOKEN: record.previewToken }),
      { mode: 0o600, flag: "wx" },
    );
    secrets.add(record.token);
    secrets.add(record.previewToken);
    await writeRemoteBuild(root, directory, record, image);
    const output = await cf(["deploy", "--prebuilt", "--secrets-file", path], {
      cwd: directory,
      profile: record.profile,
      env,
    });
    const origin = output.match(
      new RegExp(`https://${record.id}\\.[a-z0-9-]+\\.workers\\.dev`),
    )?.[0];
    if (!origin)
      throw new Error(
        "Worker deployed but cf did not report its isolated workers.dev origin; journal retained for destroy.",
      );
    record.origin = origin;
    await persistRemote(record);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function removeOwned(record: RemoteEnvironment): Promise<void> {
  const options = { profile: record.profile, env: { CLOUDFLARE_ACCOUNT_ID: record.account } };
  const failures: string[] = [];
  const remove = async (args: string[]) => {
    try {
      await cf(args, options);
    } catch (error) {
      if (!cfApiNotFound(safeMessage(error))) throw error;
    }
  };
  for (const owned of record.resources) {
    validateOwnedResources(owned, record.account);
    for (const resource of ["search", "gateway", "vectors", "artifacts"]) {
      if (!owned.resources[resource] || owned.resources[resource] === "deleted") continue;
      try {
        if (resource === "search") {
          for (;;) {
            let items: { id: string }[];
            try {
              items = JSON.parse(
                await cf(["ai-search", "list", "--name", owned.id, "--per-page", "100"], options),
              ) as { id: string }[];
            } catch (error) {
              if (cfApiNotFound(safeMessage(error))) break;
              throw error;
            }
            if (!items.length) break;
            for (const item of items)
              await remove(["ai-search", "delete", item.id, "--name", owned.id, "--force"]);
          }
          await remove(["ai-search", "namespace", "delete", owned.id, "--force"]);
        } else if (resource === "gateway")
          await remove(["ai-gateway", "gateways", "delete", owned.id, "--force"]);
        else if (resource === "vectors") await remove(["vectorize", "delete", owned.id, "--force"]);
        else {
          for (;;) {
            let repos: { name: string }[];
            try {
              repos = JSON.parse(
                await cf(
                  [
                    "artifacts",
                    "namespaces",
                    "repos",
                    "list",
                    "--namespace",
                    owned.id,
                    "--limit",
                    "100",
                  ],
                  options,
                ),
              ) as { name: string }[];
            } catch (error) {
              if (cfApiNotFound(safeMessage(error))) break;
              throw error;
            }
            if (!repos.length) break;
            for (const repo of repos)
              await remove([
                "artifacts",
                "namespaces",
                "repos",
                "delete",
                repo.name,
                "--namespace",
                owned.id,
                "--force",
              ]);
          }
          await remove(["artifacts", "namespaces", "delete", owned.id, "--force"]);
        }
        owned.resources[resource] = "deleted";
        await persistRemote(record);
      } catch (error) {
        failures.push(`${owned.id}/${resource}: ${safeMessage(error)}`);
      }
    }
  }
  if (failures.length)
    throw new Error(`Remote resource cleanup remains pending:\n${failures.join("\n")}`);
}

/** Match the one account-scoped application belonging to this random session. */
export function ownedContainerApplication(
  record: RemoteEnvironment,
  value: unknown,
): string | undefined {
  if (!Array.isArray(value) || value.length > 1)
    throw new Error("Ambiguous Container application ownership; cleanup remains pending.");
  if (value.length === 0) return undefined;
  const application: unknown = value[0];
  if (
    !application ||
    typeof application !== "object" ||
    !("id" in application) ||
    typeof application.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(application.id) ||
    !("name" in application) ||
    application.name !== record.id ||
    !("account_id" in application) ||
    application.account_id !== record.account ||
    !("scheduling_policy" in application) ||
    application.scheduling_policy !== "durable_object" ||
    (record.containerApplicationId !== undefined &&
      application.id !== record.containerApplicationId)
  )
    throw new Error("Container application ownership mismatch; cleanup remains pending.");
  return application.id;
}

export async function deleteRemoteApplication(
  record: RemoteEnvironment,
  run: typeof cf = cf,
  persist: typeof persistRemote = persistRemote,
): Promise<void> {
  validateRemoteEnvironment(record);
  const options = { profile: record.profile, env: { CLOUDFLARE_ACCOUNT_ID: record.account } };
  const lookup = async () =>
    ownedContainerApplication(
      record,
      JSON.parse(await run(["containers", "applications", "list", "--name", record.id], options)),
    );
  const id = await lookup();
  if (!id) return;
  if (record.containerApplicationId === undefined) {
    record.containerApplicationId = id;
    // Pin the observed ID before mutation, including interrupted no-origin deployments.
    await persist(record);
  }
  try {
    await run(["containers", "applications", "delete", id, "--force"], options);
  } catch (error) {
    if (!cfApiNotFound(safeMessage(error))) throw error;
  }
  if (await lookup())
    throw new Error(
      "Container application deletion is not yet confirmed; cleanup remains pending.",
    );
}

async function destroy(record: RemoteEnvironment): Promise<void> {
  await authenticate(record);
  await teardownRemote(record, {
    persist: persistRemote,
    collectOwnership: () => collectOwnership(record, remoteRequest(record)),
    stop: async () => {
      await json(remoteRequest(record), "/stop", {});
    },
    removeResources: () => removeOwned(record),
    deleteWorker: async () => {
      try {
        await cf(["workers", "delete", record.id, "--force"], {
          profile: record.profile,
          env: { CLOUDFLARE_ACCOUNT_ID: record.account },
        });
      } catch (error) {
        if (!cfApiNotFound(safeMessage(error))) throw error;
      }
    },
    deleteApplication: () => deleteRemoteApplication(record),
  });
  console.log(JSON.stringify({ event: "remote.destroyed", id: record.id }));
}

/** cf renders HTTP API failures with this title and status, unlike transport failures. */
export function cfApiNotFound(diagnostic: string): boolean {
  return /\bAPIError\b/.test(diagnostic) && /\b404 Not Found\b/.test(diagnostic);
}

async function inspector(record: RemoteEnvironment, port: number): Promise<void> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Inspector local port must be 1024–65535.");
  const capability = randomBytes(24).toString("hex");
  const base = `http://127.0.0.1:${port}/${capability}`;
  const sockets = new Set<Duplex>();
  const permitted = (
    url: string | undefined,
    host: string | undefined,
    origin: string | undefined,
  ) =>
    host === `127.0.0.1:${port}` &&
    url?.startsWith(`/${capability}/`) &&
    (!origin || origin === `http://127.0.0.1:${port}` || origin === "devtools://devtools");
  const server = createServer(async (req, res) => {
    if (!permitted(req.url, req.headers.host, req.headers.origin) || req.method !== "GET") {
      res.writeHead(403).end();
      return;
    }
    try {
      const path = req.url!.slice(capability.length + 1);
      const response = await remoteRequest(record)(`/ports/9229${path}`);
      const text = await response.text();
      const rewritten = text
        .replace(
          /wss?:\/\/[^"\s]+?(\/[^"\s]*)/g,
          (_match, target: string) =>
            `ws://127.0.0.1:${port}/${capability}${target.replace(/^\/__remote\/ports\/9229/, "")}`,
        )
        .replaceAll("/workspace/repo", record.root);
      res.writeHead(response.status, {
        "content-type": response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      res.end(rewritten);
    } catch {
      res.writeHead(502).end("Remote inspector unavailable");
    }
  });
  server.on("upgrade", (req, socket, head) => {
    if (!permitted(req.url, req.headers.host, req.headers.origin)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const target = new URL(
      `/__remote/ports/9229${req.url!.slice(capability.length + 1)}`,
      record.origin,
    );
    const upstream = httpsRequest(target, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": req.headers["sec-websocket-key"] ?? "",
        "sec-websocket-version": "13",
        authorization: `Bearer ${record.token}`,
      },
    });
    upstream.on("upgrade", (response, remote, remoteHead) => {
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${response.headers["sec-websocket-accept"]}\r\n\r\n`,
      );
      if (head.length) remote.write(head);
      if (remoteHead.length) socket.write(remoteHead);
      remote.pipe(socket);
      socket.pipe(remote);
      remote.on("error", () => socket.destroy());
      socket.on("error", () => remote.destroy());
      socket.on("close", () => remote.destroy());
    });
    upstream.on("response", () => socket.destroy());
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(port, "127.0.0.1", listening.resolve);
  await listening.promise;
  console.log(
    JSON.stringify({
      event: "remote.inspector",
      discovery: `${base}/json/list`,
      sourceMapping: { remote: "/workspace/repo", local: record.root },
      note: "Use the returned webSocketDebuggerUrl with Chrome DevTools. Proxy has a local-only capability URL.",
    }),
  );
  const closed = Promise.withResolvers<void>();
  const close = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
    server.closeAllConnections();
    closed.resolve();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  await closed.promise;
  process.off("SIGINT", close);
  process.off("SIGTERM", close);
}

export async function remoteMain(root: string, args: string[]): Promise<void> {
  const [operation = "help", ...rest] = args;
  try {
    if (operation === "help" || operation === "--help") {
      console.log(help);
      return;
    }
    if (operation === "status") {
      for (const record of await inventory()) {
        if (!remoteOutstanding(record)) continue;
        let runtime: unknown;
        try {
          runtime = record.origin ? await json(remoteRequest(record), "/status") : undefined;
        } catch (error) {
          runtime = { error: safeMessage(error) };
        }
        console.log(
          JSON.stringify(
            {
              execution: "cloudflare",
              id: record.id,
              root: record.root,
              origin: record.origin,
              status: record.status,
              expires: new Date(record.expires).toISOString(),
              resources: record.resources,
              runtime,
              quota: record.quota,
              limits: { profile: "standard-4", admission: "installation-wide", lifetimeHours: 24 },
              costs:
                "Running container + Worker/DO + owned Artifacts and opt-in AI. Expiry stops compute; cleanup removes resources.",
            },
            null,
            2,
          ),
        );
      }
      return;
    }
    if (operation === "cleanup") {
      if (rest.length !== 1 || rest[0] !== "--expired") throw new Error("Use cleanup --expired.");
      const failures: string[] = [];
      for (const record of await inventory())
        if (
          remoteOutstanding(record) &&
          (record.expires <= Date.now() ||
            record.status === "deleting" ||
            record.status === "deleted")
        ) {
          try {
            await remoteLock(record.root, () => destroy(record));
          } catch (error) {
            failures.push(`${record.id}: ${safeMessage(error)}`);
          }
        }
      // Best effort: release rows whose journals are released or gone (CORE-368).
      await sweepReservations();
      if (failures.length) throw new Error(failures.join("\n"));
      return;
    }
    if (operation === "maintenance") {
      if (rest[0] !== "reservations")
        throw new Error("Use maintenance reservations [--release [--expired]].");
      const { release, expired } = parseReservationArgs(rest.slice(1));
      console.log(JSON.stringify(await reconcileReservations(release, { expired }), null, 2));
      return;
    }
    if (operation === "destroy" || operation === "reset") {
      await remoteLock(root, async () => {
        const record = await currentRemote(root);
        if (record) await destroy(record);
      });
      if (operation === "destroy") return;
      return await remoteMain(root, ["setup", ...rest]);
    }
    if (operation === "setup") {
      if (rest.some((arg) => arg !== "--ai")) throw new Error("Use setup [--ai].");
      await remoteLock(root, async () => {
        let record = await currentRemote(root);
        const credentials = await authenticate(record);
        await quotaCredentials(record);
        await installRemoteMaintenance(root);
        if (!record) {
          record = await allocateRemote(
            root,
            credentials.account,
            process.env.GITMATRIX_CF_PROFILE,
          );
        }
        await ensureRemoteDeployment(record, (owned) => deploy(owned, root));
        const request = remoteRequest(record);
        if (record.status === "provisioning") await waitForRemoteDeployment(record, request);
        await json(request, "/start", {});
        await publishCredentials(request, credentials, record);
        await syncSources(root, request);
        const installation = await launch(record, request, ["vp", "install"]);
        const installCode = await follow(record, request, installation, true);
        if (installCode) {
          process.exitCode = installCode;
          return;
        }
        record.installed = true;
        await persistRemote(record);
        const id = await launch(record, request, ["node", "tools/agent/main.ts", "setup", ...rest]);
        const code = await follow(record, request, id, true);
        if (code) {
          process.exitCode = code;
          return;
        }
        record.status = "ready";
        await persistRemote(record);
        console.log(
          JSON.stringify({
            event: "remote.ready",
            id: record.id,
            origin: record.origin,
            expires: record.expires,
          }),
        );
      });
      return;
    }
    let record = await currentRemote(root);
    if (!record) throw new Error("No owned remote environment; run setup first.");
    const request = remoteRequest(record);
    if (operation === "logs") {
      const id = rest[0] ?? record.lastProcess;
      if (!id) throw new Error("No process to reconnect; provide its id.");
      process.exitCode = await follow(record, request, id);
      return;
    }
    if (operation === "artifacts") {
      if (rest.length !== 2)
        throw new Error("Use artifacts <remote-path> <destination-outside-worktree>.");
      await retrieveArtifact(root, request, rest[0]!, rest[1]!);
      return;
    }
    if (operation === "debug") {
      await inspector(record, Number(rest[0] ?? 9230));
      return;
    }
    if (operation === "stop") {
      await remoteLock(root, async () => {
        record = (await currentRemote(root))!;
        await collectOwnership(record, request);
        await json(request, "/stop", {});
        await collectOwnership(record, request);
        record.status = "stopped";
        record.installed = false;
        await persistRemote(record);
      });
      return;
    }
    if (record.status !== "ready" || record.expires <= Date.now())
      throw new Error(
        "Remote runtime is not ready or expired; use setup after stop, or destroy then setup after expiry.",
      );
    let credentials = await authenticate(record);
    let id = "";
    await remoteLock(root, async () => {
      record = (await currentRemote(root))!;
      await ensureRemoteAdmission(record);
      await publishCredentials(request, credentials, record);
      const synced = await syncSources(root, request);
      if (operation === "sync") {
        console.log(JSON.stringify({ event: "remote.synced", ...synced }));
        return;
      }
      let argv: string[];
      if (operation === "run") {
        argv = rest[0] === "--" ? rest.slice(1) : rest;
        if (!argv.length) throw new Error("Use run -- <argv>.");
      } else {
        if (
          !["up", "check", "test", "test-ai", "seed", "gm", "exec", "inspect"].includes(operation)
        )
          throw new Error(`Unknown remote command ${operation}.\n${help}`);
        if (operation === "up" && rest.length)
          throw new Error("Remote up takes no flags; Docker/host runners never run locally.");
        const options = [...rest];
        if (
          (operation === "check" ||
            (operation === "test-ai" &&
              !options.some((arg) => arg === "--stage" || arg.startsWith("--stage=")))) &&
          !options.includes("--all")
        )
          options.push("--all");
        argv = ["node", "tools/agent/main.ts", operation, ...options];
      }
      if (operation === "up") {
        const status = await json<{ processes: { id: string; kind: string; status: string }[] }>(
          request,
          "/status",
        );
        const running = status.processes.find(
          (item) => item.kind === "app" && item.status === "running",
        );
        if (running) {
          // Reconnecting always relaunches with the newly validated access token.
          await json(request, `/processes/${running.id}/stop`, {});
        }
      }
      id = await launch(record, request, argv, operation === "up" ? "app" : "foreground");
    });
    if (operation === "sync") return;
    if (operation !== "up") {
      process.exitCode = await follow(record, request, id);
      return;
    }
    const ticket = await json<{ url: string }>(request, "/preview-ticket", {});
    console.log(
      JSON.stringify({
        event: "remote.preview",
        url: ticket.url,
        note: "Single-use authenticated preview. Disconnect leaves remote app running; stop/destroy are explicit.",
      }),
    );
    let offset = 0;
    const write = logWriter();
    let nextAuth = nextCredentialRefresh(credentials);
    let connected = true;
    const disconnect = () => {
      connected = false;
    };
    process.once("SIGINT", disconnect);
    process.once("SIGTERM", disconnect);
    try {
      while (connected) {
        const chunk = await json<LogChunk>(request, `/processes/${id}/logs?offset=${offset}`);
        write(chunk.text, chunk.done);
        if (!Number.isSafeInteger(chunk.nextOffset) || chunk.nextOffset < offset)
          throw new Error("Invalid remote log cursor.");
        offset = chunk.nextOffset;
        if (chunk.done) {
          process.exitCode = commandExit(chunk);
          break;
        }
        await remoteLock(root, async () => {
          record = (await currentRemote(root))!;
          if (record.status !== "ready") {
            connected = false;
            return;
          }
          await collectOwnership(record, request);
          if (Date.now() >= nextAuth) {
            const refreshed = await authenticate(record);
            await publishCredentials(request, refreshed, record);
            if (refreshed.token !== credentials.token) {
              await json(request, `/processes/${id}/stop`, {});
              write("", true);
              id = await launch(record, request, ["node", "tools/agent/main.ts", "up"], "app");
              offset = 0;
              console.log(
                JSON.stringify({
                  event: "remote.credentials-refreshed",
                  appRestarted: true,
                  note: "Preview and inspector briefly disconnect; reconnect after the app restarts.",
                }),
              );
            }
            credentials = refreshed;
            nextAuth = nextCredentialRefresh(refreshed);
          }
          const status = await json<{ processes: { kind: string; status: string }[] }>(
            request,
            "/status",
          );
          if (
            !status.processes.some(
              (item) => item.kind === "foreground" && item.status === "running",
            )
          )
            await syncSources(root, request);
        });
        await delay(2000);
      }
    } catch (error) {
      // Fail closed if the connected host can no longer validate access.
      await json(request, `/processes/${id}/stop`, {}).catch(() => {});
      throw error;
    } finally {
      write("", true);
      process.off("SIGINT", disconnect);
      process.off("SIGTERM", disconnect);
    }
  } catch (error) {
    throw new Error(safeMessage(error));
  }
}
