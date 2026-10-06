import { lsRefs } from "../artifacts.ts";
import { db, nowIso } from "../schema.ts";
import { writeRefs } from "../timelines/bookmarks.ts";
import { trackerObject } from "../tracker/stub.ts";
import { getWorkSource } from "../timelines/sources.ts";

type SourceRepo = {
  id: string;
  source_id: string;
  artifacts_name: string;
  artifacts_remote: string;
};

/** Root before rewriting, then index the complete graph: no capped history scan. */
export async function retainProgress(
  env: Env,
  repo: SourceRepo,
  operationId: string,
  commit: string,
) {
  const ref = `refs/gitmatrix/progress/${commit}`;
  const existing = (await lsRefs(env, repo.artifacts_name, repo.artifacts_remote, [ref])).find(
    (r) => r.name === ref,
  );
  if (existing?.oid !== commit) {
    const [result] = await writeRefs(env, repo, [{ ref, old: null, new: commit }]);
    if (!result?.ok) {
      const raced = (await lsRefs(env, repo.artifacts_name, repo.artifacts_remote, [ref])).find(
        (r) => r.name === ref,
      );
      if (raced?.oid !== commit) throw new Error("Could not retain progress root.");
    }
  }
  using artifacts = await env.ARTIFACTS.get(repo.artifacts_name);
  const pending = [commit];
  const seen = new Set<string>();
  while (pending.length) {
    const oid = pending.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const metadata = await artifacts.readCommit(oid);
    if (!metadata) throw new Error(`Progress commit ${oid} is unavailable.`);
    pending.push(...metadata.parents);
    await db(env.DB)
      .insertInto("source_revision_origins")
      .values({ repo_id: repo.id, source_id: repo.source_id, commit_oid: oid })
      .onConflict((oc) => oc.columns(["repo_id", "commit_oid"]).doNothing())
      .execute();
    await db(env.DB)
      .insertInto("source_progress_members")
      .values({
        repo_id: repo.id,
        source_id: repo.source_id,
        commit_oid: oid,
        operation_id: operationId,
        created_at: nowIso(),
      })
      .onConflict((oc) => oc.columns(["repo_id", "source_id", "commit_oid"]).doNothing())
      .execute();
    await db(env.DB)
      .updateTable("step_contexts")
      .set({ verified_at: nowIso() })
      .where("repo_id", "=", repo.id)
      .where("commit_oid", "=", oid)
      .execute();
  }
}

/** Recovery is permitted after tombstoning, but never admits any new write. */
export async function reconcileSourcePushes(env: Env, repoId: string, sourceId?: string) {
  const canonical = await db(env.DB)
    .selectFrom("repos")
    .select("owner_id")
    .where("id", "=", repoId)
    .executeTakeFirst();
  if (!canonical) return [];
  const tracker = trackerObject(env, canonical.owner_id);
  const pending = await tracker.sourcePushes(repoId);
  if (!pending.ok) throw new Error(pending.error);
  const settled: string[] = [];
  // Tracker commits the outcome first. Repair the projection even when that
  // operation no longer appears in its pending set; never replay provider I/O.
  let projected = db(env.DB)
    .selectFrom("source_operations")
    .select(["id", "source_id"])
    .where("repo_id", "=", repoId)
    .where("kind", "=", "push")
    .where("state", "in", ["admitted", "ambiguous"]);
  if (sourceId) projected = projected.where("source_id", "=", sourceId);
  for (const row of await projected.execute()) {
    const authoritative = await tracker.sourcePush(row.id, repoId, row.source_id);
    if (!authoritative.ok) throw new Error(authoritative.error);
    if (authoritative.value.state !== "accepted" && authoritative.value.state !== "rejected")
      continue;
    const result = await tracker.finishSourcePush(row.id, authoritative.value.state);
    if (!result.ok) throw new Error(result.error);
    settled.push(row.id);
  }
  for (const operation of pending.value) {
    if (sourceId && operation.sourceId !== sourceId) continue;
    if (operation.state === "projecting") {
      const result = await tracker.rejectUnprojectedSourcePush(
        operation.operationId,
        repoId,
        operation.sourceId,
      );
      if (!result.ok) throw new Error(result.error);
      if (result.value) settled.push(operation.operationId);
      continue;
    }
    const source = await getWorkSource(env, repoId, operation.sourceId);
    if (!source?.artifacts_remote || !["ready", "archived"].includes(source.state)) continue;
    const repo = {
      id: repoId,
      source_id: source.source_id,
      artifacts_name: source.artifacts_name,
      artifacts_remote: source.artifacts_remote,
    };
    const refs = await lsRefs(env, repo.artifacts_name, repo.artifacts_remote, [source.work_ref]);
    const tip = refs.find((ref) => ref.name === source.work_ref)?.oid;
    // Old alone is not rejection proof: the interrupted provider can still CAS.
    if (!operation.commands.every((command) => command.new === tip)) continue;
    for (const command of operation.commands) {
      if (command.old) await retainProgress(env, repo, operation.operationId, command.old);
      if (command.new) await retainProgress(env, repo, operation.operationId, command.new);
    }
    const result = await tracker.finishSourcePush(operation.operationId, "accepted");
    if (!result.ok) throw new Error(result.error);
    settled.push(operation.operationId);
  }
  return settled;
}
