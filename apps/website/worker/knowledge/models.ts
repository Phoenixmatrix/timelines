// Every model the knowledge pipeline uses, by job. All run on Workers AI.
//
//   fast      many small structured jobs (one per changed file)
//   reason    synthesis and writing (components, overviews, wiki pages)
//   classify  decisions with probabilities (clef: file roles, "is this edit
//             cosmetic?", "is this page out of date?")
//   embed     vectors for graph nodes (Vectorize)

export const MODELS = {
  fast: "@cf/zai-org/glm-5.3-flash",
  reason: "@cf/qwen/qwen3.8-27b",
  classify: "@cf/cloudflare/clef",
  embed: "@cf/qwen/qwen3-embedding-0.6b",
} as const;

export const EMBEDDING_DIMENSIONS = 1024;

export interface Usage {
  model: string;
  tokens: number;
}

interface ChatChoice {
  message?: { content?: string | null };
  finish_reason?: string;
}
interface ChatResult {
  choices?: ChatChoice[];
  response?: unknown;
  usage?: { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
}

// The binding's model list is typed per model; these are OpenAI-shaped chat
// models, so call through a narrow untyped view. Every call has a deadline: a
// hung call must fail (and its workflow step retry) rather than stall a build.
type LooseAi = { run(model: string, inputs: unknown): Promise<unknown> };
const TIMEOUT_MS: Record<string, number> = {
  [MODELS.fast]: 90_000,
  [MODELS.reason]: 180_000,
  [MODELS.classify]: 60_000,
  [MODELS.embed]: 30_000,
};
const RATE_LIMIT_RETRIES = 6;

function rateLimited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\b3021\b|rate limit|too many requests|capacity/i.test(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Call a model with a deadline, waiting out Workers AI rate limits with backoff. */
const ai = (env: Env): LooseAi => ({
  async run(model, inputs) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(env, model, inputs);
      } catch (error) {
        if (!rateLimited(error) || attempt >= RATE_LIMIT_RETRIES) throw error;
        // Per-minute limits: back off for most of a window, with jitter so
        // parallel callers don't all come back at once.
        await sleep(Math.min(60_000, 5_000 * 2 ** attempt) * (0.5 + Math.random()));
      }
    }
  },
});

function once(env: Env, model: string, inputs: unknown): Promise<unknown> {
  const ms = TIMEOUT_MS[model] ?? 120_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${model} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([(env.AI as unknown as LooseAi).run(model, inputs), deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function chat(
  env: Env,
  tier: "fast" | "reason",
  messages: { role: "system" | "user"; content: string }[],
  options: { json: boolean; maxTokens: number; think: boolean },
): Promise<{ text: string; usage: Usage }> {
  const model = MODELS[tier];
  const result = (await ai(env).run(model, {
    messages,
    max_tokens: options.maxTokens,
    ...(options.json ? { response_format: { type: "json_object" } } : {}),
    // Thinking costs 3-5x the latency; only the hardest writing turns it on.
    chat_template_kwargs: { enable_thinking: options.think },
  })) as ChatResult;
  const choice = result.choices?.[0];
  const text =
    choice?.message?.content ?? (typeof result.response === "string" ? result.response : "");
  if (!text) throw new Error(`${model} returned no content (${choice?.finish_reason ?? "?"})`);
  return { text, usage: { model, tokens: result.usage?.total_tokens ?? 0 } };
}

/** Parse the first JSON object in a model reply, tolerating code fences and chatter. */
export function parseJsonReply<T>(text: string): T {
  const unfenced = text.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("No JSON object in reply");
  return JSON.parse(unfenced.slice(start, end + 1)) as T;
}

/** A JSON answer, retried once if the model's reply doesn't parse. */
export async function chatJson<T>(
  env: Env,
  tier: "fast" | "reason",
  system: string,
  user: string,
  options: { maxTokens?: number; think?: boolean } = {},
): Promise<{ value: T; usage: Usage }> {
  const messages = [
    { role: "system" as const, content: system },
    { role: "user" as const, content: user },
  ];
  let lastError: unknown;
  let tokens = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text, usage } = await chat(env, tier, messages, {
        json: true,
        maxTokens: options.maxTokens ?? 2000,
        think: options.think ?? false,
      });
      tokens += usage.tokens;
      return { value: parseJsonReply<T>(text), usage: { model: usage.model, tokens } };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** Free-form text (markdown pages). */
export async function chatText(
  env: Env,
  tier: "fast" | "reason",
  system: string,
  user: string,
  options: { maxTokens?: number; think?: boolean } = {},
): Promise<{ text: string; usage: Usage }> {
  return chat(
    env,
    tier,
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    { json: false, maxTokens: options.maxTokens ?? 4000, think: options.think ?? false },
  );
}

// ---- clef: decisions with probabilities -----------------------------------

export type ClefQuestion =
  | { type: "noul"; instructions: unknown; criteria?: { true?: unknown; false?: unknown } }
  | { type: "choice"; instructions: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions: unknown; criteria: unknown[] };

export type ClefAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; probabilities: number[]; confidence: number };

/** Ask clef up to 64 typed questions about one state. */
export async function decide(
  env: Env,
  state: unknown,
  questions: Record<string, ClefQuestion>,
): Promise<Record<string, ClefAnswer>> {
  const result = (await ai(env).run(MODELS.classify, {
    model: "clef",
    state,
    questions,
  })) as { answers?: Record<string, ClefAnswer> };
  if (!result.answers) throw new Error("clef returned no answers");
  return result.answers;
}

export function yes(answer: ClefAnswer | undefined): number {
  return answer?.type === "noul" ? answer.noul : 0;
}

export function choice(answer: ClefAnswer | undefined): string | null {
  return answer?.type === "choice" ? answer.choice : null;
}

// ---- embeddings -------------------------------------------------------------

/** Embed texts in batches; returns one vector per input, in order. */
export async function embed(env: Env, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const batch = texts.slice(i, i + 64).map((t) => t.slice(0, 8000));
    const result = (await ai(env).run(MODELS.embed, { text: batch })) as { data: number[][] };
    out.push(...result.data);
  }
  return out;
}
