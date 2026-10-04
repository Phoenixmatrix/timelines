// Step runs (CORE-235): when one finishes, its results become an artifact of
// the step, by commit. Called from the CI run's Workflow; safe to repeat.

import type { StepJobResult, StepTestSummary } from "../../shared/steps.ts";
import { db, nowIso } from "../schema.ts";

const JOB_STATUSES = new Set(["succeeded", "failed", "cancelled", "skipped"]);

/** Record a finished step run's test summary. Not a step run: nothing. */
export async function recordStepRun(d1: D1Database, runId: string): Promise<boolean> {
  const kdb = db(d1);
  const run = await kdb
    .selectFrom("ci_runs")
    .select(["repo_id", "commit_oid", "status", "step"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run?.step) return false;
  if (run.status !== "succeeded" && run.status !== "failed" && run.status !== "cancelled")
    return false;
  const rows = await kdb
    .selectFrom("ci_jobs")
    .select(["name", "status", "exit_code", "started_at", "finished_at"])
    .where("run_id", "=", runId)
    .orderBy("name")
    .execute();
  const jobs: StepJobResult[] = rows
    // Jobs that aren't step jobs were never part of this run.
    .filter((job) => JOB_STATUSES.has(job.status) && !(job.status === "skipped" && !job.started_at))
    .map((job) => ({
      name: job.name,
      status: job.status as StepJobResult["status"],
      exitCode: job.exit_code,
      durationMs:
        job.started_at && job.finished_at
          ? Math.max(0, Date.parse(job.finished_at) - Date.parse(job.started_at))
          : null,
    }));
  const summary: StepTestSummary = {
    status: run.status,
    passed: jobs.filter((job) => job.status === "succeeded").length,
    failed: jobs.filter((job) => job.status === "failed").length,
    jobs,
  };
  await kdb
    .insertInto("step_artifacts")
    .values({
      id: `${runId}:test-summary`,
      repo_id: run.repo_id,
      commit_oid: run.commit_oid,
      run_id: runId,
      kind: "test-summary",
      data: JSON.stringify(summary),
      object_key: null,
      created_at: nowIso(),
    })
    .onConflict((oc) => oc.column("id").doNothing())
    .execute();
  return true;
}
