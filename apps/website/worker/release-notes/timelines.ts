// Which timeline a landing merge landed (CORE-72). Timelines land as real git
// merges into the default branch, but git doesn't remember which branch a
// merge's other parent was. The branch comes from the push log (CORE-68),
// which saw branches pointing at the merged commit, or the merge message; a
// `timeline/<slug>` branch then names the timeline record (CORE-69) in the
// tracker of the repository's immutable Space.

import { mergedBranch } from "../../shared/landings.ts";
import type { LandedTimeline } from "../../shared/release-notes.ts";
import { db } from "../schema.ts";
import { trackerObject } from "../tracker/stub.ts";
import type { Actor } from "../db.ts";
import { findSpaceById, resolveSpaceAccess } from "../spaces/access.ts";
import { accessFor } from "../tracker/access.ts";

/** Looks up timeline ids by slug; slugs without a record are left out. */
export type TimelineIds = (slugs: string[]) => Promise<Map<string, string>>;

/** Timeline ids from the repository's Space, authorized independently of repository access. */
export function spaceTimelines(env: Env, spaceId: string, actor: Actor | null): TimelineIds {
  return async (slugs) => {
    if (!actor || !(await resolveSpaceAccess(env.DB, actor, spaceId))) return new Map();
    const space = await findSpaceById(env.DB, spaceId);
    if (!space) return new Map();
    const access = await accessFor(
      env,
      space,
      actor.id,
      actor.agent?.id ?? null,
      false,
      actor.credential,
    );
    const result = await trackerObject(env, spaceId).listTimelines(access);
    if (!result.ok) return new Map();
    return new Map(
      result.value
        .filter((timeline) => slugs.includes(timeline.slug))
        .map((timeline) => [timeline.slug, timeline.id]),
    );
  };
}

/**
 * The timeline each landing merge landed, by merge commit id, from git and
 * the push log. A timeline branch the push log saw at the merged commit wins,
 * then one the message names, then any other branch. `timelineIds` names the
 * records of `timeline/<slug>` branches.
 */
export async function landedTimelines(
  d1: D1Database,
  repoId: string,
  defaultBranch: string | null,
  merges: ArtifactsCommitMetadata[],
  timelineIds?: TimelineIds,
): Promise<Map<string, LandedTimeline>> {
  const tips = [...new Set(merges.flatMap((merge) => merge.parents.slice(1)))];
  const pushed = new Map<string, string[]>();
  const trunk = defaultBranch ? `refs/heads/${defaultBranch}` : null;
  for (let start = 0; start < tips.length; start += 90) {
    const rows = await db(d1)
      .selectFrom("ref_updates")
      .select(["ref", "new_oid"])
      .where("repo_id", "=", repoId)
      .where("source_id", "=", "canonical")
      .where("new_oid", "in", tips.slice(start, start + 90))
      .where("ref", "like", "refs/heads/%")
      .orderBy("id", "desc")
      .execute();
    for (const row of rows) {
      if (row.ref === trunk || !row.new_oid) continue;
      const branches = pushed.get(row.new_oid) ?? [];
      const branch = row.ref.slice("refs/heads/".length);
      if (!branches.includes(branch)) pushed.set(row.new_oid, [...branches, branch]);
    }
  }
  const branches = new Map<string, string | null>();
  for (const merge of merges) {
    const seen = merge.parents.slice(1).flatMap((tip) => pushed.get(tip) ?? []);
    const named = mergedBranch(merge.message);
    const candidates = [...seen, ...(named ? [named] : [])];
    const branch =
      seen.find((name) => name.startsWith("timeline/")) ??
      (named?.startsWith("timeline/") ? named : null) ??
      candidates[0] ??
      null;
    branches.set(merge.hash, branch);
  }
  const slugs = [...new Set(branches.values())].flatMap((branch) =>
    branch?.startsWith("timeline/") ? [branch.slice("timeline/".length)] : [],
  );
  const ids = slugs.length && timelineIds ? await timelineIds(slugs) : new Map<string, string>();
  const result = new Map<string, LandedTimeline>();
  for (const [landing, branch] of branches) {
    const slug = branch?.startsWith("timeline/") ? branch.slice("timeline/".length) : null;
    result.set(landing, { id: (slug && ids.get(slug)) ?? null, branch, landing });
  }
  return result;
}
