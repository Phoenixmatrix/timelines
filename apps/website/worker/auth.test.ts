import { Hono } from "hono";
import { describe, expect, test } from "vite-plus/test";
import { accounts } from "./api/accounts.ts";
import {
  endSession,
  hashToken,
  isActorCredentialLive,
  personaActor,
  sessionActor,
  startPersonaSession,
  tokenCredential,
  type AppEnv,
} from "./auth.ts";
import { authenticate } from "../registry/core/auth/authenticate.ts";
import { d1, migratedDatabase } from "./testing/d1.ts";
import type { Actor } from "./db.ts";

describe("production persona boundary", () => {
  for (const devMode of [undefined, "false"]) {
    test(`rejects persona impersonation with DEV_MODE ${devMode}`, async () => {
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", await sessionActor(c));
        await next();
      });
      app.route("/api", accounts);
      // These rejected requests must never reach storage; deliberately supply no DB.
      const env = { DEV_MODE: devMode } as Env;
      const headers = { cookie: "gm_persona=site-admin", "content-type": "application/json" };
      const session = await app.request("/api/session", { headers }, env);
      expect(session.status).toBe(200);
      expect(await session.json()).toEqual({ viewer: null });
      const login = await app.request(
        "/api/session",
        {
          method: "POST",
          headers,
          body: JSON.stringify({ accountId: "site-admin" }),
        },
        env,
      );
      expect(login.status).toBe(404);
      expect(login.headers.get("set-cookie")).toBeNull();
      expect((await app.request("/api/personas", { headers }, env)).status).toBe(404);
      const registryActor = await authenticate(env, new Headers(headers));
      expect(registryActor.kind).toBe("anonymous");
    });
  }
});

describe("durable initiating credential validation", () => {
  function setup() {
    const sqlite = migratedDatabase();
    sqlite.exec(`INSERT INTO accounts (id, kind, slug, display_name)
      VALUES ('person', 'user', 'person', 'Person'), ('other', 'user', 'other', 'Other');
      INSERT INTO agents (id, name, accountable_id) VALUES ('agent', 'Agent', 'person');
      INSERT INTO access_tokens (id, user_id, name, scope, token_hash, last_four, agent_id)
      VALUES ('token', 'person', 'Work', 'write', 'hash', 'hash', 'agent');`);
    const actor: Actor = {
      id: "person",
      slug: "person",
      displayName: "Person",
      isSiteAdmin: false,
      agent: { id: "agent", name: "Agent" },
      credential: { kind: "token", id: "token" },
    };
    return { sqlite, DB: d1(sqlite), actor };
  }

  test("requires a credential and exact live accountable agent binding", async () => {
    const { sqlite, DB, actor } = setup();
    expect(await isActorCredentialLive(DB, actor, "write")).toBe(true);
    expect(await isActorCredentialLive(DB, { ...actor, credential: undefined })).toBe(false);
    expect(await isActorCredentialLive(DB, { ...actor, agent: undefined })).toBe(false);
    expect(await isActorCredentialLive(DB, { ...actor, id: "other" })).toBe(false);
    sqlite.exec("UPDATE agents SET accountable_id = 'other'");
    expect(await isActorCredentialLive(DB, actor)).toBe(false);
    sqlite.exec("UPDATE agents SET accountable_id = 'person', revoked_at = CURRENT_TIMESTAMP");
    expect(await isActorCredentialLive(DB, actor)).toBe(false);
  });

  test("rechecks token scope, expiry and deletion without retaining authority", async () => {
    const { sqlite, DB, actor } = setup();
    expect(await isActorCredentialLive(DB, actor)).toBe(true);
    sqlite.exec("UPDATE access_tokens SET scope = 'read'");
    expect(await isActorCredentialLive(DB, actor, "write")).toBe(false);
    expect(await isActorCredentialLive(DB, actor, "read")).toBe(true);
    sqlite.exec("UPDATE access_tokens SET expires_at = '2000-01-01 00:00:00'");
    expect(await isActorCredentialLive(DB, actor)).toBe(false);
    sqlite.exec("DELETE FROM access_tokens");
    expect(await isActorCredentialLive(DB, actor)).toBe(false);
  });

  test("sessions bind the person and expiry and cannot carry agent attribution", async () => {
    const { sqlite, DB, actor } = setup();
    sqlite.exec(`INSERT INTO auth_users (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES ('person', 'Person', 'person@example.com', 1, '2026-01-01', '2026-01-01');
      INSERT INTO auth_sessions (id, token, userId, expiresAt, createdAt, updatedAt)
      VALUES ('session', 'opaque', 'person', '2999-01-01T00:00:00.000Z', '2026-01-01', '2026-01-01')`);
    const sessionActor: Actor = {
      ...actor,
      agent: undefined,
      credential: { kind: "session", id: "session" },
    };
    expect(await isActorCredentialLive(DB, sessionActor, "write")).toBe(true);
    expect(await isActorCredentialLive(DB, { ...sessionActor, agent: actor.agent })).toBe(false);
    expect(await isActorCredentialLive(DB, { ...sessionActor, id: "other" })).toBe(false);
    sqlite.exec("UPDATE auth_sessions SET expiresAt = '2000-01-01T00:00:00.000Z'");
    expect(await isActorCredentialLive(DB, sessionActor)).toBe(false);
    sqlite.exec("DELETE FROM auth_sessions");
    expect(await isActorCredentialLive(DB, sessionActor)).toBe(false);
  });

  test("token authentication propagates only the credential ID and rejects reassigned agents", async () => {
    const { sqlite, DB } = setup();
    const secret = "gmx_test";
    sqlite.prepare("UPDATE access_tokens SET token_hash = ?").run(await hashToken(secret));
    const app = new Hono<AppEnv>();
    app.get("/", async (c) => c.json(await tokenCredential(c)));
    const init = { headers: { authorization: `Bearer ${secret}` } };
    expect(await (await app.request("/", init, { DB } as Env)).json()).toMatchObject({
      kind: "token",
      actor: { id: "person", agent: { id: "agent" }, credential: { kind: "token", id: "token" } },
    });
    sqlite.exec("UPDATE agents SET accountable_id = 'other'");
    expect(await (await app.request("/", init, { DB } as Env)).json()).toEqual({ kind: "invalid" });
  });
});

describe("development persona credentials", () => {
  test("issues a persisted expiring credential and revokes it on logout", async () => {
    const sqlite = migratedDatabase();
    sqlite.exec(`INSERT INTO accounts (id, kind, slug, display_name)
      VALUES ('person', 'user', 'person', 'Person')`);
    const env = { DB: d1(sqlite), DEV_MODE: "true" } as Env;
    const app = new Hono<AppEnv>();
    app.post("/login", async (c) => {
      await startPersonaSession(c, "person");
      return c.json({ ok: true });
    });
    app.get("/actor", async (c) => c.json(await sessionActor(c)));
    app.post("/logout", async (c) => {
      await endSession(c);
      return c.json({ ok: true });
    });
    const login = await app.request("/login", { method: "POST" }, env);
    const cookie = login.headers
      .getSetCookie()
      .find((value) => value.startsWith("gm_persona=gmx_"))!
      .split(";")[0]!;
    const actor = (await (
      await app.request("/actor", { headers: { cookie } }, env)
    ).json()) as Actor;
    expect(actor).toMatchObject({ id: "person", credential: { kind: "token" } });
    expect(await isActorCredentialLive(env.DB, actor, "write")).toBe(true);
    expect(await personaActor(env, "person")).toBeNull();
    const production = { ...env };
    Reflect.deleteProperty(production, "DEV_MODE");
    expect(await personaActor(production, cookie.split("=")[1]!)).toBeNull();
    await app.request("/logout", { method: "POST", headers: { cookie } }, env);
    expect(await isActorCredentialLive(env.DB, actor)).toBe(false);
    expect(await (await app.request("/actor", { headers: { cookie } }, env)).json()).toBeNull();
    expect(sqlite.prepare("SELECT id FROM access_tokens").all()).toEqual([]);
  });
});
