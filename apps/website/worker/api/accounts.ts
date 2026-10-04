import { Hono } from "hono";
import { sql } from "kysely";
import type { AccountPage, Persona, SessionResponse } from "../../shared/api.ts";
import { endAllSessions, startPersonaSession, type AppEnv } from "../auth.ts";
import { accountSummary, findAccountBySlug, findUserById, viewerFor, visibleRepos } from "../db.ts";
import { db } from "../schema.ts";
import { createDb } from "../../registry/core/db.ts";
import { slugProblem } from "../names.ts";
import { canManageOrg } from "../avatars/api.ts";
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
  startPersonaSession(c, actor.id);
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

/**
 * Your own display name and username. The display name can always change.
 * The username is the root of your URLs; it can change while you own no
 * package feeds, whose keys and client URLs are built from it.
 */
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
    const feed = await createDb(c.env.REGISTRY_DB)
      .selectFrom("repositories")
      .select("key")
      .where("owner_id", "=", actor.id)
      .executeTakeFirst();
    if (feed)
      return fail(
        c,
        409,
        "You own package feeds, and their addresses are built from your username, so it can't change yet.",
      );
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
  if (!account) return fail(c, 404, "No such user or organization.");
  const members =
    account.kind === "org"
      ? (
          await db(c.env.DB)
            .selectFrom("accounts as a")
            .innerJoin("org_members as m", "m.user_id", "a.id")
            .selectAll("a")
            .select("m.role")
            .where("m.org_id", "=", account.id)
            .orderBy("m.role", "desc")
            .orderBy("a.slug")
            .execute()
        ).map((row) => ({ ...accountSummary(row), role: row.role }))
      : [];
  const actor = c.get("actor");
  const page: AccountPage = {
    ...accountSummary(account),
    bio: account.bio,
    repos: await visibleRepos(c.env.DB, actor, account.id),
    members,
    // People manage organizations; agents acting for them don't.
    viewerCanManage:
      account.kind === "org" && !!actor && !actor.agent
        ? await canManageOrg(c.env.DB, actor, account.id)
        : false,
  };
  return c.json(page);
});
