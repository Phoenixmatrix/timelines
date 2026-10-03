// Which timeline a landing merge landed (CORE-72). Timelines land as real git
// merges into the default branch, but git doesn't remember which branch a
// merge's other parent was. What can be known without timeline records: the
// branch the merge message names, and the branches the push log (CORE-68)
// saw pointing at the merged commit.

import { mergedBranch } from "../../shared/landings.ts";
import type { LandedTimeline } from "../../shared/release-notes.ts";
import { db } from "../schema.ts";

/**
 * The timeline each landing merge landed, by merge commit id, from git and
 * the push log alone. A timeline branch the push log saw at the merged commit
 * wins, then one the message names, then any other branch.
 */
export async function landedTimelines(
  d1: D1Database,
  repoId: string,
  defaultBranch: string | null,
  merges: ArtifactsCommitMetadata[],
): Promise<Map<string, LandedTimeline>> {
  const tips = [...new Set(merges.flatMap((merge) => merge.parents.slice(1)))];
  const pushed = new Map<string, string[]>();
  const trunk = defaultBranch ? `refs/heads/${defaultBranch}` : null;
  for (let start = 0; start < tips.length; start += 90) {
    const rows = await db(d1)
      .selectFrom("ref_updates")
      .select(["ref", "new_oid"])
      .where("repo_id", "=", repoId)
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
  const result = new Map<string, LandedTimeline>();
  for (const merge of merges) {
    const seen = merge.parents.slice(1).flatMap((tip) => pushed.get(tip) ?? []);
    const named = mergedBranch(merge.message);
    const candidates = [...seen, ...(named ? [named] : [])];
    const branch =
      seen.find((name) => name.startsWith("timeline/")) ??
      (named?.startsWith("timeline/") ? named : null) ??
      candidates[0] ??
      null;
    // CORE-69 records timelines; until then there is no id to give.
    result.set(merge.hash, { id: null, branch, landing: merge.hash });
  }
  return result;
}
