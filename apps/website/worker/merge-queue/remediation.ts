import type { QueueFailure } from "../../shared/merge-queue.ts";
import { db } from "../schema.ts";
import { accessFor } from "../tracker/access.ts";
import { TrackerError } from "../tracker/store.ts";
import { trackerObject } from "../tracker/stub.ts";

interface QueueIssueContext {
  ownerId: string;
  repoId: string;
  /** Accountable human, not the agent identity. */
  actorId: string;
  agentId: string | null;
  issueIds: string[];
}

/** Queue admission is repo-authorized by its caller and independently tracker-authorized here. */
export async function validateQueueIssues(env: Env, input: QueueIssueContext): Promise<string[]> {
  if (!input.issueIds.length) return [];
  const owner = await db(env.DB)
    .selectFrom("accounts")
    .selectAll()
    .where("id", "=", input.ownerId)
    .executeTakeFirst();
  if (!owner) throw new TrackerError(404, "not_found", "Tracker account not found.");
  let canAdmin = owner.id === input.actorId;
  if (!canAdmin) {
    const membership =
      owner.kind === "org"
        ? await db(env.DB)
            .selectFrom("org_members")
            .select("role")
            .where("org_id", "=", owner.id)
            .where("user_id", "=", input.actorId)
            .executeTakeFirst()
        : null;
    if (!membership)
      throw new TrackerError(403, "forbidden", "Tracker access requires account membership.");
    canAdmin = membership.role === "owner";
  }
  const access = await accessFor(env.DB, owner, input.actorId, input.agentId, canAdmin);
  const result = await trackerObject(env, owner.id).validateQueueIssues(access, input.issueIds);
  if (!result.ok) throw new TrackerError(result.status, result.code, result.error, result.details);
  return result.value;
}

/** Internal durable effect: no generic mutation endpoint accepts these system fields. */
export async function recordQueueFailure(
  env: Env,
  input: QueueIssueContext & { failure: QueueFailure },
): Promise<{ id: string; key: string }> {
  const owner = await db(env.DB)
    .selectFrom("accounts")
    .selectAll()
    .where("id", "=", input.ownerId)
    .executeTakeFirst();
  if (!owner) throw new TrackerError(404, "not_found", "Tracker account not found.");
  // Admission already authorized originals. Revocation since admission must not lose failure evidence.
  const access = await accessFor(env.DB, owner, input.actorId, input.agentId);
  // A repo collaborator need not belong to its owner's tracker. Resolve their
  // real identity for this trusted audit effect only, never for authorization.
  if (!access.members.some((member) => member.id === input.actorId)) {
    const principal = await db(env.DB)
      .selectFrom("accounts")
      .selectAll()
      .where("id", "=", input.actorId)
      .where("kind", "=", "user")
      .executeTakeFirst();
    if (principal) {
      const identity = await accessFor(env.DB, principal, input.actorId, input.agentId);
      access.members.push(...identity.members);
      access.agents.push(...identity.agents.filter((agent) => agent.id === input.agentId));
    }
  }
  // Access resolution can overlap deletion: don't recreate its queue evidence.
  const repo = await db(env.DB)
    .selectFrom("repos")
    .select("id")
    .where("id", "=", input.repoId)
    .where("deleted_at", "is", null)
    .executeTakeFirst();
  if (!repo) throw new TrackerError(404, "not_found", "Repository not found.");
  const result = await trackerObject(env, owner.id).recordQueueFailure(access, {
    repoId: input.repoId,
    issueIds: input.issueIds,
    failure: input.failure,
  });
  if (!result.ok) throw new TrackerError(result.status, result.code, result.error, result.details);
  return result.value;
}
