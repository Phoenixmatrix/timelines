import type { Context } from "hono";
import { sql } from "kysely";
import {
  AGENT_PRESENCE_WINDOW_SECONDS,
  type AgentPresence,
  type AgentPresenceTarget,
} from "../shared/agent-presence.ts";
import type { AppEnv } from "./auth.ts";
import { db } from "./schema.ts";

const RESULT_LIMIT = 30;
const CLEANUP_LIMIT = 100;
const WINDOW_MS = AGENT_PRESENCE_WINDOW_SECONDS * 1000;

async function recordAgentPresence(
  d1: D1Database,
  target: AgentPresenceTarget,
  agentId: string,
  now: Date,
): Promise<void> {
  const database = db(d1);
  const timestamp = now.toISOString();
  // Resolve the identity again: a token may have been revoked while its resource
  // operation was in flight. INSERT SELECT also excludes missing identities.
  await database
    .insertInto("agent_presence")
    .columns(["target_kind", "scope_id", "resource_id", "source_id", "agent_id", "last_seen_at"])
    .expression(
      database
        .selectFrom("agents")
        .select((eb) => [
          eb.val(target.kind).as("target_kind"),
          eb.val(target.scopeId).as("scope_id"),
          eb.val(target.resourceId).as("resource_id"),
          eb.val(target.sourceId).as("source_id"),
          "id as agent_id",
          eb.val(timestamp).as("last_seen_at"),
        ])
        .where("id", "=", agentId)
        .where("revoked_at", "is", null),
    )
    .onConflict((oc) =>
      oc
        .columns(["target_kind", "scope_id", "resource_id", "source_id", "agent_id"])
        .doUpdateSet({ last_seen_at: sql<string>`excluded.last_seen_at` })
        .where("agent_presence.last_seen_at", "<", timestamp),
    )
    .execute();

  // Incremental global reclamation keeps each observation bounded. No read of
  // presence renews an observation or performs a write.
  await database
    .deleteFrom("agent_presence")
    .where(
      "id",
      "in",
      database
        .selectFrom("agent_presence")
        .select("id")
        .where("last_seen_at", "<=", new Date(now.getTime() - WINDOW_MS).toISOString())
        .orderBy("last_seen_at")
        .orderBy("id")
        .limit(CLEANUP_LIMIT),
    )
    .execute();
}

/** Call only after an authorized, successful interaction with this exact resource. */
export function noteAgentPresence(c: Context<AppEnv>, target: AgentPresenceTarget): void {
  const agent = c.get("actor")?.agent;
  if (!agent) return;
  // Neither storage errors nor a missing execution context may fail the resource
  // operation. Never include exception messages or resource/token data in logs.
  try {
    const context = c.executionCtx;
    context.waitUntil(
      recordAgentPresence(c.env.DB, target, agent.id, new Date()).catch(() => {
        console.warn("Recent agent presence could not be recorded.");
      }),
    );
  } catch {
    console.warn("Recent agent presence could not be recorded.");
  }
}

/** The caller must first authorize read access and establish resource existence. */
export async function readAgentPresence(
  d1: D1Database,
  target: AgentPresenceTarget,
  now = new Date(),
): Promise<AgentPresence> {
  const asOf = now.toISOString();
  const rows = await db(d1)
    .selectFrom("agent_presence as p")
    .innerJoin("agents as a", "a.id", "p.agent_id")
    .innerJoin("accounts as h", "h.id", "a.accountable_id")
    .select(["a.id", "a.name", "h.slug", "h.display_name", "p.last_seen_at"])
    .where("p.target_kind", "=", target.kind)
    .where("p.scope_id", "=", target.scopeId)
    .where("p.resource_id", "=", target.resourceId)
    .where("p.source_id", "=", target.sourceId)
    .where("p.last_seen_at", ">", new Date(now.getTime() - WINDOW_MS).toISOString())
    .where("p.last_seen_at", "<=", asOf)
    .where("a.revoked_at", "is", null)
    .orderBy("p.last_seen_at", "desc")
    .orderBy("a.id", "asc")
    .limit(RESULT_LIMIT + 1)
    .execute();
  return {
    agents: rows.slice(0, RESULT_LIMIT).map((row) => ({
      id: row.id,
      name: row.name,
      accountable: { slug: row.slug, displayName: row.display_name },
      lastSeenAt: row.last_seen_at,
      expiresAt: new Date(Date.parse(row.last_seen_at) + WINDOW_MS).toISOString(),
    })),
    asOf,
    windowSeconds: AGENT_PRESENCE_WINDOW_SECONDS,
    truncated: rows.length > RESULT_LIMIT,
  };
}
