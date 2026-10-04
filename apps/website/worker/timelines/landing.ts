// The landing queue (CORE-77, TIMELINES-RESEARCH.md "Landing"): the Worker's
// half. A landing (shared/timelines.ts) is kept in the tracker with its
// timeline; this moves it on, each time something it waits for happens: a CI
// run ends (ci/workflow.ts), a person approves a checkpoint, a checkpoint is
// made, someone runs `gm timeline land`, or the hourly sweep looks.
//
// For each repository the queue merges the checkpoint into the main commit it
// pins, in a CI job (ci/landing.ts), onto refs/heads/gitmatrix/landing/<slug>;
// checks the merge's parents; and runs the repository's own pipeline on it
// (`trigger == "landing"`). Only once every repository's merge passed does any
// main move, one repository at a time, with a compare-and-swap from the
// commit its merge was tested on. A main that moved meanwhile is merged and
// tested again (the timeline shows `partly_landed` once another repository
// advanced). A conflict stops the landing and asks for a sync: there is no
// automatic sync with main. Main never advances to a merge that wasn't tested.
//
// When every main advanced, the tracker folds the timeline's view into main
// and records it landed in one transaction (issues done, retained leases
// released), and only then are its bookmarks deleted, so knowledge overlays
// end as landed. Each main's move fires what a push to main fires: the push
// log and timeline activity, CI on main, the mirror, knowledge, release notes.
//
// Every step reads what it needs afresh (the landing's version, CI run rows,
// refs), saves before acting where it can, and acts idempotently, so a step
// that runs twice, or a hook that never fired, only costs a later look.

import { lsRefs } from "../artifacts.ts";
import { runOutcome, startMergeRun } from "../ci/landing.ts";
import { startRun } from "../ci/trigger.ts";
import type { Actor } from "../db.ts";
import { afterPush, type PushedRepo } from "../git/effects.ts";
import { db } from "../schema.ts";
import {
  LANDING_ACTIVE,
  landingBranch,
  landingSlugOf,
  timelineBookmark,
  timelineSlugOf,
  type CheckpointState,
  type Landing,
  type LandingRepo,
  type LandResult,
  type Timeline,
} from "../../shared/timelines.ts";
import { accessFor } from "../tracker/access.ts";
import type { TrackerReply } from "../tracker/object.ts";
import { TrackerError, type Access } from "../tracker/store.ts";
import { trackerObject } from "../tracker/stub.ts";
import { logPush } from "./activity.ts";
import { writeRefs, type RefWrite, type RefWriteResult } from "./bookmarks.ts";

/** Merges tried per repository before a main that keeps moving stops the landing. */
export const MAX_ATTEMPTS = 5;
/** Steps one look takes at most: each saves the landing once. */
const MAX_STEPS = 40;

type RunOutcome = NonNullable<Awaited<ReturnType<typeof runOutcome>>>;

/** What the queue does to the world, replaceable in tests. */
export interface LandingDeps {
  /** A repository's refs now: name to commit. */
  refs(repo: PushedRepo): Promise<Map<string, string>>;
  writeRefs(repo: PushedRepo, writes: RefWrite[]): Promise<RefWriteResult[]>;
  /** A commit's parents, or null when the repository doesn't have it. */
  parents(repo: PushedRepo, oid: string): Promise<string[] | null>;
  startMerge(repo: PushedRepo, options: Parameters<typeof startMergeRun>[2]): Promise<unknown>;
  /** Run the repository's pipeline on the merge; skipped when it has none. */
  startGates(
    repo: PushedRepo,
    options: {
      runId: string;
      landingId: string;
      branch: string;
      commit: string;
      actor: RunActor;
    },
  ): Promise<{ skipped: string } | object>;
  runOutcome(runId: string): Promise<RunOutcome | null>;
  /** Main moved: everything a push to main sets off. */
  mainMoved(repo: PushedRepo, actor: RunActor): void;
  /** Bookmarks and the landing branch went: the push log and timeline activity. */
  refsDeleted(repo: PushedRepo, actor: RunActor): Promise<void>;
}

type RunActor = Pick<Actor, "id" | "agent">;

/** The queue as it runs in the Worker. */
export function workerDeps(env: Env, waitUntil: (work: Promise<unknown>) => void): LandingDeps {
  return {
    refs: async (repo) =>
      new Map(
        (await lsRefs(env, repo.artifacts_name, repo.artifacts_remote)).flatMap((r) =>
          r.oid ? [[r.name, r.oid] as const] : [],
        ),
      ),
    writeRefs: (repo, writes) => writeRefs(env, repo, writes),
    parents: async (repo, oid) => {
      using artifacts = await env.ARTIFACTS.get(repo.artifacts_name);
      return (await artifacts.readCommit(oid))?.parents ?? null;
    },
    startMerge: (repo, options) => startMergeRun(env, repo, options),
    startGates: (repo, options) =>
      startRun(env, repo, {
        branch: options.branch,
        commit: options.commit,
        trigger: "landing",
        actor: options.actor,
        waitUntil,
        runId: options.runId,
        landingId: options.landingId,
      }),
    runOutcome: (runId) => runOutcome(env.DB, runId),
    mainMoved: (repo, actor) => afterPush(env, repo, actor, waitUntil),
    refsDeleted: (repo, actor) => logPush(env, repo, actor),
  };
}

function unwrap<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new TrackerError(reply.status, reply.code, reply.error);
  return reply.value;
}

const short = (oid: string | null) => (oid ? oid.slice(0, 12) : "none");

/** The repositories a landing touches, as the push machinery needs them. */
async function repoRows(d1: D1Database, ids: string[]): Promise<Map<string, PushedRepo>> {
  if (!ids.length) return new Map();
  const rows = await db(d1)
    .selectFrom("repos as r")
    .innerJoin("accounts as o", "o.id", "r.owner_id")
    .select([
      "r.id",
      "r.owner_id",
      "o.slug as owner_slug",
      "r.name",
      "r.default_branch",
      "r.artifacts_name",
      "r.artifacts_remote",
    ])
    .where("r.id", "in", ids)
    .where("r.deleted_at", "is", null)
    .execute();
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Whether a checkpoint is green: each repository's newest CI run of its
 * commit on the timeline's bookmark succeeded. A repository with no run of it
 * has no CI to wait for. Green only queues the landing: the gates still run
 * on the merge before main moves.
 */
export async function greenness(
  d1: D1Database,
  timeline: Pick<Timeline, "slug">,
  state: CheckpointState,
): Promise<{ ok: boolean; why: string | null }> {
  const branch = timelineBookmark(timeline.slug);
  for (const repo of state.checkpoint.repos) {
    const run = await db(d1)
      .selectFrom("ci_runs")
      .select(["number", "status"])
      .where("repo_id", "=", repo.id)
      .where("commit_oid", "=", repo.commit)
      .where("ref", "=", branch)
      // Step runs are light checks per push, not the timeline's CI (CORE-235).
      .where("step", "=", 0)
      .orderBy("number", "desc")
      .executeTakeFirst();
    if (!run || run.status === "succeeded") continue;
    const where = `${repo.owner}/${repo.name}`;
    return {
      ok: false,
      why:
        run.status === "queued" || run.status === "running"
          ? `Checkpoint #${state.checkpoint.number} isn't green yet: CI run #${run.number} on ${where} is still ${run.status}. It lands when that succeeds.`
          : `Checkpoint #${state.checkpoint.number} isn't green: CI run #${run.number} on ${where} ${run.status === "failed" ? "failed" : "was cancelled"}. Push a fix and make a new checkpoint.`,
    };
  }
  return { ok: true, why: null };
}

interface Context {
  env: Env;
  deps: LandingDeps;
  ownerId: string;
  rows: Map<string, PushedRepo>;
}

function actorOf(landing: Landing): RunActor {
  const { accountableId, agentId } = landing.requestedBy;
  return { id: accountableId, ...(agentId ? { agent: { id: agentId, name: "" } } : {}) };
}

function withRepo(landing: Landing, id: string, change: Partial<LandingRepo>): Landing {
  return {
    ...landing,
    repos: landing.repos.map((repo) => (repo.id === id ? { ...repo, ...change } : repo)),
  };
}

/** Stop the landing, with why; the repository that stopped it says so too. */
function stopped(
  landing: Landing,
  state: "conflict" | "failed",
  reason: string,
  repoId?: string,
): Landing {
  const next = repoId ? withRepo(landing, repoId, { state, reason }) : landing;
  return { ...next, state, reason };
}

/**
 * A run of the same merge already in flight answers for the gates (CI starts
 * one run per branch and commit): the landing follows that one instead.
 */
async function adopted(
  ctx: Context,
  landing: Landing,
  repoId: string,
  started: object,
): Promise<Landing | null> {
  const repo = landing.repos.find((r) => r.id === repoId)!;
  const run = started as { runId?: string; number?: number };
  if (!run.runId || run.runId === repo.gateRun?.id) return landing;
  return save(
    ctx,
    landing,
    withRepo(landing, repoId, { gateRun: { id: run.runId, number: run.number ?? 0 } }),
  );
}

/** Why a CI run couldn't start, for people. */
function couldnt(what: string, error: unknown): string {
  const why = error instanceof Error ? error.message : String(error);
  return `Couldn't start the ${what} (${why}). Land again to retry.`;
}

/** Save a step; null when someone else moved the landing first. */
async function save(ctx: Context, from: Landing, next: Landing): Promise<Landing | null> {
  const reply = await trackerObject(ctx.env, ctx.ownerId).saveLanding(
    next,
    from.version,
    from.requestedBy.agentId ?? from.requestedBy.actorId,
  );
  if (reply.ok) return reply.value;
  if (reply.code === "version_conflict" || reply.code === "landing_ended") return null;
  // Moving on refused (the checkpoint moved, say): stop with the tracker's reason.
  if (next.state !== from.state && LANDING_ACTIVE.includes(next.state)) {
    const retry = await trackerObject(ctx.env, ctx.ownerId).saveLanding(
      stopped(from, "failed", reply.error),
      from.version,
      from.requestedBy.agentId ?? from.requestedBy.actorId,
    );
    return retry.ok ? retry.value : null;
  }
  throw new TrackerError(reply.status, reply.code, reply.error);
}

/** One step of a landing: saved, or null when there is nothing to do yet. */
async function step(ctx: Context, landing: Landing): Promise<Landing | null> {
  const { deps } = ctx;
  const branch = landingBranch(landing.slug);
  const branchRef = `refs/heads/${branch}`;
  const bookmarkRef = `refs/heads/${timelineBookmark(landing.slug)}`;
  const row = (repo: LandingRepo) => ctx.rows.get(repo.id);
  const where = (repo: LandingRepo) => `${repo.owner}/${repo.name}`;

  for (const repo of landing.repos) {
    const r = row(repo);
    if (!r && repo.state !== "advanced")
      return save(ctx, landing, stopped(landing, "failed", `${where(repo)} is gone.`, repo.id));
  }

  // Merge: each repository merges the checkpoint into its main as it is now.
  for (const repo of landing.repos) {
    if (repo.state !== "merging" || repo.mergeRun) continue;
    if (repo.attempt >= MAX_ATTEMPTS)
      return save(
        ctx,
        landing,
        stopped(
          landing,
          "failed",
          `${where(repo)}'s main kept moving: ${MAX_ATTEMPTS} merges were tested and main moved past each. Land again when it's quieter.`,
          repo.id,
        ),
      );
    const r = row(repo)!;
    const tips = await deps.refs(r);
    const base = tips.get(`refs/heads/${r.default_branch}`) ?? null;
    if (!base)
      return save(
        ctx,
        landing,
        stopped(
          landing,
          "failed",
          `${where(repo)} has no ${r.default_branch} to land on.`,
          repo.id,
        ),
      );
    const runId = crypto.randomUUID().replaceAll("-", "");
    const saved = await save(
      ctx,
      landing,
      withRepo(landing, repo.id, {
        base,
        merge: null,
        attempt: repo.attempt + 1,
        mergeRun: { id: runId, number: 0 },
        gateRun: null,
        reason: null,
      }),
    );
    if (!saved) return null;
    try {
      await startMerge(ctx, saved, repo.id, tips.get(branchRef) ?? null);
    } catch (error) {
      return save(ctx, saved, stopped(saved, "failed", couldnt("merge job", error), repo.id));
    }
    return saved;
  }

  // The merge jobs that finished.
  for (const repo of landing.repos) {
    if (repo.state !== "merging" || !repo.mergeRun) continue;
    const run = await deps.runOutcome(repo.mergeRun.id);
    // Saved but never started (the Worker stopped in between): start it now.
    if (!run) {
      const r = row(repo)!;
      await startMerge(ctx, landing, repo.id, (await deps.refs(r)).get(branchRef) ?? null);
      continue;
    }
    if (run.status === "queued" || run.status === "running") {
      if (repo.mergeRun.number !== run.number)
        return save(
          ctx,
          landing,
          withRepo(landing, repo.id, { mergeRun: { id: repo.mergeRun.id, number: run.number } }),
        );
      continue;
    }
    const mergeRun = { id: repo.mergeRun.id, number: run.number };
    if (run.status !== "succeeded") {
      if (run.conflict)
        return save(
          ctx,
          landing,
          stopped(
            { ...withRepo(landing, repo.id, { mergeRun }) },
            "conflict",
            `Checkpoint #${landing.checkpointNumber} conflicts with ${where(repo)}'s main (CI run #${run.number} lists the files). Landing needs a sync: merge main into ${timelineBookmark(landing.slug)} (gm merge, or ask an agent to), push, make a new checkpoint, and land that.`,
            repo.id,
          ),
        );
      return save(
        ctx,
        landing,
        stopped(
          withRepo(landing, repo.id, { mergeRun }),
          "failed",
          `The merge into ${where(repo)}'s main ${run.status === "cancelled" ? "was cancelled" : "failed"} (CI run #${run.number}). Land again to retry.`,
          repo.id,
        ),
      );
    }
    const r = row(repo)!;
    const merge = (await deps.refs(r)).get(branchRef) ?? null;
    // The checkpoint was already in main: there's nothing to merge or move.
    if (merge && merge === repo.base)
      return save(
        ctx,
        landing,
        withRepo(landing, repo.id, {
          mergeRun,
          merge,
          state: "advanced",
          reason: `${r.default_branch} already had this work.`,
        }),
      );
    const parents = merge ? await deps.parents(r, merge) : null;
    if (!merge || parents?.length !== 2 || parents[0] !== repo.base || parents[1] !== repo.commit)
      return save(
        ctx,
        landing,
        stopped(
          withRepo(landing, repo.id, { mergeRun }),
          "failed",
          `The merge job left ${branch} in ${where(repo)} at ${short(merge)}, not a merge of checkpoint #${landing.checkpointNumber} into main's ${short(repo.base)}. Land again to retry.`,
          repo.id,
        ),
      );
    const gateId = crypto.randomUUID().replaceAll("-", "");
    const saved = await save(
      ctx,
      landing,
      withRepo(landing, repo.id, {
        mergeRun,
        merge,
        state: "testing",
        gateRun: { id: gateId, number: 0 },
      }),
    );
    if (!saved) return null;
    let started: Awaited<ReturnType<LandingDeps["startGates"]>>;
    try {
      started = await deps.startGates(r, {
        runId: gateId,
        landingId: saved.id,
        branch,
        commit: merge,
        actor: actorOf(saved),
      });
    } catch (error) {
      return save(ctx, saved, stopped(saved, "failed", couldnt("gates", error), repo.id));
    }
    // No pipeline, or no job for a landing: nothing gates it.
    if ("skipped" in started)
      return save(
        ctx,
        saved,
        withRepo(saved, repo.id, {
          state: "tested",
          gateRun: null,
          reason: `No gates: ${started.skipped}`,
        }),
      );
    return adopted(ctx, saved, repo.id, started);
  }

  // The gates that finished.
  for (const repo of landing.repos) {
    if (repo.state !== "testing" || !repo.gateRun) continue;
    const run = await deps.runOutcome(repo.gateRun.id);
    if (!run) {
      const started = await deps.startGates(row(repo)!, {
        runId: repo.gateRun.id,
        landingId: landing.id,
        branch,
        commit: repo.merge!,
        actor: actorOf(landing),
      });
      if ("skipped" in started)
        return save(
          ctx,
          landing,
          withRepo(landing, repo.id, { state: "tested", gateRun: null, reason: started.skipped }),
        );
      const moved = await adopted(ctx, landing, repo.id, started);
      if (moved !== landing) return moved;
      continue;
    }
    const gateRun = { id: repo.gateRun.id, number: run.number };
    if (run.status === "queued" || run.status === "running") {
      if (repo.gateRun.number !== run.number)
        return save(ctx, landing, withRepo(landing, repo.id, { gateRun }));
      continue;
    }
    if (run.status === "succeeded")
      return save(ctx, landing, withRepo(landing, repo.id, { gateRun, state: "tested" }));
    const jobs = run.failedJobs.length ? ` (${run.failedJobs.join(", ")})` : "";
    return save(
      ctx,
      landing,
      stopped(
        withRepo(landing, repo.id, { gateRun }),
        "failed",
        `The gates failed on the merge into ${where(repo)}'s main: CI run #${run.number}${jobs} ${run.status === "cancelled" ? "was cancelled" : "failed"}. Main didn't move. Push a fix, make a new checkpoint and land that.`,
        repo.id,
      ),
    );
  }

  const left = landing.repos.filter((repo) => repo.state !== "advanced");
  // Everything prepared: only now does any main move.
  if (landing.state !== "advancing") {
    if (left.some((repo) => repo.state !== "tested")) return null;
    return save(ctx, landing, { ...landing, state: "advancing", reason: null });
  }

  // Advance each main in turn, from the commit its merge was tested on.
  const repo = left[0];
  if (repo) {
    const r = row(repo)!;
    const mainRef = `refs/heads/${r.default_branch}`;
    const tips = await deps.refs(r);
    if (tips.get(bookmarkRef) !== repo.commit)
      return save(
        ctx,
        landing,
        stopped(
          landing,
          "failed",
          `${timelineBookmark(landing.slug)} in ${where(repo)} moved past checkpoint #${landing.checkpointNumber}; make a new checkpoint and land that.`,
          repo.id,
        ),
      );
    let advanced = tips.get(mainRef) === repo.merge;
    if (!advanced) {
      const [result] = await deps.writeRefs(r, [{ ref: mainRef, old: repo.base, new: repo.merge }]);
      advanced = !!result?.ok || (await deps.refs(r)).get(mainRef) === repo.merge;
      if (advanced) deps.mainMoved(r, actorOf(landing));
    }
    if (advanced) {
      // The landing branch has done its job.
      const now = await deps.refs(r);
      const tip = now.get(branchRef);
      if (tip) await deps.writeRefs(r, [{ ref: branchRef, old: tip, new: null }]).catch(() => []);
      return save(ctx, landing, withRepo(landing, repo.id, { state: "advanced", reason: null }));
    }
    // Main moved since the merge was tested: merge onto it and test again.
    const moved = (await deps.refs(r)).get(mainRef) ?? null;
    return save(ctx, landing, {
      ...withRepo(landing, repo.id, {
        state: "merging",
        base: null,
        merge: null,
        mergeRun: null,
        gateRun: null,
        reason: `${r.default_branch} moved to ${short(moved)} before it advanced; merging again.`,
      }),
      state: "merging",
    });
  }

  // Every main advanced: the timeline lands.
  return complete(ctx, landing);
}

/** Point the landing branch at the checkpoint, then start the merge job on it. */
/**
 * Point the landing branch at the checkpoint, then start the merge job on it.
 * Idempotent, so two looks at the same landing (the auto queue after a
 * checkpoint, and `gm timeline land`, say) may both do it: a ref someone
 * else already moved is fine, and starting the saved run id again is a no-op.
 */
async function startMerge(ctx: Context, landing: Landing, repoId: string, tip: string | null) {
  const repo = landing.repos.find((r) => r.id === repoId)!;
  const r = ctx.rows.get(repoId)!;
  const branch = landingBranch(landing.slug);
  if (tip !== repo.commit) {
    const [result] = await ctx.deps.writeRefs(r, [
      { ref: `refs/heads/${branch}`, old: tip, new: repo.commit },
    ]);
    if (!result?.ok) {
      // Moved meanwhile: by another look at this landing, or by its merge job.
      const now = (await ctx.deps.refs(r)).get(`refs/heads/${branch}`) ?? null;
      if (await ctx.deps.runOutcome(repo.mergeRun!.id)) return;
      if (now !== repo.commit)
        throw new Error(
          `Couldn't point ${branch} at the checkpoint: ${result?.reason ?? "refused"}`,
        );
    }
  }
  await ctx.deps.startMerge(r, {
    runId: repo.mergeRun!.id,
    landingId: landing.id,
    slug: landing.slug,
    branch,
    commit: repo.commit,
    base: repo.base!,
    mainBranch: r.default_branch,
    title: `Land ${landing.slug} (checkpoint #${landing.checkpointNumber}): merge into ${r.default_branch}`,
    message: `Land timeline ${landing.slug} (checkpoint #${landing.checkpointNumber})\n\nMerges ${timelineBookmark(landing.slug)} at ${repo.commit.slice(0, 12)} into ${r.default_branch}.\n\nTimeline: ${landing.slug}\nCheckpoint: ${landing.checkpointId}`,
    author: { name: "Gitmatrix", email: "landing@gitmatrix.invalid" },
    actor: { id: landing.requestedBy.accountableId, agentId: landing.requestedBy.agentId },
  });
}

/** Record the timeline landed (issues and leases with it), then delete its bookmarks. */
async function complete(ctx: Context, landing: Landing): Promise<Landing | null> {
  const owner = await db(ctx.env.DB)
    .selectFrom("accounts")
    .selectAll()
    .where("id", "=", ctx.ownerId)
    .executeTakeFirst();
  if (!owner) return null;
  const by = landing.requestedBy;
  const access: Access = await accessFor(ctx.env.DB, owner, by.accountableId, by.agentId);
  const reply = await trackerObject(ctx.env, ctx.ownerId).completeLanding(
    access,
    landing,
    landing.version,
  );
  if (!reply.ok) {
    if (reply.code === "version_conflict" || reply.code === "landing_ended") return null;
    throw new TrackerError(reply.status, reply.code, reply.error);
  }
  if (reply.value.state !== "landed") return reply.value;
  // Landed is recorded first (CORE-139): overlays then end as landed.
  const bookmark = `refs/heads/${timelineBookmark(landing.slug)}`;
  const branch = `refs/heads/${landingBranch(landing.slug)}`;
  for (const repo of landing.repos) {
    const r = ctx.rows.get(repo.id);
    if (!r) continue;
    try {
      const tips = await ctx.deps.refs(r);
      const writes: RefWrite[] = [];
      if (tips.get(bookmark) === repo.commit)
        writes.push({ ref: bookmark, old: repo.commit, new: null });
      const tip = tips.get(branch);
      if (tip) writes.push({ ref: branch, old: tip, new: null });
      if (writes.length) await ctx.deps.writeRefs(r, writes);
      await ctx.deps.refsDeleted(r, actorOf(landing));
    } catch (error) {
      console.error("Landing: deleting a landed timeline's bookmark failed", {
        repo: repo.id,
        error,
      });
    }
  }
  return reply.value;
}

/** Move a landing on as far as it can go now. */
export async function progress(
  env: Env,
  deps: LandingDeps,
  ownerId: string,
  landing: Landing,
): Promise<Landing> {
  const ctx: Context = {
    env,
    deps,
    ownerId,
    rows: await repoRows(
      env.DB,
      landing.repos.map((repo) => repo.id),
    ),
  };
  for (let i = 0; i < MAX_STEPS && LANDING_ACTIVE.includes(landing.state); i++) {
    let next: Landing | null;
    try {
      next = await step(ctx, landing);
    } catch (error) {
      // Each step is safe to repeat: the next look (a run's end, the cron,
      // `gm timeline land`) picks it up. Whoever asked gets the landing as it is.
      console.error("Landing: a step failed; the next look retries it", {
        landing: landing.id,
        error,
      });
      const latest = await trackerObject(env, ownerId).landing(landing.slug);
      return latest.ok && latest.value?.id === landing.id ? latest.value : landing;
    }
    if (!next) {
      // Someone else moved it, or there's nothing to do until a run ends.
      const latest = unwrap(await trackerObject(env, ownerId).landing(landing.slug));
      if (!latest || latest.id !== landing.id || latest.version === landing.version) break;
      landing = latest;
      continue;
    }
    landing = next;
  }
  return landing;
}

/**
 * Queue a landing of a timeline's head checkpoint, or explain why not (a
 * TrackerError), and move it on. Whoever asks is who landing acts for.
 */
export async function requestLanding(
  env: Env,
  deps: LandingDeps,
  access: Access,
  slug: string,
  trigger: Landing["trigger"],
): Promise<LandResult> {
  const tracker = trackerObject(env, access.owner.id);
  const timeline = unwrap(await tracker.timeline(slug, 0, 1)).timeline;
  const head = unwrap(await tracker.checkpoints(timeline.slug))[0];
  const green =
    timeline.policy === "auto" && head
      ? await greenness(env.DB, timeline, head)
      : { ok: true, why: null };
  const agentId = access.actorId !== access.principalId ? access.actorId : null;
  const result = unwrap(
    await tracker.beginLanding(access, timeline.slug, { trigger, green, agentId }),
  );
  const landing = await progress(env, deps, access.owner.id, result.landing);
  return { landing, queued: result.queued };
}

/**
 * Something may have made a timeline landable: an `auto` timeline's
 * checkpoint went green, or a person approved one. Queues it if so; never
 * throws (why it isn't landable is in the timeline's status and checkpoint).
 */
export async function maybeLand(
  env: Env,
  deps: LandingDeps,
  ownerId: string,
  slug: string,
  trigger: "auto" | "approval",
  by?: { principalId: string; agentId: string | null },
): Promise<Landing | null> {
  try {
    const tracker = trackerObject(env, ownerId);
    const timeline = unwrap(await tracker.timeline(slug, 0, 1)).timeline;
    if (timeline.status === "landed" || timeline.status === "abandoned") return null;
    if (trigger === "auto" && timeline.policy !== "auto") return null;
    if (trigger === "approval" && timeline.policy !== "approval") return null;
    const owner = await db(env.DB)
      .selectFrom("accounts")
      .selectAll()
      .where("id", "=", ownerId)
      .executeTakeFirst();
    if (!owner) return null;
    // An auto timeline lands for the person answerable for it.
    const access = await accessFor(
      env.DB,
      owner,
      by?.principalId ?? timeline.accountableId,
      by?.agentId ?? null,
    );
    return (await requestLanding(env, deps, access, slug, trigger)).landing;
  } catch (error) {
    if (!(error instanceof TrackerError)) console.error("Landing: queueing failed", error);
    return null;
  }
}

/**
 * A CI run ended (ci/workflow.ts): if it was a landing's merge or gates, move
 * that landing on; if it was a timeline's own run, an `auto` timeline may now
 * be green. Never throws.
 */
export async function afterRun(env: Env, deps: LandingDeps, runId: string): Promise<void> {
  try {
    const run = await db(env.DB)
      .selectFrom("ci_runs as c")
      .innerJoin("repos as r", "r.id", "c.repo_id")
      .select(["c.ref", "r.owner_id", "c.step"])
      .where("c.id", "=", runId)
      .executeTakeFirst();
    // A step run is a light check, not the timeline's CI: it never lands one.
    if (!run || run.step) return;
    const landingSlug = landingSlugOf(run.ref);
    if (landingSlug) {
      const reply = await trackerObject(env, run.owner_id).landingForRun(landingSlug, runId);
      if (reply.ok && reply.value) await progress(env, deps, run.owner_id, reply.value);
      return;
    }
    const slug = timelineSlugOf(`refs/heads/${run.ref}`);
    if (slug) await maybeLand(env, deps, run.owner_id, slug, "auto");
  } catch (error) {
    console.error("Landing: after a CI run", { runId, error });
  }
}

/**
 * The hourly look (worker/index.ts): landings whose runs ended in the last
 * day, in case a run's end didn't move them on.
 */
export async function sweepLandings(env: Env, deps: LandingDeps): Promise<void> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const runs = await db(env.DB)
    .selectFrom("ci_runs")
    .select("id")
    .where("ref", "like", "gitmatrix/landing/%")
    .where("finished_at", ">", since)
    .orderBy("finished_at", "desc")
    .limit(200)
    .execute();
  for (const run of runs) await afterRun(env, deps, run.id);
}

/** Work for a step or the cron: run `fn` with Worker deps and wait for what it set off. */
export async function settled(
  env: Env,
  fn: (deps: LandingDeps) => Promise<unknown>,
): Promise<void> {
  const work: Promise<unknown>[] = [];
  await fn(workerDeps(env, (w) => work.push(w)));
  while (work.length) await Promise.allSettled(work.splice(0));
}
