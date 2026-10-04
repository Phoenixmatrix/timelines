// Preview retention per account (TIMELINES-RESEARCH.md, Decisions: previews
// are torn down 2 days after their timeline lands or is abandoned and after 7
// days without pushes; each org can change both). Stored here; CORE-79
// enforces them.
//
// Under /api/accounts/:slug/settings/previews:
//   GET    the account's numbers (its members, or the user themselves)
//   PATCH  {endedDays?, idleDays?} (org owners, or the user; people, not agents)

import { Hono, type Context } from "hono";
import { DEFAULT_PREVIEW_SETTINGS, type PreviewSettings } from "../../shared/deployments.ts";
import { fail, readJson, requireActor, requirePerson } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import { findAccountBySlug, type AccountRow, type Actor } from "../db.ts";
import { db, nowIso } from "../schema.ts";

const ENDED_DAYS = { min: 0, max: 365 };
const IDLE_DAYS = { min: 1, max: 365 };

/** An account's preview retention, with the defaults filled in. */
export async function previewSettings(d1: D1Database, accountId: string): Promise<PreviewSettings> {
  const row = await db(d1)
    .selectFrom("account_settings as s")
    .leftJoin("accounts as a", "a.id", "s.updated_by")
    .select(["s.preview_ended_days", "s.preview_idle_days", "s.updated_at", "a.slug"])
    .where("s.account_id", "=", accountId)
    .executeTakeFirst();
  if (!row) return { ...DEFAULT_PREVIEW_SETTINGS, updatedAt: null, updatedBy: null };
  return {
    endedDays: row.preview_ended_days,
    idleDays: row.preview_idle_days,
    updatedAt: row.updated_at,
    updatedBy: row.slug,
  };
}

/** The viewer's standing in an account: none, a member, or one who may change its settings. */
export async function standing(
  d1: D1Database,
  account: AccountRow,
  actor: Actor,
): Promise<"none" | "member" | "admin"> {
  if (actor.isSiteAdmin) return "admin";
  if (account.kind === "user") return account.id === actor.id ? "admin" : "none";
  const membership = await db(d1)
    .selectFrom("org_members")
    .select("role")
    .where("org_id", "=", account.id)
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  if (!membership) return "none";
  return membership.role === "owner" ? "admin" : "member";
}

/** The route's account (`:slug`) and the viewer's standing; null when they aren't a member. */
export async function load(c: Context<AppEnv>, actor: Actor) {
  const account = await findAccountBySlug(c.env.DB, c.req.param("slug") ?? "");
  const role = account ? await standing(c.env.DB, account, actor) : "none";
  return account && role !== "none" ? { account, role } : null;
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
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  return c.json<PreviewSettings>(await previewSettings(c.env.DB, found.account.id));
});

previewSettingsApi.patch("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  if (found.role !== "admin")
    return fail(c, 403, "Only the organization's owners can change its preview settings.");
  const body = await readJson<{ endedDays: unknown; idleDays: unknown }>(c);
  for (const key of Object.keys(body))
    if (key !== "endedDays" && key !== "idleDays") return fail(c, 400, `Unknown field: ${key}.`);
  const current = await previewSettings(c.env.DB, found.account.id);
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
    .insertInto("account_settings")
    .values({ account_id: found.account.id, ...values })
    .onConflict((oc) => oc.column("account_id").doUpdateSet(values))
    .execute();
  return c.json<PreviewSettings>(await previewSettings(c.env.DB, found.account.id));
});
