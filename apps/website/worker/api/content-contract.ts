import type { MiddlewareHandler } from "hono";
import { CONTENT_CONTRACT_HEADER, CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import type { AppEnv } from "../auth.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";

/** JSON content only; native Git/registry and person/credential APIs negotiate independently. */
export function isContentApiPath(path: string): boolean {
  return /^\/api\/(?:organizations|spaces|repos|tracker|packages|registry|search|refs|release-notes|ci)(?:\/|$)/.test(
    path,
  );
}

export const contentContractGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isContentApiPath(c.req.path)) return next();
  if (c.req.header(CONTENT_CONTRACT_HEADER) !== String(CONTENT_CONTRACT_VERSION)) {
    return c.json(
      {
        error: `Upgrade your client and send ${CONTENT_CONTRACT_HEADER}: ${CONTENT_CONTRACT_VERSION}.`,
        code: "client_upgrade_required",
        contractVersion: CONTENT_CONTRACT_VERSION,
      },
      426,
    );
  }
  const admission = await cutoverControl(c.env).admission(CONTENT_CONTRACT_VERSION);
  if (!admission.allowed)
    return c.json(
      { error: "Content is fenced for Organization/Space migration", code: "space_cutover_fenced" },
      503,
    );
  c.header(CONTENT_CONTRACT_HEADER, String(CONTENT_CONTRACT_VERSION));
  return next();
};
