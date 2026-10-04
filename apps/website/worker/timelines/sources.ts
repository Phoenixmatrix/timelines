import type { Selectable } from "kysely";
import type { CodeSource, SourceSnapshot } from "../../shared/code-source.ts";
import type { TimelineRepo } from "../../shared/timelines.ts";
import type { RepoRow } from "../db.ts";
import { db, type Database } from "../schema.ts";
import { fail } from "../tracker/store.ts";
import { isArtifactsError, lsRefs, forgetUpstreamTokens } from "../artifacts.ts";
import { trackerObject } from "../tracker/stub.ts";
import { TrackerError } from "../tracker/store.ts";
import type { TrackerReply } from "../tracker/object.ts";
import { writeRefs } from "./bookmarks.ts";
import { pinSourceRoot } from "../retention/work-sources.ts";

// The expiry admission fence belongs to D1, not the Tracker's lifecycle projection.
export type WorkSourceRow = Omit<
  Selectable<Database["timeline_work_sources"]>,
  "expiry_requested_at"
>;
export interface InitializedWorkSource {
  repo: RepoRow & { source_id: string };
  source: CodeSource;
  logicalBase: SourceSnapshot;
}
export interface WorkSourceInput {
  timelineId: string;
  timelineSlug: string;
  base: SourceSnapshot;
  initialHead?: SourceSnapshot;
}
export function canonicalSource(repo: Pick<RepoRow, "id" | "default_branch">): CodeSource {
  return {
    sourceId: "canonical",
    repoId: repo.id,
    kind: "canonical",
    timelineId: null,
    ref: `refs/heads/${repo.default_branch}`,
  };
}
export function workGitPath(
  repo: { owner_slug: string; name: string },
  timelineSlug: string,
): string {
  return `/${encodeURIComponent(repo.owner_slug)}/${encodeURIComponent(repo.name)}@${encodeURIComponent(timelineSlug)}.git`;
}
export async function getWorkSource(
  env: Env,
  repoId: string,
  sourceId: string,
): Promise<WorkSourceRow | undefined> {
  return db(env.DB)
    .selectFrom("timeline_work_sources")
    .selectAll()
    .where("repo_id", "=", repoId)
    .where("source_id", "=", sourceId)
    .executeTakeFirst();
}
export async function resolveSource(
  env: Env,
  repo: RepoRow,
  sourceId?: string | null,
): Promise<{ repo: RepoRow & { source_id: string }; source: CodeSource }> {
  // Always recheck D1: persisted job metadata and a previously authorized RepoRow
  // must not resurrect a canonical tombstone.
  const live = await db(env.DB)
    .selectFrom("repos")
    .select("id")
    .where("id", "=", repo.id)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!live) fail("not_found", "Repository was deleted.", 404);
  if (!sourceId || sourceId === "canonical")
    return { repo: { ...repo, source_id: "canonical" }, source: canonicalSource(repo) };
  const owned = await getWorkSource(env, repo.id, sourceId);
  if (!owned || owned.owner_id !== repo.owner_id) fail("not_found", "No such code source.", 404);
  if (owned.state === "purging" || owned.state === "purged")
    fail("source_expired", "This code source has expired.", 410);
  if (
    (owned.state !== "ready" && owned.state !== "archived") ||
    !owned.artifacts_remote ||
    !owned.initial_token_revoked
  )
    fail("source_not_ready", "The owned code source is not ready.", 409);
  return {
    repo: {
      ...repo,
      source_id: owned.source_id,
      artifacts_name: owned.artifacts_name,
      artifacts_remote: owned.artifacts_remote,
      default_branch: owned.work_ref.replace(/^refs\/heads\//, ""),
    },
    source: {
      sourceId: owned.source_id,
      repoId: repo.id,
      timelineId: owned.timeline_id,
      kind: "timeline-work",
      ref: owned.work_ref,
    },
  };
}
export async function resolveTimelineSource(env: Env, repo: RepoRow, entry: TimelineRepo) {
  if (!entry.source)
    fail(
      "migration_required",
      "This legacy timeline must be migrated before accessing active work.",
      409,
    );
  if (entry.source.repoId !== repo.id)
    fail("invalid_source", "Source repository does not match.", 409);
  const resolved = await resolveSource(env, repo, entry.source.sourceId);
  if (entry.source.kind === "canonical-historical") return { ...resolved, source: entry.source };
  if (
    resolved.source.timelineId !== entry.source.timelineId ||
    resolved.source.ref !== entry.source.ref
  )
    fail("invalid_source", "Source identity does not match its ownership record.", 409);
  return resolved;
}

/** Native fork allocation: the Tracker reserves the name before any provider side effect. */
export async function ensureWorkSource(
  env: Env,
  repo: RepoRow,
  input: WorkSourceInput,
): Promise<InitializedWorkSource> {
  const reply = await trackerObject(env, repo.owner_id).initializeWorkSource(repo, input);
  if (!reply.ok) throw new TrackerError(reply.status, reply.code, reply.error);
  return reply.value;
}

/** Runs inside the account Tracker's single-flight initializer. */
export async function initializeWorkSource(
  env: Env,
  repo: RepoRow,
  input: WorkSourceInput,
): Promise<InitializedWorkSource> {
  const tracker = trackerObject(env, repo.owner_id);
  const unwrap = <T>(reply: TrackerReply<T>): T => {
    if (!reply.ok) throw new TrackerError(reply.status, reply.code, reply.error);
    return reply.value;
  };
  let row = unwrap(await tracker.reserveWorkSource(repo, input));
  const project = async () => {
    // An update of an existing reservation is allowed after tombstoning so
    // deletion can drain the creating phase. A new reservation is not.
    await env.DB.prepare(`INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,version,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,work_ref,initial_token_revoked,created_at,updated_at,archived_at,error,initial_source_id,initial_commit,initial_tree,initial_ref)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM repos WHERE id=? AND deleted_at IS NULL)
      ON CONFLICT(source_id) DO UPDATE SET artifacts_remote=excluded.artifacts_remote,state=excluded.state,version=excluded.version,initial_token_revoked=excluded.initial_token_revoked,updated_at=excluded.updated_at,archived_at=excluded.archived_at,error=excluded.error
      WHERE timeline_work_sources.version <= excluded.version AND (timeline_work_sources.state NOT IN ('purging','purged') OR excluded.state=timeline_work_sources.state OR excluded.state='purged')`)
      .bind(
        row.source_id,
        row.repo_id,
        row.timeline_id,
        row.timeline_slug,
        row.owner_id,
        row.artifacts_name,
        row.artifacts_remote,
        row.state,
        row.version,
        row.allocation_operation_id,
        row.fork_source_id,
        row.fork_commit,
        row.fork_tree,
        row.fork_ref,
        row.work_ref,
        row.initial_token_revoked,
        row.created_at,
        row.updated_at,
        row.archived_at,
        row.error,
        row.initial_source_id,
        row.initial_commit,
        row.initial_tree,
        row.initial_ref,
        repo.id,
      )
      .run();
    await env.DB.prepare(
      `UPDATE timeline_work_sources SET artifacts_remote=?,state=?,version=?,initial_token_revoked=?,updated_at=?,archived_at=?,error=? WHERE source_id=? AND version<=? AND state NOT IN ('purging','purged')`,
    )
      .bind(
        row.artifacts_remote,
        row.state,
        row.version,
        row.initial_token_revoked,
        row.updated_at,
        row.archived_at,
        row.error,
        row.source_id,
        row.version,
      )
      .run();
  };
  await project();
  const logicalBase: SourceSnapshot = {
    ...input.base,
    sourceId: row.fork_source_id,
    commit: row.fork_commit,
    tree: row.fork_tree,
    ref: row.fork_ref,
  };
  if (logicalBase.kind === "timeline-work")
    await pinSourceRoot(env, {
      repoId: repo.id,
      sourceId: logicalBase.sourceId,
      consumerKind: "dependency",
      consumerId: input.timelineId,
      commit: logicalBase.commit,
    });
  if (row.state === "ready" || row.state === "archived")
    return { ...(await resolveSource(env, repo, row.source_id)), logicalBase };
  if (row.state === "reserved" || row.state === "failed") {
    const admitted = await env.DB.prepare(
      `UPDATE timeline_work_sources SET state='creating' WHERE source_id=? AND state IN ('reserved','failed') AND EXISTS(SELECT 1 FROM repos WHERE id=? AND deleted_at IS NULL) RETURNING source_id`,
    )
      .bind(row.source_id, repo.id)
      .first();
    if (!admitted)
      fail(
        "source_not_ready",
        "Source allocation is fenced by repository deletion or another initializer.",
        409,
      );
    row = unwrap(await tracker.transitionWorkSource(row.source_id, row.version, "creating"));
    await project();
  }
  if (row.state !== "creating")
    fail("source_not_ready", "Source allocation cannot be initialized.", 409);
  const parent = await resolveSource(env, repo, row.initial_source_id);
  try {
    using existing = await env.ARTIFACTS.get(row.artifacts_name);
    row.artifacts_remote = (await existing.info()).remote;
  } catch (error) {
    if (!isArtifactsError(error, "NOT_FOUND")) throw error;
    const live = await db(env.DB)
      .selectFrom("repos")
      .select("id")
      .where("id", "=", repo.id)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!live) {
      row = unwrap(await tracker.transitionWorkSource(row.source_id, row.version, "failed"));
      await project();
      fail("not_found", "Repository deletion fenced source creation.", 404);
    }
    using origin = await env.ARTIFACTS.get(parent.repo.artifacts_name);
    const forked = await origin.fork(row.artifacts_name, { readOnly: false });
    row.artifacts_remote = forked.remote;
  }
  using owned = await env.ARTIFACTS.get(row.artifacts_name);
  // Includes recovery after a crash before the initial token could be saved.
  // No caller receives the repo until all pre-readiness credentials are revoked.
  const tokens = await owned.listTokens();
  for (const token of tokens.tokens) await owned.revokeToken(token.id);
  forgetUpstreamTokens(row.artifacts_name);
  const pinned = await owned.readCommit(row.initial_commit);
  if (!pinned || pinned.treeHash !== row.initial_tree)
    fail("source_not_ready", "Fork does not contain the exact requested source snapshot.", 409);
  const refs = await lsRefs(env, row.artifacts_name, row.artifacts_remote!);
  const current = refs.find((ref) => ref.name === row.work_ref)?.oid ?? null;
  if (current !== row.initial_commit) {
    const [result] = await writeRefs(
      env,
      { artifacts_name: row.artifacts_name, artifacts_remote: row.artifacts_remote! },
      [{ ref: row.work_ref, old: current, new: row.initial_commit }],
    );
    if (!result?.ok) fail("source_not_ready", "The pinned work ref could not be installed.", 409);
  }
  const verified = await lsRefs(env, row.artifacts_name, row.artifacts_remote!);
  if (verified.find((ref) => ref.name === row.work_ref)?.oid !== row.initial_commit)
    fail("source_not_ready", "The pinned work ref changed during initialization.", 409);
  const pending = [row.initial_commit];
  const members = new Set<string>();
  while (pending.length) {
    const oid = pending.pop()!;
    if (members.has(oid)) continue;
    const commit = await owned.readCommit(oid);
    if (!commit) fail("source_not_ready", "The initial source graph is incomplete.", 409);
    members.add(oid);
    pending.push(...commit.parents);
    await env.DB.prepare(
      "INSERT OR IGNORE INTO source_progress_members(repo_id,source_id,commit_oid,operation_id,created_at) VALUES(?,?,?,?,?)",
    )
      .bind(row.repo_id, row.source_id, oid, row.allocation_operation_id, row.created_at)
      .run();
  }
  row = unwrap(
    await tracker.transitionWorkSource(row.source_id, row.version, "ready", row.artifacts_remote!),
  );
  await project();
  return { ...(await resolveSource(env, repo, row.source_id)), logicalBase };
}
