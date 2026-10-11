// AI call metering (CORE-207): model calls record into ai_usage for the
// account whose work declared them, and recording never fails a call.
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { chatJson, embed } from "../knowledge/models.ts";
import { aiWork, recordAiCall, tokensOf } from "./ai.ts";

let sqlite: DatabaseSync;
let env: Env;

beforeEach(() => {
  sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_o', 'org', 'orbit', 'Orbit');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo_1', 'acc_o', 'engine', 'private', 'n', 'https://x');
  `);
  env = {
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
      "SELECT account_id, feature, model, calls, input_tokens, output_tokens, total_tokens FROM ai_usage ORDER BY account_id, feature, model",
    )
    .all();
}

describe("AI metering", () => {
  test("model calls record for the repository owner's declared work", async () => {
    await aiWork({ feature: "knowledge", repo: "repo_1" }, async () => {
      await chatJson(env, "fast", "system", "user");
      await chatJson(env, "fast", "system", "user");
      await embed(env, ["a"]);
    });
    await aiWork({ feature: "assistant", account: "acc_p" }, () => chatJson(env, "fast", "s", "u"));
    // Outside any declared work: the site's.
    await chatJson(env, "fast", "s", "u");
    expect(usage()).toEqual([
      {
        account_id: "",
        feature: "unattributed",
        model: expect.any(String),
        calls: 1,
        input_tokens: 120,
        output_tokens: 8,
        total_tokens: 128,
      },
      {
        account_id: "acc_o",
        feature: "knowledge",
        model: "@cf/qwen/qwen3-embedding-0.6b",
        calls: 1,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
      {
        account_id: "acc_o",
        feature: "knowledge",
        model: expect.any(String),
        calls: 2,
        input_tokens: 240,
        output_tokens: 16,
        total_tokens: 256,
      },
      {
        account_id: "acc_p",
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
      { calls: 4, work: { feature: "avatars", account: "acc_o" } },
    );
    expect(usage()).toMatchObject([
      { account_id: "acc_o", feature: "avatars", calls: 4, total_tokens: 0 },
    ]);
    expect(tokensOf({ usage: { inputTokens: 3, outputTokens: 2 } })).toEqual({
      input: 3,
      output: 2,
      total: undefined,
    });
    expect(tokensOf(null)).toEqual({});
  });

  test("who asked is recorded beside the account, each on its own row (CORE-222)", async () => {
    const work = { feature: "search", account: "acc_o" };
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
