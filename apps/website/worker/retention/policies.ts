// Retention policies resolve within an explicit Space, person, or Instance.
// Instance defaults can configure policy categories, never grant access to
// personal chats or Space content. Active categories use only Space values.
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

export type { RetentionTarget } from "../../shared/retention.ts";
import type { RetentionTarget } from "../../shared/retention.ts";

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
  let enabled = c.control !== "policy" || c.defaultEnabled === true;
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

async function scopedRows(
  d1: D1Database,
  target: RetentionTarget,
): Promise<Map<string, StoredRow>> {
  const rows = await db(d1)
    .selectFrom("retention_policies as p")
    .leftJoin("accounts as a", "a.id", "p.updated_by")
    .select(["p.category", "p.enabled", "p.thresholds", "p.updated_at", "a.slug"])
    .where("p.scope_kind", "=", target.kind)
    .where("p.scope_id", "=", target.id)
    .execute();
  return new Map(rows.map((r) => [r.category, r]));
}

/** Space preview settings remain shared with the preview lifecycle. */
async function previewRow(d1: D1Database, spaceId: string): Promise<StoredRow | undefined> {
  const row = await db(d1)
    .selectFrom("space_settings as s")
    .leftJoin("accounts as a", "a.id", "s.updated_by")
    .select(["s.preview_ended_days", "s.preview_idle_days", "s.updated_at", "a.slug"])
    .where("s.space_id", "=", spaceId)
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

/** Effective categories for exactly one content or personal target. */
async function scopedPolicies(d1: D1Database, target: RetentionTarget): Promise<RetentionPolicy[]> {
  const [instance, own, preview, runs] = await Promise.all([
    siteRows(d1),
    scopedRows(d1, target),
    target.kind === "space" ? previewRow(d1, target.id) : undefined,
    lastRuns(d1, target),
  ]);
  return CATEGORIES.filter((c) => c.scope === target.kind).map((c) => {
    const saved = [{ from: target.kind, row: c.id === "previews" ? preview : own.get(c.id) }];
    if (c.control === "policy") saved.push({ from: "instance", row: instance.get(c.id) });
    return resolve(c, saved, runs.get(c.id));
  });
}

export async function spacePolicies(d1: D1Database, spaceId: string): Promise<RetentionPolicy[]> {
  return scopedPolicies(d1, { kind: "space", id: spaceId });
}

export async function personPolicies(d1: D1Database, personId: string): Promise<RetentionPolicy[]> {
  return scopedPolicies(d1, { kind: "person", id: personId });
}

/** Instance infrastructure policies and defaults, not access to scoped records. */
export async function instancePolicies(d1: D1Database): Promise<RetentionPolicy[]> {
  const [instance, runs] = await Promise.all([
    siteRows(d1),
    lastRuns(d1, { kind: "instance", id: "" }),
  ]);
  return CATEGORIES.filter((c) => c.scope === "instance" || c.control === "policy").map((c) =>
    resolve(
      c,
      [{ from: "instance", row: instance.get(c.id) }],
      c.scope === "instance" ? runs.get(c.id) : undefined,
    ),
  );
}

export async function targetPolicies(
  d1: D1Database,
  target: RetentionTarget,
): Promise<RetentionPolicy[]> {
  return target.kind === "instance"
    ? (await instancePolicies(d1)).filter((p) => p.scope === "instance")
    : scopedPolicies(d1, target);
}

/** Schedule independently by immutable scope, including private personal chats. */
export async function enabledTargets(
  d1: D1Database,
): Promise<{ target: RetentionTarget; policies: RetentionPolicy[] }[]> {
  const out: { target: RetentionTarget; policies: RetentionPolicy[] }[] = [];
  const instance = (await targetPolicies(d1, { kind: "instance", id: "" })).filter(
    (p) => p.control !== "active" && p.enabled,
  );
  if (instance.length) out.push({ target: { kind: "instance", id: "" }, policies: instance });
  const [spaces, people] = await Promise.all([
    db(d1)
      .selectFrom("spaces")
      .select("id")
      .where("archived_at", "is", null)
      .orderBy("id")
      .execute(),
    db(d1).selectFrom("accounts").select("id").where("kind", "=", "user").orderBy("id").execute(),
  ]);
  for (const kind of ["space", "person"] as const) {
    for (const { id } of kind === "space" ? spaces : people) {
      const target = { kind, id };
      const policies = (await targetPolicies(d1, target)).filter(
        (p) => p.control === "policy" && p.enabled,
      );
      if (policies.length) out.push({ target, policies });
    }
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
      return recent.where("scope_kind", "=", target.kind).where("scope_id", "=", target.id);
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

/** Latest changes for exactly one explicit target. */
export async function recentChanges(
  d1: D1Database,
  target: RetentionTarget,
  limit = 20,
): Promise<RetentionChange[]> {
  let query = db(d1)
    .selectFrom("retention_policy_changes as c")
    .leftJoin("accounts as a", "a.id", "c.actor_id")
    .select(["c.category", "c.before", "c.after", "c.created_at", "a.slug"])
    .orderBy("c.id", "desc")
    .limit(limit);
  query = query.where("c.scope_kind", "=", target.kind).where("c.scope_id", "=", target.id);
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
    if (level !== "instance" && c.scope !== level) return `${id} is not a ${level} category.`;
    if (c.control === "fixed") return `${id} is read-only.`;
    if (level === "instance" && c.scope !== "instance" && c.control !== "policy")
      return `${id} is set per Space, not as an Instance default.`;
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
  const [rows, preview] = await Promise.all([
    target.kind === "instance" ? siteRows(d1) : scopedRows(d1, target),
    target.kind === "space" ? previewRow(d1, target.id) : undefined,
  ]);
  const at = nowIso();
  const queries: Parameters<typeof batch>[1] = [];
  for (const [c, change] of changes) {
    const previews = c.id === "previews";
    const before = stored(previews ? preview : rows.get(c.id));
    let after = merge(before, change);
    // Previews store both numbers (space_settings columns), defaults where reset.
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
        scope_kind: target.kind,
        scope_id: target.id,
        category: c.id,
        actor_id: actorId,
        before: JSON.stringify(before),
        after: JSON.stringify(after),
        created_at: at,
      }),
    );
    // Atlas retention reads the policy on every pass; flag the Space's
    // repositories so the hourly sweep applies a tighter one without waiting
    // for their next build.
    if (c.id === ATLAS_CATEGORY && target.kind === "space")
      queries.push(
        kdb
          .updateTable("atlas_scopes")
          .set({ retention_pending: 1 })
          .where("kind", "=", "repo")
          .where("repo_id", "in", (eb) =>
            eb.selectFrom("repos").select("id").where("space_id", "=", target.id),
          ),
      );
    if (previews && target.kind === "space") {
      const values = {
        preview_ended_days: after.thresholds!.endedDays!,
        preview_idle_days: after.thresholds!.idleDays!,
        updated_by: actorId,
        updated_at: at,
      };
      queries.push(
        kdb
          .insertInto("space_settings")
          .values({ space_id: target.id, ...values })
          .onConflict((oc) => oc.column("space_id").doUpdateSet(values)),
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
    if (target.kind === "instance")
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
              .where("scope_kind", "=", target.kind)
              .where("scope_id", "=", target.id)
              .where("category", "=", c.id)
          : kdb
              .insertInto("retention_policies")
              .values({ scope_kind: target.kind, scope_id: target.id, category: c.id, ...values })
              .onConflict((oc) =>
                oc.columns(["scope_kind", "scope_id", "category"]).doUpdateSet(values),
              ),
      );
  }
  await batch(d1, queries);
}
