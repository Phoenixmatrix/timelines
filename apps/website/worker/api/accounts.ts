import { Hono } from "hono";
import { sql } from "kysely";
import type { AccountPage, Persona, SessionResponse } from "../../shared/api.ts";
import { endAllSessions, startPersonaSession, type AppEnv } from "../auth.ts";
import { accountSummary, findAccountBySlug, findUserById, viewerFor } from "../db.ts";
import { db } from "../schema.ts";
import { slugProblem } from "../names.ts";
import { fail, readJson, requireActor } from "./http.ts";

export const accounts = new Hono<AppEnv>();

accounts.get("/session", async (c) => {
  const actor = c.get("actor");
  const body: SessionResponse = { viewer: actor ? await viewerFor(c.env.DB, actor) : null };
  return c.json(body);
});

// DEVELOPMENT ONLY: sign in as any persona by id. Replaced by real auth later.
accounts.post("/session", async (c) => {
  if (c.env.DEV_MODE !== "true") return fail(c, 404, "Not found.");
  const { accountId } = await readJson<{ accountId: string }>(c);
  const actor = accountId ? await findUserById(c.env.DB, accountId) : null;
  if (!actor) return fail(c, 404, "No such persona.");
  await startPersonaSession(c, actor.id);
  const body: SessionResponse = { viewer: await viewerFor(c.env.DB, actor) };
  return c.json(body);
});

accounts.delete("/session", async (c) => {
  await endAllSessions(c);
  return c.body(null, 204);
});

accounts.get("/personas", async (c) => {
  if (c.env.DEV_MODE !== "true") return fail(c, 404, "Not found.");
  const results = await db(c.env.DB)
    .selectFrom("accounts")
    .selectAll()
    .where("kind", "=", "user")
    .orderBy(sql`rowid`)
    .execute();
  const personas: Persona[] = results.map((row) => ({
    ...accountSummary(row),
    bio: row.bio,
    isSiteAdmin: row.is_site_admin === 1,
  }));
  return c.json({ personas });
});

/** Person profile changes never rename immutable Organization or Space handles. */
accounts.patch("/account", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<{ displayName: string; slug: string }>(c);
  const changes: { display_name?: string; slug?: string } = {};
  if (body.displayName !== undefined) {
    const name = body.displayName.trim();
    if (!name || name.length > 80)
      return fail(c, 400, "Give a display name of up to 80 characters.");
    changes.display_name = name;
  }
  if (body.slug !== undefined && body.slug !== actor.slug) {
    const slug = body.slug.trim().toLowerCase();
    const problem = slugProblem(slug);
    if (problem) return fail(c, 400, problem);
    const taken = await db(c.env.DB)
      .selectFrom("accounts")
      .select("id")
      .where("slug", "=", slug)
      .where("id", "!=", actor.id)
      .executeTakeFirst();
    if (taken) return fail(c, 409, `"${slug}" is taken.`);
    changes.slug = slug;
  }
  if (changes.display_name || changes.slug) {
    await db(c.env.DB).updateTable("accounts").set(changes).where("id", "=", actor.id).execute();
    if (changes.display_name)
      await db(c.env.DB)
        .updateTable("auth_users")
        .set({ name: changes.display_name })
        .where("id", "=", actor.id)
        .execute();
  }
  const updated = await findUserById(c.env.DB, actor.id);
  const response: SessionResponse = { viewer: updated ? await viewerFor(c.env.DB, updated) : null };
  return c.json(response);
});

accounts.get("/users", async (c) => {
  const results = await db(c.env.DB)
    .selectFrom("accounts")
    .selectAll()
    .where("kind", "=", "user")
    .orderBy("slug")
    .execute();
  return c.json({ users: results.map(accountSummary) });
});

accounts.get("/accounts/:slug", async (c) => {
  const account = await findAccountBySlug(c.env.DB, c.req.param("slug"));
  if (!account || account.kind !== "user") return fail(c, 404, "No such person.");
  const personal = await c.env.DB.prepare(
    "SELECT id, default_space_id FROM organizations WHERE kind = 'personal' AND personal_account_id = ?",
  )
    .bind(account.id)
    .first<{ id: string; default_space_id: string }>();
  // Personal tenant locators are private profile shortcuts, not public content discovery.
  const self = c.get("actor")?.id === account.id;
  const page: AccountPage = {
    ...accountSummary(account),
    bio: account.bio,
    personalOrganizationId: self ? (personal?.id ?? null) : null,
    defaultSpaceId: self ? (personal?.default_space_id ?? null) : null,
  };
  return c.json(page);
});
