import { createHash } from "node:crypto";

import { namePath, type Dist } from "@gitmatrix/formats/npm";

import type { AppContext, Services } from "../../core/context.ts";
import { RegistryError, type ErrorCode } from "../../core/errors.ts";
import type { Repository } from "../../core/repos.ts";
import { deployTarget } from "../../core/virtual.ts";

/** Whole `PUT /<pkg>` body: base64 inflates a tarball by 4/3, so tarballs top out near 45 MB. */
export const MAX_PUBLISH_BODY = 60 * 1024 * 1024;
/** Everything in a publish body except the attachment data (manifest, readme...). */
export const MAX_METADATA_BYTES = 8 * 1024 * 1024;
/** One stored version manifest (D1 rows are capped at 2 MB). */
export const MAX_MANIFEST_BYTES = 512 * 1024;
/** Longer readmes are truncated, as on registry.npmjs.org. */
export const MAX_README_CHARS = 64 * 1024;
export const MAX_SMALL_BODY = 1024 * 1024;
export const MAX_AUDIT_BODY = 32 * 1024 * 1024;

export const CORGI = "application/vnd.npm.install-v1+json";
export const CORGI_ACCEPT = `${CORGI}; q=1.0, application/json; q=0.8, */*`;

/** Package-level state kept in `packages.metadata`. */
export interface NpmPackageMeta {
  /** CouchDB-style revision counter behind `_rev`. */
  rev?: number;
  readme?: string;
  readmeFilename?: string;
  description?: string;
  keywords?: string[];
  maintainers?: { name: string; email?: string }[];
  /** Versions that were unpublished and may never be reused. */
  unpublished?: string[];
  modified?: string;
}

/** `versions.metadata`: the sanitized manifest; `dist.tarball` is just the file name. */
export type NpmVersionMeta = Record<string, unknown> & { dist: Dist; deprecated?: string };

export function revString(packageId: string, counter: number): string {
  const hash = createHash("sha256").update(`${packageId}:${counter}`).digest("hex");
  return `${counter}-${hash.slice(0, 32)}`;
}

export function tarballUrl(svc: Services, repoKey: string, name: string, file: string): string {
  return `${svc.baseUrl}/npm/${repoKey}/${namePath(name)}/-/${encodeURIComponent(file)}`;
}

export function wantsAbbreviated(c: AppContext): boolean {
  if (c.req.query("write") === "true") return false;
  return (c.req.header("accept") ?? "").includes(CORGI);
}

function cacheScope(repo: Repository): string {
  return repo.visibility === "public" ? "public" : "private";
}

export function metadataCacheControl(repo: Repository): string {
  return `${cacheScope(repo)}, max-age=0, must-revalidate`;
}

export function tarballCacheControl(repo: Repository): string {
  return `${cacheScope(repo)}, max-age=31536000, immutable`;
}

/** JSON with a content ETag, answering If-None-Match with 304. */
export function sendJson(
  c: AppContext,
  value: unknown,
  options: { contentType?: string; cacheControl?: string; status?: number } = {},
): Response {
  const text = JSON.stringify(value);
  const etag = `"${createHash("sha1").update(text).digest("hex")}"`;
  const headers: Record<string, string> = {
    "content-type": `${options.contentType ?? "application/json"}; charset=utf-8`,
    etag,
    vary: "Accept, Authorization",
    "cache-control": options.cacheControl ?? "private, no-cache",
  };
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(c.req.method === "HEAD" ? null : text, {
    status: options.status ?? 200,
    headers,
  });
}

/** Reads a request body up to `limit` bytes, gunzipping `Content-Encoding: gzip`. */
export async function readBodyText(c: AppContext, limit: number): Promise<string> {
  let stream = c.req.raw.body;
  if (!stream) return "";
  if ((c.req.header("content-encoding") ?? "").toLowerCase().includes("gzip")) {
    stream = stream.pipeThrough(
      new DecompressionStream("gzip") as ReadableWritablePair<Uint8Array, Uint8Array>,
    );
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new RegistryError("too_large", `Request body exceeds ${limit} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw RegistryError.badRequest("Could not read the request body");
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(all);
}

export async function readJsonBody<T = unknown>(c: AppContext, limit = MAX_SMALL_BODY): Promise<T> {
  const text = await readBodyText(c, limit);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw RegistryError.badRequest("The request body must be JSON");
  }
}

/** Where writes addressed to `repo` land: itself, or a virtual repository's deploy target. */
export async function writableTarget(svc: Services, repo: Repository): Promise<Repository> {
  if (repo.kind === "local") return repo;
  if (repo.kind === "virtual") {
    const target = await deployTarget(svc, repo);
    if (!target) {
      throw new RegistryError("unsupported", `${repo.key} has no default deploy repository`);
    }
    return target;
  }
  throw new RegistryError(
    "unsupported",
    "Remote repositories are read-only; publish to a local one",
  );
}

export function notFound(name: string): RegistryError {
  return RegistryError.notFound(`${name} is not in this registry`);
}

/** The npm registry's wording, which clients show verbatim. */
export function cannotRepublish(version: string): RegistryError {
  return new RegistryError(
    "immutable",
    `You cannot publish over the previously published versions: ${version}.`,
    undefined,
    403,
  );
}

// Mutations run in the RepoDO; RegistryError does not survive the RPC boundary,
// so handlers return failures as data and the caller rethrows them.
type MutationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: ErrorCode; message: string; status: number };

export function guarded<P, T>(
  fn: (svc: Services, repo: Repository, payload: P) => Promise<T>,
): (svc: Services, repo: Repository, payload: unknown) => Promise<MutationOutcome<T>> {
  return async (svc, repo, payload) => {
    try {
      return { ok: true, value: await fn(svc, repo, payload as P) };
    } catch (error) {
      if (error instanceof RegistryError) {
        return { ok: false, code: error.code, message: error.message, status: error.status };
      }
      throw error;
    }
  };
}

export async function runMutation<T>(
  svc: Services,
  repo: Repository,
  op: string,
  payload: unknown,
): Promise<T> {
  // The stub's RPC return type is not a plain Promise to the type checker.
  const pending = svc
    .repoObject(repo)
    .mutate(repo.id, op, payload, await svc.actor()) as unknown as Promise<MutationOutcome<T>>;
  const outcome = await pending;
  if (!outcome.ok) {
    throw new RegistryError(outcome.code, outcome.message, undefined, outcome.status);
  }
  return outcome.value;
}
