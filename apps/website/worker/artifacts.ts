import type { GitRef } from "../shared/api.ts";
import { lsRefsRequest, parseLsRefs } from "./git/pktline.ts";

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
  using repo = await env.ARTIFACTS.get(artifactsName);
  const created = await repo.createToken(scope, TOKEN_TTL_SECONDS);
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
  const token = await upstreamToken(env, artifactsName, "read");
  const response = await fetch(`${remote}/git-upload-pack`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
      "git-protocol": "version=2",
    },
    body: lsRefsRequest(),
  });
  if (!response.ok) throw new Error(`ls-refs failed with HTTP ${response.status}`);
  const refs = parseLsRefs(new Uint8Array(await response.arrayBuffer()));

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

export function isArtifactsError(error: unknown, code: ArtifactsErrorCode): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === code
  );
}
