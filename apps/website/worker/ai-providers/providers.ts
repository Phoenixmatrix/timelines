// The HTTP side of an account's own AI providers (CORE-294): checking a key,
// reading what a provider offers, and calling its models for automatic work.
// Calls go straight to the provider with the account's key, so the provider
// bills that key; they don't pass through Workers AI or AI Gateway.
//
//   TypeSafe    POST https://api.typesafe.ai/v1/systemone   typed questions (Jev)
//               GET  https://api.typesafe.ai/v1/models      checks a key
//   OpenRouter  POST https://openrouter.ai/api/v1/chat/completions
//               GET  https://openrouter.ai/api/v1/models    the public catalog
//               GET  https://openrouter.ai/api/v1/key       checks a key

import {
  providerModelId,
  type AiProviderCatalogEntry,
  type AiProviderKind,
} from "../../shared/ai.ts";

export const TYPESAFE_API = "https://api.typesafe.ai/v1";
export const OPENROUTER_API = "https://openrouter.ai/api/v1";

const PROVIDER_NAMES: Record<AiProviderKind, string> = {
  typesafe: "TypeSafe",
  openrouter: "OpenRouter",
};

/**
 * TypeSafe serves one model family; Jev is all it offers today. `jev-latest`
 * follows TypeSafe's stable releases. Prices from docs.typesafe.ai/models,
 * checked 2026-10-05: input only; output and cached input are free.
 */
export const TYPESAFE_CATALOG: readonly AiProviderCatalogEntry[] = [
  {
    id: providerModelId("typesafe", "jev-latest"),
    name: "Jev",
    model: "jev-latest",
    provider: "typesafe",
    capability: "classification",
    description:
      "TypeSafe's System One model: answers choice, score and yes/no questions with calibrated probabilities instead of writing text.",
    releasedAt: "2026-09-15",
    inputUsdPerMillion: 0.042,
    outputUsdPerMillion: 0,
    contextLength: 64_000,
    jsonMode: true,
    url: "https://docs.typesafe.ai/models",
  },
];

export type KeyCheck = "ok" | "invalid" | "unreachable";

/** Whether the provider accepts `key`, without spending anything. */
export async function checkKey(kind: AiProviderKind, key: string): Promise<KeyCheck> {
  const url = kind === "typesafe" ? `${TYPESAFE_API}/models` : `${OPENROUTER_API}/key`;
  try {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel();
    if (response.ok) return "ok";
    return response.status === 401 || response.status === 403 ? "invalid" : "unreachable";
  } catch {
    return "unreachable";
  }
}

// ---- catalogs -----------------------------------------------------------------

interface OpenRouterModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  created?: unknown;
  context_length?: unknown;
  architecture?: { output_modalities?: unknown };
  pricing?: Record<string, unknown>;
  supported_parameters?: unknown;
}

/** OpenRouter's USD per token, as a string, in USD per million tokens; null when not a fixed price. */
function perMillion(value: unknown): number | null {
  const number = typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  if (!Number.isFinite(number) || number < 0) return null;
  // Round off float noise: "0.000002" × 1e6 is 1.9999999999999998.
  return Number((number * 1_000_000).toPrecision(10));
}

/** One OpenRouter model as this app can use it, or null when it can't (no text output). */
export function openRouterEntry(raw: OpenRouterModel): AiProviderCatalogEntry | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const outputs = Array.isArray(raw.architecture?.output_modalities)
    ? raw.architecture.output_modalities
    : ["text"];
  if (!outputs.includes("text")) return null;
  const pricing = raw.pricing ?? {};
  const input = perMillion(pricing.prompt);
  const output = perMillion(pricing.completion);
  const optional = (key: string) => {
    const price = perMillion(pricing[key]);
    return price ? price : undefined;
  };
  const parameters = Array.isArray(raw.supported_parameters) ? raw.supported_parameters : [];
  const description = typeof raw.description === "string" ? raw.description : "";
  const entry: AiProviderCatalogEntry = {
    id: providerModelId("openrouter", raw.id),
    name: typeof raw.name === "string" && raw.name ? raw.name : raw.id,
    model: raw.id,
    provider: "openrouter",
    capability: "generation",
    description: description.length > 280 ? `${description.slice(0, 279)}…` : description,
    releasedAt:
      typeof raw.created === "number" && raw.created > 0
        ? new Date(raw.created * 1000).toISOString().slice(0, 10)
        : "",
    inputUsdPerMillion: input ?? 0,
    outputUsdPerMillion: output ?? 0,
    contextLength:
      typeof raw.context_length === "number" && raw.context_length > 0 ? raw.context_length : null,
    jsonMode: parameters.includes("response_format") || parameters.includes("structured_outputs"),
    url: `https://openrouter.ai/${raw.id}`,
  };
  const cacheRead = optional("input_cache_read");
  const cacheWrite = optional("input_cache_write");
  const reasoning = optional("internal_reasoning");
  if (cacheRead !== undefined) entry.cacheReadUsdPerMillion = cacheRead;
  if (cacheWrite !== undefined) entry.cacheWriteUsdPerMillion = cacheWrite;
  if (reasoning !== undefined) entry.reasoningUsdPerMillion = reasoning;
  // Routers publish -1: what a call costs depends on the model it reaches.
  if (input === null || output === null) entry.variablePricing = true;
  return entry;
}

const CATALOG_TTL_MS = 15 * 60_000;
let openRouterCache: {
  at: number;
  promise: Promise<{ models: AiProviderCatalogEntry[]; fetchedAt: string }>;
} | null = null;

async function fetchOpenRouterCatalog() {
  const response = await fetch(`${OPENROUTER_API}/models`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`OpenRouter's model list answered ${response.status}.`);
  const body = (await response.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error("OpenRouter's model list had no models.");
  const models = body.data
    .map((raw) => openRouterEntry(raw as OpenRouterModel))
    .filter((entry): entry is AiProviderCatalogEntry => entry !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
  return { models, fetchedAt: new Date().toISOString() };
}

/**
 * What a provider offers. OpenRouter's public list is read at most every 15
 * minutes per isolate; a failed read isn't kept, so the next request retries.
 */
export async function providerCatalog(
  kind: AiProviderKind,
): Promise<{ models: AiProviderCatalogEntry[]; fetchedAt: string }> {
  if (kind === "typesafe")
    return { models: [...TYPESAFE_CATALOG], fetchedAt: new Date().toISOString() };
  const now = Date.now();
  if (!openRouterCache || now - openRouterCache.at > CATALOG_TTL_MS) {
    const promise = fetchOpenRouterCatalog();
    openRouterCache = { at: now, promise };
    promise.catch(() => {
      if (openRouterCache?.promise === promise) openRouterCache = null;
    });
  }
  return openRouterCache.promise;
}

/** TESTS ONLY: forget the cached OpenRouter catalog. */
export function forgetProviderCatalogs() {
  openRouterCache = null;
}

// ---- calls ----------------------------------------------------------------------

/** The provider's own words for a failed call, kept short. */
async function failure(kind: AiProviderKind, response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown } | string;
      detail?: unknown;
      message?: unknown;
    };
    const message =
      typeof body.error === "object" ? body.error?.message : (body.error ?? body.message);
    detail =
      typeof message === "string"
        ? message
        : body.detail !== undefined
          ? JSON.stringify(body.detail)
          : "";
  } catch {
    // No JSON body: the status says enough.
  }
  const name = PROVIDER_NAMES[kind];
  // Worded so worker/knowledge/models.ts backs off and retries these.
  const reason =
    response.status === 429
      ? "rate limit"
      : response.status === 529 || response.status === 503
        ? "over capacity"
        : response.status === 401 || response.status === 403
          ? "refused the account's API key"
          : "failed";
  return new Error(
    `${name} ${reason} (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
  );
}

/**
 * Call `model` on the account's provider with Workers AI-shaped inputs: chat
 * (`messages`) on OpenRouter, typed questions (`questions`) on TypeSafe. The
 * result keeps the shape the Workers AI binding would have returned.
 */
export async function callProvider(
  env: Env,
  kind: AiProviderKind,
  key: string,
  model: string,
  inputs: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  let url: string;
  let body: Record<string, unknown>;
  const headers: Record<string, string> = {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };
  if (kind === "typesafe") {
    if (!inputs.questions) throw new Error(`TypeSafe's ${model} only answers typed questions.`);
    url = `${TYPESAFE_API}/systemone`;
    body = { model, state: inputs.state, questions: inputs.questions };
  } else {
    if (!inputs.messages) throw new Error(`OpenRouter's ${model} only takes chat messages.`);
    url = `${OPENROUTER_API}/chat/completions`;
    body = { ...inputs, model };
    // OpenRouter's attribution headers: which app made the call.
    const site = Reflect.get(env, "PUBLIC_URL");
    if (typeof site === "string" && site) headers["http-referer"] = site;
    headers["x-title"] = "Timelines";
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await failure(kind, response);
  const result = (await response.json()) as { error?: { message?: unknown; code?: unknown } };
  // OpenRouter reports some upstream failures inside a 200.
  if (result.error) {
    const message = typeof result.error.message === "string" ? result.error.message : "";
    const code =
      typeof result.error.code === "number" || typeof result.error.code === "string"
        ? ` (${result.error.code})`
        : "";
    throw new Error(`${PROVIDER_NAMES[kind]} failed${code}: ${message.slice(0, 300)}`);
  }
  return result;
}
