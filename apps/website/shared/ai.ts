// Curated account-wide configuration for automatic AI work. Interactive chat
// and the fixed-dimension embedding model are deliberately outside this catalog.
export type AiRole = "classification" | "fast" | "task";
export type ClassificationModel = "clef";
export type GenerationModel = "glm-5.3-flash" | "gemma-4-26b-a4b-it";

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
  model: string;
  releasedAt: string;
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  url: string;
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
  "While this is on, prompts and replies, including repository code and assistant conversations, are kept in Cloudflare's AI Gateway logs. Anyone with access to the Cloudflare account's dashboard can read them, and the gateway deletes the oldest logs first once it reaches its log limit.";

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

/** GET/PATCH /api/accounts/:slug/settings/ai. */
export interface AiSettingsView extends AiSettings {
  canManage: boolean;
  catalog: typeof AI_MODEL_CATALOG;
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
