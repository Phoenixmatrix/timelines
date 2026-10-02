// Concurrency groups for CI jobs (jobs.<name>.concurrency in .gitmatrix/ci.yml):
// one job of a group runs at a time per repository, and a waiting one gives way
// to a newer run on its branch. Deploys use this, so a burst of pushes deploys
// once, from the newest commit, and deploys never overlap.

import { sql } from "kysely";
import { db, nowIso } from "../schema.ts";

export type GateVerdict =
  | { kind: "go" }
  | { kind: "wait" }
  | { kind: "cancelled" }
  | { kind: "superseded"; by: number };

/**
 * May a job in a concurrency group run now? Superseded when a newer run on the same
 * branch will run (or ran) its own job in the group; otherwise it takes the group's
 * single slot for the repository, or waits while another job holds it.
 */
export async function concurrencyGate(
  d1: D1Database,
  runId: string,
  jobId: string,
  group: string,
): Promise<GateVerdict> {
  const kdb = db(d1);
  const me = await kdb
    .selectFrom("ci_runs")
    .select(["repo_id", "ref", "number", "status"])
    .where("id", "=", runId)
    .executeTakeFirstOrThrow();
  if (me.status === "cancelled") return { kind: "cancelled" };
  const newer = await kdb
    .selectFrom("ci_jobs as j")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .select("r.number")
    .where("r.repo_id", "=", me.repo_id)
    .where("r.ref", "=", me.ref)
    .where("r.number", ">", me.number)
    .where(sql<string>`json_extract(j.spec, '$.concurrency')`, "=", group)
    .where("j.status", "in", ["pending", "queued", "running", "succeeded"])
    .orderBy("r.number", "desc")
    .executeTakeFirst();
  if (newer) return { kind: "superseded", by: newer.number };
  // Take the slot only if no other job in the group holds it: one statement, so two
  // runs checking at once can't both win.
  const { numUpdatedRows } = await kdb
    .updateTable("ci_jobs")
    .set({ concurrency_claimed_at: nowIso() })
    .where("id", "=", jobId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("ci_jobs as o")
            .select("o.id")
            .where("o.repo_id", "=", me.repo_id)
            .where("o.id", "<>", jobId)
            .where(sql<string>`json_extract(o.spec, '$.concurrency')`, "=", group)
            .where("o.concurrency_claimed_at", "is not", null)
            .where("o.status", "in", ["queued", "running"]),
        ),
      ),
    )
    .executeTakeFirst();
  return { kind: numUpdatedRows ? "go" : "wait" };
}
