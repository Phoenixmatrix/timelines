import type { LinkedIssue } from "../../shared/release-notes.ts";
import type { MutationResult } from "../../shared/tracker.ts";
import type { Actor } from "../db.ts";
import { db } from "../schema.ts";
import { findSpaceById, resolveSpaceAccess } from "../spaces/access.ts";
import { accessFor } from "../tracker/access.ts";
import { trackerObject } from "../tracker/stub.ts";

export interface TrackerSpaceRef {
  id: string;
  slug: string;
}

/** Discovery never grants access: only the repository's immutable Space may contribute. */
export async function issuesFrom(
  env: Env,
  spaces: TrackerSpaceRef[],
  repoId: string,
  keys: string[],
  actor: Actor | null,
): Promise<LinkedIssue[]> {
  if (!actor || !keys.length) return [];
  const repo = await db(env.DB)
    .selectFrom("repos")
    .select("space_id")
    .where("id", "=", repoId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!repo) return [];
  const issues: LinkedIssue[] = [];
  for (const candidate of spaces) {
    if (candidate.id !== repo.space_id || !(await resolveSpaceAccess(env.DB, actor, candidate.id)))
      continue;
    const space = await findSpaceById(env.DB, candidate.id);
    if (!space) continue;
    const access = await accessFor(
      env,
      space,
      actor.id,
      actor.agent?.id ?? null,
      false,
      actor.credential,
    );
    const stub = trackerObject(env, space.id);
    const subscribed = await stub.subscribedProjects(access, repoId);
    if (!subscribed.ok || !subscribed.value.length) continue;
    for (let start = 0; start < keys.length; start += 500) {
      const found = await stub.issuesByKey(access, keys.slice(start, start + 500));
      if (!found.ok) throw new Error(`Tracker lookup failed: ${found.error}`);
      for (const issue of found.value)
        issues.push({ ...issue, trackerSpace: space.slug, trackerSpaceId: space.id });
    }
  }
  return issues.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
}

/** Unsubscribed commit mentions still resolve, but never outside this Space. */
export async function repoIssues(
  env: Env,
  repo: { id: string; space_id: string },
  keys: string[],
  actor: Actor,
): Promise<LinkedIssue[]> {
  if (!keys.length || !(await resolveSpaceAccess(env.DB, actor, repo.space_id))) return [];
  const source = await db(env.DB)
    .selectFrom("repos")
    .select("id")
    .where("id", "=", repo.id)
    .where("space_id", "=", repo.space_id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!source) return [];
  const space = await findSpaceById(env.DB, repo.space_id);
  if (!space) return [];
  const access = await accessFor(
    env,
    space,
    actor.id,
    actor.agent?.id ?? null,
    false,
    actor.credential,
  );
  const stub = trackerObject(env, space.id);
  const issues: LinkedIssue[] = [];
  for (let start = 0; start < keys.length; start += 500) {
    const found = await stub.issuesByKey(access, keys.slice(start, start + 500));
    if (!found.ok) throw new Error(`Tracker lookup failed: ${found.error}`);
    for (const issue of found.value)
      issues.push({ ...issue, trackerSpace: space.slug, trackerSpaceId: space.id });
  }
  return issues.sort((a, b) => keys.indexOf(a.key) - keys.indexOf(b.key));
}

/** Keep the discovery mirror current without allowing cross-Space subscriptions. */
export async function affectedRepos(
  env: Env,
  spaceId: string,
  result: MutationResult,
  removedRepoIds: string[],
  actor: Actor,
): Promise<string[]> {
  const space = await findSpaceById(env.DB, spaceId);
  if (!space || !(await resolveSpaceAccess(env.DB, actor, spaceId))) return [];
  const access = await accessFor(
    env,
    space,
    actor.id,
    actor.agent?.id ?? null,
    false,
    actor.credential,
  );
  const repos = new Set(removedRepoIds);
  const keys = new Set<string>();
  const stub = trackerObject(env, spaceId);
  for (const event of result.events) {
    if (event.entityType === "issue" && event.entity && "key" in event.entity)
      keys.add(event.entity.key);
    if (event.entityType === "subscription" && event.entity && "repoId" in event.entity)
      repos.add(event.entity.repoId);
  }
  for (const repoId of repos) {
    const exists = await db(env.DB)
      .selectFrom("repos")
      .select("id")
      .where("id", "=", repoId)
      .where("space_id", "=", spaceId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!exists) {
      repos.delete(repoId);
      continue;
    }
    const subscribed = await stub.subscribedProjects(access, repoId);
    if (!subscribed.ok) throw new Error(subscribed.error);
    if (subscribed.value.length)
      await db(env.DB)
        .insertInto("tracker_repo_subscriptions")
        .values({ tracker_space_id: spaceId, repo_id: repoId })
        .onConflict((oc) => oc.doNothing())
        .execute();
    else
      await db(env.DB)
        .deleteFrom("tracker_repo_subscriptions")
        .where("tracker_space_id", "=", spaceId)
        .where("repo_id", "=", repoId)
        .execute();
  }
  if (keys.size) {
    const cited = await db(env.DB)
      .selectFrom("release_note_mentions as m")
      .innerJoin("repos as r", "r.id", "m.repo_id")
      .select("m.repo_id")
      .distinct()
      .where("r.space_id", "=", spaceId)
      .where("r.deleted_at", "is", null)
      .where("m.issue_key", "in", [...keys])
      .execute();
    for (const row of cited) repos.add(row.repo_id);
  }
  return [...repos];
}
