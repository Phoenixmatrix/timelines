// Current Space grants, person and agent identity are re-resolved at every boundary.

import { avatarUrl } from "../avatars/api.ts";
import { chunk } from "../knowledge/util.ts";
import type { AccountRow, Actor } from "../db.ts";
import type { SpaceSummary } from "../../shared/spaces.ts";
import { resolveSpaceAccess } from "../spaces/access.ts";
import { TrackerError } from "./store.ts";
import { db as gitmatrixDb } from "../schema.ts";
import type { TrackerAgent, TrackerIdentity } from "../../shared/tracker.ts";
import type { Access } from "./store.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";

export async function accessFor(
  env: Env,
  space: SpaceSummary,
  principalId: string,
  agentId: string | null,
  includeMembers = true,
  credential?: Actor["credential"],
): Promise<Access> {
  const d1 = env.DB;
  const actor: Actor = {
    id: principalId,
    slug: "",
    displayName: "",
    isSiteAdmin: false,
    ...(agentId ? { agent: { id: agentId, name: "" } } : {}),
    ...(credential ? { credential } : {}),
  };
  const current = await resolveSpaceAccess(d1, actor, space.id);
  if (!current)
    throw new TrackerError(
      403,
      "forbidden",
      "Tracker access requires a current explicit Space grant.",
    );
  const admission = await cutoverControl(env).admission(4);
  if (!admission.allowed || !Number.isSafeInteger(admission.epoch))
    throw new TrackerError(
      409,
      "migration_epoch_mismatch",
      "Space migration is not admitted. Refresh after maintenance.",
    );
  const members: AccountRow[] = !includeMembers
    ? []
    : await gitmatrixDb(d1)
        .selectFrom("accounts as a")
        .innerJoin("space_grants as g", "g.account_id", "a.id")
        .innerJoin("organization_members as m", (join) =>
          join
            .onRef("m.account_id", "=", "a.id")
            .onRef("m.organization_id", "=", "g.organization_id"),
        )
        .selectAll("a")
        .where("g.space_id", "=", space.id)
        .orderBy("a.slug")
        .execute();
  const identities = members.map((m): TrackerIdentity => ({
    id: m.id,
    slug: m.slug,
    displayName: m.display_name,
    avatarUrl: avatarUrl(m.avatar_key),
  }));
  return {
    // An agent's actions are its own; its human's memberships let it in.
    actorId: agentId ?? principalId,
    principalId,
    agentId,
    credential,
    spaceId: current.spaceId,
    space: current.space,
    contractVersion: 4,
    migrationEpoch: admission.epoch,
    authorizationVersion: current.authorizationVersion,
    canAdmin: current.grant.role === "admin",
    members: identities,
    agents: await agentsOf(d1, identities),
    repos: [],
  };
}
/** Every agent accountable to these members, revoked ones included so history still names them. */
async function agentsOf(d1: D1Database, members: TrackerIdentity[]): Promise<TrackerAgent[]> {
  if (!members.length) return [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const rows = await gitmatrixDb(d1)
    .selectFrom("agents")
    .select([
      "id",
      "name",
      "accountable_id",
      "capabilities",
      "capabilities_updated_at",
      "revoked_at",
    ])
    .where(
      "accountable_id",
      "in",
      members.map((m) => m.id),
    )
    .orderBy("name")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    accountable: byId.get(row.accountable_id)!,
    capabilities: row.capabilities === null ? null : JSON.parse(row.capabilities),
    capabilitiesUpdatedAt: row.capabilities_updated_at,
    revokedAt: row.revoked_at,
  }));
}

/** Ids per `IN (…)` lookup: well under D1's limit on bound parameters. */
export const LOOKUP_CHUNK = 50;

/**
 * The agents among `ids` (anything else is skipped): whom each answers to and
 * whether it was revoked, `size` ids per query. Approve-when-green asks this
 * of whoever asked an approval (CORE-378).
 */
export async function agentsAmong(
  d1: D1Database,
  ids: readonly string[],
  size = LOOKUP_CHUNK,
): Promise<{ id: string; accountable: { id: string }; revokedAt: string | null }[]> {
  const found: { id: string; accountable: { id: string }; revokedAt: string | null }[] = [];
  for (const part of chunk([...new Set(ids)], size))
    for (const row of await gitmatrixDb(d1)
      .selectFrom("agents")
      .select(["id", "accountable_id", "revoked_at"])
      .where("id", "in", part)
      .execute())
      found.push({
        id: row.id,
        accountable: { id: row.accountable_id },
        revokedAt: row.revoked_at,
      });
  return found;
}
