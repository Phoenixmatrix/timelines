import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, rename, writeFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import {
  parseEnvironmentLimits,
  readEnvironmentLimits,
  reserveQuota,
  releaseQuota,
} from "./quota.ts";
import type { QuotaReservation } from "./quota.ts";

export type Execution = "local" | "cloudflare";
export interface OwnedResources {
  id: string;
  account: string;
  expires?: number;
  quota?: QuotaReservation;
  resources: Record<string, "pending" | "created" | "deleted" | "orphaned">;
}
export interface RemoteEnvironment {
  version: 1;
  id: string;
  root: string;
  account: string;
  profile?: string;
  origin?: string;
  token: string;
  previewToken: string;
  created: number;
  expires: number;
  status: "provisioning" | "ready" | "stopped" | "deleting" | "deleted";
  installed: boolean;
  workerDeleted?: boolean;
  containerApplicationId?: string;
  teardownPhase?: "worker-delete";
  resources: OwnedResources[];
  quota?: QuotaReservation;
  lastProcess?: string;
}
export const remoteRegistry = join(homedir(), ".local", "state", "gitmatrix-agent", "remote");
const sessionPattern = /^gmr-[a-f0-9]{24}$/;
const accountPattern = /^[a-f0-9]{32}$/;

export function selectExecution(
  cli: string | undefined,
  env: string | undefined,
  config: unknown,
  pinned?: Execution,
): Execution {
  for (const value of [cli, env, config]) {
    if (value !== undefined && value !== "local" && value !== "cloudflare")
      throw new Error("Execution must be local or cloudflare.");
  }
  const explicit = cli ?? env ?? config;
  if (pinned && explicit !== undefined && explicit !== pinned)
    throw new Error(
      `This worktree owns a ${pinned} environment; destroy it before switching execution mode.`,
    );
  return (explicit ?? pinned ?? "local") as Execution;
}

export function validateOwnedResources(value: OwnedResources, account: string): void {
  if (
    !value ||
    !/^gma-[a-z0-9]+-[a-f0-9]{12}$/.test(value.id) ||
    value.account !== account ||
    !value.resources ||
    typeof value.resources !== "object"
  )
    throw new Error("Invalid remote resource ownership record.");
  for (const [key, state] of Object.entries(value.resources)) {
    if (
      !["artifacts", "vectors", "search", "gateway"].includes(key) ||
      !["pending", "created", "deleted", "orphaned"].includes(state)
    )
      throw new Error("Invalid remote resource ownership state.");
  }
  if (value.quota !== undefined) {
    validateQuota(value.quota);
    if (!Number.isFinite(value.expires)) throw new Error("Invalid child quota expiry.");
  }
}
function validateQuota(quota: QuotaReservation): void {
  if (!quota || typeof quota.authority !== "string")
    throw new Error("Invalid remote quota authority.");
  parseEnvironmentLimits({ maximum: 0, authority: quota.authority });
  if (!["pending", "reserved", "released"].includes(quota.state))
    throw new Error("Invalid remote quota reservation.");
}

export function remoteOutstanding(record: RemoteEnvironment): boolean {
  return (
    record.status !== "deleted" ||
    (!!record.quota && record.quota.state !== "released") ||
    record.resources.some((owned) => !!owned.quota && owned.quota.state !== "released")
  );
}

export async function remoteQuotaAuthority(record?: RemoteEnvironment): Promise<string> {
  const authority = record?.quota?.authority ?? (await readEnvironmentLimits()).authority;
  if (!authority)
    throw new Error("Configure the installation quota authority before remote setup.");
  const url = new URL(authority);
  if (
    url.protocol !== "https:" ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "[::1]" ||
    url.hostname.startsWith("127.") ||
    url.hostname === "0.0.0.0"
  )
    throw new Error(
      "Remote execution requires a hosted-reachable HTTPS quota authority; loopback authorities are unsupported.",
    );
  return authority;
}
export function validateRemoteEnvironment(value: RemoteEnvironment): void {
  if (
    !value ||
    value.version !== 1 ||
    !sessionPattern.test(value.id) ||
    !isAbsolute(value.root) ||
    !accountPattern.test(value.account) ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    !/^[a-f0-9]{64}$/.test(value.previewToken) ||
    !Number.isFinite(value.created) ||
    !Number.isFinite(value.expires) ||
    value.expires <= value.created ||
    value.expires - value.created > 86_400_000 ||
    !["provisioning", "ready", "stopped", "deleting", "deleted"].includes(value.status) ||
    typeof value.installed !== "boolean" ||
    (value.workerDeleted !== undefined && typeof value.workerDeleted !== "boolean") ||
    (value.containerApplicationId !== undefined &&
      !/^[a-f0-9]{32}$/.test(value.containerApplicationId)) ||
    (value.teardownPhase !== undefined && value.teardownPhase !== "worker-delete") ||
    (value.teardownPhase !== undefined && !["deleting", "deleted"].includes(value.status)) ||
    !Array.isArray(value.resources)
  )
    throw new Error("Invalid remote environment ownership journal; refusing resource operations.");
  if (value.quota !== undefined) validateQuota(value.quota);
  if (value.origin) {
    const url = new URL(value.origin);
    if (
      url.protocol !== "https:" ||
      url.origin !== value.origin ||
      !url.hostname.startsWith(`${value.id}.`) ||
      !url.hostname.endsWith(".workers.dev")
    )
      throw new Error("Remote origin is not this environment's isolated workers.dev host.");
  }
  for (const resource of value.resources) validateOwnedResources(resource, value.account);
  if (
    value.teardownPhase === "worker-delete" &&
    value.resources.some((owned) =>
      Object.values(owned.resources).some((state) => state !== "deleted"),
    )
  )
    throw new Error("Worker deletion requires completed owned resource cleanup.");
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error(`Remote journal directory must be private and owned by this user: ${path}`);
}
export async function privateJson(path: string, value: unknown): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}
export async function inventory(): Promise<RemoteEnvironment[]> {
  const directory = join(remoteRegistry, "environments");
  const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records: RemoteEnvironment[] = [];
  for (const name of names.filter((name) => name.endsWith(".json"))) {
    const path = join(directory, name);
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Unsafe remote ownership journal permissions.");
    const record = JSON.parse(await readFile(path, "utf8")) as RemoteEnvironment;
    validateRemoteEnvironment(record);
    if (name !== `${record.id}.json`)
      throw new Error("Remote ownership journal filename mismatch.");
    records.push(record);
  }
  return records;
}
export async function currentRemote(root: string): Promise<RemoteEnvironment | undefined> {
  return (await inventory()).find((record) => record.root === root && remoteOutstanding(record));
}
export async function persistRemote(record: RemoteEnvironment): Promise<void> {
  validateRemoteEnvironment(record);
  await privateJson(join(remoteRegistry, "environments", `${record.id}.json`), record);
}

function unadmittedLegacyRemote(record: RemoteEnvironment): boolean {
  return (
    record.status !== "deleted" &&
    (!record.quota ||
      record.resources.some(
        (owned) =>
          !owned.quota && Object.values(owned.resources).some((state) => state !== "deleted"),
      ))
  );
}

/** The caller holds this root's lifecycle lock. Never rewrite another root's journal. */
export async function ensureRemoteAdmission(record: RemoteEnvironment): Promise<void> {
  await remoteQuotaAuthority(record);
  if (unadmittedLegacyRemote(record))
    throw new Error(
      "Legacy remote resources have no installation admission record; destroy that environment on its owning host, then setup again.",
    );
  if (record.status === "deleted")
    throw new Error("Remote quota cleanup remains pending; destroy or cleanup before setup.");
  // Hosted children own their admission. A cached reserved child may already
  // have released through its external journal; replaying POST would resurrect it.
  await reserveQuota(record, "remote", persistRemote);
}

/** A failed first deployment retains its identity, secrets, quota slot and absolute deadline. */
export async function ensureRemoteDeployment(
  record: RemoteEnvironment,
  deploy: (record: RemoteEnvironment) => Promise<void>,
  now = Date.now(),
): Promise<void> {
  validateRemoteEnvironment(record);
  if (record.expires <= now || record.status === "deleting" || record.status === "deleted")
    throw new Error("Remote environment expired or deleting; destroy it before setup.");
  await ensureRemoteAdmission(record);
  if (record.origin) return;
  if (record.status !== "provisioning" || record.installed || record.resources.length !== 0)
    throw new Error("Remote deployment journal is incomplete; refusing to replace unknown state.");
  await deploy(record);
}

/** Release a hosted child's slot from the host, journaling it in the parent's record. */
async function releaseChild(
  record: RemoteEnvironment,
  owned: OwnedResources,
  persist: (record: RemoteEnvironment) => Promise<void>,
  release: typeof releaseQuota = releaseQuota,
): Promise<void> {
  if (!owned.quota) return;
  const owner = {
    id: owned.id,
    account: owned.account,
    root: record.root,
    expires: owned.expires!,
    quota: owned.quota,
  };
  await release(owner, async () => {
    owned.quota = owner.quota;
    await persist(record);
  });
}

const resourceProgress = { pending: 0, created: 1, orphaned: 2, deleted: 3 } as const;
/**
 * Merge a collected child's resource states onto the host's: a state only moves
 * forward (pending, created, orphaned, deleted). A lagging ownership record, such
 * as a lost container's, never undoes a deletion the host already made (CORE-374).
 */
export function advanceResources(
  previous: OwnedResources["resources"] | undefined,
  next: OwnedResources["resources"],
): OwnedResources["resources"] {
  const merged = { ...next };
  for (const [key, state] of Object.entries(previous ?? {})) {
    const current = merged[key];
    if (current === undefined || resourceProgress[state] > resourceProgress[current])
      merged[key] = state;
  }
  return merged;
}

/**
 * Whether a child still holds a slot or any resource that is not deleted. A
 * child its container already retired as orphaned (CORE-302: slot released, only
 * an Artifacts namespace Cloudflare refuses to delete) holds no slot; that
 * namespace belongs to orphan handling, not to retiring on every setup.
 */
function childOutstanding(owned: OwnedResources): boolean {
  if (owned.quota && owned.quota.state !== "released") return true;
  const released = owned.quota?.state === "released";
  return Object.entries(owned.resources).some(
    ([key, state]) =>
      state !== "deleted" && !(released && key === "artifacts" && state === "orphaned"),
  );
}

/**
 * Retire hosted children whose container lost its disk (CORE-374). Inside the
 * container their journals are gone, so nothing there can ever destroy them.
 *
 * `live` lists the journal ids on the container's current disk. It must be
 * listed AFTER `record` was last collected, with no collection in between: a
 * child writes its journal before its ownership record (environment.ts persist),
 * so a collected child absent from that later listing has no journal left. That
 * is never true of a child mid-setup on the current disk.
 *
 * Each stale child's resources are deleted first, persisting each; only then is
 * its slot released. A child whose deletion fails keeps its resources and its
 * slot; the others still proceed. Parent teardown deletes the same resources
 * before releasing anything, so a namespace Cloudflare refuses to delete
 * (CORE-302) also fails the parent's destroy: it stays `deleting`, retried by the
 * hourly cleanup, and holds both slots until Cloudflare allows the delete.
 */
export async function retireStaleChildren(
  record: RemoteEnvironment,
  live: ReadonlySet<string>,
  actions: {
    persist: (record: RemoteEnvironment) => Promise<void>;
    /** Delete one child's resources, persisting each; throw when any remains. */
    removeChild: (owned: OwnedResources) => Promise<void>;
    log: (event: Record<string, unknown>) => void;
    release?: typeof releaseQuota;
  },
): Promise<{ retired: string[]; failed: string[] }> {
  validateRemoteEnvironment(record);
  const retired: string[] = [];
  const failed: string[] = [];
  for (const owned of record.resources) {
    if (live.has(owned.id) || !childOutstanding(owned)) continue;
    actions.log({
      event: "remote.child_stale",
      parent: record.id,
      id: owned.id,
      resources: { ...owned.resources },
      ...(owned.quota ? { quota: owned.quota.state } : {}),
    });
    try {
      await actions.removeChild(owned);
      if (Object.values(owned.resources).some((state) => state !== "deleted"))
        throw new Error("Child resources remain after cleanup.");
      await releaseChild(record, owned, actions.persist, actions.release);
      retired.push(owned.id);
      actions.log({
        event: "remote.child_released",
        parent: record.id,
        id: owned.id,
        ...(owned.quota ? { quota: owned.quota.state } : {}),
      });
    } catch (error) {
      failed.push(owned.id);
      actions.log({
        event: "remote.child_retire_failed",
        parent: record.id,
        id: owned.id,
        resources: { ...owned.resources },
        ...(owned.quota ? { quota: owned.quota.state } : {}),
        message: error instanceof Error ? error.message : String(error),
        note: "Its resources and reservation stay journaled; parent destroy retries the deletion and releases the slot only once it succeeds.",
      });
    }
  }
  return { retired, failed };
}

/** Commit the last runtime-dependent cleanup before deleting its only endpoint. */
export async function teardownRemote(
  record: RemoteEnvironment,
  actions: {
    persist: (record: RemoteEnvironment) => Promise<void>;
    collectOwnership: () => Promise<void>;
    stop: () => Promise<void>;
    removeResources: () => Promise<void>;
    deleteWorker: () => Promise<void>;
    deleteApplication: () => Promise<void>;
  },
): Promise<void> {
  validateRemoteEnvironment(record);
  record.status = "deleting";
  await actions.persist(record);
  if (record.teardownPhase !== "worker-delete") {
    if (record.origin && !record.workerDeleted) {
      // Failure is not evidence of absence: preserve the runtime and its journal.
      await actions.collectOwnership();
      await actions.stop();
      await actions.collectOwnership();
    }
    await actions.removeResources();
    record.teardownPhase = "worker-delete";
    // Persist before cf: an interrupted successful delete must not need the Worker.
    await actions.persist(record);
  }
  if (!record.workerDeleted) {
    await actions.deleteWorker();
    record.workerDeleted = true;
    await actions.persist(record);
  }
  // Worker deletion leaves its separately billed Container application behind.
  await actions.deleteApplication();
  for (const owned of record.resources) await releaseChild(record, owned, actions.persist);
  await releaseQuota(record, actions.persist);
  record.status = "deleted";
  await actions.persist(record);
}

/** A kernel lock releases even on abrupt client exit, unlike PID-file locks. */
export async function remoteLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  await privateDirectory(remoteRegistry);
  const path = join(remoteRegistry, `${createHash("sha256").update(key).digest("hex")}.lock`);
  const child = spawn(
    "flock",
    [
      "-w",
      "300",
      path,
      process.execPath,
      "-e",
      'process.stdout.write("locked\\n");process.stdin.resume()',
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const exited = Promise.withResolvers<void>();
  const locked = Promise.withResolvers<void>();
  child.once("error", exited.reject);
  child.once("exit", (code) =>
    code === 0 ? exited.resolve() : exited.reject(new Error("Remote environment lock failed.")),
  );
  child.stdout.once("data", () => locked.resolve());
  // Attach the rejection immediately, including errors before acquiring the lock.
  void exited.promise.catch(() => {});
  await Promise.race([
    locked.promise,
    exited.promise.then(() => {
      throw new Error("Remote environment lock exited before acquisition.");
    }),
  ]);
  try {
    return await action();
  } finally {
    child.stdin.end();
    await exited.promise;
  }
}
export async function allocateRemote(
  root: string,
  account: string,
  profile?: string,
): Promise<RemoteEnvironment> {
  root = await realpath(root);
  return remoteLock("quota", async () => {
    const records = await inventory();
    if (records.some((record) => record.root === root && remoteOutstanding(record)))
      throw new Error("Remote environment already exists; use it or destroy it before setup.");
    await remoteQuotaAuthority();
    if (records.some(unadmittedLegacyRemote))
      throw new Error(
        "Legacy remote resources have no installation admission record; destroy those environments on their owning hosts before allocating another.",
      );
    const created = Date.now();
    const record: RemoteEnvironment = {
      version: 1,
      id: `gmr-${randomBytes(12).toString("hex")}`,
      root,
      account,
      profile,
      token: randomBytes(32).toString("hex"),
      previewToken: randomBytes(32).toString("hex"),
      created,
      expires: created + 86_400_000,
      status: "provisioning",
      installed: false,
      resources: [],
    };
    await persistRemote(record);
    await reserveQuota(record, "remote", persistRemote);
    return record;
  });
}
