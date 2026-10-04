// Cleanup runs (CORE-198): creating, executing, resuming and scheduling them,
// and reading them back. The cleanup contract is in engine.ts; cleanups are
// registered in cleanups/index.ts.
//
// - A run covers one target (an account, or the site) and some categories,
//   each with the thresholds it uses. It is a dry run (select only) or a real
//   run (select, then remove), and records counts, bytes, batches and errors
//   per category in cleanup_run_categories, totals in cleanup_runs.
// - `asOf` is fixed when the run is created: every batch, and every resume,
//   selects as of that moment.
// - `advanceRun` does bounded work under a lease (a token in the row; progress
//   writes require it, so two workers never both advance a run), saves each
//   category's cursor after every batch and returns "more" when its budget
//   runs out. An interrupted batch is selected again on resume; removal
//   re-checks the policy, so nothing is deleted twice or missed.
// - `continueRun` advances once, then hands the rest to the gitmatrix-jobs
//   queue ({type: "retention", runId}); the hourly cron (`retentionCron`)
//   restarts runs whose lease lapsed, and creates scheduled runs: one a day
//   per target, for the target's enabled categories that have a cleanup, and
//   only those. With nothing enabled the cron writes nothing at all.

import type {
  RetentionRun,
  RetentionRunCategory,
  RetentionRunPage,
} from "../../shared/retention.ts";
import { productionOnly } from "../preview.ts";
import { batch, db } from "../schema.ts";
import { priceTimeline } from "../usage/prices.ts";
import { category, overlappingPairs } from "./categories.ts";
import { cleanupFor } from "./cleanups/index.ts";
import { categoryCost } from "./costs.ts";
import type { CleanupContext } from "./engine.ts";
import { enabledTargets, type RetentionTarget } from "./policies.ts";

export interface RetentionJob {
  type: "retention";
  runId: number;
}

/** How long a worker holds a run before another may take over. */
const LEASE_MS = 5 * 60_000;
/** Items per select. */
export const BATCH_LIMIT = 200;
/** Scheduled runs per target: at most one in this period. */
export const SCHEDULE_EVERY_MS = 23 * 60 * 60_000;
/** A queued or running run without progress for this long is restarted by the cron. */
const STALLED_MS = 10 * 60_000;

export interface NewRun {
  target: RetentionTarget;
  trigger: "schedule" | "manual";
  actorId: string | null;
  dryRun: boolean;
  /** In order; each with its full thresholds. */
  categories: { id: string; thresholds: Record<string, number> }[];
  now?: Date;
}

export async function createRun(d1: D1Database, run: NewRun): Promise<number> {
  const at = (run.now ?? new Date()).toISOString();
  const row = await db(d1)
    .insertInto("cleanup_runs")
    .values({
      account_id: run.target.scope === "account" ? run.target.accountId : null,
      trigger: run.trigger,
      actor_id: run.actorId,
      dry_run: run.dryRun ? 1 : 0,
      status: "queued",
      as_of: at,
      created_at: at,
      updated_at: at,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  try {
    await db(d1)
      .insertInto("cleanup_run_categories")
      .values(
        run.categories.map((c, position) => ({
          run_id: row.id,
          position,
          category: c.id,
          thresholds: JSON.stringify(c.thresholds),
          status: "pending" as const,
        })),
      )
      .execute();
  } catch (error) {
    // A run without its categories would succeed doing nothing.
    await db(d1).deleteFrom("cleanup_runs").where("id", "=", row.id).execute();
    throw error;
  }
  return row.id;
}

export interface AdvanceOptions {
  now?: Date;
  /** Batches this call may do (all categories together). */
  maxBatches?: number;
  /** Wall-clock budget for this call. */
  maxMs?: number;
  limit?: number;
  /** Tests: called after each batch, before its progress is saved; a throw is a crash. */
  afterBatch?: (category: string, items: unknown[]) => void | Promise<void>;
}

/**
 * Advances a run within a budget. "done": finished (now or before); "more":
 * call again; "busy": another worker holds it; "missing": no such run.
 */
export async function advanceRun(
  env: Env,
  runId: number,
  options: AdvanceOptions = {},
): Promise<"done" | "more" | "busy" | "missing"> {
  const clock = () => options.now ?? new Date();
  const kdb = db(env.DB);
  const token = crypto.randomUUID();
  const at = clock().toISOString();
  const run = await kdb
    .updateTable("cleanup_runs")
    .set({
      status: "running",
      started_at: (eb) => eb.fn.coalesce("started_at", eb.val(at)),
      lease_token: token,
      lease_until: new Date(clock().getTime() + LEASE_MS).toISOString(),
      updated_at: at,
    })
    .where("id", "=", runId)
    .where("status", "in", ["queued", "running"])
    .where((eb) => eb.or([eb("lease_until", "is", null), eb("lease_until", "<", at)]))
    .returningAll()
    .executeTakeFirst();
  if (!run) {
    const exists = await kdb
      .selectFrom("cleanup_runs")
      .select("status")
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!exists) return "missing";
    return exists.status === "succeeded" || exists.status === "failed" ? "done" : "busy";
  }
  const target: RetentionTarget =
    run.account_id === null ? { scope: "site" } : { scope: "account", accountId: run.account_id };
  const categories = await kdb
    .selectFrom("cleanup_run_categories")
    .selectAll()
    .where("run_id", "=", runId)
    .orderBy("position")
    .execute();
  const maxBatches = options.maxBatches ?? 50;
  const deadline = Date.now() + (options.maxMs ?? 20_000);
  let batches = 0;

  /** Saves progress under the lease; false when the lease was lost. */
  const save = async (
    name: string,
    set: {
      status?: "running" | "succeeded" | "failed";
      cursor?: string | null;
      items?: number;
      bytes?: number;
      batch?: boolean;
      error?: string;
    },
  ): Promise<boolean> => {
    const now = clock().toISOString();
    // One transaction: the category's progress only while this worker holds
    // the lease, and the run's totals with it.
    const [category, held] = await batch(env.DB, [
      kdb
        .updateTable("cleanup_run_categories")
        .set((eb) => ({
          ...(set.status ? { status: set.status } : {}),
          ...(set.status === "running" ? { started_at: now } : {}),
          ...(set.status === "succeeded" || set.status === "failed" ? { finished_at: now } : {}),
          ...(set.cursor !== undefined ? { cursor: set.cursor } : {}),
          ...(set.error !== undefined ? { error: set.error } : {}),
          items: eb("items", "+", set.items ?? 0),
          bytes: eb("bytes", "+", set.bytes ?? 0),
          batches: eb("batches", "+", set.batch ? 1 : 0),
        }))
        .where("run_id", "=", runId)
        .where("category", "=", name)
        .where((eb) =>
          eb.exists(
            eb
              .selectFrom("cleanup_runs")
              .select("id")
              .where("id", "=", runId)
              .where("lease_token", "=", token),
          ),
        ),
      kdb
        .updateTable("cleanup_runs")
        .set((eb) => ({
          items: eb("items", "+", set.items ?? 0),
          bytes: eb("bytes", "+", set.bytes ?? 0),
          lease_until: new Date(clock().getTime() + LEASE_MS).toISOString(),
          updated_at: now,
        }))
        .where("id", "=", runId)
        .where("lease_token", "=", token),
    ]);
    return (category?.meta.changes ?? 0) > 0 && (held?.meta.changes ?? 0) > 0;
  };

  for (const row of categories) {
    if (row.status === "succeeded" || row.status === "failed") continue;
    const cleanup = cleanupFor(row.category);
    if (!cleanup || !category(row.category)) {
      if (!(await save(row.category, { status: "failed", error: "No cleanup for this category." })))
        return "busy";
      continue;
    }
    if (row.status === "pending" && !(await save(row.category, { status: "running" })))
      return "busy";
    const ctx: CleanupContext = {
      env,
      target,
      thresholds: JSON.parse(row.thresholds) as Record<string, number>,
      now: new Date(run.as_of),
      limit: options.limit ?? BATCH_LIMIT,
    };
    let cursor = row.cursor;
    for (;;) {
      if (batches >= maxBatches || Date.now() > deadline) {
        await kdb
          .updateTable("cleanup_runs")
          .set({ lease_token: null, lease_until: null })
          .where("id", "=", runId)
          .where("lease_token", "=", token)
          .execute();
        return "more";
      }
      let progress: { next: string | null; count: number; bytes: number };
      try {
        const selection = await cleanup.select(ctx, cursor);
        let count = selection.count ?? selection.items.length;
        let bytes = selection.bytes;
        if (!run.dry_run && selection.items.length > 0) {
          const removed = await cleanup.remove(ctx, selection.items);
          count = removed.count;
          bytes = removed.bytes;
        }
        await options.afterBatch?.(row.category, selection.items);
        progress = { next: selection.next, count, bytes };
      } catch (error) {
        if (error instanceof SimulatedCrash) throw error;
        console.error(`Retention: ${row.category} failed in run ${runId}`, error);
        const message = error instanceof Error ? error.message : String(error);
        if (!(await save(row.category, { status: "failed", error: message.slice(0, 500) })))
          return "busy";
        break;
      }
      batches++;
      const last = progress.next === null;
      const saved = await save(row.category, {
        cursor: progress.next,
        items: progress.count,
        bytes: progress.bytes,
        batch: true,
        ...(last ? { status: "succeeded" as const } : {}),
      });
      if (!saved) return "busy";
      if (last) break;
      cursor = progress.next;
    }
  }

  const failed = await kdb
    .selectFrom("cleanup_run_categories")
    .select(["category", "error"])
    .where("run_id", "=", runId)
    .where("status", "=", "failed")
    .execute();
  const end = clock().toISOString();
  await kdb
    .updateTable("cleanup_runs")
    .set({
      status: failed.length ? "failed" : "succeeded",
      error: failed.length ? failed.map((f) => `${f.category}: ${f.error}`).join("; ") : null,
      finished_at: end,
      updated_at: end,
      lease_token: null,
      lease_until: null,
    })
    .where("id", "=", runId)
    .where("lease_token", "=", token)
    .execute();
  return "done";
}

/** Thrown by tests' `afterBatch` to stand for a worker dying mid-run. */
export class SimulatedCrash extends Error {}

/** Advances a run once, then queues the rest; the cron picks up whatever stalls. */
export async function continueRun(
  env: Env,
  runId: number,
  options: AdvanceOptions = {},
): Promise<"done" | "more" | "busy" | "missing"> {
  const state = await advanceRun(env, runId, options);
  if (state === "more" && env.JOBS && productionOnly(env, "queue", `retention run ${runId}`))
    await env.JOBS.send({ type: "retention", runId } satisfies RetentionJob);
  return state;
}

/** The gitmatrix-jobs consumer for {type: "retention"}. */
export async function runRetentionJob(env: Env, message: Message<RetentionJob>): Promise<void> {
  try {
    await continueRun(env, message.body.runId);
    message.ack();
  } catch (error) {
    console.error("Retention: run failed to advance", message.body, error);
    message.retry();
  }
}

/**
 * Hourly: start scheduled runs that are due, and restart stalled ones. With
 * nothing enabled and no run open, it reads and writes nothing else.
 */
export async function retentionCron(
  env: Env,
  options: { now?: Date; advance?: AdvanceOptions } = {},
): Promise<{ scheduled: number[]; restarted: number[] }> {
  const now = options.now ?? new Date();
  const kdb = db(env.DB);
  const scheduled: number[] = [];
  for (const { target, policies } of await enabledTargets(env.DB)) {
    const runnable = policies.filter((p) => cleanupFor(p.id));
    if (!runnable.length) continue;
    let recent = kdb
      .selectFrom("cleanup_runs")
      .select("id")
      .where("trigger", "=", "schedule")
      .where("created_at", ">", new Date(now.getTime() - SCHEDULE_EVERY_MS).toISOString());
    recent =
      target.scope === "site"
        ? recent.where("account_id", "is", null)
        : recent.where("account_id", "=", target.accountId);
    if (await recent.executeTakeFirst()) continue;
    scheduled.push(
      await createRun(env.DB, {
        target,
        trigger: "schedule",
        actorId: null,
        dryRun: false,
        categories: runnable.map((p) => ({ id: p.id, thresholds: p.values })),
        now,
      }),
    );
  }
  const stalled = await kdb
    .selectFrom("cleanup_runs")
    .select("id")
    .where("status", "in", ["queued", "running"])
    .where((eb) =>
      eb.or([eb("lease_until", "is", null), eb("lease_until", "<", now.toISOString())]),
    )
    .where("updated_at", "<", new Date(now.getTime() - STALLED_MS).toISOString())
    .orderBy("id")
    .limit(20)
    .execute();
  const restarted = stalled.map((r) => r.id);
  for (const id of [...scheduled, ...restarted]) await continueRun(env, id, options.advance);
  return { scheduled, restarted };
}

function runQuery(d1: D1Database, target: RetentionTarget) {
  const query = db(d1)
    .selectFrom("cleanup_runs as r")
    .leftJoin("accounts as a", "a.id", "r.actor_id")
    .leftJoin("accounts as o", "o.id", "r.account_id")
    .select([
      "r.id",
      "r.account_id",
      "o.slug as account",
      "r.trigger",
      "a.slug as actor",
      "r.dry_run",
      "r.status",
      "r.as_of",
      "r.created_at",
      "r.started_at",
      "r.finished_at",
      "r.items",
      "r.bytes",
      "r.error",
    ]);
  return target.scope === "site"
    ? query.where("r.account_id", "is", null)
    : query.where("r.account_id", "=", target.accountId);
}

type RunRow = Awaited<ReturnType<ReturnType<typeof runQuery>["execute"]>>[number];

/** A target's runs, newest first; `before` is the previous page's `next`. */
export async function listRuns(
  d1: D1Database,
  target: RetentionTarget,
  page: { before?: number; limit?: number } = {},
): Promise<RetentionRunPage> {
  const limit = Math.min(Math.max(page.limit ?? 20, 1), 100);
  let query = runQuery(d1, target)
    .orderBy("r.id", "desc")
    .limit(limit + 1);
  if (page.before !== undefined) query = query.where("r.id", "<", page.before);
  const rows = await query.execute();
  const runs = await toRuns(d1, rows.slice(0, limit));
  return { runs, next: rows.length > limit ? runs.at(-1)!.id : null };
}

/** One of a target's runs, or null (another target's runs are not found either). */
export async function getRun(
  d1: D1Database,
  target: RetentionTarget,
  id: number,
): Promise<RetentionRun | null> {
  const row = await runQuery(d1, target).where("r.id", "=", id).executeTakeFirst();
  return row ? (await toRuns(d1, [row]))[0]! : null;
}

/** What a dry run's figures can't say on their own. */
export function runNotes(dryRun: boolean, categories: readonly string[]): string[] {
  if (!dryRun) return [];
  return overlappingPairs(categories).map(
    ([a, b]) =>
      `${a.label} and ${b.label} can select the same records. This preview counts those under both, so its total is higher than what a run removes; a run removes each record once. Preview them separately for exact figures.`,
  );
}

async function toRuns(d1: D1Database, rows: RunRow[]): Promise<RetentionRun[]> {
  if (!rows.length) return [];
  const timeline = await priceTimeline(d1);
  const categories = await db(d1)
    .selectFrom("cleanup_run_categories")
    .selectAll()
    .where(
      "run_id",
      "in",
      rows.map((r) => r.id),
    )
    .orderBy("run_id")
    .orderBy("position")
    .execute();
  return rows.map((r) => {
    const own = categories.filter((c) => c.run_id === r.id);
    return {
      id: r.id,
      level: r.account_id === null ? "site" : "account",
      account: r.account,
      trigger: r.trigger,
      actor: r.actor,
      dryRun: r.dry_run === 1,
      status: r.status,
      asOf: r.as_of,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      items: r.items,
      bytes: r.bytes,
      error: r.error,
      notes: runNotes(
        r.dry_run === 1,
        own.map((c) => c.category),
      ),
      categories: own.map((c): RetentionRunCategory => ({
        category: c.category,
        label: category(c.category)?.label ?? c.category,
        status: c.status,
        thresholds: JSON.parse(c.thresholds) as Record<string, number>,
        items: c.items,
        bytes: c.bytes,
        batches: c.batches,
        error: c.error,
        startedAt: c.started_at,
        finishedAt: c.finished_at,
        cost: categoryCost(timeline, c.category, c.bytes, r.as_of.slice(0, 10)),
      })),
    };
  });
}
