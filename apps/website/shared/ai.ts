// Curated account-wide configuration for automatic AI work. Interactive chat
// and the fixed-dimension embedding model are deliberately outside this catalog.
export type AiRole = "classification" | "fast" | "task";
/** A model an account added from one of its own providers (CORE-294): `<provider>:<model>`. */
export type ProviderModelId = `${AiProviderKind}:${string}`;
export type ClassificationModel = "clef" | ProviderModelId;
export type GenerationModel = "glm-5.3-flash" | "gemma-4-26b-a4b-it" | ProviderModelId;

export interface AiFeatures {
  knowledge: boolean;
  wiki: boolean;
  atlas: boolean;
  releaseNotes: boolean;
}

export interface AiModelSelection {
  classification: ClassificationModel;
  fast: GenerationModel;
  task: GenerationModel;
}

/** Resolved provider IDs, captured once for a job rather than read during it. */
export interface AiModels {
  classification: string;
  fast: string;
  task: string;
}

export interface AiModelOption {
  id: string;
  name: string;
  /** The provider's own model id: `@cf/…` on Workers AI, `jev-latest`, `anthropic/…`. */
  model: string;
  releasedAt: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  /** Published cache prices, where the provider charges for them. */
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  /** Reasoning tokens, where they are priced apart from output. */
  reasoningUsdPerMillion?: number;
  /** The price depends on what the provider routes to: no fixed per-token price. */
  variablePricing?: boolean;
  url: string;
  /** Absent on the built-in Workers AI models; set on an account's own provider models. */
  provider?: AiProviderKind;
}

const GLM_FLASH: AiModelOption = {
  id: "glm-5.3-flash",
  name: "GLM 5.3 Flash",
  model: "@cf/zai-org/glm-5.3-flash",
  releasedAt: "2026-08-26",
  inputUsdPerMillion: 0.15,
  outputUsdPerMillion: 0.5,
  url: "https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/",
};
const GEMMA: AiModelOption = {
  id: "gemma-4-26b-a4b-it",
  name: "Gemma 4 26B A4B",
  model: "@cf/google/gemma-4-26b-a4b-it",
  releasedAt: "2026-04-04",
  inputUsdPerMillion: 0.1,
  outputUsdPerMillion: 0.3,
  url: "https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/",
};

/** Published USD / million tokens, checked against the provider on 2026-10-03. */
export const AI_MODEL_CATALOG: Readonly<Record<AiRole, readonly AiModelOption[]>> = {
  classification: [
    {
      id: "clef",
      name: "Clef",
      model: "@cf/cloudflare/clef",
      releasedAt: "2026-10-01",
      inputUsdPerMillion: 0.24,
      outputUsdPerMillion: 0,
      url: "https://developers.cloudflare.com/workers-ai/models/clef/",
    },
  ],
  fast: [GLM_FLASH, GEMMA],
  task: [GLM_FLASH, GEMMA],
};

export interface AiConfiguration {
  features: AiFeatures;
  models: AiModelSelection;
}

export const DEFAULT_AI_CONFIGURATION: AiConfiguration = {
  features: { knowledge: true, wiki: true, atlas: true, releaseNotes: true },
  models: { classification: "clef", fast: "glm-5.3-flash", task: "glm-5.3-flash" },
};

/**
 * When pushes to main update Knowledge (CORE-286): once they have paused for
 * `quietMinutes`, and never later than `maxWaitMinutes` after the first push
 * waiting. 0 means no wait.
 */
export interface KnowledgeUpdateSchedule {
  quietMinutes: number;
  maxWaitMinutes: number;
}

export const DEFAULT_KNOWLEDGE_SCHEDULE: KnowledgeUpdateSchedule = {
  quietMinutes: 10,
  maxWaitMinutes: 30,
};

/** The longest either wait may be: one day. */
export const MAX_KNOWLEDGE_WAIT_MINUTES = 1440;

/**
 * What AI Gateway logs keep (CORE-290): every model call's metadata (model,
 * time, tokens) always; its request and response bodies only where this is on
 * for the call's component and account. One entry per kind of AI work.
 */
export type AiLogComponent =
  | "knowledge"
  | "assistant"
  | "assistant-titles"
  | "avatars"
  | "release-notes"
  | "merge-queue";

export const AI_LOG_COMPONENTS: readonly {
  id: AiLogComponent;
  label: string;
  description: string;
}[] = [
  {
    id: "knowledge",
    label: "Knowledge",
    description:
      "Repository analysis, concepts, wiki pages, Atlas descriptions, embeddings and search.",
  },
  {
    id: "assistant",
    label: "Assistant",
    description: "Assistant conversations, including their routing.",
  },
  {
    id: "assistant-titles",
    label: "Assistant titles and status lines",
    description: "The short titles and progress lines written for assistant conversations.",
  },
  { id: "avatars", label: "Generated pictures", description: "Profile picture generation." },
  {
    id: "release-notes",
    label: "Release notes",
    description: "Automatically generated release notes.",
  },
  {
    id: "merge-queue",
    label: "Merge queue",
    description: "Merge queue decisions on batching changes and repairing simple conflicts.",
  },
];

/** The plain retention note shown wherever this setting is. */
export const AI_LOG_BODIES_NOTE =
  "While this is on, prompts and replies, including repository code and assistant conversations, may be stored in Cloudflare's AI Gateway logs and read by people with access to those logs. Storage is subject to Cloudflare's limits: accounts whose first gateway predates September 24, 2026 use Legacy Logs (10 MB per log; oversized logs are not stored). Legacy logs remain until deleted; at capacity the gateway can stop saving or delete the oldest logs, depending on its configuration. Newer customers use Workers Logs (256 KB per log; oversized logs are truncated; retention is 3 days on Free or 7 days on Paid). Turning this off does not delete bodies already stored.";

/** One component's body logging: the site default, and an account's override. */
export interface AiLogBodiesEntry {
  component: AiLogComponent;
  label: string;
  description: string;
  /** The site default: its stored choice, else the environment's default. */
  site: boolean;
  siteFrom: "site" | "environment";
  /** The account's override (account views only); null follows the site. */
  account?: boolean | null;
  /** What this account's calls (the site's, on the site view) get. */
  effective: boolean;
}

export interface AiLogBodiesView {
  /** This environment's default: off once deployed, on in development. */
  environmentDefault: boolean;
  components: AiLogBodiesEntry[];
  note: string;
}

/** Per component: true or false sets it, null removes the choice (inherit). */
export type AiLogBodiesPatch = Partial<Record<AiLogComponent, boolean | null>>;

/** GET/PATCH /api/admin/ai: site defaults, for site administrators. */
export interface SiteAiSettingsView {
  logBodies: AiLogBodiesView;
  canManage: boolean;
}

export interface SiteAiSettingsPatch {
  logBodies?: AiLogBodiesPatch;
}

export interface AiSettings extends AiConfiguration {
  knowledgeUpdates: KnowledgeUpdateSchedule;
  updatedAt: string | null;
  updatedBy: string | null;
}

export type AiModelCatalog = Readonly<Record<AiRole, readonly AiModelOption[]>>;

/** GET/PATCH /api/accounts/:slug/settings/ai. */
export interface AiSettingsView extends AiSettings {
  canManage: boolean;
  /** The built-in models, then the models this account added from its providers. */
  catalog: AiModelCatalog;
  /** Gateway body logging for this account's calls: site defaults and its overrides. */
  logBodies: AiLogBodiesView;
}

export interface AiSettingsPatch {
  features?: Partial<AiFeatures>;
  models?: Partial<AiModelSelection>;
  knowledgeUpdates?: Partial<KnowledgeUpdateSchedule>;
  logBodies?: AiLogBodiesPatch;
}

/** Frozen when work starts; retries and continuations keep this exact policy. */
export interface AiSnapshot {
  version: 1;
  features: AiFeatures;
  models: AiModels;
  /**
   * USD per million input and output tokens of the provider models among
   * `models`, as published when the work started (Atlas budgets spend at them).
   */
  prices?: Record<string, { input: number; output: number }>;
  updatedAt: string | null;
}

// Work accepted before account settings existed must keep the old model policy,
// including Qwen task synthesis. Never resolve a missing snapshot from live settings.
export const LEGACY_AI_SNAPSHOT: AiSnapshot = {
  version: 1,
  features: { knowledge: true, wiki: true, atlas: true, releaseNotes: true },
  models: {
    classification: "@cf/cloudflare/clef",
    fast: "@cf/zai-org/glm-5.3-flash",
    task: "@cf/qwen/qwen3.8-27b",
  },
  updatedAt: null,
};

// ---- an account's own providers (CORE-294) ------------------------------------

/**
 * Providers an account connects with its own API key. Their calls go straight
 * to the provider, billed to that key: not through Workers AI or AI Gateway.
 */
export type AiProviderKind = "typesafe" | "openrouter";

/** What a provider model can do here: answer typed questions, or write text. */
export type AiCapability = "classification" | "generation";

/** Which roles a model of each capability can fill. */
export const CAPABILITY_ROLES: Readonly<Record<AiCapability, readonly AiRole[]>> = {
  classification: ["classification"],
  generation: ["fast", "task"],
};

export interface AiProviderInfo {
  kind: AiProviderKind;
  name: string;
  description: string;
  /** Where a person creates an API key. */
  keysUrl: string;
}

export const AI_PROVIDERS: readonly AiProviderInfo[] = [
  {
    kind: "typesafe",
    name: "TypeSafe",
    description:
      "Jev answers typed questions with calibrated probabilities. It can be the Classification model.",
    keysUrl: "https://typesafe.ai",
  },
  {
    kind: "openrouter",
    name: "OpenRouter",
    description:
      "Hundreds of text models from many vendors behind one key. They can be the Fast or Task model.",
    keysUrl: "https://openrouter.ai/settings/keys",
  },
];

export function providerModelId(kind: AiProviderKind, model: string): ProviderModelId {
  return `${kind}:${model}`;
}

/** The provider and model of `<provider>:<model>`; null for a built-in model id. */
export function parseProviderModelId(
  id: string,
): { provider: AiProviderKind; model: string } | null {
  const at = id.indexOf(":");
  if (at <= 0) return null;
  const provider = id.slice(0, at);
  const model = id.slice(at + 1);
  if (!model || !AI_PROVIDERS.some((info) => info.kind === provider)) return null;
  return { provider: provider as AiProviderKind, model };
}

/** A model an account made available from one of its providers. */
export interface AiProviderModel extends AiModelOption {
  id: ProviderModelId;
  provider: AiProviderKind;
  capability: AiCapability;
  contextLength: number | null;
  /** False when the provider doesn't advertise a JSON response mode. */
  jsonMode: boolean;
  /** When this model and its prices were read from the provider. */
  pricesCheckedAt: string;
}

/** A model a provider offers, before an account adds it. */
export type AiProviderCatalogEntry = Omit<AiProviderModel, "id" | "pricesCheckedAt"> & {
  id: ProviderModelId;
  description: string;
};

export interface AiProviderView extends AiProviderInfo {
  connected: boolean;
  /** The key's last four characters; the key itself never leaves the server. */
  keyLastFour: string | null;
  connectedAt: string | null;
  connectedBy: string | null;
  models: AiProviderModel[];
}

/** GET /api/accounts/:slug/ai-providers. */
export interface AiProvidersView {
  canManage: boolean;
  providers: AiProviderView[];
  /** The account's current choices, so a page can say which models are in use. */
  selection: AiModelSelection;
}

/** GET /api/accounts/:slug/ai-providers/:kind/catalog. */
export interface AiProviderCatalogView {
  provider: AiProviderKind;
  models: AiProviderCatalogEntry[];
  fetchedAt: string;
}
