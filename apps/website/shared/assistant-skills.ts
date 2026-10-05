export type AssistantSkillSource = "builtin" | "personal" | "repository";

export interface AssistantSkillSummary {
  id: string;
  name: string;
  description: string;
  source: AssistantSkillSource;
}

export interface PersonalAssistantSkillInput {
  name: string;
  description: string;
  body: string;
  enabled: boolean;
}

export interface PersonalAssistantSkill extends PersonalAssistantSkillInput {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface AssistantSkillInvocation extends AssistantSkillSummary {
  /** Original repository scope, retained across navigation continuations. */
  repo?: string;
}

export const ASSISTANT_SKILL_LIMITS = { name: 64, description: 500, body: 20000 } as const;
