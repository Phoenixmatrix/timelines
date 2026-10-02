// Invitations: sign-up is invite only (worker/better-auth.ts), so site admins
// list the addresses that may create an account. An invite is used up when
// that address first signs in.

import { Hono } from "hono";
import type { Invite } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import { db } from "../schema.ts";
import { fail, readJson, requireActor } from "./http.ts";

export const invites = new Hono<AppEnv>();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

invites.use(async (c, next) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site admins manage invitations.");
  await next();
});

invites.get("/", async (c) => {
  const rows = await db(c.env.DB)
    .selectFrom("auth_invites as i")
    .leftJoin("accounts as a", "a.id", "i.invited_by")
    .select(["i.email", "i.created_at", "a.slug as invited_by"])
    .orderBy("i.created_at", "desc")
    .execute();
  const body: { invites: Invite[] } = {
    invites: rows.map((r) => ({
      email: r.email,
      invitedBy: r.invited_by,
      createdAt: r.created_at,
    })),
  };
  return c.json(body);
});

invites.post("/", async (c) => {
  const { email } = await readJson<{ email: string }>(c);
  const address = email?.trim().toLowerCase() ?? "";
  if (!EMAIL.test(address) || address.length > 254) return fail(c, 400, "Enter an email address.");
  const member = await db(c.env.DB)
    .selectFrom("auth_users")
    .select("id")
    .where("email", "=", address)
    .executeTakeFirst();
  if (member) return fail(c, 409, "That address already has an account.");
  await db(c.env.DB)
    .insertInto("auth_invites")
    .values({ email: address, invited_by: c.get("actor")!.id })
    .onConflict((oc) => oc.doNothing())
    .execute();
  return c.body(null, 201);
});

invites.delete("/:email", async (c) => {
  await db(c.env.DB)
    .deleteFrom("auth_invites")
    .where("email", "=", decodeURIComponent(c.req.param("email")).toLowerCase())
    .execute();
  return c.body(null, 204);
});
