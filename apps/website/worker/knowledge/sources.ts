import { listRefs } from "../artifacts.ts";
import { selectRepos } from "../db.ts";
import { db } from "../schema.ts";
import { resolveSource } from "../timelines/sources.ts";

/** Logical timeline labels remain stable after its physical work ref is archived. */
export const knowledgeTimelineRef = (slug: string) => `refs/heads/timeline/${slug}`;

export async function knowledgeRepo(env: Env, repoId: string, sourceId = "canonical") {
  const canonical = await selectRepos(env.DB, "").where("r.id", "=", repoId).executeTakeFirst();
  if (!canonical) return null;
  const resolved = await resolveSource(env, canonical, sourceId);
  return { ...resolved.repo, full_name: `${canonical.space_slug}/${canonical.name}` };
}

/** Only owned ready sources schedule work. Never rediscover legacy canonical bookmarks. */
export async function liveTimelineSources(env: Env, repoId: string) {
  const rows = await db(env.DB)
    .selectFrom("timeline_work_sources")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("state", "=", "ready")
    .execute();
  const tips = new Map<string, { sourceId: string; commit: string }>();
  for (const source of rows) {
    const repo = await knowledgeRepo(env, repoId, source.source_id);
    if (!repo) continue;
    const refs = await listRefs(env, repo.artifacts_name, repo.artifacts_remote);
    const commit = refs.branches.find((ref) => ref.name === source.work_ref)?.oid;
    if (commit)
      tips.set(knowledgeTimelineRef(source.timeline_slug), { sourceId: source.source_id, commit });
  }
  return tips;
}

export async function timelineKnowledgeSource(env: Env, repoId: string, ref: string) {
  const slug = ref.replace(/^refs\/heads\/timeline\//, "");
  const row = await db(env.DB)
    .selectFrom("timeline_work_sources")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("timeline_slug", "=", slug)
    .executeTakeFirst();
  if (!row) return null;
  return row;
}
