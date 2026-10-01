import type { FormatId } from "@gitmatrix/formats/info";
import type { Hono } from "hono";

import type { AppContext, AppEnv, Services } from "../core/context.ts";
import type { RegistryError } from "../core/errors.ts";
import type { Repository } from "../core/repos.ts";

/**
 * One package ecosystem. Each module owns its routes (mounted under
 * `/<prefix>/:repo`, or `/v2` for OCI), renders errors in its wire format, and
 * may regenerate derived index files when its repository's RepoDO asks.
 */
export interface FormatModule {
  id: FormatId;
  routes: Hono<AppEnv>;
  /** Wire-format error response, including the right WWW-Authenticate challenge. */
  renderError(error: RegistryError, c: AppContext): Response;
  /** Regenerates derived indexes; runs inside the repository's RepoDO. */
  rebuild?(services: Services, repo: Repository): Promise<void>;
  /** Extra REST routes, mounted at `/api/registry/<id>` (e.g. the releases API). */
  apiRoutes?: Hono<AppEnv>;
  /** Serialized mutations; run inside the repository's RepoDO. */
  mutations?: Record<
    string,
    (services: Services, repo: Repository, payload: unknown) => Promise<unknown>
  >;
}
