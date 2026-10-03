// What follows a change to a repository's refs: a push through the proxy
// (http.ts), or a ref the server moved itself, like a landing advancing main
// (timelines/landing.ts). Each runs after the response, and none throws.

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
  invalidateRefs(repo.artifacts_name);
  waitUntil(notifyKnowledge(env, repo.id));
  waitUntil(
    notifyReleaseNotes(env, repo.id).catch((error) =>
      console.error("Release notes: enqueue failed", error),
    ),
  );
  waitUntil(
    queueMirror(env, repo.id).catch((error) => console.error("Mirror: enqueue failed", error)),
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
