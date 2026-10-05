// /api/accounts/:slug/ai-providers (CORE-294): an account's own AI providers.
// Members can see which providers are connected and which models they offer;
// only a person who manages the account's AI settings can change them, since
// a key spends money. The API key is verified with the provider before it is
// sealed and stored, and is never returned: views carry its last four.
//
//   GET    /                      AiProvidersView
//   GET    /:kind/catalog         the provider's models (OpenRouter: its live list)
//   PUT    /:kind                 { apiKey }: connect, or replace the key
//   DELETE /:kind                 disconnect, unless one of its models is in use
//   POST   /:kind/models          { model }: make a model available
//   DELETE /:kind/models?model=   remove one, unless it is in use
//   POST   /:kind/models/refresh  re-read names and prices from the provider

import { Hono, type Context } from "hono";
import {
  AI_PROVIDERS,
  providerModelId,
  type AiProviderCatalogView,
  type AiProviderKind,
  type AiProvidersView,
} from "../../shared/ai.ts";
import { seal } from "../../registry/core/seal.ts";
import { fail, requireActor, requirePerson } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { db, nowIso } from "../schema.ts";
import { aiSettings, load } from "../settings/ai.ts";
import { checkKey, providerCatalog } from "./providers.ts";
import { modelDetails, newProviderId, providerViews } from "./store.ts";

export const aiProvidersApi = new Hono<AppEnv>();

const ROLE_NAMES = { classification: "Classification", fast: "Fast", task: "Task" } as const;

function kindOf(c: Context<AppEnv>): AiProviderKind | null {
  const kind = c.req.param("kind");
  return AI_PROVIDERS.some((info) => info.kind === kind) ? (kind as AiProviderKind) : null;
}

const nameOf = (kind: AiProviderKind) => AI_PROVIDERS.find((info) => info.kind === kind)!.name;

async function view(d1: D1Database, accountId: string, canManage: boolean) {
  const [providers, settings] = await Promise.all([
    providerViews(d1, accountId),
    aiSettings(d1, accountId),
  ]);
  return { canManage, providers, selection: settings.models } satisfies AiProvidersView;
}

/** The account, for a person who may change its AI settings, or the failure to return. */
async function manager(c: Context<AppEnv>) {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor as Actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  if (found.role !== "admin")
    return fail(
      c,
      403,
      "Only the account owner, organization owners, or site admins can change AI providers.",
    );
  return found.account;
}

async function json(c: Context<AppEnv>): Promise<Record<string, unknown> | null> {
  try {
    const body = (await c.req.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Roles whose current choice is one of `ids`, in words: "Fast and Task". */
async function inUse(d1: D1Database, accountId: string, ids: (id: string) => boolean) {
  const { models } = await aiSettings(d1, accountId);
  const roles = (Object.keys(ROLE_NAMES) as (keyof typeof ROLE_NAMES)[]).filter((role) =>
    ids(models[role]),
  );
  return roles.map((role) => ROLE_NAMES[role]).join(" and ");
}

aiProvidersApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  return c.json(await view(c.env.DB, found.account.id, found.role === "admin" && !actor.agent));
});

aiProvidersApi.get("/:kind/catalog", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const kind = kindOf(c);
  if (!kind) return fail(c, 404, "No such AI provider.");
  if (!(await load(c, actor))) return fail(c, 404, "No such account, or you aren't a member.");
  try {
    const catalog = await providerCatalog(kind);
    return c.json<AiProviderCatalogView>({ provider: kind, ...catalog });
  } catch {
    return fail(c, 502, `Couldn't read ${nameOf(kind)}'s models. Try again in a moment.`);
  }
});

aiProvidersApi.put("/:kind", async (c) => {
  const account = await manager(c);
  if (account instanceof Response) return account;
  const kind = kindOf(c);
  if (!kind) return fail(c, 404, "No such AI provider.");
  const body = await json(c);
  if (!body) return fail(c, 400, "Send a JSON object with apiKey.");
  for (const key of Object.keys(body))
    if (key !== "apiKey") return fail(c, 400, `Unknown field: ${key}.`);
  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length < 8 || apiKey.length > 512 || /\s/.test(apiKey))
    return fail(c, 400, `Enter the ${nameOf(kind)} API key, without spaces.`);
  const check = await checkKey(kind, apiKey);
  if (check === "invalid")
    return fail(c, 400, `${nameOf(kind)} didn't accept that API key. Check it and try again.`);
  if (check === "unreachable")
    return fail(
      c,
      502,
      `Couldn't reach ${nameOf(kind)} to check the key. Nothing was saved; try again.`,
    );
  const actor = c.get("actor")!;
  const values = {
    key_sealed: await seal(c.env, apiKey),
    key_last_four: apiKey.slice(-4),
    updated_by: actor.id,
    updated_at: nowIso(),
  };
  // Replacing a key keeps the row, so running work picks up the new key.
  await db(c.env.DB)
    .insertInto("ai_providers")
    .values({ ...values, id: newProviderId(), account_id: account.id, kind })
    .onConflict((oc) => oc.columns(["account_id", "kind"]).doUpdateSet(values))
    .execute();
  return c.json(await view(c.env.DB, account.id, true));
});

aiProvidersApi.delete("/:kind", async (c) => {
  const account = await manager(c);
  if (account instanceof Response) return account;
  const kind = kindOf(c);
  if (!kind) return fail(c, 404, "No such AI provider.");
  // One statement: a choice saved concurrently can't slip between check and delete.
  const deleted = await c.env.DB.prepare(
    `DELETE FROM ai_providers WHERE account_id = ?1 AND kind = ?2 AND NOT EXISTS (
       SELECT 1 FROM account_settings s WHERE s.account_id = ?1 AND (
         s.ai_classification_model LIKE ?3 OR s.ai_fast_model LIKE ?3 OR s.ai_task_model LIKE ?3))`,
  )
    .bind(account.id, kind, `${kind}:%`)
    .run();
  if (!deleted.meta.changes) {
    const roles = await inUse(c.env.DB, account.id, (id) => id.startsWith(`${kind}:`));
    if (roles)
      return fail(
        c,
        409,
        `${nameOf(kind)} models are in use for ${roles}. Choose other models in AI settings first.`,
      );
    return fail(c, 404, `${nameOf(kind)} isn't connected.`);
  }
  return c.json(await view(c.env.DB, account.id, true));
});

async function connected(d1: D1Database, accountId: string, kind: AiProviderKind) {
  return db(d1)
    .selectFrom("ai_providers")
    .select("id")
    .where("account_id", "=", accountId)
    .where("kind", "=", kind)
    .executeTakeFirst();
}

aiProvidersApi.post("/:kind/models", async (c) => {
  const account = await manager(c);
  if (account instanceof Response) return account;
  const kind = kindOf(c);
  if (!kind) return fail(c, 404, "No such AI provider.");
  const body = await json(c);
  if (!body || typeof body.model !== "string" || Object.keys(body).length !== 1)
    return fail(c, 400, "Send a JSON object with the provider's model id as model.");
  const provider = await connected(c.env.DB, account.id, kind);
  if (!provider) return fail(c, 409, `Connect ${nameOf(kind)} with an API key first.`);
  let catalog;
  try {
    catalog = await providerCatalog(kind);
  } catch {
    return fail(c, 502, `Couldn't read ${nameOf(kind)}'s models. Try again in a moment.`);
  }
  // Names and prices come from the provider, never from the request.
  const entry = catalog.models.find((model) => model.model === body.model);
  if (!entry) return fail(c, 404, `${nameOf(kind)} doesn't offer ${body.model}.`);
  const values = {
    name: entry.name,
    capability: entry.capability,
    details: modelDetails(entry),
    context_length: entry.contextLength,
    json_mode: Number(entry.jsonMode),
    added_by: c.get("actor")!.id,
    checked_at: nowIso(),
  };
  await db(c.env.DB)
    .insertInto("ai_provider_models")
    .values({ ...values, provider_id: provider.id, model: entry.model })
    .onConflict((oc) => oc.columns(["provider_id", "model"]).doUpdateSet(values))
    .execute();
  return c.json(await view(c.env.DB, account.id, true));
});

aiProvidersApi.delete("/:kind/models", async (c) => {
  const account = await manager(c);
  if (account instanceof Response) return account;
  const kind = kindOf(c);
  if (!kind) return fail(c, 404, "No such AI provider.");
  const model = c.req.query("model");
  if (!model) return fail(c, 400, "Name the model to remove: ?model=<provider model id>.");
  const id = providerModelId(kind, model);
  const deleted = await c.env.DB.prepare(
    `DELETE FROM ai_provider_models
     WHERE model = ?1 AND provider_id = (
       SELECT id FROM ai_providers WHERE account_id = ?2 AND kind = ?3)
     AND NOT EXISTS (
       SELECT 1 FROM account_settings s WHERE s.account_id = ?2
         AND ?4 IN (s.ai_classification_model, s.ai_fast_model, s.ai_task_model))`,
  )
    .bind(model, account.id, kind, id)
    .run();
  if (!deleted.meta.changes) {
    const roles = await inUse(c.env.DB, account.id, (selected) => selected === id);
    if (roles)
      return fail(
        c,
        409,
        `${model} is in use for ${roles}. Choose another model in AI settings first.`,
      );
    return fail(c, 404, `${model} isn't one of this account's ${nameOf(kind)} models.`);
  }
  return c.json(await view(c.env.DB, account.id, true));
});

aiProvidersApi.post("/:kind/models/refresh", async (c) => {
  const account = await manager(c);
  if (account instanceof Response) return account;
  const kind = kindOf(c);
  if (!kind) return fail(c, 404, "No such AI provider.");
  const provider = await connected(c.env.DB, account.id, kind);
  if (!provider) return fail(c, 409, `Connect ${nameOf(kind)} with an API key first.`);
  let catalog;
  try {
    catalog = await providerCatalog(kind);
  } catch {
    return fail(c, 502, `Couldn't read ${nameOf(kind)}'s models. Try again in a moment.`);
  }
  const stored = await db(c.env.DB)
    .selectFrom("ai_provider_models")
    .select("model")
    .where("provider_id", "=", provider.id)
    .execute();
  const now = nowIso();
  // A model the provider no longer lists keeps its last known prices.
  const updates = stored.flatMap(({ model }) => {
    const entry = catalog.models.find((offered) => offered.model === model);
    return entry
      ? [
          db(c.env.DB)
            .updateTable("ai_provider_models")
            .set({
              name: entry.name,
              details: modelDetails(entry),
              context_length: entry.contextLength,
              json_mode: Number(entry.jsonMode),
              checked_at: now,
            })
            .where("provider_id", "=", provider.id)
            .where("model", "=", model)
            .execute(),
        ]
      : [];
  });
  await Promise.all(updates);
  return c.json(await view(c.env.DB, account.id, true));
});
