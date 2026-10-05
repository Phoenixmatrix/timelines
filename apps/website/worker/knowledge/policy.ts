import { LEGACY_AI_SNAPSHOT, type AiSnapshot } from "../../shared/ai.ts";
import { repoAiSnapshot } from "../settings/ai.ts";
import { atlasSettings, resolveAtlasSettings, type AtlasSettings } from "./budget.ts";

/** Captured before Workflow creation; all durable steps and restarts reuse it. */
export interface KnowledgePolicy {
  ai: AiSnapshot;
  atlas: AtlasSettings;
}

/** Old Workflow payloads retain the pre-settings model and feature policy. */
export const LEGACY_KNOWLEDGE_POLICY: KnowledgePolicy = {
  ai: LEGACY_AI_SNAPSHOT,
  atlas: resolveAtlasSettings(null, null),
};

export async function knowledgePolicy(env: Env, repoId: string): Promise<KnowledgePolicy> {
  const ai = await repoAiSnapshot(env.DB, repoId);
  const atlas = await atlasSettings(env, repoId, ai.models.task);
  // An account's own provider model (CORE-294) spends at the price its provider
  // published; a configured environment's price table stays exactly as written.
  if (ai.prices && atlas.source === "default")
    return { ai, atlas: { ...atlas, prices: { ...atlas.prices, ...ai.prices } } };
  return { ai, atlas };
}
