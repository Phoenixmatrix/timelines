import type { Services } from "./context.ts";
import { nowIso } from "./db.ts";
import { getDerived, putDerived, readDerivedText, type DerivedFile } from "./derived.ts";
import { getBlob, storeBlob, type ExpectedDigests, type StoredBlob } from "./blobs.ts";
import { RegistryError } from "./errors.ts";
import type { Repository } from "./repos.ts";
import { unseal } from "./seal.ts";

/**
 * Pull-through caching for remote repositories. Immutable artifacts are
 * fetched once into the blob store; mutable metadata is cached with a TTL,
 * revalidated with ETags, served stale when the upstream fails, and fetched
 * single-flight through the repository's RepoDO.
 */

/** How finely an entry's last use is kept (retention, CORE-205): one write a day at most. */
const USE_RESOLUTION_MS = 24 * 60 * 60 * 1000;

/** Record that a cached entry was served, unless it was already today. */
async function touchEntry(
  db: Services["db"],
  entry: { repo_id: string; path: string; used_at: string | null },
): Promise<void> {
  const now = Date.now();
  if (entry.used_at && Date.parse(entry.used_at) > now - USE_RESOLUTION_MS) return;
  await db
    .updateTable("remote_entries")
    .set({ used_at: new Date(now).toISOString() })
    .where("repo_id", "=", entry.repo_id)
    .where("path", "=", entry.path)
    .execute();
}

export const DEFAULT_METADATA_TTL_SECONDS = 600;
export const DEFAULT_NEGATIVE_TTL_SECONDS = 120;
const METADATA_MAX_BYTES = 128 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const HOP_HEADER = "x-gitmatrix-hop";

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.localdomain|metadata\.google\.internal)$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Refuses upstream URLs that could reach internal services or loop back to us. */
export function assertSafeUpstream(services: Services, repo: Repository, url: URL): void {
  // In development the registry itself runs on localhost, so a local test
  // upstream is allowed; deployed, loopback upstreams never are.
  const devLoopback =
    Reflect.get(services.env, "DEV_MODE") === "true" &&
    ["localhost", "127.0.0.1", "host.docker.internal"].includes(url.hostname);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (repo.config.allowInsecureUpstream || devLoopback))
  ) {
    throw new RegistryError("upstream_error", "Upstream must use https");
  }
  if (devLoopback) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (IPV4.test(host) || host.includes(":")) {
    throw new RegistryError("upstream_error", "Upstream hosts must be names, not IP addresses");
  }
  if (PRIVATE_HOST.test(host))
    throw new RegistryError("upstream_error", "Upstream host is not allowed");
  if (host === new URL(services.baseUrl).hostname)
    throw new RegistryError("upstream_error", "A repository cannot proxy this registry");
  if (url.username || url.password)
    throw new RegistryError(
      "upstream_error",
      "Put upstream credentials in the repository settings",
    );
}

export function upstreamBase(repo: Repository): string {
  if (!repo.config.upstream) throw new RegistryError("internal", `${repo.key} has no upstream`);
  return repo.config.upstream.replace(/\/+$/, "");
}

/** Joins an upstream base URL and a relative path without letting the path change host. */
export function upstreamUrl(repo: Repository, path: string): URL {
  const base = upstreamBase(repo);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) {
    throw RegistryError.badRequest("Invalid upstream path");
  }
  return new URL(`${base}/${path.replace(/^\/+/, "")}`);
}

async function credentialHeader(services: Services, repo: Repository): Promise<string | null> {
  const { upstreamUsername, upstreamPasswordSealed } = repo.config;
  if (!upstreamPasswordSealed) return null;
  const password = await unseal(services.env, upstreamPasswordSealed);
  if (!upstreamUsername) return `Bearer ${password}`;
  return `Basic ${btoa(`${upstreamUsername}:${password}`)}`;
}

export interface UpstreamInit {
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  /** POST body, buffered so it can be replayed on a redirect (npm audit). */
  body?: string;
  timeoutMs?: number;
  /** Skip the repository's configured credentials (e.g. OCI token dance handles its own). */
  anonymous?: boolean;
}

/** One upstream request with SSRF checks on every redirect hop. */
export async function upstreamFetch(
  services: Services,
  repo: Repository,
  target: URL | string,
  init: UpstreamInit = {},
): Promise<Response> {
  if (services.request.headers.has(HOP_HEADER)) {
    throw new RegistryError("upstream_error", "Refusing a proxy loop");
  }
  let url = typeof target === "string" ? upstreamUrl(repo, target) : target;
  const headers = new Headers(init.headers);
  headers.set(HOP_HEADER, "1");
  headers.set("user-agent", "gitmatrix (+https://github.com/Phoenixmatrix/timelines)");
  const auth = init.anonymous ? null : await credentialHeader(services, repo);
  const upstreamHost = new URL(upstreamBase(repo)).host;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertSafeUpstream(services, repo, url);
    // Credentials only ever go to the configured upstream host, never to a redirect target.
    if (auth && url.host === upstreamHost && !headers.has("authorization"))
      headers.set("authorization", auth);
    else if (url.host !== upstreamHost && auth && headers.get("authorization") === auth)
      headers.delete("authorization");
    let response: Response;
    try {
      response = await fetch(url, {
        method: init.method ?? "GET",
        headers,
        body: init.body,
        redirect: "manual",
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
    } catch (error) {
      throw new RegistryError("upstream_error", `Upstream request failed: ${String(error)}`);
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      url = new URL(response.headers.get("location")!, url);
      continue;
    }
    return response;
  }
  throw new RegistryError("upstream_error", "Too many upstream redirects");
}

async function readCapped(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new RegistryError("upstream_error", "Upstream metadata is too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

export interface CachedMetadata {
  status: number;
  text: string;
  contentType: string;
  /** True when served from cache after the upstream failed. */
  stale: boolean;
}

export interface MetadataOptions {
  /** Headers for the upstream request (Accept...). */
  headers?: Record<string, string>;
  /** Upstream URL when it is not `<upstream>/<path>`. */
  url?: URL;
  ttlSeconds?: number;
  /** Treat these upstream statuses as "not found" and cache them negatively. */
  notFoundStatuses?: number[];
  fetcher?: (url: URL) => Promise<Response>;
}

async function waitForLease(services: Services, repo: Repository, key: string): Promise<boolean> {
  const stub = services.repoObject(repo);
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await stub.lease(key, 30_000)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/**
 * Upstream metadata under `path`, cached per repository. Returns 404-status
 * results (cached negatively) rather than throwing, so virtual repositories
 * can move on to the next member.
 */
export async function cachedMetadata(
  services: Services,
  repo: Repository,
  path: string,
  options: MetadataOptions = {},
): Promise<CachedMetadata> {
  const db = services.db;
  const cacheKey = `upstream/${path}`;
  const entry = await db
    .selectFrom("remote_entries")
    .selectAll()
    .where("repo_id", "=", repo.id)
    .where("path", "=", cacheKey)
    .executeTakeFirst();
  const cached: DerivedFile | null =
    entry && entry.status === 200 ? await getDerived(db, repo.id, cacheKey) : null;
  const fresh = entry && entry.expires_at > nowIso();
  const fromCache = async (stale: boolean): Promise<CachedMetadata> =>
    entry!.status === 200 && cached
      ? {
          status: 200,
          text: await readDerivedText(services.bucket, cached),
          contentType: cached.contentType,
          stale,
        }
      : { status: entry!.status, text: "", contentType: "text/plain", stale };
  if (entry && fresh && (entry.status !== 200 || cached)) {
    await touchEntry(db, entry);
    return fromCache(false);
  }

  const leaseKey = `meta:${path}`;
  const leased = await waitForLease(services, repo, leaseKey);
  try {
    if (!leased && entry) return fromCache(true);
    const url = options.url ?? upstreamUrl(repo, path);
    const headers: Record<string, string> = { ...options.headers };
    if (entry?.etag && cached) headers["if-none-match"] = entry.etag;
    let response: Response;
    try {
      response = options.fetcher
        ? await options.fetcher(url)
        : await upstreamFetch(services, repo, url, { headers });
    } catch (error) {
      if (entry) return fromCache(true);
      throw error;
    }
    const ttl =
      response.ok || response.status === 304
        ? (options.ttlSeconds ?? repo.config.metadataTtlSeconds ?? DEFAULT_METADATA_TTL_SECONDS)
        : (repo.config.negativeTtlSeconds ?? DEFAULT_NEGATIVE_TTL_SECONDS);
    const expires = new Date(Date.now() + ttl * 1000).toISOString();
    const notFound =
      response.status === 404 ||
      response.status === 410 ||
      options.notFoundStatuses?.includes(response.status);

    if (response.status === 304 && entry && cached) {
      await db
        .updateTable("remote_entries")
        .set({ fetched_at: nowIso(), used_at: nowIso(), expires_at: expires })
        .where("repo_id", "=", repo.id)
        .where("path", "=", cacheKey)
        .execute();
      return fromCache(false);
    }
    if (!response.ok && !notFound) {
      await response.body?.cancel();
      if (entry) return fromCache(true);
      throw new RegistryError("upstream_error", `Upstream answered ${response.status}`);
    }

    let text = "";
    let contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (response.ok) {
      const bytes = await readCapped(response, METADATA_MAX_BYTES);
      text = new TextDecoder().decode(bytes);
      await putDerived(db, services.bucket, repo.id, cacheKey, bytes, contentType);
    } else {
      await response.body?.cancel();
      contentType = "text/plain";
    }
    const values = {
      status: response.ok ? 200 : 404,
      etag: response.headers.get("etag"),
      last_modified: response.headers.get("last-modified"),
      content_type: contentType,
      fetched_at: nowIso(),
      used_at: nowIso(),
      expires_at: expires,
    };
    await db
      .insertInto("remote_entries")
      .values({ repo_id: repo.id, path: cacheKey, digest: null, ...values })
      .onConflict((oc) => oc.columns(["repo_id", "path"]).doUpdateSet(values))
      .execute();
    return { status: values.status, text, contentType, stale: false };
  } finally {
    if (leased) await services.repoObject(repo).release(leaseKey);
  }
}

export interface ArtifactOptions {
  url?: URL;
  headers?: Record<string, string>;
  expect?: ExpectedDigests;
  contentType?: string;
  fetcher?: (url: URL) => Promise<Response>;
}

/**
 * An immutable upstream artifact, fetched into the blob store on first use.
 * Returns null if the upstream does not have it.
 */
export async function cachedArtifact(
  services: Services,
  repo: Repository,
  path: string,
  options: ArtifactOptions = {},
): Promise<{ blob: StoredBlob; contentType: string } | null> {
  const db = services.db;
  const cacheKey = `artifact/${path}`;
  const lookup = async () => {
    const entry = await db
      .selectFrom("remote_entries")
      .selectAll()
      .where("repo_id", "=", repo.id)
      .where("path", "=", cacheKey)
      .executeTakeFirst();
    if (!entry) return undefined;
    if (entry.status !== 200) return entry.expires_at > nowIso() ? null : undefined;
    const blob = entry.digest ? await getBlob(db, entry.digest) : null;
    if (!blob) return undefined;
    await touchEntry(db, entry);
    return { blob, contentType: entry.content_type ?? "application/octet-stream" };
  };
  const hit = await lookup();
  if (hit !== undefined) return hit;

  const leaseKey = `artifact:${path}`;
  const leased = await waitForLease(services, repo, leaseKey);
  try {
    if (!leased) {
      const again = await lookup();
      if (again !== undefined) return again;
    }
    const url = options.url ?? upstreamUrl(repo, path);
    const response = options.fetcher
      ? await options.fetcher(url)
      : await upstreamFetch(services, repo, url, {
          headers: options.headers,
          timeoutMs: 10 * 60_000,
        });
    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel();
      const values = {
        status: 404,
        digest: null,
        content_type: null,
        etag: null,
        last_modified: null,
        fetched_at: nowIso(),
        used_at: nowIso(),
        expires_at: new Date(
          Date.now() + (repo.config.negativeTtlSeconds ?? DEFAULT_NEGATIVE_TTL_SECONDS) * 1000,
        ).toISOString(),
      };
      await db
        .insertInto("remote_entries")
        .values({ repo_id: repo.id, path: cacheKey, ...values })
        .onConflict((oc) => oc.columns(["repo_id", "path"]).doUpdateSet(values))
        .execute();
      return null;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new RegistryError("upstream_error", `Upstream answered ${response.status} for ${path}`);
    }
    const contentType =
      options.contentType ?? response.headers.get("content-type") ?? "application/octet-stream";
    const blob = await storeBlob(db, services.bucket, response.body, {
      contentType,
      expect: options.expect,
    });
    const values = {
      status: 200,
      digest: blob.digest,
      content_type: contentType,
      etag: response.headers.get("etag"),
      last_modified: response.headers.get("last-modified"),
      fetched_at: nowIso(),
      used_at: nowIso(),
      expires_at: "9999-12-31T00:00:00.000Z",
    };
    await db
      .insertInto("remote_entries")
      .values({ repo_id: repo.id, path: cacheKey, ...values })
      .onConflict((oc) => oc.columns(["repo_id", "path"]).doUpdateSet(values))
      .execute();
    return { blob, contentType };
  } finally {
    if (leased) await services.repoObject(repo).release(leaseKey);
  }
}
