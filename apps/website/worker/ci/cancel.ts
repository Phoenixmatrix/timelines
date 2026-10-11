// Cancelling a CI run: the API's `runs/:number/cancel` and repository
// deletion (CORE-199) share it. Runners notice on their next report and
// stop; the run's Workflow stops now.

import { batch, db, nowIso } from "../schema.ts";

/** Cancel undispatched or confirmed-stopped work; live children acknowledge in report(). */
export async function cancelRun(env: Env, runId: string): Promise<void> {
  const kdb = db(env.DB);
  const now = nowIso();
  // Ambiguous queued retries retain active-attempt evidence. Only a confirmed
  // Sandbox shutdown clears it; Workflow termination alone never acknowledges it.
  const unstarted = kdb
    .selectFrom("ci_jobs")
    .select("id")
    .where("run_id", "=", runId)
    .where("status", "in", ["pending", "queued"])
    .where("claimed_by", "is", null)
    .where("started_at", "is", null)
    .where("source_completion_pending", "=", 0);
  await batch(env.DB, [
    kdb
      .updateTable("ci_runs")
      .set({ status: "cancelled", finished_at: now })
      .where("id", "=", runId)
      .where("status", "in", ["queued", "running"]),
    kdb
      .updateTable("ci_steps")
      .set({ status: "cancelled", finished_at: now })
      .where("job_id", "in", unstarted)
      .where("status", "=", "pending"),
    kdb
      .updateTable("ci_jobs")
      .set({ status: "cancelled", finished_at: now })
      .where("id", "in", unstarted),
  ]);
  const workflow = Reflect.get(env, "CI_RUN") as Workflow | undefined;
  const instance = await workflow?.get(runId).catch(() => null);
  await instance?.terminate().catch(() => {});
}
