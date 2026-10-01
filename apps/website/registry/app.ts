import { FORMATS } from "@gitmatrix/formats/info";
import { Hono, type Context, type Next } from "hono";

import { Services, withServices, type AppEnv } from "./core/context.ts";
import { asRegistryError } from "./core/errors.ts";
import { registeredFormats } from "./formats/index.ts";
import { packagesApi } from "./manage/routes.ts";

/**
 * URL prefixes the registry answers on gitmatrix's host: `/v2` for OCI
 * (docker, helm OCI…), `/<format>/<feed>/…` for the rest. Account slugs may
 * not take these names.
 */
export const REGISTRY_PREFIXES = Object.values(FORMATS).map((f) => f.prefix);

function waitUntilOf(c: {
  executionCtx: { waitUntil(p: Promise<unknown>): void };
}): (p: Promise<unknown>) => void {
  try {
    const ctx = c.executionCtx;
    return (p) => ctx.waitUntil(p);
  } catch {
    // No ExecutionContext outside the Workers runtime (unit tests): just run it.
    return (p) => void p.catch(() => undefined);
  }
}

/** Every package format's wire protocol, mounted at its prefix. */
export function buildRegistry(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  const scopes = [
    ...registeredFormats().map((f) => (f.id === "oci" ? "/v2/*" : `/${FORMATS[f.id].prefix}/*`)),
    "/api/registry/*",
    "/api/packages/*",
  ];
  // Scoped to the registry's paths: mounted at gitmatrix's root, a `*`
  // middleware would sandbox the web app too.
  for (const scope of scopes) app.use(scope, middleware);
  async function middleware(c: Context<AppEnv>, next: Next) {
    const services = new Services(c.env, c.req.raw, waitUntilOf(c));
    c.set("services", services);
    const limiter = Reflect.get(c.env, "ANON_LIMITER") as RateLimit | undefined;
    const anonymous =
      !c.req.header("authorization") &&
      !c.req.header("x-api-key") &&
      !c.req.header("x-jfrog-art-api");
    if (limiter && anonymous) {
      const { success } = await limiter.limit({
        key: c.req.header("cf-connecting-ip") ?? "unknown",
      });
      if (!success) {
        return c.text("Too many anonymous requests; authenticate or slow down.\n", 429, {
          "retry-after": "60",
        });
      }
    }
    // The publish gate and provenance read the request from here.
    await withServices(services, () => next());
    // Artifacts are untrusted content on a host that must never run their scripts.
    c.res.headers.set("x-content-type-options", "nosniff");
    if (!c.res.headers.has("content-security-policy")) {
      c.res.headers.set("content-security-policy", "default-src 'none'; sandbox");
    }
    c.res.headers.set("x-request-id", services.requestId);
  }

  for (const format of registeredFormats()) {
    format.routes.onError((error, c) => format.renderError(asRegistryError(error), c));
    const mount = format.id === "oci" ? "/v2" : `/${FORMATS[format.id].prefix}/:repo`;
    app.route(mount, format.routes);
    if (format.apiRoutes) {
      format.apiRoutes.onError((error, c) => format.renderError(asRegistryError(error), c));
      app.route(`/api/registry/${format.id}`, format.apiRoutes);
    }
  }

  app.route("/api/packages", packagesApi());

  return app;
}
