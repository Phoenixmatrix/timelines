import { sql } from "kysely";
import type { PackageContentEntry, PackageContents } from "../../shared/packageContents.ts";
import { getBlob, readBlobText, serveBlob, parseRange } from "../core/blobs.ts";
import { readBlobStream } from "../core/blob-storage.ts";
import { getVersion } from "../core/catalog.ts";
import type { Services } from "../core/context.ts";
import { parseJson } from "../core/db.ts";
import { RegistryError } from "../core/errors.ts";
import { getManifest, tagDigest } from "../formats/oci/store.ts";
import { archivePath } from "./archive.ts";
import { locate, type Located } from "./service.ts";

export interface ContentsOptions {
  version: string;
  path?: string;
  offset?: number;
  limit?: number;
  manifest?: string;
}
const missing = () => RegistryError.notFound("Version content not found.");
function downloadUrl(
  owner: string,
  format: string,
  name: string,
  version: string,
  id: string,
  manifest?: string,
): string {
  const params = new URLSearchParams({ version, id });
  if (manifest) params.set("manifest", manifest);
  return `/api/packages/${[owner, format, name].map(encodeURIComponent).join("/")}/contents/download?${params.toString()}`;
}
async function jsonBlob(svc: Services, digest: string): Promise<Record<string, unknown>> {
  const blob = await getBlob(svc.db, digest);
  if (!blob) throw missing();
  if (blob.size > 4 * 1024 * 1024)
    throw new RegistryError("too_large", "Manifest exceeds the 4 MiB inspection limit.");
  const value: unknown = JSON.parse(await readBlobText(svc.bucket, blob.r2Key));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw RegistryError.badRequest("Invalid manifest.");
  return value as Record<string, unknown>;
}
interface Descriptor {
  digest: string;
  size: number;
  mediaType?: string;
  platform?: Record<string, string>;
}
function descriptors(value: unknown): Descriptor[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (v): v is Descriptor =>
      v &&
      typeof v === "object" &&
      typeof v.digest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(v.digest),
  );
}
async function ociSelection(svc: Services, at: Located, version: string, selected?: string) {
  const root = version.startsWith("sha256:")
    ? version
    : await tagDigest(svc.db, at.feed.id, at.pkg.name, version);
  if (!root || !(await getManifest(svc.db, at.feed.id, at.pkg.name, root))) throw missing();
  const target = selected || root;
  const queue = [root];
  const seen = new Set<string>();
  while (queue.length) {
    const digest = queue.shift()!;
    if (seen.has(digest)) continue;
    seen.add(digest);
    if (seen.size > 1024)
      throw new RegistryError("too_large", "Manifest graph exceeds the inspection limit.");
    if (!(await getManifest(svc.db, at.feed.id, at.pkg.name, digest))) continue;
    const manifest = await jsonBlob(svc, digest);
    if (digest === target) return { digest, manifest };
    queue.push(...descriptors(manifest.manifests).map((d) => d.digest));
  }
  throw missing();
}
function ociEntries(digest: string, manifest: Record<string, unknown>): PackageContentEntry[] {
  const entries: PackageContentEntry[] = [
    {
      id: `0:${digest}`,
      name: "manifest.json",
      path: "manifest.json",
      kind: "manifest",
      size: null,
      digest,
      downloadUrl: null,
    },
  ];
  for (const [kind, list] of [
    ["manifest", descriptors(manifest.manifests)],
    ["config", descriptors([manifest.config])],
    ["layer", descriptors(manifest.layers)],
    ["layer", descriptors(manifest.blobs)],
  ] as const) {
    for (const d of list) {
      const platform = d.platform
        ? [d.platform.os, d.platform.architecture, d.platform.variant].filter(Boolean).join("/")
        : undefined;
      entries.push({
        id: `${entries.length}:${d.digest}`,
        name:
          kind === "manifest" ? platform || d.digest : kind === "config" ? "config.json" : d.digest,
        path: d.digest,
        kind,
        size: typeof d.size === "number" ? d.size : null,
        digest: d.digest,
        downloadUrl: null,
        ...(d.mediaType ? { contentType: d.mediaType } : {}),
        ...(platform ? { platform } : {}),
        ...(kind === "manifest" ? { manifestDigest: d.digest } : {}),
      });
    }
  }
  return entries;
}
async function distribution(svc: Services, at: Located, version: string) {
  if (at.feed.format === "generic") {
    if (version.includes("/")) throw missing();
    const prefix = `${at.pkg.name}/${version}/`;
    const exact = `${at.pkg.name}/${version}`;
    const query = svc.db
      .selectFrom("files")
      .where("repo_id", "=", at.feed.id)
      .where((eb) =>
        eb.or([
          sql<boolean>`substr(path, 1, ${prefix.length}) = ${prefix}`,
          eb("path", "=", exact),
          ...(version === at.pkg.name ? [eb("path", "=", at.pkg.name)] : []),
        ]),
      );
    return { query, metadata: at.pkg.metadata, versionRow: null };
  }
  const row = await getVersion(svc.db, at.pkg.id, version);
  if (!row) throw missing();
  return {
    query: svc.db
      .selectFrom("files")
      .where("repo_id", "=", at.feed.id)
      .where("version_id", "=", row.id),
    metadata: { package: at.pkg.metadata, version: row.metadata },
    versionRow: row,
  };
}
async function npmCache(svc: Services, at: Located, version: string) {
  const dist = await distribution(svc, at, version);
  const file = await dist.query.selectAll().orderBy("path").executeTakeFirst();
  if (!file) throw missing();
  const id = await svc.repoObject(at.feed).npmArchive(at.feed.id, file.digest);
  const cache = await svc.db
    .selectFrom("archive_caches")
    .selectAll()
    .where("id", "=", id)
    .where("repo_id", "=", at.feed.id)
    .where("digest", "=", file.digest)
    .where("ready", "=", 1)
    .executeTakeFirst();
  if (!cache) throw missing();
  return { cache, metadata: dist.metadata };
}

export async function packageContents(
  svc: Services,
  owner: string,
  format: string,
  name: string,
  options: ContentsOptions,
): Promise<PackageContents> {
  const at = await locate(svc, owner, format, name);
  if (!options.version) throw RegistryError.badRequest("Select a version.");
  const offset = Math.max(0, Math.trunc(options.offset ?? 0));
  const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 100)));
  const path = options.path ? archivePath(options.path) : "";
  const result: PackageContents = {
    format: at.feed.format,
    version: options.version,
    path,
    offset,
    limit,
    total: 0,
    files: [],
    metadata: {},
    manifest: null,
    config: null,
  };
  if (format === "oci") {
    const selected = await ociSelection(svc, at, options.version, options.manifest);
    const entries = ociEntries(selected.digest, selected.manifest);
    result.manifest = selected.manifest;
    result.metadata = at.pkg.metadata;
    const config = entries.find((e) => e.kind === "config");
    if (config?.digest) result.config = await jsonBlob(svc, config.digest);
    result.total = entries.length;
    result.files = entries.slice(offset, offset + limit);
    for (const entry of result.files) {
      const blob = await getBlob(svc.db, entry.digest!);
      if (!blob) throw missing();
      entry.size = blob.size;
      entry.checksums = { sha256: blob.digest.replace(/^sha256:/, "") };
      entry.downloadUrl = downloadUrl(
        owner,
        format,
        name,
        options.version,
        entry.id,
        selected.digest,
      );
    }
    return result;
  }
  if (format === "releases") {
    const release = await svc.db
      .selectFrom("releases")
      .selectAll()
      .where("repo_id", "=", at.feed.id)
      .where("project", "=", at.pkg.name)
      .where("tag", "=", options.version)
      .executeTakeFirst();
    if (!release || (release.draft === 1 && at.access === "read")) throw missing();
    const query = svc.db.selectFrom("release_assets").where("release_id", "=", release.id);
    result.metadata = {
      ...at.pkg.metadata,
      title: release.title,
      notes: release.notes,
      draft: release.draft === 1,
      prerelease: release.prerelease === 1,
    };
    result.total = Number(
      (await query.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst())?.n ?? 0,
    );
    result.files = (
      await query.selectAll().orderBy("name").offset(offset).limit(limit).execute()
    ).map((f) => ({
      id: f.name,
      name: f.name,
      path: f.name,
      kind: "file",
      size: f.size,
      digest: f.digest,
      contentType: f.content_type,
      metadata: { label: f.label },
      downloadUrl: downloadUrl(owner, format, name, options.version, f.name),
    }));
  } else if (format === "npm") {
    const { cache, metadata } = await npmCache(svc, at, options.version);
    result.metadata = metadata;
    if (path) {
      const dir = await svc.db
        .selectFrom("archive_members")
        .select("kind")
        .where("cache_id", "=", cache.id)
        .where("path", "=", path)
        .executeTakeFirst();
      if (dir?.kind !== "directory") throw missing();
    }
    const query = svc.db
      .selectFrom("archive_members")
      .where("cache_id", "=", cache.id)
      .where("parent", "=", path);
    result.total = Number(
      (await query.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst())?.n ?? 0,
    );
    result.files = (
      await query.selectAll().orderBy("kind").orderBy("path").offset(offset).limit(limit).execute()
    ).map((f) => ({
      id: f.path,
      name: f.path.split("/").pop()!,
      path: f.path,
      kind: f.kind,
      size: f.kind === "directory" ? null : f.size,
      digest: f.digest,
      downloadUrl:
        f.kind === "directory" ? null : downloadUrl(owner, format, name, options.version, f.path),
    }));
    const manifest = await svc.db
      .selectFrom("archive_members")
      .selectAll()
      .where("cache_id", "=", cache.id)
      .where("path", "in", ["package/package.json", "package.json"])
      .where("kind", "=", "file")
      .orderBy("path", "desc")
      .executeTakeFirst();
    if (manifest) {
      if (manifest.size > 4 * 1024 * 1024)
        throw new RegistryError("too_large", "package.json exceeds the 4 MiB inspection limit.");
      result.manifest = JSON.parse(
        await new Response(
          await readBlobStream(svc.bucket, cache.r2_key, {
            offset: manifest.offset,
            length: manifest.size,
          }),
        ).text(),
      );
    }
  } else {
    const dist = await distribution(svc, at, options.version);
    result.metadata = dist.metadata;
    if (format === "brew" && typeof dist.versionRow?.metadata.digest === "string") {
      const digest = dist.versionRow.metadata.digest;
      const blob = await getBlob(svc.db, digest);
      if (!blob) throw missing();
      const filePath =
        typeof dist.versionRow.metadata.path === "string"
          ? dist.versionRow.metadata.path
          : at.pkg.name;
      result.total = 1;
      if (offset === 0)
        result.files = [
          {
            id: "formula",
            name: filePath.split("/").pop()!,
            path: filePath,
            kind: "file",
            size: blob.size,
            digest,
            downloadUrl: downloadUrl(owner, format, name, options.version, "formula"),
          },
        ];
    } else {
      result.total = Number(
        (await dist.query.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst())?.n ??
          0,
      );
      if (format === "generic" && !result.total) throw missing();
      result.files = (
        await dist.query.selectAll().orderBy("path").offset(offset).limit(limit).execute()
      ).map((f) => ({
        id: f.id,
        name: f.path.split("/").pop()!,
        path: f.path,
        kind: "file",
        size: f.size,
        digest: f.digest,
        contentType: f.content_type,
        metadata: parseJson(f.metadata, {}),
        downloadUrl: downloadUrl(owner, format, name, options.version, f.id),
      }));
    }
  }
  for (const file of result.files) {
    if (!file.digest) continue;
    const blob = await getBlob(svc.db, file.digest);
    file.checksums = {
      sha256: file.digest.replace(/^sha256:/, ""),
      ...(blob?.md5 ? { md5: blob.md5 } : {}),
      ...(blob?.sha1 ? { sha1: blob.sha1 } : {}),
      ...(blob?.sha512 ? { sha512: blob.sha512 } : {}),
    };
  }
  return result;
}

export async function downloadPackageContent(
  svc: Services,
  owner: string,
  format: string,
  name: string,
  options: ContentsOptions,
  id: string,
): Promise<Response> {
  const at = await locate(svc, owner, format, name);
  if (!options.version || !id) throw missing();
  let digest: string;
  let filename: string;
  if (format === "npm") {
    const { cache } = await npmCache(svc, at, options.version);
    const member = await svc.db
      .selectFrom("archive_members")
      .selectAll()
      .where("cache_id", "=", cache.id)
      .where("path", "=", archivePath(id))
      .where("kind", "=", "file")
      .executeTakeFirst();
    if (!member) throw missing();
    const headers = new Headers({
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(member.path.split("/").pop()!)}`,
      "accept-ranges": "bytes",
    });
    const range = parseRange(svc.request.headers.get("range"), member.size);
    if (range === "invalid") {
      headers.set("content-range", `bytes */${member.size}`);
      return new Response(null, { status: 416, headers });
    }
    const offset = range?.offset ?? 0;
    const length = range?.length ?? member.size;
    headers.set("content-length", String(length));
    if (range)
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${member.size}`);
    return new Response(
      svc.request.method === "HEAD" || length === 0
        ? null
        : await readBlobStream(svc.bucket, cache.r2_key, {
            offset: member.offset + offset,
            length,
          }),
      { status: range ? 206 : 200, headers },
    );
  } else if (format === "oci") {
    const selected = await ociSelection(svc, at, options.version, options.manifest);
    const entry = ociEntries(selected.digest, selected.manifest).find((e) => e.id === id);
    if (!entry?.digest) throw missing();
    digest = entry.digest;
    filename = entry.name;
  } else if (format === "releases") {
    const release = await svc.db
      .selectFrom("releases")
      .selectAll()
      .where("repo_id", "=", at.feed.id)
      .where("project", "=", at.pkg.name)
      .where("tag", "=", options.version)
      .executeTakeFirst();
    if (!release || (release.draft === 1 && at.access === "read")) throw missing();
    const asset = await svc.db
      .selectFrom("release_assets")
      .selectAll()
      .where("release_id", "=", release.id)
      .where("name", "=", id)
      .executeTakeFirst();
    if (!asset) throw missing();
    digest = asset.digest;
    filename = asset.name;
  } else {
    const dist = await distribution(svc, at, options.version);
    if (
      format === "brew" &&
      id === "formula" &&
      typeof dist.versionRow?.metadata.digest === "string"
    ) {
      digest = dist.versionRow.metadata.digest;
      const filePath = dist.versionRow.metadata.path;
      filename = typeof filePath === "string" ? filePath.split("/").pop()! : "formula.rb";
    } else {
      const file = await dist.query.selectAll().where("id", "=", id).executeTakeFirst();
      if (!file) throw missing();
      digest = file.digest;
      filename = file.path.split("/").pop()!;
    }
  }
  const blob = await getBlob(svc.db, digest);
  if (!blob) throw missing();
  return serveBlob(svc.request, svc.bucket, blob, {
    filename,
    contentType: "application/octet-stream",
    cacheControl: "no-store",
  });
}
