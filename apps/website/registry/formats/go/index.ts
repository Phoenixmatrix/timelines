import {
  readZipDirectory,
  readZipEntry,
  ZipFormatError,
  type RangeReader,
  type ZipDirEntry,
} from "@gitmatrix/formats/archive";
import {
  checkModuleZip,
  checkVersionForPath,
  escapeModulePath,
  escapeVersion,
  goModModulePath,
  isCanonicalVersion,
  isPseudoVersion,
  latestVersion,
  MAX_GO_MOD,
  MAX_ZIP_FILE,
  parseProxyPath,
  sortVersions,
  synthesizeGoMod,
  versionInfo,
  type ProxyRequest,
} from "@gitmatrix/formats/go";
import { Hono } from "hono";

import { audit } from "../../core/audit.ts";
import { principalOf } from "../../core/auth/actor.ts";
import { serveBlob, storeBlob, type StoredBlob } from "../../core/blobs.ts";
import {
  addFile,
  countDownload,
  createVersion,
  deletePackage,
  deleteVersion,
  ensurePackage,
  getFile,
  getPackage,
  getVersion,
  listVersions,
} from "../../core/catalog.ts";
import { services, type AppContext, type AppEnv } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import { jsonError, loadRepo, restPath, textError } from "../../core/http.ts";
import { cachedArtifact, cachedMetadata, upstreamFetch, upstreamUrl } from "../../core/remote.ts";
import type { Repository } from "../../core/repos.ts";
import { allMatches, deployTarget, firstMatch, members } from "../../core/virtual.ts";
import type { FormatModule } from "../types.ts";

/**
 * A GOPROXY (https://go.dev/ref/mod#goproxy-protocol): `GOPROXY=https://pkg/go/<repo>`.
 *
 *   GET <module>/@v/list | @v/<version>.info | .mod | .zip | <module>/@latest
 *   PUT <module>/@v/<version>.zip            publish a module zip (Go has no publish verb)
 *   GET sumdb/<name>/...                     checksum database proxying (remote only)
 */

const IMMUTABLE_TTL_SECONDS = 30 * 86_400;
const TEXT = "text/plain; charset=utf-8";

interface GoVersionMeta {
  time: string;
}

function textResponse(c: AppContext, body: string, contentType = TEXT): Response {
  return new Response(c.req.method === "HEAD" ? null : body, {
    headers: {
      "content-type": contentType,
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
}

function blobReader(bucket: R2Bucket, r2Key: string): RangeReader {
  return async (offset, length) => {
    const object = await bucket.get(r2Key, { range: { offset, length } });
    if (!object) throw new RegistryError("internal", "Blob is missing from storage");
    return new Uint8Array(await object.arrayBuffer());
  };
}

const zipPath = (module: string, version: string) => `${module}/@v/${version}.zip`;
const modPath = (module: string, version: string) => `${module}/@v/${version}.mod`;

// ---------------------------------------------------------------------------
// Per-member resolution: each returns null when the member lacks the module/version.

async function versionsOf(
  c: AppContext,
  repo: Repository,
  module: string,
): Promise<string[] | null> {
  const svc = services(c);
  if (repo.kind === "remote") {
    const meta = await cachedMetadata(svc, repo, `${escapeModulePath(module)}/@v/list`);
    if (meta.status !== 200) return null;
    return meta.text
      .split("\n")
      .map((l) => l.trim().split(/\s+/)[0]!)
      .filter(Boolean);
  }
  if (repo.kind === "virtual") {
    const probe = (member: Repository) => versionsOf(c, member, module);
    if (repo.config.mergeVersions) {
      const found = await allMatches(svc, repo, module, probe);
      return found.length ? found.flatMap((f) => f.value) : null;
    }
    return (await firstMatch(svc, repo, module, probe))?.value ?? null;
  }
  const pkg = await getPackage(svc.db, repo.id, module);
  if (!pkg) return null;
  return (await listVersions(svc.db, pkg.id)).map((v) => v.version);
}

async function localInfo(c: AppContext, repo: Repository, module: string, version: string) {
  const db = services(c).db;
  const pkg = await getPackage(db, repo.id, module);
  const row = pkg ? await getVersion<GoVersionMeta>(db, pkg.id, version) : null;
  return row ? versionInfo(row.version, row.metadata.time ?? row.createdAt) : null;
}

async function resolve(
  c: AppContext,
  repo: Repository,
  req: ProxyRequest,
): Promise<Response | null> {
  const svc = services(c);
  if (repo.kind === "virtual") {
    if (req.kind === "list") {
      const versions = await versionsOf(c, repo, req.module);
      return versions ? listResponse(c, versions) : null;
    }
    return (
      (await firstMatch(svc, repo, req.module, (member) => resolve(c, member, req)))?.value ?? null
    );
  }

  if (repo.kind === "remote") {
    const base = escapeModulePath(req.module);
    if (req.kind === "list" || req.kind === "latest") {
      const path = req.kind === "list" ? `${base}/@v/list` : `${base}/@latest`;
      const meta = await cachedMetadata(svc, repo, path);
      if (meta.status !== 200) return null;
      return textResponse(c, meta.text, req.kind === "list" ? TEXT : "application/json");
    }
    // `.info` also answers queries like `@v/master.info`; only exact versions are immutable.
    const exact = isCanonicalVersion(req.version);
    if (!exact && req.kind !== "info") return null;
    const path = `${base}/@v/${escapeVersion(req.version)}.${req.kind}`;
    if (req.kind === "zip") {
      const cached = await cachedArtifact(svc, repo, path, { contentType: "application/zip" });
      if (!cached) return null;
      return serveBlob(c.req.raw, svc.bucket, cached.blob, { contentType: "application/zip" });
    }
    const meta = await cachedMetadata(svc, repo, path, {
      ttlSeconds: exact ? IMMUTABLE_TTL_SECONDS : undefined,
    });
    if (meta.status !== 200) return null;
    return textResponse(c, meta.text, req.kind === "info" ? "application/json" : TEXT);
  }

  if (req.kind === "list") {
    const versions = await versionsOf(c, repo, req.module);
    return versions ? listResponse(c, versions) : null;
  }
  if (req.kind === "latest") {
    const versions = await versionsOf(c, repo, req.module);
    const latest = versions && latestVersion(versions);
    const info = latest ? await localInfo(c, repo, req.module, latest) : null;
    return info ? textResponse(c, JSON.stringify(info), "application/json") : null;
  }
  if (req.kind === "info") {
    const info = await localInfo(c, repo, req.module, req.version);
    return info ? textResponse(c, JSON.stringify(info), "application/json") : null;
  }
  const path =
    req.kind === "zip" ? zipPath(req.module, req.version) : modPath(req.module, req.version);
  const file = await getFile(svc.db, repo.id, path);
  if (!file) return null;
  if (req.kind === "zip" && c.req.method === "GET") svc.waitUntil(countDownload(svc.db, file.id));
  return serveBlob(c.req.raw, svc.bucket, file, { contentType: file.contentType });
}

/** `@v/list` omits pseudo-versions (they are only reachable by exact version). */
function listResponse(c: AppContext, versions: string[]): Response {
  const listed = sortVersions(versions.filter((v) => !isPseudoVersion(v)));
  return textResponse(c, listed.map((v) => `${v}\n`).join(""));
}

// ---------------------------------------------------------------------------
// Checksum database proxying

async function sumdb(c: AppContext, repo: Repository, rest: string): Promise<Response> {
  const svc = services(c);
  const match = /^sumdb\/([a-z0-9.-]+)\/(.+)$/.exec(rest);
  if (!match) throw RegistryError.notFound("Not found");
  const [, name, tail] = match as unknown as [string, string, string];
  let remote: Repository | null = repo.kind === "remote" ? repo : null;
  if (repo.kind === "virtual") {
    const access = await svc.access();
    for (const member of await members(svc, repo)) {
      if (member.repo.kind === "remote" && (await access.can(member.repo, "read"))) {
        remote = member.repo;
        break;
      }
    }
  }
  // Local repositories answer 404 so the go command talks to the checksum database directly.
  if (!remote) throw RegistryError.notFound(`${name} is not proxied here`);
  // `rest` is already decoded; refuse traversal without decoding twice.
  const parts = tail.split("/");
  if (parts.some((p) => p === "" || p === "." || p === ".."))
    throw RegistryError.badRequest("Invalid path");
  const path = parts.map(encodeURIComponent).join("/").replace(/%40/g, "@");
  const response = await upstreamFetch(svc, remote, upstreamUrl(remote, `sumdb/${name}/${path}`), {
    method: c.req.method === "HEAD" ? "HEAD" : "GET",
  });
  if (response.status === 404 || response.status === 410) {
    await response.body?.cancel();
    throw RegistryError.notFound(`${name}/${path} not found`);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new RegistryError("upstream_error", `Upstream answered ${response.status}`);
  }
  return new Response(c.req.method === "HEAD" ? null : response.body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? TEXT,
      "cache-control": "private, max-age=60",
    },
  });
}

// ---------------------------------------------------------------------------
// Publishing

function badZip(message: string): RegistryError {
  return RegistryError.badRequest(`Invalid module zip: ${message}`);
}

async function upload(c: AppContext, req: ProxyRequest): Promise<Response> {
  const svc = services(c);
  if (req.kind !== "zip") {
    throw new RegistryError(
      "unsupported",
      "Publish the module zip; .mod and .info are derived from it",
    );
  }
  const { module, version } = req;
  const problem = checkVersionForPath(module, version);
  if (problem) throw new RegistryError("version_invalid", problem);

  let repo = await loadRepo(c, "go");
  if (repo.kind === "virtual") {
    const target = await deployTarget(svc, repo);
    if (!target)
      throw new RegistryError("unsupported", `${repo.key} has no default deploy repository`);
    repo = target;
  }
  if (repo.kind !== "local")
    throw new RegistryError("unsupported", "Publish to a local repository");
  const access = await svc.access();
  await access.require(repo, "write");
  if (!c.req.raw.body) throw RegistryError.badRequest("Request body is empty");

  const existingZip = await getFile(svc.db, repo.id, zipPath(module, version));
  const maxBytes = Math.min(MAX_ZIP_FILE, repo.config.maxUploadBytes ?? MAX_ZIP_FILE);
  const blob = await storeBlob(svc.db, svc.bucket, c.req.raw.body, {
    maxBytes,
    contentType: "application/zip",
    expect: { sha256: c.req.header("x-checksum-sha256") ?? undefined },
  });
  const idempotent = () => {
    if (existingZip?.digest === blob.digest) {
      return c.json({ module, version, sha256: blob.digest.slice(7) }, 200);
    }
    throw new RegistryError(
      "immutable",
      `${module}@${version} already exists; versions are immutable`,
    );
  };
  if (existingZip) return idempotent();

  const read = blobReader(svc.bucket, blob.r2Key);
  let goMod: Uint8Array;
  try {
    const entries = await readZipDirectory(read, blob.size);
    const check = checkModuleZip(entries, module, version, blob.size);
    if (check.errors.length) throw badZip(check.errors.slice(0, 5).join("; "));
    if (check.goMod) {
      goMod = await readZipEntry(read, check.goMod as ZipDirEntry, { maxBytes: MAX_GO_MOD });
      const declared = goModModulePath(new TextDecoder().decode(goMod));
      if (declared !== module) {
        throw badZip(`go.mod declares module ${JSON.stringify(declared ?? "")}, not ${module}`);
      }
    } else goMod = new TextEncoder().encode(synthesizeGoMod(module));
  } catch (error) {
    if (error instanceof ZipFormatError) throw badZip(error.message);
    throw error;
  }
  const modBlob: StoredBlob = await storeBlob(svc.db, svc.bucket, goMod, { contentType: TEXT });

  const publishedBy = principalOf(access.actor);
  const pkg = await ensurePackage(svc.db, repo.id, module, module);
  let row;
  try {
    row = await createVersion<GoVersionMeta>(
      svc.db,
      pkg.id,
      version,
      { time: new Date().toISOString() },
      publishedBy,
    );
  } catch (error) {
    if (error instanceof RegistryError && error.code === "immutable") {
      // Lost a race with a concurrent publish of the same version.
      const winner = await getFile(svc.db, repo.id, zipPath(module, version));
      if (winner?.digest === blob.digest)
        return c.json({ module, version, sha256: blob.digest.slice(7) }, 200);
      throw new RegistryError(
        "immutable",
        `${module}@${version} already exists; versions are immutable`,
      );
    }
    throw error;
  }
  await addFile(svc.db, {
    repoId: repo.id,
    path: modPath(module, version),
    versionId: row.id,
    digest: modBlob.digest,
    size: modBlob.size,
    contentType: TEXT,
    createdBy: publishedBy,
  });
  await addFile(svc.db, {
    repoId: repo.id,
    path: zipPath(module, version),
    versionId: row.id,
    digest: blob.digest,
    size: blob.size,
    contentType: "application/zip",
    createdBy: publishedBy,
  });
  await audit(svc.db, access.actor, "go.publish", {
    repoId: repo.id,
    target: `${module}@${version}`,
    detail: { digest: blob.digest, size: blob.size },
  });
  return c.json({ module, version, sha256: blob.digest.slice(7), size: blob.size }, 201);
}

// ---------------------------------------------------------------------------

function decodeRest(raw: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw RegistryError.badRequest("Malformed path");
  }
  if (/[\0\\]/.test(decoded)) throw RegistryError.badRequest("Invalid path");
  return decoded;
}

async function dispatch(c: AppContext): Promise<Response> {
  const rest = decodeRest(restPath(c, 2));
  const method = c.req.method;
  if (method === "PUT") {
    const req = parseProxyPath(rest);
    if (!req) throw RegistryError.badRequest("Expected PUT <module>/@v/<version>.zip");
    return upload(c, req);
  }
  if (method !== "GET" && method !== "HEAD") {
    throw new RegistryError("unsupported", `${method} is not supported here`);
  }
  const repo = await loadRepo(c, "go");
  await (await services(c).access()).require(repo, "read");
  if (rest.startsWith("sumdb/")) return sumdb(c, repo, rest);
  const req = parseProxyPath(rest);
  if (!req) throw RegistryError.notFound("Not found");
  const found = await resolve(c, repo, req);
  if (!found) {
    const what = "version" in req ? `${req.module}@${req.version}` : req.module;
    throw RegistryError.notFound(`not found: ${what}`);
  }
  return found;
}

const routes = new Hono<AppEnv>();
routes.all("/", dispatch);
routes.all("/*", dispatch);

/** `DELETE /api/registry/go/<repo>/<module>/@v/<version>`: removes a version (admins, leaked secrets). */
const apiRoutes = new Hono<AppEnv>();
apiRoutes.delete("/:repo/*", async (c) => {
  const svc = services(c);
  const repo = await loadRepo(c, "go");
  if (repo.kind !== "local") throw new RegistryError("unsupported", "Only local repositories");
  const access = await svc.access();
  await access.require(repo, "delete");
  const req = parseProxyPath(`${decodeRest(restPath(c, 4))}.zip`);
  if (!req || req.kind !== "zip") throw RegistryError.badRequest("Expected <module>/@v/<version>");
  const pkg = await getPackage(svc.db, repo.id, req.module);
  const row = pkg ? await getVersion(svc.db, pkg.id, req.version) : null;
  if (!pkg || !row) throw RegistryError.notFound(`not found: ${req.module}@${req.version}`);
  await deleteVersion(svc.db, row.id);
  if ((await listVersions(svc.db, pkg.id)).length === 0) await deletePackage(svc.db, pkg.id);
  await audit(svc.db, access.actor, "go.delete", {
    repoId: repo.id,
    target: `${req.module}@${req.version}`,
  });
  return c.body(null, 204);
});

export const goFormat: FormatModule = {
  id: "go",
  routes,
  apiRoutes,
  renderError: (error, c) =>
    new URL(c.req.url).pathname.startsWith("/api/") ? jsonError(error) : textError(error),
};
