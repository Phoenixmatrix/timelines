// Job state in D1, shared by both runners. `gm runner` reports over the API,
// the sandbox Durable Object calls report() directly; either way output is
// masked and stored the same way, and the run's Workflow hears about the end.

import { sql } from "kysely";
import type { CiClaimedJob, CiJobReport } from "../../shared/api.ts";
import { timelineSlugOf } from "../../shared/timelines.ts";
import { batch, db, nowIso } from "../schema.ts";
import type { JobSpec } from "./config.ts";
import { registrySetup, revokeJobTokens } from "./registry.ts";
import { previousVerification } from "./verification.ts";
import { resolveJobAuthority, WorkAuthorizationError } from "./admission.ts";

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
    .innerJoin("spaces as s", "s.id", "p.space_id")
    .selectAll("j")
    .select([
      "r.number",
      "r.trigger",
      "r.commit_oid",
      "r.ref",
      "r.timeline_slug",
      "r.checkpoint_id",
      "r.preview_action",
      "r.landing_id",
      "r.queue_id",
      "r.step",
      sql<string>`s.slug || '/' || p.name`.as("full_name"),
      "p.artifacts_name",
      "p.artifacts_remote",
    ])
    .where("j.id", "=", jobId)
    .whereRef("j.source_id", "=", "r.source_id")
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
  env: Env,
  job: JobContext,
  registry: { origin: string; token: string },
): Promise<CiClaimedJob> {
  await resolveJobAuthority(env, job.id);
  const d1 = env.DB;
  const spec = JSON.parse(job.spec) as StoredJob;
  const secrets = await secretsFor(d1, job.repo_id, spec.secrets);
  const setup = registrySetup(registry.origin, job.full_name.split("/")[0] ?? "", registry.token);
  const owned =
    job.source_id === "canonical"
      ? null
      : await db(d1)
          .selectFrom("timeline_work_sources")
          .select("timeline_slug")
          .where("repo_id", "=", job.repo_id)
          .where("source_id", "=", job.source_id)
          .executeTakeFirst();
  if (job.source_id !== "canonical" && !owned)
    throw new Error("Job's exact work source is unavailable.");
  const timelineSlug = owned?.timeline_slug ?? null;
  // The preview contract (CORE-79): a preview run names its timeline,
  // checkpoint and action; a push to a timeline's bookmark, or to its work
  // source (whose ref is just `work`, CORE-296), names the timeline.
  const timeline = job.timeline_slug ?? timelineSlug ?? timelineSlugOf(`refs/heads/${job.ref}`);
  const gitUrl = `${registry.origin}/${job.full_name}${timelineSlug ? `@${encodeURIComponent(timelineSlug)}` : ""}.git`;
  const verifiedBase = JSON.stringify(await previousVerification(d1, job.id));
  await resolveJobAuthority(env, job.id);
  return {
    id: job.id,
    runId: job.run_id,
    runNumber: job.number,
    name: job.name,
    repo: job.full_name,
    sourceId: job.source_id,
    timelineSlug,
    gitUrl,
    commit: job.commit_oid,
    ref: job.ref,
    timeoutMinutes: spec.timeoutMinutes,
    env: {
      CI: "true",
      GITMATRIX: "true",
      GITMATRIX_REPOSITORY: job.full_name,
      GITMATRIX_BRANCH: job.ref,
      GITMATRIX_COMMIT: job.commit_oid,
      GITMATRIX_SOURCE_ID: job.source_id,
      GITMATRIX_GIT_URL: gitUrl,
      GITMATRIX_RUN_NUMBER: String(job.number),
      GITMATRIX_JOB: job.name,
      GITMATRIX_TRIGGER: job.preview_action
        ? "preview"
        : job.landing_id || job.queue_id
          ? "landing"
          : job.step
            ? "step"
            : job.trigger,
      ...(job.queue_id ? { GITMATRIX_QUEUE_ID: job.queue_id } : {}),
      ...(timeline ? { GITMATRIX_TIMELINE: timeline } : {}),
      ...(job.checkpoint_id ? { GITMATRIX_CHECKPOINT: job.checkpoint_id } : {}),
      ...(job.preview_action ? { GITMATRIX_PREVIEW_ACTION: job.preview_action } : {}),
      ...setup.env,
      ...spec.env,
      ...secrets,
      // Reserved: repository env and secrets cannot manufacture verification provenance.
      GITMATRIX_VERIFIED_BASE: verifiedBase,
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
  const authorize = async () => {
    try {
      await resolveJobAuthority(env, jobId);
      return true;
    } catch (error) {
      await revokeJobTokens(d1, jobId);
      if (!(error instanceof WorkAuthorizationError)) throw error;
      // Ask the runner to stop without accepting logs, steps or success.
      // Only its later terminal acknowledgment releases the source claim.
      if (update.done) await settleStoppedJob(env, jobId, "Job authority is no longer current.");
      return false;
    }
  };
  if (!(await authorize())) return { cancelled: true };
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
        .set({
          status,
          exit_code: exitCode ?? null,
          error: error ?? null,
          finished_at: now,
          source_completion_pending: 0,
        })
        .where("id", "=", jobId)
        .where((eb) =>
          eb.or([
            eb("status", "in", ["queued", "running"]),
            eb("source_completion_pending", "=", 1),
          ]),
        ),
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
  if (!(await authorize())) return { cancelled: true };
  await batch(d1, statements);

  // The job's registry credential ends with the job.
  if (update.done) await revokeJobTokens(d1, jobId);
  if (update.done && job.runner === "local") {
    const instance = await env.CI_RUN.get(job.run_id);
    await instance.sendEvent({
      type: doneEvent(job.name),
      payload: { status: update.done.status },
    });
  }
  // Parent cancellation asks a runner to stop, but its source claim remains
  // until the runner reports done. Never mistake the request for completion.
  const current = await kdb
    .selectFrom("ci_jobs as j")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .select(["j.status", "r.status as run_status"])
    .where("j.id", "=", jobId)
    .executeTakeFirst();
  return {
    cancelled:
      current?.status === "cancelled" ||
      current?.run_status === "cancelled" ||
      current?.run_status === "failed",
  };
}

/** A dispatch/lease failure is not acknowledgment that a running consumer ended. */
export async function failDispatch(d1: D1Database, jobId: string, error: string): Promise<void> {
  await db(d1)
    .updateTable("ci_jobs")
    .set((eb) => ({
      error,
      status: eb
        .case()
        .when(eb.and([eb("source_id", "!=", "canonical"), eb("status", "=", "running")]))
        .then("running" as const)
        .else("failed" as const)
        .end(),
      finished_at: eb
        .case()
        .when(eb.and([eb("source_id", "!=", "canonical"), eb("status", "=", "running")]))
        .then(eb.ref("finished_at"))
        .else(nowIso())
        .end(),
    }))
    .where("id", "=", jobId)
    .where("status", "in", ["pending", "queued", "running"])
    .execute();
}

/** Claim a queued job for a local runner; false if someone else got it first. */
export async function claim(env: Env, jobId: string, runnerName: string): Promise<boolean> {
  await resolveJobAuthority(env, jobId);
  const result = await db(env.DB)
    .updateTable("ci_jobs")
    .set({
      status: "running",
      claimed_by: runnerName,
      started_at: nowIso(),
      source_completion_pending: 1,
    })
    .where("id", "=", jobId)
    .where("status", "=", "queued")
    .where("run_id", "in", (eb) =>
      eb.selectFrom("ci_runs").select("id").where("status", "in", ["queued", "running"]),
    )
    .executeTakeFirst();
  return result.numUpdatedRows > 0n;
}

/** Internal shutdown acknowledgment, never a capability to publish job results. */
export async function settleStoppedJob(env: Env, jobId: string, error: string): Promise<void> {
  const job = await loadJob(env.DB, jobId);
  if (!job) throw new Error(`No CI job ${jobId}`);
  const kdb = db(env.DB);
  await batch(env.DB, [
    kdb
      .updateTable("ci_jobs")
      .set({ status: "cancelled", error, finished_at: nowIso(), source_completion_pending: 0 })
      .where("id", "=", jobId)
      .where((eb) =>
        eb.or([
          eb("status", "in", ["pending", "queued", "running"]),
          eb("source_completion_pending", "=", 1),
        ]),
      ),
    kdb
      .updateTable("ci_steps")
      .set({ status: "cancelled", finished_at: nowIso() })
      .where("job_id", "=", jobId)
      .where("status", "in", ["pending", "running"]),
  ]);
  await revokeJobTokens(env.DB, jobId);
  if (job.runner === "local") {
    const instance = await env.CI_RUN.get(job.run_id);
    await instance.sendEvent({ type: doneEvent(job.name), payload: { status: "cancelled" } });
  }
}
