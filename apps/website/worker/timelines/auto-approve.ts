// Approve when green (CORE-378): a person may turn on, for themselves in one
// tracker, approving the checkpoint approvals routed to them once the
// checkpoint's CI is green. The tracker then answers as that person, marked
// `via: "auto-approve"`, and the approval timeline lands as if they had
// clicked Approve. It never rejects: red or pending CI leaves the request open.
// Nor does it approve a checkpoint whose changes touch the CI definition: an
// agent could weaken CI to make "green" trivial and get the person's name on
// the approval. That, or not being able to tell, leaves it to the person.

import type { CheckpointState } from "../../shared/timelines.ts";
import { autoApprovable, type HumanRequest } from "../../shared/tracker.ts";
import { lsRefs } from "../artifacts.ts";
import { CONFIG_PATH } from "../ci/config.ts";
import { actorFromRow } from "../db.ts";
import { refreshAfterTrackerMutation } from "../release-notes/queue.ts";
import { db } from "../schema.ts";
import { accessFor } from "../tracker/access.ts";
import type { TrackerReply } from "../tracker/object.ts";
import { TrackerError } from "../tracker/store.ts";
import { trackerObject } from "../tracker/stub.ts";
import { writableRepoIds } from "./checkpoints.ts";
import { greenness, maybeLand, type LandingDeps } from "./landing.ts";
import { getWorkSource } from "./sources.ts";

function unwrap<T>(reply: TrackerReply<T>): T {
  if (!reply.ok) throw new TrackerError(reply.status, reply.code, reply.error);
  return reply.value;
}

/**
 * Every file the CI loader reads to define a repository's pipeline
 * (worker/ci/config.ts, read by worker/ci/trigger.ts's pipelineAt): only
 * ci.yml, which has no includes. A new include belongs here too.
 */
export const CI_DEFINITION_PATHS: readonly string[] = [CONFIG_PATH];

/**
 * Why approve-when-green must leave this checkpoint to its person, or null:
 * in some repository the checkpoint's commit has a CI definition that differs
 * from what it would land onto (that repository's main now). Anything it
 * can't read or compare is a reason too: it fails closed.
 */
export async function ciDefinitionChange(env: Env, state: CheckpointState): Promise<string | null> {
  for (const repo of state.checkpoint.repos) {
    const where = `${repo.owner}/${repo.name}`;
    try {
      const row = await db(env.DB)
        .selectFrom("repos")
        .select(["artifacts_name", "artifacts_remote", "default_branch"])
        .where("id", "=", repo.id)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!row) throw new Error("the repository is gone");
      const source = repo.source?.sourceId;
      const work =
        source && source !== "canonical" ? await getWorkSource(env, repo.id, source) : null;
      if (!work) throw new Error("the checkpoint's work source is unavailable");
      const main = (await lsRefs(env, row.artifacts_name, row.artifacts_remote)).find(
        (ref) => ref.name === `refs/heads/${row.default_branch}`,
      )?.oid;
      if (!main) throw new Error(`it has no ${row.default_branch}`);
      const [theirs, ours] = await Promise.all([
        definitionAt(env, work.artifacts_name, repo.commit),
        definitionAt(env, row.artifacts_name, main),
      ]);
      const changed = CI_DEFINITION_PATHS.find((path) => theirs.get(path) !== ours.get(path));
      if (changed) return `Changes CI configuration (${changed} in ${where}): approve it yourself.`;
    } catch (error) {
      console.error("Auto-approve: comparing CI configuration failed", { where, error });
      return `Couldn't check whether it changes CI configuration in ${where}: approve it yourself.`;
    }
  }
  return null;
}

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Each CI definition path's object at a commit (`type:hash`), or null where there's none. */
async function definitionAt(
  env: Env,
  artifactsName: string,
  commit: string,
): Promise<Map<string, string | null>> {
  using artifacts = await env.ARTIFACTS.get(artifactsName);
  const meta = await artifacts.readCommit(commit);
  if (!meta) throw new Error(`commit ${commit.slice(0, 12)} is missing`);
  const found = new Map<string, string | null>();
  for (const path of CI_DEFINITION_PATHS) {
    let tree: string | null = meta.treeHash;
    let object: string | null = null;
    const parts = path.split("/");
    for (const [index, name] of parts.entries()) {
      if (!tree) break;
      // Git's empty tree has no entries, whether or not the store keeps the object.
      const entries: ArtifactsTreeEntry[] | null =
        tree === EMPTY_TREE ? [] : await artifacts.readTree(tree);
      if (!entries) throw new Error(`tree ${tree.slice(0, 12)} is missing`);
      const entry: ArtifactsTreeEntry | undefined = entries.find((item) => item.name === name);
      if (!entry) break;
      if (index === parts.length - 1) object = `${entry.type}:${entry.hash}`;
      else tree = entry.type === "tree" ? entry.hash : null;
    }
    found.set(path, object);
  }
  return found;
}

/** Which open approvals to look at: one timeline's, one request, or one person's. */
export interface AutoApproveScope {
  slug?: string;
  requestId?: string;
  personId?: string;
}

/**
 * Something may have made an open checkpoint approval approvable on its
 * person's setting: CI on the checkpoint ended, the request was just asked,
 * or the person turned approve-when-green on. Approves each one in `scope`
 * whose person has the setting on and whose pinned checkpoint is green (a
 * succeeded run in every repository), then queues the landing as that person.
 * Returns how many it approved; never throws.
 */
export async function maybeAutoApprove(
  env: Env,
  deps: LandingDeps,
  ownerId: string,
  scope: AutoApproveScope,
): Promise<number> {
  try {
    const tracker = trackerObject(env, ownerId);
    const on = new Set(unwrap(await tracker.approvingWhenGreen()));
    if (!on.size) return 0;
    const open = unwrap(await tracker.openRequests())
      .map(({ request }) => request)
      .filter(
        (request) =>
          request.kind === "approval" &&
          request.checkpoint &&
          on.has(request.routeTo) &&
          (!scope.slug || request.checkpoint.timeline === scope.slug) &&
          (!scope.requestId || request.id === scope.requestId) &&
          (!scope.personId || request.routeTo === scope.personId),
      );
    let approved = 0;
    for (const request of open) if (await approveOne(env, deps, ownerId, request)) approved++;
    return approved;
  } catch (error) {
    console.error("Auto-approve: looking for approvals failed", { ownerId, scope, error });
    return 0;
  }
}

async function approveOne(
  env: Env,
  deps: LandingDeps,
  ownerId: string,
  request: HumanRequest,
): Promise<boolean> {
  const requestId = request.id;
  const checkpointId = request.checkpoint!.id;
  const personId = request.routeTo;
  try {
    const tracker = trackerObject(env, ownerId);
    const [found] = unwrap(await tracker.checkpointStates([checkpointId]));
    if (!found || found.timeline.policy !== "approval" || !found.state.current) return false;
    const [owner, person] = await Promise.all(
      [ownerId, personId].map((id) =>
        db(env.DB).selectFrom("accounts").selectAll().where("id", "=", id).executeTakeFirst(),
      ),
    );
    if (!owner || !person || person.kind !== "user") return false;
    // The routed person's own access, never the asker's: their write access approves.
    const access = await accessFor(env.DB, owner, person.id, null);
    access.source = "automation";
    // Someone who left: the tracker drops their setting (and approves nothing).
    if (!access.members.some((member) => member.id === person.id)) {
      await tracker.autoApprove(access, requestId, checkpointId);
      return false;
    }
    // Only what they or their own agents asked; the tracker checks it again as it answers.
    if (!autoApprovable(request, access.agents)) return false;
    // Never for changes to CI itself, or when that can't be told: noted on the request.
    const skipped = await ciDefinitionChange(env, found.state);
    if (skipped) {
      console.warn("Auto-approve: left to its person", { ownerId, requestId, reason: skipped });
      const noted = await tracker.noteAutoApproveSkipped(access, requestId, checkpointId, skipped);
      if (!noted.ok) console.error("Auto-approve: noting why failed", noted);
      return false;
    }
    // Green just before answering; the tracker checks the rest as it answers.
    const green = await greenness(env.DB, found.timeline, found.state, { requireRun: true });
    if (!green.ok) return false;
    access.writableRepoIds = await writableRepoIds(env.DB, actorFromRow(person), owner.id);
    const reply = await tracker.autoApprove(access, requestId, checkpointId);
    if (!reply.ok) {
      // Someone answered first, or it moved on: nothing to do.
      if (reply.status >= 500) console.error("Auto-approve: answering failed", reply);
      return false;
    }
    if (!reply.value) return false;
    await refreshAfterTrackerMutation(env, owner.id, reply.value, []);
    await maybeLand(env, deps, owner.id, found.timeline.slug, "approval", {
      principalId: person.id,
      agentId: null,
    });
    return true;
  } catch (error) {
    console.error("Auto-approve: approving failed", { ownerId, requestId, error });
    return false;
  }
}
