import { describe, expect, test } from "vite-plus/test";
import { authenticate } from "../registry/core/auth/authenticate.ts";
import { createAuth, linkAccount, mayJoin, recordFailure } from "./better-auth.ts";
import { issueToken } from "./api/tokens.ts";
import { authHygiene } from "./retention/cleanups/auth-hygiene.ts";
import { advanceRun, createRun, getRun } from "./retention/runs.ts";
import { d1, migratedDatabase } from "./testing/d1.ts";

function setup({ org }: { org?: string } = {}) {
  const sqlite = migratedDatabase();
  const sent: { to: string; text: string }[] = [];
  const failures = new Map<string, number>();
  const env = {
    DB: d1(sqlite),
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    PUBLIC_URL: "http://gitmatrix.test",
    OWNER_EMAIL: "Owner@Example.com",
    ...(org ? { OWNER_ORG: org } : {}),
    EMAIL_FROM: "gitmatrix@mail.example.com",
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
  const rows = (sql: string) => sqlite.prepare(sql).all() as Record<string, unknown>[];
  return { env, sent, rows, sqlite };
}

const json = (body: unknown, ip = "198.51.100.1") => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: "http://gitmatrix.test",
    "cf-connecting-ip": ip,
  },
  body: JSON.stringify(body),
});

async function signIn(env: Env, sent: { to: string; text: string }[], email: string) {
  const auth = await createAuth(env);
  await auth.handler(
    new Request(
      "http://gitmatrix.test/api/identity/email-otp/send-verification-otp",
      json({ email, type: "sign-in" }),
    ),
  );
  const code = sent.at(-1)?.text.match(/\d{6}/)?.[0];
  return auth.handler(
    new Request(
      "http://gitmatrix.test/api/identity/sign-in/email-otp",
      json({ email, otp: code ?? "000000" }),
    ),
  );
}

describe("invite-only email sign-in", () => {
  test("only the owner, invited addresses and existing users may join", async () => {
    const { env, sqlite } = setup();
    expect(await mayJoin(env, " OWNER@example.com ")).toBe(true);
    expect(await mayJoin(env, "stranger@example.com")).toBe(false);
    sqlite.exec("INSERT INTO auth_invites (email) VALUES ('friend@example.com')");
    expect(await mayJoin(env, "Friend@Example.com")).toBe(true);
  });

  test("an uninvited address gets the same answer and no email", async () => {
    const { env, sent, rows } = setup();
    const response = await (
      await createAuth(env)
    ).handler(
      new Request(
        "http://gitmatrix.test/api/identity/email-otp/send-verification-otp",
        json({ email: "stranger@example.com", type: "sign-in" }),
      ),
    );
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
    expect(rows("SELECT * FROM auth_users")).toHaveLength(0);
  });

  test("the owner's first sign-in creates a superuser account and their org", async () => {
    const { env, sent, rows } = setup({ org: "matrixorg" });
    const response = await signIn(env, sent, "owner@example.com");
    expect(response.status).toBe(200);
    expect(sent[0]?.to).toBe("owner@example.com");
    const [user] = rows("SELECT id, email FROM auth_users");
    expect(user?.id).toMatch(/^acc_/);
    const userId = String(user!.id);
    const [account] = rows(`SELECT * FROM accounts WHERE id = '${userId}'`);
    expect(account).toMatchObject({
      kind: "user",
      slug: "owner",
      email: "owner@example.com",
      is_site_admin: 1,
    });
    const [org] = rows("SELECT id, kind FROM accounts WHERE slug = 'matrixorg'");
    expect(org?.kind).toBe("org");
    expect(
      rows(
        `SELECT role FROM org_members WHERE org_id = '${String(org!.id)}' AND user_id = '${userId}'`,
      ),
    ).toEqual([{ role: "owner" }]);
    expect(response.headers.get("set-cookie")).toContain("gm.session_token");
  });

  test("an invited person joins as a regular user with a free slug, using the invite up", async () => {
    const { env, sent, rows, sqlite } = setup();
    sqlite.exec(
      "INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_taken', 'user', 'friend', 'Someone else')",
    );
    sqlite.exec("INSERT INTO auth_invites (email) VALUES ('friend@example.com')");
    expect((await signIn(env, sent, "friend@example.com")).status).toBe(200);
    const [account] = rows(
      "SELECT slug, is_site_admin FROM accounts WHERE email = 'friend@example.com'",
    );
    expect(account).toEqual({ slug: "friend-2", is_site_admin: 0 });
    expect(rows("SELECT * FROM auth_invites")).toHaveLength(0);
    expect(rows("SELECT * FROM accounts WHERE kind = 'org'")).toHaveLength(0);
  });

  test("linking is idempotent for an account that already exists", async () => {
    const { env, rows, sqlite } = setup();
    sqlite.exec(
      "INSERT INTO accounts (id, kind, slug, display_name, email, is_site_admin) VALUES ('acc_fward', 'user', 'fward', 'F', 'owner@example.com', 1)",
    );
    await linkAccount(env, { id: "acc_fward", email: "owner@example.com", name: "F" });
    expect(rows("SELECT id FROM accounts WHERE kind = 'user'")).toEqual([{ id: "acc_fward" }]);
  });
});

describe("failure lockout", () => {
  test("crossing the limiter locks the key out, and locked keys are refused", async () => {
    const { env, sent, rows } = setup();
    await signIn(env, sent, "owner@example.com");
    const auth = await createAuth(env);
    const wrong = () =>
      auth.handler(
        new Request(
          "http://gitmatrix.test/api/identity/sign-in/email-otp",
          json({ email: "owner@example.com", otp: "000000" }, "203.0.113.9"),
        ),
      );
    for (let n = 0; n < 4; n++) await wrong();
    const locked = rows("SELECT key FROM auth_lockouts ORDER BY key").map((r) => r.key);
    expect(locked).toEqual(["email:owner@example.com", "ip:203.0.113.9"]);
    expect((await wrong()).status).toBe(429);
  });

  test("recordFailure only locks keys the limiter refuses", async () => {
    const { env, rows } = setup();
    for (let n = 0; n < 3; n++) await recordFailure(env, ["ip:1"]);
    expect(rows("SELECT * FROM auth_lockouts")).toHaveLength(0);
    await recordFailure(env, ["ip:1"]);
    expect(rows("SELECT key FROM auth_lockouts")).toEqual([{ key: "ip:1" }]);
  });
});

describe("the registry and an email sign-in", () => {
  test("the sign-in cookie alone identifies the user to the registry", async () => {
    const { env, sent, rows } = setup();
    const response = await signIn(env, sent, "owner@example.com");
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("gm.session_token="))!;
    const [account] = rows("SELECT id FROM accounts WHERE email = 'owner@example.com'");

    const actor = await authenticate(env, new Headers({ cookie }));
    expect(actor).toMatchObject({
      kind: "user",
      subject: account!.id,
      via: "session",
      isSiteAdmin: true,
    });
    // A cookie that isn't a live session is just a signed-out visitor.
    expect(
      await authenticate(env, new Headers({ cookie: "gm.session_token=forged.value" })),
    ).toMatchObject({ kind: "anonymous" });
  });
});

describe("auth hygiene (CORE-206)", () => {
  const DAY = 86_400_000;
  /** A manual site run of "auth-hygiene" to the end, in batches of two. */
  async function hygiene(env: Env, dryRun: boolean, now: Date) {
    const id = await createRun(env.DB, {
      target: { scope: "site" },
      trigger: "manual",
      actorId: null,
      dryRun,
      categories: [{ id: "auth-hygiene", thresholds: { days: 7 } }],
      now,
    });
    const seen: string[] = [];
    while (
      (await advanceRun(env, id, {
        now,
        limit: 2,
        afterBatch: (_c, items) =>
          void seen.push(...(items as { table: number; key: string }[]).map((i) => i.key)),
      })) === "more"
    );
    const run = (await getRun(env.DB, { scope: "site" }, id))!;
    expect(run.status).toBe("succeeded");
    return { seen: seen.sort(), items: run.items, bytes: run.bytes };
  }

  test("removes only what ended over 7 days ago; sign-in and tokens keep working", async () => {
    const { env, sent, rows, sqlite } = setup();
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() + days * DAY).toISOString();
    // A real sign-in: a live session, and the code it used.
    const first = await signIn(env, sent, "owner@example.com");
    const cookie = first.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .find((c) => c.startsWith("gm.session_token="))!;
    const [user] = rows("SELECT id FROM auth_users");
    const userId = String(user!.id);
    const live = await issueToken(env.DB, userId, "live", "write");
    const lasting = await issueToken(env.DB, userId, "session", "read", { expiresAt: at(3) });
    const [session] = rows("SELECT expiresAt FROM auth_sessions") as { expiresAt: string }[];
    // Better Auth stores ISO timestamps: string comparison is time order.
    expect(session!.expiresAt).toBe(new Date(session!.expiresAt).toISOString());
    sqlite.exec(`
      INSERT INTO auth_sessions (id, expiresAt, token, createdAt, updatedAt, userId) VALUES
        ('s_old', '${at(-30)}', 't_old', '${at(-60)}', '${at(-60)}', '${userId}'),
        ('s_recent', '${at(-2)}', 't_recent', '${at(-9)}', '${at(-9)}', '${userId}');
      INSERT INTO auth_verifications (id, identifier, value, expiresAt, createdAt, updatedAt) VALUES
        ('v_old', 'sign-in-otp-x', 'code', '${at(-8)}', '${at(-8)}', '${at(-8)}');
      INSERT INTO auth_device_codes (id, deviceCode, userCode, expiresAt, status) VALUES
        ('d_old', 'dc', 'UC', '${at(-10)}', 'pending'),
        ('d_live', 'dc2', 'UC2', '${at(1)}', 'pending');
      INSERT INTO auth_lockouts (key, until) VALUES
        ('ip:old', '${at(-20)}'), ('ip:active', '${at(0.01)}');
      INSERT INTO ssh_keys (id, user_id, title, key_type, public_key, fingerprint, scope)
        VALUES ('k1', '${userId}', 'laptop', 'ssh-ed25519', 'ssh-ed25519 AAAA', 'SHA256:x', 'read');
      INSERT INTO ssh_challenges (nonce, key_id, origin, expires_at) VALUES
        ('n_old', 'k1', 'http://gitmatrix.test', '${at(-7.5)}');
      INSERT INTO access_tokens (id, user_id, name, scope, token_hash, last_four, expires_at) VALUES
        ('tok_old', '${userId}', 'old', 'read', 'h_old', 'aaaa', '${at(-100)}'),
        ('tok_week', '${userId}', 'week', 'read', 'h_week', 'bbbb', '${at(-6)}');
    `);
    const old = ["d_old", "ip:old", "n_old", "s_old", "tok_old", "v_old"];

    const dry = await hygiene(env, true, now);
    expect(dry.seen).toEqual(old);
    expect(dry.items).toBe(6);
    const real = await hygiene(env, false, now);
    expect(real).toEqual(dry);
    expect(await hygiene(env, false, now)).toEqual({ seen: [], items: 0, bytes: 0 });
    expect(rows("SELECT id FROM auth_sessions WHERE id IN ('s_old', 's_recent')")).toEqual([
      { id: "s_recent" },
    ]);
    expect(rows("SELECT key FROM auth_lockouts")).toEqual([{ key: "ip:active" }]);
    expect(rows("SELECT id FROM auth_device_codes")).toEqual([{ id: "d_live" }]);
    expect(rows("SELECT id FROM access_tokens WHERE name <> 'live' AND name <> 'session'")).toEqual(
      [{ id: "tok_week" }],
    );

    // The live session, both live tokens and a fresh sign-in all still work.
    expect(await authenticate(env, new Headers({ cookie }))).toMatchObject({ via: "session" });
    for (const token of [live, lasting])
      expect(
        await authenticate(env, new Headers({ authorization: `Bearer ${token.secret}` })),
      ).toMatchObject({ via: "token", subject: userId });
    expect((await signIn(env, sent, "owner@example.com")).status).toBe(200);
    // The active lockout still refuses its key.
    sqlite.exec("UPDATE auth_lockouts SET key = 'ip:198.51.100.1'");
    expect((await signIn(env, sent, "owner@example.com")).status).toBe(429);
  });

  test("selects nothing still valid at any threshold", async () => {
    const { env, sqlite } = setup();
    const now = new Date();
    sqlite.exec(`
      INSERT INTO auth_lockouts (key, until) VALUES ('ip:a', '${new Date(now.getTime() + 60_000).toISOString()}');
    `);
    const ctx = {
      env,
      target: { scope: "site" } as const,
      thresholds: { days: 1 },
      now,
      limit: 100,
    };
    let cursor: string | null = null;
    const items: unknown[] = [];
    do {
      const selection = await authHygiene.select(ctx, cursor);
      items.push(...selection.items);
      cursor = selection.next;
    } while (cursor);
    expect(items).toEqual([]);
  });
});
