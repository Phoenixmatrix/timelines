// One CI run, as a Workflow. Jobs run in dependency stages; jobs in a stage
// run in parallel, and a job whose needs didn't all succeed is skipped.
//
// Where a job runs depends on CI_RUNNER:
//   sandbox  a step calls the job's CiSandbox Durable Object, which starts a
//            container, runs the steps, and returns when it is done.
//   local    the job is queued for `gm runner` on a developer's machine; the
//            Workflow sleeps in waitForEvent until the runner reports the end.
//            Under `vp dev` a runner starts for it on demand (CI_DISPATCH_URL,
//            vite/ci-runners.ts), like a Sandbox would.
// Either way the job's state lives in D1, so the Workflow reads the outcome
// from there.

import { QUIET_RELEASE } from "./workflow-events.ts";
import { recordStepRun } from "../steps/runs.ts";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { sql } from "kysely";
import type { CiJobStatus, CiJobVerification } from "../../shared/api.ts";
import { batch, db, nowIso } from "../schema.ts";
import { releaseHeld, UNCHANGED } from "./coalesce.ts";
import { concurrencyGate } from "./concurrency.ts";
import { stages, type JobSpec } from "./config.ts";
import { doneEvent, failDispatch, type StoredJob } from "./jobs.ts";
import { sandbox } from "./sandbox.ts";
import { startWorkflow, type RunParams } from "./trigger.ts";
import { afterRun, settled } from "../timelines/landing.ts";
import { afterQueueRun } from "../merge-queue/index.ts";
import { prerequisitesSatisfied } from "./verification.ts";

interface PlannedJob {
  id: string;
  name: string;
  status: CiJobStatus;
  runner: "local" | "sandbox";
  needs: string[];
  timeoutMinutes: number;
  concurrency: string | null;
  /** Skipped because its paths match the last commit it passed: it counts as passed. */
  unchanged: boolean;
  /** A proposal to check at consumption, never an admission decision. */
  verification: boolean;
}

type JobOutcome = CiJobStatus | "verified";

const DB_STEP = { retries: { limit: 5, delay: "2 seconds", backoff: "exponential" } } as const;
/** How long a local job may wait for a runner, on top of its own timeout. */
const QUEUE_GRACE_MINUTES = 60;
/** How often a job waiting for its concurrency group checks again, and for how long. */
const GATE_INTERVAL = "20 seconds";
const GATE_CHECKS = 360;

/**
 * Ask the development server to start a runner (best effort: a runner that is
 * already polling, or `gm runner` by hand, takes the job just the same).
 */
async function dispatchLocalRunner(env: Env): Promise<void> {
  const url = Reflect.get(env, "CI_DISPATCH_URL");
  if (typeof url !== "string" || !url) return;
  try {
    const secret = Reflect.get(env, "CI_DISPATCH_SECRET");
    const response = await fetch(url, {
      method: "POST",
      ...(typeof secret === "string" && secret
        ? { headers: { authorization: `Bearer ${secret}` } }
        : {}),
    });
    if (!response.ok) console.warn(`CI: runner dispatcher returned ${response.status}`);
  } catch (error) {
    console.warn("CI: couldn't reach the runner dispatcher", error);
  }
}

export class CiRun extends WorkflowEntrypoint<Env, RunParams> {
  async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep) {
    const { runId } = event.payload;
    const kdb = db(this.env.DB);

    // A timeline's push run waits out its quiet period (CORE-238): a newer
    // push covers it meanwhile, a checkpoint releases it at once.
    const quietUntil = await step.do("quiet period", DB_STEP, async () => {
      const row = await kdb
        .selectFrom("ci_runs")
        .select("quiet_until")
        .where("id", "=", runId)
        .executeTakeFirst();
      return row?.quiet_until ?? null;
    });
    if (quietUntil) {
      const seconds = Math.ceil((Date.parse(quietUntil) - event.timestamp.getTime()) / 1000);
      if (seconds > 0) {
        try {
          await step.waitForEvent("quiet", {
            type: QUIET_RELEASE,
            timeout: `${seconds} seconds` as WorkflowSleepDuration,
          });
        } catch {
          // The quiet period passed with no newer push: run.
        }
      }
      const still = await step.do("after the quiet period", DB_STEP, async () => {
        const row = await kdb
          .selectFrom("ci_runs")
          .select("status")
          .where("id", "=", runId)
          .executeTakeFirst();
        return row?.status === "queued";
      });
      if (!still) return;
    }

    const jobs = await step.do("plan", DB_STEP, async () => {
      await kdb
        .updateTable("ci_runs")
        .set({ status: "running", started_at: nowIso() })
        .where("id", "=", runId)
        .where("status", "=", "queued")
        .execute();
      const results = await kdb
        .selectFrom("ci_jobs")
        .select(["id", "name", "status", "runner", "spec", "error", "verified_by"])
        .where("run_id", "=", runId)
        .execute();
      return results.map((row): PlannedJob => {
        const spec = JSON.parse(row.spec) as StoredJob;
        return {
          id: row.id,
          name: row.name,
          status: row.status,
          runner: row.runner as PlannedJob["runner"],
          needs: spec.needs,
          timeoutMinutes: spec.timeoutMinutes,
          concurrency: spec.concurrency ?? null,
          unchanged: row.status === "skipped" && (row.error ?? "").startsWith(UNCHANGED),
          verification: row.verified_by !== null,
        };
      });
    });

    const outcome = new Map<string, JobOutcome>();
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
      const run = (
        await kdb.selectFrom("ci_runs").select("status").where("id", "=", runId).executeTakeFirst()
      )?.status;
      const status =
        run === "cancelled" || statuses.includes("cancelled")
          ? "cancelled"
          : statuses.includes("failed")
            ? "failed"
            : "succeeded";
      await kdb
        .updateTable("ci_runs")
        .set({ status, finished_at: nowIso() })
        .where("id", "=", runId)
        .where("status", "in", ["queued", "running"])
        .execute();
      return status;
    });

    // A step run's results attach to its step (CORE-235).
    await step.do("step-artifacts", DB_STEP, async () => recordStepRun(this.env.DB, runId));

    // A slot on the branch is free: the newest held run starts, covering older ones.
    await step.do("release", DB_STEP, async () => {
      const run = await kdb
        .selectFrom("ci_runs")
        .select(["repo_id", "source_id", "ref"])
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
      return releaseHeld(
        this.env.DB,
        run.repo_id,
        run.ref,
        (id) => startWorkflow(this.env, id),
        run.source_id,
      );
    });

    // A landing's merge or gates move the landing on; a timeline's own run may
    // make its checkpoint green (CORE-77). Never throws.
    await step.do("landing", DB_STEP, async () => {
      await settled(this.env, (deps) => afterRun(this.env, deps, runId));
    });
    await step.do("merge-queue", DB_STEP, async () => {
      const run = await kdb
        .selectFrom("ci_runs")
        .select("repo_id")
        .where("id", "=", runId)
        .executeTakeFirstOrThrow();
      const work: Promise<unknown>[] = [];
      await afterQueueRun(this.env, run.repo_id, runId, (promise) => work.push(promise));
      while (work.length) await Promise.allSettled(work.splice(0));
    });
  }

  /**
   * A job in a concurrency group (deploys, say) runs one at a time per repository.
   * While it waits, a newer run on the same branch that will run (or ran) its own
   * job in the group supersedes it: the newer one covers this one's work.
   */
  async #gate(step: WorkflowStep, runId: string, job: PlannedJob): Promise<"go" | CiJobStatus> {
    const d1 = this.env.DB;
    const kdb = db(d1);
    const group = job.concurrency!;
    for (let check = 0; ; check++) {
      const verdict = await step.do(`gate:${job.name}:${check}`, DB_STEP, () =>
        concurrencyGate(d1, runId, job.id, group),
      );
      if (verdict.kind === "go") return "go";
      if (verdict.kind === "cancelled") return "cancelled";
      if (verdict.kind === "superseded" || check >= GATE_CHECKS) {
        const error =
          verdict.kind === "superseded"
            ? `Superseded by run #${verdict.by}, which covers a newer commit.`
            : `Waited too long for another ${group} job to finish.`;
        const status = verdict.kind === "superseded" ? ("skipped" as const) : ("failed" as const);
        await step.do(`gate:${job.name}:end`, DB_STEP, async () => {
          await batch(d1, [
            kdb
              .updateTable("ci_jobs")
              .set({ status, error, finished_at: nowIso() })
              .where("id", "=", job.id)
              .where("status", "in", ["pending", "queued"]),
            kdb
              .updateTable("ci_steps")
              .set({ status: "skipped" })
              .where("job_id", "=", job.id)
              .where("status", "=", "pending"),
          ]);
        });
        return status;
      }
      await step.sleep(`gate:${job.name}:${check}:wait`, GATE_INTERVAL);
    }
  }

  async #job(
    step: WorkflowStep,
    runId: string,
    job: PlannedJob,
    outcome: Map<string, JobOutcome>,
  ): Promise<JobOutcome> {
    const d1 = this.env.DB;
    const kdb = db(d1);
    // The plan is durable, but it must never cache proof admission. This step is
    // the gate's consumption point: once committed, replay preserves that result
    // just as it preserves a completed sandbox execution across later deployments.
    const admission = job.verification
      ? await step.do(`verification:${job.name}`, DB_STEP, async () => {
          const row = await kdb
            .selectFrom("ci_jobs")
            .select(["status", "verified_by"])
            .where("id", "=", job.id)
            .executeTakeFirstOrThrow();
          if (!row.verified_by) {
            if (row.status === "skipped" && job.unchanged) return "succeeded" as const;
            return ["pending", "queued", "running"].includes(row.status) ? null : row.status;
          }
          if (row.status === "skipped") return "verified" as const;
          const run = await kdb
            .selectFrom("ci_runs")
            .select("status")
            .where("id", "=", runId)
            .executeTakeFirstOrThrow();
          const blocked = job.needs.find((need) => !prerequisitesSatisfied([need], outcome));
          const cancelled = run.status === "cancelled" || row.status === "cancelled";
          let identity: string | null = null;
          if (!blocked && !cancelled && row.status === "pending") {
            try {
              identity = await sandbox(this.env, job.id).verificationIdentity();
            } catch {
              // Unknown identity executes normally; it is not evidence of equivalence.
            }
          }
          const proof = JSON.parse(row.verified_by) as CiJobVerification;
          const accepted = identity !== null && identity === proof.executionIdentity;
          const status = cancelled ? "cancelled" : blocked || accepted ? "skipped" : "pending";
          await batch(d1, [
            kdb
              .updateTable("ci_jobs")
              .set({
                status,
                verified_by: accepted ? row.verified_by : null,
                error: cancelled
                  ? "Cancelled before candidate verification was consumed."
                  : blocked
                    ? `Skipped because ${blocked} did not succeed.`
                    : null,
              })
              .where("id", "=", job.id)
              .where("status", "=", "pending")
              .where(
                "run_id",
                "in",
                kdb.selectFrom("ci_runs").select("id").where("status", "in", ["queued", "running"]),
              ),
            kdb
              .updateTable("ci_jobs")
              .set({
                status: "cancelled",
                verified_by: null,
                error: "Cancelled before candidate verification was consumed.",
              })
              .where("id", "=", job.id)
              .where("verified_by", "is not", null)
              .where((eb) =>
                eb.or([
                  eb("status", "=", "cancelled"),
                  eb(
                    "run_id",
                    "in",
                    eb.selectFrom("ci_runs").select("id").where("status", "=", "cancelled"),
                  ),
                ]),
              ),
            kdb
              .updateTable("ci_steps")
              .set({
                status: sql<"pending" | "skipped">`CASE WHEN EXISTS (
              SELECT 1 FROM ci_jobs WHERE id = ${job.id} AND status = 'pending'
            ) THEN 'pending' ELSE 'skipped' END`,
              })
              .where("job_id", "=", job.id),
          ]);
          const consumed = await kdb
            .selectFrom("ci_jobs")
            .select(["status", "verified_by"])
            .where("id", "=", job.id)
            .executeTakeFirstOrThrow();
          return consumed.status === "skipped" && consumed.verified_by
            ? ("verified" as const)
            : consumed.status === "pending"
              ? null
              : consumed.status;
        })
      : null;
    if (admission) return admission;
    // A job skipped as unchanged stands in for a pass, so what needs it still runs.
    if (job.status !== "pending") return job.unchanged ? "succeeded" : job.status;

    // Like GitHub Actions: a job runs only when everything it needs succeeded.
    const blocked = job.needs.find((need) => !prerequisitesSatisfied([need], outcome));
    const start = await step.do(`start:${job.name}`, DB_STEP, async () => {
      const run = (
        await kdb.selectFrom("ci_runs").select("status").where("id", "=", runId).executeTakeFirst()
      )?.status;
      if (run !== "queued" && run !== "running") return "cancelled" as const;
      if (blocked) {
        await batch(d1, [
          kdb
            .updateTable("ci_jobs")
            .set({
              status: "skipped",
              error: `Skipped because ${blocked} did not succeed.`,
              finished_at: nowIso(),
            })
            .where("id", "=", job.id),
          kdb
            .updateTable("ci_steps")
            .set({ status: "skipped" })
            .where("job_id", "=", job.id)
            .where("status", "=", "pending"),
        ]);
        return "skipped" as const;
      }
      await kdb
        .updateTable("ci_jobs")
        .set({ status: "queued" })
        .where("id", "=", job.id)
        .where("status", "=", "pending")
        .where(
          "run_id",
          "in",
          kdb.selectFrom("ci_runs").select("id").where("status", "in", ["queued", "running"]),
        )
        .execute();
      return "queued" as const;
    });
    if (start !== "queued") return start;
    if (job.concurrency) {
      const gated = await this.#gate(step, runId, job);
      if (gated !== "go") return gated;
    }
    if (job.runner === "local") {
      await step.do(`dispatch:${job.name}`, async () => {
        await dispatchLocalRunner(this.env);
      });
    }

    try {
      if (job.runner === "sandbox") {
        await step.do(
          `run:${job.name}`,
          // A retry would re-run the job's commands; only infrastructure
          // failures throw here, so try once more and no more.
          {
            // A deploy (this repo's, or anyone's to this Worker) restarts the Durable
            // Object mid-job; the job then starts over in a fresh sandbox. Allow a few.
            retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
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
          ? "No runner finished this job in time. Under `vp dev` runners start on their own; otherwise run `gm runner --once`."
          : `The sandbox failed: ${error instanceof Error ? error.message : String(error)}`;
      await step.do(`fail:${job.name}`, DB_STEP, async () => {
        await failDispatch(d1, job.id, message);
      });
      return "failed";
    }

    return step.do(`result:${job.name}`, DB_STEP, async () => {
      const row = await kdb
        .selectFrom("ci_jobs")
        .select("status")
        .where("id", "=", job.id)
        .executeTakeFirst();
      return row?.status ?? "failed";
    });
  }
}
