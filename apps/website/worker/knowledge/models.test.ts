import { describe, expect, test } from "vite-plus/test";
import { chatJson, chatText } from "./models.ts";

const environment = (run: (model: string, inputs: unknown) => Promise<unknown>) =>
  ({ AI: { run } }) as unknown as Env;

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
