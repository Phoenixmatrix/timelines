import { releaseKnowledgeBase } from "./source-reader.ts";

/** Expiry cancels unstarted work; only terminal Workflow evidence retires a producer. */
export async function reconcileExpiredKnowledge(
  env: Env,
  ownerId: string,
  timelineIds: string[],
): Promise<void> {
  const ids = JSON.stringify(timelineIds);
  await env.DB.prepare(`UPDATE kg_page_sets AS p SET status='ended',finished_at=?
    WHERE p.status='queued' AND EXISTS (
      SELECT 1 FROM timeline_work_sources s WHERE s.repo_id=p.repo_id AND s.source_id=p.source_id
        AND s.owner_id=? AND s.timeline_id IN (SELECT value FROM json_each(?))
        AND s.state='archived' AND s.expiry_requested_at IS NOT NULL
    )`)
    .bind(new Date().toISOString(), ownerId, ids)
    .run();
  const claims = await env.DB.prepare(`SELECT r.repo_id,r.source_id,r.consumer_kind,r.consumer_id
    FROM timeline_source_roots r JOIN timeline_work_sources s
      ON s.repo_id=r.repo_id AND s.source_id=r.source_id
    WHERE s.owner_id=? AND s.timeline_id IN (SELECT value FROM json_each(?))
      AND s.state='archived' AND s.expiry_requested_at IS NOT NULL
      AND r.consumer_kind IN ('knowledge-overlay','knowledge-pages-build')`)
    .bind(ownerId, ids)
    .all<{
      repo_id: string;
      source_id: string;
      consumer_kind: string;
      consumer_id: string;
    }>();
  for (const claim of claims.results) {
    const prefix = `${claim.repo_id}:${claim.source_id}:`;
    if (claim.consumer_kind === "knowledge-overlay" && !claim.consumer_id.startsWith(prefix))
      throw new Error("Knowledge source claim has an invalid workflow identity");
    const buildId =
      claim.consumer_kind === "knowledge-overlay"
        ? claim.consumer_id.slice(prefix.length)
        : claim.consumer_id;
    const instance = await env.KNOWLEDGE_BUILD.get(buildId);
    const state = await instance.status();
    if (state.status !== "complete" && state.status !== "errored" && state.status !== "terminated")
      continue;
    await env.DB.prepare(`DELETE FROM timeline_source_roots
      WHERE repo_id=? AND source_id=? AND consumer_kind=? AND consumer_id=?`)
      .bind(claim.repo_id, claim.source_id, claim.consumer_kind, claim.consumer_id)
      .run();
    await releaseKnowledgeBase(env, claim.repo_id, `knowledge:${buildId}`);
  }
}
