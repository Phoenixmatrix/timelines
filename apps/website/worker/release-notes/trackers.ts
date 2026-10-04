import type { LinkedIssue } from "../../shared/release-notes.ts";
import type { MutationResult } from "../../shared/tracker.ts";
import { db } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";

export interface TrackerOwnerRef {
  id: string;
  slug: string;
}

/**
 * Resolve issue keys through those of `owners` whose trackers subscribe a
 * workspace to the repository, in key order.
 */
export async function issuesFrom(
  env: Env,
  owners: TrackerOwnerRef[],
  repoId: string,
  keys: string[],
): Promise<LinkedIssue[]> {
  if (!keys.length) return [];
  const issues: LinkedIssue[] = [];
  for (const owner of owners) {
    const stub = trackerObject(env, owner.id);
    const subscribed = await stub.subscribedWorkspaces(repoId);
    if (!subscribed.ok || !subscribed.value.length) continue;
    // The tracker looks up at most 500 keys per call.
    for (let start = 0; start < keys.length; start += 500) {
      const found = await stub.issuesByKey(keys.slice(start, start + 500));
      if (!found.ok) throw new Error(`Tracker lookup failed: ${found.error}`);
      for (const issue of found.value)
        issues.push({ ...issue, trackerOwner: owner.slug, trackerOwnerId: owner.id });
    }
  }
  return issues.sort(
    (a, b) =>
      keys.indexOf(a.key) - keys.indexOf(b.key) || a.trackerOwner.localeCompare(b.trackerOwner),
  );
}

/**
 * Trackers that may subscribe to a repository, for work without an actor:
 * those recorded subscribing, and always the repository owner's.
 */
export async function subscribedOwners(
  env: Env,
  repo: { id: string; owner_id: string },
): Promise<TrackerOwnerRef[]> {
  const rows = await db(env.DB)
    .selectFrom("accounts")
    .select(["id", "slug"])
    .where((eb) =>
      eb.or([
        eb("id", "=", repo.owner_id),
        eb(
          "id",
          "in",
          eb
            .selectFrom("tracker_repo_subscriptions")
            .select("tracker_owner_id")
            .where("repo_id", "=", repo.id),
        ),
      ]),
    )
    .orderBy("slug")
    .execute();
  return rows;
}

/**
 * After a tracker mutation: keep the subscription mirror current and name
 * the repositories whose release notes it affects (newly (un)subscribed ones,
 * and those whose commits cite a changed issue).
 */
export async function affectedRepos(
  env: Env,
  ownerId: string,
  result: MutationResult,
  /** Repositories of removed subscriptions, looked up before they were deleted. */
  removedRepoIds: string[],
): Promise<string[]> {
  const repos = new Set<string>(removedRepoIds);
  const keys = new Set<string>();
  const stub = trackerObject(env, ownerId);
  for (const event of result.events) {
    if (event.entityType === "issue" && event.entity && "key" in event.entity)
      keys.add(event.entity.key);
    if (event.entityType === "subscription" && event.entity && "repoId" in event.entity)
      repos.add(event.entity.repoId);
  }
  for (const repoId of repos) {
    const subscribed = await stub.subscribedWorkspaces(repoId);
    if (!subscribed.ok) continue;
    const exists = await db(env.DB)
      .selectFrom("repos")
      .select("id")
      .where("id", "=", repoId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!exists) continue;
    if (subscribed.value.length)
      await db(env.DB)
        .insertInto("tracker_repo_subscriptions")
        .values({ tracker_owner_id: ownerId, repo_id: repoId })
        .onConflict((oc) => oc.doNothing())
        .execute();
    else
      await db(env.DB)
        .deleteFrom("tracker_repo_subscriptions")
        .where("tracker_owner_id", "=", ownerId)
        .where("repo_id", "=", repoId)
        .execute();
  }
  if (keys.size) {
    const cited = await db(env.DB)
      .selectFrom("release_note_mentions")
      .select("repo_id")
      .distinct()
      .where("issue_key", "in", [...keys])
      .execute();
    for (const row of cited) repos.add(row.repo_id);
  }
  return [...repos];
}
