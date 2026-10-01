import type { AppContext, Services } from "../../core/context.ts";
import { getDerived, readDerivedText, serveDerived, type DerivedFile } from "../../core/derived.ts";
import { RegistryError } from "../../core/errors.ts";
import type { Repository } from "../../core/repos.ts";

/** Helpers shared by the signed package repositories (apt, rpm). */

/** Reads `length` bytes at `offset` of a stored blob (clamped to its size). */
export async function readRange(
  bucket: R2Bucket,
  blob: { r2Key: string; size: number },
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const end = Math.min(blob.size, offset + length);
  if (offset >= end) return new Uint8Array();
  const object = await bucket.get(blob.r2Key, { range: { offset, length: end - offset } });
  if (!object) throw new RegistryError("internal", "Blob is missing from storage");
  return new Uint8Array(await object.arrayBuffer());
}

/** Serves a generated index file with a Last-Modified header. */
export function serveIndex(
  c: AppContext,
  services: Services,
  file: DerivedFile,
  cacheControl?: string,
): Promise<Response> {
  return serveDerived(c.req.raw, services.bucket, file, {
    cacheControl,
    headers: { "last-modified": new Date(file.updatedAt).toUTCString() },
  });
}

/**
 * A derived file of a local repository; if the repository has never been
 * indexed (`stateKey` missing), builds it now so a fresh repository answers
 * with valid, empty, signed metadata instead of 404.
 */
export async function derivedOrBuild(
  services: Services,
  repo: Repository,
  path: string,
  stateKey: string,
): Promise<DerivedFile | null> {
  const file = await getDerived(services.db, repo.id, path);
  if (file) return file;
  if (await getDerived(services.db, repo.id, stateKey)) return null;
  await services.repoObject(repo).rebuildNow(repo.id);
  return getDerived(services.db, repo.id, path);
}

/** Reads a JSON state document kept as a derived file. */
export async function readState<T>(
  services: Services,
  repo: Repository,
  path: string,
  fallback: T,
): Promise<T> {
  const file = await getDerived(services.db, repo.id, path);
  if (!file) return fallback;
  try {
    return JSON.parse(await readDerivedText(services.bucket, file)) as T;
  } catch {
    return fallback;
  }
}

/** Runs a format mutation in the repository's RepoDO (serialized with rebuilds). */
export async function mutate<T>(
  services: Services,
  repo: Repository,
  op: string,
  payload: unknown,
): Promise<T> {
  // The RPC stub's typing loses the Promise for an `unknown` result.
  const actor = await services.actor();
  const result: unknown = services.repoObject(repo).mutate(repo.id, op, payload, actor);
  return (await Promise.resolve(result)) as T;
}
