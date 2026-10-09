import type { CiJobVerification } from "../../shared/api.ts";
import { getQueue } from "../merge-queue/store.ts";
import { db } from "../schema.ts";
import { jobRuns } from "./config.ts";
import type { StoredJob } from "./jobs.ts";

/** The platform-resolved image, not the repository's mutable `default` alias. */
export function executionIdentity(image: string | undefined, version: unknown): string | null {
  if (!image || !/(?:^|@)sha256:[0-9a-f]{64}$/.test(image)) return null;
  if (typeof version !== "object" || version === null) return null;
  const id: unknown = Reflect.get(version, "id");
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return `sandbox-v1:${id}:${image}`;
}

export interface CandidateVerification {
  queueId: string;
  attempt: number;
  gateRunId: string;
}

export interface VerificationProof {
  spec: string;
  proof: CiJobVerification;
}

export function eligibleVerification(spec: StoredJob): boolean {
  return (
    spec?.verification === "context-invariant-v1" &&
    spec.image === "default" &&
    Array.isArray(spec.secrets) &&
    spec.secrets.length === 0 &&
    Array.isArray(spec.steps) &&
    spec.steps.length > 0 &&
    !spec.concurrency &&
    !spec.local
  );
}

/** Dependency gates accept executed success or admitted verification, never ordinary skips. */
export function prerequisitesSatisfied(
  needs: readonly string[],
  outcomes: ReadonlyMap<string, string>,
): boolean {
  return needs.every(
    (need) => outcomes.get(need) === "succeeded" || outcomes.get(need) === "verified",
  );
}

/** Read only the current landed queue attempt's canonical executed evidence. */
export async function candidateProofs(
  d1: D1Database,
  target: { repoId: string; runId: string; branch: string; commit: string },
  candidate: CandidateVerification,
  identity: string | null,
): Promise<Map<string, VerificationProof>> {
  const proofs = new Map<string, VerificationProof>();
  if (!identity) return proofs;
  const queue = await getQueue(d1, target.repoId, candidate.queueId);
  if (
    !queue ||
    queue.entry.status !== "landed" ||
    queue.entry.attempts !== candidate.attempt ||
    queue.entry.candidate !== target.commit ||
    queue.entry.branch !== target.branch ||
    queue.gateRunId !== candidate.gateRunId ||
    queue.deployRunId !== target.runId
  )
    return proofs;
  const k = db(d1);
  const run = await k
    .selectFrom("ci_runs")
    .selectAll()
    .where("id", "=", candidate.gateRunId)
    .executeTakeFirst();
  if (
    !run ||
    run.repo_id !== target.repoId ||
    run.source_id !== "canonical" ||
    run.commit_oid !== target.commit ||
    run.queue_id !== candidate.queueId ||
    run.queue_attempt !== candidate.attempt ||
    run.ref !== queue.entry.candidateBranch ||
    run.trigger !== "manual" ||
    run.landing_id ||
    run.preview_action ||
    run.step ||
    run.status !== "succeeded" ||
    !run.started_at ||
    !run.finished_at ||
    run.config_error ||
    run.covered_by
  )
    return proofs;
  const jobs = await k.selectFrom("ci_jobs").selectAll().where("run_id", "=", run.id).execute();
  const steps = await k
    .selectFrom("ci_steps as s")
    .innerJoin("ci_jobs as j", "j.id", "s.job_id")
    .selectAll("s")
    .where("j.run_id", "=", run.id)
    .execute();
  const duplicate = new Set(
    jobs
      .filter((job, i) => jobs.findIndex((other) => other.name === job.name) !== i)
      .map((job) => job.name),
  );
  for (const job of jobs) {
    let spec: StoredJob;
    try {
      spec = JSON.parse(job.spec) as StoredJob;
      if (
        !eligibleVerification(spec) ||
        !jobRuns(spec, {
          branch: run.ref,
          commit: run.commit_oid,
          trigger: "landing",
          runner: "sandbox",
          action: "",
        })
      )
        continue;
    } catch {
      continue;
    }
    const completed = steps.filter((step) => step.job_id === job.id);
    if (
      duplicate.has(job.name) ||
      job.repo_id !== target.repoId ||
      job.source_id !== "canonical" ||
      job.runner !== "sandbox" ||
      job.claimed_by !== "sandbox" ||
      job.status !== "succeeded" ||
      job.exit_code !== 0 ||
      job.error ||
      !job.started_at ||
      !job.finished_at ||
      job.source_completion_pending ||
      job.verified_by ||
      job.execution_identity !== identity ||
      completed.length !== spec.steps.length ||
      completed.some(
        (step, position) =>
          step.status !== "succeeded" ||
          step.exit_code !== 0 ||
          !step.started_at ||
          !step.finished_at ||
          !spec.steps[step.position] ||
          step.name !== spec.steps[step.position]!.name ||
          completed.some((other, index) => index !== position && other.position === step.position),
      )
    )
      continue;
    proofs.set(job.name, {
      spec: job.spec,
      proof: {
        runId: run.id,
        runNumber: run.number,
        jobId: job.id,
        queueId: candidate.queueId,
        attempt: candidate.attempt,
        commit: target.commit,
        sourceId: "canonical",
        contract: "context-invariant-v1",
        executionIdentity: identity,
      },
    });
  }
  return proofs;
}
