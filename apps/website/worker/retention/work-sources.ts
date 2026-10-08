import { forgetUpstreamTokens, isArtifactsError } from "../artifacts.ts";
import { trackerObject } from "../tracker/stub.ts";
import { reconcileLandingOperations } from "../timelines/integration.ts";
import { reconcileSourcePushes } from "../git/source-push.ts";
import { reconcileExpiredKnowledge } from "../knowledge/source-claims.ts";

interface ClaimedSource {
  source_id: string;
  artifacts_name: string;
  owner_id: string;
  version: number;
}

export interface SourceRoot {
  repoId: string;
  sourceId: string;
  consumerKind: string;
  consumerId: string;
  commit: string;
}

/** Atomic with the expiry fence; only an already-admitted exact claim may retry. */
export async function pinSourceRoot(env: Env, root: SourceRoot): Promise<void> {
  if (root.sourceId === "canonical") return;
  const result = await env.DB.prepare(`INSERT INTO timeline_source_roots
    (repo_id, source_id, consumer_kind, consumer_id, commit_oid, created_at)
    SELECT s.repo_id, s.source_id, ?3, ?4, ?5, ?6 FROM timeline_work_sources s
    JOIN repos r ON r.id = s.repo_id
    WHERE s.repo_id = ?1 AND s.source_id = ?2 AND s.state IN ('ready', 'archived')
      AND r.deleted_at IS NULL
      AND (s.expiry_requested_at IS NULL OR EXISTS (
        SELECT 1 FROM timeline_source_roots existing
        WHERE existing.repo_id=s.repo_id AND existing.source_id=s.source_id
          AND existing.consumer_kind=?3 AND existing.consumer_id=?4 AND existing.commit_oid=?5))
    ON CONFLICT DO UPDATE SET created_at = timeline_source_roots.created_at
    RETURNING source_id`)
    .bind(
      root.repoId,
      root.sourceId,
      root.consumerKind,
      root.consumerId,
      root.commit,
      new Date().toISOString(),
    )
    .all();
  if (!result.results.length)
    throw new Error("Source expired or repository deleted; consumer was not published.");
}

export async function releaseSourceRoots(
  env: Env,
  consumerKind: string,
  consumerId: string,
): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM timeline_source_roots WHERE consumer_kind = ? AND consumer_id = ?",
  )
    .bind(consumerKind, consumerId)
    .run();
}

/** Provider deletion is retried from purging; inventory is never removed first. */
async function deleteClaimedSource(env: Env, source: ClaimedSource): Promise<void> {
  const tracker = trackerObject(env, source.owner_id);
  const current = await tracker.getWorkSource(source.source_id);
  if (!current.ok) throw new Error(current.error);
  if (
    current.value.repo_id !==
      (await env.DB.prepare("SELECT repo_id FROM timeline_work_sources WHERE source_id=?")
        .bind(source.source_id)
        .first<string>("repo_id")) ||
    current.value.artifacts_name !== source.artifacts_name
  )
    throw new Error("Source inventory ownership mismatch.");
  const claim =
    current.value.state === "purged"
      ? current
      : await tracker.transitionWorkSource(source.source_id, current.value.version, "purging");
  if (!claim.ok) throw new Error(claim.error);
  await env.DB.prepare(
    "UPDATE timeline_work_sources SET version = ? WHERE source_id = ? AND state = 'purging'",
  )
    .bind(claim.value.version, source.source_id)
    .run();
  forgetUpstreamTokens(source.artifacts_name);
  if (claim.value.state !== "purged") {
    try {
      await env.ARTIFACTS.delete(source.artifacts_name);
    } catch (error) {
      if (!isArtifactsError(error, "NOT_FOUND")) throw error;
    }
  }
  // Its commits' mentions go with it; the compact landing commit keeps main's (CORE-296).
  await env.DB.prepare(
    "DELETE FROM commit_issue_mentions WHERE source_id = ?1 AND repo_id = (SELECT repo_id FROM timeline_work_sources WHERE source_id = ?1)",
  )
    .bind(source.source_id)
    .run();
  const finished =
    claim.value.state === "purged"
      ? claim
      : await tracker.transitionWorkSource(source.source_id, claim.value.version, "purged");
  if (!finished.ok) throw new Error(finished.error);
  await env.DB.prepare(
    "UPDATE timeline_work_sources SET state = 'purged', version = ?, updated_at = ? WHERE source_id = ? AND state = 'purging'",
  )
    .bind(finished.value.version, new Date().toISOString(), source.source_id)
    .run();
}

export interface SourceExpiryCutoffs {
  landed: string;
  abandoned: string;
}

/** Dedicated work-Git policy; Tracker metadata and preview expiry never select bytes. */
export async function expireArchivedSources(
  env: Env,
  ownerId: string,
  cutoffs: SourceExpiryCutoffs,
  timelineIds: string[],
): Promise<void> {
  if (!timelineIds.length) return;
  const ids = JSON.stringify(timelineIds);
  // Reconcile older inventories only from authoritative end evidence. Missing
  // evidence is not abandonment, and never licenses deletion.
  const legacy =
    await env.DB.prepare(`SELECT source_id,repo_id,timeline_id FROM timeline_work_sources
    WHERE owner_id=? AND timeline_id IN (SELECT value FROM json_each(?))
      AND state='archived' AND archive_disposition IS NULL`)
      .bind(ownerId, ids)
      .all<{ source_id: string; repo_id: string; timeline_id: string }>();
  for (const source of legacy.results) {
    const reply = await trackerObject(env, ownerId).getWorkSource(source.source_id);
    if (!reply.ok) throw new Error(reply.error);
    const row = reply.value;
    if (
      row.repo_id !== source.repo_id ||
      row.timeline_id !== source.timeline_id ||
      row.owner_id !== ownerId
    )
      throw new Error("Source archive ownership mismatch.");
    if (!row.archive_disposition || !row.archived_at) continue;
    await env.DB.prepare(`UPDATE timeline_work_sources SET archive_disposition=?,archived_at=?
      WHERE source_id=? AND owner_id=? AND state='archived' AND archive_disposition IS NULL`)
      .bind(row.archive_disposition, row.archived_at, row.source_id, ownerId)
      .run();
  }
  // Fence the exact policy-expired group before attempting any reconciliation.
  // Outstanding operations and consumers delay deletion, never this admission fence.
  await env.DB.prepare(`UPDATE timeline_work_sources AS s
    SET expiry_requested_at=COALESCE(expiry_requested_at, ?1)
    WHERE s.owner_id=?2 AND s.timeline_id IN (SELECT value FROM json_each(?3))
      AND s.state='archived'
      AND s.archived_at < CASE s.archive_disposition WHEN 'landed' THEN ?4 WHEN 'abandoned' THEN ?5 END
      AND s.source_id!='canonical'
      AND NOT EXISTS (SELECT 1 FROM repos r WHERE r.id=s.repo_id AND r.artifacts_name=s.artifacts_name)
      AND NOT EXISTS (SELECT 1 FROM timeline_work_sources other
        WHERE other.timeline_id=s.timeline_id AND (
          other.owner_id!=?2 OR (other.state NOT IN ('purged','purging') AND
            (other.state!='archived' OR other.archived_at IS NULL OR other.archive_disposition IS NULL
              OR other.archived_at >= CASE other.archive_disposition WHEN 'landed' THEN ?4 WHEN 'abandoned' THEN ?5 END))))`)
    .bind(new Date().toISOString(), ownerId, ids, cutoffs.landed, cutoffs.abandoned)
    .run();
  await reconcileExpiredKnowledge(env, ownerId, timelineIds);
  const pending = await env.DB.prepare(`SELECT DISTINCT o.repo_id
    FROM source_operations o JOIN timeline_work_sources s
      ON s.repo_id=o.repo_id AND s.source_id=o.source_id
    WHERE s.owner_id=? AND s.timeline_id IN (SELECT value FROM json_each(?))
      AND o.state IN ('admitted','ambiguous')`)
    .bind(ownerId, ids)
    .all<{ repo_id: string }>();
  for (const repo of pending.results) {
    await reconcileSourcePushes(env, repo.repo_id);
    await reconcileLandingOperations(env, repo.repo_id);
  }
  // Drain closed expired dependency groups, including cycles. A live consumer,
  // unfinished operation, or independent job root protects its whole dependency
  // closure. Releasing roots and claiming sources share one transaction so a
  // new consumer cannot pin a source whose own dependencies were just released.
  const claimed = await env.DB.batch<ClaimedSource>([
    env.DB.prepare(`WITH RECURSIVE eligible(timeline_id) AS (
      SELECT DISTINCT s.timeline_id FROM timeline_work_sources s
      WHERE s.owner_id=?1 AND s.timeline_id IN (SELECT value FROM json_each(?2))
        AND NOT EXISTS (SELECT 1 FROM timeline_work_sources other
          WHERE other.timeline_id=s.timeline_id AND (
            other.owner_id!=?1 OR (other.state NOT IN ('purged','purging') AND
              (other.state!='archived' OR other.archived_at IS NULL OR other.archive_disposition IS NULL
                OR other.archived_at >= CASE other.archive_disposition WHEN 'landed' THEN ?3 WHEN 'abandoned' THEN ?4 END
                OR other.expiry_requested_at IS NULL))))
        AND NOT EXISTS (SELECT 1 FROM source_operations o JOIN timeline_work_sources owned
          ON owned.repo_id=o.repo_id AND owned.source_id=o.source_id
          WHERE owned.timeline_id=s.timeline_id AND o.state IN ('admitted','ambiguous'))
    ), protected(timeline_id) AS (
      SELECT s.timeline_id FROM timeline_source_roots r JOIN timeline_work_sources s
        ON s.source_id=r.source_id AND s.repo_id=r.repo_id
      WHERE s.timeline_id IN (SELECT timeline_id FROM eligible)
        AND (r.consumer_kind!='dependency' OR r.consumer_id NOT IN (SELECT timeline_id FROM eligible))
      UNION
      SELECT s.timeline_id FROM protected p JOIN timeline_source_roots r
        ON r.consumer_kind='dependency' AND r.consumer_id=p.timeline_id
      JOIN timeline_work_sources s ON s.source_id=r.source_id AND s.repo_id=r.repo_id
      WHERE s.timeline_id IN (SELECT timeline_id FROM eligible)
    )
    DELETE FROM timeline_source_roots WHERE consumer_kind='dependency'
      AND consumer_id IN (SELECT timeline_id FROM eligible)
      AND consumer_id NOT IN (SELECT timeline_id FROM protected)`).bind(
      ownerId,
      ids,
      cutoffs.landed,
      cutoffs.abandoned,
    ),
    env.DB.prepare(`UPDATE timeline_work_sources AS s
      SET state = 'purging', updated_at = ?1
      WHERE owner_id = ?2 AND timeline_id IN (SELECT value FROM json_each(?3))
        AND ((state = 'archived' AND expiry_requested_at IS NOT NULL
          AND archived_at < CASE archive_disposition WHEN 'landed' THEN ?4 WHEN 'abandoned' THEN ?5 END)
          OR state = 'purging')
        AND s.source_id!='canonical'
        AND NOT EXISTS (SELECT 1 FROM repos r WHERE r.id=s.repo_id AND r.artifacts_name=s.artifacts_name)
        AND NOT EXISTS (SELECT 1 FROM timeline_source_roots p WHERE p.source_id = s.source_id)
        AND NOT EXISTS (SELECT 1 FROM source_operations o WHERE o.repo_id = s.repo_id
          AND o.source_id = s.source_id AND o.state IN ('admitted','ambiguous'))
      RETURNING source_id, artifacts_name, owner_id, version`).bind(
      new Date().toISOString(),
      ownerId,
      ids,
      cutoffs.landed,
      cutoffs.abandoned,
    ),
  ]);
  for (const source of claimed[1]!.results) await deleteClaimedSource(env, source);
}

/** Tombstone is the admission fence; unresolved provider outcomes must be reconciled first. */
export async function drainDeletedRepoSources(env: Env, repoId: string): Promise<void> {
  const repo = await env.DB.prepare("SELECT deleted_at FROM repos WHERE id = ?")
    .bind(repoId)
    .first<{ deleted_at: string | null }>();
  if (repo && !repo.deleted_at) throw new Error("Cannot purge sources of a live repository.");
  const consumer = await env.DB.prepare(`SELECT consumer_id FROM timeline_source_roots
    WHERE repo_id=? AND consumer_kind='ci' LIMIT 1`)
    .bind(repoId)
    .first();
  if (consumer)
    throw new Error("Repository CI consumers still require acknowledgment before source deletion.");
  await reconcileLandingOperations(env, repoId);
  const pushes = await env.DB.prepare(`SELECT id FROM source_operations WHERE repo_id=?
    AND kind='push' AND state IN ('admitted','ambiguous') LIMIT 1`)
    .bind(repoId)
    .first();
  if (pushes) await reconcileSourcePushes(env, repoId);
  const busy = await env.DB.prepare(`SELECT id FROM source_operations WHERE repo_id = ?
    AND state IN ('admitted','ambiguous') LIMIT 1`)
    .bind(repoId)
    .first();
  if (busy)
    throw new Error("Repository source operations are still draining; reconcile before purge.");
  const creating = await env.DB.prepare(`SELECT source_id,owner_id FROM timeline_work_sources
    WHERE repo_id = ? AND state = 'creating'`)
    .bind(repoId)
    .all<{ source_id: string; owner_id: string }>();
  for (const source of creating.results) {
    const settled = await trackerObject(env, source.owner_id).reconcileDeletedSource(
      source.source_id,
    );
    if (!settled.ok || settled.value.state === "creating")
      throw new Error("Repository fork creation is still draining; reconcile before purge.");
  }
  const { results } =
    await env.DB.prepare(`UPDATE timeline_work_sources SET state = 'purging', updated_at = ?
    WHERE repo_id = ? AND state != 'purged' RETURNING source_id, artifacts_name, owner_id, version`)
      .bind(new Date().toISOString(), repoId)
      .all<ClaimedSource>();
  for (const source of results) await deleteClaimedSource(env, source);
}
