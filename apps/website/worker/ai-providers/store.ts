// A Space's own AI providers and the models it made available (CORE-294),
// and how a job's frozen AI snapshot names them.
//
// Space settings store a provider model by its id, `<provider>:<model>`
// (shared/ai.ts). A snapshot, captured when work starts, names the provider
// row too, `<provider>:<provider row id>:<model>`, so a call made hours later
// by a workflow step finds its key after revalidating the work's current Space.

import { unseal } from "../../registry/core/seal.ts";
import {
  AI_MODEL_CATALOG,
  AI_PROVIDERS,
  CAPABILITY_ROLES,
  providerModelId,
  type AiModelCatalog,
  type AiModelOption,
  type AiProviderKind,
  type AiProviderModel,
  type AiProviderView,
  type AiRole,
} from "../../shared/ai.ts";
import { db } from "../schema.ts";

type Details = Omit<
  AiModelOption,
  "id" | "name" | "model" | "provider" | "capability" | "contextLength" | "jsonMode"
>;

/** The JSON kept in ai_provider_models.details. */
export function modelDetails(model: AiModelOption): string {
  const details: Details = {
    releasedAt: model.releasedAt,
    inputUsdPerMillion: model.inputUsdPerMillion,
    outputUsdPerMillion: model.outputUsdPerMillion,
    url: model.url,
  };
  if (model.cacheReadUsdPerMillion !== undefined)
    details.cacheReadUsdPerMillion = model.cacheReadUsdPerMillion;
  if (model.cacheWriteUsdPerMillion !== undefined)
    details.cacheWriteUsdPerMillion = model.cacheWriteUsdPerMillion;
  if (model.reasoningUsdPerMillion !== undefined)
    details.reasoningUsdPerMillion = model.reasoningUsdPerMillion;
  if (model.variablePricing) details.variablePricing = true;
  return JSON.stringify(details);
}

interface ModelRow {
  provider_id: string;
  kind: AiProviderKind;
  model: string;
  name: string;
  capability: AiProviderModel["capability"];
  details: string;
  context_length: number | null;
  json_mode: number;
  checked_at: string;
}

function toModel(row: ModelRow): AiProviderModel {
  return {
    ...(JSON.parse(row.details) as Details),
    id: providerModelId(row.kind, row.model),
    name: row.name,
    model: row.model,
    provider: row.kind,
    capability: row.capability,
    contextLength: row.context_length,
    jsonMode: row.json_mode === 1,
    pricesCheckedAt: row.checked_at,
  };
}

async function modelRows(d1: D1Database, spaceId: string): Promise<ModelRow[]> {
  return db(d1)
    .selectFrom("ai_provider_models as m")
    .innerJoin("ai_providers as p", "p.id", "m.provider_id")
    .select([
      "m.provider_id",
      "p.kind",
      "m.model",
      "m.name",
      "m.capability",
      "m.details",
      "m.context_length",
      "m.json_mode",
      "m.checked_at",
    ])
    .where("p.space_id", "=", spaceId)
    .orderBy("m.name")
    .execute();
}

/** Every provider, connected or not, with the Space's models from each. */
export async function providerViews(d1: D1Database, spaceId: string): Promise<AiProviderView[]> {
  const [providers, models] = await Promise.all([
    db(d1)
      .selectFrom("ai_providers as p")
      .leftJoin("accounts as a", "a.id", "p.updated_by")
      .select(["p.kind", "p.key_last_four", "p.updated_at", "a.slug"])
      .where("p.space_id", "=", spaceId)
      .execute(),
    modelRows(d1, spaceId),
  ]);
  return AI_PROVIDERS.map((info) => {
    const row = providers.find((provider) => provider.kind === info.kind);
    return {
      ...info,
      connected: Boolean(row),
      keyLastFour: row?.key_last_four ?? null,
      connectedAt: row?.updated_at ?? null,
      connectedBy: row?.slug ?? null,
      models: models.filter((model) => model.kind === info.kind).map(toModel),
    };
  });
}

/** The built-in models, then the Space's provider models, for each role they can fill. */
export async function spaceCatalog(d1: D1Database, spaceId: string): Promise<AiModelCatalog> {
  const models = (await modelRows(d1, spaceId)).map(toModel);
  const roles = Object.keys(AI_MODEL_CATALOG) as AiRole[];
  return Object.fromEntries(
    roles.map((role) => [
      role,
      [
        ...AI_MODEL_CATALOG[role],
        ...models.filter((model) => CAPABILITY_ROLES[model.capability].includes(role)),
      ],
    ]),
  ) as unknown as AiModelCatalog;
}

// ---- snapshot references -------------------------------------------------------

const PROVIDER_ROW = /^aip_[0-9a-f-]{36}$/;

export function newProviderId(): string {
  return `aip_${crypto.randomUUID()}`;
}

/** How a snapshot names a provider model: `<provider>:<provider row id>:<model>`. */
export function providerModelRef(kind: AiProviderKind, providerId: string, model: string): string {
  return `${kind}:${providerId}:${model}`;
}

export interface ProviderModelRef {
  kind: AiProviderKind;
  providerId: string;
  model: string;
  /** What usage records call it: the user-facing id, without the row. */
  usageName: string;
}

/** A snapshot's provider model, or null for a Workers AI model id. */
export function parseProviderModelRef(ref: string): ProviderModelRef | null {
  const first = ref.indexOf(":");
  const second = ref.indexOf(":", first + 1);
  if (first <= 0 || second <= first) return null;
  const kind = ref.slice(0, first);
  const providerId = ref.slice(first + 1, second);
  const model = ref.slice(second + 1);
  if (!AI_PROVIDERS.some((info) => info.kind === kind) || !PROVIDER_ROW.test(providerId) || !model)
    return null;
  return {
    kind: kind as AiProviderKind,
    providerId,
    model,
    usageName: providerModelId(kind as AiProviderKind, model),
  };
}

/** The snapshot reference and prices for a Space's provider model id, or null if it's gone. */
export async function resolveProviderModel(
  d1: D1Database,
  spaceId: string,
  kind: AiProviderKind,
  model: string,
): Promise<{ ref: string; option: AiProviderModel } | null> {
  const row = (await modelRows(d1, spaceId)).find(
    (entry) => entry.kind === kind && entry.model === model,
  );
  return row ? { ref: providerModelRef(kind, row.provider_id, model), option: toModel(row) } : null;
}

/** Revalidate the frozen reference against its current Space and model before unsealing.
 * The caller must authorize the current resource and actor before every use.
 */
export async function providerKey(
  env: Env,
  ref: ProviderModelRef,
  spaceId: string,
): Promise<string> {
  const row = await db(env.DB)
    .selectFrom("ai_providers as p")
    .innerJoin("spaces as s", "s.id", "p.space_id")
    .innerJoin("ai_provider_models as m", "m.provider_id", "p.id")
    .select("p.key_sealed")
    .where("p.id", "=", ref.providerId)
    .where("p.kind", "=", ref.kind)
    .where("p.space_id", "=", spaceId)
    .where("m.model", "=", ref.model)
    .where("s.archived_at", "is", null)
    .executeTakeFirst();
  if (!row) throw new Error(`The requested provider model is no longer available in this Space.`);
  return unseal(env, row.key_sealed);
}
