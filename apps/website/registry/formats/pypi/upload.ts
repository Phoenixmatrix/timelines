import {
  readZipDirectory,
  readZipEntry,
  ZipFormatError,
  type RangeReader,
} from "@gitmatrix/formats/archive";
import {
  checkDistFilename,
  isValidProjectName,
  metadataField,
  MultipartError,
  multipartBoundary,
  normalizeName,
  normalizeVersion,
  parseCoreMetadata,
  parseDistFilename,
  parseMultipart,
  type CoreMetadata,
} from "@gitmatrix/formats/pypi";

import { audit } from "../../core/audit.ts";
import { principalOf } from "../../core/auth/actor.ts";
import { readBlobRange } from "../../core/blob-storage.ts";
import { storeBlob, type StoredBlob } from "../../core/blobs.ts";
import { addFile, createVersion, ensurePackage, getFile, getVersion } from "../../core/catalog.ts";
import { services, type AppContext } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import { loadRepo } from "../../core/http.ts";
import type { Repository } from "../../core/repos.ts";
import { deployTarget } from "../../core/virtual.ts";
import type { PypiFileMeta, PypiVersionMeta } from "./simple.ts";

const FIELD_LIMIT = 1024 * 1024;
const FIELDS_TOTAL_LIMIT = 8 * 1024 * 1024;
const METADATA_LIMIT = 8 * 1024 * 1024;
/** Fields kept in version metadata (form names; METADATA wins where both exist). */
const LIST_FIELDS = [
  "requires_dist",
  "provides_extra",
  "classifiers",
  "project_urls",
  "requires_external",
  "provides_dist",
  "obsoletes_dist",
  "license_file",
  "dynamic",
];
const SCALAR_FIELDS = [
  "summary",
  "home_page",
  "author",
  "author_email",
  "maintainer",
  "maintainer_email",
  "license",
  "license_expression",
  "keywords",
  "description_content_type",
  "metadata_version",
  "download_url",
  "platform",
];
const DESCRIPTION_LIMIT = 256 * 1024;

type Fields = Map<string, string[]>;

function field(fields: Fields, name: string): string | undefined {
  const value = fields.get(name)?.[0]?.trim();
  return value ? value : undefined;
}

function blobReader(bucket: R2Bucket, r2Key: string): RangeReader {
  return (offset, length) => readBlobRange(bucket, r2Key, offset, length);
}

/** `<name>-<version>.dist-info/METADATA` from a stored wheel, read with range requests. */
async function wheelMetadata(bucket: R2Bucket, blob: StoredBlob): Promise<Uint8Array> {
  const read = blobReader(bucket, blob.r2Key);
  let entries;
  try {
    entries = await readZipDirectory(read, blob.size);
  } catch (error) {
    if (error instanceof ZipFormatError)
      throw RegistryError.badRequest(`Invalid wheel: ${error.message}`);
    throw error;
  }
  const candidates = entries.filter((e) => /^[^/]+\.dist-info\/METADATA$/.test(e.name));
  if (candidates.length !== 1) {
    throw RegistryError.badRequest("Invalid wheel: expected exactly one .dist-info/METADATA");
  }
  try {
    return await readZipEntry(read, candidates[0]!, { maxBytes: METADATA_LIMIT });
  } catch (error) {
    if (error instanceof ZipFormatError)
      throw RegistryError.badRequest(`Invalid wheel: ${error.message}`);
    throw error;
  }
}

function alreadyExists(filename: string): RegistryError {
  return new RegistryError(
    "bad_request",
    `File already exists ('${filename}'). A distribution file cannot be replaced; upload a new version instead.`,
  );
}

function versionMetadata(
  fields: Fields,
  name: string,
  version: string,
  core: CoreMetadata | null,
): PypiVersionMeta {
  const out: PypiVersionMeta = { name, version };
  for (const key of SCALAR_FIELDS) {
    const fromCore = core ? metadataField(core, key.replace(/_/g, "-")) : undefined;
    const value = fromCore ?? field(fields, key);
    if (value) out[key] = value;
  }
  for (const key of LIST_FIELDS) {
    const coreKey =
      key === "classifiers"
        ? "classifier"
        : key === "project_urls"
          ? "project-url"
          : key.replace(/_/g, "-");
    const values = core?.fields[coreKey] ?? fields.get(key)?.filter(Boolean);
    if (values?.length) out[key] = values;
  }
  out.requiresPython =
    (core && metadataField(core, "requires-python")) ?? field(fields, "requires_python") ?? null;
  const description = (core?.body.trim() ? core.body : undefined) ?? field(fields, "description");
  if (description) out.description = description.slice(0, DESCRIPTION_LIMIT);
  return out;
}

/** Legacy upload API (`twine upload`, `uv publish`, `poetry publish`, flit, hatch, pdm). */
export async function upload(c: AppContext): Promise<Response> {
  const svc = services(c);
  let repo: Repository = await loadRepo(c, "pypi");
  if (repo.kind === "virtual") {
    const target = await deployTarget(svc, repo);
    if (!target)
      throw new RegistryError("unsupported", `${repo.key} has no default deploy repository`);
    repo = target;
  }
  if (repo.kind !== "local") throw new RegistryError("unsupported", "Upload to a local repository");
  const access = await svc.access();
  await access.require(repo, "write");

  const boundary = multipartBoundary(c.req.header("content-type"));
  if (!boundary) throw RegistryError.badRequest("Expected a multipart/form-data upload");
  const body = c.req.raw.body;
  if (!body) throw RegistryError.badRequest("Request body is empty");

  const fields: Fields = new Map();
  let fieldBytes = 0;
  let blob: StoredBlob | null = null;
  let filename: string | null = null;
  let duplicateOf: string | null = null;

  const identity = () => {
    const name = field(fields, "name");
    const version = field(fields, "version");
    if (!name || !isValidProjectName(name)) {
      throw new RegistryError("name_invalid", `Invalid project name ${JSON.stringify(name ?? "")}`);
    }
    const normalizedVersion = version ? normalizeVersion(version) : null;
    if (!version || !normalizedVersion) {
      throw new RegistryError(
        "version_invalid",
        `Invalid version ${JSON.stringify(version ?? "")}; see PEP 440`,
      );
    }
    return { name, normalized: normalizeName(name), version: normalizedVersion };
  };
  const pathFor = (normalized: string, version: string, file: string) =>
    `${normalized}/${version}/${file}`;

  try {
    for await (const part of parseMultipart(body, boundary)) {
      if (part.name === "content") {
        if (blob) throw RegistryError.badRequest("Only one file per upload");
        filename = part.filename?.split(/[\\/]/).pop() ?? "";
        if (!parseDistFilename(filename)) {
          throw RegistryError.badRequest(
            `Invalid distribution filename ${JSON.stringify(filename)}`,
          );
        }
        const sha256 = field(fields, "sha256_digest");
        const md5 = field(fields, "md5_digest");
        // Metadata sent first (twine, uv): refuse duplicates before storing any bytes.
        if (fields.has("name") && fields.has("version")) {
          const id = identity();
          const existing = await getFile(
            svc.db,
            repo.id,
            pathFor(id.normalized, id.version, filename),
          );
          if (existing) {
            if (!sha256 || existing.digest !== `sha256:${sha256.toLowerCase()}`)
              throw alreadyExists(filename);
            duplicateOf = existing.digest;
          }
        }
        blob = await storeBlob(svc.db, svc.bucket, part.body, {
          maxBytes: repo.config.maxUploadBytes,
          contentType: "application/octet-stream",
          expect: { sha256, md5 },
        });
      } else if (part.filename !== null) {
        // gpg_signature / attestations: accepted but not stored.
        await part.body.cancel();
      } else {
        const value = await part.text(FIELD_LIMIT);
        fieldBytes += value.length;
        if (fieldBytes > FIELDS_TOTAL_LIMIT)
          throw RegistryError.badRequest("Upload metadata is too large");
        const list = fields.get(part.name) ?? [];
        list.push(value);
        fields.set(part.name, list);
      }
    }
  } catch (error) {
    if (error instanceof MultipartError) throw RegistryError.badRequest(error.message);
    throw error;
  }

  const action = field(fields, ":action");
  if (action !== "file_upload") {
    throw RegistryError.badRequest(
      `Unsupported :action ${JSON.stringify(action ?? "")}; only file_upload is supported`,
    );
  }
  const protocol = field(fields, "protocol_version");
  if (protocol && protocol !== "1")
    throw RegistryError.badRequest(`Unknown protocol_version ${protocol}`);
  if (!blob || !filename) throw RegistryError.badRequest("Upload has no content");
  const id = identity();
  const filetype =
    field(fields, "filetype") ?? (filename.endsWith(".whl") ? "bdist_wheel" : "sdist");
  const problem = checkDistFilename(filename, id.name, id.version, filetype);
  if (problem) throw RegistryError.badRequest(problem);

  // Metadata sent after the file: verify the declared digests now.
  const sha256 = field(fields, "sha256_digest")?.toLowerCase();
  const md5 = field(fields, "md5_digest")?.toLowerCase();
  if (sha256 && `sha256:${sha256}` !== blob.digest) {
    throw new RegistryError("digest_invalid", "The sha256_digest does not match the uploaded file");
  }
  if (md5 && blob.md5 && md5 !== blob.md5) {
    throw new RegistryError("digest_invalid", "The md5_digest does not match the uploaded file");
  }

  const path = pathFor(id.normalized, id.version, filename);
  const existing = duplicateOf ? null : await getFile(svc.db, repo.id, path);
  if (existing && existing.digest !== blob.digest) throw alreadyExists(filename);
  if (duplicateOf || existing) return c.text("OK\n", 200);

  let core: CoreMetadata | null = null;
  let coreBlob: StoredBlob | null = null;
  if (filetype === "bdist_wheel") {
    const bytes = await wheelMetadata(svc.bucket, blob);
    core = parseCoreMetadata(new TextDecoder().decode(bytes));
    const metaName = metadataField(core, "name");
    const metaVersion = metadataField(core, "version");
    if (!metaName || normalizeName(metaName) !== id.normalized) {
      throw RegistryError.badRequest(
        `Wheel METADATA name ${JSON.stringify(metaName ?? "")} does not match ${id.name}`,
      );
    }
    if (!metaVersion || normalizeVersion(metaVersion) !== id.version) {
      throw RegistryError.badRequest(
        `Wheel METADATA version ${JSON.stringify(metaVersion ?? "")} does not match ${id.version}`,
      );
    }
    coreBlob = await storeBlob(svc.db, svc.bucket, bytes, {
      contentType: "text/plain; charset=utf-8",
    });
  }

  const actor = access.actor;
  const publishedBy = principalOf(actor);
  const pkg = await ensurePackage(svc.db, repo.id, id.name, id.normalized);
  const meta = versionMetadata(fields, id.name, field(fields, "version")!, core);
  let version = await getVersion<PypiVersionMeta>(svc.db, pkg.id, id.version);
  if (!version) {
    try {
      version = await createVersion(svc.db, pkg.id, id.version, meta, publishedBy);
    } catch (error) {
      // A parallel upload of another file of the same release created it.
      version = await getVersion<PypiVersionMeta>(svc.db, pkg.id, id.version);
      if (!version) throw error;
    }
  }

  const fileMeta: PypiFileMeta = {
    kind: "dist",
    filetype,
    pyversion: field(fields, "pyversion"),
    requiresPython: meta.requiresPython ?? null,
    blake2_256: field(fields, "blake2_256_digest") ?? null,
    ...(coreBlob ? { coreMetadataSha256: coreBlob.digest.slice("sha256:".length) } : {}),
  };
  if (coreBlob) {
    await addFile(svc.db, {
      repoId: repo.id,
      path: `${path}.metadata`,
      versionId: version.id,
      digest: coreBlob.digest,
      size: coreBlob.size,
      contentType: "text/plain; charset=utf-8",
      metadata: { kind: "core-metadata" } satisfies PypiFileMeta,
      createdBy: publishedBy,
    });
  }
  try {
    await addFile(svc.db, {
      repoId: repo.id,
      path,
      versionId: version.id,
      digest: blob.digest,
      size: blob.size,
      contentType:
        filename.endsWith(".whl") || filename.endsWith(".zip")
          ? "application/zip"
          : "application/gzip",
      metadata: fileMeta,
      createdBy: publishedBy,
    });
  } catch (error) {
    if (error instanceof RegistryError && error.code === "immutable") throw alreadyExists(filename);
    throw error;
  }
  await audit(svc.db, actor, "pypi.publish", {
    repoId: repo.id,
    target: `${id.normalized}==${id.version}`,
    detail: { filename, digest: blob.digest, size: blob.size },
  });
  return c.text("OK\n", 200);
}
