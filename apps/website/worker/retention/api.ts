// Space retention requires a current explicit admin grant, never Organization
// ownership or an Instance bypass. Person retention is strictly self-only.

import { Hono, type Context } from "hono";
import type {
  RetentionPolicy,
  RetentionRun,
  RetentionRunPage,
  RetentionSettings,
} from "../../shared/retention.ts";
import { fail, requireActor, requirePerson } from "../api/http.ts";
import type { AppEnv } from "../auth.ts";
import { findSpaceBySlug, resolveSpaceAccess } from "../spaces/access.ts";
import type { Actor } from "../db.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import { category, validThreshold } from "./categories.ts";
import {
  instancePolicies,
  applyPatch,
  recentChanges,
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

async function settings(
  d1: D1Database,
  target: RetentionTarget,
  canEdit: boolean,
): Promise<RetentionSettings> {
  const [categories, changes] = await Promise.all([
    target.kind === "instance" ? instancePolicies(d1) : targetPolicies(d1, target),
    recentChanges(d1, target),
  ]);
  return { target, canEdit, categories, changes };
}

async function authorize(
  c: Context<AppEnv>,
  actor: Actor,
  kind: RetentionTarget["kind"],
): Promise<RetentionTarget | Response> {
  if (kind === "instance") {
    return actor.isSiteAdmin
      ? { kind, id: "" }
      : fail(c, 403, "Only Instance administrators manage Instance retention.");
  }
  if (kind === "person") {
    if (c.req.param("person")?.toLowerCase() !== actor.slug.toLowerCase())
      return fail(c, 404, "No such person retention.");
    return { kind, id: actor.id };
  }
  const space = await findSpaceBySlug(c.env.DB, c.req.param("space") ?? "");
  const access = space && (await resolveSpaceAccess(c.env.DB, actor, space.id));
  if (!access) return fail(c, 404, "No such Space, or you don't have access.");
  if (access.grant.role !== "admin")
    return fail(c, 403, "Only Space administrators manage retention.");
  return { kind, id: access.spaceId };
}

function retentionApi(kind: RetentionTarget["kind"]) {
  const api = new Hono<AppEnv>();
  api.get("/", async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const target = await authorize(c, actor, kind);
    if (target instanceof Response) return target;
    return c.json<RetentionSettings>(await settings(c.env.DB, target, !actor.agent));
  });
  api.patch("/", async (c) => {
    const actor = requirePerson(c);
    if (actor instanceof Response) return actor;
    const target = await authorize(c, actor, kind);
    if (target instanceof Response) return target;
    const changes = validatePatch(kind, await body(c));
    if (typeof changes === "string") return fail(c, 400, changes);
    await applyPatch(c.env.DB, target, changes, actor.id);
    return c.json<RetentionSettings>(await settings(c.env.DB, target, true));
  });
  return api;
}

export const spaceRetentionApi = retentionApi("space");
export const personRetentionApi = retentionApi("person");
export const instanceRetentionApi = retentionApi("instance");

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
  actor: Actor,
  request: Exclude<ReturnType<typeof validateRunRequest>, string>,
) {
  const admission = await cutoverControl(c.env).admission(4);
  if (!admission.allowed) return fail(c, 503, "space_cutover_fenced");
  const id = await createRun(c.env.DB, {
    target,
    trigger: "manual",
    actorId: actor.id,
    authority: { ...actor, migrationEpoch: admission.epoch },
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

function runsApi(kind: RetentionTarget["kind"]) {
  const api = new Hono<AppEnv>();
  api.post("/", async (c) => {
    const actor = requirePerson(c);
    if (actor instanceof Response) return actor;
    const target = await authorize(c, actor, kind);
    if (target instanceof Response) return target;
    const request = validateRunRequest(await body(c), await targetPolicies(c.env.DB, target));
    if (typeof request === "string") return fail(c, 400, request);
    return startRun(c, target, actor, request);
  });
  api.get("/", async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const target = await authorize(c, actor, kind);
    if (target instanceof Response) return target;
    return c.json<RetentionRunPage>(await listRuns(c.env.DB, target, page(c)));
  });
  api.get("/:id", async (c) => {
    const actor = requireActor(c);
    if (actor instanceof Response) return actor;
    const target = await authorize(c, actor, kind);
    if (target instanceof Response) return target;
    const id = runId(c);
    const run = id === null ? null : await getRun(c.env.DB, target, id);
    return run ? c.json<RetentionRun>(run) : fail(c, 404, "No such run.");
  });
  return api;
}

export const spaceRunsApi = runsApi("space");
export const personRunsApi = runsApi("person");
instanceRetentionApi.route("/runs", runsApi("instance"));
