// Approve when green (CORE-378): a person may turn on, for themselves in one
// tracker, approving the checkpoint approvals routed to them once the
// checkpoint's CI is green. The tracker then answers as that person, marked
// `via: "auto-approve"`, and the approval timeline lands as if they had
// clicked Approve. It never rejects: red or pending CI leaves the request open.
// Nor does it approve a checkpoint whose changes touch the CI definition: an
// agent could weaken CI to make "green" trivial and get the person's name on
// the approval. That, or not being able to tell, leaves it to the person.
//
// It acts with the work authority the person turned it on with (their own
// credential, never an agent's), re-resolved before every use: a revoked or
// expired credential, a lost Space grant or a migration since turns the
// setting off, logged, and they turn it on again. There is no
// credential-less automation path.

import type { CheckpointState } from "../../shared/timelines.ts";
import { autoApprovable, type HumanRequest } from "../../shared/tracker.ts";
import { lsRefs } from "../artifacts.ts";
import { CONFIG_PATH } from "../ci/config.ts";
import {
  resolveWorkAuthority,
  WorkAuthorizationError,
  type WorkAuthority,
} from "../ci/admission.ts";
import type { Actor } from "../db.ts";
import { refreshAfterTrackerMutation } from "../release-notes/queue.ts";
import { db } from "../schema.ts";
import { findSpaceById } from "../spaces/access.ts";
import { accessFor } from "../tracker/access.ts";
import type { TrackerReply } from "../tracker/object.ts";
import { TrackerError, type Access } from "../tracker/store.ts";
import { trackerObject } from "../tracker/stub.ts";
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
    const where = `${repo.space}/${repo.name}`;
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
  spaceId: string,
  scope: AutoApproveScope,
): Promise<number> {
  try {
    const tracker = trackerObject(env, spaceId);
    const people = unwrap(await tracker.approvingWhenGreen()).filter(
      (id) => !scope.personId || id === scope.personId,
    );
    let approved = 0;
    for (const personId of people) {
      const consent = await consentOf(env, spaceId, personId);
      if (!consent) continue;
      const open = consent.open
        .map(({ request }) => request)
        .filter(
          (request) =>
            request.kind === "approval" &&
            request.checkpoint &&
            request.routeTo === personId &&
            (!scope.slug || request.checkpoint.timeline === scope.slug) &&
            (!scope.requestId || request.id === scope.requestId),
        );
      for (const request of open)
        if (await approveOne(env, deps, spaceId, consent, request)) approved++;
    }
    return approved;
  } catch (error) {
    console.error("Auto-approve: looking for approvals failed", { spaceId, scope, error });
    return 0;
  }
}

interface Consent {
  authority: WorkAuthority;
  access: Access;
  open: { request: HumanRequest }[];
}

/**
 * The person's tracker access, built from the authority they turned
 * approve-when-green on with and checked live; null (and the setting turned
 * off, when that's why) if it can't act for them any more.
 */
async function consentOf(env: Env, spaceId: string, personId: string): Promise<Consent | null> {
  const tracker = trackerObject(env, spaceId);
  const authority = unwrap(await tracker.workAuthority(`automation:${personId}`));
  const space = await findSpaceById(env.DB, spaceId);
  if (!authority || !space) return null;
  try {
    const access = await accessFor(env, space, personId, null, true, authority.credential);
    access.source = "automation";
    if (access.migrationEpoch !== authority.migrationEpoch)
      throw new TrackerError(409, "migration_epoch_mismatch", "Consent predates this epoch.");
    // The Durable Object checks the credential is live here, and as it answers.
    const open = unwrap(await tracker.openRequests(access));
    return { authority, access, open };
  } catch (error) {
    if (!(error instanceof TrackerError)) throw error;
    // The Durable Object re-checks why before it takes the setting away.
    const retired = await tracker.retireApprovalAutomation({ spaceId, personId });
    console.warn("Auto-approve: the consent it acts with can't act any more", {
      spaceId,
      personId,
      code: error.code,
      retired: retired.ok && retired.value,
    });
    return null;
  }
}

async function approveOne(
  env: Env,
  deps: LandingDeps,
  spaceId: string,
  { authority, access }: Consent,
  request: HumanRequest,
): Promise<boolean> {
  const requestId = request.id;
  const checkpointId = request.checkpoint!.id;
  try {
    const tracker = trackerObject(env, spaceId);
    const [found] = unwrap(await tracker.checkpointStates(access, [checkpointId]));
    if (!found || found.timeline.policy !== "approval" || !found.state.current) return false;
    // Only what they or their own agents asked; the tracker checks it again as it answers.
    if (!autoApprovable(request, access.agents)) return false;
    const note = async (reason: string) => {
      console.warn("Auto-approve: left to its person", { spaceId, requestId, reason });
      const noted = await tracker.noteAutoApproveSkipped(access, requestId, checkpointId, reason);
      if (!noted.ok) console.error("Auto-approve: noting why failed", noted);
    };
    // Their own authority, live, in every repository it would land in.
    let actor: Actor | null = null;
    for (const repo of found.state.checkpoint.repos) {
      try {
        actor = (await resolveWorkAuthority(env, authority, repo.id)).actor;
      } catch (error) {
        if (!(error instanceof WorkAuthorizationError)) throw error;
        await note(
          `Approve when green can't act for you in ${repo.space}/${repo.name}: approve it yourself.`,
        );
        return false;
      }
    }
    if (!actor) return false;
    // Never for changes to CI itself, or when that can't be told: noted on the request.
    const skipped = await ciDefinitionChange(env, found.state);
    if (skipped) {
      await note(skipped);
      return false;
    }
    // Green just before answering; the tracker checks the rest as it answers.
    const green = await greenness(env.DB, found.timeline, found.state, { requireRun: true });
    if (!green.ok) return false;
    const reply = await tracker.autoApprove(access, requestId, checkpointId);
    if (!reply.ok) {
      // Someone answered first, or it moved on: nothing to do.
      if (reply.status >= 500) console.error("Auto-approve: answering failed", reply);
      return false;
    }
    if (!reply.value) return false;
    await refreshAfterTrackerMutation(env, spaceId, reply.value, [], actor);
    await maybeLand(env, deps, spaceId, found.timeline.slug, "approval", authority);
    return true;
  } catch (error) {
    console.error("Auto-approve: approving failed", { spaceId, requestId, error });
    return false;
  }
}
