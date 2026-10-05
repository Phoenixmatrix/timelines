// TESTS ONLY: TypeSafe's and OpenRouter's HTTP APIs (CORE-294), in memory.
// Keys starting `sk-or-` (OpenRouter) or `ts-` (TypeSafe) are accepted, and
// `…-down` ones find the provider unavailable; anything else is refused.
// Every request is recorded with its parsed JSON body.

import { OPENROUTER_API, TYPESAFE_API } from "../ai-providers/providers.ts";

/** A slice of OpenRouter's GET /models, in its own shape (USD per token, as strings). */
export const OPENROUTER_MODELS = [
  {
    id: "anthropic/claude-sonnet-5",
    name: "Anthropic: Claude Sonnet 5",
    description: "A balanced model for writing and analysis.",
    created: 1788000000,
    context_length: 1_000_000,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
    },
    supported_parameters: ["max_tokens", "reasoning", "response_format", "structured_outputs"],
  },
  {
    id: "google/gemini-3-flash",
    name: "Google: Gemini 3 Flash",
    description: "Fast and inexpensive.",
    created: 1785000000,
    context_length: 1_048_576,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: {
      prompt: "0.0000003",
      completion: "0.0000025",
      input_cache_read: "0.000000075",
      internal_reasoning: "0.0000025",
    },
    supported_parameters: ["max_tokens", "response_format"],
  },
  {
    id: "deepseek/deepseek-v4",
    name: "DeepSeek: DeepSeek V4",
    description: "Open weights, no JSON mode.",
    created: 1784000000,
    context_length: 163_840,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.00000027", completion: "0.0000011" },
    supported_parameters: ["max_tokens", "temperature"],
  },
  {
    id: "typesafe/jev-router",
    name: "TypeSafe: Jev Router",
    description: "Picks the best model for each request.",
    created: 1790363560,
    context_length: 1_000_000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "-1", completion: "-1" },
    supported_parameters: ["max_tokens", "response_format"],
  },
  {
    id: "openai/gpt-image-2",
    name: "OpenAI: GPT Image 2",
    description: "Pictures only.",
    created: 1786000000,
    context_length: 32_000,
    architecture: { input_modalities: ["text"], output_modalities: ["image"] },
    pricing: { prompt: "0.000005", completion: "0.00004" },
    supported_parameters: [],
  },
];

export interface ProviderRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: Record<string, unknown> | null;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Whether `url` is one of the providers this fake answers for. */
export function isProviderUrl(url: string): boolean {
  return url.startsWith(`${OPENROUTER_API}/`) || url.startsWith(`${TYPESAFE_API}/`);
}

export function fakeProviders() {
  const requests: ProviderRequest[] = [];
  /** What the next chat completion or typed-question call answers, if not the default. */
  const next: { chat?: () => Response; systemone?: () => Response } = {};
  async function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const text = request.method === "GET" ? "" : await request.text();
    const authorization = request.headers.get("authorization");
    requests.push({
      method: request.method,
      url: request.url,
      authorization,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    });
    const key = authorization?.replace(/^Bearer /, "") ?? "";
    const openRouter = request.url.startsWith(`${OPENROUTER_API}/`);
    const path = request.url.slice((openRouter ? OPENROUTER_API : TYPESAFE_API).length);
    if (openRouter && path === "/models" && request.method === "GET")
      return json({ data: OPENROUTER_MODELS });
    if (!key.startsWith(openRouter ? "sk-or-" : "ts-"))
      return json({ error: { message: "Invalid API key" } }, 401);
    if (key.endsWith("-down")) return json({ error: { message: "Unavailable" } }, 503);
    if (openRouter && path === "/key") return json({ data: { label: "test", usage: 0 } });
    if (!openRouter && path === "/models")
      return json({ models: [{ name: "jev-latest", release_date: "2026-09-15" }] });
    if (openRouter && path === "/chat/completions")
      return (
        next.chat?.() ??
        json({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        })
      );
    if (!openRouter && path === "/systemone")
      return (
        next.systemone?.() ??
        json({
          model: "jev-1.13.0",
          answers: { cosmetic: { type: "noul", noul: 0.9 } },
          usage: { input_tokens: 40, output_tokens: 2 },
        })
      );
    return json({ error: { message: "Not found" } }, 404);
  }
  return { fetch, requests, next };
}
