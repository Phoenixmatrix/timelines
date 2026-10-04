// Cancelling a CI run: the API's `runs/:number/cancel` and repository
// deletion (CORE-199) share it. Runners notice on their next report and
// stop; the run's Workflow stops now.

import { batch, db, nowIso } from "../schema.ts";

/** Cancel undispatched work; running children acknowledge cancellation in report(). */
export async function cancelRun(env: Env, runId: string): Promise<void> {
  const kdb = db(env.DB);
  const now = nowIso();
  await batch(env.DB, [
    kdb
      .updateTable("ci_runs")
      .set({ status: "cancelled", finished_at: now })
      .where("id", "=", runId)
      .where("status", "in", ["queued", "running"]),
    kdb
      .updateTable("ci_jobs")
      .set({ status: "cancelled", finished_at: now })
      .where("run_id", "=", runId)
      .where("status", "in", ["pending", "queued"]),
    kdb
      .updateTable("ci_steps")
      .set({ status: "cancelled", finished_at: now })
      .where("job_id", "in", kdb.selectFrom("ci_jobs").select("id").where("run_id", "=", runId))
      .where("status", "in", ["pending", "running"]),
  ]);
  const workflow = Reflect.get(env, "CI_RUN") as Workflow | undefined;
  const instance = await workflow?.get(runId).catch(() => null);
  await instance?.terminate().catch(() => {});
}
