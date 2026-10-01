import {
  escapeName,
  parseIntegrity,
  rewriteTarballs,
  tarballFilename,
  tarballUrlFilename,
  versionForFile,
  type Packument,
} from "@gitmatrix/formats/npm";

import { serveBlob } from "../../core/blobs.ts";
import { services, type AppContext, type Services } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import {
  cachedArtifact,
  cachedMetadata,
  upstreamBase,
  upstreamFetch,
  upstreamUrl,
} from "../../core/remote.ts";
import type { Repository } from "../../core/repos.ts";
import { CORGI_ACCEPT, tarballCacheControl, tarballUrl } from "./common.ts";
import { tarballPath } from "./local.ts";

/**
 * The upstream packument as the upstream wrote it (tarball URLs untouched),
 * cached separately in its full and abbreviated forms.
 */
export async function upstreamPackument(
  svc: Services,
  repo: Repository,
  name: string,
  abbreviated: boolean,
): Promise<Packument | null> {
  const escaped = escapeName(name);
  const result = await cachedMetadata(
    svc,
    repo,
    `packuments/${abbreviated ? "abbreviated" : "full"}/${escaped}`,
    {
      url: upstreamUrl(repo, escaped),
      headers: { accept: abbreviated ? CORGI_ACCEPT : "application/json" },
    },
  );
  if (result.status !== 200) return null;
  let doc: Packument;
  try {
    doc = JSON.parse(result.text) as Packument;
  } catch {
    throw new RegistryError("upstream_error", `Upstream returned an invalid document for ${name}`);
  }
  if (!doc || typeof doc !== "object" || typeof doc.versions !== "object" || !doc.versions) {
    return null;
  }
  doc.name ??= name;
  doc["dist-tags"] ??= {};
  return doc;
}

/** Points every tarball at `/npm/<urlRepoKey>/`. */
export function rewriteForRepo(
  svc: Services,
  doc: Packument,
  name: string,
  urlRepoKey: string,
): Packument {
  return rewriteTarballs(doc, (manifest) => {
    const file =
      (manifest.dist.tarball && tarballUrlFilename(manifest.dist.tarball)) ||
      tarballFilename(name, String(manifest.version));
    return tarballUrl(svc, urlRepoKey, name, file);
  });
}

export async function remotePackument(
  svc: Services,
  repo: Repository,
  name: string,
  abbreviated: boolean,
  urlRepoKey: string,
): Promise<Packument | null> {
  const doc = await upstreamPackument(svc, repo, name, abbreviated);
  return doc ? rewriteForRepo(svc, doc, name, urlRepoKey) : null;
}

function tarballSource(repo: Repository, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RegistryError("upstream_error", "Upstream tarball URL is invalid");
  }
  // Old packuments still say http:// for the upstream's own host.
  const upstream = new URL(upstreamBase(repo));
  if (url.protocol === "http:" && url.host === upstream.host && upstream.protocol === "https:") {
    url.protocol = "https:";
  }
  return url;
}

/**
 * A tarball through a remote repository: the version is looked up in the
 * cached packument, and the download is verified against its integrity.
 */
export async function remoteTarball(
  c: AppContext,
  repo: Repository,
  name: string,
  file: string,
  cacheRepo: Repository = repo,
  known?: Packument,
): Promise<Response | null> {
  const svc = services(c);
  const doc = known ?? (await upstreamPackument(svc, repo, name, true));
  if (!doc) return null;
  const manifest = versionForFile(doc, file);
  if (!manifest?.dist?.tarball) return null;
  const integrity = parseIntegrity(manifest.dist.integrity);
  const cached = await cachedArtifact(svc, repo, tarballPath(name, file), {
    url: tarballSource(repo, manifest.dist.tarball),
    contentType: "application/octet-stream",
    expect: {
      sha512: integrity.sha512,
      sha1: typeof manifest.dist.shasum === "string" ? manifest.dist.shasum : integrity.sha1,
    },
  });
  if (!cached) return null;
  return serveBlob(c.req.raw, svc.bucket, cached.blob, {
    contentType: "application/octet-stream",
    cacheControl: tarballCacheControl(cacheRepo),
  });
}

export interface UpstreamSearch {
  objects: { package: { name: string }; [key: string]: unknown }[];
  total: number;
}

export async function remoteSearch(
  svc: Services,
  repo: Repository,
  params: URLSearchParams,
): Promise<UpstreamSearch> {
  const response = await upstreamFetch(svc, repo, `-/v1/search?${params.toString()}`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new RegistryError("upstream_error", `Upstream search answered ${response.status}`);
  }
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as UpstreamSearch;
    return {
      objects: Array.isArray(parsed.objects)
        ? parsed.objects.filter((o) => typeof o?.package?.name === "string")
        : [],
      total: typeof parsed.total === "number" ? parsed.total : 0,
    };
  } catch {
    throw new RegistryError("upstream_error", "Upstream search returned invalid JSON");
  }
}

export const AUDIT_PATHS = {
  bulk: "-/npm/v1/security/advisories/bulk",
  quick: "-/npm/v1/security/audits/quick",
} as const;

export async function proxyAudit(
  svc: Services,
  repo: Repository,
  kind: keyof typeof AUDIT_PATHS,
  body: string,
): Promise<Response> {
  const response = await upstreamFetch(svc, repo, AUDIT_PATHS[kind], {
    method: "POST",
    body,
    headers: { "content-type": "application/json", accept: "application/json" },
    timeoutMs: 60_000,
  });
  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
