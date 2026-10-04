// What follows a change to a repository's refs: a push through the proxy
// (http.ts), or a ref the server moved itself, like a landing advancing main
// (timelines/landing.ts). Direct pushes use best-effort background delivery;
// the merge queue awaits required deliveries before acknowledging its outbox.

import { onPush } from "../ci/trigger.ts";
import type { Actor, RepoRow } from "../db.ts";
import { sqlNow } from "../db.ts";
import { notifyKnowledge } from "../knowledge/coordinator.ts";
import { queueMirror } from "../mirror/queue.ts";
import { invalidateRefs } from "../objects.ts";
import { notifyReleaseNotes } from "../release-notes/queue.ts";
import { db } from "../schema.ts";
import { logPush } from "../timelines/activity.ts";

export type PushedRepo = Pick<
  RepoRow,
  | "id"
  | "owner_id"
  | "owner_slug"
  | "name"
  | "default_branch"
  | "artifacts_name"
  | "artifacts_remote"
>;

/**
 * Knowledge, release notes, the mirror, the push log (and what it did to
 * timelines), CI for the branches that moved, and the repository's push time.
 */
export function afterPush(
  env: Env,
  repo: PushedRepo,
  actor: Pick<Actor, "id" | "agent"> | null,
  waitUntil: (work: Promise<unknown>) => void,
): void {
  pushEffects(env, repo, actor, waitUntil, false);
}

function pushEffects(
  env: Env,
  repo: PushedRepo,
  actor: Pick<Actor, "id" | "agent"> | null,
  waitUntil: (work: Promise<unknown>) => void,
  strict: boolean,
): void {
  invalidateRefs(repo.artifacts_name);
  waitUntil(notifyKnowledge(env, repo.id));
  const releaseNotes = notifyReleaseNotes(env, repo.id);
  waitUntil(
    strict
      ? releaseNotes
      : releaseNotes.catch((error) => console.error("Release notes: enqueue failed", error)),
  );
  const mirror = queueMirror(env, repo.id);
  waitUntil(
    strict ? mirror : mirror.catch((error) => console.error("Mirror: enqueue failed", error)),
  );
  // The push log, then what the push did to timelines (merges, who worked in them).
  waitUntil(logPush(env, repo, actor));
  waitUntil(
    onPush(env, repo, actor, waitUntil).catch((error) =>
      console.error("CI: push trigger failed", error),
    ),
  );
  waitUntil(
    db(env.DB).updateTable("repos").set({ pushed_at: sqlNow }).where("id", "=", repo.id).execute(),
  );
}

/**
 * Queue delivery must reject failed enqueues, so the durable outbox retries.
 * Notifications coalesce at their consumers and mirror sync converges on refs.
 * CI delivery is owned separately by the persisted exact-candidate deployment.
 * Its best-effort moved-ref observer still maintains ci_refs and CI savings.
 * The observational push log remains best-effort, not guaranteed activity.
 */
export async function afterQueuedPush(
  env: Env,
  repo: PushedRepo,
  actor: Pick<Actor, "id" | "agent"> | null,
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  pushEffects(
    env,
    repo,
    actor,
    (work) => {
      pending.push(
        work.catch((error) => {
          errors.push(error);
        }),
      );
    },
    true,
  );
  // onPush can register further work asynchronously. Drain it too, and wait for
  // every delivery even if an earlier one failed, before allowing outbox replay.
  while (pending.length) await Promise.all(pending.splice(0));
  if (errors.length) throw errors[0];
}
