// A person's defaults for each tracker they use (CORE-119): team, layout and
// issue view, on the server so they follow them across browsers and devices.

import { TRACKER_LAYOUTS, type TrackerPreferences } from "../../shared/tracker.ts";
import { db, nowIso } from "../schema.ts";

export async function preferencesFor(
  d1: D1Database,
  userId: string,
  ownerId: string,
): Promise<TrackerPreferences | null> {
  const row = await db(d1)
    .selectFrom("tracker_preferences")
    .selectAll()
    .where("user_id", "=", userId)
    .where("owner_id", "=", ownerId)
    .executeTakeFirst();
  return row
    ? {
        teamId: row.team_id,
        view: (TRACKER_LAYOUTS as readonly string[]).includes(row.view)
          ? (row.view as TrackerPreferences["view"])
          : "list",
        query: row.query,
        updatedAt: row.updated_at,
      }
    : null;
}

/** The tracker whose defaults the person saved most recently. */
export async function defaultOwner(d1: D1Database, userId: string): Promise<string | null> {
  const row = await db(d1)
    .selectFrom("tracker_preferences")
    .select("owner_id")
    .where("user_id", "=", userId)
    .orderBy("updated_at", "desc")
    .executeTakeFirst();
  return row?.owner_id ?? null;
}

/** A valid update from a request body, or the reason it isn't. */
export function parsePreferences(body: unknown): Omit<TrackerPreferences, "updatedAt"> | string {
  if (typeof body !== "object" || body === null) return "Send {teamId, view, query}.";
  const { teamId, view, query, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length) return `Unknown fields: ${Object.keys(rest).join(", ")}.`;
  if (teamId !== null && (typeof teamId !== "string" || !teamId || teamId.length > 100))
    return "teamId is a team's id, or null for all teams.";
  if (typeof view !== "string" || !(TRACKER_LAYOUTS as readonly string[]).includes(view))
    return `view is one of ${TRACKER_LAYOUTS.join(", ")}.`;
  if (typeof query !== "string" || query.length > 500)
    return "query is a string of at most 500 characters.";
  return { teamId, view: view as TrackerPreferences["view"], query };
}

export async function savePreferences(
  d1: D1Database,
  userId: string,
  ownerId: string,
  preferences: Omit<TrackerPreferences, "updatedAt">,
): Promise<TrackerPreferences> {
  const updatedAt = nowIso();
  await db(d1)
    .insertInto("tracker_preferences")
    .values({
      user_id: userId,
      owner_id: ownerId,
      team_id: preferences.teamId,
      view: preferences.view,
      query: preferences.query,
      updated_at: updatedAt,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "owner_id"]).doUpdateSet({
        team_id: preferences.teamId,
        view: preferences.view,
        query: preferences.query,
        updated_at: updatedAt,
      }),
    )
    .execute();
  return { ...preferences, updatedAt };
}

export async function clearPreferences(d1: D1Database, userId: string, ownerId: string) {
  await db(d1)
    .deleteFrom("tracker_preferences")
    .where("user_id", "=", userId)
    .where("owner_id", "=", ownerId)
    .execute();
}
