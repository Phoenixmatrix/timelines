import { Hono } from "hono";
import { sql } from "kysely";
import type { AccountPage, Persona, SessionResponse } from "../../shared/api.ts";
import { endSession, startPersonaSession, type AppEnv } from "../auth.ts";
import { accountSummary, findAccountBySlug, findUserById, viewerFor, visibleRepos } from "../db.ts";
import { db } from "../schema.ts";
import { fail, readJson } from "./http.ts";

export const accounts = new Hono<AppEnv>();

accounts.get("/session", async (c) => {
  const actor = c.get("actor");
  const body: SessionResponse = { viewer: actor ? await viewerFor(c.env.DB, actor) : null };
  return c.json(body);
});

// DEVELOPMENT ONLY: sign in as any persona by id. Replaced by real auth later.
accounts.post("/session", async (c) => {
  const { accountId } = await readJson<{ accountId: string }>(c);
  const actor = accountId ? await findUserById(c.env.DB, accountId) : null;
  if (!actor) return fail(c, 404, "No such persona.");
  startPersonaSession(c, actor.id);
  const body: SessionResponse = { viewer: await viewerFor(c.env.DB, actor) };
  return c.json(body);
});

accounts.delete("/session", (c) => {
  endSession(c);
  return c.body(null, 204);
});

accounts.get("/personas", async (c) => {
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
  const page: AccountPage = {
    ...accountSummary(account),
    bio: account.bio,
    repos: await visibleRepos(c.env.DB, c.get("actor"), account.id),
    members,
  };
  return c.json(page);
});
