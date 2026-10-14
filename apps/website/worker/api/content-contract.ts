import type { Context, MiddlewareHandler } from "hono";
import { CONTENT_CONTRACT_HEADER, CONTENT_CONTRACT_VERSION } from "../../shared/spaces.ts";
import type { AppEnv } from "../auth.ts";
import { cachedAdmission, cutoverControl } from "../durable/cutover-admission.ts";
import type { Timing } from "../timing.ts";

/** JSON content only; native Git/registry and person/credential APIs negotiate independently. */
export function isContentApiPath(path: string): boolean {
  return /^\/api\/(?:organizations|spaces|repos|tracker|packages|registry|search|refs|release-notes|ci)(?:\/|$)/.test(
    path,
  );
}

/**
 * The cutover fence as this request sees it. The content gate and every Space page a
 * response lists share one read per contract version, kept in this request's context
 * only. The current contract comes from the isolate's verified admission, which the
 * fetch gate primes (cachedAdmission): a positive contract-4 read stays true, since
 * SpaceCutover.save refuses any write that would close it or move its epoch, and
 * denials are never cached. Without it (a preview, or an expired entry) this request
 * reads the control object itself. Other versions always read the control object.
 */
export function requestAdmission(
  c: Context<AppEnv>,
  contractVersion: number = CONTENT_CONTRACT_VERSION,
): Promise<{ allowed: boolean; epoch: number }> {
  let admissions = c.get("admissions");
  if (!admissions) c.set("admissions", (admissions = new Map()));
  let admission = admissions.get(contractVersion);
  if (!admission) {
    admission =
      contractVersion === CONTENT_CONTRACT_VERSION
        ? cachedAdmission(c.env, c.get("timing") as Timing | undefined)
        : Promise.resolve(cutoverControl(c.env).admission(contractVersion));
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
