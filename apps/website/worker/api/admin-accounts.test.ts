import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import { sessionActor, tokenCredential } from "../auth.ts";
import { createAuth } from "../better-auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { adminAccounts } from "./admin-accounts.ts";
import { issueToken } from "./tokens.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const PASSWORD = "correct horse battery";

async function setup() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, is_site_admin, email) VALUES
      ('acc_admin', 'user', 'admin', 'Admin', 1, NULL),
      ('acc_member', 'user', 'member', 'Member', 0, NULL),
      ('acc_persona', 'user', 'persona', 'Persona', 0, 'persona@example.com');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_admin', 'admin-bot', 'acc_admin');
  `);
  const failures = new Map<string, number>();
  const sent: { to: string; text: string }[] = [];
  const env = {
    DB: d1(sqlite),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    PUBLIC_URL: "http://gitmatrix.test",
    OWNER_EMAIL: "owner@example.com",
    EMAIL_FROM: "timelines@mail.example.com",
    EMAIL: {
      send: async (message: { to: string; text: string }) => {
        sent.push(message);
        return { messageId: "m" };
      },
    },
    // Allows three failures per key, then refuses: a stand-in for the binding.
    AUTH_FAILURES: {
      limit: async ({ key }: { key: string }) => {
        const n = (failures.get(key) ?? 0) + 1;
        failures.set(key, n);
        return { success: n <= 3 };
      },
    },
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/admin/accounts", adminAccounts);
  // Who a browser's cookies identify to a read (auth.ts sessionActor).
  const viewer = new Hono<AppEnv>().get("/viewer", async (c) =>
    c.json({ id: (await sessionActor(c))?.id ?? null }),
  );
  const view = (cookie: string) => viewer.request("/viewer", { headers: { cookie } }, env);
  const tokens = {
    admin: (await issueToken(env.DB, "acc_admin", "admin", "write")).secret,
    member: (await issueToken(env.DB, "acc_member", "member", "write")).secret,
    agent: (await issueToken(env.DB, "acc_admin", "agent", "write", undefined, "agt_admin")).secret,
  };
  const call = (token: string | null, method: string, path: string, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  const identity = async (path: string, body: unknown, ip = "198.51.100.1") =>
    (await createAuth(env)).handler(
      new Request(`http://gitmatrix.test/api/identity${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://gitmatrix.test",
          "cf-connecting-ip": ip,
        },
        body: JSON.stringify(body),
      }),
    );
  const signIn = (email: string, password: string, ip?: string) =>
    identity("/sign-in/email", { email, password }, ip);
  const rows = (sql: string) => sqlite.prepare(sql).all() as Record<string, unknown>[];
  return { env, tokens, call, signIn, identity, rows, sent, view };
}

const demo = {
  username: "Demo-1",
  email: "Demo@Example.com",
  displayName: "Demo Person",
  password: PASSWORD,
};

describe("site admins create password accounts", () => {
  test("creates an unverified account that signs in by username or email", async () => {
    const { tokens, call, signIn, rows } = await setup();
    const created = await call(tokens.admin, "POST", "/admin/accounts", demo);
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      account: {
        username: "demo-1",
        email: "demo@example.com",
        displayName: "Demo Person",
        emailVerified: false,
        hasPassword: true,
      },
    });
    const [account] = rows("SELECT * FROM accounts WHERE slug = 'demo-1'");
    expect(account).toMatchObject({ kind: "user", is_site_admin: 0, email: "demo@example.com" });
    const id = String(account!.id);
    const [user] = rows(`SELECT * FROM auth_users WHERE id = '${id}'`);
    expect(user).toMatchObject({ email: "demo@example.com", emailVerified: 0 });
    const [credential] = rows(`SELECT * FROM auth_accounts WHERE userId = '${id}'`);
    expect(credential).toMatchObject({ providerId: "credential", accountId: id });
    expect(credential!.password).not.toContain(PASSWORD);

    for (const name of ["demo-1", "DEMO-1", "demo@example.com"]) {
      const response = await signIn(name, PASSWORD);
      expect(response.status, name).toBe(200);
      expect(response.headers.get("set-cookie")).toContain("gm.session_token");
    }
    expect(rows("SELECT userId FROM auth_sessions")).toHaveLength(3);
  });

  test("lists people with whether they have a password", async () => {
    const { tokens, call } = await setup();
    await call(tokens.admin, "POST", "/admin/accounts", demo);
    const response = await call(tokens.admin, "GET", "/admin/accounts");
    expect(await response.json()).toMatchObject({
      accounts: expect.arrayContaining([
        expect.objectContaining({ username: "demo-1", hasPassword: true, emailVerified: false }),
      ]),
    });
  });

  test("an invitation for the address is used up", async () => {
    const { tokens, call, rows, env } = await setup();
    await env.DB.prepare("INSERT INTO auth_invites (email) VALUES ('demo@example.com')").run();
    await call(tokens.admin, "POST", "/admin/accounts", demo);
    expect(rows("SELECT * FROM auth_invites")).toEqual([]);
  });

  test("only a person who is a site admin may create one", async () => {
    const { tokens, call, rows } = await setup();
    expect((await call(null, "POST", "/admin/accounts", demo)).status).toBe(401);
    expect((await call(tokens.member, "POST", "/admin/accounts", demo)).status).toBe(403);
    const agent = await call(tokens.agent, "POST", "/admin/accounts", demo);
    expect(agent.status).toBe(403);
    expect(await agent.json()).toMatchObject({ error: expect.stringMatching(/Agents can't/) });
    expect(rows("SELECT * FROM accounts WHERE slug = 'demo-1'")).toEqual([]);
  });

  test("refuses taken, reserved or malformed details", async () => {
    const { tokens, call } = await setup();
    for (const [change, status, message] of [
      [{ username: "member" }, 409, /username is taken/],
      [{ username: "settings" }, 400, /reserved/],
      [{ username: "-bad" }, 400, /lowercase letters/],
      [{ email: "persona@example.com" }, 409, /already has an account/],
      [{ email: "nope" }, 400, /email address/],
      // Better Auth refuses these at sign-in, so they'd never sign in.
      [{ email: "carol@demo.c" }, 400, /email address/],
      [{ email: "bob..x@example.com" }, 400, /email address/],
      [{ email: "Owner@Example.com" }, 400, /instance owner/],
      [{ password: "short" }, 400, /at least 12/],
      [{ password: "x".repeat(129) }, 400, /at most 128/],
      [{ displayName: "x".repeat(101) }, 400, /at most 100/],
    ] as const) {
      const response = await call(tokens.admin, "POST", "/admin/accounts", { ...demo, ...change });
      const label = JSON.stringify(change);
      expect(response.status, label).toBe(status);
      expect(await response.json(), label).toMatchObject({ error: expect.stringMatching(message) });
    }
  });
});

describe("password sign-in", () => {
  test("nobody signs themselves up with a password", async () => {
    const { identity, rows } = await setup();
    const response = await identity("/sign-up/email", {
      email: "owner@example.com",
      password: PASSWORD,
      name: "Owner",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(rows("SELECT * FROM auth_users")).toEqual([]);
  });

  test("a wrong password and an unknown username fail alike, then lock out", async () => {
    const { tokens, call, signIn } = await setup();
    await call(tokens.admin, "POST", "/admin/accounts", demo);
    const wrong = await signIn("demo-1", "not the password at all");
    const unknown = await signIn("nobody", PASSWORD, "198.51.100.2");
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    const code = async (r: Response) => ((await r.json()) as { code?: string }).code;
    expect(await code(wrong)).toBe(await code(unknown));

    await signIn("demo-1", "not the password at all", "198.51.100.3");
    await signIn("demo-1", "not the password at all", "198.51.100.4");
    await signIn("demo@example.com", "not the password at all", "198.51.100.6");
    // Locking an unknown username out reveals nothing either: its key is its
    // own, and the address it stands in for leads to a different one.
    for (const ip of ["198.51.100.20", "198.51.100.21", "198.51.100.22", "198.51.100.23"])
      await signIn("ghost", "not the password at all", ip);
    expect((await signIn("ghost@users.invalid", PASSWORD, "198.51.100.24")).status).toBe(401);
    expect((await signIn("ghost", PASSWORD, "198.51.100.25")).status).toBe(429);
    // The account's key (by username or email alike) is past three failures: even the right password waits.
    const locked = await signIn("demo@example.com", PASSWORD, "198.51.100.5");
    expect(locked.status).toBe(429);
  });
});

describe("an email nobody proved", () => {
  test("gets no sign-in code, and a guessed one keeps the password", async () => {
    const { tokens, call, identity, signIn, sent, rows } = await setup();
    await call(tokens.admin, "POST", "/admin/accounts", demo);
    const send = await identity("/email-otp/send-verification-otp", {
      email: demo.email,
      type: "sign-in",
    });
    expect(send.status).toBe(200);
    expect(sent).toEqual([]);
    const guess = await identity("/sign-in/email-otp", { email: demo.email, otp: "123456" });
    expect(guess.status).toBe(400);
    expect(((await guess.json()) as { code?: string }).code).toBe("INVALID_OTP");
    expect(rows("SELECT * FROM auth_accounts")).toHaveLength(1);
    expect((await signIn("demo-1", PASSWORD)).status).toBe(200);
  });

  test("no route resets a password, or changes or proves an email", async () => {
    const { tokens, call, identity, sent } = await setup();
    await call(tokens.admin, "POST", "/admin/accounts", demo);
    for (const path of [
      "/email-otp/request-password-reset",
      "/email-otp/reset-password",
      "/forget-password/email-otp",
      "/request-password-reset",
      "/reset-password",
      "/email-otp/verify-email",
      "/send-verification-email",
    ]) {
      const response = await identity(path, {
        email: "demo@example.com",
        otp: "123456",
        password: "an attacker's password",
        newPassword: "an attacker's password",
      });
      expect(response.status, path).toBe(404);
    }
    for (const type of ["forget-password", "email-verification", "change-email"]) {
      const response = await identity("/email-otp/send-verification-otp", {
        email: "demo@example.com",
        type,
      });
      expect(response.status, type).toBe(400);
    }
    expect(sent).toEqual([]);
  });
});

describe("site admins set a new password", () => {
  test("replaces the password and signs the account out everywhere", async () => {
    const { tokens, call, signIn, rows } = await setup();
    await call(tokens.admin, "POST", "/admin/accounts", demo);
    await signIn("demo-1", PASSWORD);
    const reset = await call(tokens.admin, "PUT", "/admin/accounts/demo-1/password", {
      password: "a brand new passphrase",
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ sessionsRevoked: 1, tokensRevoked: 0 });
    expect(rows("SELECT * FROM auth_sessions")).toEqual([]);
    expect(rows("SELECT * FROM auth_accounts WHERE providerId = 'credential'")).toHaveLength(1);
    expect((await signIn("demo-1", PASSWORD, "198.51.100.9")).status).toBe(401);
    expect((await signIn("demo-1", "a brand new passphrase")).status).toBe(200);
  });

  test("ends a browser's session at once, even within its signed cache's age", async () => {
    const { tokens, call, signIn, view, rows } = await setup();
    await call(tokens.admin, "POST", "/admin/accounts", demo);
    const signedIn = await signIn("demo-1", PASSWORD);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0]!)
      .join("; ");
    expect(cookie).toContain("gm.session_data=");
    const [{ id }] = rows("SELECT id FROM accounts WHERE slug = 'demo-1'") as [{ id: string }];
    expect(await (await view(cookie)).json()).toEqual({ id });
    const reset = await call(tokens.admin, "PUT", "/admin/accounts/demo-1/password", {
      password: "a brand new passphrase",
    });
    expect(await reset.json()).toEqual({ sessionsRevoked: 1, tokensRevoked: 0 });
    const after = await view(cookie);
    expect(await after.json()).toEqual({ id: null });
    expect(
      after.headers
        .getSetCookie()
        .some((value) => value.startsWith("gm.session_data=") && /max-age=0/i.test(value)),
    ).toBe(true);
  });

  test("revokes the account's access tokens only when asked", async () => {
    const { tokens, call, rows, env } = await setup();
    await call(tokens.admin, "POST", "/admin/accounts", demo);
    const [{ id }] = rows("SELECT id FROM accounts WHERE slug = 'demo-1'") as [{ id: string }];
    await issueToken(env.DB, id, "gm", "write");
    const path = "/admin/accounts/demo-1/password";
    const kept = await call(tokens.admin, "PUT", path, { password: "a brand new passphrase" });
    expect(await kept.json()).toMatchObject({ tokensRevoked: 0 });
    const revoked = await call(tokens.admin, "PUT", path, {
      password: "another new passphrase",
      revokeTokens: true,
    });
    expect(await revoked.json()).toMatchObject({ tokensRevoked: 1 });
    expect(rows(`SELECT * FROM access_tokens WHERE user_id = '${id}'`)).toEqual([]);
  });

  test("lists accounts that never signed in, when they have an email", async () => {
    const { tokens, call } = await setup();
    const { accounts } = (await (await call(tokens.admin, "GET", "/admin/accounts")).json()) as {
      accounts: { username: string; hasPassword: boolean; emailVerified: boolean }[];
    };
    expect(accounts.map((a) => a.username)).toEqual(["persona"]);
    expect(accounts[0]).toMatchObject({ hasPassword: false, emailVerified: false });
  });

  test("refuses an account whose email another account signs in with", async () => {
    const { tokens, call, env } = await setup();
    // Member signs in with the address the persona account holds.
    await env.DB.prepare(
      `INSERT INTO auth_users (id, name, email, createdAt, updatedAt)
       VALUES ('acc_member', 'Member', 'persona@example.com', 'now', 'now')`,
    ).run();
    const reset = await call(tokens.admin, "PUT", "/admin/accounts/persona/password", {
      password: PASSWORD,
    });
    expect(reset.status).toBe(409);
  });

  test("leaves the owner's account to their first emailed code", async () => {
    const { tokens, call, env } = await setup();
    await env.DB.prepare(
      "UPDATE accounts SET email = 'Owner@Example.com' WHERE slug = 'member'",
    ).run();
    const reset = await call(tokens.admin, "PUT", "/admin/accounts/member/password", {
      password: PASSWORD,
    });
    expect(reset.status).toBe(409);
    expect(await reset.json()).toMatchObject({ error: expect.stringMatching(/instance owner/) });
  });

  test("gives an account that never signed in a user to sign in as", async () => {
    const { tokens, call, signIn } = await setup();
    const reset = await call(tokens.admin, "PUT", "/admin/accounts/persona/password", {
      password: PASSWORD,
    });
    expect(reset.status).toBe(200);
    expect((await signIn("persona", PASSWORD)).status).toBe(200);
  });

  test("refuses accounts without an email, unknown accounts and agents", async () => {
    const { tokens, call } = await setup();
    const body = { password: PASSWORD };
    expect((await call(tokens.admin, "PUT", "/admin/accounts/member/password", body)).status).toBe(
      409,
    );
    expect((await call(tokens.admin, "PUT", "/admin/accounts/ghost/password", body)).status).toBe(
      404,
    );
    expect((await call(tokens.agent, "PUT", "/admin/accounts/member/password", body)).status).toBe(
      403,
    );
    expect(
      (await call(tokens.member, "PUT", "/admin/accounts/persona/password", body)).status,
    ).toBe(403);
  });
});
