// Job state in D1, shared by both runners. `gm runner` reports over the API,
// the sandbox Durable Object calls report() directly; either way output is
// masked and stored the same way, and the run's Workflow hears about the end.

import type { CiClaimedJob, CiJobReport, CiRunner } from "../../shared/api.ts";
import type { JobSpec } from "./config.ts";

/** What ci_jobs.spec holds: the parsed job with pipeline env merged in. */
export type StoredJob = Omit<JobSpec, "name">;

export interface JobRow {
  id: string;
  run_id: string;
  repo_id: string;
  name: string;
  spec: string;
  status: string;
  runner: CiRunner;
  claimed_by: string | null;
}

interface JobContext extends JobRow {
  number: number;
  commit_oid: string;
  ref: string;
  full_name: string;
  artifacts_name: string;
  artifacts_remote: string;
}

const MAX_CHUNK = 64 * 1024;
const MAX_CHUNKS_PER_JOB = 4000;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** The Workflow event a job's end is announced with. */
export const doneEvent = (jobName: string) => `job-done-${jobName}`;

export async function loadJob(db: D1Database, jobId: string): Promise<JobContext | null> {
  return db
    .prepare(
      `SELECT j.*, r.number, r.commit_oid, r.ref, o.slug || '/' || p.name AS full_name,
         p.artifacts_name, p.artifacts_remote
       FROM ci_jobs j JOIN ci_runs r ON r.id = j.run_id JOIN repos p ON p.id = j.repo_id
       JOIN accounts o ON o.id = p.owner_id WHERE j.id = ?`,
    )
    .bind(jobId)
    .first<JobContext>();
}

async function secretsFor(db: D1Database, repoId: string, names: string[]) {
  if (names.length === 0) return {};
  const { results } = await db
    .prepare(
      `SELECT name, value FROM ci_secrets WHERE repo_id = ? AND name IN (${names.map(() => "?").join(",")})`,
    )
    .bind(repoId, ...names)
    .all<{ name: string; value: string }>();
  return Object.fromEntries(results.map((r) => [r.name, r.value]));
}

/** Everything a runner needs to execute a job, secrets included. */
export async function jobPayload(db: D1Database, job: JobContext): Promise<CiClaimedJob> {
  const spec = JSON.parse(job.spec) as StoredJob;
  const secrets = await secretsFor(db, job.repo_id, spec.secrets);
  return {
    id: job.id,
    runId: job.run_id,
    runNumber: job.number,
    name: job.name,
    repo: job.full_name,
    commit: job.commit_oid,
    ref: job.ref,
    timeoutMinutes: spec.timeoutMinutes,
    env: {
      CI: "true",
      GITMATRIX: "true",
      GITMATRIX_REPOSITORY: job.full_name,
      GITMATRIX_BRANCH: job.ref,
      GITMATRIX_COMMIT: job.commit_oid,
      GITMATRIX_RUN_NUMBER: String(job.number),
      GITMATRIX_JOB: job.name,
      ...spec.env,
      ...secrets,
    },
    steps: spec.steps.map((s, i) => ({ position: i, name: s.name, run: s.run })),
  };
}

/** Hide secret values in output. */
export function mask(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length >= 4) out = out.split(secret).join("***");
  }
  return out;
}

/** Apply a runner's report. Returns whether the job was cancelled meanwhile. */
export async function report(
  env: Env,
  jobId: string,
  update: CiJobReport,
): Promise<{ cancelled: boolean }> {
  const db = env.DB;
  const job = await loadJob(db, jobId);
  if (!job) throw new Error(`No CI job ${jobId}`);
  const spec = JSON.parse(job.spec) as StoredJob;
  const secrets = Object.values(await secretsFor(db, job.repo_id, spec.secrets));
  const statements: D1PreparedStatement[] = [];

  for (const log of update.logs ?? []) {
    if (!log.text) continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO ci_logs (job_id, seq, step, text)
           SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3 FROM ci_logs WHERE job_id = ?1
           HAVING COUNT(*) < ${MAX_CHUNKS_PER_JOB}`,
        )
        .bind(jobId, log.step, mask(log.text, secrets).slice(0, MAX_CHUNK)),
    );
  }
  for (const step of update.steps ?? []) {
    const terminal = step.status !== "running" && step.status !== "pending";
    statements.push(
      db
        .prepare(
          `UPDATE ci_steps SET status = ?1, exit_code = ?2,
             started_at = CASE WHEN ?1 = 'running' THEN ${now} ELSE COALESCE(started_at, ${now}) END,
             finished_at = CASE WHEN ?3 THEN ${now} ELSE NULL END
           WHERE job_id = ?4 AND position = ?5 AND status != 'cancelled'`,
        )
        .bind(step.status, step.exitCode ?? null, terminal ? 1 : 0, jobId, step.position),
    );
  }
  if (update.done) {
    const { status, exitCode, error } = update.done;
    statements.push(
      db
        .prepare(
          `UPDATE ci_jobs SET status = ?, exit_code = ?, error = ?, finished_at = ${now}
           WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .bind(status, exitCode ?? null, error ?? null, jobId),
      // Steps that never ran are skipped; one cut off mid-way takes the job's fate.
      db
        .prepare(
          `UPDATE ci_steps SET status = CASE status WHEN 'running' THEN ?1 ELSE 'skipped' END,
             finished_at = ${now}
           WHERE job_id = ?2 AND status IN ('pending', 'running')`,
        )
        .bind(status, jobId),
    );
  }
  if (statements.length) await db.batch(statements);

  if (update.done && job.runner === "local") {
    const instance = await env.CI_RUN.get(job.run_id).catch(() => null);
    await instance
      ?.sendEvent({ type: doneEvent(job.name), payload: { status: update.done.status } })
      .catch((error) => console.error("CI: could not wake the run", error));
  }
  const status = update.done
    ? await db
        .prepare("SELECT status FROM ci_jobs WHERE id = ?")
        .bind(jobId)
        .first<string>("status")
    : job.status;
  return { cancelled: status === "cancelled" };
}

/** Claim a queued job for a local runner; false if someone else got it first. */
export async function claim(db: D1Database, jobId: string, runnerName: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE ci_jobs SET status = 'running', claimed_by = ?, started_at = ${now}
       WHERE id = ? AND status = 'queued'`,
    )
    .bind(runnerName, jobId)
    .run();
  return result.meta.changes === 1;
}
