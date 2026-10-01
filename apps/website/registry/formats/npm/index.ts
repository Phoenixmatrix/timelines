import {
  abbreviatePackument,
  mergePackuments,
  parseNpmPath,
  resolveSpec,
  searchObject,
  searchResponse,
  searchScore,
  searchTerms,
  type NpmRoute,
  type Packument,
  type SearchObject,
} from "@gitmatrix/formats/npm";
import { Hono } from "hono";

import { getPackage } from "../../core/catalog.ts";
import { services, type AppContext, type AppEnv, type Services } from "../../core/context.ts";
import { parseJson } from "../../core/db.ts";
import { RegistryError } from "../../core/errors.ts";
import { jsonError, loadRepo, restPath } from "../../core/http.ts";
import type { Repository } from "../../core/repos.ts";
import {
  allMatches,
  candidates,
  deployTarget,
  firstMatch,
  isPinned,
  memberAllows,
  members,
} from "../../core/virtual.ts";
import type { FormatModule } from "../types.ts";
import {
  CORGI,
  MAX_AUDIT_BODY,
  metadataCacheControl,
  notFound,
  readBodyText,
  readJsonBody,
  sendJson,
  wantsAbbreviated,
  writableTarget,
  type NpmPackageMeta,
  type NpmVersionMeta,
} from "./common.ts";
import { legacyLogin, startWebLogin, webLoginDone } from "./login.ts";
import {
  changeDistTag,
  localDistTags,
  localPackument,
  localTarball,
  npmMutations,
  putPackage,
  unpublishFile,
  unpublishPackage,
  updatePackument,
} from "./local.ts";
import {
  AUDIT_PATHS,
  proxyAudit,
  remotePackument,
  remoteSearch,
  remoteTarball,
  upstreamPackument,
} from "./remote.ts";

export { completeNpmLogin } from "./login.ts";

/**
 * npm registry protocol at `/npm/<repo>/` for npm, pnpm, yarn and bun:
 * packuments (full and abbreviated), tarballs, publish, dist-tags, deprecate,
 * unpublish, search, audit proxying, whoami and both login flows.
 */

// ---------------------------------------------------------------------------
// Resolution across repository kinds

interface ResolveOptions {
  abbreviated: boolean;
  /** Repository key tarball URLs point at (the one the client asked). */
  urlRepoKey: string;
}

async function packumentFor(
  svc: Services,
  repo: Repository,
  name: string,
  options: ResolveOptions,
): Promise<Packument | null> {
  if (repo.kind === "local") return localPackument(svc, repo, name, options.urlRepoKey);
  if (repo.kind === "remote") {
    return remotePackument(svc, repo, name, options.abbreviated, options.urlRepoKey);
  }
  const probe = (member: Repository) => packumentFor(svc, member, name, options);
  if (repo.config.mergeVersions) {
    const found = await allMatches(svc, repo, name, probe);
    return found.length > 0 ? mergePackuments(found.map((f) => f.value)) : null;
  }
  return (await firstMatch(svc, repo, name, probe))?.value ?? null;
}

/**
 * A tarball through a virtual repository comes from the member that serves
 * the package's document (or, with mergeVersions, the first that has the file).
 */
async function virtualTarball(
  c: AppContext,
  repo: Repository,
  name: string,
  file: string,
): Promise<Response | null> {
  const svc = services(c);
  for (const member of await candidates(svc, repo, name)) {
    let response: Response | null;
    if (member.kind === "local") {
      const pkg = await getPackage(svc.db, member.id, name);
      if (!pkg) continue;
      response = await localTarball(c, member, name, file, repo);
    } else {
      const doc = await upstreamPackument(svc, member, name, true);
      if (!doc) continue;
      response = await remoteTarball(c, member, name, file, repo, doc);
    }
    if (response || !repo.config.mergeVersions) return response;
  }
  return null;
}

async function tarballFor(c: AppContext, repo: Repository, name: string, file: string) {
  if (repo.kind === "local") return localTarball(c, repo, name, file);
  if (repo.kind === "remote") return remoteTarball(c, repo, name, file);
  return virtualTarball(c, repo, name, file);
}

// ---------------------------------------------------------------------------
// Reads

async function getPackument(c: AppContext, repo: Repository, name: string): Promise<Response> {
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "read");
  const write = c.req.query("write") === "true";
  const abbreviated = wantsAbbreviated(c);
  let source = repo;
  if (write && repo.kind === "virtual") {
    // Editing (deprecate, unpublish) must see the revision of the repository that takes the write.
    const target = await deployTarget(svc, repo);
    if (target && (await access.can(target, "read"))) source = target;
  }
  const doc = await packumentFor(svc, source, name, { abbreviated, urlRepoKey: repo.key });
  if (!doc) throw notFound(name);
  return sendJson(c, abbreviated ? abbreviatePackument(doc) : doc, {
    contentType: abbreviated ? CORGI : "application/json",
    cacheControl: write ? "private, no-cache, no-store" : metadataCacheControl(repo),
  });
}

async function getVersion(c: AppContext, repo: Repository, name: string, spec: string) {
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const doc = await packumentFor(svc, repo, name, { abbreviated: false, urlRepoKey: repo.key });
  if (!doc) throw notFound(name);
  const version = resolveSpec(doc, spec);
  if (!version) throw RegistryError.notFound(`version not found: ${spec}`);
  return sendJson(c, doc.versions[version], { cacheControl: metadataCacheControl(repo) });
}

async function getTarball(c: AppContext, repo: Repository, name: string, file: string) {
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const response = await tarballFor(c, repo, name, file);
  if (!response) throw RegistryError.notFound(`${name}/-/${file} not found`);
  return response;
}

async function getDistTags(c: AppContext, repo: Repository, name: string) {
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const tags =
    repo.kind === "local"
      ? await localDistTags(svc, repo, name)
      : ((await packumentFor(svc, repo, name, { abbreviated: true, urlRepoKey: repo.key }))?.[
          "dist-tags"
        ] ?? null);
  if (!tags) throw notFound(name);
  return sendJson(c, tags, { cacheControl: "private, no-cache" });
}

async function whoami(c: AppContext): Promise<Response> {
  const actor = await services(c).actor();
  if (actor.kind === "anonymous") throw RegistryError.unauthorized();
  return c.json({ username: actor.email ?? actor.name ?? actor.subject });
}

// ---------------------------------------------------------------------------
// Search

async function searchLocal(
  svc: Services,
  repo: Repository,
  terms: string[],
  limit: number,
): Promise<{ objects: SearchObject[]; total: number }> {
  let query = svc.db.selectFrom("packages").selectAll().where("repo_id", "=", repo.id);
  for (const term of terms) {
    const like = `%${term}%`;
    query = query.where((eb) =>
      eb.or([eb("normalized_name", "like", like), eb("metadata", "like", like)]),
    );
  }
  const rows = await query.orderBy("normalized_name").limit(2000).execute();
  const scored: { row: (typeof rows)[number]; meta: NpmPackageMeta; score: number }[] = [];
  for (const row of rows) {
    const meta = parseJson<NpmPackageMeta>(row.metadata, {});
    const score = searchScore(
      { name: row.name, description: meta.description, keywords: meta.keywords },
      terms,
    );
    if (score > 0) scored.push({ row, meta, score });
  }
  scored.sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
  const page = scored.slice(0, limit);
  const latest = new Map<
    string,
    { version: string; createdAt: string; publisher?: { name: string; email?: string } }
  >();
  const ids = page.map((p) => p.row.id);
  for (let i = 0; i < ids.length; i += 90) {
    const tagged = await svc.db
      .selectFrom("dist_tags as t")
      .innerJoin("versions as v", (join) =>
        join.onRef("v.package_id", "=", "t.package_id").onRef("v.version", "=", "t.version"),
      )
      .select(["t.package_id", "v.version", "v.created_at", "v.metadata"])
      .where("t.tag", "=", "latest")
      .where("t.package_id", "in", ids.slice(i, i + 90))
      .execute();
    for (const row of tagged) {
      const manifest = parseJson<NpmVersionMeta>(row.metadata, { dist: { tarball: "" } });
      latest.set(row.package_id, {
        version: row.version,
        createdAt: row.created_at,
        publisher: manifest._npmUser as { name: string; email?: string } | undefined,
      });
    }
  }
  const objects = page.flatMap(({ row, meta, score }) => {
    const info = latest.get(row.id);
    if (!info) return [];
    return [
      searchObject(
        {
          name: row.name,
          version: info.version,
          description: meta.description,
          keywords: meta.keywords,
          date: info.createdAt,
          ...(info.publisher
            ? { publisher: { username: info.publisher.name, email: info.publisher.email } }
            : {}),
          maintainers: (meta.maintainers ?? []).map((m) => ({ username: m.name, email: m.email })),
        },
        score,
      ),
    ];
  });
  return { objects, total: scored.length };
}

async function search(c: AppContext, repo: Repository): Promise<Response> {
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "read");
  const text = c.req.query("text") ?? "";
  const size = Math.min(Math.max(Number(c.req.query("size") ?? 20) || 20, 1), 250);
  const from = Math.max(Number(c.req.query("from") ?? 0) || 0, 0);
  const terms = searchTerms(text);

  if (repo.kind === "remote") {
    const params = new URLSearchParams({ text, size: String(size), from: String(from) });
    const upstream = await remoteSearch(svc, repo, params);
    return c.json({ ...upstream, time: new Date().toUTCString() });
  }

  const sources =
    repo.kind === "local" ? [{ repo, include: [], exclude: [] }] : await members(svc, repo);
  const readable = [];
  for (const member of sources) {
    if (await access.can(member.repo, "read")) readable.push(member);
  }
  const objects: unknown[] = [];
  let total = 0;
  const localNames = new Set<string>();
  for (const member of readable.filter((m) => m.repo.kind === "local")) {
    const found = await searchLocal(svc, member.repo, terms, from + size);
    for (const object of found.objects) {
      const name = object.package.name;
      if (localNames.has(name) || !memberAllows(member, name)) continue;
      localNames.add(name);
      objects.push(object);
    }
    total += found.total;
  }
  (objects as SearchObject[]).sort((a, b) => b.searchScore - a.searchScore);
  const remote = readable.find((m) => m.repo.kind === "remote");
  if (remote && text) {
    try {
      const params = new URLSearchParams({ text, size: String(from + size), from: "0" });
      const upstream = await remoteSearch(svc, remote.repo, params);
      for (const object of upstream.objects) {
        const name = object.package.name;
        if (localNames.has(name) || isPinned(repo, name) || !memberAllows(remote, name)) continue;
        objects.push(object);
      }
      total += upstream.total;
    } catch {
      // Local results still answer when the upstream is down.
    }
  }
  const page = objects.slice(from, from + size) as SearchObject[];
  return c.json(searchResponse(page, Math.max(total, page.length)));
}

// ---------------------------------------------------------------------------
// Audit

const EMPTY_QUICK_AUDIT = {
  actions: [],
  advisories: {},
  muted: [],
  metadata: {
    vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
    dependencies: 0,
    devDependencies: 0,
    optionalDependencies: 0,
    totalDependencies: 0,
  },
};

/** Names that must not leave the registry: pinned, or published to a local member. */
async function privateNames(
  svc: Services,
  repo: Repository,
  names: string[],
): Promise<Set<string>> {
  const out = new Set(names.filter((n) => isPinned(repo, n)));
  const localIds = (await members(svc, repo))
    .filter((m) => m.repo.kind === "local")
    .map((m) => m.repo.id);
  if (localIds.length === 0) return out;
  const rest = names.filter((n) => !out.has(n));
  for (let i = 0; i < rest.length; i += 80) {
    const rows = await svc.db
      .selectFrom("packages")
      .select("normalized_name")
      .where("repo_id", "in", localIds)
      .where("normalized_name", "in", rest.slice(i, i + 80))
      .execute();
    for (const row of rows) out.add(row.normalized_name);
  }
  return out;
}

async function auditRequest(c: AppContext, repo: Repository, kind: keyof typeof AUDIT_PATHS) {
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "read");
  const empty = kind === "bulk" ? {} : EMPTY_QUICK_AUDIT;
  let upstream: Repository | null = repo.kind === "remote" ? repo : null;
  if (repo.kind === "virtual") {
    for (const member of await members(svc, repo)) {
      if (member.repo.kind === "remote" && (await access.can(member.repo, "read"))) {
        upstream = member.repo;
        break;
      }
    }
  }
  if (!upstream) {
    // Drain (not cancel) so keep-alive connections stay usable for the next request.
    await readBodyText(c, MAX_AUDIT_BODY);
    return c.json(empty);
  }
  let body = await readBodyText(c, MAX_AUDIT_BODY);
  if (kind === "bulk" && repo.kind === "virtual") {
    let request: Record<string, unknown>;
    try {
      request = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw RegistryError.badRequest("The audit request must be JSON");
    }
    const hidden = await privateNames(svc, repo, Object.keys(request));
    for (const name of hidden) delete request[name];
    if (Object.keys(request).length === 0) return c.json({});
    body = JSON.stringify(request);
  }
  return proxyAudit(svc, upstream, kind, body);
}

// ---------------------------------------------------------------------------
// Routing

function methodNotAllowed(): never {
  throw new RegistryError("unsupported", "Method not allowed");
}

async function readTagVersion(c: AppContext): Promise<string> {
  const text = (await readBodyText(c, 4096)).trim();
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // yarn and older clients may send the bare version.
  }
  if (typeof value !== "string" || !value) {
    throw RegistryError.badRequest("The body must be a JSON string version");
  }
  return value;
}

async function dispatch(c: AppContext, repo: Repository, route: NpmRoute): Promise<Response> {
  const method = c.req.method;
  const read = method === "GET" || method === "HEAD";
  const svc = services(c);
  switch (route.kind) {
    case "ping":
      return c.json({});
    case "whoami":
      return read ? whoami(c) : methodNotAllowed();
    case "search":
      return read ? search(c, repo) : methodNotAllowed();
    case "webLogin":
      return method === "POST" ? startWebLogin(c, repo) : methodNotAllowed();
    case "webLoginDone":
      return read ? webLoginDone(c, route.id) : methodNotAllowed();
    case "couchUser":
      return method === "PUT" ? legacyLogin(c, repo, route.user) : methodNotAllowed();
    case "auditBulk":
    case "auditQuick":
      return method === "POST"
        ? auditRequest(c, repo, route.kind === "auditBulk" ? "bulk" : "quick")
        : methodNotAllowed();
    case "distTags":
      if (!route.tag) return read ? getDistTags(c, repo, route.name) : methodNotAllowed();
      if (method === "PUT" || method === "POST") {
        const target = await writableTarget(svc, repo);
        return changeDistTag(c, target, route.name, route.tag, await readTagVersion(c));
      }
      if (method === "DELETE") {
        return changeDistTag(c, await writableTarget(svc, repo), route.name, route.tag, null);
      }
      return methodNotAllowed();
    case "packument":
      if (read) return getPackument(c, repo, route.name);
      if (method === "PUT") return putPackage(c, repo, await writableTarget(svc, repo), route.name);
      return methodNotAllowed();
    case "version":
      return read ? getVersion(c, repo, route.name, route.spec) : methodNotAllowed();
    case "tarball":
      if (read && route.rev === undefined) return getTarball(c, repo, route.name, route.file);
      if (method === "DELETE") {
        return unpublishFile(c, await writableTarget(svc, repo), route.name, route.file);
      }
      return methodNotAllowed();
    case "rev": {
      if (method === "PUT") {
        const target = await writableTarget(svc, repo);
        await (await svc.access()).require(target, "write");
        const body = await readJsonBody(c, 16 * 1024 * 1024);
        return updatePackument(c, repo, target, route.name, body, route.rev);
      }
      if (method === "DELETE") {
        return unpublishPackage(c, await writableTarget(svc, repo), route.name, route.rev);
      }
      return methodNotAllowed();
    }
    case "unknown":
      throw RegistryError.notFound("Not found");
  }
}

async function handle(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "npm");
  return dispatch(c, repo, parseNpmPath(restPath(c, 2)));
}

const routes = new Hono<AppEnv>();
routes.all("/*", handle);

export const npmFormat: FormatModule = {
  id: "npm",
  routes,
  renderError: (error) => jsonError(error),
  mutations: npmMutations,
};
