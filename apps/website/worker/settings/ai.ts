import { Hono, type Context } from "hono";
import type { Insertable } from "kysely";
import {
  AI_LOG_BODIES_NOTE,
  AI_LOG_COMPONENTS,
  AI_MODEL_CATALOG,
  DEFAULT_AI_CONFIGURATION,
  DEFAULT_KNOWLEDGE_SCHEDULE,
  DEFAULT_RELEASE_HIGHLIGHTS_SCHEDULE,
  MAX_KNOWLEDGE_WAIT_MINUTES,
  MAX_RELEASE_HIGHLIGHTS_INTERVAL_HOURS,
  parseProviderModelId,
  type AiLogBodiesPatch,
  type AiLogBodiesView,
  type AiModelCatalog,
  type AiRole,
  type AiSettings,
  type AiSettingsPatch,
  type AiSettingsView,
  type AiSnapshot,
  type KnowledgeUpdateSchedule,
  type SiteAiSettingsPatch,
  type SiteAiSettingsView,
} from "../../shared/ai.ts";
import { environmentKeepsBodies, forgetLogBodySettings } from "../ai-gateway.ts";
import { accountCatalog, resolveProviderModel } from "../ai-providers/store.ts";
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
      "s.knowledge_quiet_minutes",
      "s.knowledge_max_wait_minutes",
      "s.release_highlights_interval_hours",
      "a.slug",
    ])
    .where("s.account_id", "=", accountId)
    .executeTakeFirst();
  if (!row)
    return {
      features: { ...DEFAULT_AI_CONFIGURATION.features },
      models: { ...DEFAULT_AI_CONFIGURATION.models },
      knowledgeUpdates: { ...DEFAULT_KNOWLEDGE_SCHEDULE },
      releaseHighlights: { ...DEFAULT_RELEASE_HIGHLIGHTS_SCHEDULE },
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
    knowledgeUpdates: {
      quietMinutes: row.knowledge_quiet_minutes,
      maxWaitMinutes: row.knowledge_max_wait_minutes,
    },
    releaseHighlights: { intervalHours: row.release_highlights_interval_hours },
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
  return accountAiSnapshot(d1, repo.owner_id);
}

/** Resolve account-owned work without inventing a repository for site/tracker scopes. */
export async function accountAiSnapshot(d1: D1Database, accountId: string): Promise<AiSnapshot> {
  const account = await db(d1)
    .selectFrom("accounts")
    .select("id")
    .where("id", "=", accountId)
    .executeTakeFirst();
  if (!account) throw new Error("Cannot resolve AI settings: no such account.");
  const settings = await aiSettings(d1, accountId);
  const prices: NonNullable<AiSnapshot["prices"]> = {};
  const builtIn = (role: AiRole, id: string) => {
    const option = AI_MODEL_CATALOG[role].find((entry) => entry.id === id);
    if (!option) throw new Error(`Invalid stored AI model for ${role}.`);
    return option.model;
  };
  const model = async (role: AiRole) => {
    const id = settings.models[role];
    const custom = parseProviderModelId(id);
    if (!custom) return builtIn(role, id);
    const resolved = await resolveProviderModel(d1, accountId, custom.provider, custom.model);
    // Removing a model in use is refused (worker/ai-providers/api.ts); should one
    // still go missing, new work uses the default rather than failing every read.
    if (!resolved) {
      console.warn(`AI settings: ${id} is no longer available; using the default ${role} model.`);
      return builtIn(role, DEFAULT_AI_CONFIGURATION.models[role]);
    }
    if (!resolved.option.variablePricing)
      prices[resolved.ref] = {
        input: resolved.option.inputUsdPerMillion,
        output: resolved.option.outputUsdPerMillion,
      };
    return resolved.ref;
  };
  const [classification, fast, task] = await Promise.all([
    model("classification"),
    model("fast"),
    model("task"),
  ]);
  return {
    version: 1,
    features: settings.features,
    models: { classification, fast, task },
    ...(Object.keys(prices).length ? { prices } : {}),
    updatedAt: settings.updatedAt,
  };
}

/**
 * When a repository's pushes update its Knowledge (CORE-286): its account's
 * schedule, in milliseconds. Development environments may shorten both waits
 * (`GITMATRIX_KNOWLEDGE_QUIET_SECONDS` and `GITMATRIX_KNOWLEDGE_MAX_WAIT_SECONDS`,
 * the KNOWLEDGE_QUIET_SECONDS / KNOWLEDGE_MAX_WAIT_SECONDS text bindings);
 * deployed Workers use the account's settings.
 */
export async function knowledgeSchedule(
  env: Env,
  repoId: string,
): Promise<{ quietMs: number; maxWaitMs: number }> {
  const repo = await db(env.DB)
    .selectFrom("repos")
    .select("owner_id")
    .where("id", "=", repoId)
    .executeTakeFirst();
  const schedule: KnowledgeUpdateSchedule = repo
    ? (await aiSettings(env.DB, repo.owner_id)).knowledgeUpdates
    : DEFAULT_KNOWLEDGE_SCHEDULE;
  const seconds = (name: string) => {
    const raw = Reflect.get(env, name);
    const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  return {
    quietMs: (seconds("KNOWLEDGE_QUIET_SECONDS") ?? schedule.quietMinutes * 60) * 1000,
    maxWaitMs: (seconds("KNOWLEDGE_MAX_WAIT_SECONDS") ?? schedule.maxWaitMinutes * 60) * 1000,
  };
}

/**
 * Gateway body logging (CORE-290) as the site sets it, and with `accountId`
 * that account's overrides and what its calls get. Read fresh, not from the
 * per-call cache in worker/ai-gateway.ts.
 */
export async function logBodiesView(env: Env, accountId: string | null): Promise<AiLogBodiesView> {
  const [site, account] = await Promise.all([
    db(env.DB).selectFrom("site_ai_log_bodies").select(["component", "keep"]).execute(),
    accountId
      ? db(env.DB)
          .selectFrom("account_ai_log_bodies")
          .select(["component", "keep"])
          .where("account_id", "=", accountId)
          .execute()
      : Promise.resolve([]),
  ]);
  const environmentDefault = environmentKeepsBodies(env);
  const stored = (rows: { component: string; keep: number }[], id: string) => {
    const row = rows.find((r) => r.component === id);
    return row ? row.keep === 1 : null;
  };
  return {
    environmentDefault,
    note: AI_LOG_BODIES_NOTE,
    components: AI_LOG_COMPONENTS.map(({ id, label, description }) => {
      const siteChoice = stored(site, id);
      const siteValue = siteChoice ?? environmentDefault;
      const accountChoice = accountId ? stored(account, id) : null;
      return {
        component: id,
        label,
        description,
        site: siteValue,
        siteFrom: siteChoice === null ? "environment" : "site",
        ...(accountId ? { account: accountChoice } : {}),
        effective: accountChoice ?? siteValue,
      };
    }),
  };
}

function validateLogBodies(value: unknown, field: string): AiLogBodiesPatch | string {
  if (!object(value)) return `${field} must be an object of components, each true, false or null.`;
  for (const [key, choice] of Object.entries(value)) {
    if (!AI_LOG_COMPONENTS.some((component) => component.id === key))
      return `Unknown component: ${field}.${key}. Components: ${AI_LOG_COMPONENTS.map((c) => c.id).join(", ")}.`;
    if (choice !== null && typeof choice !== "boolean")
      return `${field}.${key} must be true, false or null (inherit).`;
  }
  return value as AiLogBodiesPatch;
}

/** Store a level's choices: true/false sets, null removes (inherit). */
async function saveLogBodies(
  d1: D1Database,
  accountId: string | null,
  patch: AiLogBodiesPatch,
  actorId: string,
) {
  const statements: D1PreparedStatement[] = [];
  const now = nowIso();
  for (const [component, choice] of Object.entries(patch)) {
    if (accountId === null)
      statements.push(
        choice === null
          ? d1.prepare("DELETE FROM site_ai_log_bodies WHERE component = ?1").bind(component)
          : d1
              .prepare(
                `INSERT INTO site_ai_log_bodies (component, keep, updated_by, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (component) DO UPDATE SET
                   keep = excluded.keep, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
              )
              .bind(component, Number(choice), actorId, now),
      );
    else
      statements.push(
        choice === null
          ? d1
              .prepare("DELETE FROM account_ai_log_bodies WHERE account_id = ?1 AND component = ?2")
              .bind(accountId, component)
          : d1
              .prepare(
                `INSERT INTO account_ai_log_bodies (account_id, component, keep, updated_by, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (account_id, component) DO UPDATE SET
                   keep = excluded.keep, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
              )
              .bind(accountId, component, Number(choice), actorId, now),
      );
  }
  if (statements.length) await d1.batch(statements);
  forgetLogBodySettings(d1);
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

/** The account named in the route and the actor's standing in it; null when not a member. */
export async function load(c: Context<AppEnv>, actor: Actor) {
  const account = await findAccountBySlug(c.env.DB, c.req.param("slug") ?? "");
  const role = account ? await standing(c.env.DB, account, actor) : "none";
  return account && role !== "none" ? { account, role } : null;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validate(body: unknown, catalog: AiModelCatalog): AiSettingsPatch | string {
  if (!object(body)) return "AI settings must be a JSON object.";
  for (const key of Object.keys(body))
    if (
      key !== "features" &&
      key !== "models" &&
      key !== "knowledgeUpdates" &&
      key !== "releaseHighlights" &&
      key !== "logBodies"
    )
      return `Unknown field: ${key}.`;
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
      const options = catalog[key as AiRole];
      if (!options.some((option) => option.id === value))
        return `models.${key} must be one of: ${options.map((option) => option.id).join(", ")}.`;
    }
  }
  if (body.knowledgeUpdates !== undefined) {
    if (!object(body.knowledgeUpdates))
      return "knowledgeUpdates must be an object of waits in minutes.";
    for (const [key, value] of Object.entries(body.knowledgeUpdates)) {
      if (!Object.hasOwn(DEFAULT_KNOWLEDGE_SCHEDULE, key))
        return `Unknown field: knowledgeUpdates.${key}.`;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > MAX_KNOWLEDGE_WAIT_MINUTES
      )
        return `knowledgeUpdates.${key} must be a whole number of minutes from 0 to ${MAX_KNOWLEDGE_WAIT_MINUTES}.`;
    }
  }
  if (body.releaseHighlights !== undefined) {
    if (!object(body.releaseHighlights))
      return "releaseHighlights must be an object of intervals in hours.";
    for (const [key, value] of Object.entries(body.releaseHighlights)) {
      if (!Object.hasOwn(DEFAULT_RELEASE_HIGHLIGHTS_SCHEDULE, key))
        return `Unknown field: releaseHighlights.${key}.`;
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > MAX_RELEASE_HIGHLIGHTS_INTERVAL_HOURS
      )
        return `releaseHighlights.${key} must be a whole number of hours from 1 to ${MAX_RELEASE_HIGHLIGHTS_INTERVAL_HOURS}.`;
    }
  }
  if (body.logBodies !== undefined) {
    const logBodies = validateLogBodies(body.logBodies, "logBodies");
    if (typeof logBodies === "string") return logBodies;
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
    catalog: await accountCatalog(c.env.DB, found.account.id),
    logBodies: await logBodiesView(c.env, found.account.id),
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
  const patch = validate(body, await accountCatalog(c.env.DB, found.account.id));
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
  if (patch.knowledgeUpdates?.quietMinutes !== undefined)
    values.knowledge_quiet_minutes = patch.knowledgeUpdates.quietMinutes;
  if (patch.knowledgeUpdates?.maxWaitMinutes !== undefined)
    values.knowledge_max_wait_minutes = patch.knowledgeUpdates.maxWaitMinutes;
  if (patch.releaseHighlights?.intervalHours !== undefined)
    values.release_highlights_interval_hours = patch.releaseHighlights.intervalHours;
  if (Object.keys(values).length) {
    values.ai_updated_by = actor.id;
    values.ai_updated_at = nowIso();
    await db(c.env.DB)
      .insertInto("account_settings")
      .values({ ...values, account_id: found.account.id })
      .onConflict((oc) => oc.column("account_id").doUpdateSet(values))
      .execute();
  }
  if (patch.logBodies) await saveLogBodies(c.env.DB, found.account.id, patch.logBodies, actor.id);
  return c.json<AiSettingsView>({
    ...(await aiSettings(c.env.DB, found.account.id)),
    canManage: true,
    catalog: await accountCatalog(c.env.DB, found.account.id),
    logBodies: await logBodiesView(c.env, found.account.id),
  });
});

/**
 * GET/PATCH /api/admin/ai: the site's defaults (CORE-290: gateway body
 * logging), for site administrators; changing them takes a person.
 */
export const siteAiSettingsApi = new Hono<AppEnv>();

siteAiSettingsApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site administrators manage site AI settings.");
  return c.json<SiteAiSettingsView>({
    logBodies: await logBodiesView(c.env, null),
    canManage: !actor.agent,
  });
});

siteAiSettingsApi.patch("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site administrators manage site AI settings.");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 400, "Site AI settings must be valid JSON.");
  }
  if (!object(body)) return fail(c, 400, "Site AI settings must be a JSON object.");
  for (const key of Object.keys(body))
    if (key !== "logBodies") return fail(c, 400, `Unknown field: ${key}.`);
  const patch = body as SiteAiSettingsPatch;
  if (patch.logBodies !== undefined) {
    const logBodies = validateLogBodies(patch.logBodies, "logBodies");
    if (typeof logBodies === "string") return fail(c, 400, logBodies);
    await saveLogBodies(c.env.DB, null, logBodies, actor.id);
  }
  return c.json<SiteAiSettingsView>({
    logBodies: await logBodiesView(c.env, null),
    canManage: true,
  });
});
