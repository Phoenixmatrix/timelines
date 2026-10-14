import {
  CONTENT_CONTRACT_VERSION,
  type SpaceAccess,
  type SpaceSummary,
} from "../../shared/spaces.ts";
import type { Actor } from "../db.ts";
import { avatarUrl } from "../avatars/api.ts";

interface SpaceRow {
  id: string;
  organization_id: string;
  slug: string;
  display_name: string;
  archived_at: string | null;
  authorization_version: number;
  created_at: string;
  organization_slug: string;
  organization_display_name: string;
  organization_kind: "company" | "personal";
  organization_avatar_key: string | null;
  personal_account_id: string | null;
  default_space_id: string;
  organization_created_at: string;
}
const SPACE_SELECT = `SELECT s.*, o.slug AS organization_slug,
  o.display_name AS organization_display_name, o.kind AS organization_kind,
  o.personal_account_id, o.default_space_id, o.created_at AS organization_created_at,
  o.avatar_key AS organization_avatar_key
  FROM spaces s JOIN organizations o ON o.id = s.organization_id`;
function summary(row: SpaceRow): SpaceSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    slug: row.slug,
    displayName: row.display_name,
    archivedAt: row.archived_at,
    authorizationVersion: row.authorization_version,
    createdAt: row.created_at,
    organization: {
      id: row.organization_id,
      slug: row.organization_slug,
      displayName: row.organization_display_name,
      kind: row.organization_kind,
      avatarUrl: avatarUrl(row.organization_avatar_key),
      personalAccountId: row.personal_account_id,
      defaultSpaceId: row.default_space_id,
      createdAt: row.organization_created_at,
    },
  };
}
/** Lookup is not authorization, including for an Organization owner. */
export async function findSpaceById(d1: D1Database, id: string): Promise<SpaceSummary | null> {
  const row = await d1.prepare(`${SPACE_SELECT} WHERE s.id = ?`).bind(id).first<SpaceRow>();
  return row ? summary(row) : null;
}
/** Every Space of one Organization, archived included. Lookup, not authorization. */
export async function listOrganizationSpaces(
  d1: D1Database,
  organizationId: string,
): Promise<SpaceSummary[]> {
  const { results } = await d1
    .prepare(`${SPACE_SELECT} WHERE s.organization_id = ?`)
    .bind(organizationId)
    .all<SpaceRow>();
  return results.map(summary);
}
export async function findSpaceBySlug(d1: D1Database, slug: string): Promise<SpaceSummary | null> {
  const row = await d1
    .prepare(`${SPACE_SELECT} WHERE s.slug = ? COLLATE NOCASE`)
    .bind(slug)
    .first<SpaceRow>();
  return row ? summary(row) : null;
}
type AccessRow = SpaceRow & {
  role: "admin" | "member";
  repository_role: "none" | "read" | "write";
  package_role: "none" | "read" | "write";
  origin: string;
  granted_at: string;
  granted_by: string;
  granted_by_agent_id: string | null;
  agent_name: string | null;
};
/** Live Space grants: a current Organization member's explicit grant on an active
 * Space, through an unrevoked agent when one acts. Callers narrow with `filter`. */
function accessQuery(d1: D1Database, actor: Actor, filter: string, ...values: unknown[]) {
  return d1
    .prepare(`SELECT s.*, o.slug AS organization_slug,
    o.display_name AS organization_display_name, o.kind AS organization_kind,
    o.personal_account_id, o.default_space_id, o.created_at AS organization_created_at,
    o.avatar_key AS organization_avatar_key,
    g.role, g.repository_role, g.package_role, g.origin, g.granted_at,
    g.granted_by, g.granted_by_agent_id, a.name AS agent_name
    FROM spaces s JOIN organizations o ON o.id = s.organization_id
    JOIN space_grants g ON g.space_id = s.id AND g.organization_id = s.organization_id
    JOIN organization_members m ON m.organization_id = s.organization_id AND m.account_id = g.account_id
    JOIN accounts p ON p.id = g.account_id AND p.kind = 'user'
    LEFT JOIN agents a ON a.id = ? AND a.accountable_id = p.id AND a.revoked_at IS NULL
    WHERE p.id = ? AND s.archived_at IS NULL
      AND (? IS NULL OR a.id IS NOT NULL) ${filter}`)
    .bind(actor.agent?.id ?? null, actor.id, actor.agent?.id ?? null, ...values);
}
function access(actor: Actor, row: AccessRow): SpaceAccess {
  return {
    space: summary(row),
    spaceId: row.id,
    personId: actor.id,
    ...(actor.agent ? { agent: { id: actor.agent.id, name: row.agent_name! } } : {}),
    authorizationVersion: row.authorization_version,
    contractVersion: CONTENT_CONTRACT_VERSION,
    grant: {
      spaceId: row.id,
      accountId: actor.id,
      role: row.role,
      repositoryRole: row.repository_role,
      packageRole: row.package_role,
      origin: row.origin,
      grantedAt: row.granted_at,
      grantedBy: row.granted_by,
      grantedByAgentId: row.granted_by_agent_id,
    },
  };
}
/** Current person/agent, membership and explicit grant in one database snapshot.
 * Credential expiry/scope is the caller's authentication boundary; no cached Actor
 * or Instance privilege can manufacture a Space grant here.
 */
export async function resolveSpaceAccess(
  d1: D1Database,
  actor: Actor | null,
  spaceId: string,
): Promise<SpaceAccess | null> {
  if (!actor) return null;
  const row = await accessQuery(d1, actor, "AND s.id = ?", spaceId).first<AccessRow>();
  return row ? access(actor, row) : null;
}
/** Every Space `resolveSpaceAccess` would admit, by Organization then Space handle,
 * in one query rather than one per Space; optionally within one Organization. */
export async function listSpaceAccess(
  d1: D1Database,
  actor: Actor,
  organizationId?: string,
): Promise<SpaceAccess[]> {
  const { results } = await (
    organizationId
      ? accessQuery(d1, actor, "AND s.organization_id = ? ORDER BY o.slug, s.slug", organizationId)
      : accessQuery(d1, actor, "ORDER BY o.slug, s.slug")
  ).all<AccessRow>();
  return results.map((row) => access(actor, row));
}
