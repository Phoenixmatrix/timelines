// Trusted timeline compaction and the independent ordinary queue merge job.
// A compact job reads pinned work and canonical objects, computes exact B/O/T,
// and publishes from a fresh canonical-only object database. Its job credential
// can read only those sources and write only its canonical landing branch.

import { sql } from "kysely";
import { jobCaller } from "../deployments/job.ts";
import { PreviewModeError, productionOnly } from "../preview.ts";
import { batch, db } from "../schema.ts";
import type { StoredJob } from "./jobs.ts";
import { startWorkflow } from "./trigger.ts";
import { landingBranch, landingSlugOf } from "../../shared/timelines.ts";
import { QUEUE_MERGE_SCRIPT } from "./queue-script.ts";
import { COMPACT_SCRIPT } from "./compact-script.ts";
import type { SourceSnapshot } from "../../shared/code-source.ts";
import { resolveRunAuthority, resolveWorkAuthority, type WorkAuthority } from "./admission.ts";

/** The exit code the merge step ends with when the merge conflicts. */
export const CONFLICT_EXIT = 42;
/** The merge job's name in a landing's merge run. */
export const LANDING_JOB = "land";

/** What marks a job as a landing merge: only the Worker writes it into a spec. */
export interface LandingJobSpec extends StoredJob {
  landing: { slug: string; sourceId: string };
}

export interface QueueMergeJobSpec extends StoredJob {
  queue: { id: string; attempt: number };
}

/**
 * Record and start a landing's merge run under `runId` (chosen and saved by
 * the landing first, so a retry finds it): one job, on `branch` at the
 * checkpoint's `commit`. Starting it twice is harmless.
 */
export async function startMergeRun(
  env: Env,
  repo: { id: string },
  options: {
    runId: string;
    /** Exactly one authority: a timeline landing or the current queue attempt. */
    branch: string;
    commit: string;
    base: string;
    mainBranch: string;
    message: string;
    title: string;
    author: { name: string; email: string };
    actor: { id: string; agentId: string | null } | null;
    authority: WorkAuthority;
  } & (
    | {
        landingId: string;
        slug: string;
        source: SourceSnapshot;
        logicalBase: SourceSnapshot;
        old: string | null;
        queueId?: never;
        attempt?: never;
      }
    | { queueId: string; attempt: number; landingId?: never; slug?: never }
  ),
): Promise<{ number: number }> {
  // CI_RUN is production's Workflow: a preview can't run the merge, so it can't land.
  if (!productionOnly(env, "workflow", `the merge run of ${options.queueId ?? options.landingId}`))
    throw new PreviewModeError("workflow", "Previews don't run CI, so nothing lands in one.");
  await resolveWorkAuthority(env, options.authority, repo.id);
  const kdb = db(env.DB);
  const sourceId = "source" in options ? options.source.sourceId : "canonical";
  const spec: LandingJobSpec | QueueMergeJobSpec = {
    needs: [],
    if: null,
    image: "default",
    instance: "standard-1",
    env: {
      GITMATRIX_LANDING_BRANCH: options.branch,
      GITMATRIX_LANDING_MAIN: options.mainBranch,
      GITMATRIX_LANDING_BASE: options.base,
      GITMATRIX_LANDING_MESSAGE: options.message,
      GITMATRIX_LANDING_NAME: options.author.name,
      GITMATRIX_LANDING_EMAIL: options.author.email,
      ...("source" in options
        ? {
            GITMATRIX_LANDING_SOURCE: options.source.sourceId,
            GITMATRIX_LANDING_TIMELINE: options.slug,
            GITMATRIX_LANDING_SOURCE_TREE: options.source.tree,
            GITMATRIX_LANDING_LOGICAL_COMMIT: options.logicalBase.commit,
            GITMATRIX_LANDING_LOGICAL_TREE: options.logicalBase.tree,
            GITMATRIX_LANDING_OLD: options.old ?? "",
            GITMATRIX_LANDING_DATE: "2000-01-01T00:00:00Z",
          }
        : {
            GITMATRIX_QUEUE_ID: options.queueId,
            GITMATRIX_QUEUE_ATTEMPT: String(options.attempt),
          }),
    },
    secrets: [],
    timeoutMinutes: 20,
    steps: [
      {
        name: options.queueId ? "Merge into main" : "Materialize compact tree",
        run: options.queueId ? QUEUE_MERGE_SCRIPT : COMPACT_SCRIPT,
      },
    ],
    concurrency: null,
    paths: [],
    ...("source" in options
      ? { landing: { slug: options.slug, sourceId } }
      : { queue: { id: options.queueId, attempt: options.attempt } }),
  };
  // Named after the run, so recording it twice records it once.
  const jobId = `${options.runId}m`;
  await batch(env.DB, [
    kdb
      .insertInto("ci_runs")
      .columns([
        "id",
        "repo_id",
        "source_id",
        "space_id",
        "migration_epoch",
        "authority",
        "number",
        "commit_oid",
        "ref",
        "trigger",
        "actor_id",
        "agent_id",
        "title",
        "status",
        "landing_id",
        "queue_id",
      ])
      .expression((eb) =>
        eb
          .selectFrom("ci_runs")
          .select([
            eb.val(options.runId).as("id"),
            eb.val(repo.id).as("repo_id"),
            eb.val(sourceId).as("source_id"),
            eb.val(options.authority.spaceId).as("space_id"),
            eb.val(options.authority.migrationEpoch).as("migration_epoch"),
            eb.val(JSON.stringify(options.authority)).as("authority"),
            eb(eb.fn.coalesce(eb.fn.max("number"), eb.lit(0)), "+", eb.lit(1)).as("number"),
            eb.val(options.commit).as("commit_oid"),
            eb.val(options.branch).as("ref"),
            eb.val("manual" as const).as("trigger"),
            eb.val(options.authority.personId).as("actor_id"),
            eb.val(options.authority.agentId).as("agent_id"),
            eb.val(options.title.slice(0, 200)).as("title"),
            eb.val("queued" as const).as("status"),
            eb.val(options.landingId ?? null).as("landing_id"),
            eb.val(options.queueId ?? null).as("queue_id"),
          ])
          .where("repo_id", "=", repo.id)
          .having((eb) =>
            eb.exists(
              eb
                .selectFrom("repos")
                .select("id")
                .where("id", "=", repo.id)
                .where("deleted_at", "is", null),
            ),
          ),
      )
      .onConflict((oc) => oc.doNothing()),
    kdb
      .insertInto("ci_jobs")
      .values({
        id: jobId,
        run_id: options.runId,
        repo_id: repo.id,
        source_id: sourceId,
        name: LANDING_JOB,
        spec: JSON.stringify(spec),
        status: "pending",
        runner: env.CI_RUNNER,
      })
      .onConflict((oc) => oc.doNothing()),
    kdb
      .insertInto("ci_steps")
      .values({ job_id: jobId, position: 0, name: spec.steps[0]!.name, status: "pending" })
      .onConflict((oc) => oc.doNothing()),
  ]);
  const row = await kdb
    .selectFrom("ci_runs")
    .select(["number", "status"])
    .where("id", "=", options.runId)
    .executeTakeFirst();
  await resolveRunAuthority(env, options.runId);
  // Its Workflow, once: another look may have started it already.
  if (row?.status === "queued")
    try {
      await startWorkflow(env, options.runId);
    } catch (error) {
      // A handle alone is not evidence that the exact instance exists (CORE-391).
      const started = await env.CI_RUN.get(options.runId)
        .then((workflow) => workflow.status())
        .catch(() => null);
      if (!started) throw error;
    }
  return { number: row?.number ?? 0 };
}

/** A finished run, as a landing reads it: its outcome, and whether its merge conflicted. */
export async function runOutcome(
  d1: D1Database,
  runId: string,
): Promise<{
  number: number;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  conflict: boolean;
  failedJobs: string[];
} | null> {
  const kdb = db(d1);
  const run = await kdb
    .selectFrom("ci_runs")
    .select(["number", "status"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run) return null;
  const jobs = await kdb
    .selectFrom("ci_jobs as j")
    .select([
      "j.name",
      "j.status",
      "j.exit_code",
      sql<number>`(SELECT count(*) FROM ci_steps s WHERE s.job_id = j.id AND s.exit_code = ${CONFLICT_EXIT})`.as(
        "conflicts",
      ),
    ])
    .where("j.run_id", "=", runId)
    .execute();
  return {
    number: run.number,
    status: run.status,
    conflict: jobs.some(
      (job) =>
        job.name === LANDING_JOB &&
        job.status === "failed" &&
        (job.exit_code === CONFLICT_EXIT || Number(job.conflicts) > 0),
    ),
    failedJobs: jobs.filter((job) => job.status === "failed").map((job) => job.name),
  };
}

export type LandingJobAccess =
  | {
      ok: true;
      slug: string;
      sourceId: string;
      repo: { id: string; artifacts_name: string; artifacts_remote: string };
    }
  | { ok: false; status: 401 | 403; error: string };

/**
 * What a job credential (gmj_…) may do in `space/name`'s git: only a
 * landing's own merge job, while it runs, in its own repository, gets its
 * landing's slug, and with it a push to that landing's branch (git/http.ts).
 */
export async function landingJob(
  env: Env,
  secret: string,
  space: string,
  name: string,
): Promise<LandingJobAccess> {
  const job = await jobCaller(env, secret);
  if (!job)
    return {
      ok: false,
      status: 401,
      error: "This isn't a running CI job's credential (has the job ended?).",
    };
  const row = await db(env.DB)
    .selectFrom("ci_jobs as j")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .innerJoin("repos as p", "p.id", "j.repo_id")
    .innerJoin("spaces as o", "o.id", "p.space_id")
    .select([
      "j.spec",
      "p.id",
      "p.name",
      "o.slug as space",
      "p.artifacts_name",
      "p.artifacts_remote",
    ])
    .where("j.id", "=", job.jobId)
    .where("p.deleted_at", "is", null)
    .where("j.status", "=", "running")
    .where("r.status", "=", "running")
    .executeTakeFirst();
  const spec = row ? (JSON.parse(row.spec) as Partial<LandingJobSpec>) : null;
  const slug = spec?.landing?.slug;
  if (
    !row ||
    !slug ||
    !spec?.landing?.sourceId ||
    spec.landing.sourceId === "canonical" ||
    spec.landing.sourceId !== job.sourceId ||
    job.ref !== landingBranch(slug) ||
    landingSlugOf(landingBranch(slug)) !== slug ||
    job.jobName !== LANDING_JOB ||
    row.space !== space ||
    row.name !== name
  )
    return {
      ok: false,
      status: 403,
      error:
        "A CI job's credential reaches git only as a landing's merge job, in its own repository.",
    };
  return {
    ok: true,
    slug,
    sourceId: spec!.landing!.sourceId,
    repo: {
      id: row.id,
      artifacts_name: row.artifacts_name,
      artifacts_remote: row.artifacts_remote,
    },
  };
}
