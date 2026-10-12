// A tracker Access built from D1: by a request once it checked membership
// (api.ts authorize), or by the Worker finishing work on someone's behalf
// later, like a landing (timelines/landing.ts).

import { avatarUrl } from "../avatars/api.ts";
import { chunk } from "../knowledge/util.ts";
import type { AccountRow } from "../db.ts";
import { db as gitmatrixDb } from "../schema.ts";
import type { TrackerAgent, TrackerIdentity } from "../../shared/tracker.ts";
import type { Access } from "./store.ts";

/**
 * The tracker access of a person (or an agent acting for one), who is known
 * to be a member: what a request builds after checking, and what work the
 * Worker finishes later on someone's behalf (a landing, CORE-77) rebuilds.
 */
export async function accessFor(
  d1: D1Database,
  owner: AccountRow,
  principalId: string,
  agentId: string | null,
  canAdmin = false,
  includeMembers = true,
): Promise<Access> {
  const members: AccountRow[] = !includeMembers
    ? []
    : owner.kind === "user"
      ? [owner]
      : await gitmatrixDb(d1)
          .selectFrom("accounts as a")
          .innerJoin("org_members as m", "m.user_id", "a.id")
          .selectAll("a")
          .where("m.org_id", "=", owner.id)
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
    owner: { id: owner.id, slug: owner.slug, displayName: owner.display_name },
    canAdmin,
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
