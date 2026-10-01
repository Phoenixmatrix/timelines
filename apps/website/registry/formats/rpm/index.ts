import { createHash } from "node:crypto";

import { gzipSync } from "@gitmatrix/formats/archive";
import {
  filelistsPackage,
  metadataHead,
  metadataTail,
  nevra,
  otherPackage,
  parseNevra,
  parseRpm,
  primaryPackage,
  repomdXml,
  RPM_ARCH,
  RPM_NAME,
  RPM_VERSION,
  rpmFilename,
  rpmHeaderSpan,
  type MetadataKind,
  type RpmPackage,
} from "@gitmatrix/formats/rpm";
import { Hono } from "hono";

import { audit } from "../../core/audit.ts";
import { principalOf } from "../../core/auth/actor.ts";
import { serveBlob, storeBlob, type StoredBlob } from "../../core/blobs.ts";
import {
  addFile,
  countDownload,
  createVersion,
  deleteFile,
  deletePackage,
  deleteVersion,
  ensurePackage,
  getFile,
  getPackage,
  getVersion,
  listVersions,
} from "../../core/catalog.ts";
import { services, type AppContext, type AppEnv, type Services } from "../../core/context.ts";
import { parseJson } from "../../core/db.ts";
import { deleteDerived, getDerived, putDerived, readDerivedText } from "../../core/derived.ts";
import { RegistryError } from "../../core/errors.ts";
import { loadRepo, restPath, safePath, textError } from "../../core/http.ts";
import { cachedArtifact, cachedMetadata } from "../../core/remote.ts";
import type { Repository } from "../../core/repos.ts";
import { ensureSigningKey, rotateSigningKey, servePublicKey } from "../_signing/index.ts";
import { derivedOrBuild, mutate, readRange, readState, serveIndex } from "../_signing/repo.ts";
import type { FormatModule } from "../types.ts";

/**
 * RPM repositories for dnf, yum and zypper. Uploaded packages are parsed from
 * their headers only; the RepoDO writes createrepo_c-compatible repodata with
 * content-addressed file names and a detached signature on repomd.xml.
 * Remote repositories proxy an upstream mirror byte-for-byte.
 */

const RPM_TYPE = "application/x-rpm";
const STATE_PATH = "_rpm/state.json";
/** Earlier repodata sets kept so clients holding an older repomd.xml still resolve. */
const GENERATIONS_KEPT = 3;

interface RpmVersionMeta {
  nevra: string;
  name: string;
  epoch: string;
  version: string;
  release: string;
  arch: string;
  sha256: string;
  size: number;
  location: string;
  fileTime: number;
  summary: string;
}

interface RpmState {
  /** Newest first: the repodata file paths of each recent generation. */
  generations: string[][];
  dataKey?: string;
}

const fragmentPath = (sha256: string) => `_rpm/pkg/${sha256}.json`;

// ---------------------------------------------------------------------------
// Reads

function configRepo(svc: Services, repo: Repository): string {
  const base = `${svc.baseUrl}/rpm/${repo.key}`;
  const lines = [
    `[${repo.key}]`,
    `name=${repo.description ? repo.description.replace(/[\r\n]+/g, " ") : `${repo.key} (gitmatrix)`}`,
    `baseurl=${base}/`,
    "enabled=1",
    ...(repo.kind === "remote"
      ? [
          // Proxied packages keep their upstream signatures; import the distribution's key.
          "gpgcheck=1",
          "repo_gpgcheck=0",
          "#gpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-<distribution>",
        ]
      : [
          // Packages are not re-signed by the registry; the repodata is.
          "gpgcheck=0",
          "repo_gpgcheck=1",
          `gpgkey=${base}/repodata/repomd.xml.key`,
        ]),
    "metadata_expire=5m",
  ];
  if (repo.visibility !== "public") {
    lines.push("# Private repository: add credentials (a personal access token as password):");
    lines.push("#username=token", "#password=<personal access token>");
  }
  return `${lines.join("\n")}\n`;
}

async function readRemote(c: AppContext, repo: Repository, path: string): Promise<Response> {
  const svc = services(c);
  if (!path) throw RegistryError.notFound("Not found");
  const mutable =
    /^(.*\/)?repodata\/repomd\.xml(\.asc|\.key)?$/.test(path) ||
    /(^|\/)(metalink|mirrorlist)(\.xml)?$/.test(path);
  if (mutable) {
    const meta = await cachedMetadata(svc, repo, path);
    if (meta.status !== 200) throw RegistryError.notFound(`${path} not found upstream`);
    const file = await getDerived(svc.db, repo.id, `upstream/${path}`);
    if (!file) throw RegistryError.notFound(`${path} not found upstream`);
    return serveIndex(c, svc, file);
  }
  const cached = await cachedArtifact(svc, repo, path);
  if (!cached) throw RegistryError.notFound(`${path} not found upstream`);
  return serveBlob(c.req.raw, svc.bucket, cached.blob, {
    contentType: path.endsWith(".rpm") ? RPM_TYPE : cached.contentType,
  });
}

async function read(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "rpm");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const path = safePath(restPath(c, 2));
  if (path === "config.repo" || path === `${repo.key}.repo`) {
    return c.text(configRepo(svc, repo), 200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, max-age=0, must-revalidate",
    });
  }
  if (repo.kind === "remote") return readRemote(c, repo, path);

  if (path === "repodata/repomd.xml.key" || path === "key.asc" || path === "RPM-GPG-KEY") {
    return servePublicKey(c, svc, repo, "asc");
  }
  if (path === "key.gpg") return servePublicKey(c, svc, repo, "gpg");
  if (path.startsWith("repodata/")) {
    const file =
      path === "repodata/repomd.xml" || path === "repodata/repomd.xml.asc"
        ? await derivedOrBuild(svc, repo, path, STATE_PATH)
        : await getDerived(svc.db, repo.id, path);
    if (!file) throw RegistryError.notFound(`${path} not found`);
    return serveIndex(c, svc, file);
  }
  const file = path ? await getFile(svc.db, repo.id, path) : null;
  if (!file) throw RegistryError.notFound(`${path || "/"} not found`);
  if (c.req.method === "GET") svc.waitUntil(countDownload(svc.db, file.id));
  return serveBlob(c.req.raw, svc.bucket, file, {
    contentType: RPM_TYPE,
    filename: path.split("/").pop(),
  });
}

// ---------------------------------------------------------------------------
// Upload

async function readHeader(bucket: R2Bucket, blob: StoredBlob): Promise<RpmPackage> {
  let bytes = await readRange(bucket, blob, 0, 256 * 1024);
  for (let i = 0; i < 4; i++) {
    const need = rpmHeaderSpan(bytes);
    if (need <= bytes.length) return parseRpm(bytes);
    if (need > blob.size) throw new Error("truncated RPM header");
    bytes = await readRange(bucket, blob, 0, need);
  }
  throw new Error("could not read the RPM header");
}

interface PublishPayload {
  path: string;
  digest: string;
  meta: RpmVersionMeta;
  publishedBy: string | null;
}

async function publishMutation(
  svc: Services,
  repo: Repository,
  raw: unknown,
): Promise<{ created: boolean; path: string }> {
  const { path, digest, meta, publishedBy } = raw as PublishPayload;
  const pkg = await ensurePackage(svc.db, repo.id, meta.name, meta.name);
  const key = `${meta.epoch}:${meta.version}-${meta.release}.${meta.arch}`;
  const existing = await getVersion<RpmVersionMeta>(svc.db, pkg.id, key);
  if (existing) {
    if (existing.metadata.sha256 !== meta.sha256) {
      throw new RegistryError("immutable", `${meta.nevra} already exists with different contents`);
    }
    return { created: false, path: existing.metadata.location };
  }
  const clash = await getFile(svc.db, repo.id, path);
  if (clash && clash.digest !== digest) {
    throw new RegistryError("immutable", `${path} already exists with different contents`);
  }
  const version = await createVersion(svc.db, pkg.id, key, meta, publishedBy);
  if (clash) await deleteFile(svc.db, repo.id, path);
  await addFile(svc.db, {
    repoId: repo.id,
    path,
    versionId: version.id,
    digest,
    size: meta.size,
    contentType: RPM_TYPE,
    createdBy: publishedBy,
  });
  return { created: true, path };
}

async function upload(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "rpm");
  const svc = services(c);
  if (repo.kind !== "local") throw new RegistryError("unsupported", "Upload to a local repository");
  const access = await svc.access();
  await access.require(repo, "write");
  const requested = safePath(restPath(c, 2));
  if (!requested.endsWith(".rpm")) throw RegistryError.badRequest("Only .rpm files are accepted");
  if (/^(repodata|_rpm)\//.test(requested)) {
    throw RegistryError.badRequest(`${requested} is a reserved path`);
  }
  const body = c.req.raw.body;
  if (!body) throw RegistryError.badRequest("Request body is empty");

  const blob = await storeBlob(svc.db, svc.bucket, body, {
    contentType: RPM_TYPE,
    maxBytes: repo.config.maxUploadBytes,
    expect: {
      sha256: c.req.header("x-checksum-sha256") ?? undefined,
      sha1: c.req.header("x-checksum-sha1") ?? undefined,
      md5: c.req.header("x-checksum-md5") ?? undefined,
    },
  });
  let pkg: RpmPackage;
  try {
    pkg = await readHeader(svc.bucket, blob);
  } catch (error) {
    throw RegistryError.badRequest(`Invalid .rpm: ${(error as Error).message}`);
  }
  if (
    !RPM_NAME.test(pkg.name) ||
    !RPM_VERSION.test(pkg.version) ||
    !RPM_VERSION.test(pkg.release) ||
    !RPM_ARCH.test(pkg.arch) ||
    !/^\d+$/.test(pkg.epoch)
  ) {
    throw new RegistryError("name_invalid", `Invalid package identity: ${nevra(pkg)}`);
  }
  const isUpload = requested.startsWith("upload/");
  const filename = rpmFilename(pkg);
  const path = isUpload ? `Packages/${filename[0]!.toLowerCase()}/${filename}` : requested;
  const sha256 = blob.digest.slice("sha256:".length);
  const fileTime = Math.floor(Date.now() / 1000);
  const meta: RpmVersionMeta = {
    nevra: nevra(pkg),
    name: pkg.name,
    epoch: pkg.epoch,
    version: pkg.version,
    release: pkg.release,
    arch: pkg.arch,
    sha256,
    size: blob.size,
    location: path,
    fileTime,
    summary: pkg.summary,
  };
  const result = await mutate<{ created: boolean; path: string }>(svc, repo, "publish", {
    path,
    digest: blob.digest,
    meta,
    publishedBy: principalOf(access.actor),
  } satisfies PublishPayload);
  if (result.created) {
    // Pre-rendered XML (file lists can be large) lives in R2, not in the D1 row.
    const info = { sha256, size: blob.size, location: path, fileTime };
    const fragments: Record<MetadataKind, string> = {
      primary: primaryPackage(pkg, info),
      filelists: filelistsPackage(pkg, info),
      other: otherPackage(pkg, info),
    };
    await putDerived(
      svc.db,
      svc.bucket,
      repo.id,
      fragmentPath(sha256),
      JSON.stringify(fragments),
      "application/json",
    );
  }
  await audit(svc.db, access.actor, "rpm.publish", {
    repoId: repo.id,
    target: meta.nevra,
    detail: { path: result.path, digest: blob.digest, created: result.created },
  });
  await svc.repoObject(repo).requestRebuild(repo.id);
  const url = `${svc.baseUrl}/rpm/${repo.key}/${result.path.split("/").map(encodeURIComponent).join("/")}`;
  return c.json(
    {
      repo: repo.key,
      path: `/${result.path}`,
      created: result.created,
      downloadUri: url,
      mimeType: RPM_TYPE,
      size: blob.size,
      nevra: meta.nevra,
      checksums: { sha256, sha1: blob.sha1, md5: blob.md5 },
    },
    result.created ? 201 : 200,
    { location: url },
  );
}

// ---------------------------------------------------------------------------
// repodata generation

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function rebuild(svc: Services, repo: Repository): Promise<void> {
  if (repo.kind !== "local") return;
  const state = await readState<RpmState>(svc, repo, STATE_PATH, { generations: [] });
  const rows = await svc.db
    .selectFrom("versions as v")
    .innerJoin("packages as p", "p.id", "v.package_id")
    .select(["v.metadata"])
    .where("p.repo_id", "=", repo.id)
    .execute();
  const metas = rows
    .map((r) => parseJson<RpmVersionMeta | null>(r.metadata, null))
    .filter((m): m is RpmVersionMeta => m !== null && typeof m.sha256 === "string")
    .sort((a, b) => (a.location < b.location ? -1 : a.location > b.location ? 1 : 0));

  const parts: Record<MetadataKind, string[]> = { primary: [], filelists: [], other: [] };
  for (const meta of metas) {
    const file = await getDerived(svc.db, repo.id, fragmentPath(meta.sha256));
    if (!file) continue;
    const fragments = parseJson<Record<MetadataKind, string> | null>(
      await readDerivedText(svc.bucket, file),
      null,
    );
    if (!fragments) continue;
    for (const kind of ["primary", "filelists", "other"] as const)
      parts[kind].push(fragments[kind]);
  }

  const signer = await ensureSigningKey(svc, repo);
  const now = Math.floor(Date.now() / 1000);
  const entries = [];
  const written: string[] = [];
  for (const kind of ["primary", "filelists", "other"] as const) {
    const xml = new TextEncoder().encode(
      metadataHead(kind, parts[kind].length) + parts[kind].join("") + metadataTail(kind),
    );
    const gz = gzipSync(xml, { level: 9, mtime: 0 });
    const checksum = sha256Hex(gz);
    const location = `repodata/${checksum}-${kind}.xml.gz`;
    await putDerived(svc.db, svc.bucket, repo.id, location, gz, "application/gzip");
    written.push(location);
    entries.push({
      type: kind,
      checksum,
      openChecksum: sha256Hex(xml),
      location,
      timestamp: now,
      size: gz.length,
      openSize: xml.length,
    });
  }

  const dataKey = `${entries.map((e) => e.checksum).join(",")}:${signer.fingerprint}`;
  const current = await getDerived(svc.db, repo.id, "repodata/repomd.xml");
  if (state.dataKey === dataKey && current) return;

  const repomd = repomdXml(now, entries);
  await putDerived(svc.db, svc.bucket, repo.id, "repodata/repomd.xml", repomd, "application/xml");
  await putDerived(
    svc.db,
    svc.bucket,
    repo.id,
    "repodata/repomd.xml.asc",
    await signer.detachSign(repomd),
    "application/pgp-signature",
  );

  const generations = [written, ...state.generations].slice(0, GENERATIONS_KEPT);
  const keep = new Set(generations.flat());
  for (const old of state.generations.slice(GENERATIONS_KEPT - 1).flat()) {
    if (!keep.has(old)) await deleteDerived(svc.db, repo.id, old);
  }
  await putDerived(
    svc.db,
    svc.bucket,
    repo.id,
    STATE_PATH,
    JSON.stringify({ generations, dataKey } satisfies RpmState),
    "application/json",
  );
}

// ---------------------------------------------------------------------------
// REST

async function deleteMutation(
  svc: Services,
  repo: Repository,
  raw: unknown,
): Promise<string | null> {
  const wanted = parseNevra(String(raw));
  if (!wanted) return null;
  const pkg = await getPackage(svc.db, repo.id, wanted.name);
  if (!pkg) return null;
  const versions = await listVersions<RpmVersionMeta>(svc.db, pkg.id);
  const explicitEpoch = /-\d+:/.test(String(raw));
  const version = versions.find(
    (v) =>
      v.metadata.version === wanted.version &&
      v.metadata.release === wanted.release &&
      v.metadata.arch === wanted.arch &&
      (!explicitEpoch || v.metadata.epoch === wanted.epoch),
  );
  if (!version) return null;
  await deleteFile(svc.db, repo.id, version.metadata.location);
  await deleteVersion(svc.db, version.id);
  if (!versions.some((v) => v.id !== version.id && v.metadata.sha256 === version.metadata.sha256)) {
    await deleteDerived(svc.db, repo.id, fragmentPath(version.metadata.sha256));
  }
  if (versions.length === 1) await deletePackage(svc.db, pkg.id);
  return version.metadata.nevra;
}

const apiRoutes = new Hono<AppEnv>();

apiRoutes.delete("/:repo/packages/:nevra", async (c) => {
  const repo = await loadRepo(c, "rpm");
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "delete");
  const deleted = await mutate<string | null>(svc, repo, "delete", c.req.param("nevra"));
  if (!deleted) throw RegistryError.notFound("No such package");
  await audit(svc.db, access.actor, "rpm.delete", { repoId: repo.id, target: String(deleted) });
  await svc.repoObject(repo).requestRebuild(repo.id);
  return c.body(null, 204);
});

apiRoutes.post("/:repo/rotate-key", async (c) => {
  const repo = await loadRepo(c, "rpm");
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "admin");
  if (repo.kind !== "local") throw new RegistryError("unsupported", "Only local repositories sign");
  const signer = await rotateSigningKey(svc, repo);
  await audit(svc.db, access.actor, "rpm.rotate-key", {
    repoId: repo.id,
    detail: { fingerprint: signer.fingerprint },
  });
  await svc.repoObject(repo).requestRebuild(repo.id);
  return c.json({ fingerprint: signer.fingerprint, algorithm: signer.algorithm });
});

const routes = new Hono<AppEnv>();
routes.on(["GET", "HEAD"], "/*", read);
routes.on(["GET", "HEAD"], "/", read);
routes.put("/*", upload);

export const rpmFormat: FormatModule = {
  id: "rpm",
  routes,
  apiRoutes,
  renderError: (error) => textError(error),
  rebuild,
  mutations: { publish: publishMutation, delete: deleteMutation },
};
