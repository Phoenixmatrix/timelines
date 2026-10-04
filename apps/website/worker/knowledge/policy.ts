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
  return { ai, atlas: await atlasSettings(env, repoId, ai.models.task) };
}
