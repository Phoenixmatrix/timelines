// The cutover's barrier for Git writes Artifacts accepted on its own. A push
// that began before preparation carries no execution ticket, and Artifacts
// documents no way to drain or cancel writes it already accepted. The cutover
// doesn't need one: Artifacts is outside every checkpoint and restore, and the
// migration never rewrites a repository, so such a write can't be lost. What it
// can lose is its bookkeeping, which the storage fence rejects. So each stage
// lists the refs Artifacts holds and compares them with the refs the push log
// last saw (repo_refs):
//
// - fenced: under the fence, before any store is checkpointed. Repairs land in
//   the checkpoint.
// - pre-open: after reconciliation (or restoration), before write admission
//   opens. Repairs are forward, through the same fenced migration authority.
// - post-open: once write admission is open, for anything that landed between.
//
// A divergence is journaled before its repair, then logged with no known
// pusher, and the repository's refs generation is bumped so no reader is
// served refs cached before the write (objects.ts). Push effects (CI, mirror, knowledge, release notes, timeline activity,
// mentions) are new-epoch work, so they replay only after admission opens,
// initiated by a current human session, from the journaled updates themselves.
// A replay that cannot run (no write access in its Space, a failed delivery) is
// marked blocked with its reason and never holds up the others or the pass; a
// person who can run it re-triggers it (replayRefDivergence).
//
// After opening, live pushes race the pass: a divergence is repaired only once
// two observations at least REF_SETTLE_MS apart agree, no Git request holds an
// admission ticket, and the push log gained nothing for the target in between.
// Otherwise it is deferred, so a push that logs itself keeps its pusher.
//
// A legacy reopening (restored stores, contract 3) runs the post-open pass too,
// but its journaled effects cannot replay: they are v4 work. Those replays are
// blocked with that reason, never silently left pending.
//
// Each stage counts only once a complete pass finds no difference; elapsed time,
// zero tickets and revoked tokens prove nothing here.

import { canonicalSpaceJson, spaceDigest } from "../../shared/space-cutover.ts";
import type { Actor } from "../db.ts";
import {
  captureWorkAuthority,
  WorkAuthorizationError,
  type WorkAuthority,
} from "../ci/admission.ts";
import { cutoverControl } from "../durable/cutover-admission.ts";
import { afterReplayedPush, type PushedRepo } from "../git/effects.ts";
import {
  journaledUpdates,
  loggedTips,
  recordObservedRefs,
  type PushRepo,
} from "../ref-log/record.ts";
import {
  REF_PAGE_LIMIT,
  refStage,
  type CutoverRun,
  type RefDivergence,
  type RefObservation,
  type RefReplay,
  type RefTarget,
} from "./control.ts";
import { migrationContext } from "./engine.ts";
import { migrationDatabase } from "./storage-fence.ts";
import { invalidateRefs } from "../objects.ts";

/** Pending effect replays per request: each runs its push's whole effect set. */
const REPLAYS_PER_STEP = 4;
/**
 * How long a post-open divergence must hold before the barrier logs it: beyond
 * waitUntil's 30 seconds after a response, by which a live push logs itself.
 */
export const REF_SETTLE_MS = 90_000;
const LEGACY_REPLAY =
  "Legacy reopening: push effects are v4 work and cannot replay on restored stores; the next push delivers its own.";

interface Target extends RefTarget {
  artifactsName: string;
  artifactsRemote: string;
}

/** Live repositories and the work sources that accept pushes, in a stable order. */
async function targetsAfter(d1: D1Database, cursor: string | null): Promise<Target[]> {
  const [repoId, sourceId] = cursor ? (JSON.parse(cursor) as [string, string]) : ["", ""];
  const { results } = await d1
    .prepare(
      `SELECT repo_id,source_id,artifacts_name,artifacts_remote FROM (
        SELECT id AS repo_id,'canonical' AS source_id,artifacts_name,artifacts_remote FROM repos
          WHERE deleted_at IS NULL AND artifacts_remote IS NOT NULL
        UNION ALL
        SELECT w.repo_id,w.source_id,w.artifacts_name,w.artifacts_remote
          FROM timeline_work_sources w JOIN repos r ON r.id=w.repo_id
          WHERE r.deleted_at IS NULL AND w.state IN ('ready','archived') AND w.artifacts_remote IS NOT NULL
      ) WHERE repo_id>? OR (repo_id=? AND source_id>?) ORDER BY repo_id,source_id LIMIT ?`,
    )
    .bind(repoId, repoId, sourceId, REF_PAGE_LIMIT)
    .all<{
      repo_id: string;
      source_id: string;
      artifacts_name: string;
      artifacts_remote: string;
    }>();
  return results.map((row) => ({
    repoId: row.repo_id,
    sourceId: row.source_id,
    artifactsName: row.artifacts_name,
    artifactsRemote: row.artifacts_remote,
  }));
}

/** How Artifacts' refs differ from those the push log last saw. */
async function divergence(
  d1: D1Database,
  target: Target,
  tips: Map<string, string>,
): Promise<RefDivergence["changes"]> {
  const { results } = await d1
    .prepare("SELECT ref,oid FROM repo_refs WHERE repo_id=? AND source_id=?")
    .bind(target.repoId, target.sourceId)
    .all<{ ref: string; oid: string }>();
  const known = new Map(results.map((row) => [row.ref, row.oid]));
  const changes: RefDivergence["changes"] = [];
  for (const [ref, oid] of tips) {
    const old = known.get(ref) ?? null;
    if (old !== oid) changes.push({ ref, old, new: oid });
  }
  for (const [ref, oid] of known) if (!tips.has(ref)) changes.push({ ref, old: oid, new: null });
  return changes.sort((a, b) => a.ref.localeCompare(b.ref));
}

/** The push log's newest entry for a target: a live push logging itself moves it. */
async function updateMark(d1: D1Database, target: RefTarget): Promise<number> {
  const row = await d1
    .prepare("SELECT COALESCE(MAX(id),0) AS mark FROM ref_updates WHERE repo_id=? AND source_id=?")
    .bind(target.repoId, target.sourceId)
    .first<{ mark: number }>();
  return row?.mark ?? 0;
}

export async function refReconciliation(env: Env, runId: string) {
  return cutoverControl(env).refReconciliation(runId);
}

/**
 * One bounded step of the current phase's ref barrier: after admission opened,
 * replays a few pending push effects first (each failure is recorded, never
 * fatal), then lists and repairs one page of targets. `fresh` starts another
 * pass even when the stage's last one was clean.
 */
export async function advanceRefReconciliation(
  env: Env,
  runId: string,
  options: { actor?: Actor | null; fresh?: boolean } = {},
) {
  const control = cutoverControl(env);
  const run = await control.status();
  if (!run || run.runId !== runId) throw new Error("Cutover run mismatch");
  const stage = refStage(run);
  if (!stage) throw new Error("Artifacts ref reconciliation is unavailable in this phase");
  if (stage === "post-open") {
    // Without a current human session nothing replays; the pass still runs.
    const actor = options.actor?.credential && !options.actor.agent ? options.actor : null;
    if (actor || run.phase === "legacy-active")
      for (const replay of await control.pendingRefReplays(runId, REPLAYS_PER_STEP))
        await replayOne(env, run, replay, actor);
  }
  const pass = await control.refPass(runId, stage, options.fresh ?? false);
  if (pass.complete) return refReconciliation(env, runId);
  // Reads are never fenced. Writes before admission go only through the
  // run's own atomic migration authority, rechecked against the journal.
  const writer =
    stage === "post-open"
      ? env.DB
      : migrationDatabase(
          env.DB,
          migrationContext(run, run.manifest.mapping[0]!),
          "refs",
          async (context, operation) => {
            await control.assertParticipant(context, operation);
          },
          run.authorityToken,
        );
  const targets = await targetsAfter(env.DB, pass.cursor);
  const observations: RefObservation[] = [];
  for (const target of targets) {
    const repo: PushRepo = {
      id: target.repoId,
      source_id: target.sourceId,
      artifacts_name: target.artifactsName,
      artifacts_remote: target.artifactsRemote,
    };
    const tips = await loggedTips(env, repo);
    const digest = await spaceDigest(canonicalSpaceJson(Object.fromEntries(tips)));
    const changes = await divergence(env.DB, target, tips);
    observations.push({ repoId: target.repoId, sourceId: target.sourceId, digest });
    if (!changes.length) {
      if (stage === "post-open") await control.clearRefDeferral(runId, target);
      continue;
    }
    if (stage === "post-open") {
      // A live push may be between Artifacts accepting it and logging itself.
      const mark = await updateMark(env.DB, target);
      const prior = await control.refDeferral(runId, target);
      const gitInFlight = (await control.activeTickets()).some(
        (ticket) => ticket.consumer === "http-git-registry",
      );
      const same = prior?.digest === digest && prior.updateMark === mark;
      if (gitInFlight || !same || Date.now() - Date.parse(prior!.observedAt) < REF_SETTLE_MS) {
        await control.recordRefDeferral(runId, pass.pass, pass.cursor, {
          repoId: target.repoId,
          sourceId: target.sourceId,
          digest,
          // An unchanged observation keeps its first time: only agreement over time settles it.
          observedAt: same ? prior!.observedAt : new Date().toISOString(),
          updateMark: mark,
        });
        continue;
      }
    }
    await control.recordRefDivergence(runId, pass.pass, pass.cursor, {
      repoId: target.repoId,
      sourceId: target.sourceId,
      digest,
      changes,
    });
    await recordObservedRefs(env, writer, repo, tips);
    // The write behind this divergence moved refs without a refs generation
    // bump (its own was fenced, or never ran), so readers could still be served
    // refs cached before it for up to a day (objects.ts). Bump it now, through
    // the same writer: under the fence only the run's authority may write, and
    // a bump that fails is logged by invalidateRefs, leaving the age bound.
    await invalidateRefs(writer, target.artifactsName);
    if (stage === "post-open") await control.clearRefDeferral(runId, target);
  }
  const last = targets.at(-1);
  await control.recordRefPage(
    runId,
    pass.pass,
    pass.cursor,
    targets.length < REF_PAGE_LIMIT || !last ? null : JSON.stringify([last.repoId, last.sourceId]),
    observations,
  );
  return refReconciliation(env, runId);
}

/**
 * Re-triggers one journaled replay, pending or blocked, for a person who can
 * run it: typically someone with write access in its Space when the operator
 * has none there.
 */
export async function replayRefDivergence(
  env: Env,
  runId: string,
  key: { pass: number; repoId: string; sourceId: string },
  actor: Actor | null,
) {
  if (!actor?.credential || actor.agent)
    throw new Error("A current human session must initiate replayed push effects");
  const control = cutoverControl(env);
  const run = await control.status();
  if (!run || run.runId !== runId || refStage(run) !== "post-open" || run.phase !== "active")
    throw new Error("Push effects replay only after Space write admission opened");
  const replay = await control.refReplay(runId, key);
  if (!replay) throw new Error("No such replay is waiting");
  await replayOne(env, run, replay, actor);
  return refReconciliation(env, runId);
}

/** What afterPush needs, for a repository's canonical refs or one work source. */
async function pushedRepo(d1: D1Database, target: RefTarget): Promise<PushedRepo | null> {
  if (target.sourceId === "canonical")
    return d1
      .prepare(
        "SELECT r.id,r.space_id,s.slug AS space_slug,r.name,r.default_branch,r.artifacts_name,r.artifacts_remote FROM repos r JOIN spaces s ON s.id=r.space_id WHERE r.id=? AND r.deleted_at IS NULL",
      )
      .bind(target.repoId)
      .first<PushedRepo>();
  const source = await d1
    .prepare(
      "SELECT r.id,r.space_id,s.slug AS space_slug,r.name,w.work_ref,w.artifacts_name,w.artifacts_remote,w.source_id FROM timeline_work_sources w JOIN repos r ON r.id=w.repo_id JOIN spaces s ON s.id=r.space_id WHERE w.repo_id=? AND w.source_id=? AND r.deleted_at IS NULL AND w.state IN ('ready','archived')",
    )
    .bind(target.repoId, target.sourceId)
    .first<Omit<PushedRepo, "default_branch"> & { work_ref: string }>();
  if (!source) return null;
  const { work_ref, ...repo } = source;
  return { ...repo, default_branch: work_ref.replace(/^refs\/heads\//, "") };
}

/**
 * Push effects for refs the push log logged with no known pusher. The person
 * who initiates the replay is its work authority, never an invented one; the
 * push log itself keeps the pusher unknown. Any failure blocks this replay
 * alone, with its reason.
 */
async function replayOne(
  env: Env,
  run: CutoverRun,
  replay: RefReplay,
  actor: Actor | null,
): Promise<void> {
  const control = cutoverControl(env);
  if (run.phase === "legacy-active") {
    await control.blockRefReplay(run.runId, replay, LEGACY_REPLAY);
    return;
  }
  if (!actor) return;
  try {
    const repo = await pushedRepo(env.DB, replay);
    // A repository deleted since has no effects left to deliver.
    if (repo) {
      let authority: WorkAuthority;
      try {
        authority = await captureWorkAuthority(env, repo.id, actor);
      } catch (error) {
        if (!(error instanceof WorkAuthorizationError)) throw error;
        await control.blockRefReplay(
          run.runId,
          replay,
          `Needs a person with write access in ${repo.space_slug} to replay it.`,
        );
        return;
      }
      await afterReplayedPush(
        env,
        repo,
        actor,
        authority,
        await journaledUpdates(env, repo, replay.changes),
      );
    }
  } catch (error) {
    await control.blockRefReplay(
      run.runId,
      replay,
      `Replay failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return;
  }
  await control.settleRefReplay(run.runId, replay);
}
