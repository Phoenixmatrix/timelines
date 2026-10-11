import { describe, expect, test } from "vite-plus/test";
import { chatJson, chatText, decide, type ClefQuestion } from "./models.ts";

const environment = (run: (model: string, inputs: unknown) => Promise<unknown>) =>
  ({ AI: { run } }) as unknown as Env;

describe("configured classification models", () => {
  const state = "Checkout has been failing for every customer for the last hour.";
  const questions: Record<string, ClefQuestion> = {
    urgent: { type: "noul", instructions: "Is this support request urgent?" },
  };

  test.each([
    { options: {}, selector: "clef" },
    { options: { model: "@cf/cloudflare/clef" }, selector: "clef" },
    { options: { model: "@cf/cloudflare/clef-flash" }, selector: "clef-flash" },
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
