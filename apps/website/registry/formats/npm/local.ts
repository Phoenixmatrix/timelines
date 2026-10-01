import {
  buildPackument,
  distTagError,
  highestVersion,
  integrityFromHex,
  isValidVersion,
  packageNameError,
  parseIntegrity,
  PublishBodyError,
  PublishBodyScanner,
  sanitizeManifest,
  tarballFilename,
  TarballStats,
  type Packument,
  type ScanEvent,
} from "@gitmatrix/formats/npm";

import { audit } from "../../core/audit.ts";
import { actorLabel, principalOf, type Actor } from "../../core/auth/actor.ts";
import { commitBlob, writeBlob, type WrittenBlob } from "../../core/blobs.ts";
import {
  addFile,
  countDownload,
  createVersion,
  deleteDistTag,
  deletePackage,
  deleteVersion,
  ensurePackage,
  getDistTags,
  getFile,
  getPackage,
  getVersion,
  listVersions,
  setDistTag,
  updatePackageMetadata,
  updateVersion,
  type PackageRow,
  type VersionRow,
} from "../../core/catalog.ts";
import { services, type AppContext, type Services } from "../../core/context.ts";
import { nowIso } from "../../core/db.ts";
import { RegistryError } from "../../core/errors.ts";
import { safePath } from "../../core/http.ts";
import type { Repository } from "../../core/repos.ts";
import { serveBlob } from "../../core/blobs.ts";
import {
  cannotRepublish,
  guarded,
  MAX_MANIFEST_BYTES,
  MAX_METADATA_BYTES,
  MAX_PUBLISH_BODY,
  MAX_README_CHARS,
  notFound,
  revString,
  runMutation,
  tarballCacheControl,
  tarballUrl,
  type NpmPackageMeta,
  type NpmVersionMeta,
} from "./common.ts";

// ---------------------------------------------------------------------------
// Reads

function packageMeta(pkg: PackageRow): NpmPackageMeta {
  return pkg.metadata as NpmPackageMeta;
}

export function currentRev(pkg: PackageRow): string {
  return revString(pkg.id, packageMeta(pkg).rev ?? 1);
}

/** The full packument of a local package, tarball URLs pointing at `urlRepoKey`. */
export async function localPackument(
  svc: Services,
  repo: Repository,
  name: string,
  urlRepoKey: string,
): Promise<Packument | null> {
  const pkg = await getPackage(svc.db, repo.id, name);
  if (!pkg) return null;
  const versions = await listVersions<NpmVersionMeta>(svc.db, pkg.id);
  if (versions.length === 0) return null;
  const meta = packageMeta(pkg);
  return buildPackument({
    name: pkg.name,
    rev: currentRev(pkg),
    distTags: await getDistTags(svc.db, pkg.id),
    versions: versions.map((v) => ({
      version: v.version,
      manifest: v.metadata,
      createdAt: v.createdAt,
    })),
    created: pkg.createdAt,
    modified: meta.modified ?? pkg.updatedAt,
    readme: meta.readme,
    readmeFilename: meta.readmeFilename,
    maintainers: meta.maintainers,
    tarballUrl: (file) => tarballUrl(svc, urlRepoKey, pkg.name, file),
  });
}

export function tarballPath(name: string, file: string): string {
  const path = `${name}/-/${file}`;
  if (safePath(path) !== path) throw RegistryError.badRequest("Invalid tarball path");
  return path;
}

export async function localTarball(
  c: AppContext,
  repo: Repository,
  name: string,
  file: string,
  cacheRepo: Repository = repo,
): Promise<Response | null> {
  const svc = services(c);
  const found = await getFile(svc.db, repo.id, tarballPath(name, file));
  if (!found) return null;
  if (c.req.method === "GET") svc.waitUntil(countDownload(svc.db, found.id));
  return serveBlob(c.req.raw, svc.bucket, found, {
    contentType: "application/octet-stream",
    cacheControl: tarballCacheControl(cacheRepo),
  });
}

// ---------------------------------------------------------------------------
// Publish

interface ScannedBody {
  meta: unknown;
  tarball: WrittenBlob | null;
  stats: TarballStats | null;
}

function scanError(error: unknown): unknown {
  if (error instanceof PublishBodyError) {
    return error.tooLarge
      ? new RegistryError("too_large", error.message)
      : RegistryError.badRequest(error.message);
  }
  return error;
}

/**
 * Streams the publish body: the tarball attachment goes straight into R2
 * (uncommitted until verified), everything else is parsed as JSON.
 */
async function scanPublishBody(
  svc: Services,
  repo: Repository,
  body: ReadableStream<Uint8Array>,
): Promise<ScannedBody> {
  const scanner = new PublishBodyScanner({ maxMetadataBytes: MAX_METADATA_BYTES });
  const reader = body.getReader();
  const queue: ScanEvent[] = [];
  let ended = false;
  let total = 0;
  const next = async (): Promise<ScanEvent | null> => {
    while (queue.length === 0 && !ended) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      total += value.length;
      if (total > MAX_PUBLISH_BODY) {
        throw new RegistryError(
          "too_large",
          `Publish body exceeds ${MAX_PUBLISH_BODY} bytes (tarballs are limited to about 40 MB)`,
        );
      }
      try {
        queue.push(...scanner.push(value));
      } catch (error) {
        throw scanError(error);
      }
    }
    return queue.shift() ?? null;
  };

  let tarball: WrittenBlob | null = null;
  let stats: TarballStats | null = null;
  try {
    for (let event = await next(); event; event = await next()) {
      if (event.type !== "attachment") continue;
      if (!event.name.endsWith(".tgz")) {
        // Provenance bundles (`.sigstore`) and anything else are not stored.
        for (let e = await next(); e && e.type !== "end"; e = await next());
        continue;
      }
      if (tarball) throw RegistryError.badRequest("Publish one tarball at a time");
      const counter = new TarballStats();
      stats = counter;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          for (;;) {
            const e = await next();
            if (!e || e.type === "end") {
              counter.finish();
              controller.close();
              return;
            }
            if (e.type === "data" && e.bytes.length > 0) {
              counter.push(e.bytes);
              controller.enqueue(e.bytes);
              return;
            }
          }
        },
      });
      tarball = await writeBlob(svc.bucket, stream, {
        contentType: "application/octet-stream",
        maxBytes: repo.config.maxUploadBytes,
      });
    }
    let meta: unknown;
    try {
      meta = scanner.finish();
    } catch (error) {
      throw scanError(error);
    }
    return { meta, tarball, stats };
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (tarball) await svc.bucket.delete(tarball.r2Key).catch(() => undefined);
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function publisherOf(actor: Actor): { name: string; email?: string } {
  return { name: actorLabel(actor), ...(actor.email ? { email: actor.email } : {}) };
}

interface PublishPayload {
  name: string;
  version: string;
  manifest: NpmVersionMeta;
  distTags: Record<string, string>;
  readme?: string;
  readmeFilename?: string;
  file: string;
  blob: { digest: string; size: number };
  publisher: { name: string; email?: string };
  principal: string | null;
}

/**
 * `PUT /<pkg>`: a publish when the body carries a tarball, otherwise a
 * metadata update (what `npm deprecate` sends).
 */
export async function putPackage(
  c: AppContext,
  addressed: Repository,
  target: Repository,
  name: string,
) {
  const svc = services(c);
  const access = await svc.access();
  await access.require(target, "write");
  const body = c.req.raw.body;
  if (!body) throw RegistryError.badRequest("Request body is empty");
  const length = Number(c.req.header("content-length") ?? "0");
  if (length > MAX_PUBLISH_BODY) {
    throw new RegistryError("too_large", `Publish body exceeds ${MAX_PUBLISH_BODY} bytes`);
  }
  const { meta, tarball, stats } = await scanPublishBody(svc, target, body);
  const state = { committed: false };
  try {
    if (!isObject(meta)) throw RegistryError.badRequest("The publish body must be a JSON object");
    const docName = meta.name ?? meta._id;
    if (docName !== undefined && docName !== name) {
      throw RegistryError.badRequest(
        `Package name in the body (${JSON.stringify(docName)}) does not match the URL`,
      );
    }
    if (!tarball) {
      if (isObject(meta._attachments) && Object.keys(meta._attachments).length > 0) {
        throw RegistryError.badRequest("The publish body has no .tgz attachment");
      }
      return await updatePackument(c, addressed, target, name, meta, null);
    }
    return await publish(c, target, name, meta, tarball, stats!, state);
  } catch (error) {
    // Once committed, the blob row owns the object; GC reclaims it if unused.
    if (tarball && !state.committed) {
      await svc.bucket.delete(tarball.r2Key).catch(() => undefined);
    }
    throw error;
  }
}

async function publish(
  c: AppContext,
  repo: Repository,
  name: string,
  meta: Record<string, unknown>,
  tarball: WrittenBlob,
  stats: TarballStats,
  state: { committed: boolean },
): Promise<Response> {
  const svc = services(c);
  const actor = (await svc.access()).actor;
  const nameError = packageNameError(name);
  if (nameError) throw new RegistryError("name_invalid", `Invalid package name: ${nameError}`);

  const versions = meta.versions;
  if (!isObject(versions) || Object.keys(versions).length !== 1) {
    throw RegistryError.badRequest("A publish must contain exactly one version");
  }
  const [version, raw] = Object.entries(versions)[0]!;
  if (!isValidVersion(version)) {
    throw new RegistryError("version_invalid", `Invalid version: ${version}`);
  }
  if (!isObject(raw) || raw.name !== name || raw.version !== version) {
    throw RegistryError.badRequest("The version manifest must repeat the package name and version");
  }

  const declared = isObject(raw.dist) ? raw.dist : {};
  const integrity = parseIntegrity(declared.integrity);
  const mismatch = (algo: string, want: unknown, got: string) => {
    if (typeof want === "string" && want && want.toLowerCase() !== got) {
      throw new RegistryError(
        "digest_invalid",
        `${algo} mismatch: the tarball does not match dist.${algo === "sha1" ? "shasum" : "integrity"}`,
      );
    }
  };
  mismatch("sha512", integrity.sha512, tarball.sha512);
  mismatch("sha1", declared.shasum ?? integrity.sha1, tarball.sha1);
  const attachment = isObject(meta._attachments)
    ? Object.entries(meta._attachments).find(([key]) => key.endsWith(".tgz"))?.[1]
    : undefined;
  if (
    isObject(attachment) &&
    typeof attachment.length === "number" &&
    attachment.length !== tarball.size
  ) {
    throw new RegistryError(
      "size_invalid",
      `Attachment length ${String(attachment.length)} does not match ${tarball.size} bytes`,
    );
  }
  if (stats.error === "corrupt") {
    throw RegistryError.badRequest("The attachment is not a gzip-compressed tar archive");
  }

  const tags: Record<string, string> = {};
  if (isObject(meta["dist-tags"])) {
    for (const [tag, value] of Object.entries(meta["dist-tags"])) {
      const tagError = distTagError(tag);
      if (tagError) throw RegistryError.badRequest(`Invalid dist-tag ${tag}: ${tagError}`);
      if (value !== version)
        throw RegistryError.badRequest(`dist-tag ${tag} must point at ${version}`);
      tags[tag] = version;
    }
  }
  if (Object.keys(tags).length === 0) tags.latest = version;

  // Refuse early so a duplicate publish never commits its blob.
  const existing = await getPackage(svc.db, repo.id, name);
  if (
    existing &&
    ((packageMeta(existing).unpublished ?? []).includes(version) ||
      (await getVersion(svc.db, existing.id, version)))
  ) {
    throw cannotRepublish(version);
  }

  const file = tarballFilename(name, version);
  const counts = stats.result();
  const manifest: NpmVersionMeta = {
    ...sanitizeManifest(raw),
    _npmUser: publisherOf(actor),
    dist: {
      tarball: file,
      shasum: tarball.sha1,
      integrity: integrityFromHex("sha512", tarball.sha512),
      ...(counts ? { fileCount: counts.fileCount, unpackedSize: counts.unpackedSize } : {}),
    },
  };
  if (JSON.stringify(manifest).length > MAX_MANIFEST_BYTES) {
    throw RegistryError.badRequest(`The version manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
  }
  const readme =
    typeof meta.readme === "string"
      ? meta.readme
      : typeof raw.readme === "string"
        ? raw.readme
        : undefined;
  const readmeFilename =
    typeof meta.readmeFilename === "string"
      ? meta.readmeFilename
      : typeof raw.readmeFilename === "string"
        ? raw.readmeFilename
        : undefined;

  state.committed = true;
  const blob = await commitBlob(svc.db, svc.bucket, tarball);
  const payload: PublishPayload = {
    name,
    version,
    manifest,
    distTags: tags,
    readme: readme?.slice(0, MAX_README_CHARS),
    readmeFilename,
    file,
    blob: { digest: blob.digest, size: blob.size },
    publisher: publisherOf(actor),
    principal: principalOf(actor),
  };
  const result = await runMutation<{ rev: string }>(svc, repo, "publish", payload);
  await audit(svc.db, actor, "npm.publish", {
    repoId: repo.id,
    target: `${name}@${version}`,
    detail: { digest: blob.digest, size: blob.size, tags: Object.keys(tags) },
  });
  return c.json({ ok: true, id: name, rev: result.rev, success: true }, 201);
}

async function applyPublish(
  svc: Services,
  repo: Repository,
  p: PublishPayload,
): Promise<{ rev: string }> {
  const pkg = await ensurePackage(svc.db, repo.id, p.name, p.name);
  const meta = packageMeta(pkg);
  if ((meta.unpublished ?? []).includes(p.version)) throw cannotRepublish(p.version);
  let version: VersionRow;
  try {
    version = await createVersion(svc.db, pkg.id, p.version, p.manifest, p.principal);
  } catch (error) {
    if (error instanceof RegistryError && error.code === "immutable")
      throw cannotRepublish(p.version);
    throw error;
  }
  try {
    await addFile(svc.db, {
      repoId: repo.id,
      path: `${p.name}/-/${p.file}`,
      versionId: version.id,
      digest: p.blob.digest,
      size: p.blob.size,
      contentType: "application/octet-stream",
      createdBy: p.principal,
    });
  } catch (error) {
    await deleteVersion(svc.db, version.id);
    throw error;
  }
  for (const [tag, v] of Object.entries(p.distTags)) await setDistTag(svc.db, pkg.id, tag, v);
  const tags = await getDistTags(svc.db, pkg.id);
  if (!tags.latest) await setDistTag(svc.db, pkg.id, "latest", p.version);

  const maintainers = meta.maintainers ?? [];
  if (!maintainers.some((m) => m.name === p.publisher.name)) maintainers.push(p.publisher);
  const next: NpmPackageMeta = {
    ...meta,
    rev: (meta.rev ?? 0) + 1,
    modified: nowIso(),
    maintainers,
    ...(p.readme !== undefined ? { readme: p.readme, readmeFilename: p.readmeFilename } : {}),
  };
  if (typeof p.manifest.description === "string") next.description = p.manifest.description;
  if (Array.isArray(p.manifest.keywords)) next.keywords = p.manifest.keywords.map(String);
  await updatePackageMetadata(svc.db, pkg.id, next as Record<string, unknown>);
  return { rev: revString(pkg.id, next.rev!) };
}

// ---------------------------------------------------------------------------
// Metadata updates: deprecate, unpublish by PUT, dist-tags

interface UpdatePayload {
  name: string;
  rev: string | null;
  remove: string[];
  allowRemove: boolean;
  deprecations: Record<string, string | null>;
  distTags: Record<string, string> | null;
}

/**
 * `PUT /<pkg>/-rev/<rev>` (and `PUT /<pkg>` without a tarball): npm sends the
 * whole packument back. Deprecation messages are applied, versions missing
 * from the document are unpublished, and dist-tags are replaced.
 */
export async function updatePackument(
  c: AppContext,
  addressed: Repository,
  repo: Repository,
  name: string,
  body: unknown,
  rev: string | null,
): Promise<Response> {
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "write");
  if (!isObject(body) || !isObject(body.versions)) {
    throw RegistryError.badRequest("The document must contain versions");
  }
  const pkg = await getPackage(svc.db, repo.id, name);
  if (!pkg) throw notFound(name);
  const existing = await listVersions<NpmVersionMeta>(svc.db, pkg.id);
  const remove = existing.map((v) => v.version).filter((v) => !(v in (body.versions as object)));
  if (remove.length > 0) await access.require(repo, "delete");

  const deprecations: Record<string, string | null> = {};
  for (const [v, manifest] of Object.entries(body.versions)) {
    if (!isObject(manifest)) continue;
    const message = manifest.deprecated;
    deprecations[v] = typeof message === "string" && message !== "" ? message.slice(0, 1024) : null;
  }
  let distTags: Record<string, string> | null = null;
  if (isObject(body["dist-tags"])) {
    distTags = {};
    for (const [tag, value] of Object.entries(body["dist-tags"])) {
      if (distTagError(tag) || typeof value !== "string") {
        throw RegistryError.badRequest(`Invalid dist-tag ${tag}`);
      }
      distTags[tag] = value;
    }
  }
  const payload: UpdatePayload = {
    name,
    rev,
    remove,
    allowRemove: remove.length > 0,
    deprecations,
    distTags,
  };
  const result = await runMutation<{ rev: string | null; deleted: boolean }>(
    svc,
    repo,
    "update",
    payload,
  );
  const deprecated = Object.entries(deprecations).filter(([v, m]) => {
    const before = existing.find((e) => e.version === v)?.metadata.deprecated ?? null;
    return before !== m;
  });
  if (remove.length > 0) {
    await audit(svc.db, access.actor, "npm.unpublish", {
      repoId: repo.id,
      target: name,
      detail: { versions: remove, via: addressed.key },
    });
  }
  if (deprecated.length > 0) {
    await audit(svc.db, access.actor, "npm.deprecate", {
      repoId: repo.id,
      target: name,
      detail: { versions: Object.fromEntries(deprecated) },
    });
  }
  return c.json({ ok: true, id: name, rev: result.rev });
}

async function deleteVersionFiles(
  svc: Services,
  repo: Repository,
  versionIds: string[],
): Promise<void> {
  for (let i = 0; i < versionIds.length; i += 90) {
    await svc.db
      .deleteFrom("files")
      .where("repo_id", "=", repo.id)
      .where("version_id", "in", versionIds.slice(i, i + 90))
      .execute();
  }
}

async function dropPackage(svc: Services, repo: Repository, pkg: PackageRow): Promise<void> {
  const versions = await listVersions(svc.db, pkg.id);
  await deleteVersionFiles(
    svc,
    repo,
    versions.map((v) => v.id),
  );
  await deletePackage(svc.db, pkg.id);
}

async function saveMeta(svc: Services, pkg: PackageRow, meta: NpmPackageMeta): Promise<string> {
  const next = { ...meta, rev: (meta.rev ?? 1) + 1, modified: nowIso() };
  await updatePackageMetadata(svc.db, pkg.id, next as Record<string, unknown>);
  return revString(pkg.id, next.rev);
}

async function requirePackage(svc: Services, repo: Repository, name: string, rev: string | null) {
  const pkg = await getPackage(svc.db, repo.id, name);
  if (!pkg) throw notFound(name);
  if (rev && rev !== currentRev(pkg)) {
    throw RegistryError.conflict("Document update conflict: the package changed; retry");
  }
  return pkg;
}

/** Keeps `latest` pointing at a live version. */
async function repairLatest(svc: Services, pkgId: string, live: string[]): Promise<void> {
  const tags = await getDistTags(svc.db, pkgId);
  for (const [tag, version] of Object.entries(tags)) {
    if (!live.includes(version)) await deleteDistTag(svc.db, pkgId, tag);
  }
  if (!tags.latest || !live.includes(tags.latest)) {
    const latest = highestVersion(live);
    if (latest) await setDistTag(svc.db, pkgId, "latest", latest);
  }
}

async function applyUpdate(
  svc: Services,
  repo: Repository,
  p: UpdatePayload,
): Promise<{ rev: string | null; deleted: boolean }> {
  const pkg = await requirePackage(svc, repo, p.name, p.rev);
  const meta = packageMeta(pkg);
  const versions = await listVersions<NpmVersionMeta>(svc.db, pkg.id);
  const removing = versions.filter((v) => p.remove.includes(v.version));
  if (removing.length > 0 && !p.allowRemove) {
    throw RegistryError.denied("Unpublishing needs delete permission");
  }
  if (removing.length > 0 && removing.length === versions.length) {
    await dropPackage(svc, repo, pkg);
    return { rev: null, deleted: true };
  }
  if (removing.length > 0) {
    await deleteVersionFiles(
      svc,
      repo,
      removing.map((v) => v.id),
    );
    for (const v of removing) await deleteVersion(svc.db, v.id);
    meta.unpublished = [
      ...new Set([...(meta.unpublished ?? []), ...removing.map((v) => v.version)]),
    ];
  }
  const live = versions.filter((v) => !p.remove.includes(v.version));
  for (const v of live) {
    if (!(v.version in p.deprecations)) continue;
    const message = p.deprecations[v.version] ?? null;
    if ((v.metadata.deprecated ?? null) === message) continue;
    const metadata: NpmVersionMeta = { ...v.metadata };
    if (message) metadata.deprecated = message;
    else delete metadata.deprecated;
    await updateVersion(svc.db, v.id, {
      metadata,
      status: message ? "deprecated" : "active",
      statusReason: message,
    });
  }
  const liveVersions = live.map((v) => v.version);
  if (p.distTags) {
    const current = await getDistTags(svc.db, pkg.id);
    for (const tag of Object.keys(current)) {
      if (!(tag in p.distTags) && tag !== "latest") await deleteDistTag(svc.db, pkg.id, tag);
    }
    for (const [tag, version] of Object.entries(p.distTags)) {
      if (liveVersions.includes(version) && current[tag] !== version) {
        await setDistTag(svc.db, pkg.id, tag, version);
      }
    }
  }
  await repairLatest(svc, pkg.id, liveVersions);
  return { rev: await saveMeta(svc, pkg, meta), deleted: false };
}

export async function unpublishPackage(
  c: AppContext,
  repo: Repository,
  name: string,
  rev: string,
): Promise<Response> {
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "delete");
  await runMutation(svc, repo, "unpublishPackage", { name, rev });
  await audit(svc.db, access.actor, "npm.unpublish", {
    repoId: repo.id,
    target: name,
    detail: { all: true },
  });
  return c.json({ ok: true, id: name });
}

async function applyUnpublishPackage(
  svc: Services,
  repo: Repository,
  p: { name: string; rev: string | null },
): Promise<null> {
  const pkg = await requirePackage(svc, repo, p.name, p.rev);
  await dropPackage(svc, repo, pkg);
  return null;
}

/**
 * `DELETE /<pkg>/-/<file>/-rev/<rev>`: the last step of `npm unpublish
 * pkg@version`, after the version was already dropped from the document.
 */
export async function unpublishFile(
  c: AppContext,
  repo: Repository,
  name: string,
  file: string,
): Promise<Response> {
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "delete");
  const removed = await runMutation<string | null>(svc, repo, "unpublishFile", { name, file });
  if (removed) {
    await audit(svc.db, access.actor, "npm.unpublish", {
      repoId: repo.id,
      target: `${name}@${removed}`,
    });
  }
  return c.json({ ok: true });
}

async function applyUnpublishFile(
  svc: Services,
  repo: Repository,
  p: { name: string; file: string },
): Promise<string | null> {
  const pkg = await getPackage(svc.db, repo.id, p.name);
  if (!pkg) throw notFound(p.name);
  const found = await getFile(svc.db, repo.id, tarballPath(p.name, p.file));
  if (!found?.versionId) return null;
  const versions = await listVersions(svc.db, pkg.id);
  const version = versions.find((v) => v.id === found.versionId);
  if (!version) return null;
  if (versions.length === 1) {
    await dropPackage(svc, repo, pkg);
    return version.version;
  }
  await deleteVersionFiles(svc, repo, [version.id]);
  await deleteVersion(svc.db, version.id);
  const meta = packageMeta(pkg);
  meta.unpublished = [...new Set([...(meta.unpublished ?? []), version.version])];
  await repairLatest(
    svc,
    pkg.id,
    versions.filter((v) => v.id !== version.id).map((v) => v.version),
  );
  await saveMeta(svc, pkg, meta);
  return version.version;
}

export async function localDistTags(svc: Services, repo: Repository, name: string) {
  const pkg = await getPackage(svc.db, repo.id, name);
  return pkg ? getDistTags(svc.db, pkg.id) : null;
}

export async function changeDistTag(
  c: AppContext,
  repo: Repository,
  name: string,
  tag: string,
  version: string | null,
): Promise<Response> {
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "write");
  const tagError = distTagError(tag);
  if (tagError) throw RegistryError.badRequest(tagError);
  if (version === null && tag === "latest") {
    throw RegistryError.badRequest("The latest tag cannot be removed");
  }
  await runMutation(svc, repo, "distTag", { name, tag, version });
  await audit(svc.db, access.actor, version ? "npm.dist-tag.add" : "npm.dist-tag.rm", {
    repoId: repo.id,
    target: name,
    detail: { tag, version },
  });
  return c.json({ ok: true });
}

async function applyDistTag(
  svc: Services,
  repo: Repository,
  p: { name: string; tag: string; version: string | null },
): Promise<null> {
  const pkg = await requirePackage(svc, repo, p.name, null);
  if (p.version !== null) {
    if (!(await getVersion(svc.db, pkg.id, p.version))) {
      throw RegistryError.notFound(`${p.name}@${p.version} does not exist`);
    }
    await setDistTag(svc.db, pkg.id, p.tag, p.version);
  } else {
    const tags = await getDistTags(svc.db, pkg.id);
    if (!(p.tag in tags)) throw RegistryError.notFound(`${p.name} has no ${p.tag} tag`);
    await deleteDistTag(svc.db, pkg.id, p.tag);
  }
  await saveMeta(svc, pkg, packageMeta(pkg));
  return null;
}

export const npmMutations = {
  publish: guarded(applyPublish),
  update: guarded(applyUpdate),
  unpublishPackage: guarded(applyUnpublishPackage),
  unpublishFile: guarded(applyUnpublishFile),
  distTag: guarded(applyDistTag),
};
