// Preview retention per Space. Explicit Space members may read; Space admins
// and the existing separate Instance operator may change the policy.
// Mounted at /api/spaces/:space/settings/previews.

import { Hono, type Context } from "hono";
import { DEFAULT_PREVIEW_SETTINGS, type PreviewSettings } from "../../shared/deployments.ts";
import { fail, readJson, requireActor, requirePerson } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import type { SpaceSummary } from "../../shared/spaces.ts";
import { findSpaceBySlug, resolveSpaceAccess } from "../spaces/access.ts";
import { db, nowIso } from "../schema.ts";

const ENDED_DAYS = { min: 0, max: 365 };
const IDLE_DAYS = { min: 1, max: 365 };

/** A Space's preview retention, with the defaults filled in. */
export async function previewSettings(d1: D1Database, spaceId: string): Promise<PreviewSettings> {
  const row = await db(d1)
    .selectFrom("space_settings as s")
    .leftJoin("accounts as a", "a.id", "s.updated_by")
    .select(["s.preview_ended_days", "s.preview_idle_days", "s.updated_at", "a.slug"])
    .where("s.space_id", "=", spaceId)
    .executeTakeFirst();
  if (!row) return { ...DEFAULT_PREVIEW_SETTINGS, updatedAt: null, updatedBy: null };
  return {
    endedDays: row.preview_ended_days,
    idleDays: row.preview_idle_days,
    updatedAt: row.updated_at,
    updatedBy: row.slug,
  };
}

/** Current explicit Space standing, with the existing separate operator power. */
export async function standing(
  d1: D1Database,
  space: SpaceSummary,
  actor: Actor,
): Promise<"none" | "member" | "admin"> {
  if (actor.isSiteAdmin) return "admin";
  return (await resolveSpaceAccess(d1, actor, space.id))?.grant.role ?? "none";
}

/** Resolve the immutable Space locator independently from its grants. */
export async function load(c: Context<AppEnv>, actor: Actor) {
  const space = await findSpaceBySlug(c.env.DB, c.req.param("space") ?? "");
  const role = space ? await standing(c.env.DB, space, actor) : "none";
  return space && role !== "none" ? { space, role } : null;
}

function days(value: unknown, name: string, range: { min: number; max: number }): number | string {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < range.min ||
    value > range.max
  )
    return `${name} must be a whole number of days from ${range.min} to ${range.max}.`;
  return value;
}

export const previewSettingsApi = new Hono<AppEnv>();

previewSettingsApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such Space, or you aren't a member.");
  return c.json<PreviewSettings>(await previewSettings(c.env.DB, found.space.id));
});

previewSettingsApi.patch("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such Space, or you aren't a member.");
  if (found.role !== "admin")
    return fail(c, 403, "Only Space admins can change its preview settings.");
  const body = await readJson<{ endedDays: unknown; idleDays: unknown }>(c);
  for (const key of Object.keys(body))
    if (key !== "endedDays" && key !== "idleDays") return fail(c, 400, `Unknown field: ${key}.`);
  const current = await previewSettings(c.env.DB, found.space.id);
  const ended =
    body.endedDays === undefined
      ? current.endedDays
      : days(body.endedDays, "endedDays", ENDED_DAYS);
  const idle =
    body.idleDays === undefined ? current.idleDays : days(body.idleDays, "idleDays", IDLE_DAYS);
  if (typeof ended === "string") return fail(c, 400, ended);
  if (typeof idle === "string") return fail(c, 400, idle);
  const values = {
    preview_ended_days: ended,
    preview_idle_days: idle,
    updated_by: actor.id,
    updated_at: nowIso(),
  };
  await db(c.env.DB)
    .insertInto("space_settings")
    .values({ space_id: found.space.id, ...values })
    .onConflict((oc) => oc.column("space_id").doUpdateSet(values))
    .execute();
  return c.json<PreviewSettings>(await previewSettings(c.env.DB, found.space.id));
});
