// Mirrors sync off the push path: a push enqueues its repository, the queue
// consumer syncs it, and failures retry with backoff. Duplicate messages are
// harmless: every sync converges on the repository's current refs.

import { productionOnly } from "../preview.ts";
import { db } from "../schema.ts";
import { MirrorError, syncMirror } from "./sync.ts";

export interface MirrorJob {
  type: "mirror";
  repoId: string;
}

/** After a push: enqueue a sync if the repository has an enabled mirror. */
export async function queueMirror(env: Env, repoId: string): Promise<void> {
  if (!productionOnly(env, "mirror", `a mirror sync of ${repoId}`)) return;
  const mirror = await db(env.DB)
    .selectFrom("repo_mirrors")
    .select("enabled")
    .where("repo_id", "=", repoId)
    .executeTakeFirst();
  if (!mirror?.enabled) return;
  await db(env.DB)
    .updateTable("repo_mirrors")
    .set({ status: "pending" })
    .where("repo_id", "=", repoId)
    .where("status", "!=", "syncing")
    .execute();
  await env.JOBS.send({ type: "mirror", repoId } satisfies MirrorJob);
}

/** Queue consumer for one message; retries busy and failed syncs with backoff. */
export async function runMirrorJob(env: Env, message: Message<MirrorJob>): Promise<void> {
  const backoff = Math.min(600, 15 * 2 ** Math.max(0, message.attempts - 1));
  try {
    const result = await syncMirror(env, message.body.repoId);
    if (result.status === "busy") message.retry({ delaySeconds: 10 });
    else message.ack();
  } catch (error) {
    console.error("Mirror sync failed", message.body.repoId, error);
    // A bad token or a missing target won't fix itself quickly; still retry
    // (the queue's maxRetries bounds it) so a transient outage heals.
    message.retry({ delaySeconds: error instanceof MirrorError ? backoff : 30 });
  }
}
