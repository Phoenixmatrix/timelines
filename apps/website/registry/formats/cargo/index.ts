import {
  buildIndexLine,
  CargoProtocolError,
  expandDlTemplate,
  indexPath,
  maxVersion,
  mergeIndexFiles,
  nameFromIndexPath,
  normalizeCrateName,
  parseIndexFile,
  parsePublishMetadata,
  readPublishBody,
  renderIndexFile,
  validCrateName,
  validVersion,
  versionIdentity,
  type IndexConfig,
  type IndexLine,
  type PublishMetadata,
} from "@gitmatrix/formats/cargo";
import { digestHex } from "@gitmatrix/formats/hash";
import { Hono } from "hono";

import { db as gitmatrixDb } from "../../../worker/schema.ts";
import { audit } from "../../core/audit.ts";
import { principalOf } from "../../core/auth/actor.ts";
import { serveBlob, storeBlob } from "../../core/blobs.ts";
import {
  addFile,
  countDownload,
  createVersion,
  ensurePackage,
  getPackage,
  getVersion,
  listFiles,
  listVersions,
  updateVersion,
  type PackageRow,
} from "../../core/catalog.ts";
import { services, type AppContext, type AppEnv, type Services } from "../../core/context.ts";
import { nowIso } from "../../core/db.ts";
import { RegistryError } from "../../core/errors.ts";
import { loadRepo, restPath, safePath } from "../../core/http.ts";
import { cachedArtifact, cachedMetadata } from "../../core/remote.ts";
import type { Repository } from "../../core/repos.ts";
import { allMatches, deployTarget, firstMatch, members } from "../../core/virtual.ts";
import type { FormatModule } from "../types.ts";

/**
 * Cargo alternative registries: the sparse index (`/index/`), the registry web
 * API (`/api/v1/crates/...`) and downloads. Index files are generated on read
 * from the catalog, where each version's metadata holds its index line.
 */

const MAX_METADATA_BYTES = 1024 * 1024;
const CRATE_CONTENT_TYPE = "application/gzip";
const INDEX_CONTENT_TYPE = "text/plain; charset=utf-8";

/** What a cargo version row's `metadata` holds. */
export interface CargoVersionMeta {
  index: Omit<IndexLine, "yanked">;
  description?: string | null;
  license?: string | null;
  repository?: string | null;
  homepage?: string | null;
  documentation?: string | null;
  keywords?: string[];
  categories?: string[];
  authors?: string[];
  rust_version?: string | null;
}

function cargoError(error: RegistryError, c: AppContext): Response {
  const headers: Record<string, string> = {};
  if (error.status === 401) {
    headers["www-authenticate"] = `Cargo login_url="${new URL(c.req.url).origin}/settings/tokens"`;
  }
  return Response.json({ errors: [{ detail: error.message }] }, { status: error.status, headers });
}

function protocolError(error: unknown): unknown {
  return error instanceof CargoProtocolError ? RegistryError.badRequest(error.message) : error;
}

function repoBase(svc: Services, repo: Repository): string {
  return `${svc.baseUrl}/cargo/${repo.key}`;
}

function cratePath(name: string, version: string): string {
  return `crates/${name}/${name}-${version}.crate`;
}

/** The local repository that takes writes for `repo` (a virtual's deploy target). */
async function writableRepo(svc: Services, repo: Repository): Promise<Repository> {
  if (repo.kind === "virtual") {
    const target = await deployTarget(svc, repo);
    if (!target) {
      throw new RegistryError("unsupported", `${repo.key} has no default deploy repository`);
    }
    return target;
  }
  if (repo.kind !== "local") {
    throw new RegistryError("unsupported", `${repo.key} is a read-only remote repository`);
  }
  return repo;
}

// ---------------------------------------------------------------------------
// Index

interface IndexText {
  text: string;
  lastModified?: string;
}

async function localIndex(
  svc: Services,
  repo: Repository,
  name: string,
): Promise<IndexText | null> {
  const pkg = await getPackage(svc.db, repo.id, normalizeCrateName(name));
  if (!pkg || pkg.name.toLowerCase() !== name) return null;
  const versions = await listVersions<CargoVersionMeta>(svc.db, pkg.id);
  const lines = versions
    .filter((v) => v.metadata.index)
    .map((v): IndexLine => ({ ...v.metadata.index, yanked: v.status === "yanked" }));
  if (lines.length === 0) return null;
  return { text: renderIndexFile(lines), lastModified: pkg.updatedAt };
}

async function remoteIndex(svc: Services, repo: Repository, name: string): Promise<string | null> {
  const meta = await cachedMetadata(svc, repo, indexPath(name));
  return meta.status === 200 ? meta.text : null;
}

async function memberIndex(
  svc: Services,
  member: Repository,
  name: string,
): Promise<IndexText | null> {
  if (member.kind === "remote") {
    const text = await remoteIndex(svc, member, name);
    return text === null ? null : { text };
  }
  return localIndex(svc, member, name);
}

async function resolveIndex(
  svc: Services,
  repo: Repository,
  name: string,
): Promise<IndexText | null> {
  if (repo.kind !== "virtual") return memberIndex(svc, repo, name);
  if (repo.config.mergeVersions) {
    const found = await allMatches(svc, repo, name, (m) => memberIndex(svc, m, name));
    if (found.length === 0) return null;
    if (found.length === 1) return found[0]!.value;
    return { text: mergeIndexFiles(found.map((f) => f.value.text)) };
  }
  return (await firstMatch(svc, repo, name, (m) => memberIndex(svc, m, name)))?.value ?? null;
}

function httpDate(iso: string): string {
  return new Date(iso).toUTCString();
}

async function serveIndex(c: AppContext, index: IndexText): Promise<Response> {
  const etag = `"${await digestHex("SHA-256", index.text)}"`;
  const headers: Record<string, string> = {
    "content-type": INDEX_CONTENT_TYPE,
    etag,
    "cache-control": "private, max-age=0, must-revalidate",
  };
  if (index.lastModified) headers["last-modified"] = httpDate(index.lastModified);

  const inm = c.req.header("if-none-match");
  const ims = c.req.header("if-modified-since");
  const notModified = inm
    ? inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)
    : Boolean(
        ims &&
        index.lastModified &&
        Math.floor(Date.parse(index.lastModified) / 1000) <= Math.floor(Date.parse(ims) / 1000),
      );
  if (notModified) return new Response(null, { status: 304, headers });
  return new Response(c.req.method === "HEAD" ? null : index.text, { status: 200, headers });
}

async function configJson(c: AppContext): Promise<Response> {
  // Served to anonymous callers on purpose: cargo reads it to learn that the
  // registry requires authentication (RFC 3139).
  const repo = await loadRepo(c, "cargo");
  const base = repoBase(services(c), repo);
  const config: IndexConfig = { dl: `${base}/api/v1/crates` };
  if (repo.kind !== "remote") config.api = base;
  config["auth-required"] = repo.visibility !== "public";
  return c.json(config, 200, { "cache-control": "private, max-age=0, must-revalidate" });
}

async function indexFile(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "cargo");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const name = nameFromIndexPath(safePath(restPath(c, 3)));
  if (!name) throw RegistryError.notFound("Not an index file");
  const index = await resolveIndex(svc, repo, name);
  if (!index) throw RegistryError.notFound(`crate \`${name}\` does not exist`);
  return serveIndex(c, index);
}

// ---------------------------------------------------------------------------
// Publish

function versionMeta(meta: PublishMetadata, line: IndexLine): CargoVersionMeta {
  const { yanked: _yanked, ...index } = line;
  return {
    index,
    description: meta.description,
    license: meta.license,
    repository: meta.repository,
    homepage: meta.homepage,
    documentation: meta.documentation,
    keywords: meta.keywords,
    categories: meta.categories,
    authors: meta.authors,
    rust_version: meta.rust_version,
  };
}

async function publish(c: AppContext): Promise<Response> {
  const svc = services(c);
  const requested = await loadRepo(c, "cargo");
  const repo = await writableRepo(svc, requested);
  const access = await svc.access();
  await access.require(repo, "write");
  const body = c.req.raw.body;
  if (!body) throw RegistryError.badRequest("the publish request has no body");

  let parsed: Awaited<ReturnType<typeof readPublishBody>>;
  let meta: PublishMetadata;
  try {
    parsed = await readPublishBody(body, {
      maxJsonBytes: MAX_METADATA_BYTES,
      maxCrateBytes: repo.config.maxUploadBytes,
    });
  } catch (error) {
    throw protocolError(error);
  }
  const abandon = async (error: unknown): Promise<never> => {
    await parsed.crate.cancel().catch(() => undefined);
    throw protocolError(error);
  };

  try {
    meta = parsePublishMetadata(parsed.metadata);
  } catch (error) {
    return abandon(error);
  }
  const normalized = normalizeCrateName(meta.name);
  const existing = await getPackage(svc.db, repo.id, normalized);
  if (existing && existing.name !== meta.name) {
    return abandon(
      RegistryError.conflict(
        `crate was previously named \`${existing.name}\`; publish it under that name`,
      ),
    );
  }
  if (existing) {
    const identity = versionIdentity(meta.vers);
    const versions = await listVersions(svc.db, existing.id);
    if (versions.some((v) => versionIdentity(v.version) === identity)) {
      return abandon(
        new RegistryError(
          "immutable",
          `crate version \`${meta.name}@${meta.vers}\` is already uploaded`,
        ),
      );
    }
  }

  let blob: Awaited<ReturnType<typeof storeBlob>>;
  try {
    blob = await storeBlob(svc.db, svc.bucket, parsed.crate, {
      contentType: CRATE_CONTENT_TYPE,
      maxBytes: repo.config.maxUploadBytes,
      expect: { size: parsed.crateLength },
    });
  } catch (error) {
    throw protocolError(error);
  }
  const cksum = blob.digest.slice("sha256:".length);
  const line = buildIndexLine(meta, cksum, {
    ownIndexUrls: [`${repoBase(svc, repo)}/index`, `${repoBase(svc, requested)}/index`],
  });

  const pkg = await ensurePackage(svc.db, repo.id, meta.name, normalized, {
    description: meta.description,
    readme: meta.readme,
    repository: meta.repository,
    homepage: meta.homepage,
    documentation: meta.documentation,
    license: meta.license,
    keywords: meta.keywords,
    categories: meta.categories,
  });
  if (pkg.name !== meta.name) {
    throw RegistryError.conflict(`crate was previously named \`${pkg.name}\``);
  }
  const publishedBy = principalOf(access.actor);
  const version = await createVersion(
    svc.db,
    pkg.id,
    meta.vers,
    versionMeta(meta, line),
    publishedBy,
  );
  await addFile(svc.db, {
    repoId: repo.id,
    path: cratePath(meta.name, meta.vers),
    versionId: version.id,
    digest: blob.digest,
    size: blob.size,
    contentType: CRATE_CONTENT_TYPE,
    createdBy: publishedBy,
  });
  await audit(svc.db, access.actor, "cargo.publish", {
    repoId: repo.id,
    target: `${meta.name}@${meta.vers}`,
    detail: { digest: blob.digest, size: blob.size },
  });
  return c.json({ warnings: { invalid_categories: [], invalid_badges: [], other: [] } });
}

// ---------------------------------------------------------------------------
// Yank, search, owners

async function touchPackage(svc: Services, packageId: string): Promise<void> {
  await svc.db
    .updateTable("packages")
    .set({ updated_at: nowIso() })
    .where("id", "=", packageId)
    .execute();
}

async function crateOrThrow(svc: Services, repo: Repository, name: string): Promise<PackageRow> {
  const pkg = validCrateName(name)
    ? await getPackage(svc.db, repo.id, normalizeCrateName(name))
    : null;
  if (!pkg) throw RegistryError.notFound(`crate \`${name}\` does not exist`);
  return pkg;
}

function setYanked(yanked: boolean) {
  return async (c: AppContext): Promise<Response> => {
    const svc = services(c);
    const repo = await writableRepo(svc, await loadRepo(c, "cargo"));
    const access = await svc.access();
    await access.require(repo, "write");
    const name = c.req.param("name") ?? "";
    const vers = c.req.param("version") ?? "";
    const pkg = await crateOrThrow(svc, repo, name);
    const version = await getVersion(svc.db, pkg.id, vers);
    if (!version) throw RegistryError.notFound(`crate \`${name}\` has no version \`${vers}\``);
    await updateVersion(svc.db, version.id, {
      status: yanked ? "yanked" : "active",
      statusReason: null,
    });
    await touchPackage(svc, pkg.id);
    await audit(svc.db, access.actor, yanked ? "cargo.yank" : "cargo.unyank", {
      repoId: repo.id,
      target: `${pkg.name}@${vers}`,
    });
    return c.json({ ok: true });
  };
}

async function searchableRepos(svc: Services, repo: Repository): Promise<Repository[]> {
  if (repo.kind === "local") return [repo];
  if (repo.kind === "remote") return [];
  const access = await svc.access();
  const out: Repository[] = [];
  for (const member of await members(svc, repo)) {
    if (member.repo.kind === "local" && (await access.can(member.repo, "read"))) {
      out.push(member.repo);
    }
  }
  return out;
}

async function search(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "cargo");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const term = normalizeCrateName((c.req.query("q") ?? "").replace(/[^A-Za-z0-9_-]/g, ""));
  const perPage = Math.min(100, Math.max(1, Number(c.req.query("per_page")) || 10));

  const crates: { name: string; max_version: string; description: string }[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const member of await searchableRepos(svc, repo)) {
    let query = svc.db.selectFrom("packages").where("repo_id", "=", member.id);
    if (term) query = query.where("normalized_name", "like", `%${term}%`);
    const count = await query.select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirst();
    total += Number(count?.n ?? 0);
    if (crates.length >= perPage) continue;
    const rows = await query
      .selectAll()
      .orderBy("normalized_name")
      .limit(perPage - crates.length)
      .execute();
    for (const row of rows) {
      if (seen.has(row.normalized_name)) continue;
      seen.add(row.normalized_name);
      const versions = await listVersions(svc.db, row.id);
      const active = versions.filter((v) => v.status !== "yanked").map((v) => v.version);
      const max = maxVersion(active.length ? active : versions.map((v) => v.version));
      if (!max) continue;
      const metadata = JSON.parse(row.metadata || "{}") as { description?: string | null };
      crates.push({ name: row.name, max_version: max, description: metadata.description ?? "" });
    }
  }
  return c.json({ crates, meta: { total } });
}

async function listOwners(c: AppContext): Promise<Response> {
  const svc = services(c);
  let repo = await loadRepo(c, "cargo");
  await (await svc.access()).require(repo, "read");
  if (repo.kind === "virtual") repo = await writableRepo(svc, repo);
  if (repo.kind !== "local") throw new RegistryError("unsupported", "owners are not proxied");
  const pkg = await crateOrThrow(svc, repo, c.req.param("name") ?? "");
  const publishers = [
    ...new Set((await listVersions(svc.db, pkg.id)).flatMap((v) => v.publishedBy ?? [])),
  ];
  const ids = publishers.filter((p) => p.startsWith("user:")).map((p) => p.slice(5));
  const users = ids.length
    ? await gitmatrixDb(svc.env.DB)
        .selectFrom("accounts")
        .select(["id", "slug", "display_name"])
        .where("id", "in", ids)
        .execute()
    : [];
  return c.json({
    users: publishers.map((principal, i) => {
      const user = users.find((u) => `user:${u.id}` === principal);
      return { id: i + 1, login: user?.slug ?? principal, name: user?.display_name ?? null };
    }),
  });
}

async function changeOwners(c: AppContext): Promise<Response> {
  const svc = services(c);
  const repo = await writableRepo(svc, await loadRepo(c, "cargo"));
  await (await svc.access()).require(repo, "admin");
  await crateOrThrow(svc, repo, c.req.param("name") ?? "");
  return c.json({
    ok: true,
    msg: "crate ownership follows its sources: grant a repository in the package's settings in gitmatrix",
  });
}

// ---------------------------------------------------------------------------
// Downloads

async function localDownload(
  c: AppContext,
  repo: Repository,
  name: string,
  vers: string,
): Promise<Response | null> {
  const svc = services(c);
  const pkg = await getPackage(svc.db, repo.id, normalizeCrateName(name));
  const version = pkg ? await getVersion(svc.db, pkg.id, vers) : null;
  if (!pkg || !version) return null;
  const [file] = await listFiles(svc.db, repo.id, { versionIds: [version.id] });
  if (!file) return null;
  if (c.req.method === "GET") svc.waitUntil(countDownload(svc.db, file.id));
  return serveBlob(c.req.raw, svc.bucket, file, {
    contentType: CRATE_CONTENT_TYPE,
    filename: `${pkg.name}-${version.version}.crate`,
    cacheControl: "private, max-age=31536000, immutable",
  });
}

async function upstreamDl(svc: Services, repo: Repository): Promise<string> {
  const meta = await cachedMetadata(svc, repo, "config.json");
  if (meta.status === 200) {
    try {
      const config = JSON.parse(meta.text) as Partial<IndexConfig>;
      if (typeof config.dl === "string" && config.dl) return config.dl;
    } catch {
      // fall through
    }
  }
  throw new RegistryError("upstream_error", "The upstream index has no usable config.json");
}

async function remoteDownload(
  c: AppContext,
  repo: Repository,
  name: string,
  vers: string,
): Promise<Response | null> {
  const svc = services(c);
  const text = await remoteIndex(svc, repo, name.toLowerCase());
  const line = text === null ? null : parseIndexFile(text).find((l) => l.vers === vers);
  if (!line || !/^[a-f0-9]{64}$/.test(line.cksum)) return null;
  const url = new URL(
    expandDlTemplate(await upstreamDl(svc, repo), {
      name: line.name,
      version: line.vers,
      cksum: line.cksum,
    }),
  );
  const cached = await cachedArtifact(svc, repo, cratePath(line.name, line.vers), {
    url,
    expect: { sha256: line.cksum },
    contentType: CRATE_CONTENT_TYPE,
  });
  if (!cached) return null;
  return serveBlob(c.req.raw, svc.bucket, cached.blob, {
    contentType: CRATE_CONTENT_TYPE,
    filename: `${line.name}-${line.vers}.crate`,
    cacheControl: "private, max-age=31536000, immutable",
  });
}

function memberDownload(c: AppContext, member: Repository, name: string, vers: string) {
  return member.kind === "remote"
    ? remoteDownload(c, member, name, vers)
    : localDownload(c, member, name, vers);
}

async function download(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "cargo");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const name = c.req.param("name") ?? "";
  const vers = c.req.param("version") ?? "";
  if (!validCrateName(name) || !validVersion(vers)) throw RegistryError.notFound("No such crate");
  const found =
    repo.kind === "virtual"
      ? ((await firstMatch(svc, repo, name.toLowerCase(), (m) => memberDownload(c, m, name, vers)))
          ?.value ?? null)
      : await memberDownload(c, repo, name, vers);
  if (!found) throw RegistryError.notFound(`crate \`${name}@${vers}\` does not exist`);
  return found;
}

async function me(c: AppContext): Promise<Response> {
  await loadRepo(c, "cargo");
  return c.redirect(`${new URL(c.req.url).origin}/settings/tokens`, 302);
}

const routes = new Hono<AppEnv>();
routes.on(["GET", "HEAD"], "/index/config.json", configJson);
routes.on(["GET", "HEAD"], "/index/*", indexFile);
routes.put("/api/v1/crates/new", publish);
routes.get("/api/v1/crates", search);
routes.delete("/api/v1/crates/:name/:version/yank", setYanked(true));
routes.put("/api/v1/crates/:name/:version/unyank", setYanked(false));
routes.on(["GET", "HEAD"], "/api/v1/crates/:name/:version/download", download);
routes.get("/api/v1/crates/:name/owners", listOwners);
routes.put("/api/v1/crates/:name/owners", changeOwners);
routes.delete("/api/v1/crates/:name/owners", changeOwners);
routes.get("/me", me);

export const cargoFormat: FormatModule = {
  id: "cargo",
  routes,
  renderError: cargoError,
};
