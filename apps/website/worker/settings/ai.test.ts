import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { DEFAULT_AI_CONFIGURATION, type AiSettingsView } from "../../shared/ai.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { previewSettings, previewSettingsApi } from "../deployments/settings.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { aiSettings, aiSettingsApi, knowledgeSchedule, repoAiSnapshot } from "./ai.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

async function setup() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('owner', 'user', 'ann', 'Ann'), ('member', 'user', 'cat', 'Cat'),
      ('outsider', 'user', 'bob', 'Bob'), ('admin', 'user', 'admin', 'Admin'),
      ('org', 'org', 'orbit', 'Orbit');
    UPDATE accounts SET is_site_admin = 1 WHERE id = 'admin';
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('org', 'owner', 'owner'), ('org', 'member', 'member');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agent', 'builder', 'owner');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('repo', 'org', 'app', 'private', 'a', 'https://a'),
      ('sibling', 'org', 'site', 'private', 'b', 'https://b'),
      ('personal', 'owner', 'mine', 'private', 'c', 'https://c');
  `);
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/accounts/:slug/settings/ai", aiSettingsApi);
  app.route("/api/accounts/:slug/settings/previews", previewSettingsApi);
  const tokens = {
    owner: (await issueToken(env.DB, "owner", "owner", "write")).secret,
    member: (await issueToken(env.DB, "member", "member", "write")).secret,
    outsider: (await issueToken(env.DB, "outsider", "outsider", "write")).secret,
    admin: (await issueToken(env.DB, "admin", "admin", "write")).secret,
    agent: (await issueToken(env.DB, "owner", "agent", "write", undefined, "agent")).secret,
  };
  const call = async (
    token: string | null,
    method = "GET",
    body?: unknown,
    owner = "orbit",
    resource = "ai",
  ) =>
    app.request(
      `/api/accounts/${owner}/settings/${resource}`,
      {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  return { env, sqlite, tokens, app, call };
}

describe("account AI settings", () => {
  test("members read, only human owners and site admins manage, outsiders see no account", async () => {
    const t = await setup();
    const member = await t.call(t.tokens.member);
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({
      ...DEFAULT_AI_CONFIGURATION,
      canManage: false,
      updatedAt: null,
      updatedBy: null,
    });
    expect((await t.call(null)).status).toBe(401);
    expect((await t.call(t.tokens.outsider)).status).toBe(404);
    expect((await t.call(t.tokens.owner, "GET", undefined, "missing")).status).toBe(404);
    for (const token of [t.tokens.member, t.tokens.agent]) {
      const denied = await t.call(token, "PATCH", { features: { knowledge: false } });
      expect(denied.status).toBe(403);
      expect(await denied.json()).toHaveProperty("error");
    }
    expect(await (await t.call(t.tokens.agent)).json()).toMatchObject({ canManage: false });
    expect(
      (await t.call(t.tokens.outsider, "PATCH", { features: { knowledge: false } })).status,
    ).toBe(404);
    expect(
      (await t.call(t.tokens.owner, "PATCH", { features: { knowledge: false } }, "ann")).status,
    ).toBe(200);
    expect((await t.call(t.tokens.member, "GET", undefined, "ann")).status).toBe(404);
    const admin = await t.call(t.tokens.admin, "PATCH", { models: { task: "gemma-4-26b-a4b-it" } });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({
      canManage: true,
      models: { task: "gemma-4-26b-a4b-it" },
      updatedBy: "admin",
    });
    expect((await aiSettings(t.env.DB, "org")).features.knowledge).toBe(true);
  });

  test("settings resolve provider IDs for every repository owned by the account without rewriting snapshots", async () => {
    const t = await setup();
    const original = await repoAiSnapshot(t.env.DB, "repo");
    const changed = await t.call(t.tokens.owner, "PATCH", {
      features: { knowledge: false, wiki: true, atlas: false, releaseNotes: false },
      models: { classification: "clef", fast: "gemma-4-26b-a4b-it", task: "gemma-4-26b-a4b-it" },
    });
    expect(changed.status).toBe(200);
    const snapshot = await repoAiSnapshot(t.env.DB, "repo");
    expect(snapshot).toMatchObject({
      version: 1,
      features: { knowledge: false, wiki: true, atlas: false, releaseNotes: false },
      models: {
        classification: "@cf/cloudflare/clef",
        fast: "@cf/google/gemma-4-26b-a4b-it",
        task: "@cf/google/gemma-4-26b-a4b-it",
      },
    });
    expect(snapshot.updatedAt).toEqual(expect.any(String));
    expect(await repoAiSnapshot(t.env.DB, "sibling")).toEqual(snapshot);
    expect(await repoAiSnapshot(t.env.DB, "personal")).toEqual(original);
    expect(original.features.knowledge).toBe(true);
    expect(original.models.task).toBe("@cf/zai-org/glm-5.3-flash");
    await expect(repoAiSnapshot(t.env.DB, "missing")).rejects.toThrow(/no such repository/);
  });

  test.each(
    [
      null,
      [],
      "on",
      7,
      { knowledge: false },
      { features: null },
      { features: [] },
      { models: false },
      { features: { knowledge: "false" } },
      { features: { releaseNotes: 0 } },
      { features: { timeline: true } },
      { models: { route: "clef" } },
      { models: { classification: "jev" } },
      { models: { fast: "clef" } },
      { models: { task: "@cf/google/gemma-4-26b-a4b-it" } },
      { models: { task: null } },
      { models: { task: "gemma-3" } },
      { features: { __proto__: null, constructor: true } },
    ].map((body) => ({ body })),
  )("rejects malformed or non-curated configuration %# without writing", async ({ body }) => {
    const t = await setup();
    const response = await t.call(t.tokens.owner, "PATCH", body);
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    expect(t.sqlite.prepare("SELECT count(*) AS count FROM account_settings").get()).toMatchObject({
      count: 0,
    });
  });

  test("rejects malformed JSON and treats empty partial updates as no-ops", async () => {
    const t = await setup();
    const response = await t.app.request(
      "/api/accounts/orbit/settings/ai",
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${t.tokens.owner}`, "content-type": "application/json" },
        body: "{",
      },
      t.env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    for (const body of [{}, { features: {}, models: {} }]) {
      expect((await t.call(t.tokens.owner, "PATCH", body)).status).toBe(200);
    }
    expect(t.sqlite.prepare("SELECT count(*) AS count FROM account_settings").get()).toMatchObject({
      count: 0,
    });
  });

  test("concurrent partial writes retain unrelated AI fields, including first insertion", async () => {
    const t = await setup();
    const patches = [
      { features: { knowledge: false } },
      { features: { wiki: false } },
      { features: { atlas: false } },
      { features: { releaseNotes: false } },
      { models: { fast: "gemma-4-26b-a4b-it" } },
      { models: { task: "gemma-4-26b-a4b-it" } },
    ];
    const results = await Promise.all(
      patches.map((patch) => t.call(t.tokens.owner, "PATCH", patch)),
    );
    expect(results.map((response) => response.status)).toEqual(patches.map(() => 200));
    const saved = (await (await t.call(t.tokens.owner)).json()) as AiSettingsView;
    expect(saved.features).toEqual({
      knowledge: false,
      wiki: false,
      atlas: false,
      releaseNotes: false,
    });
    expect(saved.models).toEqual({
      classification: "clef",
      fast: "gemma-4-26b-a4b-it",
      task: "gemma-4-26b-a4b-it",
    });
    await t.call(t.tokens.owner, "PATCH", {
      features: { wiki: true },
      models: { task: "glm-5.3-flash" },
    });
    expect(await aiSettings(t.env.DB, "org")).toMatchObject({
      features: { ...saved.features, wiki: true },
      models: { ...saved.models, task: "glm-5.3-flash" },
    });
  });

  test("an account's first AI save does not invent preview provenance", async () => {
    const t = await setup();
    const preview = await previewSettings(t.env.DB, "org");
    await t.call(t.tokens.owner, "PATCH", { features: { knowledge: false } });
    expect(await previewSettings(t.env.DB, "org")).toEqual(preview);
    expect(await aiSettings(t.env.DB, "org")).toMatchObject({
      features: { knowledge: false },
      updatedBy: "ann",
    });
  });

  test("AI and preview updates retain independent values and provenance", async () => {
    const t = await setup();
    await t.call(t.tokens.owner, "PATCH", { endedDays: 8, idleDays: 19 }, "orbit", "previews");
    const preview = await previewSettings(t.env.DB, "org");
    expect(await aiSettings(t.env.DB, "org")).toMatchObject({ updatedAt: null, updatedBy: null });
    await t.call(t.tokens.admin, "PATCH", { features: { atlas: false } });
    expect(await previewSettings(t.env.DB, "org")).toEqual(preview);
    const ai = await aiSettings(t.env.DB, "org");
    await t.call(t.tokens.owner, "PATCH", { idleDays: 23 }, "orbit", "previews");
    expect(await aiSettings(t.env.DB, "org")).toEqual(ai);
    const concurrent = await Promise.all([
      t.call(t.tokens.admin, "PATCH", { features: { wiki: false } }),
      t.call(t.tokens.owner, "PATCH", { endedDays: 4 }, "orbit", "previews"),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    expect(await previewSettings(t.env.DB, "org")).toMatchObject({
      endedDays: 4,
      idleDays: 23,
      updatedBy: "ann",
    });
    expect(await aiSettings(t.env.DB, "org")).toMatchObject({
      features: { atlas: false, wiki: false },
      updatedBy: "admin",
    });
  });

  test("knowledge update windows (CORE-286): defaults, owners' choices, validation and the development override", async () => {
    const t = await setup();
    expect(await (await t.call(t.tokens.member)).json()).toMatchObject({
      knowledgeUpdates: { quietMinutes: 10, maxWaitMinutes: 30 },
    });
    expect(await knowledgeSchedule(t.env, "repo")).toEqual({
      quietMs: 10 * 60_000,
      maxWaitMs: 30 * 60_000,
    });
    for (const bad of [
      { knowledgeUpdates: { quietMinutes: -1 } },
      { knowledgeUpdates: { maxWaitMinutes: 1441 } },
      { knowledgeUpdates: { quietMinutes: 2.5 } },
      { knowledgeUpdates: { quietMinutes: "5" } },
      { knowledgeUpdates: { soon: 1 } },
      { knowledgeUpdates: 5 },
    ]) {
      const refused = await t.call(t.tokens.owner, "PATCH", bad);
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
    expect(
      (await t.call(t.tokens.member, "PATCH", { knowledgeUpdates: { quietMinutes: 1 } })).status,
    ).toBe(403);
    const saved = await t.call(t.tokens.owner, "PATCH", { knowledgeUpdates: { quietMinutes: 0 } });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      knowledgeUpdates: { quietMinutes: 0, maxWaitMinutes: 30 },
      // Other choices are untouched.
      features: DEFAULT_AI_CONFIGURATION.features,
    });
    expect(await knowledgeSchedule(t.env, "repo")).toEqual({ quietMs: 0, maxWaitMs: 30 * 60_000 });
    // Another account's repositories keep the defaults.
    expect((await knowledgeSchedule(t.env, "personal")).quietMs).toBe(10 * 60_000);
    // Development environments may shorten both.
    const dev = {
      ...t.env,
      KNOWLEDGE_QUIET_SECONDS: "2",
      KNOWLEDGE_MAX_WAIT_SECONDS: "8",
    } as unknown as Env;
    expect(await knowledgeSchedule(dev, "repo")).toEqual({ quietMs: 2_000, maxWaitMs: 8_000 });
  });
});
