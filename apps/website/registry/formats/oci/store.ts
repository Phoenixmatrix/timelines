import { parseJson, nowIso, type DB } from "../../core/db.ts";

/**
 * The OCI catalog of a local repository in D1: blob links (what was pushed
 * or mounted into each image name), manifests with their references,
 * referrer subjects, and tags. Names here are image paths without the
 * repository key; the repository id scopes them.
 */

export interface ManifestRow {
  digest: string;
  mediaType: string;
  artifactType: string | null;
  subject: string | null;
  size: number;
  annotations: Record<string, string>;
  createdAt: string;
}

function toManifest(row: {
  digest: string;
  media_type: string;
  artifact_type: string | null;
  subject: string | null;
  size: number;
  annotations: string;
  created_at: string;
}): ManifestRow {
  return {
    digest: row.digest,
    mediaType: row.media_type,
    artifactType: row.artifact_type,
    subject: row.subject,
    size: row.size,
    annotations: parseJson(row.annotations, {}),
    createdAt: row.created_at,
  };
}

export async function linkBlob(db: DB, repoId: string, name: string, digest: string) {
  await db
    .insertInto("oci_blob_links")
    .values({ repo_id: repoId, name, digest, created_at: nowIso() })
    .onConflict((oc) => oc.columns(["repo_id", "name", "digest"]).doNothing())
    .execute();
}

export async function unlinkBlob(db: DB, repoId: string, name: string, digest: string) {
  const result = await db
    .deleteFrom("oci_blob_links")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("digest", "=", digest)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

export async function isBlobLinked(
  db: DB,
  repoId: string,
  name: string,
  digest: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("oci_blob_links")
    .select("digest")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("digest", "=", digest)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Whether `digest` belongs to this image: pushed or mounted into it, referenced
 * by one of its manifests, or one of its manifests itself.
 */
export async function blobVisible(
  db: DB,
  repoId: string,
  name: string,
  digest: string,
): Promise<boolean> {
  if (await isBlobLinked(db, repoId, name, digest)) return true;
  const ref = await db
    .selectFrom("oci_manifest_refs")
    .select("ref")
    .where("ref", "=", digest)
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .executeTakeFirst();
  if (ref) return true;
  return (await getManifest(db, repoId, name, digest)) !== null;
}

export async function getManifest(
  db: DB,
  repoId: string,
  name: string,
  digest: string,
): Promise<ManifestRow | null> {
  const row = await db
    .selectFrom("oci_manifests")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("digest", "=", digest)
    .executeTakeFirst();
  return row ? toManifest(row) : null;
}

export async function tagDigest(
  db: DB,
  repoId: string,
  name: string,
  tag: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("oci_tags")
    .select("digest")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("tag", "=", tag)
    .executeTakeFirst();
  return row?.digest ?? null;
}

export interface NewManifest {
  repoId: string;
  name: string;
  digest: string;
  mediaType: string;
  artifactType: string | null;
  subject: string | null;
  size: number;
  annotations: Record<string, string>;
  refs: string[];
}

/** Records a manifest and what it references; idempotent for identical bytes. */
export async function putManifest(db: DB, m: NewManifest): Promise<void> {
  await db
    .insertInto("oci_manifests")
    .values({
      repo_id: m.repoId,
      name: m.name,
      digest: m.digest,
      media_type: m.mediaType,
      artifact_type: m.artifactType,
      subject: m.subject,
      size: m.size,
      annotations: JSON.stringify(m.annotations),
      created_at: nowIso(),
    })
    .onConflict((oc) => oc.columns(["repo_id", "name", "digest"]).doNothing())
    .execute();
  for (const ref of m.refs) {
    await db
      .insertInto("oci_manifest_refs")
      .values({ repo_id: m.repoId, name: m.name, manifest: m.digest, ref })
      .onConflict((oc) => oc.columns(["repo_id", "name", "manifest", "ref"]).doNothing())
      .execute();
  }
}

/** Points `tag` at `digest`; returns the digest it pointed at before, if any. */
export async function setTag(
  db: DB,
  repoId: string,
  name: string,
  tag: string,
  digest: string,
): Promise<string | null> {
  const previous = await tagDigest(db, repoId, name, tag);
  const updatedAt = nowIso();
  await db
    .insertInto("oci_tags")
    .values({ repo_id: repoId, name, tag, digest, updated_at: updatedAt })
    .onConflict((oc) =>
      oc.columns(["repo_id", "name", "tag"]).doUpdateSet({ digest, updated_at: updatedAt }),
    )
    .execute();
  return previous;
}

export async function deleteTag(db: DB, repoId: string, name: string, tag: string) {
  const result = await db
    .deleteFrom("oci_tags")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("tag", "=", tag)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

/** Deletes a manifest, its references and every tag pointing at it. */
export async function deleteManifest(db: DB, repoId: string, name: string, digest: string) {
  await db
    .deleteFrom("oci_tags")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("digest", "=", digest)
    .execute();
  await db
    .deleteFrom("oci_manifest_refs")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("manifest", "=", digest)
    .execute();
  const result = await db
    .deleteFrom("oci_manifests")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("digest", "=", digest)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

export async function listTags(
  db: DB,
  repoId: string,
  name: string,
  options: { after?: string | null; limit?: number } = {},
): Promise<string[]> {
  let q = db
    .selectFrom("oci_tags")
    .select("tag")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .orderBy("tag");
  if (options.after) q = q.where("tag", ">", options.after);
  if (options.limit !== undefined) q = q.limit(options.limit);
  return (await q.execute()).map((r) => r.tag);
}

export async function hasImage(db: DB, repoId: string, name: string): Promise<boolean> {
  const row = await db
    .selectFrom("oci_manifests")
    .select("digest")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function listReferrers(
  db: DB,
  repoId: string,
  name: string,
  subject: string,
): Promise<ManifestRow[]> {
  const rows = await db
    .selectFrom("oci_manifests")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("subject", "=", subject)
    .orderBy("created_at")
    .execute();
  return rows.map(toManifest);
}

/** Image names with at least one manifest. */
export async function listImageNames(db: DB, repoId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("oci_manifests")
    .select("name")
    .distinct()
    .where("repo_id", "=", repoId)
    .orderBy("name")
    .execute();
  return rows.map((r) => r.name);
}

/** Whether any other manifest of this image references `digest`. */
export async function isReferenced(
  db: DB,
  repoId: string,
  name: string,
  digest: string,
): Promise<boolean> {
  const row = await db
    .selectFrom("oci_manifest_refs")
    .select("manifest")
    .where("ref", "=", digest)
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

export async function manifestRefs(
  db: DB,
  repoId: string,
  name: string,
  digest: string,
): Promise<string[]> {
  const rows = await db
    .selectFrom("oci_manifest_refs")
    .select("ref")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("manifest", "=", digest)
    .execute();
  return rows.map((r) => r.ref);
}

export async function isTagged(db: DB, repoId: string, name: string, digest: string) {
  const row = await db
    .selectFrom("oci_tags")
    .select("tag")
    .where("repo_id", "=", repoId)
    .where("name", "=", name)
    .where("digest", "=", digest)
    .limit(1)
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * `retention.deleteUntagged`: removes `digest` if no tag points at it, no
 * other manifest (an index) references it and it is not itself a referrer
 * (signatures and SBOMs are untagged by design). Recurses into an index's
 * children, and removes referrers of whatever it deletes.
 */
export async function pruneUntagged(
  db: DB,
  repoId: string,
  name: string,
  digest: string,
  depth = 0,
): Promise<string[]> {
  if (depth > 8) return [];
  const manifest = await getManifest(db, repoId, name, digest);
  if (!manifest || manifest.subject) return [];
  if (await isTagged(db, repoId, name, digest)) return [];
  if (await isReferenced(db, repoId, name, digest)) return [];
  const children = await manifestRefs(db, repoId, name, digest);
  const referrers = await listReferrers(db, repoId, name, digest);
  await deleteManifest(db, repoId, name, digest);
  const removed = [digest];
  for (const referrer of referrers) {
    await deleteManifest(db, repoId, name, referrer.digest);
    removed.push(referrer.digest);
  }
  for (const child of children) {
    removed.push(...(await pruneUntagged(db, repoId, name, child, depth + 1)));
  }
  return removed;
}
