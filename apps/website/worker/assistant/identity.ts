// Who the assistant is when it acts: an agent identity accountable to the
// person it works for ("assistant for Ann Lee"), so everything it does carries
// CORE-52 attribution, with that person's permissions and never more.

import { issueToken } from "../api/tokens.ts";
import { db, nowIso } from "../schema.ts";

export const ASSISTANT_NAME = "assistant";
/** Tokens are short-lived; a chat mints a fresh one when its last runs low. */
const TOKEN_HOURS = 12;

export interface AssistantCredential {
  token: string;
  expiresAt: string;
  agentId: string;
}

/** The person's assistant agent, created the first time they use it. */
export async function assistantAgent(d1: D1Database, userId: string): Promise<string> {
  const k = db(d1);
  const existing = await k
    .selectFrom("agents")
    .select(["id", "revoked_at"])
    .where("accountable_id", "=", userId)
    .where("name", "=", ASSISTANT_NAME)
    .executeTakeFirst();
  if (existing && !existing.revoked_at) return existing.id;
  if (existing)
    throw new AssistantRevoked(
      "Your assistant agent was revoked. Delete it in Settings > Agents to start over.",
    );
  const id = `agt_${crypto.randomUUID()}`;
  await k
    .insertInto("agents")
    .values({
      id,
      name: ASSISTANT_NAME,
      accountable_id: userId,
      description: "Gitmatrix's built-in assistant, acting for you from chat and gm ask.",
      revoked_at: null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  // A concurrent first use may have won the insert.
  return (
    await k
      .selectFrom("agents")
      .select("id")
      .where("accountable_id", "=", userId)
      .where("name", "=", ASSISTANT_NAME)
      .executeTakeFirstOrThrow()
  ).id;
}

export class AssistantRevoked extends Error {}

/** A working credential: `current` if it has an hour left, else a fresh token. */
export async function credential(
  d1: D1Database,
  userId: string,
  current: AssistantCredential | null,
): Promise<AssistantCredential> {
  const agentId = await assistantAgent(d1, userId);
  if (
    current &&
    current.agentId === agentId &&
    Date.parse(current.expiresAt) - Date.now() > 3_600_000
  )
    return current;
  // Expired assistant tokens are clutter on the Agents page; clear them out.
  await db(d1)
    .deleteFrom("access_tokens")
    .where("agent_id", "=", agentId)
    .where("expires_at", "<", nowIso())
    .execute();
  const expiresAt = new Date(Date.now() + TOKEN_HOURS * 3_600_000).toISOString();
  const minted = await issueToken(d1, userId, "Assistant session", "write", { expiresAt }, agentId);
  return { token: minted.secret, expiresAt, agentId };
}
