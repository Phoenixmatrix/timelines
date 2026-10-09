import type { Actor } from "../db.ts";
import type { PushedRepo } from "./effects.ts";
import { lsRefs } from "../artifacts.ts";
import { startRun } from "../ci/trigger.ts";
import { notifyKnowledge } from "../knowledge/coordinator.ts";
import { invalidateRefs } from "../objects.ts";
import { recordPush } from "../ref-log/record.ts";
import { db } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";
import { TrackerError } from "../tracker/store.ts";

/** CI delivery is an exact-operation obligation, not a moved-ref notification. */
export async function deliverRecoveredSourcePush(
  env: Env,
  repo: PushedRepo & { source_id: string },
  operationId: string,
  actor: Pick<Actor, "id" | "agent"> | null,
  waitUntil: (work: Promise<unknown>) => void,
) {
  const tracker = trackerObject(env, repo.owner_id);
  const kdb = db(env.DB);
  const operation = await tracker.sourcePush(operationId, repo.id, repo.source_id);
  if (!operation.ok) throw new TrackerError(operation.status, operation.code, operation.error);
  const runIds: Partial<Record<"push" | "step", string>> = {};
  if (!operation.value.delivery) {
    const head =
      operation.value.recovery?.head ??
      (operation.value.state === "accepted" ? operation.value.commands[0]?.new : null);
    if (head) {
      const existing = await kdb
        .selectFrom("ci_runs")
        .select(["id", "step"])
        .where("repo_id", "=", repo.id)
        .where("source_id", "=", repo.source_id)
        .where("ref", "=", "work")
        .where("commit_oid", "=", head)
        .where("preview_action", "is", null)
        .where("landing_id", "is", null)
        .where("queue_id", "is", null)
        .where((eb) =>
          eb.or([eb.and([eb("step", "=", 0), eb("trigger", "=", "push")]), eb("step", "=", 1)]),
        )
        .orderBy("number", "desc")
        .execute();
      for (const run of existing) runIds[run.step ? "step" : "push"] ??= run.id;
    }
  }
  const reserved = await tracker.reserveSourcePushDelivery(
    operationId,
    repo.id,
    repo.source_id,
    runIds,
  );
  if (!reserved.ok) throw new TrackerError(reserved.status, reserved.code, reserved.error);
  const delivery = reserved.value;

  // This audit always observes the live source, never rewinds it to the
  // historical obligation. The durable plan already exists if observation
  // succeeds but the process disappears before run creation.
  invalidateRefs(repo.artifacts_name);
  await recordPush(env, repo, actor);
  const previous = await kdb
    .selectFrom("ci_refs")
    .select("oid")
    .where("repo_id", "=", repo.id)
    .where("source_id", "=", repo.source_id)
    .where("ref", "=", "work")
    .executeTakeFirst();
  const head = (
    await lsRefs(env, repo.artifacts_name, repo.artifacts_remote, ["refs/heads/work"])
  ).find((ref) => ref.name === "refs/heads/work")?.oid;
  if (head === delivery.head) {
    // Do not overwrite a newer ordinary observer racing this observation.
    await kdb
      .insertInto("ci_refs")
      .values({ repo_id: repo.id, source_id: repo.source_id, ref: "work", oid: head })
      .onConflict((oc) =>
        previous
          ? oc
              .columns(["repo_id", "source_id", "ref"])
              .doUpdateSet({ oid: head })
              .where("ci_refs.oid", "=", previous.oid)
          : oc.columns(["repo_id", "source_id", "ref"]).doNothing(),
      )
      .execute();
  }
  for (const trigger of ["push", "step"] as const) {
    const run = delivery.runs[trigger];
    if (run.state !== "pending") continue;
    const result = await startRun(env, repo, {
      branch: "work",
      commit: delivery.head,
      trigger,
      actor,
      waitUntil,
      runId: run.id,
      sourceRecovery: true,
    });
    const completed = await tracker.completeSourcePushDelivery(
      operationId,
      trigger,
      run.id,
      result,
    );
    if (!completed.ok) throw new TrackerError(completed.status, completed.code, completed.error);
  }
  await notifyKnowledge(env, repo.id);
}
