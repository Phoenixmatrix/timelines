import { Hono } from "hono";

import { serveBlob, storeBlob } from "../../core/blobs.ts";
import { requestCompaction } from "../../core/blob-compaction.ts";
import { audit } from "../../core/audit.ts";
import { genericCoordinates, markPublishes, recordFile } from "../../core/provenance.ts";
import { principalOf } from "../../core/auth/actor.ts";
import {
  addFile,
  countDownload,
  deleteFile,
  ensurePackage,
  getFile,
  getPackage,
  listFiles,
} from "../../core/catalog.ts";
import { services, type AppContext, type AppEnv } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import { jsonError, loadRepo, restPath, safePath } from "../../core/http.ts";
import { cachedArtifact } from "../../core/remote.ts";
import type { Repository } from "../../core/repos.ts";
import { deployTarget, firstMatch } from "../../core/virtual.ts";
import type { FormatModule } from "../types.ts";

/**
 * Arbitrary files at arbitrary paths: `curl -T file https://pkg/generic/<repo>/a/b`.
 * Speaks Artifactory's deploy conventions (X-Checksum-* headers) so existing
 * scripts keep working, and serves `<file>.sha256`-style sidecars.
 */

const SIDE_CARS = {
  ".sha256": "sha256",
  ".sha1": "sha1",
  ".md5": "md5",
  ".sha512": "sha512",
} as const;

interface Listing {
  repo: string;
  path: string;
  children: {
    name: string;
    folder: boolean;
    size?: number;
    sha256?: string;
    lastModified?: string;
  }[];
}

async function listing(c: AppContext, repo: Repository, dir: string): Promise<Listing | null> {
  const prefix = dir ? `${dir}/` : "";
  const files = await listFiles(services(c).db, repo.id, { prefix, limit: 10_000 });
  if (files.length === 0 && dir) return null;
  const folders = new Set<string>();
  const children: Listing["children"] = [];
  for (const file of files) {
    const rest = file.path.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) {
      children.push({
        name: rest,
        folder: false,
        size: file.size,
        sha256: file.digest.slice("sha256:".length),
        lastModified: file.createdAt,
      });
    } else folders.add(rest.slice(0, slash));
  }
  return {
    repo: repo.key,
    path: `/${dir}`,
    children: [...[...folders].sort().map((name) => ({ name, folder: true })), ...children],
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function listingHtml(list: Listing): Response {
  const rows = list.children
    .map((child) => {
      const href = encodeURIComponent(child.name) + (child.folder ? "/" : "");
      const label = escapeHtml(child.name + (child.folder ? "/" : ""));
      const size = child.folder ? "-" : String(child.size);
      return `<a href="${href}">${label}</a>${" ".repeat(Math.max(1, 60 - label.length))}${size}`;
    })
    .join("\n");
  const title = escapeHtml(`${list.repo}${list.path}`);
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><pre><a href="../">../</a>\n${rows}</pre></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

async function fromRemote(c: AppContext, repo: Repository, path: string): Promise<Response | null> {
  const cached = await cachedArtifact(services(c), repo, path);
  if (!cached) return null;
  return serveBlob(c.req.raw, services(c).bucket, cached.blob, {
    contentType: cached.contentType,
    filename: path.split("/").pop(),
  });
}

/** A file from one member of a virtual repository, or null. */
async function resolveFile(
  c: AppContext,
  member: Repository,
  path: string,
): Promise<Response | null> {
  if (member.kind === "remote") return fromRemote(c, member, path);
  const file = await getFile(services(c).db, member.id, path);
  if (!file) return null;
  return serveBlob(c.req.raw, services(c).bucket, file, {
    contentType: file.contentType,
    filename: path.split("/").pop(),
  });
}

async function read(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "generic");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const raw = restPath(c, 2);
  const path = safePath(raw);

  if (path && repo.kind !== "local") {
    const found =
      repo.kind === "remote"
        ? await fromRemote(c, repo, path)
        : ((await firstMatch(svc, repo, path, (member) => resolveFile(c, member, path)))?.value ??
          null);
    if (found) return found;
    throw RegistryError.notFound(`${path} not found`);
  }

  if (path) {
    const file = await getFile(svc.db, repo.id, path);
    if (file) {
      if (c.req.method === "GET") svc.waitUntil(countDownload(svc.db, file.id));
      return serveBlob(c.req.raw, svc.bucket, file, {
        contentType: file.contentType,
        filename: path.split("/").pop(),
        headers: {
          "x-checksum-sha256": file.digest.slice(7),
          ...(file.sha1 ? { "x-checksum-sha1": file.sha1 } : {}),
          ...(file.md5 ? { "x-checksum-md5": file.md5 } : {}),
        },
      });
    }
    for (const [suffix, algo] of Object.entries(SIDE_CARS)) {
      if (!path.endsWith(suffix)) continue;
      const target = await getFile(svc.db, repo.id, path.slice(0, -suffix.length));
      const value =
        target &&
        (algo === "sha256" ? target.digest.slice(7) : target[algo as "sha1" | "md5" | "sha512"]);
      if (value)
        return c.text(value, 200, { "cache-control": "private, max-age=0, must-revalidate" });
    }
  }

  const list = await listing(c, repo, path);
  if (!list) throw RegistryError.notFound(`${path} not found`);
  if (!raw.endsWith("/") && path) return c.redirect(`${new URL(c.req.url).pathname}/`, 301);
  const wantsJson =
    c.req.query("format") === "json" || (c.req.header("accept") ?? "").includes("application/json");
  return wantsJson ? c.json(list) : listingHtml(list);
}

async function upload(c: AppContext): Promise<Response> {
  const svc = services(c);
  let repo = await loadRepo(c, "generic");
  if (repo.kind === "virtual") {
    const target = await deployTarget(svc, repo);
    if (!target)
      throw new RegistryError("unsupported", `${repo.key} has no default deploy repository`);
    repo = target;
  }
  if (repo.kind !== "local") throw new RegistryError("unsupported", "Deploy to a local repository");
  const access = await svc.access();
  await access.require(repo, "write");
  const path = safePath(restPath(c, 2));
  if (!path || path.endsWith("/")) throw RegistryError.badRequest("A file path is required");
  if (!c.req.raw.body) throw RegistryError.badRequest("Request body is empty");

  // `<package>/<version>/…`: gate the package before storing anything.
  const coords = genericCoordinates(path);
  const pkg = await ensurePackage(svc.db, repo.id, coords.name, coords.name.toLowerCase(), {
    kind: "files",
  });
  const existing = await getFile(svc.db, repo.id, path);
  const overwrite =
    existing !== null && repo.config.immutable !== true && (await access.can(repo, "delete"));
  if (existing && !overwrite) {
    throw new RegistryError(
      "immutable",
      `${path} already exists; delete it first or ask for delete permission`,
    );
  }

  const blob = await storeBlob(svc.db, svc.bucket, c.req.raw.body, {
    contentType: c.req.header("content-type") ?? undefined,
    maxBytes: repo.config.maxUploadBytes,
    expect: {
      sha256: c.req.header("x-checksum-sha256") ?? undefined,
      sha1: c.req.header("x-checksum-sha1") ?? undefined,
      md5: c.req.header("x-checksum-md5") ?? c.req.header("x-checksum") ?? undefined,
    },
  });
  const actor = access.actor;
  await addFile(svc.db, {
    repoId: repo.id,
    path,
    digest: blob.digest,
    size: blob.size,
    contentType: c.req.header("content-type") ?? "application/octet-stream",
    createdBy: principalOf(actor),
    overwrite,
  });
  await requestCompaction(svc);
  await recordFile(
    svc.db,
    { packageId: pkg.id, repoId: repo.id, version: coords.version, action: "generic.deploy" },
    blob,
  );
  await audit(svc.db, actor, "generic.deploy", {
    repoId: repo.id,
    target: path,
    detail: { digest: blob.digest, size: blob.size },
  });
  const url = `${svc.baseUrl}/generic/${repo.key}/${path.split("/").map(encodeURIComponent).join("/")}`;
  return c.json(
    {
      repo: repo.key,
      path: `/${path}`,
      downloadUri: url,
      size: blob.size,
      checksums: { sha256: blob.digest.slice(7), sha1: blob.sha1, md5: blob.md5 },
    },
    201,
    { location: url },
  );
}

async function remove(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "generic");
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "delete");
  const path = safePath(restPath(c, 2));
  if (!path) throw RegistryError.badRequest("Refusing to delete the repository root");
  let deleted = (await deleteFile(svc.db, repo.id, path)) ? 1 : 0;
  if (!deleted) {
    for (const file of await listFiles(svc.db, repo.id, { prefix: `${path}/` })) {
      if (await deleteFile(svc.db, repo.id, file.path)) deleted++;
    }
  }
  if (!deleted) throw RegistryError.notFound(`${path} not found`);
  const coords = genericCoordinates(path);
  const pkg = await getPackage(svc.db, repo.id, coords.name.toLowerCase());
  if (pkg && path.split("/").length <= 2) {
    await markPublishes(svc.db, pkg.id, path.includes("/") ? coords.version : null, "deleted");
  }
  await audit(svc.db, access.actor, "generic.delete", {
    repoId: repo.id,
    target: path,
    detail: { files: deleted },
  });
  return new Response(null, { status: 204 });
}

const routes = new Hono<AppEnv>();
routes.on(["GET", "HEAD"], "/*", read);
routes.on(["GET", "HEAD"], "/", read);
routes.put("/*", upload);
routes.delete("/*", remove);

export const genericFormat: FormatModule = {
  id: "generic",
  routes,
  renderError: (error) => jsonError(error),
};
