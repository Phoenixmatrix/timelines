// Job state in D1, shared by both runners. `gm runner` reports over the API,
// the sandbox Durable Object calls report() directly; either way output is
// masked and stored the same way, and the run's Workflow hears about the end.

import { sql } from "kysely";
import type { CiClaimedJob, CiJobReport } from "../../shared/api.ts";
import { timelineSlugOf } from "../../shared/timelines.ts";
import { batch, db, nowIso } from "../schema.ts";
import type { JobSpec } from "./config.ts";
import { registrySetup, revokeJobTokens } from "./registry.ts";

/** What ci_jobs.spec holds: the parsed job with pipeline env merged in. */
export type StoredJob = Omit<JobSpec, "name">;

type JobContext = NonNullable<Awaited<ReturnType<typeof loadJob>>>;

const MAX_CHUNK = 64 * 1024;
const MAX_CHUNKS_PER_JOB = 4000;

/** The Workflow event a job's end is announced with. */
export const doneEvent = (jobName: string) => `job-done-${jobName}`;

export async function loadJob(d1: D1Database, jobId: string) {
  const row = await db(d1)
    .selectFrom("ci_jobs as j")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .innerJoin("repos as p", "p.id", "j.repo_id")
    .innerJoin("accounts as o", "o.id", "p.owner_id")
    .selectAll("j")
    .select([
      "r.number",
      "r.trigger",
      "r.commit_oid",
      "r.ref",
      "r.timeline_slug",
      "r.checkpoint_id",
      "r.preview_action",
      sql<string>`o.slug || '/' || p.name`.as("full_name"),
      "p.artifacts_name",
      "p.artifacts_remote",
    ])
    .where("j.id", "=", jobId)
    .executeTakeFirst();
  return row ?? null;
}

async function secretsFor(d1: D1Database, repoId: string, names: string[]) {
  if (names.length === 0) return {};
  const results = await db(d1)
    .selectFrom("ci_secrets")
    .select(["name", "value"])
    .where("repo_id", "=", repoId)
    .where("name", "in", names)
    .execute();
  return Object.fromEntries(results.map((r) => [r.name, r.value]));
}

/**
 * Everything a runner needs to execute a job, secrets included, plus the
 * package tools' configuration for publishing with the job's credential.
 */
export async function jobPayload(
  d1: D1Database,
  job: JobContext,
  registry: { origin: string; token: string },
): Promise<CiClaimedJob> {
  const spec = JSON.parse(job.spec) as StoredJob;
  const secrets = await secretsFor(d1, job.repo_id, spec.secrets);
  const setup = registrySetup(registry.origin, job.full_name.split("/")[0] ?? "", registry.token);
  // The preview contract (CORE-79): a preview run names its timeline,
  // checkpoint and action; a push to a timeline's bookmark names the timeline.
  const timeline = job.timeline_slug ?? timelineSlugOf(`refs/heads/${job.ref}`);
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
      GITMATRIX_TRIGGER: job.preview_action ? "preview" : job.trigger,
      ...(timeline ? { GITMATRIX_TIMELINE: timeline } : {}),
      ...(job.checkpoint_id ? { GITMATRIX_CHECKPOINT: job.checkpoint_id } : {}),
      ...(job.preview_action ? { GITMATRIX_PREVIEW_ACTION: job.preview_action } : {}),
      ...setup.env,
      ...spec.env,
      ...secrets,
    },
    files: setup.files,
    steps: spec.steps.map((s, i) => ({ position: i, name: s.name, run: s.run })),
  };
}

/** Hide secret values (and any CI job credential) in output. */
export function mask(text: string, secrets: string[]): string {
  let out = text.replace(/gmj_[A-Za-z0-9]+/g, "gmj_***");
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
  const d1 = env.DB;
  const kdb = db(d1);
  const job = await loadJob(d1, jobId);
  if (!job) throw new Error(`No CI job ${jobId}`);
  const spec = JSON.parse(job.spec) as StoredJob;
  const secrets = Object.values(await secretsFor(d1, job.repo_id, spec.secrets));
  const statements: Parameters<typeof batch>[1] = [];

  for (const log of update.logs ?? []) {
    if (!log.text) continue;
    statements.push(
      kdb
        .insertInto("ci_logs")
        .columns(["job_id", "seq", "step", "text"])
        .expression((eb) =>
          eb
            .selectFrom("ci_logs")
            .select([
              eb.val(jobId).as("job_id"),
              eb(eb.fn.coalesce(eb.fn.max("seq"), eb.lit(0)), "+", eb.lit(1)).as("seq"),
              eb.val(log.step).as("step"),
              eb.val(mask(log.text, secrets).slice(0, MAX_CHUNK)).as("text"),
            ])
            .where("job_id", "=", jobId)
            .having(eb.fn.countAll(), "<", MAX_CHUNKS_PER_JOB),
        ),
    );
  }
  for (const step of update.steps ?? []) {
    const terminal = step.status !== "running" && step.status !== "pending";
    const now = nowIso();
    statements.push(
      kdb
        .updateTable("ci_steps")
        .set((eb) => ({
          status: step.status,
          exit_code: step.exitCode ?? null,
          started_at: step.status === "running" ? now : eb.fn.coalesce("started_at", eb.val(now)),
          finished_at: terminal ? now : null,
        }))
        .where("job_id", "=", jobId)
        .where("position", "=", step.position)
        .where("status", "!=", "cancelled"),
    );
  }
  if (update.done) {
    const { status, exitCode, error } = update.done;
    const now = nowIso();
    statements.push(
      kdb
        .updateTable("ci_jobs")
        .set({ status, exit_code: exitCode ?? null, error: error ?? null, finished_at: now })
        .where("id", "=", jobId)
        .where("status", "in", ["queued", "running"]),
      // Steps that never ran are skipped; one cut off mid-way takes the job's fate.
      kdb
        .updateTable("ci_steps")
        .set((eb) => ({
          status: eb
            .case("status")
            .when("running")
            .then(status)
            .else("skipped" as const)
            .end(),
          finished_at: now,
        }))
        .where("job_id", "=", jobId)
        .where("status", "in", ["pending", "running"]),
    );
  }
  await batch(d1, statements);

  // The job's registry credential ends with the job.
  if (update.done) await revokeJobTokens(d1, jobId);
  if (update.done && job.runner === "local") {
    const instance = await env.CI_RUN.get(job.run_id).catch(() => null);
    await instance
      ?.sendEvent({ type: doneEvent(job.name), payload: { status: update.done.status } })
      .catch((error) => console.error("CI: could not wake the run", error));
  }
  const status = update.done
    ? (await kdb.selectFrom("ci_jobs").select("status").where("id", "=", jobId).executeTakeFirst())
        ?.status
    : job.status;
  return { cancelled: status === "cancelled" };
}

/** Claim a queued job for a local runner; false if someone else got it first. */
export async function claim(d1: D1Database, jobId: string, runnerName: string): Promise<boolean> {
  const result = await db(d1)
    .updateTable("ci_jobs")
    .set({ status: "running", claimed_by: runnerName, started_at: nowIso() })
    .where("id", "=", jobId)
    .where("status", "=", "queued")
    .executeTakeFirst();
  return result.numUpdatedRows === BigInt(1);
}
