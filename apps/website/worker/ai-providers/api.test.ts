// An account's own AI providers (CORE-294): connecting a key, choosing
// models, using them in AI settings and in the snapshots jobs run with.

import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { AiProviderCatalogView, AiProvidersView, AiSettingsView } from "../../shared/ai.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { chatJson, decide } from "../knowledge/models.ts";
import { knowledgePolicy } from "../knowledge/policy.ts";
import { aiSettingsApi, repoAiSnapshot } from "../settings/ai.ts";
import { fakeProviders, isProviderUrl } from "../testing/ai-providers.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { aiWork } from "../usage/ai.ts";
import { aiProvidersApi } from "./api.ts";
import { forgetProviderCatalogs, openRouterEntry } from "./providers.ts";
import { parseProviderModelRef } from "./store.ts";

const databases: DatabaseSync[] = [];
let provider = fakeProviders();
beforeEach(() => {
  provider = fakeProviders();
  forgetProviderCatalogs();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    isProviderUrl(String(input instanceof Request ? input.url : input))
      ? provider.fetch(input, init)
      : real(input, init),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const sqlite of databases.splice(0)) sqlite.close();
});

async function setup() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('owner', 'user', 'ann', 'Ann'), ('member', 'user', 'cat', 'Cat'),
      ('outsider', 'user', 'bob', 'Bob'), ('org', 'org', 'orbit', 'Orbit');
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('org', 'owner', 'owner'), ('org', 'member', 'member');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agent', 'builder', 'owner');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('repo', 'org', 'app', 'private', 'a', 'https://a');
  `);
  const env = {
    DB: d1(sqlite),
    REGISTRY_KEK: btoa("k".repeat(32)),
    PUBLIC_URL: "https://gitmatrix.test",
  } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/accounts/:slug/settings/ai", aiSettingsApi);
  app.route("/api/accounts/:slug/ai-providers", aiProvidersApi);
  const tokens = {
    owner: (await issueToken(env.DB, "owner", "owner", "write")).secret,
    member: (await issueToken(env.DB, "member", "member", "write")).secret,
    outsider: (await issueToken(env.DB, "outsider", "outsider", "write")).secret,
    agent: (await issueToken(env.DB, "owner", "agent", "write", undefined, "agent")).secret,
  };
  const call = (token: string, method: string, path: string, body?: unknown) =>
    app.request(
      `/api/accounts/orbit/${path}`,
      {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
  return { sqlite, env, tokens, call };
}

const providerOf = (view: AiProvidersView, kind: string) =>
  view.providers.find((entry) => entry.kind === kind)!;

describe("OpenRouter's catalog", () => {
  test("prices become USD per million tokens, routers have no fixed price, and only text models are offered", () => {
    expect(
      openRouterEntry({
        id: "anthropic/claude-sonnet-5",
        name: "Anthropic: Claude Sonnet 5",
        created: 1788000000,
        context_length: 1000,
        architecture: { output_modalities: ["text"] },
        pricing: {
          prompt: "0.000003",
          completion: "0.000015",
          input_cache_read: "0.0000003",
          input_cache_write: "0.00000375",
          internal_reasoning: "0",
        },
        supported_parameters: ["structured_outputs"],
      }),
    ).toMatchObject({
      id: "openrouter:anthropic/claude-sonnet-5",
      model: "anthropic/claude-sonnet-5",
      capability: "generation",
      releasedAt: "2026-08-29",
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.3,
      cacheWriteUsdPerMillion: 3.75,
      jsonMode: true,
      url: "https://openrouter.ai/anthropic/claude-sonnet-5",
    });
    const router = openRouterEntry({
      id: "typesafe/jev-router",
      pricing: { prompt: "-1", completion: "-1" },
    });
    expect(router).toMatchObject({ variablePricing: true, jsonMode: false });
    expect(router).not.toHaveProperty("reasoningUsdPerMillion");
    expect(
      openRouterEntry({ id: "openai/gpt-image-2", architecture: { output_modalities: ["image"] } }),
    ).toBeNull();
  });

  test("members read it through the account; outsiders can't", async () => {
    const { tokens, call } = await setup();
    const response = await call(tokens.member, "GET", "ai-providers/openrouter/catalog");
    expect(response.status).toBe(200);
    const catalog = (await response.json()) as AiProviderCatalogView;
    expect(catalog.models.map((model) => model.model)).toEqual([
      "anthropic/claude-sonnet-5",
      "deepseek/deepseek-v4",
      "google/gemini-3-flash",
      "typesafe/jev-router",
    ]);
    expect((await call(tokens.outsider, "GET", "ai-providers/openrouter/catalog")).status).toBe(
      404,
    );
    // Read once, then served from memory.
    await call(tokens.member, "GET", "ai-providers/openrouter/catalog");
    expect(provider.requests.filter((r) => r.url.endsWith("/models"))).toHaveLength(1);
  });
});

describe("connecting a provider", () => {
  test("an owner's verified key is sealed and only its last four are ever shown", async () => {
    const { sqlite, tokens, call } = await setup();
    const before = (await (
      await call(tokens.member, "GET", "ai-providers")
    ).json()) as AiProvidersView;
    expect(before.canManage).toBe(false);
    expect(providerOf(before, "openrouter")).toMatchObject({ connected: false, models: [] });

    const response = await call(tokens.owner, "PUT", "ai-providers/openrouter", {
      apiKey: "  sk-or-v1-secret-abcd ",
    });
    expect(response.status).toBe(200);
    const view = (await response.json()) as AiProvidersView;
    expect(providerOf(view, "openrouter")).toMatchObject({
      connected: true,
      keyLastFour: "abcd",
      connectedBy: "ann",
    });
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(provider.requests.at(-1)).toMatchObject({
      url: "https://openrouter.ai/api/v1/key",
      authorization: "Bearer sk-or-v1-secret-abcd",
    });
    const row = sqlite.prepare("SELECT key_sealed FROM ai_providers").get() as {
      key_sealed: string;
    };
    expect(row.key_sealed).toMatch(/^v1\./);
    expect(row.key_sealed).not.toContain("secret");
  });

  test("a refused or unverifiable key stores nothing", async () => {
    const { sqlite, tokens, call } = await setup();
    const refused = await call(tokens.owner, "PUT", "ai-providers/typesafe", {
      apiKey: "wrong-key",
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("didn't accept") });
    const down = await call(tokens.owner, "PUT", "ai-providers/typesafe", {
      apiKey: "ts-key-down",
    });
    expect(down.status).toBe(502);
    expect(
      (await call(tokens.owner, "PUT", "ai-providers/typesafe", { apiKey: "ts key" })).status,
    ).toBe(400);
    expect(sqlite.prepare("SELECT count(*) AS n FROM ai_providers").get()).toEqual({ n: 0 });
  });

  test("members, agents and outsiders can't connect one", async () => {
    const { tokens, call } = await setup();
    const body = { apiKey: "sk-or-v1-key-1234" };
    expect((await call(tokens.member, "PUT", "ai-providers/openrouter", body)).status).toBe(403);
    expect((await call(tokens.agent, "PUT", "ai-providers/openrouter", body)).status).toBe(403);
    expect((await call(tokens.outsider, "PUT", "ai-providers/openrouter", body)).status).toBe(404);
    expect((await call(tokens.owner, "PUT", "ai-providers/anthropic", body)).status).toBe(404);
  });
});

describe("provider models in AI settings and jobs", () => {
  async function connected() {
    const context = await setup();
    const { tokens, call } = context;
    await call(tokens.owner, "PUT", "ai-providers/openrouter", { apiKey: "sk-or-v1-first-1111" });
    await call(tokens.owner, "PUT", "ai-providers/typesafe", { apiKey: "ts-key-2222" });
    return context;
  }

  test("added models carry the provider's published prices and fill the roles their capability allows", async () => {
    const { tokens, call } = await connected();
    // The request names a model; its name and prices come from the provider.
    const added = await call(tokens.owner, "POST", "ai-providers/openrouter/models", {
      model: "anthropic/claude-sonnet-5",
    });
    expect(added.status).toBe(200);
    expect(
      (
        await call(tokens.owner, "POST", "ai-providers/openrouter/models", {
          model: "made/up",
        })
      ).status,
    ).toBe(404);
    await call(tokens.owner, "POST", "ai-providers/typesafe/models", { model: "jev-latest" });
    const view = (await (
      await call(tokens.owner, "GET", "ai-providers")
    ).json()) as AiProvidersView;
    expect(providerOf(view, "openrouter").models).toEqual([
      expect.objectContaining({
        id: "openrouter:anthropic/claude-sonnet-5",
        name: "Anthropic: Claude Sonnet 5",
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
        cacheReadUsdPerMillion: 0.3,
        cacheWriteUsdPerMillion: 3.75,
        contextLength: 1_000_000,
        jsonMode: true,
      }),
    ]);
    expect(providerOf(view, "typesafe").models).toEqual([
      expect.objectContaining({ id: "typesafe:jev-latest", inputUsdPerMillion: 0.042 }),
    ]);
    const settings = (await (
      await call(tokens.member, "GET", "settings/ai")
    ).json()) as AiSettingsView;
    const ids = (role: "classification" | "fast" | "task") =>
      settings.catalog[role].map((option) => option.id);
    expect(ids("classification")).toEqual(["clef", "typesafe:jev-latest"]);
    expect(ids("fast")).toEqual([
      "glm-5.3-flash",
      "gemma-4-26b-a4b-it",
      "openrouter:anthropic/claude-sonnet-5",
    ]);
    expect(ids("task")).toEqual(ids("fast"));
    // A capability mismatch is refused like any unknown model.
    const wrong = await call(tokens.owner, "PATCH", "settings/ai", {
      models: { classification: "openrouter:anthropic/claude-sonnet-5" },
    });
    expect(wrong.status).toBe(400);
  });

  test("jobs snapshot the provider row and price, and call the provider with the account's key", async () => {
    const { env, tokens, call } = await connected();
    await call(tokens.owner, "POST", "ai-providers/openrouter/models", {
      model: "anthropic/claude-sonnet-5",
    });
    await call(tokens.owner, "POST", "ai-providers/typesafe/models", { model: "jev-latest" });
    const saved = await call(tokens.owner, "PATCH", "settings/ai", {
      models: {
        classification: "typesafe:jev-latest",
        task: "openrouter:anthropic/claude-sonnet-5",
      },
    });
    expect(saved.status).toBe(200);

    const snapshot = await repoAiSnapshot(env.DB, "repo");
    const task = parseProviderModelRef(snapshot.models.task)!;
    expect(task).toMatchObject({
      kind: "openrouter",
      model: "anthropic/claude-sonnet-5",
      usageName: "openrouter:anthropic/claude-sonnet-5",
    });
    expect(snapshot.models.fast).toBe("@cf/zai-org/glm-5.3-flash");
    expect(snapshot.prices).toEqual({
      [snapshot.models.task]: { input: 3, output: 15 },
      [snapshot.models.classification]: { input: 0.042, output: 0 },
    });
    // Atlas spends at the provider's published price.
    const policy = await knowledgePolicy(env, "repo");
    expect(policy.atlas.prices[snapshot.models.task]).toEqual({ input: 3, output: 15 });

    // A replaced key keeps the provider row, so captured work uses the new key.
    await call(tokens.owner, "PUT", "ai-providers/openrouter", { apiKey: "sk-or-v1-second-3333" });
    const { value, usage } = await aiWork({ feature: "knowledge", account: "org" }, () =>
      chatJson<{ ok: boolean }>(env, "reason", "system", "user", {
        model: snapshot.models.task,
        think: true,
      }),
    );
    expect(value).toEqual({ ok: true });
    expect(usage).toMatchObject({ model: snapshot.models.task, inputTokens: 12, outputTokens: 3 });
    expect(provider.requests.at(-1)).toMatchObject({
      method: "POST",
      url: "https://openrouter.ai/api/v1/chat/completions",
      authorization: "Bearer sk-or-v1-second-3333",
      body: {
        model: "anthropic/claude-sonnet-5",
        max_tokens: 2000,
        response_format: { type: "json_object" },
        reasoning: { effort: "high" },
        messages: [
          { role: "system", content: "system" },
          { role: "user", content: "user" },
        ],
      },
    });

    const answers = await aiWork({ feature: "knowledge", account: "org" }, () =>
      decide(
        env,
        { file: "README.md" },
        { cosmetic: { type: "noul", instructions: "Is this cosmetic?" } },
        { model: snapshot.models.classification },
      ),
    );
    expect(answers).toEqual({ cosmetic: { type: "noul", noul: 0.9 } });
    expect(provider.requests.at(-1)).toMatchObject({
      url: "https://api.typesafe.ai/v1/systemone",
      authorization: "Bearer ts-key-2222",
      body: {
        model: "jev-latest",
        state: { file: "README.md" },
        questions: { cosmetic: { type: "noul", instructions: "Is this cosmetic?" } },
      },
    });

    // Usage is metered under the account-facing ids, never the provider row.
    const usageRows = env.DB.prepare(
      "SELECT model, calls, input_tokens, output_tokens FROM ai_usage WHERE account_id = 'org' ORDER BY model",
    );
    expect((await usageRows.all()).results).toEqual([
      {
        model: "openrouter:anthropic/claude-sonnet-5",
        calls: 1,
        input_tokens: 12,
        output_tokens: 3,
      },
      { model: "typesafe:jev-latest", calls: 1, input_tokens: 40, output_tokens: 2 },
    ]);
  });

  test("a provider's refusal fails the call without retrying, and is metered as failed", async () => {
    const { env, tokens, call } = await connected();
    await call(tokens.owner, "POST", "ai-providers/openrouter/models", {
      model: "google/gemini-3-flash",
    });
    await call(tokens.owner, "PATCH", "settings/ai", {
      models: { fast: "openrouter:google/gemini-3-flash" },
    });
    const { models } = await repoAiSnapshot(env.DB, "repo");
    provider.next.chat = () =>
      new Response(JSON.stringify({ error: { message: "Insufficient credits" } }), { status: 402 });
    await expect(
      aiWork({ feature: "knowledge", account: "org" }, () =>
        chatJson(env, "fast", "s", "u", { model: models.fast, attempts: 1 }),
      ),
    ).rejects.toThrow("OpenRouter failed (402): Insufficient credits");
    expect(provider.requests.filter((r) => r.url.endsWith("/chat/completions"))).toHaveLength(1);
    const row = await env.DB.prepare(
      "SELECT calls, failed_calls FROM ai_usage WHERE model = 'openrouter:google/gemini-3-flash'",
    ).first();
    expect(row).toEqual({ calls: 0, failed_calls: 1 });
  });

  test("models and providers in use can't be removed; once unused they can", async () => {
    const { env, sqlite, tokens, call } = await connected();
    await call(tokens.owner, "POST", "ai-providers/openrouter/models", {
      model: "google/gemini-3-flash",
    });
    await call(tokens.owner, "PATCH", "settings/ai", {
      models: { fast: "openrouter:google/gemini-3-flash" },
    });
    const removeModel = () =>
      call(
        tokens.owner,
        "DELETE",
        `ai-providers/openrouter/models?model=${encodeURIComponent("google/gemini-3-flash")}`,
      );
    const inUse = await removeModel();
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toMatchObject({
      error: "google/gemini-3-flash is in use for Fast. Choose another model in AI settings first.",
    });
    const disconnect = await call(tokens.owner, "DELETE", "ai-providers/openrouter");
    expect(disconnect.status).toBe(409);
    expect(await disconnect.json()).toMatchObject({
      error: "OpenRouter models are in use for Fast. Choose other models in AI settings first.",
    });

    await call(tokens.owner, "PATCH", "settings/ai", { models: { fast: "glm-5.3-flash" } });
    expect((await removeModel()).status).toBe(200);
    expect((await removeModel()).status).toBe(404);
    await call(tokens.owner, "POST", "ai-providers/openrouter/models", {
      model: "deepseek/deepseek-v4",
    });
    expect((await call(tokens.owner, "DELETE", "ai-providers/openrouter")).status).toBe(200);
    // Its models went with it.
    expect(
      sqlite
        .prepare(
          "SELECT count(*) AS n FROM ai_provider_models m JOIN ai_providers p ON p.id = m.provider_id WHERE p.kind = 'openrouter'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect((await repoAiSnapshot(env.DB, "repo")).models.fast).toBe("@cf/zai-org/glm-5.3-flash");
  });

  test("a model that went missing anyway falls back to the default rather than failing reads", async () => {
    const { env, sqlite, tokens, call } = await connected();
    await call(tokens.owner, "POST", "ai-providers/openrouter/models", {
      model: "google/gemini-3-flash",
    });
    await call(tokens.owner, "PATCH", "settings/ai", {
      models: { task: "openrouter:google/gemini-3-flash" },
    });
    sqlite.exec("DELETE FROM ai_provider_models");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await repoAiSnapshot(env.DB, "repo")).models.task).toBe("@cf/zai-org/glm-5.3-flash");
    expect(warn).toHaveBeenCalled();
  });

  test("refreshing re-reads names and prices; a removed provider's captured work fails clearly", async () => {
    const { env, sqlite, tokens, call } = await connected();
    await call(tokens.owner, "POST", "ai-providers/openrouter/models", {
      model: "google/gemini-3-flash",
    });
    sqlite.exec(
      `UPDATE ai_provider_models SET name = 'Old name', checked_at = '2026-01-01T00:00:00.000Z'`,
    );
    const refreshed = (await (
      await call(tokens.owner, "POST", "ai-providers/openrouter/models/refresh")
    ).json()) as AiProvidersView;
    expect(providerOf(refreshed, "openrouter").models[0]).toMatchObject({
      name: "Google: Gemini 3 Flash",
      reasoningUsdPerMillion: 2.5,
    });
    expect(providerOf(refreshed, "openrouter").models[0]!.pricesCheckedAt).not.toBe(
      "2026-01-01T00:00:00.000Z",
    );

    await call(tokens.owner, "PATCH", "settings/ai", {
      models: { fast: "openrouter:google/gemini-3-flash" },
    });
    const { models } = await repoAiSnapshot(env.DB, "repo");
    sqlite.exec("DELETE FROM ai_providers WHERE kind = 'openrouter'");
    await expect(chatJson(env, "fast", "s", "u", { model: models.fast })).rejects.toThrow(
      /provider this work started with was removed/,
    );
  });
});
