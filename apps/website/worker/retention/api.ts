// Retention settings API (CORE-196). Categories and resolution:
// worker/retention/categories.ts and policies.ts; shapes: shared/retention.ts.
//
// /api/accounts/:slug/settings/retention (accountRetentionApi)
//   GET    the account's categories with effective policies (members; others 404)
//   PATCH  RetentionPatch for account categories (org owners or the user
//          themselves, and site administrators; people, not agents)
// /api/admin/retention (siteRetentionApi; site administrators only, others 403)
//   GET    site categories, and site-wide defaults for account categories
//   PATCH  RetentionPatch for those
//
// Every PATCH is validated against the registry (unknown categories or
// thresholds, out-of-bounds or fractional values, read-only categories: 400)
// and records who changed what in retention_policy_changes.
//
// Cleanup runs (CORE-198; worker/retention/runs.ts):
// /api/accounts/:slug/retention/runs (accountRunsApi), /api/admin/retention/runs
//   POST      RetentionRunRequest {dryRun, categories, thresholds?}: 202 with
//             the queued run (owners/site admins, people only). Any categories
//             of the level that have a cleanup, enabled or not.
//   GET       the level's runs, newest first (?before=<next>&limit=)
//   GET /:id  one run with each category's thresholds, counts, bytes, errors
//   Account runs: members read; site runs: site administrators.

import { Hono, type Context } from "hono";
import type {
  RetentionPolicy,
  RetentionRun,
  RetentionRunPage,
  RetentionSettings,
} from "../../shared/retention.ts";
import { fail, requireActor, requirePerson } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import { load } from "../deployments/settings.ts";
import { category, validThreshold } from "./categories.ts";
import {
  accountPolicies,
  applyPatch,
  recentChanges,
  sitePolicies,
  targetPolicies,
  validatePatch,
  type RetentionTarget,
} from "./policies.ts";
import { continueRun, createRun, getRun, listRuns } from "./runs.ts";

async function body(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

async function accountSettings(
  d1: D1Database,
  account: { id: string; slug: string },
  canEdit: boolean,
): Promise<RetentionSettings> {
  const [categories, changes] = await Promise.all([
    accountPolicies(d1, account.id),
    recentChanges(d1, account.id),
  ]);
  return { level: "account", account: account.slug, canEdit, categories, changes };
}

async function siteSettings(d1: D1Database, canEdit: boolean): Promise<RetentionSettings> {
  const [categories, changes] = await Promise.all([sitePolicies(d1), recentChanges(d1, null)]);
  return { level: "site", account: null, canEdit, categories, changes };
}

export const accountRetentionApi = new Hono<AppEnv>();

accountRetentionApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  return c.json<RetentionSettings>(
    await accountSettings(c.env.DB, found.account, found.role === "admin" && !actor.agent),
  );
});

accountRetentionApi.patch("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  if (found.role !== "admin")
    return fail(c, 403, "Only the organization's owners can change its data retention.");
  const changes = validatePatch("account", await body(c));
  if (typeof changes === "string") return fail(c, 400, changes);
  await applyPatch(c.env.DB, { scope: "account", accountId: found.account.id }, changes, actor.id);
  return c.json<RetentionSettings>(await accountSettings(c.env.DB, found.account, true));
});

export const siteRetentionApi = new Hono<AppEnv>();

siteRetentionApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site administrators manage site retention.");
  return c.json<RetentionSettings>(await siteSettings(c.env.DB, !actor.agent));
});

siteRetentionApi.patch("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site administrators manage site retention.");
  const changes = validatePatch("site", await body(c));
  if (typeof changes === "string") return fail(c, 400, changes);
  await applyPatch(c.env.DB, { scope: "site" }, changes, actor.id);
  return c.json<RetentionSettings>(await siteSettings(c.env.DB, true));
});

/**
 * Checks a run request against a level's effective policies: categories of
 * that level with a cleanup (enabled or not), thresholds overridden within
 * their bounds. Returns what to run, or a message saying what's wrong.
 */
export function validateRunRequest(
  body: unknown,
  policies: RetentionPolicy[],
): { dryRun: boolean; categories: { id: string; thresholds: Record<string, number> }[] } | string {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return "Send {dryRun, categories: [<id>], thresholds?}.";
  const { dryRun, categories, thresholds = {}, ...rest } = body as Record<string, unknown>;
  for (const key of Object.keys(rest)) return `Unknown field: ${key}.`;
  if (typeof dryRun !== "boolean") return "Say dryRun: true to preview, or false to delete.";
  if (
    !Array.isArray(categories) ||
    categories.length === 0 ||
    categories.some((id) => typeof id !== "string") ||
    new Set(categories).size !== categories.length
  )
    return "categories must list category ids, each once.";
  if (!thresholds || typeof thresholds !== "object" || Array.isArray(thresholds))
    return "thresholds must be an object keyed by category id.";
  for (const id of Object.keys(thresholds))
    if (!categories.includes(id)) return `thresholds names ${id}, which isn't in categories.`;
  const out: { id: string; thresholds: Record<string, number> }[] = [];
  for (const id of categories as string[]) {
    const policy = policies.find((p) => p.id === id);
    if (!category(id)) return `Unknown category: ${id}.`;
    if (!policy) return `${id} isn't a category of this level.`;
    if (!policy.runnable) return `${id} has no cleanup yet.`;
    const values = { ...policy.values };
    const overrides = (thresholds as Record<string, unknown>)[id] ?? {};
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides))
      return `thresholds.${id} must be an object.`;
    for (const [key, value] of Object.entries(overrides)) {
      const t = policy.thresholds.find((t) => t.key === key);
      if (!t) return `Unknown threshold for ${id}: ${key}.`;
      if (!validThreshold(t, value))
        return `${id}.${key} must be a whole number from ${t.min} to ${t.max}.`;
      values[key] = value;
    }
    out.push({ id, thresholds: values });
  }
  return { dryRun, categories: out };
}

/** Starts a run and its first slice after the response; the queue and cron do the rest. */
async function startRun(
  c: Context<AppEnv>,
  target: RetentionTarget,
  actorId: string,
  request: Exclude<ReturnType<typeof validateRunRequest>, string>,
) {
  const id = await createRun(c.env.DB, {
    target,
    trigger: "manual",
    actorId,
    dryRun: request.dryRun,
    categories: request.categories,
  });
  c.executionCtx.waitUntil(
    continueRun(c.env, id).catch((error) => console.error("Retention: run failed", id, error)),
  );
  return c.json<RetentionRun>((await getRun(c.env.DB, target, id))!, 202);
}

function page(c: Context<AppEnv>) {
  const before = Number(c.req.query("before"));
  const limit = Number(c.req.query("limit"));
  return {
    ...(Number.isInteger(before) && before > 0 ? { before } : {}),
    ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
  };
}

function runId(c: Context<AppEnv>): number | null {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** /api/accounts/:slug/retention/runs */
export const accountRunsApi = new Hono<AppEnv>();

accountRunsApi.post("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  if (found.role !== "admin")
    return fail(c, 403, "Only the organization's owners can clean up its data.");
  const target = { scope: "account", accountId: found.account.id } as const;
  const request = validateRunRequest(await body(c), await targetPolicies(c.env.DB, target));
  if (typeof request === "string") return fail(c, 400, request);
  return startRun(c, target, actor.id, request);
});

accountRunsApi.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  return c.json<RetentionRunPage>(
    await listRuns(c.env.DB, { scope: "account", accountId: found.account.id }, page(c)),
  );
});

accountRunsApi.get("/:id", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const found = await load(c, actor);
  if (!found) return fail(c, 404, "No such account, or you aren't a member.");
  const id = runId(c);
  const run =
    id === null
      ? null
      : await getRun(c.env.DB, { scope: "account", accountId: found.account.id }, id);
  return run ? c.json<RetentionRun>(run) : fail(c, 404, "No such run.");
});

siteRetentionApi.post("/runs", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site administrators manage site retention.");
  const target = { scope: "site" } as const;
  const request = validateRunRequest(await body(c), await targetPolicies(c.env.DB, target));
  if (typeof request === "string") return fail(c, 400, request);
  return startRun(c, target, actor.id, request);
});

siteRetentionApi.get("/runs", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site administrators manage site retention.");
  return c.json<RetentionRunPage>(await listRuns(c.env.DB, { scope: "site" }, page(c)));
});

siteRetentionApi.get("/runs/:id", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  if (!actor.isSiteAdmin) return fail(c, 403, "Only site administrators manage site retention.");
  const id = runId(c);
  const run = id === null ? null : await getRun(c.env.DB, { scope: "site" }, id);
  return run ? c.json<RetentionRun>(run) : fail(c, 404, "No such run.");
});
