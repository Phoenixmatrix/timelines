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

import { Hono } from "hono";
import type { RetentionSettings } from "../../shared/retention.ts";
import { fail, requireActor, requirePerson } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import { load } from "../deployments/settings.ts";
import {
  accountPolicies,
  applyPatch,
  recentChanges,
  sitePolicies,
  validatePatch,
} from "./policies.ts";

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
