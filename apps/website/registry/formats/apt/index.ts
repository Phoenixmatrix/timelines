import { createHash } from "node:crypto";

import {
  ARCHITECTURE,
  comparePackages,
  componentReleaseFile,
  controlFromMember,
  debFilename,
  debIdentity,
  DEFAULT_ARCHITECTURES,
  DIST_NAME,
  locateControlMember,
  packagesStanza,
  parseDeb822,
  poolPath,
  releaseFile,
  type Stanza,
} from "@gitmatrix/formats/apt";
import { gzipSync } from "@gitmatrix/formats/archive";
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
  updateVersion,
} from "../../core/catalog.ts";
import { services, type AppContext, type AppEnv, type Services } from "../../core/context.ts";
import { parseJson } from "../../core/db.ts";
import { deleteDerived, getDerived, putDerived } from "../../core/derived.ts";
import { RegistryError } from "../../core/errors.ts";
import { loadRepo, restPath, safePath, textError } from "../../core/http.ts";
import { cachedArtifact, cachedMetadata } from "../../core/remote.ts";
import type { Repository } from "../../core/repos.ts";
import { ensureSigningKey, rotateSigningKey, servePublicKey } from "../_signing/index.ts";
import { derivedOrBuild, mutate, readRange, readState, serveIndex } from "../_signing/repo.ts";
import type { FormatModule } from "../types.ts";

/**
 * Debian/Ubuntu repositories for apt. Local repositories accept .deb uploads
 * (Artifactory's `;deb.distribution=` matrix parameters or `/upload/`), and
 * the RepoDO regenerates signed `dists/` indexes with by-hash copies. Remote
 * repositories proxy an upstream archive byte-for-byte, so clients keep
 * verifying the upstream's own signatures.
 */

const DEB_TYPE = "application/vnd.debian.binary-package";
const STATE_PATH = "_apt/state.json";
/** How many earlier by-hash copies of each index stay downloadable. */
const BY_HASH_KEEP = 3;
const MAX_CONTROL_BYTES = 16 * 1024 * 1024;

interface Target {
  distribution: string;
  component: string;
}

interface AptVersionMeta {
  package: string;
  version: string;
  architecture: string;
  source: string;
  control: Stanza;
  filename: string;
  size: number;
  md5: string;
  sha1: string;
  sha256: string;
  sha512: string;
  targets: Target[];
}

interface AptState {
  dists: Record<string, { components: string[]; architectures: string[]; releaseKey?: string }>;
  /** by-hash directory -> index file name -> recent SHA-256s, newest first. */
  byHash: Record<string, Record<string, string[]>>;
}

// ---------------------------------------------------------------------------
// Reads

function isImmutableUpstreamPath(path: string): boolean {
  return (
    path.startsWith("pool/") ||
    path.includes("/by-hash/") ||
    /\.(u?deb|dsc|diff\.gz|tar\.(gz|xz|bz2|zst))$/.test(path)
  );
}

async function readRemote(c: AppContext, repo: Repository, path: string): Promise<Response> {
  const svc = services(c);
  if (!path) throw RegistryError.notFound("Not found");
  if (isImmutableUpstreamPath(path)) {
    const cached = await cachedArtifact(svc, repo, path);
    if (!cached) throw RegistryError.notFound(`${path} not found upstream`);
    return serveBlob(c.req.raw, svc.bucket, cached.blob, {
      contentType: path.endsWith(".deb") ? DEB_TYPE : cached.contentType,
    });
  }
  const meta = await cachedMetadata(svc, repo, path);
  if (meta.status !== 200) throw RegistryError.notFound(`${path} not found upstream`);
  const file = await getDerived(svc.db, repo.id, `upstream/${path}`);
  if (!file) throw RegistryError.notFound(`${path} not found upstream`);
  return serveIndex(c, svc, file);
}

async function read(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "apt");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const path = safePath(restPath(c, 2));
  if (repo.kind === "remote") return readRemote(c, repo, path);

  if (path === "key.asc" || path === "key.gpg" || path === "public.key") {
    return servePublicKey(c, svc, repo, path === "key.gpg" ? "gpg" : "asc");
  }
  if (path.startsWith("dists/")) {
    const file = /^dists\/[^/]+\/(InRelease|Release|Release\.gpg)$/.test(path)
      ? await derivedOrBuild(svc, repo, path, STATE_PATH)
      : await getDerived(svc.db, repo.id, path);
    if (!file) throw RegistryError.notFound(`${path} not found`);
    return serveIndex(c, svc, file);
  }
  const file = path ? await getFile(svc.db, repo.id, path) : null;
  if (!file) throw RegistryError.notFound(`${path || "/"} not found`);
  if (c.req.method === "GET") svc.waitUntil(countDownload(svc.db, file.id));
  return serveBlob(c.req.raw, svc.bucket, file, {
    contentType: DEB_TYPE,
    filename: path.split("/").pop(),
  });
}

// ---------------------------------------------------------------------------
// Upload

/** Splits Artifactory matrix parameters (`a/b.deb;deb.distribution=x`) off a raw path. */
function parseMatrix(raw: string): { path: string; params: Map<string, string[]> } {
  const params = new Map<string, string[]>();
  const segments = raw.split("/").map((segment) => {
    const [name, ...pairs] = segment.split(";");
    for (const pair of pairs) {
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      let key: string;
      let value: string;
      try {
        key = decodeURIComponent(pair.slice(0, eq));
        value = decodeURIComponent(pair.slice(eq + 1));
      } catch {
        throw RegistryError.badRequest("Malformed matrix parameter");
      }
      params.set(key, [...(params.get(key) ?? []), value]);
    }
    return name ?? "";
  });
  return { path: segments.join("/"), params };
}

function listParam(values: (string | undefined)[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    for (const part of (value ?? "").split(",")) if (part.trim()) out.add(part.trim());
  }
  return [...out];
}

async function readControl(bucket: R2Bucket, blob: StoredBlob): Promise<string> {
  let prefix = await readRange(bucket, blob, 0, 4096);
  let location = locateControlMember(prefix);
  if (!location && prefix.length < blob.size) {
    prefix = await readRange(bucket, blob, 0, 64 * 1024);
    location = locateControlMember(prefix);
  }
  if (!location) throw new Error("no control member");
  if (location.size > MAX_CONTROL_BYTES) throw new Error("control member is too large");
  const data = await readRange(bucket, blob, location.offset, location.size);
  if (data.length !== location.size) throw new Error("truncated control member");
  return controlFromMember(location.name, data);
}

interface PublishPayload {
  path: string;
  digest: string;
  meta: AptVersionMeta;
  publishedBy: string | null;
}

async function publishMutation(
  svc: Services,
  repo: Repository,
  raw: unknown,
): Promise<{ created: boolean; path: string; targets: Target[] }> {
  const { path, digest, meta, publishedBy } = raw as PublishPayload;
  const pkg = await ensurePackage(svc.db, repo.id, meta.package, meta.package);
  const key = `${meta.version}_${meta.architecture}`;
  const existing = await getVersion<AptVersionMeta>(svc.db, pkg.id, key);
  if (existing) {
    if (existing.metadata.sha256 !== meta.sha256) {
      throw new RegistryError(
        "immutable",
        `${meta.package} ${meta.version} ${meta.architecture} already exists with different contents`,
      );
    }
    const targets = [...existing.metadata.targets];
    for (const t of meta.targets) {
      if (!targets.some((e) => e.distribution === t.distribution && e.component === t.component)) {
        targets.push(t);
      }
    }
    if (targets.length !== existing.metadata.targets.length) {
      await updateVersion(svc.db, existing.id, { metadata: { ...existing.metadata, targets } });
    }
    return { created: false, path: existing.metadata.filename, targets };
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
    contentType: DEB_TYPE,
    createdBy: publishedBy,
  });
  return { created: true, path, targets: meta.targets };
}

async function publish(
  c: AppContext,
  repo: Repository,
  options: { path: string | null; params: Map<string, string[]> },
): Promise<Response> {
  const svc = services(c);
  if (repo.kind !== "local") throw new RegistryError("unsupported", "Upload to a local repository");
  const access = await svc.access();
  await access.require(repo, "write");
  const body = c.req.raw.body;
  if (!body) throw RegistryError.badRequest("Request body is empty");

  const pick = (name: string) => [
    ...(options.params.get(`deb.${name}`) ?? []),
    ...(options.params.get(name) ?? []),
    c.req.query(`deb.${name}`),
    c.req.query(name),
  ];
  const config = repo.config.apt ?? {};
  const distributions = listParam(pick("distribution"));
  const components = listParam(pick("component"));
  if (!distributions.length) distributions.push(config.distributions?.[0] ?? "stable");
  if (!components.length) components.push(config.components?.[0] ?? "main");
  for (const name of [...distributions, ...components]) {
    if (!DIST_NAME.test(name) || name.length > 64) {
      throw RegistryError.badRequest(`Invalid distribution or component: ${name}`);
    }
  }
  const archParam = listParam(pick("architecture"));
  if (options.path !== null) {
    if (!options.path.endsWith(".deb"))
      throw RegistryError.badRequest("Only .deb files are accepted");
    if (/^(dists|_apt)\//.test(options.path) || options.path.startsWith("key.")) {
      throw RegistryError.badRequest(`${options.path} is a reserved path`);
    }
  }

  const blob = await storeBlob(svc.db, svc.bucket, body, {
    contentType: DEB_TYPE,
    maxBytes: repo.config.maxUploadBytes,
    expect: {
      sha256: c.req.header("x-checksum-sha256") ?? undefined,
      sha1: c.req.header("x-checksum-sha1") ?? undefined,
      md5: c.req.header("x-checksum-md5") ?? undefined,
    },
  });
  let control: Stanza;
  let id: ReturnType<typeof debIdentity>;
  try {
    const stanza = parseDeb822(await readControl(svc.bucket, blob))[0];
    if (!stanza) throw new Error("empty control file");
    control = stanza;
    id = debIdentity(control);
  } catch (error) {
    throw RegistryError.badRequest(`Invalid .deb: ${(error as Error).message}`);
  }
  if (archParam.length && !archParam.includes(id.architecture)) {
    throw RegistryError.badRequest(
      `deb.architecture=${archParam.join(",")} does not match the package's ${id.architecture}`,
    );
  }
  const path = options.path ?? poolPath(components[0]!, id.source, debFilename(id));
  const targets = distributions.flatMap((distribution) =>
    components.map((component) => ({ distribution, component })),
  );
  const meta: AptVersionMeta = {
    package: id.package,
    version: id.version,
    architecture: id.architecture,
    source: id.source,
    control,
    filename: path,
    size: blob.size,
    md5: blob.md5 ?? "",
    sha1: blob.sha1 ?? "",
    sha256: blob.digest.slice("sha256:".length),
    sha512: blob.sha512 ?? "",
    targets,
  };
  const result = await mutate<{ created: boolean; path: string; targets: Target[] }>(
    svc,
    repo,
    "publish",
    {
      path,
      digest: blob.digest,
      meta,
      publishedBy: principalOf(access.actor),
    } satisfies PublishPayload,
  );
  await audit(svc.db, access.actor, "apt.publish", {
    repoId: repo.id,
    target: `${id.package}_${id.version}_${id.architecture}`,
    detail: { path: result.path, digest: blob.digest, targets, created: result.created },
  });
  await svc.repoObject(repo).requestRebuild(repo.id);
  const url = `${svc.baseUrl}/apt/${repo.key}/${result.path.split("/").map(encodeURIComponent).join("/")}`;
  return c.json(
    {
      repo: repo.key,
      path: `/${result.path}`,
      created: result.created,
      downloadUri: url,
      mimeType: DEB_TYPE,
      size: blob.size,
      package: id.package,
      version: id.version,
      architecture: id.architecture,
      distributions: [...new Set(result.targets.map((t) => t.distribution))],
      components: [...new Set(result.targets.map((t) => t.component))],
      checksums: { sha256: meta.sha256, sha1: meta.sha1, md5: meta.md5 },
    },
    result.created ? 201 : 200,
    { location: url },
  );
}

async function upload(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "apt");
  const { path: rawPath, params } = parseMatrix(restPath(c, 2));
  const path = safePath(rawPath);
  if (!path) throw RegistryError.badRequest("A file path is required");
  if (path === "upload" || path.startsWith("upload/")) {
    if (!path.endsWith(".deb") && path !== "upload") {
      throw RegistryError.badRequest("Only .deb files are accepted");
    }
    return publish(c, repo, { path: null, params });
  }
  return publish(c, repo, { path, params });
}

// ---------------------------------------------------------------------------
// Index generation

function hashes(bytes: Uint8Array) {
  return {
    size: bytes.length,
    md5: createHash("md5").update(bytes).digest("hex"),
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

async function allVersions(svc: Services, repo: Repository): Promise<AptVersionMeta[]> {
  const rows = await svc.db
    .selectFrom("versions as v")
    .innerJoin("packages as p", "p.id", "v.package_id")
    .select(["v.metadata"])
    .where("p.repo_id", "=", repo.id)
    .execute();
  return rows
    .map((row) => parseJson<AptVersionMeta | null>(row.metadata, null))
    .filter((m): m is AptVersionMeta => m !== null && Array.isArray(m.targets));
}

async function rebuild(svc: Services, repo: Repository): Promise<void> {
  if (repo.kind !== "local") return;
  const config = repo.config.apt ?? {};
  const state = await readState<AptState>(svc, repo, STATE_PATH, { dists: {}, byHash: {} });
  const versions = await allVersions(svc, repo);

  const dists = new Map<string, { components: Set<string>; archs: Set<string>; hasAll: boolean }>();
  const dist = (name: string) => {
    let entry = dists.get(name);
    if (!entry) {
      entry = { components: new Set(), archs: new Set(), hasAll: false };
      dists.set(name, entry);
    }
    return entry;
  };
  for (const name of config.distributions ?? []) {
    for (const component of config.components ?? ["main"]) dist(name).components.add(component);
  }
  for (const [name, previous] of Object.entries(state.dists)) {
    for (const component of previous.components) dist(name).components.add(component);
    for (const arch of previous.architectures) dist(name).archs.add(arch);
  }
  for (const v of versions) {
    for (const t of v.targets) {
      const entry = dist(t.distribution);
      entry.components.add(t.component);
      if (v.architecture === "all") entry.hasAll = true;
      else if (ARCHITECTURE.test(v.architecture)) entry.archs.add(v.architecture);
    }
  }

  const signer = dists.size ? await ensureSigningKey(svc, repo) : null;
  const now = new Date();
  const next: AptState = { dists: {}, byHash: { ...state.byHash } };

  for (const [name, entry] of [...dists].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const archs = new Set(entry.archs);
    if (entry.hasAll || archs.size === 0) for (const a of DEFAULT_ARCHITECTURES) archs.add(a);
    const architectures = [...archs].sort();
    const components = [...entry.components].sort();
    const indexFiles: { path: string; size: number; md5: string; sha1: string; sha256: string }[] =
      [];

    for (const component of components) {
      for (const arch of architectures) {
        const dir = `${component}/binary-${arch}`;
        const base = `dists/${name}/${dir}`;
        const selected = versions
          .filter(
            (v) =>
              (v.architecture === arch || v.architecture === "all") &&
              v.targets.some((t) => t.distribution === name && t.component === component),
          )
          .sort(comparePackages);
        const packages = new TextEncoder().encode(
          selected
            .map((v) =>
              packagesStanza(v.control, {
                filename: v.filename,
                size: v.size,
                md5: v.md5,
                sha1: v.sha1,
                sha256: v.sha256,
                sha512: v.sha512 || undefined,
              }),
            )
            .join("\n"),
        );
        const gz = gzipSync(packages, { level: 9, mtime: 0 });
        const archRelease = new TextEncoder().encode(
          componentReleaseFile({
            suite: name,
            codename: name,
            component,
            architecture: arch,
            origin: config.origin ?? "gitmatrix",
            label: config.label ?? repo.key,
            acquireByHash: true,
          }),
        );
        const files: [string, Uint8Array, string][] = [
          ["Packages", packages, "text/plain; charset=utf-8"],
          ["Packages.gz", gz, "application/gzip"],
          ["Release", archRelease, "text/plain; charset=utf-8"],
        ];
        const history = { ...next.byHash[base] };
        for (const [file, bytes, type] of files) {
          const h = hashes(bytes);
          indexFiles.push({ path: `${dir}/${file}`, ...h });
          await putDerived(svc.db, svc.bucket, repo.id, `${base}/${file}`, bytes, type);
          if (file === "Release") continue;
          // by-hash copies: the current one plus the last few, so a client that
          // fetched the previous InRelease can still download matching indexes.
          await putDerived(
            svc.db,
            svc.bucket,
            repo.id,
            `${base}/by-hash/SHA256/${h.sha256}`,
            bytes,
            type,
          );
          const previous = history[file] ?? [];
          const kept = [h.sha256, ...previous.filter((x) => x !== h.sha256)];
          for (const expired of kept.slice(BY_HASH_KEEP)) {
            await deleteDerived(svc.db, repo.id, `${base}/by-hash/SHA256/${expired}`);
          }
          history[file] = kept.slice(0, BY_HASH_KEEP);
        }
        next.byHash[base] = history;
      }
    }

    const releaseInput = {
      origin: config.origin ?? "gitmatrix",
      label: config.label ?? repo.key,
      suite: name,
      codename: name,
      architectures,
      components,
      description: `${repo.key} ${name}`,
      acquireByHash: true,
      files: indexFiles,
    };
    // Only re-date and re-sign when an index or the key actually changed.
    const releaseKey = createHash("sha256")
      .update(JSON.stringify(releaseInput))
      .update(signer!.fingerprint)
      .digest("hex");
    next.dists[name] = { components, architectures: [...entry.archs].sort(), releaseKey };
    const unchanged =
      state.dists[name]?.releaseKey === releaseKey &&
      (await getDerived(svc.db, repo.id, `dists/${name}/InRelease`)) !== null;
    if (unchanged) continue;
    const release = releaseFile({ ...releaseInput, date: now });
    const text = "text/plain; charset=utf-8";
    await putDerived(svc.db, svc.bucket, repo.id, `dists/${name}/Release`, release, text);
    await putDerived(
      svc.db,
      svc.bucket,
      repo.id,
      `dists/${name}/Release.gpg`,
      await signer!.detachSign(release),
      "application/pgp-signature",
    );
    await putDerived(
      svc.db,
      svc.bucket,
      repo.id,
      `dists/${name}/InRelease`,
      await signer!.clearsign(release),
      text,
    );
  }
  await putDerived(
    svc.db,
    svc.bucket,
    repo.id,
    STATE_PATH,
    JSON.stringify(next),
    "application/json",
  );
}

// ---------------------------------------------------------------------------
// REST: delete a version, rotate the key, upload without a path

interface DeletePayload {
  name: string;
  version: string;
  architecture: string;
  distribution?: string;
  component?: string;
}

async function deleteMutation(svc: Services, repo: Repository, raw: unknown): Promise<boolean> {
  const p = raw as DeletePayload;
  const pkg = await getPackage(svc.db, repo.id, p.name);
  if (!pkg) return false;
  const version = await getVersion<AptVersionMeta>(
    svc.db,
    pkg.id,
    `${p.version}_${p.architecture}`,
  );
  if (!version) return false;
  const remaining = version.metadata.targets.filter(
    (t) =>
      !(
        (!p.distribution || t.distribution === p.distribution) &&
        (!p.component || t.component === p.component)
      ),
  );
  if (remaining.length === version.metadata.targets.length) return false;
  if (remaining.length > 0) {
    await updateVersion(svc.db, version.id, {
      metadata: { ...version.metadata, targets: remaining },
    });
    return true;
  }
  await deleteFile(svc.db, repo.id, version.metadata.filename);
  await deleteVersion(svc.db, version.id);
  if ((await listVersions(svc.db, pkg.id)).length === 0) await deletePackage(svc.db, pkg.id);
  return true;
}

const apiRoutes = new Hono<AppEnv>();

apiRoutes.delete("/:repo/packages/:name/:version/:arch", async (c) => {
  const repo = await loadRepo(c, "apt");
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "delete");
  const payload: DeletePayload = {
    name: c.req.param("name"),
    version: c.req.param("version"),
    architecture: c.req.param("arch"),
    distribution: c.req.query("distribution") || undefined,
    component: c.req.query("component") || undefined,
  };
  const deleted = await mutate<boolean>(svc, repo, "delete", payload);
  if (!deleted) throw RegistryError.notFound("No such package version");
  await audit(svc.db, access.actor, "apt.delete", {
    repoId: repo.id,
    target: `${payload.name}_${payload.version}_${payload.architecture}`,
    detail: { distribution: payload.distribution, component: payload.component },
  });
  await svc.repoObject(repo).requestRebuild(repo.id);
  return c.body(null, 204);
});

apiRoutes.post("/:repo/rotate-key", async (c) => {
  const repo = await loadRepo(c, "apt");
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "admin");
  if (repo.kind !== "local") throw new RegistryError("unsupported", "Only local repositories sign");
  const signer = await rotateSigningKey(svc, repo);
  await audit(svc.db, access.actor, "apt.rotate-key", {
    repoId: repo.id,
    detail: { fingerprint: signer.fingerprint },
  });
  await svc.repoObject(repo).requestRebuild(repo.id);
  return c.json({ fingerprint: signer.fingerprint, algorithm: signer.algorithm });
});

apiRoutes.post("/:repo/upload", async (c) => {
  const repo = await loadRepo(c, "apt");
  return publish(c, repo, { path: null, params: new Map() });
});

const routes = new Hono<AppEnv>();
routes.on(["GET", "HEAD"], "/*", read);
routes.on(["GET", "HEAD"], "/", read);
routes.put("/*", upload);

export const aptFormat: FormatModule = {
  id: "apt",
  routes,
  apiRoutes,
  renderError: (error) => textError(error),
  rebuild,
  mutations: { publish: publishMutation, delete: deleteMutation },
};
