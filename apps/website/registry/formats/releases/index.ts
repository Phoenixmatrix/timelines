import { Hono } from "hono";

import { serveBlob } from "../../core/blobs.ts";
import { services, type AppContext, type AppEnv } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import { jsonError, loadRepo } from "../../core/http.ts";
import type { CreateReleaseInput, UpdateReleaseInput } from "./types.ts";
import type { FormatModule } from "../types.ts";
import * as releases from "./service.ts";

/**
 * GitHub-Releases-style downloads under `/releases/<repo>/` and the REST API
 * under `/api/registry/releases/`. The logic lives in `service.ts`, shared with the
 * web UI's RPC.
 */

const MAX_JSON_BYTES = 1024 * 1024;

function param(c: AppContext, name: string): string {
  return c.req.param(name) ?? "";
}

async function readJson<T>(c: AppContext): Promise<T> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw RegistryError.badRequest("A JSON body is required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_JSON_BYTES) {
      await reader.cancel();
      throw new RegistryError("too_large", "The JSON body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    throw RegistryError.badRequest("The body is not valid JSON");
  }
}

function uploadContentType(c: AppContext): string | undefined {
  const type = c.req.header("content-type");
  // `curl --data-binary` labels files as form data; that is never what an asset is.
  if (!type || type.startsWith("application/x-www-form-urlencoded")) return undefined;
  return type;
}

function truthy(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

async function upload(
  c: AppContext,
  repoKey: string,
  project: string,
  tag: string,
  name: string,
  createRelease: boolean,
): Promise<Response> {
  const body = c.req.raw.body;
  if (!body) throw RegistryError.badRequest("Request body is empty");
  const { asset, created } = await releases.uploadAsset(
    services(c),
    repoKey,
    project,
    tag,
    name,
    body,
    {
      contentType: uploadContentType(c),
      label: c.req.query("label"),
      sha256: c.req.header("x-checksum-sha256") ?? undefined,
      overwrite: truthy(c.req.query("overwrite")),
      createRelease,
    },
  );
  return c.json(asset, created ? 201 : 200, { location: asset.browserDownloadUrl });
}

// ---------------------------------------------------------------------------
// Protocol routes: /releases/<repo>/<project>/<tag>/...

async function download(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "releases");
  const svc = services(c);
  const { release, asset } = await releases.resolveAsset(
    svc,
    repo.key,
    param(c, "project"),
    param(c, "tag"),
    param(c, "asset"),
  );
  if (c.req.method === "GET") {
    svc.waitUntil(releases.countAssetDownload(svc, release.id, asset.name));
  }
  const immutable = param(c, "tag") !== "latest";
  return serveBlob(
    c.req.raw,
    svc.bucket,
    { r2Key: asset.r2_key, size: asset.size, digest: asset.digest },
    {
      contentType: asset.content_type,
      filename: asset.name,
      headers: { "x-checksum-sha256": asset.digest.slice(7) },
      ...(immutable ? {} : { cacheControl: "private, no-cache" }),
    },
  );
}

async function sums(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "releases");
  const { text } = await releases.checksums(
    services(c),
    repo.key,
    param(c, "project"),
    param(c, "tag"),
  );
  return new Response(c.req.method === "HEAD" ? null : text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, no-cache",
    },
  });
}

/** `curl -T file .../releases/<repo>/<project>/<tag>/<asset>`: creates the release if needed. */
async function oneShot(c: AppContext): Promise<Response> {
  const repo = await loadRepo(c, "releases");
  return upload(c, repo.key, param(c, "project"), param(c, "tag"), param(c, "asset"), true);
}

const routes = new Hono<AppEnv>();
routes.on(["GET", "HEAD"], "/:project/:tag/download/:asset", download);
routes.on(["GET", "HEAD"], "/:project/:tag/SHA256SUMS", sums);
routes.put("/:project/:tag/:asset", oneShot);

// ---------------------------------------------------------------------------
// REST API: /api/registry/releases/<repo>/...

const api = new Hono<AppEnv>();

api.get("/:repo/projects", async (c) =>
  c.json(await releases.listProjects(services(c), param(c, "repo"))),
);

api.get("/:repo/:project/releases", async (c) => {
  const page = Number(c.req.query("page")) || 1;
  const perPage = Number(c.req.query("per_page")) || 30;
  const list = await releases.listReleases(services(c), param(c, "repo"), param(c, "project"), {
    page,
    perPage,
  });
  const headers: Record<string, string> = { "x-total-count": String(list.total) };
  if (list.page * list.perPage < list.total) {
    const next = new URL(c.req.url);
    next.searchParams.set("page", String(list.page + 1));
    next.searchParams.set("per_page", String(list.perPage));
    headers.link = `<${next.pathname}${next.search}>; rel="next"`;
  }
  return c.json(list.releases, 200, headers);
});

api.post("/:repo/:project/releases", async (c) =>
  c.json(
    await releases.createRelease(
      services(c),
      param(c, "repo"),
      param(c, "project"),
      await readJson<CreateReleaseInput>(c),
    ),
    201,
  ),
);

api.get("/:repo/:project/releases/latest", async (c) =>
  c.json(await releases.getLatestRelease(services(c), param(c, "repo"), param(c, "project"))),
);

const getByTag = async (c: AppContext) =>
  c.json(
    await releases.getRelease(services(c), param(c, "repo"), param(c, "project"), param(c, "tag")),
  );
api.get("/:repo/:project/releases/tags/:tag", getByTag);
api.get("/:repo/:project/releases/:tag", getByTag);

api.patch("/:repo/:project/releases/:tag", async (c) =>
  c.json(
    await releases.updateRelease(
      services(c),
      param(c, "repo"),
      param(c, "project"),
      param(c, "tag"),
      await readJson<UpdateReleaseInput>(c),
    ),
  ),
);

api.delete("/:repo/:project/releases/:tag", async (c) => {
  await releases.deleteRelease(services(c), param(c, "repo"), param(c, "project"), param(c, "tag"));
  return c.body(null, 204);
});

api.put("/:repo/:project/releases/:tag/assets/:name", (c) =>
  upload(c, param(c, "repo"), param(c, "project"), param(c, "tag"), param(c, "name"), false),
);

api.delete("/:repo/:project/releases/:tag/assets/:name", async (c) => {
  await releases.deleteAsset(
    services(c),
    param(c, "repo"),
    param(c, "project"),
    param(c, "tag"),
    param(c, "name"),
  );
  return c.body(null, 204);
});

export const releasesFormat: FormatModule = {
  id: "releases",
  routes,
  apiRoutes: api,
  renderError: (error) => jsonError(error),
};
