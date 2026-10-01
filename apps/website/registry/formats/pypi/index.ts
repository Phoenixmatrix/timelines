import {
  isValidProjectName,
  negotiateSimple,
  normalizeName,
  normalizeVersion,
  renderIndexHtml,
  renderIndexJson,
  renderProjectHtml,
  renderProjectJson,
} from "@gitmatrix/formats/pypi";
import { Hono } from "hono";

import { audit } from "../../core/audit.ts";
import { serveBlob } from "../../core/blobs.ts";
import {
  countDownload,
  deletePackage,
  deleteVersion,
  getFile,
  getPackage,
  getVersion,
  listVersions,
  updateVersion,
} from "../../core/catalog.ts";
import { services, type AppContext, type AppEnv } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import { basicChallenge, jsonError, loadRepo, restPath } from "../../core/http.ts";
import { cachedArtifact, upstreamFetch } from "../../core/remote.ts";
import type { Repository } from "../../core/repos.ts";
import { firstMatch } from "../../core/virtual.ts";
import type { FormatModule } from "../types.ts";
import {
  projectNames,
  resolveProject,
  safeSegment,
  upstreamProject,
  type PypiFileMeta,
} from "./simple.ts";
import { upload } from "./upload.ts";

/**
 * PyPI: the Simple Repository API (PEP 503 HTML and PEP 691 JSON, with
 * PEP 592/658/700/714 extras) for pip, uv, poetry, pdm and pipenv, and the
 * legacy upload API for twine, uv, poetry, flit and hatch.
 *
 *   /pypi/<repo>/simple/                      project index
 *   /pypi/<repo>/simple/<project>/            project page
 *   /pypi/<repo>/packages/<project>/<v>/<f>   local files (and `<f>.metadata`)
 *   /pypi/<repo>/remote-files/<p>/<sha>/<f>   files proxied from upstream
 *   POST /pypi/<repo>/ (or /legacy/)          upload
 */

function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw RegistryError.badRequest("Malformed path");
  }
}

function page(c: AppContext, contentType: string, body: string): Response {
  return new Response(c.req.method === "HEAD" ? null : body, {
    headers: {
      "content-type": contentType.startsWith("text/")
        ? `${contentType}; charset=utf-8`
        : contentType,
      vary: "Accept",
      "cache-control": "private, max-age=0, must-revalidate",
    },
  });
}

async function readable(c: AppContext): Promise<Repository> {
  const repo = await loadRepo(c, "pypi");
  await (await services(c).access()).require(repo, "read");
  return repo;
}

async function simpleIndex(c: AppContext): Promise<Response> {
  const repo = await readable(c);
  const names = await projectNames(services(c), repo);
  const negotiated = negotiateSimple(c.req.header("accept") ?? null, c.req.query("format"));
  return negotiated.format === "json"
    ? page(c, negotiated.contentType, renderIndexJson(names))
    : page(c, negotiated.contentType, renderIndexHtml(names));
}

async function projectPage(c: AppContext, rawName: string): Promise<Response> {
  const repo = await readable(c);
  const name = decodeSegment(rawName);
  if (!isValidProjectName(name)) throw RegistryError.notFound(`No project ${name}`);
  const normalized = normalizeName(name);
  if (normalized !== name) {
    const query = new URL(c.req.url).search;
    return c.redirect(`/pypi/${repo.key}/simple/${normalized}/${query}`, 301);
  }
  const project = await resolveProject(services(c), repo, normalized);
  if (!project) throw RegistryError.notFound(`No project ${normalized} in ${repo.key}`);
  const negotiated = negotiateSimple(c.req.header("accept") ?? null, c.req.query("format"));
  return negotiated.format === "json"
    ? page(c, negotiated.contentType, renderProjectJson(project))
    : page(c, negotiated.contentType, renderProjectHtml(project));
}

/** A file of a local repository by its catalog path (`<project>/<version>/<filename>`). */
async function localFile(c: AppContext, repo: Repository, path: string): Promise<Response | null> {
  const svc = services(c);
  const file = await getFile<PypiFileMeta>(svc.db, repo.id, path);
  if (!file) return null;
  if (c.req.method === "GET" && file.metadata.kind === "dist") {
    svc.waitUntil(countDownload(svc.db, file.id));
  }
  return serveBlob(c.req.raw, svc.bucket, file, {
    contentType: file.contentType,
    filename: path.split("/").pop(),
  });
}

async function packageFile(c: AppContext, parts: string[]): Promise<Response> {
  const repo = await readable(c);
  if (parts.length !== 3 || !parts.every(safeSegment)) throw RegistryError.notFound("Not found");
  const path = parts.join("/");
  const found =
    repo.kind === "local"
      ? await localFile(c, repo, path)
      : repo.kind === "virtual"
        ? ((
            await firstMatch(services(c), repo, parts[0]!, (member) =>
              member.kind === "local" ? localFile(c, member, path) : Promise.resolve(null),
            )
          )?.value ?? null)
        : null;
  if (!found) throw RegistryError.notFound(`${parts[2]} not found`);
  return found;
}

/**
 * A file listed on the upstream project page. Only URLs that appeared in
 * cached upstream metadata are ever fetched: this is not an open proxy.
 */
async function remoteFile(
  c: AppContext,
  repo: Repository,
  project: string,
  sha: string,
  filename: string,
): Promise<Response | null> {
  const svc = services(c);
  const isMetadata = filename.endsWith(".metadata");
  const distName = isMetadata ? filename.slice(0, -".metadata".length) : filename;
  const locate = async () => {
    const upstream = await upstreamProject(svc, repo, project);
    const file = upstream?.files.find((f) => f.filename === distName);
    if (!file || (sha !== "_" && file.hashes.sha256 !== sha)) return null;
    return file;
  };
  let cached;
  if (isMetadata) {
    const file = await locate();
    if (!file?.coreMetadata) return null;
    const expected = file.coreMetadata === true ? undefined : file.coreMetadata.sha256;
    cached = await cachedArtifact(svc, repo, `files/${project}/${filename}`, {
      url: new URL(`${file.url}.metadata`),
      expect: { sha256: expected },
      contentType: "text/plain; charset=utf-8",
    });
  } else {
    // The upstream page is only consulted on a cache miss.
    cached = await cachedArtifact(svc, repo, `files/${project}/${filename}`, {
      expect: { sha256: sha === "_" ? undefined : sha },
      contentType: "application/octet-stream",
      fetcher: async () => {
        const file = await locate();
        if (!file) return new Response(null, { status: 404 });
        return upstreamFetch(svc, repo, new URL(file.url), { timeoutMs: 10 * 60_000 });
      },
    });
  }
  if (!cached) return null;
  return serveBlob(c.req.raw, svc.bucket, cached.blob, {
    contentType: cached.contentType,
    filename,
  });
}

async function remoteFileRoute(c: AppContext, parts: string[]): Promise<Response> {
  const repo = await readable(c);
  const [project, sha, filename] = parts as [string, string, string];
  if (
    parts.length !== 3 ||
    !isValidProjectName(project) ||
    normalizeName(project) !== project ||
    !(sha === "_" || /^[0-9a-f]{64}$/.test(sha)) ||
    !safeSegment(filename)
  ) {
    throw RegistryError.notFound("Not found");
  }
  const found =
    repo.kind === "remote"
      ? await remoteFile(c, repo, project, sha, filename)
      : repo.kind === "virtual"
        ? ((
            await firstMatch(services(c), repo, project, (member) =>
              member.kind === "remote"
                ? remoteFile(c, member, project, sha, filename)
                : Promise.resolve(null),
            )
          )?.value ?? null)
        : null;
  if (!found) throw RegistryError.notFound(`${filename} not found`);
  return found;
}

async function dispatch(c: AppContext): Promise<Response> {
  const raw = restPath(c, 2);
  const segments = raw.split("/");
  const method = c.req.method;
  if (method === "POST") {
    if (raw === "" || raw === "legacy" || raw === "legacy/") return upload(c);
    throw RegistryError.notFound("Not found");
  }
  if (method !== "GET" && method !== "HEAD") {
    throw new RegistryError("unsupported", `${method} is not supported here`);
  }
  const [head, ...rest] = segments;
  if (head === "simple") {
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "")) return simpleIndex(c);
    if (rest.length === 1 || (rest.length === 2 && rest[1] === "")) return projectPage(c, rest[0]!);
  } else if (head === "packages") {
    return packageFile(c, rest.map(decodeSegment));
  } else if (head === "remote-files") {
    return remoteFileRoute(c, rest.map(decodeSegment));
  } else if (raw === "") {
    await readable(c);
    return c.redirect(`/pypi/${c.req.param("repo")}/simple/`, 302);
  }
  await readable(c);
  throw RegistryError.notFound("Not found");
}

const routes = new Hono<AppEnv>();
routes.all("/", dispatch);
routes.all("/*", dispatch);

// ---------------------------------------------------------------------------
// REST: yank, unyank, delete (`/api/registry/pypi/<repo>/<project>/<version>/...`)

async function releaseOf(c: AppContext, action: "write" | "delete") {
  const svc = services(c);
  const repo = await loadRepo(c, "pypi");
  if (repo.kind !== "local") throw new RegistryError("unsupported", "Only local repositories");
  const access = await svc.access();
  await access.require(repo, action);
  const normalized = normalizeName(c.req.param("project") ?? "");
  const pkg = await getPackage(svc.db, repo.id, normalized);
  if (!pkg) throw RegistryError.notFound(`No project ${normalized}`);
  const raw = c.req.param("version");
  const version = raw === undefined ? null : normalizeVersion(raw);
  if (raw !== undefined && !version)
    throw new RegistryError("version_invalid", `Invalid version ${raw}`);
  const row = version ? await getVersion(svc.db, pkg.id, version) : null;
  if (version && !row) throw RegistryError.notFound(`No release ${normalized} ${version}`);
  return { svc, repo, access, pkg, row };
}

async function setYanked(c: AppContext, yanked: boolean): Promise<Response> {
  const { svc, repo, access, pkg, row } = await releaseOf(c, "write");
  let reason: string | null = null;
  if (yanked) {
    if (Number(c.req.header("content-length") ?? 0) > 16 * 1024) {
      throw RegistryError.badRequest("Body too large");
    }
    const text = await c.req.text();
    if (text.length > 16 * 1024) throw RegistryError.badRequest("Body too large");
    let body: { reason?: unknown } = {};
    try {
      body = text ? (JSON.parse(text) as { reason?: unknown }) : {};
    } catch {
      throw RegistryError.badRequest('Expected a JSON body like {"reason": "..."}');
    }
    if (typeof body?.reason === "string") reason = body.reason.slice(0, 1000);
  }
  await updateVersion(svc.db, row!.id, {
    status: yanked ? "yanked" : "active",
    statusReason: yanked ? reason : null,
  });
  await audit(svc.db, access.actor, yanked ? "pypi.yank" : "pypi.unyank", {
    repoId: repo.id,
    target: `${pkg.normalizedName}==${row!.version}`,
    detail: reason ? { reason } : {},
  });
  return c.json({ project: pkg.normalizedName, version: row!.version, yanked, reason });
}

const apiRoutes = new Hono<AppEnv>();
apiRoutes.post("/:repo/:project/:version/yank", (c) => setYanked(c, true));
apiRoutes.post("/:repo/:project/:version/unyank", (c) => setYanked(c, false));
apiRoutes.delete("/:repo/:project/:version", async (c) => {
  const { svc, repo, access, pkg, row } = await releaseOf(c, "delete");
  await deleteVersion(svc.db, row!.id);
  if ((await listVersions(svc.db, pkg.id)).length === 0) await deletePackage(svc.db, pkg.id);
  await audit(svc.db, access.actor, "pypi.delete", {
    repoId: repo.id,
    target: `${pkg.normalizedName}==${row!.version}`,
  });
  return c.body(null, 204);
});
apiRoutes.delete("/:repo/:project", async (c) => {
  const { svc, repo, access, pkg } = await releaseOf(c, "delete");
  await deletePackage(svc.db, pkg.id);
  await audit(svc.db, access.actor, "pypi.delete", { repoId: repo.id, target: pkg.normalizedName });
  return c.body(null, 204);
});

/** Plain-text errors; the message doubles as the reason phrase, which twine prints. */
function renderError(error: RegistryError, c: AppContext): Response {
  if (new URL(c.req.url).pathname.startsWith("/api/")) return jsonError(error);
  const reason = error.message.replace(/[^\x20-\x7e]/g, " ").slice(0, 200);
  return new Response(`${error.message}\n`, {
    status: error.status,
    statusText: reason,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      ...(error.status === 401 ? basicChallenge() : {}),
    },
  });
}

export const pypiFormat: FormatModule = {
  id: "pypi",
  routes,
  apiRoutes,
  renderError,
};
