import { SYSTEM_ACTOR } from "../core/auth/system.ts";
import { repoObject, Services } from "../core/context.ts";
import { compactBlob, sweepCompactions } from "../core/blob-compaction.ts";
import { collectGarbage } from "./gc.ts";
import { applyRetention } from "./retention.ts";

export type Job =
  | { type: "gc" }
  | { type: "retention" }
  | { type: "rebuild"; repoId: string }
  | { type: "compact-sweep" }
  | { type: "compact"; id: string };

function systemServices(env: Env): Services {
  return new Services(
    env,
    new Request(`${Reflect.get(env, "PUBLIC_URL") || "http://localhost"}/jobs`),
    () => undefined,
    `job-${crypto.randomUUID()}`,
    SYSTEM_ACTOR,
  );
}

export async function runJob(env: Env, job: Job): Promise<void> {
  switch (job.type) {
    case "compact-sweep":
      await sweepCompactions(systemServices(env));
      return;
    case "compact":
      await compactBlob(systemServices(env), job.id);
      return;
    case "gc":
      await collectGarbage(systemServices(env));
      return;
    case "retention":
      await applyRetention(systemServices(env));
      return;
    case "rebuild":
      await repoObject(env, job.repoId).rebuildNow(job.repoId);
      return;
  }
}

export async function scheduleSweeps(env: Env): Promise<void> {
  // Retention first: the versions it prunes free blobs for a later GC pass.
  await env.REGISTRY_JOBS.send({ type: "retention" });
  await env.REGISTRY_JOBS.send({ type: "gc" });
  await env.REGISTRY_JOBS.send({ type: "compact-sweep" });
}
