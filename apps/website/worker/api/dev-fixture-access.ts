import type { SpaceSummary } from "../../shared/spaces.ts";
import { accessFor } from "../tracker/access.ts";
import { issueToken } from "./tokens.ts";

/** Named-dev callers mint real expiring credentials; no synthetic DO admission. */
export async function fixtureAccess(
  env: Env,
  space: SpaceSummary,
  personId: string,
  agentId: string | null = null,
) {
  const token = await issueToken(
    env.DB,
    personId,
    "development-fixture",
    "write",
    {
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    },
    agentId ?? undefined,
  );
  return accessFor(env, space, personId, agentId, true, { kind: "token", id: token.id });
}
