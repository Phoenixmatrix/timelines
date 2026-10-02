// Agents: identities that work on their own, each with a human accountable for
// it. A person manages their agents and mints their tokens here; an agent
// signed in with its own token can't manage agents or credentials.

import { Hono, type Context } from "hono";
import type { Agent, CreatedAccessToken, TokenScope } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import { accountSummary } from "../db.ts";
import { db, nowIso } from "../schema.ts";
import { fail, readJson, requirePerson } from "./http.ts";
import { issueToken } from "./tokens.ts";

/** Lowercase letters, digits and single hyphens, like usernames. */
const NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

export const agents = new Hono<AppEnv>();

async function listAgents(d1: D1Database, accountableId: string): Promise<Agent[]> {
  const k = db(d1);
  const [rows, tokens, human] = await Promise.all([
    k
      .selectFrom("agents")
      .selectAll()
      .where("accountable_id", "=", accountableId)
      .orderBy("name")
      .execute(),
    k
      .selectFrom("access_tokens")
      .selectAll()
      .where("user_id", "=", accountableId)
      .where("agent_id", "is not", null)
      .orderBy("created_at", "desc")
      .execute(),
    k.selectFrom("accounts").selectAll().where("id", "=", accountableId).executeTakeFirstOrThrow(),
  ]);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description,
    accountable: accountSummary(human),
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    tokens: tokens
      .filter((t) => t.agent_id === row.id)
      .map((t) => ({
        id: t.id,
        name: t.name,
        scope: t.scope,
        lastFour: t.last_four,
        createdAt: t.created_at,
        lastUsedAt: t.last_used_at,
      })),
  }));
}

agents.get("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  return c.json({ agents: await listAgents(c.env.DB, actor.id) });
});

agents.post("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<{ name: string; description: string }>(c);
  const name = body.name?.trim() ?? "";
  if (!NAME.test(name))
    return fail(c, 400, "Name it with 1 to 39 lowercase letters, digits or single hyphens.");
  const description = body.description?.trim() ?? "";
  if (description.length > 500) return fail(c, 400, "Keep the description under 500 characters.");
  const taken = await db(c.env.DB)
    .selectFrom("agents")
    .select("id")
    .where("accountable_id", "=", actor.id)
    .where("name", "=", name)
    .executeTakeFirst();
  if (taken) return fail(c, 409, `You already have an agent named ${name}.`);
  const id = `agt_${crypto.randomUUID()}`;
  await db(c.env.DB)
    .insertInto("agents")
    .values({ id, name, accountable_id: actor.id, description, revoked_at: null })
    .execute();
  const agent = (await listAgents(c.env.DB, actor.id)).find((a) => a.id === id)!;
  return c.json({ agent }, 201);
});

/** The person's own, unrevoked agent, or an error response. */
async function ownAgent(c: Context<AppEnv>, personId: string) {
  const row = await db(c.env.DB)
    .selectFrom("agents")
    .selectAll()
    .where("id", "=", c.req.param("id")!)
    .where("accountable_id", "=", personId)
    .executeTakeFirst();
  if (!row) return fail(c, 404, "No such agent.");
  if (row.revoked_at) return fail(c, 409, `${row.name} was revoked.`);
  return row;
}

agents.post("/:id/tokens", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const agent = await ownAgent(c, actor.id);
  if (agent instanceof Response) return agent;
  const body = await readJson<{ name: string; scope: TokenScope }>(c);
  const scope = body.scope ?? "write";
  if (scope !== "read" && scope !== "write") return fail(c, 400, "Choose read or write.");
  const name = body.name?.trim() || `${agent.name} on ${new Date().toISOString().slice(0, 10)}`;
  if (name.length > 80) return fail(c, 400, "Give the token a name of up to 80 characters.");
  const token: CreatedAccessToken = await issueToken(
    c.env.DB,
    actor.id,
    name,
    scope,
    undefined,
    agent.id,
  );
  return c.json(token, 201);
});

agents.delete("/:id/tokens/:tokenId", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const { numDeletedRows } = await db(c.env.DB)
    .deleteFrom("access_tokens")
    .where("id", "=", c.req.param("tokenId"))
    .where("agent_id", "=", c.req.param("id"))
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  return numDeletedRows ? c.body(null, 204) : fail(c, 404, "No such token.");
});

/** Revoking keeps the agent's name for history, and ends every token it has. */
agents.delete("/:id", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const agent = await ownAgent(c, actor.id);
  if (agent instanceof Response) return agent;
  await db(c.env.DB)
    .updateTable("agents")
    .set({ revoked_at: nowIso() })
    .where("id", "=", agent.id)
    .execute();
  await db(c.env.DB).deleteFrom("access_tokens").where("agent_id", "=", agent.id).execute();
  return c.body(null, 204);
});
