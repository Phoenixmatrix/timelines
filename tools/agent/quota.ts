import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { link, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { withFileLock } from "./heavy.ts";

class QuotaResponseError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
/** A refused quota RPC; `status` is the authority's HTTP status when it answered. */
class QuotaRefusal extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}
export interface QuotaReservation {
  authority: string;
  state: "pending" | "reserved" | "released";
}

const progress = { pending: 0, reserved: 1, released: 2 } as const;
/**
 * A reservation only moves forward: pending → reserved → released (CORE-368).
 * Merging a stale copy (an in-memory record, a lagging ownership journal) must
 * never turn an acknowledged release back into a live reservation.
 */
export function advanceQuota(
  previous: QuotaReservation | undefined,
  next: QuotaReservation | undefined,
): QuotaReservation | undefined {
  if (!previous) return next && { ...next };
  if (!next) return { ...previous };
  if (previous.authority !== next.authority)
    throw new Error("Environment quota authority changed; refusing to rewrite its reservation.");
  return progress[next.state] >= progress[previous.state] ? { ...next } : { ...previous };
}

const HOST = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Which machine and OS user this home directory is on: a digest of the Linux
 * machine id and the uid, never sent anywhere. A home copied to another machine
 * (VM or WSL clone, restored backup, dotfile sync) then mints its own host id
 * instead of sharing one, which would let either machine's sweep mistake the
 * other's live reservations for its own orphans. Undefined when the machine has
 * no machine id: such a host records no host at all.
 */
async function machineFingerprint(): Promise<string | undefined> {
  // Test hook: unit fixtures cannot depend on the runner having a machine id.
  const sources = process.env.GITMATRIX_AGENT_MACHINE_ID_FILE
    ? [process.env.GITMATRIX_AGENT_MACHINE_ID_FILE]
    : ["/etc/machine-id", "/var/lib/dbus/machine-id"];
  for (const source of sources) {
    const machine = (await readFile(source, "utf8").catch(() => "")).trim();
    if (machine)
      return createHash("sha256")
        .update(`gitmatrix-agent-host\0${machine}\0${process.getuid?.() ?? ""}`)
        .digest("hex");
  }
  return undefined;
}

/**
 * This machine's stable reservation host id, kept in the agent state directory
 * with the fingerprint of the machine that minted it. Hosted containers have
 * none: their parent's journal covers them, and a child row tagged with the host
 * before that journal learns it would look like this machine's orphan.
 */
export async function hostId(): Promise<string | undefined> {
  if (process.env.GITMATRIX_REMOTE_HOSTED === "1") return undefined;
  const fingerprint = await machineFingerprint();
  if (!fingerprint) return undefined;
  const directory = join(homedir(), ".local", "state", "gitmatrix-agent");
  const path = join(directory, "host.json");
  /** The id on disk if it belongs to this machine; null if absent, empty or another machine's. */
  const current = async (): Promise<string | null> => {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    // Only a file that is provably empty counts as absent.
    if (text === "") return null;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    const id = value && typeof value === "object" && "id" in value ? value.id : undefined;
    if (typeof id !== "string" || !HOST.test(id))
      throw new Error(
        `Unreadable reservation host id in ${path}; remove it to mint a new one (this machine's existing reservations then list as foreign).`,
      );
    const minted = value && typeof value === "object" && "machine" in value ? value.machine : null;
    return minted === fingerprint ? id : null;
  };
  // Fast path: an id already minted on this machine needs no lock.
  const existing = await current();
  if (existing) return existing;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Minting is serialized: without the kernel lock, a process replacing a stale
  // file could delete an id another process had just published and handed out.
  return withFileLock(join(directory, "host.lock"), 60, async () => {
    const settled = await current();
    if (settled) return settled;
    // Absent, provably empty, or minted on another machine: rows recorded under
    // that old id now list as foreign, never as this machine's orphans.
    const present = await readFile(path).then(
      () => true,
      () => false,
    );
    // Complete content is published atomically, so lock-free readers never see
    // a partial file: link() creates it, rename() replaces a stale one.
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(
        temporary,
        JSON.stringify({ id: randomBytes(16).toString("hex"), machine: fingerprint }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      if (present) await rename(temporary, path);
      else
        await link(temporary, path).catch((error: NodeJS.ErrnoException) => {
          // Published by a process outside this lock: everyone uses that one.
          if (error.code !== "EEXIST") throw error;
        });
    } finally {
      await rm(temporary, { force: true });
    }
    const minted = await current();
    if (!minted) throw new Error(`Could not establish a reservation host id in ${path}.`);
    return minted;
  });
}
export interface QuotaOwner {
  id: string;
  root: string;
  account: string;
  expires: number;
  quota?: QuotaReservation;
}

export function parseEnvironmentLimits(value: unknown): { maximum: number; authority?: string } {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("maximum" in value) ||
    typeof value.maximum !== "number" ||
    !Number.isInteger(value.maximum) ||
    value.maximum < 0 ||
    value.maximum > 2147483647
  )
    throw new Error(
      "Invalid machine environment maximum; use gm settings environments set --local --max N (0–2147483647).",
    );
  const authority = "authority" in value ? value.authority : undefined;
  if (authority !== undefined) {
    if (typeof authority !== "string") throw new Error("Invalid environment quota authority.");
    const url = new URL(authority);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== authority
    )
      throw new Error(
        "Environment quota authority must be an http(s) origin without credentials or a path.",
      );
  }
  return { maximum: value.maximum, authority: authority as string | undefined };
}

async function quotaCredentials(): Promise<{ authority?: string; token?: string }> {
  let source: NodeJS.ProcessEnv = process.env;
  if (source.GITMATRIX_REMOTE_HOSTED === "1" && source.GITMATRIX_REMOTE_CREDENTIALS_FILE) {
    let channel;
    try {
      channel = JSON.parse(await readFile(source.GITMATRIX_REMOTE_CREDENTIALS_FILE, "utf8"));
    } catch {
      throw new Error("Hosted quota credential channel is unreadable or invalid.");
    }
    if (!channel?.env || typeof channel.env !== "object" || Array.isArray(channel.env))
      throw new Error("Hosted quota credential channel is invalid.");
    source = channel.env;
  }
  const authority = source.GITMATRIX_ENVIRONMENT_QUOTA_AUTHORITY;
  const token = source.GITMATRIX_ENVIRONMENT_QUOTA_TOKEN;
  if (
    authority !== undefined ||
    token !== undefined ||
    process.env.GITMATRIX_REMOTE_HOSTED === "1"
  ) {
    if (typeof authority !== "string" || !authority || typeof token !== "string" || !token.trim())
      throw new Error("Explicit environment quota authority and token are required together.");
    parseEnvironmentLimits({ maximum: 4, authority });
  }
  return { authority, token };
}

export async function readEnvironmentLimits(): Promise<{ maximum: number; authority?: string }> {
  let limits: { maximum: number; authority?: string } = { maximum: 4 };
  try {
    limits = parseEnvironmentLimits(
      JSON.parse(
        await readFile(
          join(homedir(), ".local", "state", "gitmatrix-agent", "limits.json"),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (process.env.GITMATRIX_REMOTE_HOSTED === "1")
    return { maximum: limits.maximum, authority: (await quotaCredentials()).authority };
  return limits;
}

const execute = promisify(execFile);

function quotaResponseError(status: number, message: unknown): QuotaResponseError {
  if (status === 409) {
    const capacity =
      typeof message === "string"
        ? /^Installation environment limit reached \((0|[1-9][0-9]{0,9})\/(0|[1-9][0-9]{0,9})\)\. Destroy unused environments on their owning machines, or ask a site administrator to change gm settings environments set --site --max\. Expired reservations still require cleanup\.$/.exec(
            message,
          )
        : null;
    if (capacity && Number(capacity[1]) <= 2147483647 && Number(capacity[2]) <= 2147483647)
      return new QuotaResponseError(
        `Installation environment limit reached (${Number(capacity[1])}/${Number(capacity[2])}). Destroy unused environments on their owning machines, or ask a site administrator to change gm settings environments set --site --max. Expired reservations still require cleanup.`,
      );
    if (message === "Environment reservation belongs to a different owner or configuration.")
      return new QuotaResponseError(
        "Environment reservation belongs to a different owner or configuration. Inspect the owning environment's journal and resolve the reservation conflict before retrying.",
      );
    return new QuotaResponseError(
      "Quota request conflicted (409); no recognized capacity diagnostic.",
    );
  }
  if (status === 401 || status === 403)
    return new QuotaResponseError(
      `Quota authorization failed (${status}). Sign in to the pinned authority with an identity permitted to manage this reservation.`,
    );
  return new QuotaResponseError(`Quota request failed (${status}).`, status);
}

function subprocessQuotaError(error: unknown): never {
  // gm -o json emits { error: { code, message, ... } } on stderr.
  // Parse only that envelope; arbitrary text, hints and stdout are never diagnostics.
  if (error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string") {
    let diagnostic;
    try {
      diagnostic = JSON.parse(error.stderr);
    } catch {
      throw error;
    }
    const detail = diagnostic?.error;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const status =
        detail.code === "conflict"
          ? 409
          : detail.code === "unauthenticated"
            ? 401
            : detail.code === "forbidden"
              ? 403
              : // gm reports other HTTP failures as server_error "HTTP <status>: …".
                detail.code === "server_error" &&
                  typeof detail.message === "string" &&
                  detail.message.startsWith("HTTP 400:")
                ? 400
                : undefined;
      if (status !== undefined) throw quotaResponseError(status, detail.message);
    }
  }
  throw error;
}
/** One authenticated quota RPC to a pinned authority; returns its parsed JSON body. */
async function quotaCall(
  authority: string,
  root: string | undefined,
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown> {
  parseEnvironmentLimits({ maximum: 4, authority });
  try {
    const credentials = await quotaCredentials();
    if (credentials.token) {
      const configured = (await readEnvironmentLimits()).authority;
      if (credentials.authority !== authority || configured !== authority)
        throw new QuotaResponseError(
          "Quota credential authority does not match the pinned reservation.",
        );
      const response = await fetch(`${authority}/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${credentials.token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) {
        const diagnostic: unknown = await response.json().catch(() => null);
        throw quotaResponseError(
          response.status,
          diagnostic && typeof diagnostic === "object" && "error" in diagnostic
            ? diagnostic.error
            : undefined,
        );
      }
      try {
        return await response.json();
      } catch {
        throw new QuotaResponseError("Quota authority did not return a JSON acknowledgement.");
      }
    }
    const quotaEnv: NodeJS.ProcessEnv = { ...process.env, GM_SERVER: authority, NO_COLOR: "1" };
    delete quotaEnv.GM_TOKEN;
    delete quotaEnv.GITMATRIX_TOKEN;
    const { stdout } = await execute(
      "gm",
      [
        "-o",
        "json",
        "api",
        method,
        path,
        ...(body === undefined ? [] : ["--data", JSON.stringify(body)]),
      ],
      {
        cwd:
          root !== undefined && (await realpath(root).catch(() => null)) === root
            ? root
            : homedir(),
        env: quotaEnv,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    ).catch(subprocessQuotaError);
    try {
      return JSON.parse(stdout);
    } catch {
      throw new QuotaResponseError("Quota authority did not return a JSON acknowledgement.");
    }
  } catch (error) {
    // Subprocess output and HTTP bodies can contain credentials; never echo them.
    const detail =
      error instanceof QuotaResponseError
        ? error.message
        : "Quota transport or credentials unavailable. Check the quota API and sign in to the pinned authority with gm before retrying cleanup/setup.";
    throw new QuotaRefusal(
      `Environment quota authority ${authority} refused ${method}. No admission fallback is allowed. ${detail}`,
      error instanceof QuotaResponseError ? error.status : undefined,
    );
  }
}

async function quotaRequest(
  record: QuotaOwner,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<{ removed?: boolean }> {
  if (!record.quota) throw new Error("Environment has no pinned quota authority.");
  const authority = record.quota.authority;
  const path = `/environments/reservations${method === "DELETE" ? `/${record.id}` : ""}`;
  const acknowledgement = await quotaCall(authority, record.root, method, path, body);
  const action = method === "POST" ? "reserved" : "released";
  if (
    !acknowledgement ||
    typeof acknowledgement !== "object" ||
    Array.isArray(acknowledgement) ||
    !("id" in acknowledgement) ||
    acknowledgement.id !== record.id ||
    !(action in acknowledgement) ||
    Reflect.get(acknowledgement, action) !== true ||
    ("removed" in acknowledgement && typeof acknowledgement.removed !== "boolean")
  )
    throw new Error(
      `Environment quota authority ${authority} refused ${method}. No admission fallback is allowed. Quota authority did not acknowledge ${action}: true for ${record.id}.`,
    );
  return "removed" in acknowledgement ? { removed: acknowledgement.removed as boolean } : {};
}

export interface ListedReservation {
  id: string;
  backend?: string;
  expires?: number;
  /** Null on rows reserved by older clients, hosted children, or an older server. */
  host?: string | null;
  createdAt?: string;
}

/** The signed-in owner's installation reservations at one authority. */
export async function listReservations(
  authority: string,
  root?: string,
): Promise<ListedReservation[]> {
  const value = await quotaCall(authority, root, "GET", "/environments");
  const rows =
    value && typeof value === "object" && "reservations" in value ? value.reservations : undefined;
  if (
    !Array.isArray(rows) ||
    rows.some(
      (row: unknown) =>
        !row ||
        typeof row !== "object" ||
        !("id" in row) ||
        typeof row.id !== "string" ||
        ("host" in row && row.host !== null && typeof row.host !== "string"),
    )
  )
    throw new Error(
      `Environment quota authority ${authority} returned an invalid reservation list.`,
    );
  return (rows as ListedReservation[]).map(({ id, backend, expires, host, createdAt }) => ({
    id,
    backend,
    expires,
    host: host ?? null,
    createdAt,
  }));
}

/**
 * Release a listed row that no journal here can release (reconciliation only).
 * Returns whether the authority removed it; older authorities count as removed.
 */
export async function releaseListedReservation(authority: string, id: string): Promise<boolean> {
  const { removed } = await quotaRequest(
    { id, root: homedir(), account: "", expires: 0, quota: { authority, state: "reserved" } },
    "DELETE",
  );
  return removed ?? true;
}

// A call, not an inline check: TypeScript keeps a property narrowed across `await persist()`.
function released(quota: QuotaReservation | undefined): boolean {
  return quota?.state === "released";
}

export async function reserveQuota<T extends QuotaOwner>(
  record: T,
  backend: "local" | "remote",
  persist: (record: T) => Promise<void>,
): Promise<void> {
  if (record.quota?.state === "released")
    throw new Error("A released environment reservation cannot be reused; destroy then setup.");
  if (!record.quota) {
    const { authority } = await readEnvironmentLimits();
    if (!authority)
      throw new Error(
        "Configure the shared installation quota authority first: gm settings environments set --local --authority https://YOUR-GITMATRIX. Local/scoped test credentials never select an authority implicitly.",
      );
    record.quota = { authority, state: "pending" };
  }
  // Journal precedes every RPC, including a retry after publication failed.
  await persist(record);
  // persist may have merged an acknowledged release from the journal on disk;
  // a POST now would resurrect that slot (CORE-368).
  if (released(record.quota))
    throw new Error("A released environment reservation cannot be reused; destroy then setup.");
  const body = { id: record.id, account: record.account, backend, expires: record.expires };
  const host = await hostId();
  try {
    await quotaRequest(record, "POST", host ? { ...body, host } : body);
  } catch (error) {
    // An authority older than CORE-368 rejects the unknown `host` field (400).
    // Admission still needs its own matching acknowledgement; the row merely
    // records no host, which reconciliation treats conservatively as foreign.
    if (!host || !(error instanceof QuotaRefusal) || error.status !== 400) throw error;
    await quotaRequest(record, "POST", body);
  }
  record.quota!.state = "reserved";
  await persist(record);
}

export async function releaseQuota<T extends QuotaOwner>(
  record: T,
  persist: (record: T) => Promise<void>,
): Promise<void> {
  if (!record.quota || record.quota.state === "released") return;
  const { removed } = await quotaRequest(record, "DELETE");
  // An older authority omits `removed`; its acknowledgement stays authoritative.
  // `removed: false` means nothing matched: confirm the row is really gone
  // before recording a release we cannot otherwise distinguish from a no-op.
  if (
    removed === false &&
    (await listReservations(record.quota.authority, record.root)).some(
      (row) => row.id === record.id,
    )
  )
    throw new Error(
      `Environment quota authority ${record.quota.authority} acknowledged releasing ${record.id} but still lists it; the reservation is retained for retry.`,
    );
  record.quota.state = "released";
  await persist(record);
}
