import { Hono, type Context } from "hono";
import type { Insertable } from "kysely";
import {
  AI_MODEL_CATALOG,
  DEFAULT_AI_CONFIGURATION,
  type AiRole,
  type AiSettings,
  type AiSettingsPatch,
  type AiSettingsView,
  type AiSnapshot,
} from "../../shared/ai.ts";
import { fail, requireActor, requirePerson } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import { findAccountBySlug, type AccountRow, type Actor } from "../db.ts";
import { db, nowIso, type Database } from "../schema.ts";

/** Stored account choices, independent of preview retention and its provenance. */
export async function aiSettings(d1: D1Database, accountId: string): Promise<AiSettings> {
  const row = await db(d1)
    .selectFrom("account_settings as s")
    .leftJoin("accounts as a", "a.id", "s.ai_updated_by")
    .select([
      "s.ai_knowledge",
      "s.ai_wiki",
      "s.ai_atlas",
      "s.ai_release_notes",
      "s.ai_classification_model",
      "s.ai_fast_model",
      "s.ai_task_model",
      "s.ai_updated_at",
      "a.slug",
    ])
    .where("s.account_id", "=", accountId)
    .executeTakeFirst();
  if (!row)
    return {
      features: { ...DEFAULT_AI_CONFIGURATION.features },
      models: { ...DEFAULT_AI_CONFIGURATION.models },
      updatedAt: null,
      updatedBy: null,
    };
  return {
    features: {
      knowledge: row.ai_knowledge === 1,
      wiki: row.ai_wiki === 1,
      atlas: row.ai_atlas === 1,
      releaseNotes: row.ai_release_notes === 1,
    },
    models: {
      classification: row.ai_classification_model,
      fast: row.ai_fast_model,
      task: row.ai_task_model,
    },
    updatedAt: row.ai_updated_at,
    updatedBy: row.slug,
  };
}

/** Resolve only at admission; running work must persist and reuse this snapshot. */
export async function repoAiSnapshot(d1: D1Database, repoId: string): Promise<AiSnapshot> {
  const repo = await db(d1)
    .selectFrom("repos")
    .select("owner_id")
    .where("id", "=", repoId)
    .executeTakeFirst();
  if (!repo) throw new Error("Cannot resolve AI settings: no such repository.");
  const settings = await aiSettings(d1, repo.owner_id);
  const model = (role: AiRole) => {
    const option = AI_MODEL_CATALOG[role].find((entry) => entry.id === settings.models[role]);
    if (!option) throw new Error(`Invalid stored AI model for ${role}.`);
    return option.model;
  };
  return {
    version: 1,
    features: settings.features,
    models: { classification: model("classification"), fast: model("fast"), task: model("task") },
    updatedAt: settings.updatedAt,
  };
}

async function standing(d1: D1Database, account: AccountRow, actor: Actor) {
  if (actor.isSiteAdmin) return "admin";
  if (account.kind === "user") return account.id === actor.id ? "admin" : "none";
  const membership = await db(d1)
    .selectFrom("org_members")
    .select("role")
    .where("org_id", "=", account.id)
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  if (!membership) return "none";
  return membership.role === "owner" ? "admin" : "member";
}

async function load(c: Context<AppEnv>, actor: Actor) {
  const account = await findAccountBySlug(c.env.DB, c.req.param("slug") ?? "");
  const role = account ? await standing(c.env.DB, account, actor) : "none";
  return account && role !== "none" ? { account, role } : null;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(body: unknown): AiSettingsPatch | string {
  if (!object(body)) return "AI settings must be a JSON object.";
  for (const key of Object.keys(body))
    if (key !== "features" && key !== "models") return `Unknown field: ${key}.`;
  if (body.features !== undefined) {
    if (!object(body.features)) return "features must be an object of boolean toggles.";
    for (const [key, value] of Object.entries(body.features)) {
      if (!Object.hasOwn(DEFAULT_AI_CONFIGURATION.features, key))
        return `Unknown field: features.${key}.`;
      if (typeof value !== "boolean") return `features.${key} must be a boolean.`;
    }
  }
  if (body.models !== undefined) {
    if (!object(body.models)) return "models must be an object of curated model choices.";
    for (const [key, value] of Object.entries(body.models)) {
      if (!Object.hasOwn(AI_MODEL_CATALOG, key)) return `Unknown field: models.${key}.`;
      const options = AI_MODEL_CATALOG[key as AiRole];
      if (!options.some((option) => option.id === value))
        return `models.${key} must be one of: ${options.map((option) => option.id).join(", ")}.`;
    }
  }
  return body as AiSettingsPatch;
}

export const aiSettingsApi = new Hono<AppEnv>();

aiSettingsApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  return c.json<AiSettingsView>({
    ...(await aiSettings(c.env.DB, found.account.id)),
    canManage: found.role === "admin" && !actor.agent,
    catalog: AI_MODEL_CATALOG,
  });
});

aiSettingsApi.patch("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  if (found.role !== "admin")
    return fail(
      c,
      403,
      "Only the account owner, organization owners, or site admins can change AI settings.",
    );
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "AI settings must be valid JSON.");
  }
  const patch = validate(body);
  if (typeof patch === "string") return fail(c, 400, patch);
  // Only supplied columns participate in the upsert. No read/merge/write window:
  // concurrent changes to other choices or preview retention cannot be overwritten.
  const values: Partial<Insertable<Database["account_settings"]>> = {};
  if (patch.features?.knowledge !== undefined)
    values.ai_knowledge = Number(patch.features.knowledge);
  if (patch.features?.wiki !== undefined) values.ai_wiki = Number(patch.features.wiki);
  if (patch.features?.atlas !== undefined) values.ai_atlas = Number(patch.features.atlas);
  if (patch.features?.releaseNotes !== undefined)
    values.ai_release_notes = Number(patch.features.releaseNotes);
  if (patch.models?.classification !== undefined)
    values.ai_classification_model = patch.models.classification;
  if (patch.models?.fast !== undefined) values.ai_fast_model = patch.models.fast;
  if (patch.models?.task !== undefined) values.ai_task_model = patch.models.task;
  if (Object.keys(values).length) {
    values.ai_updated_by = actor.id;
    values.ai_updated_at = nowIso();
    await db(c.env.DB)
      .insertInto("account_settings")
      .values({ ...values, account_id: found.account.id })
      .onConflict((oc) => oc.column("account_id").doUpdateSet(values))
      .execute();
  }
  return c.json<AiSettingsView>({
    ...(await aiSettings(c.env.DB, found.account.id)),
    canManage: true,
    catalog: AI_MODEL_CATALOG,
  });
});
