// Retention policies (CORE-196): what each account and the site have chosen
// for every category in worker/retention/categories.ts, resolved to effective
// values.
//
// Resolution, per category and threshold:
// - account categories: the account's stored value, else the site-wide
//   default, else the category's default; `enabled` likewise, ending at false.
// - site categories: the site's stored value, else the category's default.
// - "active" categories always run, per account. Previews' thresholds live in
//   account_settings (the columns the preview sweep reads), so changing them
//   here or through /settings/previews is the same change; Atlas snapshots'
//   in retention_policies (enabled null), which every Atlas retention pass
//   reads (worker/atlas/retention.ts `scopePolicy`).
// - "fixed" categories always run with their defaults, on the schedule like
//   an enabled policy, and ignore any stored value (auth hygiene stored a site
//   row while it was a policy; CORE-249).
// A stored value that no longer fits its threshold's bounds is ignored.
//
// Nothing here deletes anything. The cleanup engine (runs.ts) asks
// `targetPolicies` / `enabledTargets` what to run; `runnable` says whether a
// category has a cleanup (cleanups/index.ts), `lastRun` what its latest run did.

import type {
  PolicySource,
  RetentionCategory,
  RetentionChange,
  RetentionLastRun,
  RetentionPolicy,
  RetentionScope,
  StoredPolicy,
} from "../../shared/retention.ts";
import { DEFAULT_PREVIEW_SETTINGS } from "../../shared/deployments.ts";
import { ATLAS_CATEGORY } from "../atlas/retention.ts";
import { batch, db, nowIso } from "../schema.ts";
import { CATEGORIES, category, validThreshold } from "./categories.ts";
import { cleanupFor } from "./cleanups/index.ts";

/** Whose policies: one account's, or the site's. */
export type RetentionTarget = { scope: "account"; accountId: string } | { scope: "site" };

interface StoredRow {
  category: string;
  enabled: number | null;
  thresholds: string;
  updated_at: string;
  slug: string | null;
}

function parseThresholds(json: string): Record<string, number> {
  try {
    const value = JSON.parse(json) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value))
      return Object.fromEntries(
        Object.entries(value).filter((entry): entry is [string, number] => {
          return typeof entry[1] === "number";
        }),
      );
  } catch {
    // An unreadable value inherits.
  }
  return {};
}

function stored(row: StoredRow | undefined): StoredPolicy {
  if (!row) return {};
  const thresholds = parseThresholds(row.thresholds);
  return {
    ...(row.enabled === null ? {} : { enabled: row.enabled === 1 }),
    ...(Object.keys(thresholds).length ? { thresholds } : {}),
  };
}

function resolve(
  c: RetentionCategory,
  saved: { from: PolicySource; row: StoredRow | undefined }[],
  lastRun?: RetentionLastRun,
): RetentionPolicy {
  const levels = c.control === "fixed" ? [] : saved;
  const values: Record<string, number> = {};
  const valuesFrom: Record<string, PolicySource> = {};
  for (const t of c.thresholds) {
    values[t.key] = t.default;
    valuesFrom[t.key] = "default";
    for (const level of levels) {
      const value = stored(level.row).thresholds?.[t.key];
      if (validThreshold(t, value)) {
        values[t.key] = value;
        valuesFrom[t.key] = level.from;
        break;
      }
    }
  }
  let enabled = c.control !== "policy";
  let enabledFrom: PolicySource = "default";
  if (c.control === "policy")
    for (const level of levels) {
      const value = stored(level.row).enabled;
      if (value !== undefined) {
        enabled = value;
        enabledFrom = level.from;
        break;
      }
    }
  const own = levels[0]?.row;
  return {
    ...c,
    never: [...c.never],
    overlaps: [...(c.overlaps ?? [])],
    thresholds: c.thresholds.map((t) => ({ ...t })),
    enabled,
    enabledFrom,
    values,
    valuesFrom,
    runnable: c.control !== "active" && cleanupFor(c.id) !== undefined,
    lastRun: lastRun ?? null,
    updatedAt: own?.updated_at ?? null,
    updatedBy: own?.slug ?? null,
  };
}

async function siteRows(d1: D1Database): Promise<Map<string, StoredRow>> {
  const rows = await db(d1)
    .selectFrom("retention_site_policies as p")
    .leftJoin("accounts as a", "a.id", "p.updated_by")
    .select(["p.category", "p.enabled", "p.thresholds", "p.updated_at", "a.slug"])
    .execute();
  return new Map(rows.map((r) => [r.category, r]));
}

async function accountRows(d1: D1Database, accountId: string): Promise<Map<string, StoredRow>> {
  const rows = await db(d1)
    .selectFrom("retention_policies as p")
    .leftJoin("accounts as a", "a.id", "p.updated_by")
    .select(["p.category", "p.enabled", "p.thresholds", "p.updated_at", "a.slug"])
    .where("p.account_id", "=", accountId)
    .execute();
  return new Map(rows.map((r) => [r.category, r]));
}

/** The account_settings preview columns, as a stored policy row of `previews`. */
async function previewRow(d1: D1Database, accountId: string): Promise<StoredRow | undefined> {
  const row = await db(d1)
    .selectFrom("account_settings as s")
    .leftJoin("accounts as a", "a.id", "s.updated_by")
    .select(["s.preview_ended_days", "s.preview_idle_days", "s.updated_at", "a.slug"])
    .where("s.account_id", "=", accountId)
    .executeTakeFirst();
  // A row the AI settings created leaves the preview columns at their
  // defaults and updated_at null: nothing stored for previews.
  if (!row || row.updated_at === null) return undefined;
  return {
    category: "previews",
    enabled: null,
    thresholds: JSON.stringify({
      endedDays: row.preview_ended_days,
      idleDays: row.preview_idle_days,
    }),
    updated_at: row.updated_at,
    slug: row.slug,
  };
}

/** Every account category with this account's effective policy, in registry order. */
export async function accountPolicies(
  d1: D1Database,
  accountId: string,
): Promise<RetentionPolicy[]> {
  const [site, own, preview, runs] = await Promise.all([
    siteRows(d1),
    accountRows(d1, accountId),
    previewRow(d1, accountId),
    lastRuns(d1, { scope: "account", accountId }),
  ]);
  return CATEGORIES.filter((c) => c.scope === "account").map((c) => {
    // Active (and any fixed) categories: the account's own values only (a
    // fixed one never has stored values: validatePatch refuses them).
    if (c.control !== "policy")
      return resolve(c, [{ from: "account", row: c.id === "previews" ? preview : own.get(c.id) }]);
    return resolve(
      c,
      [
        { from: "account", row: own.get(c.id) },
        { from: "site", row: site.get(c.id) },
      ],
      runs.get(c.id),
    );
  });
}

/**
 * The site level: site categories with their policy, then the account
 * categories that take a policy, with the site-wide defaults.
 */
export async function sitePolicies(d1: D1Database): Promise<RetentionPolicy[]> {
  const [site, runs] = await Promise.all([siteRows(d1), lastRuns(d1, { scope: "site" })]);
  const of = (c: RetentionCategory) =>
    resolve(c, [{ from: "site", row: site.get(c.id) }], runs.get(c.id));
  return [
    ...CATEGORIES.filter((c) => c.scope === "site").map(of),
    // Site-wide defaults: their runs are each account's.
    ...CATEGORIES.filter((c) => c.scope === "account" && c.control === "policy").map((c) =>
      resolve(c, [{ from: "site", row: site.get(c.id) }]),
    ),
  ];
}

/** A target's effective policies (an account's account categories, or the site's site ones). */
export async function targetPolicies(
  d1: D1Database,
  target: RetentionTarget,
): Promise<RetentionPolicy[]> {
  return target.scope === "account"
    ? accountPolicies(d1, target.accountId)
    : (await sitePolicies(d1)).filter((p) => p.scope === "site");
}

/**
 * Every target with at least one enabled "policy" or "fixed" category, with
 * those categories: what scheduled runs cover. With nothing enabled anywhere,
 * only the site with its fixed categories.
 */
export async function enabledTargets(
  d1: D1Database,
): Promise<{ target: RetentionTarget; policies: RetentionPolicy[] }[]> {
  const site = await sitePolicies(d1);
  const out: { target: RetentionTarget; policies: RetentionPolicy[] }[] = [];
  const siteOn = site.filter((p) => p.scope === "site" && p.control !== "active" && p.enabled);
  if (siteOn.length) out.push({ target: { scope: "site" }, policies: siteOn });
  // Accounts that enabled something, or every account when a site-wide
  // default enables an account category.
  const defaultOn = site.some((p) => p.scope === "account" && p.enabled);
  const accounts = defaultOn
    ? await db(d1).selectFrom("accounts").select("id").orderBy("id").execute()
    : await db(d1)
        .selectFrom("retention_policies")
        .select("account_id as id")
        .where("enabled", "=", 1)
        .distinct()
        .orderBy("account_id")
        .execute();
  for (const { id } of accounts) {
    const on = (await accountPolicies(d1, id)).filter((p) => p.control === "policy" && p.enabled);
    if (on.length) out.push({ target: { scope: "account", accountId: id }, policies: on });
  }
  return out;
}

/** The latest run of each category at a target, from its recent runs. */
export async function lastRuns(
  d1: D1Database,
  target: RetentionTarget,
): Promise<Map<string, RetentionLastRun>> {
  const query = db(d1)
    .selectFrom("cleanup_run_categories as c")
    .innerJoin("cleanup_runs as r", "r.id", "c.run_id")
    .select([
      "c.category",
      "r.id",
      "r.dry_run",
      "r.trigger",
      "r.created_at",
      "c.status",
      "c.items",
      "c.bytes",
      "c.error",
      "c.finished_at",
    ])
    .where("r.id", "in", (eb) => {
      const recent = eb.selectFrom("cleanup_runs").select("id").orderBy("id", "desc").limit(100);
      return target.scope === "site"
        ? recent.where("account_id", "is", null)
        : recent.where("account_id", "=", target.accountId);
    })
    .orderBy("r.id", "desc");
  const out = new Map<string, RetentionLastRun>();
  for (const row of await query.execute())
    if (!out.has(row.category))
      out.set(row.category, {
        runId: row.id,
        dryRun: row.dry_run === 1,
        trigger: row.trigger,
        status: row.status,
        items: row.items,
        bytes: row.bytes,
        error: row.error,
        at: row.finished_at ?? row.created_at,
      });
  return out;
}

/** The latest changes at a level (an account, or the site with null). */
export async function recentChanges(
  d1: D1Database,
  accountId: string | null,
  limit = 20,
): Promise<RetentionChange[]> {
  let query = db(d1)
    .selectFrom("retention_policy_changes as c")
    .leftJoin("accounts as a", "a.id", "c.actor_id")
    .select(["c.category", "c.before", "c.after", "c.created_at", "a.slug"])
    .orderBy("c.id", "desc")
    .limit(limit);
  query =
    accountId === null
      ? query.where("c.account_id", "is", null)
      : query.where("c.account_id", "=", accountId);
  return (await query.execute()).map((r) => ({
    category: r.category,
    actor: r.slug,
    before: JSON.parse(r.before) as StoredPolicy,
    after: JSON.parse(r.after) as StoredPolicy,
    at: r.created_at,
  }));
}

type Change = { enabled?: boolean | null; thresholds?: Record<string, number | null> };

/**
 * Checks a PATCH body against the registry for a level. Returns the changes
 * by category, or a message saying what's wrong.
 */
export function validatePatch(
  level: RetentionScope,
  body: unknown,
): Map<RetentionCategory, Change> | string {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return "Send {categories: {<id>: {enabled?, thresholds?}}}.";
  for (const key of Object.keys(body)) if (key !== "categories") return `Unknown field: ${key}.`;
  const categories = (body as { categories?: unknown }).categories;
  if (!categories || typeof categories !== "object" || Array.isArray(categories))
    return "categories must be an object keyed by category id.";
  const out = new Map<RetentionCategory, Change>();
  for (const [id, raw] of Object.entries(categories)) {
    const c = category(id);
    if (!c) return `Unknown category: ${id}.`;
    if (level === "account" && c.scope === "site")
      return `${id} is a site category; site administrators set it under /api/admin/retention.`;
    if (c.control === "fixed") return `${id} is read-only.`;
    if (level === "site" && c.control !== "policy")
      return `${id} is set per account, not as a site-wide default.`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return `${id} must be {enabled?, thresholds?}.`;
    const change: Change = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === "enabled") {
        if (c.control !== "policy") return `${id} always runs; it can't be turned off.`;
        if (value !== null && typeof value !== "boolean")
          return `${id}.enabled must be true, false or null.`;
        change.enabled = value as boolean | null;
      } else if (key === "thresholds") {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return `${id}.thresholds must be an object.`;
        change.thresholds = {};
        for (const [name, number] of Object.entries(value)) {
          const t = c.thresholds.find((t) => t.key === name);
          if (!t) return `Unknown threshold for ${id}: ${name}.`;
          if (number !== null && !validThreshold(t, number))
            return `${id}.${name} must be a whole number from ${t.min} to ${t.max}.`;
          change.thresholds[name] = number as number | null;
        }
      } else return `Unknown field for ${id}: ${key}.`;
    }
    out.set(c, change);
  }
  return out;
}

function merge(before: StoredPolicy, change: Change): StoredPolicy {
  const enabled = change.enabled === undefined ? before.enabled : (change.enabled ?? undefined);
  const thresholds: Record<string, number> = { ...before.thresholds };
  for (const [key, value] of Object.entries(change.thresholds ?? {}))
    if (value === null) delete thresholds[key];
    else thresholds[key] = value;
  return {
    ...(enabled === undefined ? {} : { enabled }),
    ...(Object.keys(thresholds).length ? { thresholds } : {}),
  };
}

const same = (a: StoredPolicy, b: StoredPolicy) => {
  const keys = new Set([...Object.keys(a.thresholds ?? {}), ...Object.keys(b.thresholds ?? {})]);
  return a.enabled === b.enabled && [...keys].every((k) => a.thresholds?.[k] === b.thresholds?.[k]);
};

/**
 * Applies validated changes at a level, atomically, recording one change row
 * per category that actually changed.
 */
export async function applyPatch(
  d1: D1Database,
  target: RetentionTarget,
  changes: Map<RetentionCategory, Change>,
  actorId: string,
): Promise<void> {
  const kdb = db(d1);
  const accountId = target.scope === "account" ? target.accountId : null;
  const [rows, preview] = await Promise.all([
    accountId === null ? siteRows(d1) : accountRows(d1, accountId),
    accountId === null ? undefined : previewRow(d1, accountId),
  ]);
  const at = nowIso();
  const queries: Parameters<typeof batch>[1] = [];
  for (const [c, change] of changes) {
    const previews = c.id === "previews";
    const before = stored(previews ? preview : rows.get(c.id));
    let after = merge(before, change);
    // Previews store both numbers (account_settings columns), defaults where reset.
    if (previews)
      after = {
        thresholds: {
          endedDays: after.thresholds?.endedDays ?? DEFAULT_PREVIEW_SETTINGS.endedDays,
          idleDays: after.thresholds?.idleDays ?? DEFAULT_PREVIEW_SETTINGS.idleDays,
        },
      };
    if (same(before, after)) continue;
    queries.push(
      kdb.insertInto("retention_policy_changes").values({
        account_id: accountId,
        category: c.id,
        actor_id: actorId,
        before: JSON.stringify(before),
        after: JSON.stringify(after),
        created_at: at,
      }),
    );
    // Atlas retention reads the policy on every pass; flag the account's
    // repositories so the hourly sweep applies a tighter one without waiting
    // for their next build.
    if (c.id === ATLAS_CATEGORY && accountId !== null)
      queries.push(
        kdb
          .updateTable("atlas_scopes")
          .set({ retention_pending: 1 })
          .where("kind", "=", "repo")
          .where("repo_id", "in", (eb) =>
            eb.selectFrom("repos").select("id").where("owner_id", "=", accountId),
          ),
      );
    if (previews && accountId !== null) {
      const values = {
        preview_ended_days: after.thresholds!.endedDays!,
        preview_idle_days: after.thresholds!.idleDays!,
        updated_by: actorId,
        updated_at: at,
      };
      queries.push(
        kdb
          .insertInto("account_settings")
          .values({ account_id: accountId, ...values })
          .onConflict((oc) => oc.column("account_id").doUpdateSet(values)),
      );
      continue;
    }
    const empty = after.enabled === undefined && !after.thresholds;
    const values = {
      enabled: after.enabled === undefined ? null : after.enabled ? 1 : 0,
      thresholds: JSON.stringify(after.thresholds ?? {}),
      updated_by: actorId,
      updated_at: at,
    };
    if (accountId === null)
      queries.push(
        empty
          ? kdb.deleteFrom("retention_site_policies").where("category", "=", c.id)
          : kdb
              .insertInto("retention_site_policies")
              .values({ category: c.id, ...values })
              .onConflict((oc) => oc.column("category").doUpdateSet(values)),
      );
    else
      queries.push(
        empty
          ? kdb
              .deleteFrom("retention_policies")
              .where("account_id", "=", accountId)
              .where("category", "=", c.id)
          : kdb
              .insertInto("retention_policies")
              .values({ account_id: accountId, category: c.id, ...values })
              .onConflict((oc) => oc.columns(["account_id", "category"]).doUpdateSet(values)),
      );
  }
  await batch(d1, queries);
}
