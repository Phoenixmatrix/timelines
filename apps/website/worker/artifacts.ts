import type { GitRef } from "../shared/api.ts";
import { lsRefsRequest, parseLsRefs, type LsRefsEntry } from "./git/pktline.ts";
import { retrying, UPSTREAM_TIMEOUT_MS, withTimeout } from "./retry.ts";

const TOKEN_TTL_SECONDS = 60 * 60;
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Opaque, storage-only name; the owner/name people see lives in D1. */
export function newArtifactsName(): string {
  return `r-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

interface CachedToken {
  secret: string;
  expiresAt: number;
}

// Minting a token is a control-plane call (rate limited per namespace), so each
// isolate reuses a repo's token until it is close to expiring.
const tokenCache = new Map<string, CachedToken>();

export async function upstreamToken(
  env: Env,
  artifactsName: string,
  scope: "read" | "write",
): Promise<string> {
  const key = `${artifactsName}:${scope}`;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return cached.secret;
  // A pending binding call cannot be shared with a different request's lifetime.
  // An extra token from a retried call is harmless; it expires unused.
  const created = await retrying(
    async () => {
      // Binding calls take no AbortSignal: bounded by racing a timer instead.
      using repo = await withTimeout(env.ARTIFACTS.get(artifactsName), UPSTREAM_TIMEOUT_MS);
      return await withTimeout(repo.createToken(scope, TOKEN_TTL_SECONDS), UPSTREAM_TIMEOUT_MS);
    },
    { retryable: isTransientArtifactsError, label: "Artifacts token", context: { artifactsName } },
  );
  const token = { secret: created.plaintext, expiresAt: Date.parse(created.expiresAt) };
  tokenCache.set(key, token);
  return token.secret;
}

export function forgetUpstreamTokens(artifactsName: string): void {
  tokenCache.delete(`${artifactsName}:read`);
  tokenCache.delete(`${artifactsName}:write`);
}

export interface RepoRefs {
  /** The branch HEAD points to, even when it has no commits yet. */
  headBranch: string | null;
  head: string | null;
  branches: GitRef[];
  tags: GitRef[];
}

/**
 * The binding has no ref listing, so ask the git endpoint directly with a
 * protocol v2 `ls-refs` command.
 */
export async function listRefs(env: Env, artifactsName: string, remote: string): Promise<RepoRefs> {
  const refs = await lsRefs(env, artifactsName, remote);
  const result: RepoRefs = { headBranch: null, head: null, branches: [], tags: [] };
  for (const ref of refs) {
    if (ref.name === "HEAD") {
      result.head = ref.oid;
      result.headBranch = ref.symrefTarget?.replace(/^refs\/heads\//, "") ?? null;
    } else if (ref.oid && ref.name.startsWith("refs/heads/")) {
      result.branches.push({
        name: ref.name,
        shortName: ref.name.slice(11),
        kind: "branch",
        oid: ref.oid,
      });
    } else if (ref.oid && ref.name.startsWith("refs/tags/")) {
      result.tags.push({
        name: ref.name,
        shortName: ref.name.slice(10),
        kind: "tag",
        oid: ref.peeled ?? ref.oid,
      });
    }
  }
  result.branches.sort((a, b) => a.shortName.localeCompare(b.shortName));
  result.tags.sort((a, b) => b.shortName.localeCompare(a.shortName, undefined, { numeric: true }));
  return result;
}

/** HEAD, branches and tags (or the refs under `prefixes`; [] for every ref) as `ls-refs` lists them: tags unpeeled, with `peeled`. */
export async function lsRefs(
  env: Env,
  artifactsName: string,
  remote: string,
  prefixes?: readonly string[],
): Promise<LsRefsEntry[]> {
  // A read: retried through the provider's transient failures, each try bounded.
  return retrying(
    async () => {
      const token = await upstreamToken(env, artifactsName, "read");
      const response = await fetch(`${remote}/git-upload-pack`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-git-upload-pack-request",
          accept: "application/x-git-upload-pack-result",
          "git-protocol": "version=2",
        },
        body: lsRefsRequest(prefixes),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new UpstreamStatusError("ls-refs", response.status);
      }
      return parseLsRefs(new Uint8Array(await response.arrayBuffer()));
    },
    {
      retryable: isTransientArtifactsError,
      label: "Artifacts ls-refs",
      context: { artifactsName },
    },
  );
}

/** A git endpoint's HTTP failure, with the status that says whether to retry. */
export class UpstreamStatusError extends Error {
  readonly status: number;
  constructor(operation: string, status: number) {
    super(`${operation} failed with HTTP ${status}`);
    this.status = status;
  }
}

/**
 * Statuses that say the provider, not the request, failed. Rate limiting (429)
 * isn't among them: asking again at once only adds to it.
 */
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

const MISSING_REMOTE_REPO = /^ArtifactsError: Repository not found: [A-Za-z0-9][A-Za-z0-9._-]*\.$/;

/** Artifacts failures that say nothing about the request: retrying the same call may succeed. */
const TRANSIENT_CODES: readonly ArtifactsErrorCode[] = [
  "INTERNAL_ERROR",
  "UPSTREAM_UNAVAILABLE",
  "FORK_IN_PROGRESS",
];
// Remote bindings and Durable Object RPC keep only the message: the provider's
// internal error, a fork still in progress (CORE-315), the dropped connection
// of local development's remote binding (CORE-302), or a network failure on
// the way: a name lookup that failed once, a reset or refused connection
// (CORE-331).
const TRANSIENT_REMOTE =
  /^ArtifactsError: An internal error occurred|^ArtifactsError: Repository "[^"]+" is currently being forked|Peer closed WebSocket|Network connection lost|DNS lookup failed|Temporary failure in name resolution|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|^fetch failed$/;
/** Node-style network error codes, as some runtimes' fetch reports them. */
const TRANSIENT_NETWORK_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"]);

/**
 * Whether `error` is a dropped connection to the provider (local
 * development's remote binding): the call's outcome is unknown.
 */
export function isDroppedConnection(error: unknown): boolean {
  return (
    error instanceof Error && /Peer closed WebSocket|Network connection lost/.test(error.message)
  );
}

/** Whether `error` is a transient Artifacts or transport failure, worth retrying idempotent work. */
export function isTransientArtifactsError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (error instanceof UpstreamStatusError) return TRANSIENT_STATUSES.has(error.status);
  // A call that ran past its time limit (AbortSignal.timeout) got no answer.
  if (error instanceof Error && error.name === "TimeoutError") return true;
  if ("code" in error && typeof error.code === "string")
    return (
      (TRANSIENT_CODES as readonly string[]).includes(error.code) ||
      TRANSIENT_NETWORK_CODES.has(error.code)
    );
  return error instanceof Error && TRANSIENT_REMOTE.test(error.message);
}

export function isArtifactsError(error: unknown, code: ArtifactsErrorCode): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error) return error.code === code;
  // Remote bindings preserve an RPC error's name in its message, not custom fields.
  // Recognize only the observed missing-repository form; unknown outcomes stay fenced.
  return (
    code === "NOT_FOUND" &&
    error instanceof Error &&
    "remote" in error &&
    error.remote === true &&
    MISSING_REMOTE_REPO.test(error.message)
  );
}
