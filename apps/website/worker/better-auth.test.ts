import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { authenticate } from "../registry/core/auth/authenticate.ts";
import {
  issueRegistryToken,
  resetRegistryTokenKeys,
} from "../registry/core/auth/registry-token.ts";
import { createAuth, linkAccount, mayJoin, recordFailure } from "./better-auth.ts";
import { issueToken } from "./api/tokens.ts";
import { authHygiene } from "./retention/cleanups/auth-hygiene.ts";
import { advanceRun, createRun, getRun } from "./retention/runs.ts";
import { createFreshSpaceTestEnvironment } from "./testing/spaces.ts";
import { cutoverControl } from "./durable/cutover-admission.ts";
import type { RetentionAuthority } from "./retention/runs.ts";

vi.mock("cloudflare:workers", () => import("./testing/runtime.ts"));

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});

async function setup({ org }: { org?: string } = {}) {
  const fresh = await createFreshSpaceTestEnvironment();
  cleanups.push(fresh.close);
  const { sqlite } = fresh;
  const sent: { to: string; text: string }[] = [];
  const failures = new Map<string, number>();
  const env = {
    ...fresh.env,
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
    const { env, sqlite } = await setup();
    expect(await mayJoin(env, " OWNER@example.com ")).toBe(true);
    expect(await mayJoin(env, "stranger@example.com")).toBe(false);
    sqlite.exec("INSERT INTO auth_invites (email) VALUES ('friend@example.com')");
    expect(await mayJoin(env, "Friend@Example.com")).toBe(true);
  });

  test("an uninvited address gets the same answer and no email", async () => {
    const { env, sent, rows } = await setup();
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

  test("the owner's first sign-in creates a person, personal Space and configured company", async () => {
    const { env, sent, rows } = await setup({ org: "matrixorg" });
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
    expect(rows("SELECT id FROM accounts WHERE kind = 'org'")).toEqual([]);
    const [personal] = rows(`SELECT * FROM organizations WHERE personal_account_id = '${userId}'`);
    expect(personal).toMatchObject({ kind: "personal", slug: "owner" });
    const [org] = rows("SELECT * FROM organizations WHERE slug = 'matrixorg'");
    expect(org?.kind).toBe("company");
    for (const tenant of [personal!, org!]) {
      expect(
        rows(
          `SELECT organization_id, archived_at FROM spaces WHERE id = '${String(tenant.default_space_id)}'`,
        ),
      ).toEqual([{ organization_id: tenant.id, archived_at: null }]);
      expect(
        rows(
          `SELECT role FROM organization_members WHERE organization_id = '${String(tenant.id)}' AND account_id = '${userId}'`,
        ),
      ).toEqual([{ role: "owner" }]);
      expect(
        rows(
          `SELECT role, repository_role, package_role FROM space_grants WHERE space_id = '${String(tenant.default_space_id)}' AND account_id = '${userId}'`,
        ),
      ).toEqual([{ role: "admin", repository_role: "write", package_role: "write" }]);
      expect(
        rows(
          `SELECT actor_id, action FROM space_audit WHERE organization_id = '${String(tenant.id)}'`,
        ),
      ).toEqual([{ actor_id: userId, action: "organization.bootstrap" }]);
      expect(tenant.default_space_id).not.toBe(userId);
    }
    expect(response.headers.get("set-cookie")).toContain("gm.session_token");
  });

  test("an invited person joins as a regular user with a free slug, using the invite up", async () => {
    const { env, sent, rows, sqlite } = await setup();
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
    const { env, rows, sqlite } = await setup();
    sqlite.exec(
      "INSERT INTO accounts (id, kind, slug, display_name, email, is_site_admin) VALUES ('acc_fward', 'user', 'fward', 'F', 'owner@example.com', 1)",
    );
    await linkAccount(env, { id: "acc_fward", email: "owner@example.com", name: "F" });
    expect(rows("SELECT id FROM accounts WHERE kind = 'user'")).toEqual([{ id: "acc_fward" }]);
  });

  test("a failed grant rolls back person, tenants and invite consumption together", async () => {
    const { env, rows, sqlite } = await setup({ org: "matrixorg" });
    sqlite.exec(`INSERT INTO auth_invites (email) VALUES ('owner@example.com');
      CREATE TRIGGER reject_bootstrap BEFORE INSERT ON space_grants
      BEGIN SELECT RAISE(ABORT, 'grant failed'); END;`);
    await expect(
      linkAccount(env, { id: "acc_retry", email: "owner@example.com", name: "Owner" }),
    ).rejects.toThrow("grant failed");
    for (const table of [
      "accounts",
      "organizations",
      "spaces",
      "organization_members",
      "space_grants",
      "space_audit",
    ])
      expect(rows(`SELECT * FROM ${table}`)).toEqual([]);
    expect(rows("SELECT email FROM auth_invites")).toEqual([{ email: "owner@example.com" }]);
    sqlite.exec("DROP TRIGGER reject_bootstrap");
    await linkAccount(env, { id: "acc_retry", email: "owner@example.com", name: "Owner" });
    expect(rows("SELECT id FROM accounts")).toEqual([{ id: "acc_retry" }]);
    expect(rows("SELECT * FROM organizations")).toHaveLength(2);
  });

  test("sign-in does not recreate a revoked explicit personal grant", async () => {
    const { env, rows, sqlite } = await setup();
    const user = { id: "acc_person", email: "owner@example.com", name: "Owner" };
    await linkAccount(env, user);
    sqlite.exec("DELETE FROM space_grants");
    await linkAccount(env, user);
    expect(rows("SELECT * FROM space_grants")).toEqual([]);
    expect(rows("SELECT * FROM space_audit")).toHaveLength(1);
  });

  test("personal handles avoid an existing Space without treating it as identity", async () => {
    const { env, rows, sqlite } = await setup();
    await linkAccount(env, { id: "acc_other", email: "other@example.com", name: "Other" });
    sqlite.exec("UPDATE accounts SET slug = 'renamed' WHERE id = 'acc_other'");
    await linkAccount(env, { id: "acc_new", email: "other@elsewhere.example", name: "New" });
    expect(rows("SELECT slug FROM accounts WHERE id = 'acc_new'")).toEqual([{ slug: "other-2" }]);
  });

  test("a later session retries an auth-only signup without replacing the person ID", async () => {
    const { env, sent, rows, sqlite } = await setup();
    sqlite.exec(`CREATE TRIGGER reject_bootstrap BEFORE INSERT ON space_grants
      BEGIN SELECT RAISE(ABORT, 'grant failed'); END;`);
    expect((await signIn(env, sent, "owner@example.com")).status).not.toBe(200);
    expect(rows("SELECT * FROM accounts")).toEqual([]);
    expect(rows("SELECT * FROM auth_sessions")).toEqual([]);
    const [authUser] = rows("SELECT id FROM auth_users");
    expect(authUser?.id).toMatch(/^acc_/);
    sqlite.exec("DROP TRIGGER reject_bootstrap");
    expect((await signIn(env, sent, "owner@example.com")).status).toBe(200);
    expect(rows("SELECT id FROM accounts")).toEqual([{ id: authUser!.id }]);
    expect(rows("SELECT personal_account_id FROM organizations")).toEqual([
      { personal_account_id: authUser!.id },
    ]);
  });
});

describe("failure lockout", () => {
  test("crossing the limiter locks the key out, and locked keys are refused", async () => {
    const { env, sent, rows } = await setup();
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
    const { env, rows } = await setup();
    for (let n = 0; n < 3; n++) await recordFailure(env, ["ip:1"]);
    expect(rows("SELECT * FROM auth_lockouts")).toHaveLength(0);
    await recordFailure(env, ["ip:1"]);
    expect(rows("SELECT key FROM auth_lockouts")).toEqual([{ key: "ip:1" }]);
  });
});

describe("the registry and an email sign-in", () => {
  test("the sign-in cookie alone identifies the user to the registry", async () => {
    const { env, sent, rows } = await setup();
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
    // Supplied but invalid credentials never silently become anonymous.
    await expect(
      authenticate(env, new Headers({ cookie: "gm.session_token=forged.value" })),
    ).rejects.toMatchObject({ status: 401 });
  });

  test("revoking a real session revokes its cookie and previously issued registry JWT", async () => {
    const { env, sent, sqlite } = await setup();
    env.REGISTRY_KEK = btoa("k".repeat(32));
    resetRegistryTokenKeys();
    const response = await signIn(env, sent, "owner@example.com");
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0]!)
      .find((value) => value.startsWith("gm.session_token="))!;
    const actor = await authenticate(env, new Headers({ cookie }));
    expect(actor.credential?.kind).toBe("session");
    const issued = await issueRegistryToken(env, actor, [], "gitmatrix.test");
    const headers = new Headers({ authorization: `Bearer ${issued.token}` });
    expect(await authenticate(env, headers)).toMatchObject({
      subject: actor.subject,
      via: "registry",
    });
    sqlite
      .prepare("DELETE FROM auth_sessions WHERE id = ?")
      .run(actor.credential?.kind === "session" ? actor.credential.id : "");
    await expect(authenticate(env, headers)).rejects.toMatchObject({ status: 401 });
    await expect(authenticate(env, new Headers({ cookie }))).rejects.toMatchObject({ status: 401 });
  });
});

describe("auth hygiene (CORE-206)", () => {
  const DAY = 86_400_000;
  /** A manual site run of "auth-hygiene" to the end, in batches of two. */
  async function hygiene(env: Env, dryRun: boolean, now: Date, authority: RetentionAuthority) {
    const id = await createRun(env.DB, {
      target: { kind: "instance", id: "" },
      trigger: "manual",
      actorId: authority.id,
      authority,
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
    const run = (await getRun(env.DB, { kind: "instance", id: "" }, id))!;
    expect(run.status).toBe("succeeded");
    return { seen: seen.sort(), items: run.items, bytes: run.bytes };
  }

  test("removes only what ended over 7 days ago; sign-in and tokens keep working", async () => {
    const { env, sent, rows, sqlite } = await setup();
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
    const person = sqlite
      .prepare("SELECT slug, display_name FROM accounts WHERE id = ?")
      .get(userId) as {
      slug: string;
      display_name: string;
    };
    const authority: RetentionAuthority = {
      id: userId,
      slug: person.slug,
      displayName: person.display_name,
      isSiteAdmin: true,
      credential: { kind: "token", id: live.id },
      migrationEpoch: (await cutoverControl(env).admission(4)).epoch,
    };
    const old = ["d_old", "ip:old", "n_old", "s_old", "tok_old", "v_old"];

    const dry = await hygiene(env, true, now, authority);
    expect(dry.seen).toEqual(old);
    expect(dry.items).toBe(6);
    const real = await hygiene(env, false, now, authority);
    expect(real).toEqual(dry);
    expect(await hygiene(env, false, now, authority)).toEqual({ seen: [], items: 0, bytes: 0 });
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
    const { env, sqlite } = await setup();
    const now = new Date();
    sqlite.exec(`
      INSERT INTO auth_lockouts (key, until) VALUES ('ip:a', '${new Date(now.getTime() + 60_000).toISOString()}');
    `);
    const ctx = {
      env,
      target: { kind: "instance", id: "" } as const,
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
