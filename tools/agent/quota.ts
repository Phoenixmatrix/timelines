import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

class QuotaResponseError extends Error {}
export interface QuotaReservation {
  authority: string;
  state: "pending" | "reserved" | "released";
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
async function quotaRequest(
  record: QuotaOwner,
  method: "POST" | "DELETE",
  body?: unknown,
): Promise<void> {
  if (!record.quota) throw new Error("Environment has no pinned quota authority.");
  const authority = record.quota.authority;
  parseEnvironmentLimits({ maximum: 4, authority });
  const path = `/environments/reservations${method === "DELETE" ? `/${record.id}` : ""}`;
  try {
    const credentials = await quotaCredentials();
    let acknowledgement: unknown;
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
      if (!response.ok) throw new QuotaResponseError(`Quota request failed (${response.status}).`);
      try {
        acknowledgement = await response.json();
      } catch {
        throw new QuotaResponseError("Quota authority did not return a JSON acknowledgement.");
      }
    } else {
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
            (await realpath(record.root).catch(() => null)) === record.root
              ? record.root
              : homedir(),
          env: quotaEnv,
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      try {
        acknowledgement = JSON.parse(stdout);
      } catch {
        throw new QuotaResponseError("Quota authority did not return a JSON acknowledgement.");
      }
    }
    const action = method === "POST" ? "reserved" : "released";
    if (
      !acknowledgement ||
      typeof acknowledgement !== "object" ||
      Array.isArray(acknowledgement) ||
      !("id" in acknowledgement) ||
      acknowledgement.id !== record.id ||
      !(action in acknowledgement) ||
      Reflect.get(acknowledgement, action) !== true
    )
      throw new QuotaResponseError(
        `Quota authority did not acknowledge ${action}: true for ${record.id}.`,
      );
  } catch (error) {
    // Subprocess output and HTTP bodies can contain credentials; never echo them.
    const detail =
      error instanceof QuotaResponseError
        ? error.message
        : "Quota transport or credentials unavailable.";
    throw new Error(
      `Environment quota authority ${authority} refused ${method}. No admission fallback is allowed. Deploy the environment quota API, sign in to that authority with gm, and retry cleanup/setup. ${detail}`,
    );
  }
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
  await quotaRequest(record, "POST", {
    id: record.id,
    account: record.account,
    backend,
    expires: record.expires,
  });
  record.quota.state = "reserved";
  await persist(record);
}

export async function releaseQuota<T extends QuotaOwner>(
  record: T,
  persist: (record: T) => Promise<void>,
): Promise<void> {
  if (!record.quota || record.quota.state === "released") return;
  await quotaRequest(record, "DELETE");
  record.quota.state = "released";
  await persist(record);
}
