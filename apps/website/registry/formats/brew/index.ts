import {
  checkTapFile,
  parseBottleFileName,
  parseTapFile,
  renderFormula,
  TAP_NAME_PATTERN,
  validDownloadFileName,
  validTapName,
  type FormulaSpec,
  type TapFileKind,
} from "@gitmatrix/formats/brew";
import { Hono } from "hono";
import { z } from "zod";

import { audit } from "../../core/audit.ts";
import { principalOf } from "../../core/auth/actor.ts";
import { serveBlob, storeBlob } from "../../core/blobs.ts";
import {
  addFile,
  countDownload,
  deleteFile,
  getFile,
  getPackage,
  getVersion,
  listFiles,
} from "../../core/catalog.ts";
import { services, type AppContext, type AppEnv } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import { jsonError, loadRepo, textError } from "../../core/http.ts";
import type { Repository } from "../../core/repos.ts";
import type { FormatModule } from "../types.ts";
import { infoRefs, readBody, receivePack, uploadPack } from "./git-http.ts";
import { getHead } from "./store.ts";
import {
  bottleRootUrl,
  commitTap,
  listTapFiles,
  mutateTap,
  needsAuth,
  tapMutations,
  tapName,
  tapPath,
  tapUrl,
  type CommitResult,
  type DeleteFilePayload,
  type PutFilePayload,
  type PutFileResult,
  type TapVersionMeta,
} from "./tap.ts";

/**
 * Homebrew taps served as read-only git repositories over smart HTTP
 * (`brew tap user/name <registry>/brew/<repo>/homebrew-<tap>.git`), plus
 * bottle and source-archive downloads under `/brew/<repo>/bottles/`.
 * Formulae and casks are published through `/api/registry/brew`.
 */

const MAX_TAP_FILE_BYTES = 1024 * 1024;

async function localRepo(c: AppContext): Promise<Repository> {
  const repo = await loadRepo(c, "brew");
  if (repo.kind !== "local") throw new RegistryError("unsupported", "Taps are local repositories");
  return repo;
}

function bottleName(c: AppContext): string {
  const file = c.req.param("file") ?? "";
  if (!validDownloadFileName(file)) throw RegistryError.badRequest(`Invalid file name ${file}`);
  return file;
}

async function summary(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "brew");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const head = await getHead(svc.db, repo.id);
  return c.json({
    repository: repo.key,
    tap: `gitmatrix/${tapName(repo)}`,
    url: tapUrl(svc.baseUrl, repo),
    bottleRootUrl: bottleRootUrl(svc.baseUrl, repo),
    head: head?.oid ?? null,
    install: `brew tap gitmatrix/${tapName(repo)} ${tapUrl(svc.baseUrl, repo)}`,
  });
}

async function getBottle(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "brew");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const file = bottleName(c);
  const row = await getFile(svc.db, repo.id, `bottles/${file}`);
  if (!row) throw RegistryError.notFound(`${file} not found`);
  if (c.req.method === "GET") svc.waitUntil(countDownload(svc.db, row.id));
  return serveBlob(c.req.raw, svc.bucket, row, {
    contentType: row.contentType,
    filename: file,
    cacheControl: needsAuth(repo) ? "private, max-age=0, must-revalidate" : "public, max-age=300",
    headers: { "x-checksum-sha256": row.digest.slice("sha256:".length) },
  });
}

async function putBottle(c: AppContext): Promise<Response> {
  const repo = await localRepo(c);
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "write");
  const file = bottleName(c);
  if (!c.req.raw.body) throw RegistryError.badRequest("Request body is empty");
  const path = `bottles/${file}`;
  const existing = await getFile(svc.db, repo.id, path);
  const blob = await storeBlob(svc.db, svc.bucket, c.req.raw.body, {
    contentType: "application/octet-stream",
    maxBytes: repo.config.maxUploadBytes,
    expect: {
      sha256: c.req.header("x-checksum-sha256") ?? c.req.query("sha256") ?? undefined,
      sha1: c.req.header("x-checksum-sha1") ?? undefined,
    },
  });
  const changed = existing !== null && existing.digest !== blob.digest;
  if (changed && (repo.config.immutable === true || !(await access.can(repo, "delete")))) {
    throw new RegistryError(
      "immutable",
      `${file} already exists with different content; formulae pin its sha256`,
    );
  }
  const bottle = parseBottleFileName(file);
  await addFile(svc.db, {
    repoId: repo.id,
    path,
    digest: blob.digest,
    size: blob.size,
    contentType:
      file.endsWith(".gz") || file.endsWith(".tgz")
        ? "application/gzip"
        : "application/octet-stream",
    metadata: bottle ? { bottle } : {},
    createdBy: principalOf(access.actor),
    overwrite: changed,
  });
  await audit(svc.db, access.actor, "brew.upload", {
    repoId: repo.id,
    target: path,
    detail: { digest: blob.digest, size: blob.size },
  });
  const url = `${bottleRootUrl(svc.baseUrl, repo)}/${file}`;
  return c.json(
    { repo: repo.key, path, url, size: blob.size, sha256: blob.digest.slice(7), bottle },
    existing && !changed ? 200 : 201,
    { location: url },
  );
}

async function deleteBottle(c: AppContext): Promise<Response> {
  const repo = await localRepo(c);
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "delete");
  const path = `bottles/${bottleName(c)}`;
  if (!(await deleteFile(svc.db, repo.id, path))) throw RegistryError.notFound(`${path} not found`);
  await audit(svc.db, access.actor, "brew.delete", { repoId: repo.id, target: path });
  return c.body(null, 204);
}

const routes = new Hono<AppEnv>();
routes.get("/", summary);
routes.get("/:tap/info/refs", infoRefs);
routes.post("/:tap/git-upload-pack", uploadPack);
routes.post("/:tap/git-receive-pack", receivePack);
routes.on(["GET", "HEAD"], "/bottles/:file", getBottle);
routes.put("/bottles/:file", putBottle);
routes.delete("/bottles/:file", deleteBottle);

// Management API (/api/registry/brew).

function tapFileParams(c: AppContext): { kind: TapFileKind; name: string } {
  const dir = c.req.param("dir");
  const file = c.req.param("file") ?? "";
  const kind: TapFileKind = dir === "Casks" ? "cask" : "formula";
  const name = file.endsWith(".rb") ? file.slice(0, -3) : "";
  if (!validTapName(name)) {
    throw new RegistryError(
      "name_invalid",
      `Expected ${dir}/<name>.rb with a name matching ${TAP_NAME_PATTERN.source}`,
    );
  }
  return { kind, name };
}

async function publishTapFile(
  c: AppContext,
  repo: Repository,
  kind: TapFileKind,
  name: string,
  content: string,
): Promise<Response> {
  const svc = services(c);
  const access = await svc.access();
  const problem = checkTapFile(kind, name, content);
  if (problem) throw RegistryError.badRequest(problem);
  const info = parseTapFile(kind, content);
  const blob = await storeBlob(svc.db, svc.bucket, content, {
    contentType: "text/x-ruby; charset=utf-8",
  });
  const version = info.version ?? `sha256-${blob.digest.slice(7, 19)}`;
  const path = tapPath(kind, name);

  const pkg = await getPackage(svc.db, repo.id, path.slice(0, -3));
  const previous = pkg ? await getVersion<TapVersionMeta>(svc.db, pkg.id, version) : null;
  const overwrite = previous !== null && previous.metadata.digest !== blob.digest;
  const allowOverwrite =
    overwrite && repo.config.immutable !== true && (await access.can(repo, "delete"));
  if (overwrite && !allowOverwrite) {
    throw new RegistryError(
      "immutable",
      `${name} ${version} is already published with different content; bump its version or revision (or overwrite with delete permission)`,
    );
  }
  const publishedBy = principalOf(access.actor);
  const result = await mutateTap<PutFileResult>(svc, repo, "putFile", {
    kind,
    name,
    content,
    digest: blob.digest,
    size: blob.size,
    version,
    desc: info.desc,
    publishedBy,
    allowOverwrite,
  } satisfies PutFilePayload);
  await audit(svc.db, access.actor, "brew.publish", {
    repoId: repo.id,
    target: path,
    detail: { version, digest: blob.digest, commit: result.commit },
  });
  return c.json(
    {
      repo: repo.key,
      path,
      kind,
      name,
      version,
      sha256: blob.digest.slice(7),
      commit: result.commit,
      changed: result.changed,
      tap: tapUrl(svc.baseUrl, repo),
    },
    result.changed ? 201 : 200,
  );
}

async function readText(c: AppContext): Promise<string> {
  const bytes = await readBody(c.req.raw, MAX_TAP_FILE_BYTES);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw RegistryError.badRequest("The body must be UTF-8 text");
  }
}

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex digits");

const FormulaInput = z
  .object({
    name: z.string().regex(TAP_NAME_PATTERN).max(100),
    desc: z.string().max(500).optional(),
    homepage: z.url().optional(),
    url: z.url(),
    sha256: Sha256,
    version: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._+~-]*$/)
      .max(100)
      .optional(),
    revision: z.number().int().min(0).max(1000).optional(),
    license: z.string().max(200).optional(),
    depends_on: z
      .array(
        z.union([
          z.string().regex(/^[a-z0-9][a-z0-9@._+/-]*$/),
          z.object({
            name: z.string().regex(/^[a-z0-9][a-z0-9@._+/-]*$/),
            type: z.enum(["build", "test", "recommended", "optional"]).optional(),
          }),
        ]),
      )
      .max(100)
      .optional(),
    install: z
      .string()
      .max(64 * 1024)
      .optional(),
    test: z
      .string()
      .max(64 * 1024)
      .optional(),
    caveats: z
      .string()
      .max(8 * 1024)
      .optional(),
    bottles: z
      .record(
        z.string().regex(/^[a-z0-9_]+$/),
        z.union([
          Sha256,
          z.object({
            sha256: Sha256,
            cellar: z
              .string()
              .regex(/^(?::?any|:?any_skip_relocation|\/[A-Za-z0-9/._-]+)$/)
              .optional(),
          }),
        ]),
      )
      .optional(),
  })
  .strict();

const api = new Hono<AppEnv>();

api.get("/:repo/files", async (c) => {
  const repo = await loadRepo(c, "brew");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const head = await getHead(svc.db, repo.id);
  const { formulae, casks } = await listTapFiles(svc, repo);
  const bottles = await listFiles(svc.db, repo.id, { prefix: "bottles/" });
  const entry = (f: (typeof formulae)[number]) => ({
    path: f.path,
    name: f.metadata.name,
    version: f.metadata.version,
    desc: f.metadata.desc ?? null,
    sha256: f.digest.slice(7),
    size: f.size,
    updatedAt: f.createdAt,
  });
  return c.json({
    repository: repo.key,
    tap: tapUrl(svc.baseUrl, repo),
    head: head?.oid ?? null,
    formulae: formulae.map(entry),
    casks: casks.map(entry),
    bottles: bottles.map((b) => ({
      path: b.path,
      url: `${bottleRootUrl(svc.baseUrl, repo)}/${b.path.slice("bottles/".length)}`,
      sha256: b.digest.slice(7),
      size: b.size,
      downloads: b.downloads,
    })),
  });
});

api.get("/:repo/:dir{Formula|Casks}/:file", async (c) => {
  const repo = await loadRepo(c, "brew");
  const svc = services(c);
  await (await svc.access()).require(repo, "read");
  const { kind, name } = tapFileParams(c);
  const file = await getFile(svc.db, repo.id, tapPath(kind, name));
  if (!file) throw RegistryError.notFound(`${tapPath(kind, name)} not found`);
  return serveBlob(c.req.raw, svc.bucket, file, { contentType: "text/plain; charset=utf-8" });
});

api.put("/:repo/:dir{Formula|Casks}/:file", async (c) => {
  const repo = await localRepo(c);
  await (await services(c).access()).require(repo, "write");
  const { kind, name } = tapFileParams(c);
  return publishTapFile(c, repo, kind, name, await readText(c));
});

api.delete("/:repo/:dir{Formula|Casks}/:file", async (c) => {
  const repo = await localRepo(c);
  const svc = services(c);
  const access = await svc.access();
  await access.require(repo, "delete");
  const { kind, name } = tapFileParams(c);
  const result = await mutateTap<CommitResult>(svc, repo, "deleteFile", {
    kind,
    name,
    publishedBy: principalOf(access.actor),
  } satisfies DeleteFilePayload);
  await audit(svc.db, access.actor, "brew.delete", {
    repoId: repo.id,
    target: tapPath(kind, name),
  });
  return c.json(result);
});

api.post("/:repo/formula", async (c) => {
  const repo = await localRepo(c);
  const svc = services(c);
  await (await svc.access()).require(repo, "write");
  let raw: unknown;
  try {
    raw = JSON.parse(await readText(c));
  } catch (error) {
    if (error instanceof RegistryError) throw error;
    throw RegistryError.badRequest("Body must be JSON");
  }
  const parsed = FormulaInput.safeParse(raw);
  if (!parsed.success) {
    throw RegistryError.badRequest("Invalid formula", z.treeifyError(parsed.error));
  }
  const { depends_on: dependsOn, ...rest } = parsed.data;
  const spec: FormulaSpec = { ...rest, dependsOn };
  const source = renderFormula(spec, {
    bottleRootUrl: bottleRootUrl(svc.baseUrl, repo),
    registryUrl: svc.baseUrl,
    authenticated: needsAuth(repo),
  });
  return publishTapFile(c, repo, "formula", spec.name, source);
});

/** Git clients get plain text (git prints it); the API gets JSON. */
function renderError(error: RegistryError, c: AppContext): Response {
  const path = new URL(c.req.url).pathname;
  if (path.startsWith("/api/"))
    return jsonError(error, { error: error.message, code: error.code, detail: error.detail });
  return textError(error);
}

export const brewFormat: FormatModule = {
  id: "brew",
  routes,
  renderError,
  apiRoutes: api,
  mutations: tapMutations,
  rebuild: async (svc, repo) => {
    if (repo.kind === "local") await commitTap(svc, repo, "Regenerate tap files");
  },
};
