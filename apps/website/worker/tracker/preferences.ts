// A person's defaults for each tracker they use (CORE-119): team, layout and
// issue view, on the server so they follow them across browsers and devices.

import { sql } from "kysely";
import { TRACKER_LAYOUTS, type TrackerPreferences } from "../../shared/tracker.ts";
import { db, nowIso } from "../schema.ts";
import { parseQuery } from "../../shared/tracker-query.ts";

export async function preferencesFor(
  d1: D1Database,
  userId: string,
  spaceId: string,
): Promise<TrackerPreferences | null> {
  const row = await db(d1)
    .selectFrom("tracker_preferences")
    .selectAll()
    .where("user_id", "=", userId)
    .where("space_id", "=", spaceId)
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
export async function defaultSpace(d1: D1Database, userId: string): Promise<string | null> {
  const row = await db(d1)
    .selectFrom("tracker_preferences")
    .select("space_id")
    .where("user_id", "=", userId)
    .orderBy("updated_at", "desc")
    .executeTakeFirst();
  if (row) return row.space_id;
  const personal = await db(d1)
    .selectFrom("organizations")
    .select("default_space_id")
    .where("personal_account_id", "=", userId)
    .executeTakeFirst();
  return personal?.default_space_id ?? null;
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
  try {
    parseQuery(query);
  } catch (error) {
    return error instanceof Error ? error.message : "Invalid tracker query.";
  }
  return { teamId, view: view as TrackerPreferences["view"], query };
}

export async function savePreferences(
  d1: D1Database,
  userId: string,
  spaceId: string,
  preferences: Omit<TrackerPreferences, "updatedAt">,
): Promise<TrackerPreferences> {
  const now = nowIso();
  // Allocate chronology inside the write, not in a separate read: simultaneous
  // saves (or a clock moving backwards) must still select the last saved tracker.
  const updatedAt = sql<string>`(
    select max(${now}, coalesce(
      strftime('%Y-%m-%dT%H:%M:%fZ', max(updated_at), '+0.001 seconds'), ${now}
    ))
    from tracker_preferences where user_id = ${userId}
  )`;
  const row = await db(d1)
    .insertInto("tracker_preferences")
    .values({
      user_id: userId,
      space_id: spaceId,
      team_id: preferences.teamId,
      view: preferences.view,
      query: preferences.query,
      updated_at: updatedAt,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "space_id"]).doUpdateSet((eb) => ({
        team_id: preferences.teamId,
        view: preferences.view,
        query: preferences.query,
        updated_at: eb.ref("excluded.updated_at"),
      })),
    )
    .returning("updated_at")
    .executeTakeFirstOrThrow();
  return { ...preferences, updatedAt: row.updated_at };
}

export async function clearPreferences(d1: D1Database, userId: string, spaceId: string) {
  await db(d1)
    .deleteFrom("tracker_preferences")
    .where("user_id", "=", userId)
    .where("space_id", "=", spaceId)
    .execute();
}
