// Password accounts (CORE-404): a site admin creates an account outright, with
// a username, an email nobody verifies and a password, for people who can't
// set one up themselves yet or for demos with made-up addresses. Sign-up stays
// invite only; this is the one way in without an invitation. Admins also set a
// new password on an existing account, which ends its browser sessions (and,
// when asked, revokes its access tokens).
//
// The email is never proven, so no sign-in code is ever sent to it
// (mayJoin in worker/better-auth.ts): a made-up address could be someone's.
//
// Only a person may do either: an agent's token is refused, as for the other
// site settings that grant access.

import { hashPassword } from "better-auth/crypto";
import { sql } from "kysely";
import { Hono } from "hono";
import { z } from "zod";
import type { PasswordAccount } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import { MAX_PASSWORD, MIN_PASSWORD } from "../better-auth.ts";
import { slugProblem } from "../names.ts";
import { db } from "../schema.ts";
import { personStatements } from "../spaces/store.ts";
import { fail, readJson, requirePerson } from "./http.ts";

export const adminAccounts = new Hono<AppEnv>();

adminAccounts.use(async (c, next) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site admins create accounts.");
  await next();
});

// Better Auth's own check at sign-in: an address it refuses could never sign in.
const EMAIL = z.email();

function emailProblem(email: string): string | null {
  return email.length > 254 || !EMAIL.safeParse(email).success ? "Enter an email address." : null;
}

function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD)
    return `Use a password of at least ${MIN_PASSWORD} characters.`;
  if (password.length > MAX_PASSWORD)
    return `Use a password of at most ${MAX_PASSWORD} characters.`;
  return null;
}

adminAccounts.get("/", async (c) => {
  // Everyone who can sign in or be given a password: they have an email.
  const rows = await db(c.env.DB)
    .selectFrom("accounts as a")
    .leftJoin("auth_users as u", "u.id", "a.id")
    .leftJoin("auth_accounts as p", (join) =>
      join.onRef("p.userId", "=", "a.id").on("p.providerId", "=", "credential"),
    )
    .select([
      "a.slug",
      "a.display_name",
      sql<string>`coalesce(u.email, a.email)`.as("email"),
      "u.emailVerified",
      "p.password",
      sql<string>`coalesce(u.createdAt, a.created_at)`.as("createdAt"),
    ])
    .where("a.kind", "=", "user")
    .where((eb) => eb.or([eb("u.id", "is not", null), eb("a.email", "is not", null)]))
    .orderBy("createdAt", "desc")
    .limit(1000)
    .execute();
  const body: { accounts: PasswordAccount[] } = {
    accounts: rows.map((r) => ({
      username: r.slug,
      displayName: r.display_name,
      email: r.email,
      emailVerified: Boolean(r.emailVerified),
      hasPassword: Boolean(r.password),
      createdAt: r.createdAt,
    })),
  };
  return c.json(body);
});

adminAccounts.post("/", async (c) => {
  const input = await readJson<{
    username: string;
    email: string;
    displayName: string;
    password: string;
  }>(c);
  const username = typeof input.username === "string" ? input.username.trim().toLowerCase() : "";
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const displayName =
    (typeof input.displayName === "string" ? input.displayName.trim() : "") || username;
  const problem =
    slugProblem(username) ??
    emailProblem(email) ??
    (email === (Reflect.get(c.env, "OWNER_EMAIL") as string | undefined)?.trim().toLowerCase()
      ? "That's the instance owner's address; they sign in with an emailed code."
      : null) ??
    (displayName.length > 100 ? "Use a name of at most 100 characters." : null) ??
    passwordProblem(input.password);
  if (problem) return fail(c, 400, problem);

  // The personal Organization and its default Space take the same handle.
  const [slugTaken, emailTaken] = await Promise.all([
    db(c.env.DB)
      .selectFrom("accounts")
      .select("id")
      .where("slug", "=", username)
      .unionAll(db(c.env.DB).selectFrom("organizations").select("id").where("slug", "=", username))
      .unionAll(db(c.env.DB).selectFrom("spaces").select("id").where("slug", "=", username))
      .executeTakeFirst(),
    db(c.env.DB)
      .selectFrom("auth_users")
      .select("id")
      .where("email", "=", email)
      .unionAll(db(c.env.DB).selectFrom("accounts").select("id").where("email", "=", email))
      .executeTakeFirst(),
  ]);
  if (slugTaken) return fail(c, 409, "That username is taken.");
  if (emailTaken) return fail(c, 409, "That address already has an account.");

  // A Better Auth user's id is the account id (worker/better-auth.ts); the
  // password lives on its "credential" account, where sign-in looks for it.
  const id = `acc_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const hash = await hashPassword(input.password!);
  const DB = c.env.DB;
  try {
    await DB.batch([
      DB.prepare(
        `INSERT INTO auth_users (id, name, email, emailVerified, createdAt, updatedAt)
         VALUES (?1, ?2, ?3, 0, ?4, ?4)`,
      ).bind(id, displayName, email, now),
      // A person, never a bare Account: their private personal Organization
      // and default Space come with them, as with an invited sign-up.
      ...personStatements(DB, {
        id,
        slug: username,
        displayName,
        email,
        isSiteAdmin: false,
      }),
      DB.prepare(
        `INSERT INTO auth_accounts (id, accountId, providerId, userId, password, createdAt, updatedAt)
         VALUES (?1, ?2, 'credential', ?2, ?3, ?4, ?4)`,
      ).bind(crypto.randomUUID(), id, hash, now),
    ]);
  } catch (error) {
    // Lost a race for the username or address since the checks above.
    if (String(error).includes("UNIQUE")) return fail(c, 409, "That username or address is taken.");
    throw error;
  }
  const account: PasswordAccount = {
    username,
    displayName,
    email,
    emailVerified: false,
    hasPassword: true,
    createdAt: now,
  };
  return c.json({ account }, 201);
});

adminAccounts.put("/:username/password", async (c) => {
  const { password, revokeTokens } = await readJson<{ password: string; revokeTokens: boolean }>(c);
  const problem = passwordProblem(password);
  if (problem) return fail(c, 400, problem);
  const account = await db(c.env.DB)
    .selectFrom("accounts as a")
    .leftJoin("auth_users as u", "u.id", "a.id")
    .select(["a.id", "a.display_name", "a.email", "u.id as user_id"])
    .where("a.slug", "=", c.req.param("username").toLowerCase())
    .where("a.kind", "=", "user")
    .executeTakeFirst();
  if (!account) return fail(c, 404, "No such account.");
  if (!account.user_id) {
    if (!account.email || emailProblem(account.email))
      return fail(c, 409, "That account has no email to sign in with.");
    // The owner's first sign-in (by code) makes them a site admin; an
    // unproven user with their address would take that sign-in instead.
    if (
      account.email.toLowerCase() ===
      (Reflect.get(c.env, "OWNER_EMAIL") as string | undefined)?.trim().toLowerCase()
    )
      return fail(
        c,
        409,
        "That's the instance owner's account; they sign in with an emailed code first.",
      );
    const holder = await db(c.env.DB)
      .selectFrom("auth_users")
      .select("id")
      .where("email", "=", account.email)
      .executeTakeFirst();
    if (holder) return fail(c, 409, "Another account signs in with that account's email.");
  }

  const now = new Date().toISOString();
  const hash = await hashPassword(password!);
  const DB = c.env.DB;
  const results = await DB.batch([
    // Accounts made before sign-in existed (the dev personas) have no user yet.
    DB.prepare(
      `INSERT OR IGNORE INTO auth_users (id, name, email, emailVerified, createdAt, updatedAt)
       VALUES (?1, ?2, ?3, 0, ?4, ?4)`,
    ).bind(account.id, account.display_name, account.email, now),
    DB.prepare(`DELETE FROM auth_accounts WHERE userId = ? AND providerId = 'credential'`).bind(
      account.id,
    ),
    DB.prepare(
      `INSERT INTO auth_accounts (id, accountId, providerId, userId, password, createdAt, updatedAt)
       VALUES (?1, ?2, 'credential', ?2, ?3, ?4, ?4)`,
    ).bind(crypto.randomUUID(), account.id, hash, now),
    DB.prepare(`DELETE FROM auth_sessions WHERE userId = ?`).bind(account.id),
    // Their browsers' signed session caches stop counting at once
    // (auth.ts sessionActor reads D1 for a while after this).
    DB.prepare(`UPDATE accounts SET sessions_revoked_at = ? WHERE id = ?`).bind(
      Date.now(),
      account.id,
    ),
    // Tokens (gm, agents, any minted from a session) outlive sessions: a
    // leaked password's access ends only if the admin revokes them too.
    ...(revokeTokens === true
      ? [DB.prepare(`DELETE FROM access_tokens WHERE user_id = ?`).bind(account.id)]
      : []),
  ]);
  return c.json({
    sessionsRevoked: results[3]?.meta.changes ?? 0,
    tokensRevoked: results[5]?.meta.changes ?? 0,
  });
});
