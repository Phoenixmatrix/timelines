// `/api/packages`: the artifact store for the web app and gm. Same
// credentials as the registry protocols (session cookie, gmx_ tokens, CI job
// tokens), JSON in and out, errors as `{error}` like the rest of the API.
//
//   GET    /:owner                                   packages and feeds
//   POST   /:owner/feeds                             create a proxy or virtual feed
//   PATCH  /:owner/feeds/:format/:key                visibility, retention, upstream, members
//   DELETE /:owner/feeds/:format/:key
//   GET    /:owner/:format/:name                     one package
//   GET    /:owner/:format/:name/publishes?q=&offset=&limit=   its console
//   POST   /:owner/:format/:name/actions             bulk delete/yank/deprecate/tag
//   POST   /:owner/:format/:name/sources             {repo: "owner/name"}
//   DELETE /:owner/:format/:name/sources/:repoId
//   GET    /-/published?repo=owner/name&commit=|run=  what a commit or run published
//   GET    /-/repo-packages?repo=owner/name          packages a repository publishes
//   GET    /-/npm-login/:publicId, POST …/approve     npm login --auth-type=web
//
// Package names travel as one URL-encoded segment (`@scope%2Fname`).

import { Hono, type Context } from "hono";

import type {
  BulkActionRequest,
  CreateFeedRequest,
  UpdateFeedRequest,
} from "../../shared/packages.ts";
import { services, type AppEnv } from "../core/context.ts";
import { asRegistryError, RegistryError } from "../core/errors.ts";
import { downloadPackageContent, packageContents } from "./contents.ts";
import {
  approveNpmLogin,
  bulkAction,
  createFeed,
  grantSource,
  npmLogin,
  ownerPackages,
  packageDetail,
  packagePublishes,
  published,
  removeFeed,
  repoPackages,
  revokeSource,
  updateFeed,
} from "./service.ts";

async function body<T>(c: Context<AppEnv>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw RegistryError.badRequest("Send a JSON body.");
  }
}

function number(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function packagesApi(): Hono<AppEnv> {
  const api = new Hono<AppEnv>();
  api.onError((error, c) => {
    const e = asRegistryError(error);
    return c.json({ error: e.message }, e.status as 400);
  });
  api.use(async (c, next) => {
    await next();
    c.header("cache-control", "no-store");
  });

  api.get("/-/published", async (c) => {
    const repo = c.req.query("repo") ?? "";
    const commit = c.req.query("commit");
    const run = c.req.query("run");
    return c.json(
      await published(services(c), repo, {
        ...(commit ? { commit } : {}),
        ...(run ? { run: number(run, -1) } : {}),
      }),
    );
  });
  api.get("/-/repo-packages", async (c) =>
    c.json({ packages: await repoPackages(services(c), c.req.query("repo") ?? "") }),
  );
  api.get("/-/npm-login/:id", async (c) => c.json(await npmLogin(services(c), c.req.param("id"))));
  api.post("/-/npm-login/:id/approve", async (c) => {
    await approveNpmLogin(services(c), c.req.param("id"));
    return c.body(null, 204);
  });

  api.get("/:owner", async (c) => c.json(await ownerPackages(services(c), c.req.param("owner"))));

  api.post("/:owner/feeds", async (c) =>
    c.json(
      await createFeed(services(c), c.req.param("owner"), await body<CreateFeedRequest>(c)),
      201,
    ),
  );
  api.patch("/:owner/feeds/:format/:key", async (c) =>
    c.json(
      await updateFeed(
        services(c),
        c.req.param("owner"),
        c.req.param("format"),
        c.req.param("key"),
        await body<UpdateFeedRequest>(c),
      ),
    ),
  );
  api.delete("/:owner/feeds/:format/:key", async (c) => {
    await removeFeed(services(c), c.req.param("owner"), c.req.param("format"), c.req.param("key"));
    return c.body(null, 204);
  });

  const at = (c: Context<AppEnv>) =>
    [c.req.param("owner") ?? "", c.req.param("format") ?? "", c.req.param("name") ?? ""] as const;

  api.get("/:owner/:format/:name/contents", async (c) =>
    c.json(
      await packageContents(services(c), ...at(c), {
        version: c.req.query("version") ?? "",
        path: c.req.query("path"),
        manifest: c.req.query("manifest"),
        offset: number(c.req.query("offset"), 0),
        limit: number(c.req.query("limit"), 100),
      }),
    ),
  );
  api.get("/:owner/:format/:name/contents/download", async (c) =>
    downloadPackageContent(
      services(c),
      ...at(c),
      {
        version: c.req.query("version") ?? "",
        manifest: c.req.query("manifest"),
      },
      c.req.query("id") ?? "",
    ),
  );
  api.get("/:owner/:format/:name", async (c) => c.json(await packageDetail(services(c), ...at(c))));
  api.get("/:owner/:format/:name/publishes", async (c) =>
    c.json(
      await packagePublishes(services(c), ...at(c), {
        query: c.req.query("q") ?? "",
        offset: number(c.req.query("offset"), 0),
        limit: number(c.req.query("limit"), 100),
      }),
    ),
  );
  api.post("/:owner/:format/:name/actions", async (c) =>
    c.json(await bulkAction(services(c), ...at(c), await body<BulkActionRequest>(c))),
  );
  api.post("/:owner/:format/:name/sources", async (c) => {
    const { repo } = await body<{ repo?: string }>(c);
    if (!repo) throw RegistryError.badRequest("Name the repository (owner/name).");
    return c.json({ sources: await grantSource(services(c), ...at(c), repo) });
  });
  api.delete("/:owner/:format/:name/sources/:repoId", async (c) =>
    c.json({ sources: await revokeSource(services(c), ...at(c), c.req.param("repoId")) }),
  );
  return api;
}
