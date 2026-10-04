// Fewer runs without slower answers (CORE-23):
//
// - Dedupe: starting a commit that already has a run in flight on its branch
//   returns that run.
// - Unchanged jobs: a pushed job whose `paths` are identical to the last commit
//   it passed on the branch is skipped, and counts as passed for its dependents.
// - Coalescing: with on.push.coalesce_after runs in flight on a branch, a push's
//   run is held; when a run finishes, the newest held run starts and covers the
//   older held ones (their commits are its ancestors). `gm runs wait` follows the
//   covering run.

import { db, nowIso } from "../schema.ts";

/** The error a job skipped as unchanged carries (and how it's recognized). */
export const UNCHANGED = "Unchanged since run #";
/** A run in flight longer than this is presumed stuck and no longer counts. */
const STALE_HOURS = 3;

/**
 * A run of this commit still in flight on the branch, if any. Preview runs
 * (CORE-79) only answer for the same action and checkpoint, and never for a
 * push or manual run.
 */
export async function activeRun(
  d1: D1Database,
  repoId: string,
  ref: string,
  commit: string,
  preview: { action: "create" | "teardown"; checkpoint: string | null } | null = null,
  sourceId = "canonical",
) {
  let query = db(d1)
    .selectFrom("ci_runs")
    .select(["id", "number"])
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .where("ref", "=", ref)
    .where("commit_oid", "=", commit)
    .where("status", "in", ["queued", "running"]);
  query = preview
    ? query
        .where("preview_action", "=", preview.action)
        .where("checkpoint_id", preview.checkpoint === null ? "is" : "=", preview.checkpoint)
    : query.where("preview_action", "is", null);
  return (await query.orderBy("number", "desc").executeTakeFirst()) ?? null;
}

/** Runs actually in flight on the branch: started (not held), and not presumed stuck. */
export async function inFlight(
  d1: D1Database,
  repoId: string,
  ref: string,
  except: string,
  sourceId = "canonical",
): Promise<number> {
  const since = new Date(Date.now() - STALE_HOURS * 3_600_000).toISOString();
  const row = await db(d1)
    .selectFrom("ci_runs")
    .select((eb) => eb.fn.countAll<number>().as("n"))
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .where("ref", "=", ref)
    .where("id", "<>", except)
    .where("status", "in", ["queued", "running"])
    .where("held_at", "is", null)
    .where("preview_action", "is", null)
    .where("created_at", ">", since)
    .executeTakeFirst();
  return Number(row?.n ?? 0);
}

/** Whether any run on the branch is held, waiting for its turn. */
export async function anyHeld(
  d1: D1Database,
  repoId: string,
  ref: string,
  except: string,
  sourceId = "canonical",
) {
  return Boolean(
    await db(d1)
      .selectFrom("ci_runs")
      .select("id")
      .where("repo_id", "=", repoId)
      .where("source_id", "=", sourceId)
      .where("ref", "=", ref)
      .where("id", "<>", except)
      .where("held_at", "is not", null)
      .where("status", "=", "queued")
      .executeTakeFirst(),
  );
}

/**
 * The last run on the branch where this job passed with this exact spec (a pass
 * includes being skipped as unchanged, which stood in for one).
 */
export async function lastPassed(
  d1: D1Database,
  repoId: string,
  ref: string,
  name: string,
  spec: string,
  sourceId = "canonical",
): Promise<{ number: number; commit: string } | null> {
  const row = await db(d1)
    .selectFrom("ci_jobs as j")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .select(["r.number", "r.commit_oid"])
    .where("r.repo_id", "=", repoId)
    .where("r.source_id", "=", sourceId)
    .where("r.ref", "=", ref)
    .where("j.name", "=", name)
    .where("j.spec", "=", spec)
    .where((eb) =>
      eb.or([
        eb("j.status", "=", "succeeded"),
        eb.and([eb("j.status", "=", "skipped"), eb("j.error", "like", `${UNCHANGED}%`)]),
      ]),
    )
    .orderBy("r.number", "desc")
    .executeTakeFirst();
  return row ? { number: row.number, commit: row.commit_oid } : null;
}

/**
 * A slot is free on the branch: start its newest held run, and mark the older
 * held runs as covered by it. Returns the started run's number, if any.
 */
export async function releaseHeld(
  d1: D1Database,
  repoId: string,
  ref: string,
  start: (runId: string) => Promise<void>,
  sourceId = "canonical",
): Promise<number | null> {
  const kdb = db(d1);
  const held = await kdb
    .selectFrom("ci_runs")
    .select(["id", "number"])
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .where("ref", "=", ref)
    .where("held_at", "is not", null)
    .where("status", "=", "queued")
    .orderBy("number", "desc")
    .execute();
  const [newest, ...older] = held;
  if (!newest) return null;
  // Claim it: two runs finishing at once must not both start it.
  const { numUpdatedRows } = await kdb
    .updateTable("ci_runs")
    .set({ held_at: null })
    .where("id", "=", newest.id)
    .where("held_at", "is not", null)
    .executeTakeFirst();
  if (!numUpdatedRows) return null;
  try {
    await start(newest.id);
  } catch (error) {
    // Put it back on hold so the next release (or a retry) starts it.
    await kdb
      .updateTable("ci_runs")
      .set({ held_at: nowIso() })
      .where("id", "=", newest.id)
      .execute();
    throw error;
  }
  if (older.length) {
    const ids = older.map((run) => run.id);
    const covered = `Covered by run #${newest.number}, which tests a newer commit.`;
    await kdb
      .updateTable("ci_runs")
      .set({ status: "cancelled", held_at: null, covered_by: newest.number, finished_at: nowIso() })
      .where("id", "in", ids)
      .where("status", "=", "queued")
      .execute();
    await kdb
      .updateTable("ci_jobs")
      .set({ status: "cancelled", error: covered, finished_at: nowIso() })
      .where("run_id", "in", ids)
      .where("status", "in", ["pending", "queued"])
      .execute();
  }
  return newest.number;
}
