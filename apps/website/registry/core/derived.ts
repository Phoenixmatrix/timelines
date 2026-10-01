import { digestHex } from "@gitmatrix/formats/hash";

import { nowIso, type DB } from "./db.ts";
import { serveBlob, type ServeOptions } from "./blobs.ts";

/**
 * Generated index files (Packages, InRelease, repomd.xml, index.yaml, git
 * objects...). Stored in R2 under a content-derived key so earlier copies stay
 * readable (apt by-hash) until pruned; `derived_files` maps path to the latest.
 */
export interface DerivedFile {
  path: string;
  r2Key: string;
  size: number;
  sha256: string;
  contentType: string;
  generation: number;
  updatedAt: string;
}

export async function putDerived(
  db: DB,
  bucket: R2Bucket,
  repoId: string,
  path: string,
  content: Uint8Array | string,
  contentType: string,
): Promise<DerivedFile> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const sha256 = await digestHex("SHA-256", bytes);
  const r2Key = `d/${repoId}/${sha256}`;
  const existing = await getDerived(db, repoId, path);
  if (existing?.sha256 === sha256) return existing;
  if (!(await bucket.head(r2Key))) {
    await bucket.put(r2Key, bytes, { httpMetadata: { contentType } });
  }
  const updatedAt = nowIso();
  const generation = (existing?.generation ?? 0) + 1;
  await db
    .insertInto("derived_files")
    .values({
      repo_id: repoId,
      path,
      r2_key: r2Key,
      size: bytes.length,
      sha256,
      content_type: contentType,
      generation,
      updated_at: updatedAt,
    })
    .onConflict((oc) =>
      oc.columns(["repo_id", "path"]).doUpdateSet({
        r2_key: r2Key,
        size: bytes.length,
        sha256,
        content_type: contentType,
        generation,
        updated_at: updatedAt,
      }),
    )
    .execute();
  return { path, r2Key, size: bytes.length, sha256, contentType, generation, updatedAt };
}

export async function getDerived(
  db: DB,
  repoId: string,
  path: string,
): Promise<DerivedFile | null> {
  const row = await db
    .selectFrom("derived_files")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("path", "=", path)
    .executeTakeFirst();
  return row
    ? {
        path: row.path,
        r2Key: row.r2_key,
        size: row.size,
        sha256: row.sha256,
        contentType: row.content_type,
        generation: row.generation,
        updatedAt: row.updated_at,
      }
    : null;
}

export async function listDerived(db: DB, repoId: string, prefix = ""): Promise<DerivedFile[]> {
  const rows = await db
    .selectFrom("derived_files")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("path", "like", `${prefix.replace(/[%_]/g, "\\$&")}%`)
    .orderBy("path")
    .execute();
  return rows.map((row) => ({
    path: row.path,
    r2Key: row.r2_key,
    size: row.size,
    sha256: row.sha256,
    contentType: row.content_type,
    generation: row.generation,
    updatedAt: row.updated_at,
  }));
}

export async function deleteDerived(db: DB, repoId: string, path: string): Promise<void> {
  await db
    .deleteFrom("derived_files")
    .where("repo_id", "=", repoId)
    .where("path", "=", path)
    .execute();
}

export async function readDerivedText(bucket: R2Bucket, file: DerivedFile): Promise<string> {
  const object = await bucket.get(file.r2Key);
  return object ? object.text() : "";
}

export function serveDerived(
  request: Request,
  bucket: R2Bucket,
  file: DerivedFile,
  options: ServeOptions = {},
): Promise<Response> {
  return serveBlob(
    request,
    bucket,
    { r2Key: file.r2Key, size: file.size, digest: `sha256:${file.sha256}` },
    { contentType: file.contentType, ...options },
  );
}
