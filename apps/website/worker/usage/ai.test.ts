// AI call metering keeps Space, person and Instance ownership distinct.
// Recording errors never fail the model call.
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { d1, migratedDatabase, migratedRegistryDatabase } from "../testing/d1.ts";
import { seedSpaceFixture } from "../testing/spaces.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";
import { chatJson, embed } from "../knowledge/models.ts";
import { aiWork, attribution, recordAiCall, tokensOf } from "./ai.ts";

let sqlite: DatabaseSync;
let env: Env;
let registry: DatabaseSync;
let closeControl: () => void;

afterEach(() => {
  closeControl();
  sqlite.close();
  registry.close();
});

beforeEach(async () => {
  sqlite = migratedDatabase();
  registry = migratedRegistryDatabase();
  env = { DB: d1(sqlite), REGISTRY_DB: d1(registry) } as Env;
  closeControl = installCutoverTestControl(env).close;
  await initializeFreshSpaceInstallation(env);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_o', 'user', 'ann', 'Ann');
  `);
  await seedSpaceFixture(d1(sqlite), {
    organization: { id: "org", slug: "company", displayName: "Company", kind: "company" },
    space: { id: "acc_o", slug: "orbit", displayName: "Orbit" },
    actorId: "acc_o",
    members: [
      {
        accountId: "acc_o",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo_1', 'acc_o', 'engine', 'private', 'n', 'https://x');
  `);
  env = {
    ...env,
    DB: d1(sqlite),
    AI: {
      run: vi.fn(async (model: string) =>
        model.includes("embedding")
          ? { data: [[0.1, 0.2]] }
          : {
              choices: [{ message: { content: '{"ok":true}' } }],
              usage: { prompt_tokens: 120, completion_tokens: 8, total_tokens: 128 },
            },
      ),
    },
  } as unknown as Env;
});

function usage() {
  return sqlite
    .prepare(
      "SELECT scope_kind, scope_id, feature, model, calls, input_tokens, output_tokens, total_tokens FROM ai_usage ORDER BY scope_id, scope_kind, feature, model",
    )
    .all();
}

describe("AI metering", () => {
  test("model calls record for the repository Space, person or Instance", async () => {
    await aiWork({ feature: "knowledge", repo: "repo_1" }, async () => {
      await chatJson(env, "fast", "system", "user");
      await chatJson(env, "fast", "system", "user");
      await embed(env, ["a"]);
    });
    await aiWork({ feature: "assistant", personId: "acc_p" }, () =>
      chatJson(env, "fast", "s", "u"),
    );
    // Outside any declared work: the site's.
    await chatJson(env, "fast", "s", "u");
    expect(usage()).toEqual([
      {
        scope_kind: "instance",
        scope_id: "",
        feature: "unattributed",
        model: expect.any(String),
        calls: 1,
        input_tokens: 120,
        output_tokens: 8,
        total_tokens: 128,
      },
      {
        scope_kind: "space",
        scope_id: "acc_o",
        feature: "knowledge",
        model: "@cf/qwen/qwen3-embedding-0.6b",
        calls: 1,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
      {
        scope_kind: "space",
        scope_id: "acc_o",
        feature: "knowledge",
        model: expect.any(String),
        calls: 2,
        input_tokens: 240,
        output_tokens: 16,
        total_tokens: 256,
      },
      {
        scope_kind: "person",
        scope_id: "acc_p",
        feature: "assistant",
        model: expect.any(String),
        calls: 1,
        input_tokens: 120,
        output_tokens: 8,
        total_tokens: 128,
      },
    ]);
  });

  test("a failing recording never fails the call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = {
      ...env,
      DB: {
        prepare: () => {
          throw new Error("D1 is down");
        },
      },
    } as unknown as Env;
    await expect(chatJson(broken, "fast", "s", "u")).resolves.toMatchObject({
      value: { ok: true },
    });
    await expect(recordAiCall(broken, "m", {}, { calls: 4 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("explicit work and token shapes", async () => {
    await recordAiCall(
      env,
      "@cf/flux",
      {},
      { calls: 4, work: { feature: "avatars", personId: "acc_o" } },
    );
    expect(usage()).toMatchObject([
      { scope_kind: "person", scope_id: "acc_o", feature: "avatars", calls: 4, total_tokens: 0 },
    ]);
    expect(tokensOf({ usage: { inputTokens: 3, outputTokens: 2 } })).toEqual({
      input: 3,
      output: 2,
      total: undefined,
    });
    expect(tokensOf(null)).toEqual({});
  });

  test("equal preserved person and Space IDs never merge their usage", async () => {
    await recordAiCall(env, "m", { input: 2 }, { work: { feature: "test", personId: "acc_o" } });
    await recordAiCall(env, "m", { input: 3 }, { work: { feature: "test", spaceId: "acc_o" } });
    expect(usage()).toMatchObject([
      { scope_kind: "person", scope_id: "acc_o", input_tokens: 2 },
      { scope_kind: "space", scope_id: "acc_o", input_tokens: 3 },
    ]);
  });

  test("missing or mismatched repositories cannot fall back to personal or Instance attribution", async () => {
    await expect(
      aiWork({ feature: "test", repo: "missing" }, () => attribution(env)),
    ).rejects.toThrow("AI work repository has no active Space.");
    await expect(
      aiWork({ feature: "test", repo: "repo_1", spaceId: "other" }, () => attribution(env)),
    ).rejects.toThrow("AI work repository does not belong to the declared Space.");
    await expect(
      aiWork({ feature: "test", repo: "repo_1", personId: "acc_o" }, () => attribution(env)),
    ).rejects.toThrow("AI work cannot mix personal and content attribution.");
  });

  test("who asked is recorded beside the Space, each on its own row (CORE-222)", async () => {
    const work = { feature: "search", spaceId: "acc_o" };
    await recordAiCall(env, "@cf/e", { total: 10 }, { work: { ...work, actor: "acc_ann" } });
    await recordAiCall(env, "@cf/e", { total: 20 }, { work: { ...work, actor: "acc_ann" } });
    await recordAiCall(
      env,
      "@cf/e",
      { total: 5 },
      { work: { ...work, actor: "acc_ann", agent: "agt_bot", timeline: "search-v2" } },
    );
    // Work that serves no one in particular records as before.
    await recordAiCall(env, "@cf/e", { total: 7 }, { work });
    expect(
      sqlite
        .prepare(
          "SELECT actor_id, agent_id, timeline, calls, total_tokens FROM ai_usage ORDER BY total_tokens",
        )
        .all(),
    ).toEqual([
      {
        actor_id: "acc_ann",
        agent_id: "agt_bot",
        timeline: "search-v2",
        calls: 1,
        total_tokens: 5,
      },
      { actor_id: "", agent_id: "", timeline: "", calls: 1, total_tokens: 7 },
      { actor_id: "acc_ann", agent_id: "", timeline: "", calls: 2, total_tokens: 30 },
    ]);
  });
});
