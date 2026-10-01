import { sql } from "kysely";

import { nowIso, parseJson, type DB } from "./db.ts";
import { RegistryError } from "./errors.ts";
import { ulid } from "./ids.ts";
import { addPublishedFile, authorizePublish, markPublishes, recordPublish } from "./provenance.ts";

/**
 * The generic package catalog every format shares: packages (by normalized
 * name), versions (with format-specific JSON metadata), files (repository
 * paths pointing at content-addressed blobs) and named tags.
 */

export interface PackageRow {
  id: string;
  repoId: string;
  name: string;
  normalizedName: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface VersionRow<M = Record<string, unknown>> {
  id: string;
  packageId: string;
  version: string;
  metadata: M;
  status: "active" | "yanked" | "deprecated";
  statusReason: string | null;
  publishedBy: string | null;
  createdAt: string;
}

export interface FileRow<M = Record<string, unknown>> {
  id: string;
  repoId: string;
  path: string;
  versionId: string | null;
  digest: string;
  r2Key: string;
  size: number;
  contentType: string;
  metadata: M;
  downloads: number;
  createdBy: string | null;
  createdAt: string;
  md5: string | null;
  sha1: string | null;
  sha512: string | null;
}

function toPackage(row: {
  id: string;
  repo_id: string;
  name: string;
  normalized_name: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}): PackageRow {
  return {
    id: row.id,
    repoId: row.repo_id,
    name: row.name,
    normalizedName: row.normalized_name,
    metadata: parseJson(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVersion<M>(row: {
  id: string;
  package_id: string;
  version: string;
  metadata: string;
  status: "active" | "yanked" | "deprecated";
  status_reason: string | null;
  published_by: string | null;
  created_at: string;
}): VersionRow<M> {
  return {
    id: row.id,
    packageId: row.package_id,
    version: row.version,
    metadata: parseJson(row.metadata, {} as M),
    status: row.status,
    statusReason: row.status_reason,
    publishedBy: row.published_by,
    createdAt: row.created_at,
  };
}

export async function getPackage(
  db: DB,
  repoId: string,
  normalizedName: string,
): Promise<PackageRow | null> {
  const row = await db
    .selectFrom("packages")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("normalized_name", "=", normalizedName)
    .executeTakeFirst();
  return row ? toPackage(row) : null;
}

export async function getPackageById(db: DB, id: string): Promise<PackageRow | null> {
  const row = await db.selectFrom("packages").selectAll().where("id", "=", id).executeTakeFirst();
  return row ? toPackage(row) : null;
}

/**
 * Returns the package, creating it on first publish. Every publish path comes
 * through here, so this is where gitmatrix decides whether the caller may
 * publish it (provenance.ts).
 */
export async function ensurePackage(
  db: DB,
  repoId: string,
  name: string,
  normalizedName: string,
  metadata?: Record<string, unknown>,
): Promise<PackageRow> {
  const existed = (await getPackage(db, repoId, normalizedName)) !== null;
  const now = nowIso();
  await db
    .insertInto("packages")
    .values({
      id: ulid(),
      repo_id: repoId,
      name,
      normalized_name: normalizedName,
      metadata: JSON.stringify(metadata ?? {}),
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.columns(["repo_id", "normalized_name"]).doUpdateSet({ updated_at: now }))
    .execute();
  const pkg = (await getPackage(db, repoId, normalizedName))!;
  try {
    await authorizePublish(db, { id: pkg.id, name: pkg.name, repoId });
  } catch (error) {
    // A refused first publish leaves nothing behind.
    if (!existed) await db.deleteFrom("packages").where("id", "=", pkg.id).execute();
    throw error;
  }
  if (metadata) {
    await db
      .updateTable("packages")
      .set({ metadata: JSON.stringify({ ...pkg.metadata, ...metadata }) })
      .where("id", "=", pkg.id)
      .execute();
    pkg.metadata = { ...pkg.metadata, ...metadata };
  }
  return pkg;
}

export async function updatePackageMetadata(
  db: DB,
  packageId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .updateTable("packages")
    .set({ metadata: JSON.stringify(metadata), updated_at: nowIso() })
    .where("id", "=", packageId)
    .execute();
}

export async function listPackages(
  db: DB,
  repoId: string,
  options: { query?: string; limit?: number; after?: string } = {},
): Promise<PackageRow[]> {
  let q = db
    .selectFrom("packages")
    .selectAll()
    .where("repo_id", "=", repoId)
    .orderBy("normalized_name")
    .limit(options.limit ?? 100);
  if (options.query) q = q.where("normalized_name", "like", `%${options.query.toLowerCase()}%`);
  if (options.after) q = q.where("normalized_name", ">", options.after);
  return (await q.execute()).map(toPackage);
}

export async function deletePackage(db: DB, packageId: string): Promise<void> {
  await db.deleteFrom("packages").where("id", "=", packageId).execute();
}

export async function createVersion<M extends object>(
  db: DB,
  packageId: string,
  version: string,
  metadata: M,
  publishedBy: string | null,
): Promise<VersionRow<M>> {
  const id = ulid();
  const now = nowIso();
  const result = await db
    .insertInto("versions")
    .values({
      id,
      package_id: packageId,
      version,
      metadata: JSON.stringify(metadata),
      published_by: publishedBy,
      created_at: now,
    })
    .onConflict((oc) => oc.columns(["package_id", "version"]).doNothing())
    .executeTakeFirst();
  if (Number(result.numInsertedOrUpdatedRows ?? 0n) === 0) {
    throw new RegistryError("immutable", `Version ${version} already exists`);
  }
  const pkg = await getPackageById(db, packageId);
  if (pkg) await recordPublish(db, { packageId, repoId: pkg.repoId, version });
  return {
    id,
    packageId,
    version,
    metadata,
    status: "active",
    statusReason: null,
    publishedBy,
    createdAt: now,
  };
}

export async function upsertVersion<M extends object>(
  db: DB,
  packageId: string,
  version: string,
  metadata: M,
  publishedBy: string | null,
): Promise<VersionRow<M>> {
  const existing = await getVersion<M>(db, packageId, version);
  if (!existing) return createVersion(db, packageId, version, metadata, publishedBy);
  await db
    .updateTable("versions")
    .set({ metadata: JSON.stringify(metadata) })
    .where("id", "=", existing.id)
    .execute();
  return { ...existing, metadata };
}

export async function getVersion<M = Record<string, unknown>>(
  db: DB,
  packageId: string,
  version: string,
): Promise<VersionRow<M> | null> {
  const row = await db
    .selectFrom("versions")
    .selectAll()
    .where("package_id", "=", packageId)
    .where("version", "=", version)
    .executeTakeFirst();
  return row ? toVersion<M>(row) : null;
}

export async function listVersions<M = Record<string, unknown>>(
  db: DB,
  packageId: string,
): Promise<VersionRow<M>[]> {
  const rows = await db
    .selectFrom("versions")
    .selectAll()
    .where("package_id", "=", packageId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows.map((row) => toVersion<M>(row));
}

export async function updateVersion(
  db: DB,
  versionId: string,
  patch: {
    metadata?: object;
    status?: "active" | "yanked" | "deprecated";
    statusReason?: string | null;
  },
): Promise<void> {
  await db
    .updateTable("versions")
    .set({
      ...(patch.metadata ? { metadata: JSON.stringify(patch.metadata) } : {}),
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.statusReason !== undefined ? { status_reason: patch.statusReason } : {}),
    })
    .where("id", "=", versionId)
    .execute();
  if (patch.status) {
    const row = await versionRef(db, versionId);
    if (row) await markPublishes(db, row.package_id, row.version, patch.status);
  }
}

async function versionRef(db: DB, versionId: string) {
  return db
    .selectFrom("versions")
    .select(["package_id", "version"])
    .where("id", "=", versionId)
    .executeTakeFirst();
}

export async function deleteVersion(db: DB, versionId: string): Promise<void> {
  const row = await versionRef(db, versionId);
  await db.deleteFrom("versions").where("id", "=", versionId).execute();
  if (row) await markPublishes(db, row.package_id, row.version, "deleted");
}

const FILE_COLUMNS = [
  "f.id",
  "f.repo_id",
  "f.path",
  "f.version_id",
  "f.digest",
  "f.size",
  "f.content_type",
  "f.metadata",
  "f.downloads",
  "f.created_by",
  "f.created_at",
  "b.r2_key",
  "b.md5",
  "b.sha1",
  "b.sha512",
] as const;

function toFile<M>(row: {
  id: string;
  repo_id: string;
  path: string;
  version_id: string | null;
  digest: string;
  size: number;
  content_type: string;
  metadata: string;
  downloads: number;
  created_by: string | null;
  created_at: string;
  r2_key: string;
  md5: string | null;
  sha1: string | null;
  sha512: string | null;
}): FileRow<M> {
  return {
    id: row.id,
    repoId: row.repo_id,
    path: row.path,
    versionId: row.version_id,
    digest: row.digest,
    r2Key: row.r2_key,
    size: row.size,
    contentType: row.content_type,
    metadata: parseJson(row.metadata, {} as M),
    downloads: row.downloads,
    createdBy: row.created_by,
    createdAt: row.created_at,
    md5: row.md5,
    sha1: row.sha1,
    sha512: row.sha512,
  };
}

export interface AddFileInput {
  repoId: string;
  path: string;
  versionId?: string | null;
  digest: string;
  size: number;
  contentType?: string;
  metadata?: object;
  createdBy?: string | null;
  /** Replace an existing file at the same path instead of failing. */
  overwrite?: boolean;
}

export async function addFile(db: DB, input: AddFileInput): Promise<void> {
  if (input.versionId) {
    const ref = await versionRef(db, input.versionId);
    if (ref) {
      await addPublishedFile(db, ref.package_id, ref.version, {
        digest: input.digest,
        size: input.size,
      });
    }
  }
  const values = {
    id: ulid(),
    repo_id: input.repoId,
    path: input.path,
    version_id: input.versionId ?? null,
    digest: input.digest,
    size: input.size,
    content_type: input.contentType ?? "application/octet-stream",
    metadata: JSON.stringify(input.metadata ?? {}),
    created_by: input.createdBy ?? null,
    created_at: nowIso(),
  };
  if (input.overwrite) {
    await db
      .insertInto("files")
      .values(values)
      .onConflict((oc) =>
        oc.columns(["repo_id", "path"]).doUpdateSet({
          version_id: values.version_id,
          digest: values.digest,
          size: values.size,
          content_type: values.content_type,
          metadata: values.metadata,
          created_by: values.created_by,
          created_at: values.created_at,
        }),
      )
      .execute();
    return;
  }
  const result = await db
    .insertInto("files")
    .values(values)
    .onConflict((oc) => oc.columns(["repo_id", "path"]).doNothing())
    .executeTakeFirst();
  if (Number(result.numInsertedOrUpdatedRows ?? 0n) === 0) {
    const existing = await getFile(db, input.repoId, input.path);
    // Re-uploading identical bytes is idempotent (maven and twine retry).
    if (existing?.digest === input.digest) return;
    throw new RegistryError("immutable", `${input.path} already exists`);
  }
}

export async function getFile<M = Record<string, unknown>>(
  db: DB,
  repoId: string,
  path: string,
): Promise<FileRow<M> | null> {
  const row = await db
    .selectFrom("files as f")
    .innerJoin("blobs as b", "b.digest", "f.digest")
    .select(FILE_COLUMNS)
    .where("f.repo_id", "=", repoId)
    .where("f.path", "=", path)
    .executeTakeFirst();
  return row ? toFile<M>(row) : null;
}

export async function listFiles<M = Record<string, unknown>>(
  db: DB,
  repoId: string,
  options: { prefix?: string; versionIds?: string[]; limit?: number; after?: string } = {},
): Promise<FileRow<M>[]> {
  let q = db
    .selectFrom("files as f")
    .innerJoin("blobs as b", "b.digest", "f.digest")
    .select(FILE_COLUMNS)
    .where("f.repo_id", "=", repoId)
    .orderBy("f.path");
  if (options.prefix) {
    q = q.where(sql<boolean>`substr(f.path, 1, ${options.prefix.length}) = ${options.prefix}`);
  }
  if (options.versionIds) {
    if (options.versionIds.length === 0) return [];
    q = q.where("f.version_id", "in", options.versionIds);
  }
  if (options.after) q = q.where("f.path", ">", options.after);
  if (options.limit) q = q.limit(options.limit);
  return (await q.execute()).map((row) => toFile<M>(row));
}

export async function filesForVersions<M = Record<string, unknown>>(
  db: DB,
  repoId: string,
  versionIds: string[],
): Promise<Map<string, FileRow<M>[]>> {
  const out = new Map<string, FileRow<M>[]>();
  // D1 caps bound parameters at 100 per statement.
  for (let i = 0; i < versionIds.length; i += 90) {
    const files = await listFiles<M>(db, repoId, { versionIds: versionIds.slice(i, i + 90) });
    for (const file of files) {
      const list = out.get(file.versionId!) ?? [];
      list.push(file);
      out.set(file.versionId!, list);
    }
  }
  return out;
}

export async function deleteFile(db: DB, repoId: string, path: string): Promise<boolean> {
  const result = await db
    .deleteFrom("files")
    .where("repo_id", "=", repoId)
    .where("path", "=", path)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

export async function countDownload(db: DB, fileId: string): Promise<void> {
  await db
    .updateTable("files")
    .set((eb) => ({ downloads: eb("downloads", "+", 1) }))
    .where("id", "=", fileId)
    .execute();
}

export async function getDistTags(db: DB, packageId: string): Promise<Record<string, string>> {
  const rows = await db
    .selectFrom("dist_tags")
    .select(["tag", "version"])
    .where("package_id", "=", packageId)
    .execute();
  return Object.fromEntries(rows.map((r) => [r.tag, r.version]));
}

export async function setDistTag(
  db: DB,
  packageId: string,
  tag: string,
  version: string,
): Promise<void> {
  const now = nowIso();
  await db
    .insertInto("dist_tags")
    .values({ package_id: packageId, tag, version, updated_at: now })
    .onConflict((oc) => oc.columns(["package_id", "tag"]).doUpdateSet({ version, updated_at: now }))
    .execute();
}

export async function deleteDistTag(db: DB, packageId: string, tag: string): Promise<void> {
  await db
    .deleteFrom("dist_tags")
    .where("package_id", "=", packageId)
    .where("tag", "=", tag)
    .execute();
}
