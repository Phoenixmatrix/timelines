import { queueCandidateBranch } from "../../shared/merge-queue.ts";
import { jobCaller } from "../deployments/job.ts";
import { db } from "../schema.ts";

export type QueueMergeJobAccess =
  | {
      ok: true;
      queueId: string;
      attempt: number;
      runId: string;
      jobId: string;
      repo: { id: string; artifacts_name: string; artifacts_remote: string };
      branch: string;
    }
  | { ok: false; status: 401 | 403; error: string };

/** Authority shared by Git and conflict resolution; never inferred from a branch name alone. */
export async function queueMergeJob(
  d1: D1Database,
  secret: string,
  owner: string,
  name: string,
  queueId?: string,
): Promise<QueueMergeJobAccess> {
  const job = await jobCaller(d1, secret);
  if (!job)
    return {
      ok: false,
      status: 401,
      error: "This isn't a running CI job's credential (has the job ended?).",
    };
  const row = await db(d1)
    .selectFrom("ci_jobs as j")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .innerJoin("repos as p", "p.id", "j.repo_id")
    .innerJoin("accounts as o", "o.id", "p.owner_id")
    .innerJoin("merge_queue as q", (join) =>
      join.onRef("q.repo_id", "=", "p.id").onRef("q.id", "=", "r.queue_id"),
    )
    .select([
      "j.spec",
      "j.status as jobStatus",
      "r.status as runStatus",
      "r.repo_id as runRepo",
      "r.trigger",
      "r.commit_oid",
      "r.ref",
      "p.id",
      "p.name",
      "o.slug as owner",
      "p.artifacts_name",
      "p.artifacts_remote",
      "q.id as queueId",
      "q.attempts",
      "q.status as queueStatus",
      "q.merge_run_id",
      "q.base",
      "q.data",
    ])
    .where("j.id", "=", job.jobId)
    .executeTakeFirst();
  let spec: { queue?: { id?: unknown; attempt?: unknown }; landing?: unknown } | null = null;
  let source: unknown = null;
  try {
    spec = row ? JSON.parse(row.spec) : null;
    const data = row ? (JSON.parse(row.data) as { mergeSource?: unknown } | null) : null;
    source = data?.mergeSource ?? row?.queueId;
  } catch {
    // Damaged persisted authority cannot grant access.
  }
  if (
    !row ||
    !/^[0-9a-f]{40}$/.test(row.queueId) ||
    (queueId !== undefined && row.queueId !== queueId) ||
    job.jobName !== "land" ||
    row.jobStatus !== "running" ||
    row.runStatus !== "running" ||
    row.trigger !== "manual" ||
    row.runRepo !== row.id ||
    row.owner !== owner ||
    row.name !== name ||
    row.queueStatus !== "merging" ||
    row.merge_run_id !== job.runId ||
    !Number.isSafeInteger(row.attempts) ||
    row.attempts < 1 ||
    !row.base ||
    !/^[0-9a-f]{40}$/.test(row.base) ||
    spec?.queue?.id !== row.queueId ||
    spec.queue.attempt !== row.attempts ||
    spec.landing != null ||
    typeof source !== "string" ||
    !/^[0-9a-f]{40}$/.test(source) ||
    row.commit_oid !== source ||
    row.ref !== queueCandidateBranch(row.queueId, row.attempts)
  )
    return {
      ok: false,
      status: 403,
      error:
        "Only the current running queue merge job may access its repository and candidate branch.",
    };
  return {
    ok: true,
    queueId: row.queueId,
    attempt: row.attempts,
    runId: job.runId,
    jobId: job.jobId,
    repo: {
      id: row.id,
      artifacts_name: row.artifacts_name,
      artifacts_remote: row.artifacts_remote,
    },
    branch: queueCandidateBranch(row.queueId, row.attempts),
  };
}
