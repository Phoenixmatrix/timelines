import type { QueueFailure } from "../../shared/merge-queue.ts";
import { db } from "../schema.ts";
import { accessFor } from "../tracker/access.ts";
import { TrackerError } from "../tracker/store.ts";
import { trackerObject } from "../tracker/stub.ts";
import type { Actor } from "../db.ts";
import { findSpaceById } from "../spaces/access.ts";

interface QueueIssueContext {
  spaceId: string;
  repoId: string;
  /** Accountable human, not the agent identity. */
  actorId: string;
  agentId: string | null;
  credential?: Actor["credential"];
  issueIds: string[];
}

/** Queue admission is repo-authorized by its caller and independently tracker-authorized here. */
export async function validateQueueIssues(env: Env, input: QueueIssueContext): Promise<string[]> {
  if (!input.issueIds.length) return [];
  const space = await findSpaceById(env.DB, input.spaceId);
  if (!space) throw new TrackerError(404, "not_found", "Tracker Space not found.");
  const repo = await db(env.DB)
    .selectFrom("repos")
    .select("space_id")
    .where("id", "=", input.repoId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (repo?.space_id !== space.id)
    throw new TrackerError(404, "not_found", "Repository is not in this Space.");
  const access = await accessFor(env, space, input.actorId, input.agentId, true, input.credential);
  const result = await trackerObject(env, space.id).validateQueueIssues(access, input.issueIds);
  if (!result.ok) throw new TrackerError(result.status, result.code, result.error, result.details);
  return result.value;
}

/** Internal durable effect: no generic mutation endpoint accepts these system fields. */
export async function recordQueueFailure(
  env: Env,
  input: QueueIssueContext & { failure: QueueFailure },
): Promise<{ id: string; key: string }> {
  const space = await findSpaceById(env.DB, input.spaceId);
  if (!space) throw new TrackerError(404, "not_found", "Tracker Space not found.");
  const access = await accessFor(env, space, input.actorId, input.agentId, true, input.credential);
  // Access resolution can overlap deletion: don't recreate its queue evidence.
  const repo = await db(env.DB)
    .selectFrom("repos")
    .select("id")
    .where("id", "=", input.repoId)
    .where("space_id", "=", input.spaceId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!repo) throw new TrackerError(404, "not_found", "Repository not found.");
  const result = await trackerObject(env, space.id).recordQueueFailure(access, {
    repoId: input.repoId,
    issueIds: input.issueIds,
    failure: input.failure,
  });
  if (!result.ok) throw new TrackerError(result.status, result.code, result.error, result.details);
  return result.value;
}
