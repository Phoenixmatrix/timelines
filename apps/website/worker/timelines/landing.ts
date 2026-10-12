// Compact timeline landing: prepare exact logical-base/work/canonical trees,
// gate every repository, then publish with durable per-repository CAS receipts.
// Source writes are fenced by Tracker admission. Retries reconcile recorded
// candidates on canonical history before preparing anything again; successful
// partial results are fixed. Ordinary queue real-merge semantics are separate.

import { lsRefs } from "../artifacts.ts";
import { runOutcome, startMergeRun } from "../ci/landing.ts";
import { startRun } from "../ci/trigger.ts";
import { actorFromRow, type Actor } from "../db.ts";
import { afterPush, type PushedRepo } from "../git/effects.ts";
import { db } from "../schema.ts";
import {
  LANDING_ACTIVE,
  landingBranch,
  landingSlugOf,
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
import { getWorkSource } from "./sources.ts";
import { writableRepoIds } from "./checkpoints.ts";
import {
  completeReceipts,
  receiptFor,
  recordIntent,
  recordIntegrated,
  RevisionMetadata,
  revisionClosure,
  validateDependencies,
  validateMergeEdges,
} from "./integration.ts";
import { notifyReleaseNotes } from "../release-notes/queue.ts";
import { landingFixtureBarrier } from "./landing-fixture.ts";

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
  /** Pauses before retrying a failed step in place (default STEP_RETRY_MS). */
  stepRetryMs?: readonly number[];
}

/**
 * Retries of a failed step before it's left to the next look (CORE-305): a
 * provider hiccup, or in local development a dropped remote binding session,
 * would otherwise strand a landing until a run ends or the hourly cron.
 */
const STEP_RETRY_MS = [1_000, 4_000] as const;

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
 * commit on the timeline's bookmark succeeded (not a step run, and not a
 * preview's deploy). A repository with no run of it
 * has no CI to wait for, unless `requireRun`: approving on a person's behalf
 * (CORE-378) needs a run that succeeded in every repository. Green only queues
 * the landing: the gates still run on the merge before main moves.
 */
export async function greenness(
  d1: D1Database,
  _timeline: Pick<Timeline, "slug">,
  state: CheckpointState,
  options: { requireRun?: boolean } = {},
): Promise<{ ok: boolean; why: string | null }> {
  const branch = "work";
  for (const repo of state.checkpoint.repos) {
    const run = await db(d1)
      .selectFrom("ci_runs")
      .select(["number", "status"])
      .where("repo_id", "=", repo.id)
      .where("commit_oid", "=", repo.commit)
      .where("source_id", "=", repo.source?.sourceId ?? "migration-required")
      .where("ref", "=", branch)
      // Step runs are light checks per push, not the timeline's CI (CORE-235),
      // and a preview's create or teardown deploys, never tests (CORE-79, CORE-378).
      .where("step", "=", 0)
      .where("preview_action", "is", null)
      .orderBy("number", "desc")
      .executeTakeFirst();
    const where = `${repo.owner}/${repo.name}`;
    if (!run && options.requireRun)
      return {
        ok: false,
        why: `Checkpoint #${state.checkpoint.number} has no CI run on ${where} yet: approve-when-green waits for one to succeed.`,
      };
    if (!run || run.status === "succeeded") continue;
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
  metadata: RevisionMetadata;
}

function recordCasOutcome(
  ctx: Context,
  operationId: string,
  state: "accepted" | "rejected" | "ambiguous",
) {
  return ctx.env.DB.prepare(
    "UPDATE source_operations SET state=?,updated_at=datetime('now') WHERE id=? AND state='admitted'",
  )
    .bind(state, operationId)
    .run();
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
  state: "conflict" | "failed" | "blocked_dependency",
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

/**
 * Whether main still holds `commit`, re-read just before a receipt records it.
 * What a step observed (`seen`) can be seconds old by then, after a slow walk
 * of history or a CAS, and main may have been rewritten meanwhile.
 */
async function stillOnMain(deps: LandingDeps, r: PushedRepo, commit: string, seen: string) {
  const main = (await deps.refs(r)).get(`refs/heads/${r.default_branch}`);
  if (!main) return false;
  return main === seen || (await revisionClosure(main, (oid) => deps.parents(r, oid))).has(commit);
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
  const row = (repo: LandingRepo) => ctx.rows.get(repo.id);
  const where = (repo: LandingRepo) => `${repo.owner}/${repo.name}`;

  if (await landingFixtureBarrier(ctx.env, landing)) return null;
  for (const repo of landing.repos) {
    const r = row(repo);
    if (!r && repo.state !== "advanced")
      return save(ctx, landing, stopped(landing, "failed", `${where(repo)} is gone.`, repo.id));
    if (repo.state === "advanced") continue;
    if (!repo.source || !repo.logicalBase || !repo.dependencies)
      return save(
        ctx,
        landing,
        stopped(
          landing,
          "failed",
          "migration_required: renew the checkpoint with owned work source metadata",
          repo.id,
        ),
      );
    if (
      repo.source.kind !== "timeline-work" ||
      repo.source.repoId !== repo.id ||
      repo.source.timelineId !== landing.timelineId ||
      repo.source.commit !== repo.commit ||
      repo.logicalBase.repoId !== repo.id ||
      repo.dependencies.some(
        (dependency) => dependency.source.repoId !== repo.id || dependency.base.repoId !== repo.id,
      )
    )
      return save(
        ctx,
        landing,
        stopped(
          landing,
          "failed",
          "Checkpoint source identity does not match the admitted repository and timeline",
          repo.id,
        ),
      );
    const source = await getWorkSource(ctx.env, repo.id, repo.source.sourceId);
    if (
      !source ||
      source.state !== "ready" ||
      source.timeline_id !== landing.timelineId ||
      source.work_ref !== repo.source.ref
    )
      return save(ctx, landing, stopped(landing, "failed", "Work source is not ready", repo.id));
    const refs = await deps.refs({
      ...r!,
      artifacts_name: source.artifacts_name,
      artifacts_remote: source.artifacts_remote!,
    });
    if (refs.get(repo.source.ref) !== repo.commit)
      return save(
        ctx,
        landing,
        stopped(
          landing,
          "failed",
          "Approved work source moved; renew checkpoint and approval",
          repo.id,
        ),
      );
    const main = (await deps.refs(r!)).get(`refs/heads/${r!.default_branch}`);
    if (!main)
      return save(
        ctx,
        landing,
        stopped(landing, "failed", "Canonical main is unavailable", repo.id),
      );
    try {
      const canonical = await revisionClosure(main, (oid) => deps.parents(r!, oid));
      await validateDependencies(ctx.env, repo, canonical, ctx.metadata);
      using work = await ctx.env.ARTIFACTS.get(source.artifacts_name);
      const readCommit = ctx.metadata.reader(source.artifacts_name, work);
      for (const snapshot of [
        repo.source,
        repo.logicalBase,
        ...repo.dependencies.map((dependency) => dependency.source),
      ]) {
        const commit = await readCommit(snapshot.commit);
        if (!commit || commit.treeHash !== snapshot.tree)
          throw new Error("blocked_dependency: pinned source tree is unavailable or mismatched");
      }
      await validateMergeEdges(
        ctx.env,
        repo.source,
        repo.commit,
        repo.logicalBase.commit,
        repo.dependencies.map((dependency) => dependency.source.commit),
        async (oid) => (await readCommit(oid))?.parents ?? null,
        canonical,
      );
    } catch (error) {
      // A transport failure defers progress without invalidating prepared candidates.
      if (!(error instanceof Error) || !error.message.startsWith("blocked_dependency:"))
        throw error;
      return save(ctx, landing, stopped(landing, "blocked_dependency", String(error), repo.id));
    }
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
            `Checkpoint #${landing.checkpointNumber} conflicts with ${where(repo)}'s main (CI run #${run.number} lists the files). Explicitly sync/rebase the owned work source, resolve conflicts, and renew the checkpoint and approval.`,
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
    // No-op candidates still pass all-repository gates before their durable receipt.
    const parents = merge ? await deps.parents(r, merge) : null;
    if (!merge || (merge !== repo.base && (parents?.length !== 1 || parents[0] !== repo.base)))
      return save(
        ctx,
        landing,
        stopped(
          withRepo(landing, repo.id, { mergeRun }),
          "failed",
          `The compact job left ${branch} at ${short(merge)}, not a single-parent candidate on pinned canonical ${short(repo.base)}.`,
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
  if (await landingFixtureBarrier(ctx.env, landing, "prepared")) return null;

  // Reconcile every durable intent before considering any reprepare. Read main
  // before its receipt, and use that same observation for staleness: another
  // progress request may publish between reads without saving Tracker yet.
  let stale: LandingRepo | undefined;
  for (const pending of left) {
    const r = row(pending)!;
    const main = (await deps.refs(r)).get(`refs/heads/${r.default_branch}`);
    if (!main) throw new Error("Canonical main disappeared while reconciling CAS");
    const intent = await receiptFor(ctx.env, landing.id, pending.id);
    if (!intent) {
      if (main !== pending.base) stale ??= pending;
      continue;
    }
    let seen = main;
    let integrated = (await revisionClosure(main, (oid) => deps.parents(r, oid))).has(
      intent.canonical_commit,
    );
    const operation = integrated
      ? null
      : await ctx.env.DB.prepare("SELECT state FROM source_operations WHERE id=?")
          .bind(`landing:${landing.id}:${pending.id}`)
          .first<{ state: string }>();
    if (
      !integrated &&
      operation &&
      operation.state !== "admitted" &&
      operation.state !== "rejected"
    ) {
      // The terminal acknowledgement can arrive after our first main read.
      // Re-observe its result before declaring a confirmed publication lost.
      const acknowledgedMain = (await deps.refs(r)).get(`refs/heads/${r.default_branch}`);
      if (!acknowledgedMain)
        throw new Error("Canonical main disappeared after CAS acknowledgement");
      if (acknowledgedMain !== main) {
        seen = acknowledgedMain;
        integrated = (await revisionClosure(acknowledgedMain, (oid) => deps.parents(r, oid))).has(
          intent.canonical_commit,
        );
      }
    }
    if (integrated) {
      if (await landingFixtureBarrier(ctx.env, landing, "after-cas", pending.id)) return null;
      // Main moved off it since: take the step again from what main is now.
      if (!(await stillOnMain(deps, r, intent.canonical_commit, seen))) return landing;
      await recordIntegrated(ctx.env, landing, pending);
      deps.mainMoved(r, actorOf(landing));
      return save(ctx, landing, withRepo(landing, pending.id, { state: "advanced", reason: null }));
    }
    if (intent.status !== "intent")
      return save(
        ctx,
        landing,
        stopped(
          landing,
          "failed",
          "Recorded integration is absent from rewritten canonical history; refusing replay",
          pending.id,
        ),
      );
    // An admitted RPC may still be running in another progress request. It is
    // neither permission to issue another CAS nor evidence of failure.
    if (operation?.state === "admitted") {
      const reason =
        "Awaiting an admitted canonical CAS. If it does not settle, reconcile its outcome before any retry.";
      return pending.reason === reason
        ? null
        : save(ctx, landing, withRepo(landing, pending.id, { reason }));
    }
    // A reported ambiguous outcome, or an acknowledged success missing from
    // rewritten history, cannot be replayed even after a reset exactly to base.
    if (operation && operation.state !== "rejected")
      return save(
        ctx,
        landing,
        stopped(
          landing,
          "failed",
          "Canonical CAS outcome is unknown and requires reconciliation; refusing replay",
          pending.id,
        ),
      );
    if (main !== pending.base) stale ??= pending;
  }
  // Every unadvanced main was checked above. Never advance A while B's
  // candidate is stale, or discard a candidate with an unresolved CAS.
  if (stale)
    return save(ctx, landing, {
      ...withRepo(landing, stale.id, {
        state: "merging",
        base: null,
        merge: null,
        mergeRun: null,
        gateRun: null,
        reason: `${row(stale)!.default_branch} moved; rematerializing and regating the approved tree.`,
      }),
      state: "merging",
    });
  const repo = left[0];
  if (repo) {
    const r = row(repo)!;
    using artifacts = await ctx.env.ARTIFACTS.get(r.artifacts_name);
    const candidate = await ctx.metadata.reader(r.artifacts_name, artifacts)(repo.merge!);
    if (!candidate) throw new Error("Tested candidate is unavailable");
    await recordIntent(ctx.env, landing, repo, candidate.treeHash, ctx.metadata);
    if (!repo.casIntent || repo.casIntent.candidate !== repo.merge)
      return save(
        ctx,
        landing,
        withRepo(landing, repo.id, {
          casIntent: { base: repo.base!, candidate: repo.merge!, tree: candidate.treeHash },
        }),
      );
    if (await landingFixtureBarrier(ctx.env, landing, "before-cas", repo.id)) return null;
    // Durable intent and complete revision membership precede the external CAS.
    const operationId = `landing:${landing.id}:${repo.id}`;
    const admitted = await ctx.env.DB.prepare(`INSERT INTO source_operations
      (id,owner_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
      SELECT ?,?,?,?,?, 'landing','admitted',?,datetime('now'),datetime('now')
      WHERE EXISTS(SELECT 1 FROM repos WHERE id=? AND deleted_at IS NULL)
      ON CONFLICT(id) DO UPDATE SET state='admitted',data=excluded.data,updated_at=excluded.updated_at
      WHERE source_operations.state='rejected'`)
      .bind(
        operationId,
        ctx.ownerId,
        landing.timelineId,
        repo.id,
        repo.source!.sourceId,
        JSON.stringify(repo.casIntent),
        repo.id,
      )
      .run();
    if (!admitted.meta.changes) return null;
    const live = await ctx.env.DB.prepare("SELECT id FROM repos WHERE id=? AND deleted_at IS NULL")
      .bind(repo.id)
      .first();
    if (!live) {
      await recordCasOutcome(ctx, operationId, "rejected");
      throw new Error("Canonical repository was tombstoned before CAS.");
    }
    let result: RefWriteResult | undefined;
    try {
      [result] = await deps.writeRefs(r, [
        {
          ref: `refs/heads/${r.default_branch}`,
          old: repo.base,
          new: repo.merge,
        },
      ]);
      if (!result) throw new Error("Canonical CAS returned no outcome; reconciliation required");
    } catch (error) {
      await recordCasOutcome(ctx, operationId, "ambiguous");
      throw error;
    }
    if (!result.ok) {
      const current = (await deps.refs(r)).get(`refs/heads/${r.default_branch}`);
      if (
        current &&
        (await revisionClosure(current, (oid) => deps.parents(r, oid))).has(repo.merge!)
      ) {
        await recordCasOutcome(ctx, operationId, "accepted");
        if (await landingFixtureBarrier(ctx.env, landing, "after-cas", repo.id)) return null;
        if (!(await stillOnMain(deps, r, repo.merge!, current))) return landing;
        await recordIntegrated(ctx.env, landing, repo);
        deps.mainMoved(r, actorOf(landing));
        return save(ctx, landing, withRepo(landing, repo.id, { state: "advanced", reason: null }));
      }
      const rejected = await recordCasOutcome(ctx, operationId, "rejected");
      if (!rejected.meta.changes) return null;
      await ctx.env.DB.prepare(
        "DELETE FROM source_integration_receipts WHERE landing_id=? AND repo_id=? AND status='intent'",
      )
        .bind(landing.id, repo.id)
        .run();
      return save(ctx, landing, withRepo(landing, repo.id, { casIntent: undefined }));
    }
    await recordCasOutcome(ctx, operationId, "accepted");
    if (await landingFixtureBarrier(ctx.env, landing, "after-cas", repo.id)) return null;
    if (!(await stillOnMain(deps, r, repo.merge!, repo.merge!))) return landing;
    await recordIntegrated(ctx.env, landing, repo);
    deps.mainMoved(r, actorOf(landing));
    return save(ctx, landing, withRepo(landing, repo.id, { state: "advanced", reason: null }));
  }

  // Every main advanced: the timeline lands.
  if (await landingFixtureBarrier(ctx.env, landing, "before-finalize")) return null;
  return complete(ctx, landing);
}

/** Issue keys a compact commit carries, at most: what main's mention index reads from one commit. */
const LANDED_KEYS = 20;

/**
 * The issue keys the work source's commits mention (CORE-296). The compact
 * commit names them, so main's mention index keeps linking the issues to the
 * work after the source's own commits (and their mentions) expire.
 */
export async function landedIssueKeys(
  d1: D1Database,
  repoId: string,
  sourceId: string,
): Promise<string[]> {
  const rows = await db(d1)
    .selectFrom("commit_issue_mentions")
    .select("issue_key")
    .distinct()
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .orderBy("issue_key")
    .limit(LANDED_KEYS)
    .execute();
  return rows.map((row) => row.issue_key);
}

/** Start the trusted materializer without ever staging the source commit canonically. */
async function startMerge(ctx: Context, landing: Landing, repoId: string, tip: string | null) {
  const repo = landing.repos.find((r) => r.id === repoId)!;
  const r = ctx.rows.get(repoId)!;
  const branch = landingBranch(landing.slug);
  if (!repo.source || !repo.logicalBase) throw new Error("migration_required");
  const keys = await landedIssueKeys(ctx.env.DB, repoId, repo.source.sourceId);
  await ctx.deps.startMerge(r, {
    runId: repo.mergeRun!.id,
    landingId: landing.id,
    slug: landing.slug,
    branch,
    commit: repo.commit,
    base: repo.base!,
    source: repo.source,
    logicalBase: repo.logicalBase,
    old: tip,
    mainBranch: r.default_branch,
    title: `Land ${landing.slug} (checkpoint #${landing.checkpointNumber}): compact into ${r.default_branch}`,
    message: `Land timeline ${landing.slug} (checkpoint #${landing.checkpointNumber})\n\nSource: ${repo.source.sourceId}\nCheckpoint: ${landing.checkpointId}${keys.length ? `\nIssues: ${keys.join(" ")}` : ""}`,
    author: { name: "Timelines", email: "landing@gitmatrix.invalid" },
    actor: { id: landing.requestedBy.accountableId, agentId: landing.requestedBy.agentId },
  });
}

/** Finish the durable cross-store outbox after Tracker commits the timeline end. */
async function publishCompleted(env: Env, ownerId: string, landing: Landing) {
  for (const repo of landing.repos) {
    if (!repo.source) continue;
    const owned = await getWorkSource(env, repo.id, repo.source.sourceId);
    if (!owned || owned.state !== "ready") continue;
    const archived = unwrap(
      await trackerObject(env, ownerId).transitionWorkSource(
        owned.source_id,
        owned.version,
        "archived",
      ),
    );
    await db(env.DB)
      .updateTable("timeline_work_sources")
      .set({
        state: archived.state,
        version: archived.version,
        archived_at: archived.archived_at,
        updated_at: archived.updated_at,
      })
      .where("source_id", "=", archived.source_id)
      .where("version", "<=", archived.version)
      .where("state", "not in", ["purging", "purged"])
      .execute();
  }
  await completeReceipts(env, landing.id);
  for (const repo of landing.repos) await notifyReleaseNotes(env, repo.id);
  await env.DB.prepare(
    "UPDATE source_integration_receipts SET completed_at=datetime('now') WHERE landing_id=? AND status='complete' AND completed_at IS NULL",
  )
    .bind(landing.id)
    .run();
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
  await publishCompleted(ctx.env, ctx.ownerId, landing);
  // Landed is recorded first (CORE-139): overlays then end as landed.
  const branch = `refs/heads/${landingBranch(landing.slug)}`;
  for (const repo of landing.repos) {
    const r = ctx.rows.get(repo.id);
    if (!r) continue;
    try {
      const tips = await ctx.deps.refs(r);
      const writes: RefWrite[] = [];
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
  if (landing.state === "landed") {
    await publishCompleted(env, ownerId, landing);
    return landing;
  }
  // This look may traverse the same canonical history in many saved steps.
  // Only immutable successful reads survive those steps; refs and proofs stay fresh.
  const parents = new Map<string, Map<string, string[]>>();
  const ctx: Context = {
    env,
    deps: {
      ...deps,
      parents: async (repo, oid) => {
        let commits = parents.get(repo.artifacts_name);
        if (!commits) parents.set(repo.artifacts_name, (commits = new Map()));
        const known = commits.get(oid);
        if (known) return known;
        const value = await deps.parents(repo, oid);
        if (value) commits.set(oid, value);
        return value;
      },
    },
    ownerId,
    metadata: new RevisionMetadata(),
    rows: await repoRows(
      env.DB,
      landing.repos.map((repo) => repo.id),
    ),
  };
  const retryMs = deps.stepRetryMs ?? STEP_RETRY_MS;
  let retries = 0;
  for (let i = 0; i < MAX_STEPS && LANDING_ACTIVE.includes(landing.state); i++) {
    let next: Landing | null;
    try {
      next = await step(ctx, landing);
    } catch (error) {
      // Each step is safe to repeat: retried here after a pause, then left to
      // the next look (a run's end, the cron, `gm timeline land`). Whoever
      // asked gets the landing as it is.
      const latest = await trackerObject(env, ownerId).landing(landing.slug);
      const current = latest.ok && latest.value?.id === landing.id ? latest.value : landing;
      const pause = retryMs[retries++];
      if (pause !== undefined && LANDING_ACTIVE.includes(current.state)) {
        console.warn("Landing: a step failed; retrying it", { landing: landing.id, error });
        await new Promise((resolve) => setTimeout(resolve, pause));
        landing = current;
        continue;
      }
      console.error("Landing: a step failed; the next look retries it", {
        landing: landing.id,
        error,
      });
      return current;
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
 * be green, or an approval routed to someone with approve-when-green on may now
 * be approvable. Never throws.
 */
export async function afterRun(env: Env, deps: LandingDeps, runId: string): Promise<void> {
  try {
    const run = await db(env.DB)
      .selectFrom("ci_runs as c")
      .innerJoin("repos as r", "r.id", "c.repo_id")
      .select(["c.ref", "c.repo_id", "c.source_id", "r.owner_id", "c.step", "c.preview_action"])
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
    // A preview deploys a checkpoint; it says nothing about whether it's green.
    if (run.preview_action) return;
    if (run.source_id !== "canonical") {
      const source = await getWorkSource(env, run.repo_id, run.source_id);
      if (source?.state === "ready") {
        const { timeline } = unwrap(
          await trackerObject(env, run.owner_id).timeline(source.timeline_slug, 0, 1),
        );
        if (timeline.policy === "auto")
          await maybeLand(env, deps, run.owner_id, timeline.slug, "auto");
        else {
          // An approval timeline's checkpoint may now be green for someone's
          // approve-when-green setting (CORE-378). Loaded only then.
          const { maybeAutoApprove } = await import("./auto-approve.ts");
          await maybeAutoApprove(env, deps, run.owner_id, { slug: timeline.slug });
          // An approval whose landing never began (CORE-390): try it again.
          await retryApprovedLanding(env, deps, run.owner_id, timeline.slug);
        }
      }
    }
  } catch (error) {
    console.error("Landing: after a CI run", { runId, error });
  }
}

/**
 * The hourly look (worker/index.ts): landings whose runs ended in the last
 * day, in case a run's end didn't move them on; then approvals whose landing
 * never began (CORE-390). Each part on its own: one failing never skips the
 * other.
 */
export async function sweepLandings(env: Env, deps: LandingDeps): Promise<void> {
  try {
    await sweepStartedLandings(env, deps);
  } catch (error) {
    console.error("Landing: sweeping landings failed", error);
  }
  try {
    await sweepApprovedLandings(env, deps);
  } catch (error) {
    console.error("Landing: sweeping approved timelines failed", error);
  }
}

async function sweepStartedLandings(env: Env, deps: LandingDeps): Promise<void> {
  // Receipt completion is a cross-store outbox, not dependent on a recent CI
  // callback. Include old/partially advanced operations without a time cutoff.
  const pending = await env.DB.prepare(`SELECT DISTINCT r.landing_id,w.owner_id,w.timeline_slug
    FROM source_integration_receipts r JOIN timeline_work_sources w ON w.source_id=r.source_id
    WHERE r.status IN ('intent','integrated') OR (r.status='complete' AND r.completed_at IS NULL)`).all<{
    landing_id: string;
    owner_id: string;
    timeline_slug: string;
  }>();
  for (const row of pending.results) {
    const reply = await trackerObject(env, row.owner_id).landing(row.timeline_slug);
    if (reply.ok && reply.value?.id === row.landing_id)
      await progress(env, deps, row.owner_id, reply.value);
  }
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

/** Landing attempts the hourly sweep makes per run, at most (CORE-390). */
const APPROVED_SWEEP_LIMIT = 25;
/**
 * Candidates it lists per tracker for each attempt left (CORE-392): skipped
 * ones (an approver who left, say) mustn't hide landable ones behind them.
 */
const APPROVED_SWEEP_LOOKAHEAD = 4;
/** And at most this many per tracker per run. */
const APPROVED_SWEEP_LISTED = 100;
/** Trackers it looks in per run, at most; where it starts rotates hourly. */
const APPROVED_SWEEP_OWNERS = 200;
/**
 * How recent an approval must be for its landing to be retried unattended:
 * landing on main deploys, so an older approval waits for a person
 * (`gm timeline land`).
 */
export const APPROVAL_RETRY_MS = 24 * 3600_000;

/**
 * The trackers with live timeline work the sweep looks in this `hour`: at
 * most `window`, in id order, from where the last hour's window ended,
 * wrapping round. While the number of trackers is stable, each is reached
 * within ceil(trackers / window) hours; when all fit, the first one rotates
 * hourly.
 */
export async function sweepOwners(d1: D1Database, window: number, hour: number): Promise<string[]> {
  const live = () => db(d1).selectFrom("timeline_work_sources").where("state", "=", "ready");
  const counted = await live()
    .select((eb) => eb.fn.count<number>("owner_id").distinct().as("owners"))
    .executeTakeFirst();
  const total = Number(counted?.owners ?? 0);
  if (!total) return [];
  // More trackers than fit: each hour's window starts where the last one
  // ended. All of them fit: only the order rotates, a tracker an hour, so the
  // attempt budget isn't always spent on the same first ones.
  const start = total > window ? (hour * window) % total : hour % total;
  const page = async (offset: number, limit: number) =>
    (
      await live()
        .select("owner_id")
        .distinct()
        .orderBy("owner_id")
        .limit(limit)
        .offset(offset)
        .execute()
    ).map((row) => row.owner_id);
  const owners = await page(start, window);
  if (owners.length < window && start > 0)
    owners.push(...(await page(0, Math.min(window - owners.length, start))));
  return owners;
}

/**
 * The hourly retry of approvals whose landing never began (CORE-390): in the
 * trackers with live timeline work, each approval timeline whose head was
 * approved in the last day, is still current and has no landing, queued again
 * for its approver. At most `limit` landing attempts per run: only a real
 * beginLanding counts, and what's skipped before one (an approver who left,
 * say) costs nothing and doesn't hide later candidates within the lookahead
 * of four times the remaining budget. A tracker that fails, including an
 * unexpected failure before a landing was asked for, is logged and passed
 * over for this run. Returns the attempts made.
 */
export async function sweepApprovedLandings(
  env: Env,
  deps: LandingDeps,
  options: { limit?: number; owners?: number; hour?: number } = {},
): Promise<number> {
  let left = options.limit ?? APPROVED_SWEEP_LIMIT;
  let attempts = 0;
  const since = new Date(Date.now() - APPROVAL_RETRY_MS).toISOString();
  const owners = await sweepOwners(
    env.DB,
    options.owners ?? APPROVED_SWEEP_OWNERS,
    options.hour ?? Math.floor(Date.now() / 3600_000),
  );
  for (const ownerId of owners) {
    if (left <= 0) break;
    try {
      const listed = unwrap(
        await trackerObject(env, ownerId).approvedUnlanded(
          Math.min(left * APPROVED_SWEEP_LOOKAHEAD, APPROVED_SWEEP_LISTED),
          since,
        ),
      );
      for (const { slug } of listed) {
        if (left <= 0) break;
        if ((await retryApprovedLanding(env, deps, ownerId, slug, since)).attempted) {
          left--;
          attempts++;
        }
      }
    } catch (error) {
      console.error("Landing: sweeping a tracker's approved timelines failed", { ownerId, error });
    }
  }
  return attempts;
}

/** What retrying an approval's landing did: whether it tried, and the landing if one began. */
export interface ApprovalRetry {
  /**
   * Whether it asked beginLanding to land it and that counted: not when it
   * was skipped before, failed before, or found the checkpoint already had a
   * landing or had moved on (`landing_exists`, `checkpoint_moved`).
   */
  attempted: boolean;
  landing: Landing | null;
}

/**
 * Queue the landing an approval should have queued (CORE-390): an approval
 * timeline whose head was approved since `since` (the last day by default),
 * is still current and never had a landing, lands for the person who
 * approved it, as `maybeLand(…, "approval")` does after an answer. Not when
 * that person is no longer a member or can't write to every repository of the
 * checkpoint. beginLanding checks again in its transaction that this exact
 * checkpoint never had a landing (`onlyIfUnlanded`) and refuses anything stale.
 * Why it didn't is logged. Throws only an unexpected failure before a landing
 * was asked for (a failing tracker or D1), not counted as an attempt, so the
 * sweep gives up on that tracker for this run instead of grinding on.
 */
export async function retryApprovedLanding(
  env: Env,
  deps: LandingDeps,
  ownerId: string,
  slug: string,
  since = new Date(Date.now() - APPROVAL_RETRY_MS).toISOString(),
): Promise<ApprovalRetry> {
  const skipped: ApprovalRetry = { attempted: false, landing: null };
  try {
    const tracker = trackerObject(env, ownerId);
    const { timeline, head, everLanded } = unwrap(await tracker.headCheckpoint(slug));
    if (
      timeline.policy !== "approval" ||
      timeline.status === "landed" ||
      timeline.status === "abandoned"
    )
      return skipped;
    if (!head?.approved || !head.approval?.by || !head.approval.at || everLanded) return skipped;
    const where = { ownerId, slug, checkpoint: head.checkpoint.number };
    if (head.approval.at < since) {
      console.info("Landing: an approval over a day old waits for a person to land it", where);
      return skipped;
    }
    const approverId = head.approval.by;
    const [owner, person] = await Promise.all(
      [ownerId, approverId].map((id) =>
        db(env.DB).selectFrom("accounts").selectAll().where("id", "=", id).executeTakeFirst(),
      ),
    );
    if (!owner) {
      console.warn("Landing: the tracker's account is gone", where);
      return skipped;
    }
    if (!person || person.kind !== "user") {
      console.warn("Landing: the approver's account is gone", { ...where, approverId });
      return skipped;
    }
    const access = await accessFor(env.DB, owner, person.id, null);
    if (!access.members.some((member) => member.id === person.id)) {
      console.warn("Landing: the approver left the tracker", { ...where, approverId });
      return skipped;
    }
    const writable = await writableRepoIds(env.DB, actorFromRow(person), owner.id);
    const unwritable = head.checkpoint.repos.find((repo) => !writable.includes(repo.id));
    if (unwritable) {
      console.warn("Landing: the approver can't write to the checkpoint any more", {
        ...where,
        approverId,
        repo: `${unwritable.owner}/${unwritable.name}`,
      });
      return skipped;
    }
    try {
      const result = unwrap(
        await tracker.beginLanding(access, timeline.slug, {
          trigger: "approval",
          green: { ok: true, why: null },
          agentId: null,
          onlyIfUnlanded: head.checkpoint.id,
        }),
      );
      return { attempted: true, landing: await progress(env, deps, owner.id, result.landing) };
    } catch (error) {
      if (
        error instanceof TrackerError &&
        ["landing_exists", "checkpoint_moved"].includes(error.code)
      ) {
        console.info("Landing: no retry, the checkpoint moved on", {
          ...where,
          why: error.message,
        });
        return skipped;
      } else if (error instanceof TrackerError)
        console.warn("Landing: an approved checkpoint can't land", {
          ...where,
          code: error.code,
          why: error.message,
        });
      else console.error("Landing: retrying an approved checkpoint failed", { ...where, error });
      return { attempted: true, landing: null };
    }
  } catch (error) {
    // Before any landing was asked for: nothing attempted. A tracker's refusal
    // is this candidate's; anything else is the tracker or D1 failing.
    if (!(error instanceof TrackerError)) throw error;
    console.warn("Landing: an approved timeline can't be retried", {
      ownerId,
      slug,
      code: error.code,
      why: error.message,
    });
    return skipped;
  }
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
