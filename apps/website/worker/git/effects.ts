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
import { logPush, recordTimelineActivity } from "../timelines/activity.ts";
import { captureWorkAuthority, resolveWorkAuthority, type WorkAuthority } from "../ci/admission.ts";
import { indexPushedMentions } from "../mentions/index.ts";
import type { LoggedUpdate } from "../ref-log/record.ts";

export type PushedRepo = Pick<
  RepoRow,
  | "id"
  | "space_id"
  | "space_slug"
  | "name"
  | "default_branch"
  | "artifacts_name"
  | "artifacts_remote"
> & { source_id?: string };

/**
 * Knowledge, release notes, the mirror, the push log (and what it did to
 * timelines), CI for the branches that moved, and the repository's push time.
 */
export function afterPush(
  env: Env,
  repo: PushedRepo,
  actor: Pick<Actor, "id" | "agent" | "credential"> | null,
  waitUntil: (work: Promise<unknown>) => void,
): void {
  waitUntil(pushEffects(env, repo, actor, waitUntil, false));
}

async function pushEffects(
  env: Env,
  repo: PushedRepo,
  actor: Pick<Actor, "id" | "agent" | "credential"> | null,
  waitUntil: (work: Promise<unknown>) => void,
  strict: boolean,
  originalAuthority?: WorkAuthority,
  replayed?: LoggedUpdate[],
): Promise<void> {
  const authorization = originalAuthority ?? (await captureWorkAuthority(env, repo.id, actor));
  const current = await resolveWorkAuthority(env, authorization, repo.id);
  await invalidateRefs(env.DB, repo.artifacts_name);
  // Updates already in the push log (a replay): index their mentions here, as
  // recording them would have, under the replaying person's authority.
  if (replayed)
    waitUntil(
      indexPushedMentions(env, repo.id, authorization, replayed, {
        sourceId: repo.source_id ?? "canonical",
      }),
    );
  if (repo.source_id && repo.source_id !== "canonical") {
    // Work is an isolated source. Never wake canonical mirrors or observers.
    waitUntil(notifyKnowledge(env, repo.id, { authorization }));
    waitUntil(onPush(env, repo, current.actor, waitUntil));
    return;
  }
  waitUntil(notifyKnowledge(env, repo.id, { authorization }));
  const releaseNotes = notifyReleaseNotes(env, repo.id, authorization);
  waitUntil(
    strict
      ? releaseNotes
      : releaseNotes.catch((error) => console.error("Release notes: enqueue failed", error)),
  );
  const mirror = queueMirror(env, repo.id, current.actor);
  waitUntil(
    strict ? mirror : mirror.catch((error) => console.error("Mirror: enqueue failed", error)),
  );
  // The push log, then what the push did to timelines (merges, who worked in
  // them). A replay's updates are logged already, with no known pusher.
  waitUntil(
    replayed
      ? recordTimelineActivity(env, repo, null, replayed)
      : logPush(env, repo, current.actor),
  );
  waitUntil(
    onPush(env, repo, current.actor, waitUntil).catch((error) =>
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
  actor: Pick<Actor, "id" | "agent" | "credential"> | null,
  authority: WorkAuthority,
  replayed?: LoggedUpdate[],
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  await pushEffects(
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
    authority,
    replayed,
  );
  // onPush can register further work asynchronously. Drain it too, and wait for
  // every delivery even if an earlier one failed, before allowing outbox replay.
  while (pending.length) await Promise.all(pending.splice(0));
  if (errors.length) throw errors[0];
}

/**
 * Effects of updates the Space cutover's ref barrier logged with no known
 * pusher (space-cutover/ref-barrier.ts): like a queued push, but timeline
 * activity and mentions come from those journaled updates, not from a fresh
 * comparison that would find nothing left to log.
 */
export function afterReplayedPush(
  env: Env,
  repo: PushedRepo,
  actor: Pick<Actor, "id" | "agent" | "credential">,
  authority: WorkAuthority,
  replayed: LoggedUpdate[],
): Promise<void> {
  return afterQueuedPush(env, repo, actor, authority, replayed);
}
