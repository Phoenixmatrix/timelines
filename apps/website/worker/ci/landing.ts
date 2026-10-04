// A landing's merge job (CORE-77, TIMELINES-RESEARCH.md "Landing"). The
// Worker can't run `git merge`, so the merge runs where git already runs: a
// CI job of Gitmatrix's own (not the repository's ci.yml) on the landing
// branch, which holds the checkpoint's commit. It fetches main, merges the
// checkpoint into the main commit the landing pinned, and pushes the merge
// back to the landing branch, where the repository's own pipeline then tests
// it before main moves (timelines/landing.ts).
//
// The landing credential is the job's own (gmj_…, for as long as the job
// runs). The job fetches and pushes through Gitmatrix's git proxy
// (git/http.ts), which takes that credential from a landing's merge job only,
// for its own repository, and lets it push to nothing but its landing branch
// (CORE-157): no Artifacts token reaches the sandbox. Every timeline
// repository belongs to the tracker's own account. The commands are these,
// never the repository's, and the Worker checks the merge's parents before
// testing it and moves main itself, with a compare-and-swap.

import { sql } from "kysely";
import { jobCaller } from "../deployments/job.ts";
import { PreviewModeError, productionOnly } from "../preview.ts";
import { batch, db } from "../schema.ts";
import type { StoredJob } from "./jobs.ts";
import { startWorkflow } from "./trigger.ts";
import { landingBranch, landingSlugOf } from "../../shared/timelines.ts";
import { QUEUE_MERGE_SCRIPT } from "./queue-script.ts";

/** The exit code the merge step ends with when the merge conflicts. */
export const CONFLICT_EXIT = 42;
/** The merge job's name in a landing's merge run. */
export const LANDING_JOB = "land";

/** What marks a job as a landing merge: only the Worker writes it into a spec. */
export interface LandingJobSpec extends StoredJob {
  landing: { slug: string };
}

export interface QueueMergeJobSpec extends StoredJob {
  queue: { id: string; attempt: number };
}

/** The merge step: POSIX shell under `bash -eo pipefail`, like every step. */
export const MERGE_SCRIPT = String.raw`# Through Gitmatrix's git proxy, with the job's own credential: it reads this
# repository and pushes only to this landing's branch.
remote="$GITMATRIX_URL/$GITMATRIX_REPOSITORY.git"
export GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader
export GIT_CONFIG_VALUE_0="Authorization: Bearer $GITMATRIX_TOKEN"
deepen=""
if [ -f "$(git rev-parse --git-dir)/shallow" ]; then deepen=--unshallow; fi
git fetch --quiet $deepen "$remote" "+refs/heads/$GITMATRIX_LANDING_MAIN:refs/remotes/landing/main"
if ! git cat-file -e "$GITMATRIX_LANDING_BASE^{commit}"; then
  echo "Main's commit $GITMATRIX_LANDING_BASE is gone (was main rewritten?). Land again."
  exit 1
fi
git checkout --quiet -B gitmatrix-landing "$GITMATRIX_LANDING_BASE"
if ! git -c user.name="$GITMATRIX_LANDING_NAME" -c user.email="$GITMATRIX_LANDING_EMAIL" \
  merge --no-ff --no-edit -m "$GITMATRIX_LANDING_MESSAGE" "$GITMATRIX_COMMIT"; then
  echo
  echo "Merging the checkpoint into $GITMATRIX_LANDING_MAIN conflicts in:"
  git diff --name-only --diff-filter=U | sed 's/^/  /'
  git merge --abort || true
  exit ${CONFLICT_EXIT}
fi
git push --quiet --force "$remote" "HEAD:refs/heads/$GITMATRIX_LANDING_BRANCH"
echo "Merged as $(git rev-parse HEAD)."
`;

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
  } & (
    | { landingId: string; slug: string; queueId?: never; attempt?: never }
    | { queueId: string; attempt: number; landingId?: never; slug?: never }
  ),
): Promise<{ number: number }> {
  // CI_RUN is production's Workflow: a preview can't run the merge, so it can't land.
  if (!productionOnly(env, "workflow", `the merge run of ${options.queueId ?? options.landingId}`))
    throw new PreviewModeError("workflow", "Previews don't run CI, so nothing lands in one.");
  const kdb = db(env.DB);
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
      ...(options.queueId
        ? { GITMATRIX_QUEUE_ID: options.queueId, GITMATRIX_QUEUE_ATTEMPT: String(options.attempt) }
        : {}),
    },
    secrets: [],
    timeoutMinutes: 20,
    steps: [{ name: "Merge into main", run: options.queueId ? QUEUE_MERGE_SCRIPT : MERGE_SCRIPT }],
    concurrency: null,
    paths: [],
    ...(options.queueId
      ? { queue: { id: options.queueId, attempt: options.attempt } }
      : { landing: { slug: options.slug! } }),
  };
  // Named after the run, so recording it twice records it once.
  const jobId = `${options.runId}m`;
  await batch(env.DB, [
    kdb
      .insertInto("ci_runs")
      .columns([
        "id",
        "repo_id",
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
            eb(eb.fn.coalesce(eb.fn.max("number"), eb.lit(0)), "+", eb.lit(1)).as("number"),
            eb.val(options.commit).as("commit_oid"),
            eb.val(options.branch).as("ref"),
            eb.val("manual" as const).as("trigger"),
            eb.val(options.actor?.id ?? null).as("actor_id"),
            eb.val(options.actor?.agentId ?? null).as("agent_id"),
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
  // Its Workflow, once: another look may have started it already.
  if (row?.status === "queued")
    try {
      await startWorkflow(env, options.runId);
    } catch (error) {
      const started = await env.CI_RUN.get(options.runId).catch(() => null);
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
      repo: { id: string; artifacts_name: string; artifacts_remote: string };
    }
  | { ok: false; status: 401 | 403; error: string };

/**
 * What a job credential (gmj_…) may do in `owner/name`'s git: only a
 * landing's own merge job, while it runs, in its own repository, gets its
 * landing's slug, and with it a push to that landing's branch (git/http.ts).
 */
export async function landingJob(
  d1: D1Database,
  secret: string,
  owner: string,
  name: string,
): Promise<LandingJobAccess> {
  const job = await jobCaller(d1, secret);
  if (!job)
    return {
      ok: false,
      status: 401,
      error: "This isn't a running CI job's credential (has the job ended?).",
    };
  const row = await db(d1)
    .selectFrom("ci_jobs as j")
    .innerJoin("repos as p", "p.id", "j.repo_id")
    .innerJoin("accounts as o", "o.id", "p.owner_id")
    .select([
      "j.spec",
      "p.id",
      "p.name",
      "o.slug as owner",
      "p.artifacts_name",
      "p.artifacts_remote",
    ])
    .where("j.id", "=", job.jobId)
    .executeTakeFirst();
  const spec = row ? (JSON.parse(row.spec) as Partial<LandingJobSpec>) : null;
  const slug = spec?.landing?.slug;
  if (
    !row ||
    !slug ||
    landingSlugOf(landingBranch(slug)) !== slug ||
    job.jobName !== LANDING_JOB ||
    row.owner !== owner ||
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
    repo: {
      id: row.id,
      artifacts_name: row.artifacts_name,
      artifacts_remote: row.artifacts_remote,
    },
  };
}
