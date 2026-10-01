// One CI run, as a Workflow. Jobs run in dependency stages; jobs in a stage
// run in parallel, and a job whose needs didn't all succeed is skipped.
//
// Where a job runs depends on CI_RUNNER:
//   sandbox  a step calls the job's CiSandbox Durable Object, which starts a
//            container, runs the steps, and returns when it is done.
//   local    the job is queued for `gm runner` on a developer's machine; the
//            Workflow sleeps in waitForEvent until the runner reports the end.
// Either way the job's state lives in D1, so the Workflow reads the outcome
// from there.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { CiJobStatus } from "../../shared/api.ts";
import { stages, type JobSpec } from "./config.ts";
import { doneEvent, type StoredJob } from "./jobs.ts";
import { sandbox } from "./sandbox.ts";
import type { RunParams } from "./trigger.ts";

interface PlannedJob {
  id: string;
  name: string;
  status: CiJobStatus;
  runner: "local" | "sandbox";
  needs: string[];
  timeoutMinutes: number;
}

const DB_STEP = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } } as const;
/** How long a local job may wait for a runner, on top of its own timeout. */
const QUEUE_GRACE_MINUTES = 60;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export class CiRun extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
    const { runId } = event.payload;
    const db = this.env.DB;

    const jobs = await step.do("plan", DB_STEP, async () => {
      await db
        .prepare(
          `UPDATE ci_runs SET status = 'running', started_at = ${now} WHERE id = ? AND status = 'queued'`,
        )
        .bind(runId)
        .run();
      const { results } = await db
        .prepare("SELECT id, name, status, runner, spec FROM ci_jobs WHERE run_id = ?")
        .bind(runId)
        .all<{
          id: string;
          name: string;
          status: CiJobStatus;
          runner: "local" | "sandbox";
          spec: string;
        }>();
      return results.map((row): PlannedJob => {
        const spec = JSON.parse(row.spec) as StoredJob;
        return {
          id: row.id,
          name: row.name,
          status: row.status,
          runner: row.runner,
          needs: spec.needs,
          timeoutMinutes: spec.timeoutMinutes,
        };
      });
    });

    const outcome = new Map<string, CiJobStatus>();
    const byName = new Map(jobs.map((j) => [j.name, j]));
    for (const stage of stages(jobs.map((j) => ({ name: j.name, needs: j.needs }) as JobSpec))) {
      await Promise.all(
        stage.map(async ({ name }) => {
          const job = byName.get(name)!;
          outcome.set(name, await this.#job(step, runId, job, outcome));
        }),
      );
    }

    await step.do("finish", DB_STEP, async () => {
      const statuses = [...outcome.values()];
      const run = await db
        .prepare("SELECT status FROM ci_runs WHERE id = ?")
        .bind(runId)
        .first<string>("status");
      const status =
        run === "cancelled" || statuses.includes("cancelled")
          ? "cancelled"
          : statuses.includes("failed")
            ? "failed"
            : "succeeded";
      await db
        .prepare(
          `UPDATE ci_runs SET status = ?, finished_at = ${now} WHERE id = ? AND status IN ('queued', 'running')`,
        )
        .bind(status, runId)
        .run();
      return status;
    });
  }

  async #job(
    step: WorkflowStep,
    runId: string,
    job: PlannedJob,
    outcome: Map<string, CiJobStatus>,
  ): Promise<CiJobStatus> {
    const db = this.env.DB;
    if (job.status !== "pending") return job.status;

    // Like GitHub Actions: a job runs only when everything it needs succeeded.
    const blocked = job.needs.find((need) => outcome.get(need) !== "succeeded");
    const start = await step.do(`start:${job.name}`, DB_STEP, async () => {
      const run = await db
        .prepare("SELECT status FROM ci_runs WHERE id = ?")
        .bind(runId)
        .first<string>("status");
      if (run === "cancelled") return "cancelled" as const;
      if (blocked) {
        await db.batch([
          db
            .prepare(
              `UPDATE ci_jobs SET status = 'skipped', error = ?, finished_at = ${now} WHERE id = ?`,
            )
            .bind(`Skipped because ${blocked} did not succeed.`, job.id),
          db
            .prepare(
              "UPDATE ci_steps SET status = 'skipped' WHERE job_id = ? AND status = 'pending'",
            )
            .bind(job.id),
        ]);
        return "skipped" as const;
      }
      await db
        .prepare("UPDATE ci_jobs SET status = 'queued' WHERE id = ? AND status = 'pending'")
        .bind(job.id)
        .run();
      return "queued" as const;
    });
    if (start !== "queued") return start;

    try {
      if (job.runner === "sandbox") {
        await step.do(
          `run:${job.name}`,
          // A retry would re-run the job's commands; only infrastructure
          // failures throw here, so try once more and no more.
          {
            retries: { limit: 1, delay: "10 seconds" },
            timeout: `${job.timeoutMinutes + 10} minutes`,
          },
          async () => {
            await sandbox(this.env, job.id).run(job.id);
          },
        );
      } else {
        await step.waitForEvent(`wait:${job.name}`, {
          type: doneEvent(job.name),
          timeout: `${job.timeoutMinutes + QUEUE_GRACE_MINUTES} minutes`,
        });
      }
    } catch (error) {
      const message =
        job.runner === "local"
          ? "No runner finished this job in time. Start one with `gm runner`."
          : `The sandbox failed: ${error instanceof Error ? error.message : String(error)}`;
      await step.do(`fail:${job.name}`, DB_STEP, async () => {
        await db
          .prepare(
            `UPDATE ci_jobs SET status = 'failed', error = ?, finished_at = ${now}
             WHERE id = ? AND status IN ('pending', 'queued', 'running')`,
          )
          .bind(message, job.id)
          .run();
      });
    }

    return step.do(`result:${job.name}`, DB_STEP, async () => {
      const status = await db
        .prepare("SELECT status FROM ci_jobs WHERE id = ?")
        .bind(job.id)
        .first<CiJobStatus>("status");
      return status ?? "failed";
    });
  }
}
