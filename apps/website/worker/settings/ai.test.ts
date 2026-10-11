import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  AI_LOG_BODIES_NOTE,
  AI_LOG_COMPONENTS,
  DEFAULT_AI_CONFIGURATION,
  type AiSettingsView,
  type SiteAiSettingsView,
} from "../../shared/ai.ts";
import { aiGatewayOptions } from "../ai-gateway.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { previewSettings, previewSettingsApi } from "../deployments/settings.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import {
  accountAiSnapshot,
  aiSettings,
  aiSettingsApi,
  knowledgeSchedule,
  repoAiSnapshot,
  siteAiSettingsApi,
} from "./ai.ts";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});

async function setup(bindings: Record<string, string> = {}) {
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
  const env = { DB: d1(sqlite), ...bindings } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/accounts/:slug/settings/ai", aiSettingsApi);
  app.route("/api/accounts/:slug/settings/previews", previewSettingsApi);
  app.route("/api/admin/ai", siteAiSettingsApi);
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
  const site = async (token: string | null, method = "GET", body?: unknown) =>
    app.request(
      "/api/admin/ai",
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
  return { env, sqlite, tokens, app, call, site };
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

  test.each(["clef-flash", "clef-omni"])(
    "%s round-trips as classification and resolves into new snapshots only",
    async (classification) => {
      const t = await setup();
      const original = await repoAiSnapshot(t.env.DB, "repo");
      expect(original.models.classification).toBe("@cf/cloudflare/clef");
      const saved = await t.call(t.tokens.owner, "PATCH", { models: { classification } });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        models: { ...DEFAULT_AI_CONFIGURATION.models, classification },
      });
      const read = (await (await t.call(t.tokens.member)).json()) as AiSettingsView;
      expect(read.models.classification).toBe(classification);
      expect(
        read.catalog.classification.find((option) => option.id === classification)?.model,
      ).toBe(`@cf/cloudflare/${classification}`);
      expect((await repoAiSnapshot(t.env.DB, "repo")).models.classification).toBe(
        `@cf/cloudflare/${classification}`,
      );
      expect((await repoAiSnapshot(t.env.DB, "sibling")).models.classification).toBe(
        `@cf/cloudflare/${classification}`,
      );
      expect(await repoAiSnapshot(t.env.DB, "personal")).toEqual(original);
      expect(original.models.classification).toBe("@cf/cloudflare/clef");
      for (const role of ["fast", "task"]) {
        const rejected = await t.call(t.tokens.owner, "PATCH", {
          models: { [role]: classification },
        });
        expect(rejected.status).toBe(400);
      }
      expect((await aiSettings(t.env.DB, "org")).models).toEqual({
        ...DEFAULT_AI_CONFIGURATION.models,
        classification,
      });
    },
  );

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

  test("release highlights cadence defaults daily and persists bounded account-owned partial updates", async () => {
    const t = await setup();
    const initial = await aiSettings(t.env.DB, "org");
    expect(initial.releaseHighlights).toEqual({ intervalHours: 24 });
    expect(await (await t.call(t.tokens.member)).json()).toMatchObject({
      releaseHighlights: { intervalHours: 24 },
    });
    for (const token of [t.tokens.member, t.tokens.agent]) {
      expect(
        (await t.call(token, "PATCH", { releaseHighlights: { intervalHours: 1 } })).status,
      ).toBe(403);
    }
    for (const intervalHours of [1, 168]) {
      const saved = await t.call(t.tokens.owner, "PATCH", { releaseHighlights: { intervalHours } });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        releaseHighlights: { intervalHours },
        features: initial.features,
        models: initial.models,
        knowledgeUpdates: initial.knowledgeUpdates,
        updatedBy: "ann",
        updatedAt: expect.any(String),
      });
      expect(await (await t.call(t.tokens.member)).json()).toMatchObject({
        releaseHighlights: { intervalHours },
      });
    }
    const before = await aiSettings(t.env.DB, "org");
    expect((await t.call(t.tokens.owner, "PATCH", { releaseHighlights: {} })).status).toBe(200);
    expect(await aiSettings(t.env.DB, "org")).toEqual(before);
    const responses = await Promise.all([
      t.call(t.tokens.owner, "PATCH", { releaseHighlights: { intervalHours: 12 } }),
      t.call(t.tokens.owner, "PATCH", { features: { releaseNotes: false } }),
      t.call(t.tokens.owner, "PATCH", { knowledgeUpdates: { quietMinutes: 7 } }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await aiSettings(t.env.DB, "org")).toMatchObject({
      releaseHighlights: { intervalHours: 12 },
      features: { releaseNotes: false },
      knowledgeUpdates: { quietMinutes: 7 },
    });
    expect((await aiSettings(t.env.DB, "owner")).releaseHighlights).toEqual({ intervalHours: 24 });
    expect(await accountAiSnapshot(t.env.DB, "org")).toEqual(
      await repoAiSnapshot(t.env.DB, "repo"),
    );
    expect(await accountAiSnapshot(t.env.DB, "owner")).toEqual(
      await repoAiSnapshot(t.env.DB, "personal"),
    );
    const snapshot = await accountAiSnapshot(t.env.DB, "org");
    await t.call(t.tokens.owner, "PATCH", { features: { releaseNotes: true } });
    expect(snapshot.features.releaseNotes).toBe(false);
    expect((await accountAiSnapshot(t.env.DB, "org")).features.releaseNotes).toBe(true);
    await expect(accountAiSnapshot(t.env.DB, "missing")).rejects.toThrow(/no such account/);
  });

  test.each(
    [
      null,
      [],
      false,
      24,
      { intervalHours: 0 },
      { intervalHours: -1 },
      { intervalHours: 169 },
      { intervalHours: 1.5 },
      { intervalHours: "24" },
      { intervalHours: null },
      { intervalHours: true },
      { hours: 24 },
      { constructor: 24 },
    ].map((releaseHighlights) => ({ releaseHighlights })),
  )("rejects malformed highlights cadence %# without writing", async ({ releaseHighlights }) => {
    const t = await setup();
    const response = await t.call(t.tokens.owner, "PATCH", { releaseHighlights });
    expect(response.status).toBe(400);
    expect(await response.json()).toHaveProperty("error");
    expect(t.sqlite.prepare("SELECT count(*) AS count FROM account_settings").get()).toMatchObject({
      count: 0,
    });
  });

  test("stored account cadence and viewer-scoped highlight keys obey migration constraints", async () => {
    const t = await setup();
    t.sqlite.exec("INSERT INTO account_settings (account_id) VALUES ('org')");
    expect((await aiSettings(t.env.DB, "org")).releaseHighlights).toEqual({ intervalHours: 24 });
    for (const hours of [0, 169]) {
      expect(() =>
        t.sqlite
          .prepare(
            "UPDATE account_settings SET release_highlights_interval_hours = ? WHERE account_id = 'org'",
          )
          .run(hours),
      ).toThrow();
    }
    const insert = t.sqlite.prepare(
      "INSERT INTO release_highlights (scope, scope_id, viewer_id, owner_account_id, source_hash, body, updated_at) VALUES ('repo', 'repo', ?, 'org', 'hash', '', '2026-10-11T00:00:00.000Z')",
    );
    insert.run("owner");
    insert.run("member");
    expect(() => insert.run("owner")).toThrow();
    expect(
      t.sqlite
        .prepare(
          "SELECT source_manifest, status, due_at, lease_until FROM release_highlights WHERE viewer_id = 'owner'",
        )
        .get(),
    ).toMatchObject({ source_manifest: "[]", status: "idle", due_at: 0, lease_until: 0 });
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

describe("gateway body logging settings (CORE-290)", () => {
  const effective = (view: {
    logBodies: { components: { component: string; effective: boolean }[] };
  }) => Object.fromEntries(view.logBodies.components.map((e) => [e.component, e.effective]));
  const all = (value: boolean) =>
    Object.fromEntries(AI_LOG_COMPONENTS.map((c) => [c.id, value])) as Record<string, boolean>;

  test("site defaults: site administrators only, and changing them takes a person", async () => {
    const t = await setup();
    const view = (await (await t.site(t.tokens.admin)).json()) as SiteAiSettingsView;
    expect(view).toMatchObject({
      canManage: true,
      logBodies: { environmentDefault: false, note: AI_LOG_BODIES_NOTE },
    });
    expect(view.logBodies.components.map((e) => e.component)).toEqual(
      AI_LOG_COMPONENTS.map((c) => c.id),
    );
    expect(view.logBodies.components.every((e) => e.siteFrom === "environment")).toBe(true);
    expect(effective(view)).toEqual(all(false));

    expect((await t.site(null)).status).toBe(401);
    for (const token of [t.tokens.owner, t.tokens.member, t.tokens.outsider, t.tokens.agent]) {
      expect((await t.site(token)).status).toBe(403);
      expect((await t.site(token, "PATCH", { logBodies: { knowledge: true } })).status).toBe(403);
    }
    // A site administrator's agent may read, not change.
    t.sqlite.exec(
      "INSERT INTO agents (id, name, accountable_id) VALUES ('agent2', 'ops', 'admin')",
    );
    const adminAgent = (await issueToken(t.env.DB, "admin", "agent2", "write", undefined, "agent"))
      .secret;
    expect(await (await t.site(adminAgent)).json()).toMatchObject({ canManage: false });
    expect((await t.site(adminAgent, "PATCH", { logBodies: { knowledge: true } })).status).toBe(
      403,
    );
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM site_ai_log_bodies").get()).toEqual({
      n: 0,
    });

    const changed = await t.site(t.tokens.admin, "PATCH", { logBodies: all(true) });
    expect(changed.status).toBe(200);
    const saved = (await changed.json()) as SiteAiSettingsView;
    expect(effective(saved)).toEqual(all(true));
    expect(saved.logBodies.components.every((e) => e.siteFrom === "site")).toBe(true);
    expect(t.sqlite.prepare("SELECT DISTINCT updated_by FROM site_ai_log_bodies").all()).toEqual([
      { updated_by: "admin" },
    ]);
    // Calls see it at once in this isolate, for every account without an override.
    expect(
      await aiGatewayOptions(t.env, "knowledge", { account: "org", feature: "knowledge" }),
    ).not.toHaveProperty("extraHeaders");
    // null goes back to the environment's default.
    const reset = (await (
      await t.site(t.tokens.admin, "PATCH", { logBodies: { knowledge: null } })
    ).json()) as SiteAiSettingsView;
    expect(reset.logBodies.components.find((e) => e.component === "knowledge")).toMatchObject({
      site: false,
      siteFrom: "environment",
      effective: false,
    });
    expect(
      (await aiGatewayOptions(t.env, "knowledge", { account: "org", feature: "knowledge" }))
        .extraHeaders,
    ).toEqual({ "cf-aig-collect-log-payload": "false" });
  });

  test.each(
    [
      null,
      [],
      { logBodies: true },
      { logBodies: { knowledge: "on" } },
      { logBodies: { knowledge: 1 } },
      { logBodies: { atlas: true } },
      { logBodies: { "assistant-title": true } },
      { other: {} },
    ].map((body) => ({ body })),
  )("rejects malformed log body settings %# without writing", async ({ body }) => {
    const t = await setup();
    for (const response of [
      await t.site(t.tokens.admin, "PATCH", body),
      await t.call(t.tokens.owner, "PATCH", body),
    ]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM site_ai_log_bodies").get()).toEqual({
      n: 0,
    });
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM account_ai_log_bodies").get()).toEqual({
      n: 0,
    });
  });

  test("account overrides: the account's administrators, and its calls follow them", async () => {
    const t = await setup({ AI_LOG_BODIES: "on" });
    const initial = (await (await t.call(t.tokens.member)).json()) as AiSettingsView;
    expect(initial.logBodies).toMatchObject({ environmentDefault: true, note: AI_LOG_BODIES_NOTE });
    expect(initial.logBodies.components.every((e) => e.account === null && e.site)).toBe(true);
    expect(effective(initial)).toEqual(all(true));

    // Members, agents and outsiders can't; the owner, the org owner and site admins can.
    expect(
      (await t.call(t.tokens.member, "PATCH", { logBodies: { assistant: false } })).status,
    ).toBe(403);
    expect(
      (await t.call(t.tokens.agent, "PATCH", { logBodies: { assistant: false } })).status,
    ).toBe(403);
    expect(
      (await t.call(t.tokens.outsider, "PATCH", { logBodies: { assistant: false } })).status,
    ).toBe(404);
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM account_ai_log_bodies").get()).toEqual({
      n: 0,
    });

    const off = await t.call(t.tokens.owner, "PATCH", { logBodies: { assistant: false } });
    expect(off.status).toBe(200);
    const view = (await off.json()) as AiSettingsView;
    expect(view.logBodies.components.find((e) => e.component === "assistant")).toMatchObject({
      site: true,
      account: false,
      effective: false,
    });
    expect(
      (await aiGatewayOptions(t.env, "assistant", { account: "org", feature: "assistant" }))
        .extraHeaders,
    ).toEqual({ "cf-aig-collect-log-payload": "false" });
    // Only that account's calls: Ann's own still keep bodies.
    expect(
      await aiGatewayOptions(t.env, "assistant", { account: "owner", feature: "assistant" }),
    ).not.toHaveProperty("extraHeaders");

    // The site turns it off everywhere; an account turns it back on for itself.
    await t.site(t.tokens.admin, "PATCH", { logBodies: { avatars: false } });
    expect(
      (await t.call(t.tokens.admin, "PATCH", { logBodies: { avatars: true } }, "ann")).status,
    ).toBe(200);
    expect(
      await aiGatewayOptions(t.env, "avatars", { account: "owner", feature: "avatars" }),
    ).not.toHaveProperty("extraHeaders");
    expect(
      (await aiGatewayOptions(t.env, "avatars", { account: "org", feature: "avatars" }))
        .extraHeaders,
    ).toEqual({ "cf-aig-collect-log-payload": "false" });

    // null removes the override: back to the site's default. Other AI settings are untouched.
    const back = (await (
      await t.call(t.tokens.owner, "PATCH", { logBodies: { assistant: null } })
    ).json()) as AiSettingsView;
    expect(back.logBodies.components.find((e) => e.component === "assistant")).toMatchObject({
      account: null,
      effective: true,
    });
    expect(back.updatedAt).toBeNull();
    expect(
      t.sqlite.prepare("SELECT account_id, component, keep FROM account_ai_log_bodies").all(),
    ).toEqual([{ account_id: "owner", component: "avatars", keep: 1 }]);
  });
});
