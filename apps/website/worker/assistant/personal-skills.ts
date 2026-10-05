import type { Selectable } from "kysely";
import {
  ASSISTANT_SKILL_LIMITS,
  type PersonalAssistantSkill,
  type PersonalAssistantSkillInput,
} from "../../shared/assistant-skills.ts";
import { db, type Database } from "../schema.ts";

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function validatePersonalSkill(value: unknown): PersonalAssistantSkillInput | string {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return "Skill must be a JSON object.";
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (!["name", "description", "body", "enabled"].includes(key)) return `Unknown field: ${key}.`;
  if (typeof input.name !== "string" || !SKILL_NAME.test(input.name))
    return "Name must be 1–64 lowercase letters, digits or hyphens, starting with a letter or digit.";
  const description = input.description === undefined ? "" : input.description;
  if (typeof description !== "string" || description.length > ASSISTANT_SKILL_LIMITS.description)
    return "Description must be at most 500 characters.";
  if (
    typeof input.body !== "string" ||
    !input.body.trim() ||
    input.body.length > ASSISTANT_SKILL_LIMITS.body
  )
    return "Instructions must be nonblank and at most 20000 characters.";
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") return "Enabled must be a boolean.";
  return { name: input.name, description, body: input.body, enabled };
}

export function personalSkill(
  row: Selectable<Database["assistant_personal_skills"]>,
): PersonalAssistantSkill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    body: row.body,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function personalSkills(
  d1: D1Database,
  userId: string,
): Promise<PersonalAssistantSkill[]> {
  const rows = await db(d1)
    .selectFrom("assistant_personal_skills")
    .selectAll()
    .where("user_id", "=", userId)
    .orderBy("name")
    .execute();
  return rows.map(personalSkill);
}
