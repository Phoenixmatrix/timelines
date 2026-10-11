import { digestHex } from "@gitmatrix/formats/hash";
import {
  dockerHubName,
  MANIFEST_ACCEPT,
  MANIFEST_MEDIA_TYPES,
  MAX_MANIFEST_BYTES,
  normalizeMediaType,
  parseChallenge,
} from "@gitmatrix/formats/oci";

import { readBlobBytes, type StoredBlob } from "../../core/blobs.ts";
import type { Services } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import {
  assertSafeUpstream,
  cachedArtifact,
  cachedMetadata,
  upstreamBase,
  upstreamUrl,
} from "../../core/remote.ts";
import type { Repository } from "../../core/repos.ts";
import { unseal } from "../../core/seal.ts";
import { OciError } from "./errors.ts";

/**
 * Pull-through for remote OCI repositories (Docker Hub, ghcr.io, quay.io...).
 * Upstream registries answer 401 with a Bearer challenge; the token dance
 * fetches a pull token from the challenge's realm (with the repository's
 * upstream credentials, if any) and caches it per scope until it expires.
 * Tags resolve to digests with a HEAD (cached briefly); manifests and blobs
 * by digest are immutable and cached forever, verified against the digest.
 */

const HOP_HEADER = "x-gitmatrix-hop";
const MAX_REDIRECTS = 5;
export const TAG_TTL_SECONDS = 300;

const tokens = new Map<string, { token: string; until: number }>();

export function resetUpstreamTokens(): void {
  tokens.clear();
}

/** The upstream image path for `<remoteKey>/<image>` (Docker Hub needs `library/`). */
export function upstreamImage(repo: Repository, image: string): string {
  return dockerHubName(new URL(upstreamBase(repo)).host, image);
}

async function credentials(svc: Services, repo: Repository) {
  const { upstreamUsername, upstreamPasswordSealed } = repo.config;
  if (!upstreamPasswordSealed) return null;
  const password = await unseal(svc.env, upstreamPasswordSealed);
  return { username: upstreamUsername ?? null, password };
}

/**
 * One upstream request with SSRF checks on every hop. The Authorization
 * header never follows a redirect to another host: blob downloads redirect
 * to presigned storage URLs that reject (and must not see) our credentials.
 */
async function ociFetch(
  svc: Services,
  repo: Repository,
  target: URL,
  init: { method?: "GET" | "HEAD"; headers?: Record<string, string> } = {},
): Promise<Response> {
  if (svc.request.headers.has(HOP_HEADER)) {
    throw new RegistryError("upstream_error", "Refusing a proxy loop");
  }
  let url = target;
  const originHost = target.host;
  const headers = new Headers(init.headers);
  headers.set(HOP_HEADER, "1");
  headers.set("user-agent", "gitmatrix (+https://github.com/Phoenixmatrix/timelines)");
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertSafeUpstream(svc, repo, url);
    if (url.host !== originHost) headers.delete("authorization");
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method ?? "GET",
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(10 * 60_000),
      });
    } catch (error) {
      throw new RegistryError("upstream_error", `Upstream request failed: ${String(error)}`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      await response.body?.cancel();
      url = new URL(response.headers.get("location")!, url);
      continue;
    }
    if (response.status === 429) {
      // Thrown, not returned: cached metadata is then served stale instead.
      await response.body?.cancel();
      const retry = response.headers.get("retry-after");
      throw new OciError("TOOMANYREQUESTS", `${url.host} is rate limiting this registry`, {
        headers: retry ? { "retry-after": retry } : {},
      });
    }
    return response;
  }
  throw new RegistryError("upstream_error", "Too many upstream redirects");
}

async function fetchToken(
  svc: Services,
  repo: Repository,
  params: Record<string, string>,
  scope: string,
): Promise<string | null> {
  if (!params.realm) return null;
  let realm: URL;
  try {
    realm = new URL(params.realm);
  } catch {
    return null;
  }
  if (params.service) realm.searchParams.set("service", params.service);
  realm.searchParams.set("scope", params.scope ?? scope);
  const headers: Record<string, string> = { accept: "application/json" };
  const creds = await credentials(svc, repo);
  if (creds?.username)
    headers.authorization = `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
  const response = await ociFetch(svc, repo, realm, { headers });
  if (!response.ok) {
    await response.body?.cancel();
    throw new RegistryError("upstream_error", `Upstream token service answered ${response.status}`);
  }
  const body = (await response.json().catch(() => ({}))) as {
    token?: string;
    access_token?: string;
    expires_in?: number;
  };
  const token = body.token ?? body.access_token;
  if (!token) return null;
  const ttl = Math.max(30, Math.min(body.expires_in ?? 60, 3600) - 10);
  tokens.set(`${repo.id} ${scope}`, { token, until: Date.now() + ttl * 1000 });
  return token;
}

/** `GET|HEAD <upstream>/v2/<image>/<path>` with the token dance. */
export async function upstreamRequest(
  svc: Services,
  repo: Repository,
  image: string,
  path: string,
  init: { method?: "GET" | "HEAD"; headers?: Record<string, string> } = {},
): Promise<Response> {
  const url = upstreamUrl(repo, `v2/${image}/${path}`);
  const scope = `repository:${image}:pull`;
  const cached = tokens.get(`${repo.id} ${scope}`);
  const headers = { ...init.headers };
  if (cached && cached.until > Date.now()) headers.authorization = `Bearer ${cached.token}`;
  else {
    // A password without a username is a static registry token.
    const creds = await credentials(svc, repo);
    if (creds && !creds.username) headers.authorization = `Bearer ${creds.password}`;
  }
  let response = await ociFetch(svc, repo, url, { ...init, headers });
  if (response.status !== 401) return response;

  const challenge = parseChallenge(response.headers.get("www-authenticate"));
  await response.body?.cancel();
  if (challenge?.scheme === "bearer") {
    const token = await fetchToken(svc, repo, challenge.params, scope);
    if (!token) return new Response(null, { status: 401 });
    response = await ociFetch(svc, repo, url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
    });
  } else if (challenge?.scheme === "basic") {
    const creds = await credentials(svc, repo);
    if (!creds?.username) return new Response(null, { status: 401 });
    response = await ociFetch(svc, repo, url, {
      ...init,
      headers: {
        ...init.headers,
        authorization: `Basic ${btoa(`${creds.username}:${creds.password}`)}`,
      },
    });
  }
  return response;
}

/** Upstream 401/403 for a name means "not there for us": treat it like 404. */
const HIDDEN = [401, 403];

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  if (Number(response.headers.get("content-length") ?? "0") > limit) {
    await response.body?.cancel();
    throw new RegistryError("upstream_error", "Upstream manifest too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit)
    throw new RegistryError("upstream_error", "Upstream manifest too large");
  return bytes;
}

export interface ManifestInfo {
  digest: string;
  mediaType: string;
  size: number;
}

/** Tag -> digest, via HEAD, cached for `metadataTtlSeconds` (default 5 minutes). */
export async function resolveRemoteTag(
  svc: Services,
  repo: Repository,
  image: string,
  tag: string,
): Promise<ManifestInfo | null> {
  const upstream = upstreamImage(repo, image);
  const meta = await cachedMetadata(svc, repo, `oci/tags/${upstream}:${tag}`, {
    url: upstreamUrl(repo, `v2/${upstream}/manifests/${tag}`),
    ttlSeconds: repo.config.metadataTtlSeconds ?? TAG_TTL_SECONDS,
    notFoundStatuses: HIDDEN,
    fetcher: async () => {
      let response = await upstreamRequest(svc, repo, upstream, `manifests/${tag}`, {
        method: "HEAD",
        headers: { accept: MANIFEST_ACCEPT },
      });
      if (!response.ok) return response;
      let digest = response.headers.get("docker-content-digest");
      let mediaType = normalizeMediaType(response.headers.get("content-type"));
      let size = Number(response.headers.get("content-length") ?? "0");
      if (!digest || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
        response = await upstreamRequest(svc, repo, upstream, `manifests/${tag}`, {
          headers: { accept: MANIFEST_ACCEPT },
        });
        if (!response.ok) return response;
        const bytes = await readCapped(response, MAX_MANIFEST_BYTES);
        digest = `sha256:${await digestHex("SHA-256", bytes)}`;
        mediaType = normalizeMediaType(response.headers.get("content-type"));
        size = bytes.length;
      }
      return Response.json({ digest, mediaType, size } satisfies ManifestInfo);
    },
  });
  if (meta.status !== 200) return null;
  return JSON.parse(meta.text) as ManifestInfo;
}

function verified<T>(work: Promise<T>): Promise<T> {
  return work.catch((error: unknown) => {
    if (error instanceof RegistryError && error.code === "digest_invalid") {
      throw new RegistryError("upstream_error", `Upstream content failed verification`);
    }
    throw error;
  });
}

/** A manifest by digest, fetched once and verified. */
export async function remoteManifest(
  svc: Services,
  repo: Repository,
  image: string,
  digest: string,
): Promise<{ blob: StoredBlob; mediaType: string } | null> {
  const upstream = upstreamImage(repo, image);
  const cached = await verified(
    cachedArtifact(svc, repo, `oci/manifests/${upstream}@${digest}`, {
      url: upstreamUrl(repo, `v2/${upstream}/manifests/${digest}`),
      expect: { sha256: digest.slice("sha256:".length) },
      fetcher: async () => {
        const response = await upstreamRequest(svc, repo, upstream, `manifests/${digest}`, {
          headers: { accept: MANIFEST_ACCEPT },
        });
        return HIDDEN.includes(response.status) ? new Response(null, { status: 404 }) : response;
      },
    }),
  );
  if (!cached) return null;
  let mediaType = normalizeMediaType(cached.contentType);
  if (!MANIFEST_MEDIA_TYPES.includes(mediaType)) {
    const bytes = await readBlobBytes(svc.bucket, cached.blob.r2Key);
    try {
      const doc = JSON.parse(new TextDecoder().decode(bytes)) as { mediaType?: unknown };
      if (typeof doc.mediaType === "string") mediaType = doc.mediaType;
    } catch {
      // Served as-is with the upstream content type.
    }
  }
  return { blob: cached.blob, mediaType };
}

/** A blob by digest, fetched once into the blob store and verified. */
export async function remoteBlob(
  svc: Services,
  repo: Repository,
  image: string,
  digest: string,
): Promise<StoredBlob | null> {
  const upstream = upstreamImage(repo, image);
  const cached = await verified(
    cachedArtifact(svc, repo, `oci/blobs/${upstream}@${digest}`, {
      url: upstreamUrl(repo, `v2/${upstream}/blobs/${digest}`),
      expect: { sha256: digest.slice("sha256:".length) },
      contentType: "application/octet-stream",
      fetcher: async () => {
        const response = await upstreamRequest(svc, repo, upstream, `blobs/${digest}`);
        return HIDDEN.includes(response.status) ? new Response(null, { status: 404 }) : response;
      },
    }),
  );
  return cached?.blob ?? null;
}

/** All upstream tags (following Link pagination), cached like tag lookups. */
export async function remoteTags(
  svc: Services,
  repo: Repository,
  image: string,
): Promise<string[] | null> {
  const upstream = upstreamImage(repo, image);
  const meta = await cachedMetadata(svc, repo, `oci/tag-list/${upstream}`, {
    url: upstreamUrl(repo, `v2/${upstream}/tags/list`),
    ttlSeconds: repo.config.metadataTtlSeconds ?? TAG_TTL_SECONDS,
    notFoundStatuses: HIDDEN,
    fetcher: async () => {
      const all: string[] = [];
      let path = "tags/list";
      for (let page = 0; page < 20; page++) {
        const response = await upstreamRequest(svc, repo, upstream, path, {
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          if (page === 0) return response;
          await response.body?.cancel();
          break;
        }
        const link = response.headers.get("link");
        const body = (await response.json().catch(() => ({}))) as { tags?: unknown };
        if (Array.isArray(body.tags)) {
          all.push(...body.tags.filter((t): t is string => typeof t === "string"));
        }
        const next = link ? /<([^>]+)>\s*;\s*rel="?next"?/.exec(link)?.[1] : undefined;
        const query = next ? new URL(next, "https://upstream.invalid").search : "";
        if (!query) break;
        path = `tags/list${query}`;
      }
      return Response.json({ tags: [...new Set(all)].sort() });
    },
  });
  if (meta.status !== 200) return null;
  return (JSON.parse(meta.text) as { tags: string[] }).tags;
}

/** Upstream referrers; registries without the API count as "none". */
export async function remoteReferrers(
  svc: Services,
  repo: Repository,
  image: string,
  digest: string,
): Promise<Record<string, unknown>[]> {
  const upstream = upstreamImage(repo, image);
  const meta = await cachedMetadata(svc, repo, `oci/referrers/${upstream}@${digest}`, {
    url: upstreamUrl(repo, `v2/${upstream}/referrers/${digest}`),
    ttlSeconds: repo.config.metadataTtlSeconds ?? TAG_TTL_SECONDS,
    notFoundStatuses: [...HIDDEN, 400, 405],
    fetcher: () =>
      upstreamRequest(svc, repo, upstream, `referrers/${digest}`, {
        headers: { accept: "application/vnd.oci.image.index.v1+json" },
      }),
  });
  if (meta.status !== 200) return [];
  try {
    const doc = JSON.parse(meta.text) as { manifests?: unknown };
    return Array.isArray(doc.manifests) ? (doc.manifests as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}
