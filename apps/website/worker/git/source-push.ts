import { encodeCommit, hashObject, PackWriter } from "@gitmatrix/formats/git";
import { lsRefs } from "../artifacts.ts";
import { db, nowIso } from "../schema.ts";
import { writeRefs } from "../timelines/bookmarks.ts";
import { trackerObject } from "../tracker/stub.ts";
import { getWorkSource } from "../timelines/sources.ts";
import { TrackerError } from "../tracker/store.ts";
import type { TrackerReply } from "../tracker/object.ts";
import type { SourcePush, SourcePushRecovery } from "../tracker/timelines.ts";
import { sourcePushFixtureBoundary } from "./source-push-fixture.ts";
import { repoSpace, type Actor } from "../db.ts";
import { captureWorkAuthority, resolveWorkAuthority } from "../ci/admission.ts";
import { accessFor } from "../tracker/access.ts";

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
    .select("space_id")
    .where("id", "=", repoId)
    .executeTakeFirst();
  if (!canonical) return [];
  const tracker = trackerObject(env, canonical.space_id);
  const pending = await tracker.sourcePushesForSettlement({ spaceId: canonical.space_id, repoId });
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
    const authoritative = await tracker.sourcePushForSettlement({
      spaceId: canonical.space_id,
      operationId: row.id,
      repoId,
      sourceId: row.source_id,
    });
    if (!authoritative.ok) throw new Error(authoritative.error);
    if (authoritative.value.state !== "accepted" && authoritative.value.state !== "rejected")
      continue;
    const proof = authoritative.value.recovery;
    const result =
      proof?.outcome && proof.head
        ? await tracker.settleSourcePushRecovery(row.id, proof.outcome, proof.head)
        : await tracker.finishSourcePushForSettlement(
            { spaceId: canonical.space_id, repoId, sourceId: row.source_id, operationId: row.id },
            authoritative.value.state,
          );
    if (!result.ok) throw new Error(result.error);
    settled.push(row.id);
  }
  for (const operation of pending.value) {
    if (sourceId && operation.sourceId !== sourceId) continue;
    if (operation.state === "accepted" || operation.state === "rejected") {
      if (!settled.includes(operation.operationId)) {
        const proof = operation.recovery;
        const result =
          proof?.outcome && proof.head
            ? await tracker.settleSourcePushRecovery(
                operation.operationId,
                proof.outcome,
                proof.head,
              )
            : await tracker.finishSourcePushForSettlement(
                {
                  spaceId: canonical.space_id,
                  repoId,
                  sourceId: operation.sourceId,
                  operationId: operation.operationId,
                },
                operation.state,
              );
        if (!result.ok) throw new Error(result.error);
        settled.push(operation.operationId);
      }
      continue;
    }
    if (operation.recovery) continue; // An unresolved CAS is not rejection proof.
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
    const result = await tracker.finishSourcePushForSettlement(
      {
        spaceId: canonical.space_id,
        repoId,
        sourceId: operation.sourceId,
        operationId: operation.operationId,
      },
      "accepted",
    );
    if (!result.ok) throw new Error(result.error);
    settled.push(operation.operationId);
  }
  return settled;
}

function unwrapPush<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new TrackerError(reply.status, reply.code, reply.error);
  return reply.value;
}

function recoveryResult(operation: SourcePush & { state: string }) {
  if (operation.state !== "accepted" && operation.state !== "rejected")
    throw new TrackerError(
      409,
      "source_busy",
      "Recovery is not proven; retry this exact operation.",
    );
  return {
    sourceId: operation.sourceId,
    operationId: operation.operationId,
    state: operation.state,
    // A pre-forward rejection proves no write, not that the client's old OID
    // was the provider head. Do not present that unobserved head as proof.
    head:
      operation.recovery?.head ??
      (operation.state === "accepted" ? operation.commands[0]?.new : null) ??
      null,
    recoveryId: operation.recovery?.id ?? null,
    fenceCommit: operation.recovery?.commit ?? null,
    syncRequired: operation.recovery?.outcome === "rejected",
  };
}

/** Explicit recovery never treats the unchanged old ref as rejection proof. */
export async function recoverSourcePush(
  env: Env,
  canonical: { id: string; space_id: string },
  sourceId: string,
  operationId: string,
  actor: Actor,
) {
  const tracker = trackerObject(env, canonical.space_id);
  const scope = { spaceId: canonical.space_id, operationId, repoId: canonical.id, sourceId };
  let operation = unwrapPush(await tracker.sourcePushForSettlement(scope));
  const readOperation = async () => unwrapPush(await tracker.sourcePushForSettlement(scope));
  const finish = async () => {
    if (operation.recovery?.outcome) {
      unwrapPush(
        await tracker.settleSourcePushRecovery(
          operationId,
          operation.recovery.outcome,
          operation.recovery.head!,
        ),
      );
    } else if (operation.state === "accepted" || operation.state === "rejected") {
      unwrapPush(await tracker.finishSourcePushForSettlement(scope, operation.state));
    }
    return recoveryResult(await readOperation());
  };
  if (operation.state === "accepted" || operation.state === "rejected") return finish();
  if (operation.state === "projecting") {
    unwrapPush(await tracker.rejectUnprojectedSourcePush(operationId, canonical.id, sourceId));
    operation = await readOperation();
    return finish();
  }
  const source = await getWorkSource(env, canonical.id, sourceId);
  if (
    !source ||
    source.space_id !== canonical.space_id ||
    source.state !== "ready" ||
    !source.artifacts_remote ||
    source.timeline_id !== operation.timelineId
  )
    throw new TrackerError(409, "source_expired", "Recovery requires the active owned source.");
  const [command] = operation.commands;
  if (
    operation.commands.length !== 1 ||
    !command ||
    command.ref !== source.work_ref ||
    !command.new
  )
    throw new TrackerError(409, "recovery_conflict", "Operation is not an owned work-ref update.");
  const repo = {
    id: canonical.id,
    source_id: sourceId,
    artifacts_name: source.artifacts_name,
    artifacts_remote: source.artifacts_remote,
  };
  const readHead = async () =>
    (await lsRefs(env, repo.artifacts_name, repo.artifacts_remote, [source.work_ref])).find(
      (ref) => ref.name === source.work_ref,
    )?.oid ?? null;
  let head = await readHead();
  if (!operation.recovery && head === command.new) {
    await retainProgress(env, repo, operationId, command.new);
    unwrapPush(await tracker.finishSourcePushForSettlement(scope, "accepted"));
    operation = await readOperation();
    return finish();
  }
  if (!operation.recovery) {
    const recoveryAuthority = await captureWorkAuthority(env, canonical.id, actor);
    if (!head || head !== command.old || command.old === command.new)
      throw new TrackerError(
        409,
        "recovery_conflict",
        "The provider head is neither the admitted old nor new commit; the source remains fenced.",
      );
    using artifacts = await env.ARTIFACTS.get(repo.artifacts_name);
    const base = await artifacts.readCommit(head);
    if (!base)
      throw new TrackerError(409, "recovery_conflict", "Recovery base commit is unavailable.");
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const identity = {
      name: "Timelines source recovery",
      email: "source-recovery@gitmatrix.com",
      time: Math.floor(Date.parse(createdAt) / 1000),
    };
    const bytes = encodeCommit({
      tree: base.treeHash,
      parents: [head],
      author: identity,
      committer: identity,
      message: `Fence interrupted source push ${operationId}\n\nRecovery: ${id}\n`,
    });
    const intent: SourcePushRecovery = {
      authority: recoveryAuthority,
      id,
      base: head,
      tree: base.treeHash,
      commit: hashObject("commit", bytes),
      content: new TextDecoder().decode(bytes),
      actorId: actor.agent?.id ?? actor.id,
      accountableId: actor.id,
      createdAt,
      priorState: operation.state,
    };
    // First persisted intent wins. Every contender must use the returned marker.
    const current = await resolveWorkAuthority(env, recoveryAuthority, canonical.id);
    const access = await accessFor(
      env,
      repoSpace(current.repo),
      actor.id,
      actor.agent?.id ?? null,
      false,
      actor.credential,
    );
    operation = unwrapPush(
      await tracker.beginSourcePushRecovery(access, operationId, canonical.id, sourceId, intent),
    );
    if (operation.state === "accepted" || operation.state === "rejected") return finish();
  }
  const recovery = operation.recovery!;
  head = await readHead();
  if (head === recovery.base) {
    const bytes = new TextEncoder().encode(recovery.content);
    if (hashObject("commit", bytes) !== recovery.commit)
      throw new TrackerError(409, "recovery_conflict", "Persisted recovery marker does not match.");
    const writer = new PackWriter();
    writer.header(1);
    writer.add("commit", bytes);
    const chunks = writer.finish();
    const pack = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      pack.set(chunk, offset);
      offset += chunk.length;
    }
    await resolveWorkAuthority(env, recovery.authority, canonical.id);
    try {
      await writeRefs(
        env,
        repo,
        [{ ref: source.work_ref, old: recovery.base, new: recovery.commit }],
        pack,
      );
    } catch {
      // A lost response is not a failed CAS. Only the fresh ref proof below settles it.
    }
    head = await readHead();
  }
  if (head !== recovery.commit && head !== command.new)
    throw new TrackerError(
      409,
      "source_busy",
      "Recovery has no terminal ref proof; retry this exact operation. The source remains fenced.",
    );
  const outcome = head === recovery.commit ? "rejected" : "accepted";
  if (outcome === "rejected")
    await sourcePushFixtureBoundary(
      env,
      canonical.id,
      sourceId,
      operationId,
      "after-recovery-fence",
    );
  await retainProgress(env, repo, operationId, head);
  unwrapPush(await tracker.settleSourcePushRecovery(operationId, outcome, head));
  operation = await readOperation();
  return finish();
}
