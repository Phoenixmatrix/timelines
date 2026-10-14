import type { Context, MiddlewareHandler } from "hono";
import { CONTENT_CONTRACT_HEADER, CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import type { AppEnv } from "../auth.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";

/** JSON content only; native Git/registry and person/credential APIs negotiate independently. */
export function isContentApiPath(path: string): boolean {
  return /^\/api\/(?:organizations|spaces|repos|tracker|packages|registry|search|refs|release-notes|ci)(?:\/|$)/.test(
    path,
  );
}

/** The cutover fence as this request sees it. The instance gate, the content gate and
 * every Space page a response lists share one read of the singleton control object per
 * contract version instead of a round trip each. Scoped to one request, never cached.
 */
export function requestAdmission(
  c: Context<AppEnv>,
  contractVersion: number = CONTENT_CONTRACT_VERSION,
): Promise<{ allowed: boolean; epoch: number }> {
  let admissions = c.get("admissions");
  if (!admissions) c.set("admissions", (admissions = new Map()));
  let admission = admissions.get(contractVersion);
  if (!admission) {
    admission = Promise.resolve(cutoverControl(c.env).admission(contractVersion));
    admissions.set(contractVersion, admission);
  }
  return admission;
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
  const admission = await requestAdmission(c);
  if (!admission.allowed)
    return c.json(
      { error: "Content is fenced for Organization/Space migration", code: "space_cutover_fenced" },
      503,
    );
  c.header(CONTENT_CONTRACT_HEADER, String(CONTENT_CONTRACT_VERSION));
  return next();
};
