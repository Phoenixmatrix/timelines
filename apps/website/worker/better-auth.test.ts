import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, test } from "vite-plus/test";
import { authenticate } from "../registry/core/auth/authenticate.ts";
import { createAuth, linkAccount, mayJoin, recordFailure } from "./better-auth.ts";

/** Enough of D1 over node:sqlite for Kysely (kysely-d1) and Better Auth's D1 dialect. */
function d1(sqlite: DatabaseSync): D1Database {
  const statement = (sql: string, params: SQLInputValue[] = []) => {
    const run = () => {
      const prepared = sqlite.prepare(sql);
      const results = prepared.all(...params) as Record<string, unknown>[];
      const { c } = sqlite.prepare("SELECT changes() AS c").get() as { c: number };
      return { results, changes: c };
    };
    return {
      bind: (...next: SQLInputValue[]) => statement(sql, next),
      async all() {
        const { results, changes } = run();
        return { results, success: true, meta: { changes, last_row_id: 0, duration: 0 } };
      },
      async first(column?: string) {
        const row = run().results[0] ?? null;
        return column && row ? row[column] : row;
      },
      async run() {
        const { changes } = run();
        return { results: [], success: true, meta: { changes, last_row_id: 0, duration: 0 } };
      },
      async raw() {
        return run().results.map((row) => Object.values(row));
      },
    };
  };
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: { all(): Promise<unknown> }[]) =>
      Promise.all(statements.map((s) => s.all())),
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  } as unknown as D1Database;
}

function setup({ org }: { org?: string } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../migrations/", import.meta.url).href);
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(readFileSync(join(dir, file), "utf8"));
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
