// Current Space grants, person and agent identity are re-resolved at every boundary.

import { avatarUrl } from "../avatars/api.ts";
import { chunk } from "../knowledge/util.ts";
import type { AccountRow, Actor } from "../db.ts";
import type { SpaceAccess, SpaceSummary } from "../../shared/spaces.ts";
import { resolveSpaceAccess } from "../spaces/access.ts";
import { TrackerError } from "./store.ts";
import { db as gitmatrixDb } from "../schema.ts";
import type { TrackerAgent, TrackerIdentity } from "../../shared/tracker.ts";
import type { Access } from "./store.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import { timedCall, type Timing } from "../timing.ts";

export async function accessFor(
  env: Env,
  space: SpaceSummary,
  principalId: string,
  agentId: string | null,
  includeMembers = true,
  credential?: Actor["credential"],
  timing?: Timing,
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
  // Independent reads run together; their failures still decide in this order:
  // no current grant (403), then closed admission (409), then the member reads.
  const [grant, admission, listed] = await Promise.allSettled([
    resolveSpaceAccess(d1, actor, space.id),
    timedCall(timing, cutoverControl(env).admission(4)),
    includeMembers ? membersOf(d1, space.id) : Promise.resolve([]),
  ]);
  const current = settledValue(grant);
  if (!current)
    throw new TrackerError(
      403,
      "forbidden",
      "Tracker access requires a current explicit Space grant.",
    );
  const open = admitted(settledValue(admission));
  const identities = settledValue(listed);
  return {
    ...grantedAccess(current, open, credential),
    members: identities,
    agents: await agentsOf(d1, identities),
  };
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

/** The epoch an open content admission names; anything else refuses Tracker access. */
function admitted(admission: { allowed: boolean; epoch: number }): { epoch: number } {
  if (!admission.allowed || !Number.isSafeInteger(admission.epoch))
    throw new TrackerError(
      409,
      "migration_epoch_mismatch",
      "Space migration is not admitted. Refresh after maintenance.",
    );
  return admission;
}

function grantedAccess(
  current: SpaceAccess,
  admission: { epoch: number },
  credential: Actor["credential"],
): Access {
  const principalId = current.personId;
  const agentId = current.agent?.id ?? null;
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
    members: [],
    agents: [],
    repos: [],
  };
}

/**
 * The Access `accessFor(…, includeMembers = false)` builds, from a grant
 * listSpaceAccess already resolved for `actor` and this request's admission
 * read: no further D1 or control round trip per Space.
 */
export function accessFromGrant(
  current: SpaceAccess,
  admission: { allowed: boolean; epoch: number },
  credential: Actor["credential"],
): Access {
  return grantedAccess(current, admitted(admission), credential);
}

async function membersOf(d1: D1Database, spaceId: string): Promise<TrackerIdentity[]> {
  const members: AccountRow[] = await gitmatrixDb(d1)
    .selectFrom("accounts as a")
    .innerJoin("space_grants as g", "g.account_id", "a.id")
    .innerJoin("organization_members as m", (join) =>
      join.onRef("m.account_id", "=", "a.id").onRef("m.organization_id", "=", "g.organization_id"),
    )
    .selectAll("a")
    .where("g.space_id", "=", spaceId)
    .orderBy("a.slug")
    .execute();
  return members.map((m): TrackerIdentity => ({
    id: m.id,
    slug: m.slug,
    displayName: m.display_name,
    avatarUrl: avatarUrl(m.avatar_key),
  }));
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
