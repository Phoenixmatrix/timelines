import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import { chatJson, chatText, decide, type ClefQuestion } from "./models.ts";
import { aiWork } from "../usage/ai.ts";
import * as providerStore from "../ai-providers/store.ts";
import * as providers from "../ai-providers/providers.ts";
import type { Actor } from "../db.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { issueToken } from "../api/tokens.ts";
import * as gateway from "../ai-gateway.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));

const environment = (run: (model: string, inputs: unknown) => Promise<unknown>) =>
  ({ AI: { run } }) as unknown as Env;

describe("configured classification models", () => {
  const state = "Checkout has been failing for every customer for the last hour.";
  const questions: Record<string, ClefQuestion> = {
    urgent: { type: "noul", instructions: "Is this support request urgent?" },
  };

  test.each([
    { options: {}, selector: "clef" },
    { options: { model: "@cf/cloudflare/clef-omni" }, selector: "clef-omni" },
    { options: { flash: true, model: "@cf/cloudflare/clef-omni" }, selector: "clef-flash" },
  ])(
    "routes $selector with a matching request selector ($options)",
    async ({ options, selector }) => {
      const calls: { model: string; inputs: unknown }[] = [];
      const answers = { urgent: { type: "noul", noul: 0.99 } };
      const env = environment(async (model, inputs) => {
        calls.push({ model, inputs });
        return { answers };
      });
      expect(await decide(env, state, questions, options)).toEqual(answers);
      expect(calls).toEqual([
        {
          model: `@cf/cloudflare/${selector}`,
          inputs: { model: selector, state, questions },
        },
      ]);
    },
  );
});

describe("configured inference failures", () => {
  test("a reasoning-only completion fails rather than publishing an empty page", async () => {
    const env = environment(async () => ({
      choices: [
        { message: { content: null, reasoning_content: "Thinking" }, finish_reason: "length" },
      ],
    }));
    await expect(
      chatText(env, "reason", "system", "user", { model: "@cf/google/gemma-4-26b-a4b-it" }),
    ).rejects.toThrow(Error);
  });

  test.each(["instance", "person"])(
    "a provider reference in %s context fails before dispatch",
    async (scope) => {
      let calls = 0;
      const env = environment(async () => {
        calls++;
        throw new Error("Unscoped provider work must not dispatch");
      });
      await expect(
        aiWork({ feature: "assistant", ...(scope === "person" ? { personId: "ann" } : {}) }, () =>
          chatText(env, "reason", "system", "user", {
            model: "openrouter:aip_00000000-0000-0000-0000-000000000001:example/model",
          }),
        ),
      ).rejects.toThrow("Provider model calls require an authorized Space resource.");
      expect(calls).toBe(0);
    },
  );

  test.each(
    ["custom", "builtin"].flatMap((kind) =>
      ["live", "credential", "grant", "foreign-person", "revoked-during-setup"].map((state) => ({
        kind,
        state,
      })),
    ),
  )("$kind personal provider authority checks $state before dispatch", async ({ kind, state }) => {
    const fresh = await createFreshSpaceTestEnvironment();
    const { sqlite } = fresh;
    onTestFinished(() => {
      vi.restoreAllMocks();
      fresh.close();
    });
    sqlite.exec(`
        INSERT INTO accounts (id,kind,slug,display_name) VALUES ('ann','user','ann','Ann'), ('ben','user','ben','Ben');
      `);
    const builtin = vi.fn(async () => ({
      choices: [{ message: { content: "Authorized answer" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
    const env = { ...fresh.env, AI: { run: builtin } } as unknown as Env;
    const token = await issueToken(env.DB, "ann", "Model test", "write");
    await seedSpaceFixture(env.DB, {
      organization: {
        id: "personal-org",
        slug: "personal-org",
        displayName: "Personal",
        kind: "personal",
        personalAccountId: "ann",
      },
      space: { id: "personal-space", slug: "personal-space", displayName: "Personal Space" },
      actorId: "ann",
      members: [
        {
          accountId: "ann",
          role: "owner",
          grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
        },
      ],
    });
    const actor: Actor = {
      id: "ann",
      slug: "ann",
      displayName: "Ann",
      isSiteAdmin: false,
      credential: { kind: "token", id: token.id },
    };
    const key = vi.spyOn(providerStore, "providerKey").mockImplementation(async () => {
      if (state === "revoked-during-setup")
        sqlite.prepare("DELETE FROM access_tokens WHERE id=?").run(token.id);
      return "test-provider-key";
    });
    const gatewayOptions = vi.spyOn(gateway, "aiGatewayOptions").mockImplementation(async () => {
      if (state === "revoked-during-setup")
        sqlite.prepare("DELETE FROM access_tokens WHERE id=?").run(token.id);
      return { gateway: { id: "test-gateway", metadata: { component: "assistant" } } };
    });
    const dispatch = vi.spyOn(providers, "callProvider").mockResolvedValue({
      choices: [{ message: { content: "Authorized answer" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
    if (state === "credential")
      sqlite.prepare("DELETE FROM access_tokens WHERE id=?").run(token.id);
    if (state === "grant") sqlite.exec("DELETE FROM space_grants WHERE account_id='ann'");
    const result = aiWork(
      {
        feature: "assistant",
        personId: state === "foreign-person" ? "ben" : "ann",
        providerAuthority: { spaceId: "personal-space", actor },
      },
      () =>
        chatText(env, "reason", "system", "user", {
          model:
            kind === "custom"
              ? "openrouter:aip_00000000-0000-0000-0000-000000000001:example/model"
              : "@cf/google/gemma-4-26b-a4b-it",
        }),
    );
    if (state === "live") {
      expect((await result).text).toBe("Authorized answer");
      if (kind === "custom") {
        expect(key).toHaveBeenCalledWith(
          env,
          expect.objectContaining({
            providerId: "aip_00000000-0000-0000-0000-000000000001",
          }),
          "personal-space",
        );
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(builtin).not.toHaveBeenCalled();
      } else {
        expect(builtin).toHaveBeenCalledTimes(1);
        expect(dispatch).not.toHaveBeenCalled();
        expect(key).not.toHaveBeenCalled();
      }
      expect(sqlite.prepare("SELECT scope_kind,scope_id FROM ai_usage").all()).toEqual([
        { scope_kind: "person", scope_id: "ann" },
      ]);
    } else {
      await expect(result).rejects.toThrow("Provider Space authority is no longer valid.");
      expect(dispatch).not.toHaveBeenCalled();
      expect(builtin).not.toHaveBeenCalled();
      if (state !== "revoked-during-setup") {
        expect(key).not.toHaveBeenCalled();
        expect(gatewayOptions).not.toHaveBeenCalled();
      }
    }
  });
});

describe("rate limit retries", () => {
  test("chatText forwards rateLimitRetries: 0, so a rate-limited call is not retried", async () => {
    let attempts = 0;
    const env = environment(async () => {
      attempts++;
      throw new Error("3021: Too many requests");
    });
    await expect(
      chatText(env, "reason", "system", "user", { rateLimitRetries: 0 }),
    ).rejects.toThrow(/Too many requests/);
    expect(attempts).toBe(1);
  });
});

describe("JSON repair accounting", () => {
  test("both failed parsing and repair tokens remain attributed to the configured model", async () => {
    let attempts = 0;
    const env = environment(async () => {
      attempts++;
      return {
        choices: [{ message: { content: attempts === 1 ? "invalid" : '{"title":"Repaired"}' } }],
        usage: { total_tokens: 15, prompt_tokens: 10, completion_tokens: 5 },
      };
    });
    const result = await chatJson(env, "reason", "system", "user", {
      model: "@cf/google/gemma-4-26b-a4b-it",
    });
    expect(result).toEqual({
      value: { title: "Repaired" },
      usage: {
        model: "@cf/google/gemma-4-26b-a4b-it",
        tokens: 30,
        inputTokens: 20,
        outputTokens: 10,
      },
    });
    expect(attempts).toBe(2);
  });

  test("Atlas single-attempt calls do not buy a JSON repair", async () => {
    let attempts = 0;
    const env = environment(async () => {
      attempts++;
      return { response: "invalid", usage: { total_tokens: 5 } };
    });
    await expect(chatJson(env, "reason", "system", "user", { attempts: 1 })).rejects.toThrow(Error);
    expect(attempts).toBe(1);
  });
});
