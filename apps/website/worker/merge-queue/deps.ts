import type { QueueDecision, QueueFailure } from "../../shared/merge-queue.ts";
import { lsRefs } from "../artifacts.ts";
import { startMergeRun, runOutcome } from "../ci/landing.ts";
import { startRun, startWorkflow } from "../ci/trigger.ts";
import { revokeJobTokens } from "../ci/registry.ts";
import { resolveWorkAuthority } from "../ci/admission.ts";
import { afterQueuedPush, type PushedRepo } from "../git/effects.ts";
import { diffTrees } from "../knowledge/overlay.ts";
import { db, batch } from "../schema.ts";
import { writeRefs, type RefWrite, type RefWriteResult } from "../timelines/bookmarks.ts";
import { classifyQueue } from "./ai.ts";
import { recordQueueFailure } from "./remediation.ts";
import type { StoredQueue } from "./store.ts";
export type Waiter = (work: Promise<unknown>) => void;
export interface Outcome {
  number: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  conflict: boolean;
  failedJobs: string[];
}
export interface QueueDeps {
  refs: (repo: PushedRepo) => Promise<Map<string, string>>;
  parents: (repo: PushedRepo, commit: string) => Promise<string[] | null>;
  write: (repo: PushedRepo, writes: RefWrite[]) => Promise<RefWriteResult[]>;
  merge: (repo: PushedRepo, state: StoredQueue) => Promise<{ number: number }>;
  gates: (
    repo: PushedRepo,
    state: StoredQueue,
  ) => Promise<{ runId: string; number: number } | { skipped: string }>;
  deploy: (
    repo: PushedRepo,
    state: StoredQueue,
  ) => Promise<{ runId: string; number: number } | { skipped: string }>;
  outcome: (runId: string) => Promise<Outcome | null>;
  recover: (runId: string) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  effects: (repo: PushedRepo, state: StoredQueue) => Promise<void>;
  classify: (
    repo: PushedRepo,
    state: StoredQueue,
    entries: StoredQueue[],
  ) => Promise<QueueDecision>;
  remediate: (
    repo: PushedRepo,
    state: StoredQueue,
    failure: QueueFailure,
  ) => Promise<{ id: string }>;
  /** Pauses before retrying a failed step in place (default: the scheduler's). */
  stepRetryMs?: readonly number[];
}
export function queueDeps(env: Env, waitUntil: Waiter): QueueDeps {
  const live = async <T>(repo: PushedRepo, work: () => Promise<T>): Promise<T> => {
    const row = await db(env.DB)
      .selectFrom("repos")
      .select("id")
      .where("id", "=", repo.id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!row) throw new Error("Repository is being deleted or no longer exists.");
    return work();
  };
  return {
    refs: async (repo) =>
      new Map(
        (await lsRefs(env, repo.artifacts_name, repo.artifacts_remote)).flatMap((r) =>
          r.oid ? [[r.name, r.oid] as const] : [],
        ),
      ),
    parents: async (repo, commit) => {
      using artifacts = await env.ARTIFACTS.get(repo.artifacts_name);
      return (await artifacts.readCommit(commit))?.parents ?? null;
    },
    write: (repo, writes) => live(repo, () => writeRefs(env, repo, writes)),
    merge: (repo, s) =>
      live(repo, () =>
        startMergeRun(env, repo, {
          runId: s.mergeRunId!,
          authority: s.authority,
          queueId: s.entry.id,
          attempt: s.entry.attempts,
          branch: s.entry.candidateBranch,
          commit: s.mergeSource,
          base: s.entry.base!,
          mainBranch: s.entry.branch,
          message: `Merge queued ${s.entry.id}`,
          title: `Queue ${s.entry.id.slice(0, 12)}`,
          author: { name: "Timelines merge queue", email: "queue@gitmatrix.dev" },
          actor: { id: s.actor.id, agentId: s.actor.agent?.id ?? null },
        }),
      ),
    gates: (repo, s) =>
      live(repo, () =>
        startRun(env, repo, {
          runId: s.gateRunId!,
          authority: s.authority,
          queueId: s.entry.id,
          queueAttempt: s.entry.attempts,
          branch: s.entry.candidateBranch,
          commit: s.entry.candidate!,
          trigger: "landing",
          actor: s.actor,
          waitUntil,
        }),
      ),
    deploy: (repo, s) =>
      live(repo, () =>
        startRun(env, repo, {
          runId: s.deployRunId!,
          authority: s.authority,
          verification: { queueId: s.entry.id, attempt: s.entry.attempts, gateRunId: s.gateRunId! },
          branch: s.entry.branch,
          commit: s.entry.candidate!,
          trigger: "push",
          actor: s.actor,
          waitUntil,
        }),
      ),
    outcome: (id) => runOutcome(env.DB, id),
    recover: async (id) => {
      const run = await db(env.DB)
        .selectFrom("ci_runs")
        .select(["status", "held_at"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!run || run.status !== "queued" || run.held_at) return;
      try {
        await startWorkflow(env, id);
      } catch (error) {
        if (!(await env.CI_RUN.get(id).catch(() => null))) throw error;
      }
    },
    cancel: async (id) => {
      const k = db(env.DB),
        now = new Date().toISOString();
      const jobs = await k.selectFrom("ci_jobs").select("id").where("run_id", "=", id).execute();
      await batch(env.DB, [
        k
          .updateTable("ci_runs")
          .set({ status: "cancelled", finished_at: now })
          .where("id", "=", id)
          .where("status", "in", ["queued", "running"]),
        k
          .updateTable("ci_jobs")
          .set({ status: "cancelled", finished_at: now })
          .where("run_id", "=", id)
          .where("status", "in", ["pending", "queued"]),
      ]);
      await Promise.all(jobs.map((j) => revokeJobTokens(env.DB, j.id)));
      const instance = await env.CI_RUN.get(id).catch(() => null);
      await instance?.terminate();
    },
    effects: async (repo, s) => {
      const { actor } = await resolveWorkAuthority(env, s.authority, repo.id);
      return live(repo, () => afterQueuedPush(env, repo, actor, s.authority));
    },
    classify: async (repo, s, entries) => {
      await resolveWorkAuthority(env, s.authority, repo.id);
      for (const entry of entries) await resolveWorkAuthority(env, entry.authority, repo.id);
      if (entries.length < 2)
        return {
          action: "separate",
          reason: "Only one submission is pending.",
          model: null,
          confidence: null,
        };
      using artifacts = await env.ARTIFACTS.get(repo.artifacts_name);
      let reads = 0;
      const reader = {
        tree: async (oid: string) => {
          if (++reads > 64) throw new Error("Queue scheduling tree budget exceeded");
          return artifacts.readTree(oid);
        },
      };
      const inputs = [];
      for (const entry of entries) {
        const commit = await artifacts.readCommit(entry.entry.commit);
        if (!commit) throw new Error("Pinned scheduling commit is missing");
        const parent = commit.parents[0] ? await artifacts.readCommit(commit.parents[0]) : null;
        const changes = await diffTrees(reader, parent?.treeHash ?? null, commit.treeHash);
        if (changes.length > 100) throw new Error("Queue scheduling path budget exceeded");
        inputs.push({
          id: entry.entry.id,
          commit: entry.entry.commit,
          paths: changes.map((change) => change.path),
        });
      }
      return classifyQueue(env, s.snapshot, { repoId: repo.id, entries: inputs });
    },
    remediate: async (repo, s, failure) => {
      await resolveWorkAuthority(env, s.authority, repo.id);
      return live(repo, () =>
        recordQueueFailure(env, {
          spaceId: repo.space_id,
          repoId: repo.id,
          actorId: s.actor.id,
          agentId: s.actor.agent?.id ?? null,
          credential: s.authority.credential,
          issueIds: s.entry.issueIds,
          failure,
        }),
      );
    },
  };
}
