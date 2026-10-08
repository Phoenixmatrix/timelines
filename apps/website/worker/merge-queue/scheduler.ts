import {
  queueCandidateBranch,
  type QueueFailure,
  type QueueFailureKind,
} from "../../shared/merge-queue.ts";
import { sql } from "kysely";
import type { PushedRepo } from "../git/effects.ts";
import { jobRuns } from "../ci/config.ts";
import type { StoredJob } from "../ci/jobs.ts";
import { db } from "../schema.ts";
import { queueDeps, type QueueDeps, type Outcome, type Waiter } from "./deps.ts";
import { getQueue, listQueue, saveQueue, type StoredQueue } from "./store.ts";
const ACTIVE = ["merging", "testing", "advancing"] as const;
const MAX_ATTEMPTS = 5;
const MAX_AGE = 4 * 60 * 60 * 1000;
/**
 * Retries of a failed step before it fails the entry (CORE-305): a provider
 * hiccup, or in local development a dropped remote binding session.
 */
const STEP_RETRY_MS = [1_000, 4_000] as const;
const freshId = () => crypto.randomUUID().replaceAll("-", "");

async function repoFor(env: Env, id: string): Promise<PushedRepo | undefined> {
  return db(env.DB)
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
    .where("r.id", "=", id)
    .where("r.deleted_at", "is", null)
    .executeTakeFirst();
}
/** Bounded proof only: an exhausted graph walk never authorizes coverage. */
export async function ancestor(
  deps: QueueDeps,
  repo: PushedRepo,
  older: string,
  newer: string,
): Promise<boolean> {
  const pending = [newer],
    seen = new Set<string>();
  while (pending.length && seen.size < 256) {
    const oid = pending.pop()!;
    if (oid === older) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const parents = await deps.parents(repo, oid);
    if (!parents) return false;
    pending.push(...parents);
  }
  return false;
}
async function failure(
  env: Env,
  s: StoredQueue,
  stage: QueueFailure["stage"],
  kind: QueueFailureKind,
  reason: string,
  outcome?: Outcome | null,
) {
  let e =
    s.entry.status === "queued" && stage === "merge"
      ? { ...s.entry, attempts: s.entry.attempts + 1 }
      : s.entry;
  let conflictPaths = s.resolutionInput
    ? (JSON.parse(s.resolutionInput) as { path: string }[]).map((f) => f.path)
    : [];
  if (stage === "merge" && s.mergeRunId && !conflictPaths.length) {
    const logs = await db(env.DB)
      .selectFrom("ci_logs as l")
      .innerJoin("ci_jobs as j", "j.id", "l.job_id")
      .select("l.text")
      .where("j.run_id", "=", s.mergeRunId)
      .orderBy("l.seq", "desc")
      .limit(16)
      .execute();
    for (const log of logs) {
      const marker = /QUEUE_CONFLICT_PATHS (\[[^\n]*\])/.exec(log.text)?.[1];
      if (!marker) continue;
      try {
        const paths: unknown = JSON.parse(marker);
        if (Array.isArray(paths))
          conflictPaths = paths
            .filter((path): path is string => {
              if (typeof path !== "string" || path.length > 256) return false;
              for (let index = 0; index < path.length; index++) {
                if (path.charCodeAt(index) < 32) return false;
              }
              return true;
            })
            .slice(0, 100);
      } catch {
        /* A malformed runner log cannot become writable issue metadata. */
      }
      break;
    }
  }
  if (conflictPaths.length && !s.resolution) {
    e = {
      ...e,
      decision: {
        action: "manual",
        reason: "Conflict is outside the bounded automatic repair scope.",
        model: null,
        confidence: null,
      },
    };
    if (outcome?.conflict) kind = "unsafe_conflict";
  }
  const evidence: QueueFailure = {
    queueId: e.id,
    repo: `${e.repo.owner}/${e.repo.name}`,
    commit: e.commit,
    attempt: e.attempts,
    stage,
    kind,
    reason: reason.slice(0, 1000),
    runNumber: outcome?.number ?? null,
    failedJobs: outcome?.failedJobs ?? [],
    conflictPaths,
    classificationModel: e.decision?.model ?? null,
    repairModel: s.resolution?.repairModel ?? null,
    occurredAt: new Date().toISOString(),
  };
  const saved = await saveQueue(env.DB, s, {
    ...s,
    remediationPending: true,
    entry: {
      ...e,
      status: stage === "deployment" ? e.status : "failed",
      failure: evidence,
      ...(stage === "deployment"
        ? {
            deployStatus:
              outcome?.status === "cancelled" ? ("cancelled" as const) : ("failed" as const),
          }
        : {}),
    },
  });
  if (saved && stage !== "deployment") await releaseCombined(env, saved);
  return saved;
}
async function releaseCombined(env: Env, s: StoredQueue) {
  // Member CAS alone cannot distinguish a reservation made by a later attempt.
  const leader = { id: s.entry.id, version: s.version };
  for (const id of s.combinedIds) {
    const member = await getQueue(env.DB, s.entry.repo.id, id);
    if (
      !member ||
      member.entry.coveredBy !== s.entry.id ||
      !["queued", "covered"].includes(member.entry.status)
    )
      continue;
    if (s.entry.status === "landed") {
      if (
        member.entry.status === "covered" &&
        member.entry.deployRun === s.entry.deployRun &&
        member.entry.deployStatus === s.entry.deployStatus &&
        member.entry.remediationIssueId === s.entry.remediationIssueId
      )
        continue;
      await saveQueue(
        env.DB,
        member,
        {
          ...member,
          entry: {
            ...member.entry,
            status: "covered",
            coveredBy: s.entry.id,
            candidate: s.entry.candidate,
            base: s.entry.base,
            gateRun: s.entry.gateRun,
            mergeRun: s.entry.mergeRun,
            deployRun: s.entry.deployRun,
            deployStatus: s.entry.deployStatus,
            decision: s.entry.decision,
            failure: s.entry.failure,
            remediationIssueId: s.entry.remediationIssueId,
          },
        },
        leader,
      );
    } else if (
      s.entry.status === "failed" ||
      s.entry.status === "cancelled" ||
      s.entry.status === "queued"
    ) {
      const released = await saveQueue(
        env.DB,
        member,
        { ...member, entry: { ...member.entry, coveredBy: null } },
        leader,
      );
      if (!released) return false;
    }
  }
  return true;
}
async function terminalEffects(env: Env, repo: PushedRepo, s: StoredQueue, deps: QueueDeps) {
  if (!(await repoFor(env, repo.id))) return;
  await db(env.DB)
    .updateTable("merge_queue")
    .set({ recovered_at: new Date().toISOString() })
    .where("repo_id", "=", repo.id)
    .where("id", "=", s.entry.id)
    .execute();
  const stopDeployment = async (
    state: StoredQueue,
    kind: QueueFailureKind,
    reason: string,
    outcome?: Outcome | null,
  ) => {
    const stopped = await failure(env, state, "deployment", kind, reason, outcome);
    if (stopped) await terminalEffects(env, repo, stopped, deps);
  };
  await releaseCombined(env, s);
  if (s.remediationPending && s.entry.failure) {
    if (!(await repoFor(env, repo.id))) return;
    try {
      const issue = await deps.remediate(repo, s, s.entry.failure);
      const saved = await saveQueue(env.DB, s, {
        ...s,
        remediationPending: false,
        entry: { ...s.entry, remediationIssueId: issue.id },
      });
      if (saved) s = saved;
    } catch (error) {
      console.error("Queue remediation deferred", s.entry.id, error);
    }
  }
  if (s.entry.status !== "landed") return;
  if (s.effectsPending) {
    if (!(await repoFor(env, repo.id))) return;
    try {
      await deps.effects(repo, s);
      const saved = await saveQueue(env.DB, s, { ...s, effectsPending: false });
      if (saved) s = saved;
    } catch (error) {
      console.error("Queue main effects deferred", s.entry.id, error);
    }
  }
  if (["succeeded", "failed", "cancelled"].includes(s.entry.deployStatus ?? "")) return;
  const k = db(env.DB);
  let run = s.deployRunId
    ? await k.selectFrom("ci_runs").selectAll().where("id", "=", s.deployRunId).executeTakeFirst()
    : await k
        .selectFrom("ci_runs")
        .selectAll()
        .where("repo_id", "=", repo.id)
        .where("ref", "=", s.entry.branch)
        .where("commit_oid", "=", s.entry.candidate!)
        .where("trigger", "=", "push")
        .orderBy("number", "desc")
        .executeTakeFirst();
  if (!run) {
    const main = (await deps.refs(repo)).get(`refs/heads/${s.entry.branch}`);
    if (main !== s.entry.candidate) {
      if (!main || !(await ancestor(deps, repo, s.entry.candidate!, main))) {
        await stopDeployment(
          s,
          "infrastructure",
          "Main changed without deployment coverage ancestry.",
        );
        return;
      }
      // Never enqueue an obsolete production commit after a newer main pipeline.
      // A proven descendant's real push verdict may cover this landed candidate.
      run = await k
        .selectFrom("ci_runs")
        .selectAll()
        .where("repo_id", "=", repo.id)
        .where("ref", "=", s.entry.branch)
        .where("commit_oid", "=", main)
        .where("trigger", "=", "push")
        .orderBy("number", "desc")
        .executeTakeFirst();
      if (!run) {
        if (Date.now() - Date.parse(s.entry.updatedAt) > MAX_AGE)
          await stopDeployment(
            s,
            "infrastructure",
            "Main advanced but no covering pipeline was recovered.",
          );
        return;
      }
    }
  }
  if (!run) {
    // Queue recovery owns main CI on the exact landed commit, independently of
    // best-effort direct-push observers. No skipped/no-config result is green.
    if (!s.deployRunId) {
      const saved = await saveQueue(env.DB, s, { ...s, deployRunId: freshId() });
      if (!saved) return;
      s = saved;
    }
    const result = await deps.deploy(repo, s);
    if ("skipped" in result) {
      await stopDeployment(s, "configuration", result.skipped);
      return;
    }
    run = await k
      .selectFrom("ci_runs")
      .selectAll()
      .where("id", "=", result.runId)
      .executeTakeFirst();
  }
  const visited = new Set<number>();
  while (run?.covered_by !== null && run?.covered_by !== undefined) {
    if (visited.has(run.number) || visited.size >= 32) {
      await stopDeployment(s, "infrastructure", "Invalid main CI coverage cycle.");
      return;
    }
    visited.add(run.number);
    const next = await k
      .selectFrom("ci_runs")
      .selectAll()
      .where("repo_id", "=", repo.id)
      .where("number", "=", run.covered_by)
      .executeTakeFirst();
    if (
      !next ||
      next.ref !== s.entry.branch ||
      !(await ancestor(deps, repo, s.entry.candidate!, next.commit_oid))
    ) {
      await stopDeployment(s, "infrastructure", "Main CI coverage has no ancestry proof.");
      return;
    }
    run = next;
  }
  if (!run) return;
  if (run.status === "failed" || run.status === "cancelled") {
    const outcome = await deps.outcome(run.id);
    if (!outcome || outcome.status !== run.status || outcome.number !== run.number) return;
    // Commit the final verdict, exact run evidence, and remediation outbox together.
    // Until this succeeds, recovery must still discover this deployment.
    await stopDeployment(
      { ...s, deployRunId: run.id, entry: { ...s.entry, deployRun: run.number } },
      "build_failed",
      `Main pipeline ${run.status}.`,
      outcome,
    );
    return;
  }
  const saved = await saveQueue(env.DB, s, {
    ...s,
    deployRunId: run.id,
    entry: { ...s.entry, deployRun: run.number, deployStatus: run.status },
  });
  if (!saved) return;
  await releaseCombined(env, saved);
  if (run.status === "queued" || run.status === "running") {
    if (Date.now() - Date.parse(run.created_at) > MAX_AGE)
      await stopDeployment(
        saved,
        "infrastructure",
        "Main pipeline expired.",
        await deps.outcome(run.id),
      );
    else await deps.recover(run.id);
  }
}

async function step(env: Env, repo: PushedRepo, s: StoredQueue, deps: QueueDeps): Promise<boolean> {
  if (!(await repoFor(env, repo.id))) return false;
  const e = s.entry;
  if (e.status === "queued") {
    if (e.coveredBy) return false;
    // The pre-pass may have run before another isolate requeued this leader.
    // Do not discard old membership until every reservation is released.
    if (!(await releaseCombined(env, s))) return true;
    const active = await db(env.DB)
      .selectFrom("merge_queue")
      .select("id")
      .where("repo_id", "=", repo.id)
      .where("status", "in", ACTIVE)
      .executeTakeFirst();
    if (active) return false;
    const refs = await deps.refs(repo),
      base = refs.get(`refs/heads/${e.branch}`);
    if (!base) {
      await failure(env, s, "merge", "configuration", "Default branch does not exist.");
      return true;
    }
    if (await ancestor(deps, repo, e.commit, base)) {
      // Ordinary/native pushes remain authoritative. Inclusion already present on
      // main is not a new merge and does not invent successful queue gate evidence.
      await saveQueue(env.DB, s, {
        ...s,
        effectsPending: false,
        entry: {
          ...e,
          status: "landed",
          base,
          candidate: base,
          mergeRun: null,
          gateRun: null,
          deployStatus: "queued",
          decision: {
            action: "separate",
            reason:
              "Pinned source is already included in the current main; no ref was advanced by this queue entry.",
            model: null,
            confidence: null,
          },
        },
      });
      return true;
    }
    if (refs.get(`refs/heads/${e.sourceBranch}`) !== e.commit) {
      await failure(env, s, "merge", "infrastructure", "Pinned source ref changed or disappeared.");
      return true;
    }
    const attempt = e.attempts + 1;
    if (s.rebaseAttempts >= MAX_ATTEMPTS) {
      await failure(
        env,
        s,
        "merge",
        "infrastructure",
        "Main changed too often; retry after syncing.",
      );
      return true;
    }
    const claimed = await saveQueue(env.DB, s, {
      ...s,
      mergeSource: e.commit,
      combinedIds: [],
      mergeRunId: freshId(),
      gateRunId: null,
      resolution: null,
      resolutionInput: null,
      resolutionClaimed: false,
      classificationClaimed: false,
      entry: {
        ...e,
        status: "merging",
        attempts: attempt,
        candidateBranch: queueCandidateBranch(e.id, attempt),
        base,
        candidate: null,
        mergeRun: null,
        gateRun: null,
        decision: null,
      },
    });
    return !!claimed;
  }
  if (e.status === "merging") {
    if (!s.classificationClaimed) {
      const claimed = await saveQueue(env.DB, s, { ...s, classificationClaimed: true });
      if (!claimed) return true;
      // A paid claim is durable before inference. A lost answer falls back to FIFO;
      // neither recovery nor another isolate repeats an uncertain model request.
      const all = await listQueue(env.DB, repo.id);
      const pending = all
        .filter((x) => x.entry.status === "queued" && !x.entry.coveredBy)
        .slice(0, 7);
      let decision;
      try {
        decision = await deps.classify(repo, claimed, [claimed, ...pending]);
      } catch {
        decision = {
          action: "separate" as const,
          reason: "Scheduling inference unavailable; using FIFO.",
          model: null,
          confidence: null,
        };
      }
      let selected = claimed.entry.commit;
      const combined: StoredQueue[] = [];
      if (decision.action === "combine" && decision.model && (decision.confidence ?? 0) >= 0.95) {
        for (const candidate of pending) {
          const cancelled = all.filter((x) => x.entry.status === "cancelled");
          if (cancelled.length > 100) continue;
          let includesCancelled = false;
          for (const stopped of cancelled)
            if (await ancestor(deps, repo, stopped.entry.commit, candidate.entry.commit)) {
              includesCancelled = true;
              break;
            }
          if (includesCancelled) continue;
          if (await ancestor(deps, repo, selected, candidate.entry.commit)) {
            selected = candidate.entry.commit;
            combined.push(candidate);
          }
        }
      }
      const saved = await saveQueue(env.DB, claimed, {
        ...claimed,
        mergeSource: selected,
        combinedIds: combined.map((x) => x.entry.id),
        entry: { ...claimed.entry, decision },
      });
      if (!saved) return true;
      for (const member of combined)
        await saveQueue(
          env.DB,
          member,
          { ...member, entry: { ...member.entry, coveredBy: e.id } },
          { id: saved.entry.id, version: saved.version },
        );
      return true;
    }
    if (!e.decision) {
      if (Date.now() - Date.parse(e.updatedAt) < 120_000) return false;
      await saveQueue(env.DB, s, {
        ...s,
        entry: {
          ...e,
          decision: {
            action: "separate",
            reason: "Uncertain scheduling inference was not replayed; using FIFO.",
            model: null,
            confidence: null,
          },
        },
      });
      return true;
    }
    // Recover a crash between saving the selected source and reserving members.
    // A member cancelled in that gap invalidates this combination, not its cancel.
    for (const id of s.combinedIds) {
      const member = await getQueue(env.DB, repo.id, id);
      if (
        !member ||
        member.entry.status !== "queued" ||
        (member.entry.coveredBy && member.entry.coveredBy !== e.id)
      ) {
        await failure(
          env,
          s,
          "merge",
          "infrastructure",
          "Combined membership changed before the merge; retry separately.",
        );
        return true;
      }
      if (
        !member.entry.coveredBy &&
        !(await saveQueue(
          env.DB,
          member,
          {
            ...member,
            entry: { ...member.entry, coveredBy: e.id },
          },
          { id: s.entry.id, version: s.version },
        ))
      )
        return true;
    }
    const result = await deps.outcome(s.mergeRunId!);
    if (!result) {
      const refs = await deps.refs(repo),
        current = refs.get(`refs/heads/${e.candidateBranch}`);
      if (!current) {
        const written = await deps.write(repo, [
          { ref: `refs/heads/${e.candidateBranch}`, old: "0".repeat(40), new: s.mergeSource },
        ]);
        if (!written.every((r) => r.ok)) return false;
      }
      const latest = await getQueue(env.DB, repo.id, e.id);
      if (!latest || latest.version !== s.version || latest.entry.status !== "merging") return true;
      const run = await deps.merge(repo, s);
      await saveQueue(env.DB, s, { ...s, entry: { ...e, mergeRun: run.number } });
      return false;
    }
    if (result.status === "queued" || result.status === "running") {
      await deps.recover(s.mergeRunId!);
      return false;
    }
    if (result.status !== "succeeded") {
      await failure(
        env,
        s,
        "merge",
        result.conflict
          ? s.resolution?.decision.action === "manual"
            ? "unsafe_conflict"
            : "conflict"
          : "infrastructure",
        `Merge job ${result.status}.`,
        result,
      );
      return true;
    }
    const candidate = (await deps.refs(repo)).get(`refs/heads/${e.candidateBranch}`);
    const parents = candidate ? await deps.parents(repo, candidate) : null;
    if (
      !candidate ||
      parents?.length !== 2 ||
      parents[0] !== e.base ||
      parents[1] !== s.mergeSource
    ) {
      await failure(
        env,
        s,
        "merge",
        "infrastructure",
        "Candidate parents do not match the pinned base and source.",
        result,
      );
      return true;
    }
    await saveQueue(env.DB, s, {
      ...s,
      gateRunId: freshId(),
      entry: { ...e, status: "testing", candidate, mergeRun: result.number },
    });
    return true;
  }
  if (e.status === "testing") {
    const result = await deps.outcome(s.gateRunId!);
    if (!result) {
      let started;
      try {
        started = await deps.gates(repo, s);
      } catch (error) {
        // A simultaneous starter may have committed this exact durable run ID.
        // Its insertion winning is recovery, not a reason to fail valid work.
        if (await deps.outcome(s.gateRunId!)) return true;
        throw error;
      }
      if ("skipped" in started) await failure(env, s, "gates", "configuration", started.skipped);
      else if (started.runId !== s.gateRunId)
        await failure(
          env,
          s,
          "gates",
          "infrastructure",
          "Candidate gates returned an unrelated run.",
        );
      else await saveQueue(env.DB, s, { ...s, entry: { ...e, gateRun: started.number } });
      return "skipped" in started;
    }
    if (result.status === "queued" || result.status === "running") {
      // A start whose answer or save was lost still shows its run (CORE-256).
      if (e.gateRun !== result.number)
        await saveQueue(env.DB, s, { ...s, entry: { ...e, gateRun: result.number } });
      await deps.recover(s.gateRunId!);
      return false;
    }
    if (result.status !== "succeeded") {
      await failure(env, s, "gates", "build_failed", `Candidate gates ${result.status}.`, result);
      return true;
    }
    // Independently require runnable succeeded jobs. A run with only conditional
    // skips, or a forged/empty successful run, is never a queue gate.
    const jobs = await db(env.DB)
      .selectFrom("ci_jobs")
      .select(["status", "error", "spec"])
      .where("run_id", "=", s.gateRunId!)
      .execute();
    const required = jobs.filter((j) =>
      jobRuns(JSON.parse(j.spec) as StoredJob, {
        branch: e.candidateBranch,
        commit: e.candidate!,
        trigger: "landing",
        runner: env.CI_RUNNER,
        action: "",
      }),
    );
    if (
      !required.length ||
      required.some((j) => j.status !== "succeeded") ||
      jobs.some((j) => !["succeeded", "skipped"].includes(j.status))
    ) {
      await failure(
        env,
        s,
        "gates",
        "configuration",
        "Candidate has no complete successful configured gates.",
        result,
      );
      return true;
    }
    const run = await db(env.DB)
      .selectFrom("ci_runs")
      .select(["commit_oid", "queue_id", "repo_id"])
      .where("id", "=", s.gateRunId!)
      .executeTakeFirst();
    if (
      !run ||
      run.commit_oid !== e.candidate ||
      run.queue_id !== e.id ||
      run.repo_id !== repo.id
    ) {
      await failure(
        env,
        s,
        "gates",
        "infrastructure",
        "Gate identity does not match the exact candidate.",
        result,
      );
      return true;
    }
    await saveQueue(env.DB, s, {
      ...s,
      entry: { ...e, status: "advancing", gateRun: result.number },
    });
    return true;
  }
  if (e.status === "advancing") {
    // Cancellation is forbidden after this persisted fence. Retries cannot reuse
    // this candidate ref, and only this exact already-tested OID may reach main.
    let main = (await deps.refs(repo)).get(`refs/heads/${e.branch}`);
    if (main === e.base) {
      // The ref read can overlap repository deletion. Never publish its stale snapshot.
      if (!(await repoFor(env, repo.id))) return false;
      try {
        await deps.write(repo, [
          { ref: `refs/heads/${e.branch}`, old: e.base!, new: e.candidate! },
        ]);
      } catch {
        /* reread resolves uncertain CAS */
      }
      main = (await deps.refs(repo)).get(`refs/heads/${e.branch}`);
    }
    if (main === e.candidate || (main && (await ancestor(deps, repo, e.candidate!, main)))) {
      await saveQueue(env.DB, s, {
        ...s,
        effectsPending: true,
        entry: { ...e, status: "landed", deployStatus: "queued" },
      });
      return true;
    }
    const rebased = await saveQueue(env.DB, s, {
      ...s,
      rebaseAttempts: s.rebaseAttempts + 1,
      history: [...s.history, e],
      entry: { ...e, status: "queued", base: null, candidate: null },
    });
    if (rebased) await releaseCombined(env, rebased);
    return true;
  }
  return false;
}

export async function progressQueue(
  env: Env,
  repoId: string,
  waitUntil: Waiter,
  injected?: QueueDeps,
): Promise<void> {
  const repo = await repoFor(env, repoId);
  if (!repo) return;
  const deps = injected ?? queueDeps(env, waitUntil);
  // Recovery and failure handling never hold an active slot for Tracker availability.
  for (const state of await listQueue(env.DB, repoId)) {
    if (state.entry.status === "queued" && !state.entry.coveredBy && state.combinedIds.length)
      await releaseCombined(env, state);
    if (["landed", "failed", "cancelled"].includes(state.entry.status))
      await terminalEffects(env, repo, state, deps).catch((error) =>
        console.error("Queue terminal recovery", state.entry.id, error),
      );
    if (state.entry.status === "queued" && state.entry.coveredBy) {
      const owner = await getQueue(env.DB, repoId, state.entry.coveredBy);
      if (owner?.entry.status === "landed") await releaseCombined(env, owner);
      if (!owner || ["failed", "cancelled"].includes(owner.entry.status))
        await saveQueue(
          env.DB,
          state,
          { ...state, entry: { ...state.entry, coveredBy: null } },
          { id: state.entry.coveredBy, version: owner?.version ?? null },
        );
    }
  }
  const retryMs = deps.stepRetryMs ?? STEP_RETRY_MS;
  let retries = 0;
  for (let count = 0; count < 32; count++) {
    const rows = await listQueue(env.DB, repoId);
    if (!(await repoFor(env, repoId))) return;
    const state =
      rows.find((x) => ACTIVE.some((status) => status === x.entry.status)) ??
      rows.find((x) => x.entry.status === "queued" && !x.entry.coveredBy);
    if (!state) return;
    if (
      state.entry.status !== "advancing" &&
      state.entry.status !== "queued" &&
      Date.now() - Date.parse(state.entry.updatedAt) > MAX_AGE
    ) {
      await failure(
        env,
        state,
        state.entry.status === "testing" ? "gates" : "merge",
        "infrastructure",
        "Queue attempt expired.",
      );
      for (const id of [state.mergeRunId, state.gateRunId])
        if (id) await deps.cancel(id).catch((error) => console.error("Queue expired run", error));
      continue;
    }
    try {
      const moved = await step(env, repo, state, deps);
      const latest = await getQueue(env.DB, repoId, state.entry.id);
      if (latest && ["landed", "failed", "cancelled"].includes(latest.entry.status))
        await terminalEffects(env, repo, latest, deps).catch((error) =>
          console.error("Queue terminal effects", latest.entry.id, error),
        );
      if (!moved) return;
    } catch (error) {
      // An uncertain main CAS must remain advancing until its reread succeeds.
      if (state.entry.status === "advancing") {
        console.error("Queue progression deferred", state.entry.id, error);
        return;
      }
      // Steps are safe to repeat: a transient provider error (or in local
      // development a dropped remote binding session) is retried in place.
      const pause = retryMs[retries++];
      if (pause !== undefined) {
        console.warn("Queue step failed; retrying it", state.entry.id, error);
        await new Promise((resolve) => setTimeout(resolve, pause));
        continue;
      }
      // Past its retries, an infrastructure error is an honest terminal failure.
      console.error("Queue progression deferred", state.entry.id, error);
      const current = await getQueue(env.DB, repoId, state.entry.id);
      if (current?.version === state.version)
        await failure(
          env,
          current,
          state.entry.status === "testing" ? "gates" : "merge",
          "infrastructure",
          "Queue infrastructure operation failed; inspect run logs and retry.",
        );
    }
  }
}
export async function afterQueueRun(
  env: Env,
  repoId: string,
  _runId: string,
  waitUntil: Waiter,
): Promise<void> {
  await progressQueue(env, repoId, waitUntil);
}
export async function sweepQueue(env: Env, waitUntil: Waiter): Promise<void> {
  // Every unfinished record participates, not only recent completed CI callbacks.
  const k = db(env.DB);
  const repos = await k
    .selectFrom("merge_queue")
    .select("repo_id")
    .select(sql<string>`min(swept_at)`.as("last_swept"))
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("repos")
          .select("id")
          .whereRef("repos.id", "=", "merge_queue.repo_id")
          .where("deleted_at", "is", null),
      ),
    )
    .where(
      sql<boolean>`status IN ('queued','merging','testing','advancing') OR json_extract(data, '$.effectsPending') = 1 OR json_extract(data, '$.remediationPending') = 1 OR (status = 'landed' AND json_extract(data, '$.entry.deployStatus') NOT IN ('succeeded','failed','cancelled'))`,
    )
    .groupBy("repo_id")
    .orderBy("last_swept", "asc")
    .limit(50)
    .execute();
  for (const repo of repos) {
    await k
      .updateTable("merge_queue")
      .set({ swept_at: new Date().toISOString() })
      .where("repo_id", "=", repo.repo_id)
      .execute();
    await progressQueue(env, repo.repo_id, waitUntil).catch((error) =>
      console.error("Queue sweep", repo.repo_id, error),
    );
  }
}
