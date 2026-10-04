// The assistant's HTTP surface (CORE-25/26). Chats are per person: the
// Durable Object instance is "<userId>:<chatId>", chosen here from the signed-
// in actor, so nobody can reach someone else's conversation by naming it.

import { Hono } from "hono";
import type { AskRequest, AssistantChat } from "../../shared/assistant.ts";
import type { AppEnv } from "../auth.ts";
import { durableAgent, purgeInstance } from "../durable/registry.ts";
import { accountPolicies } from "../retention/policies.ts";
import { db } from "../schema.ts";
import { fail, readJson, requireActor } from "./http.ts";

export const assistant = new Hono<AppEnv>();

const CHAT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The Durable Object's answer, with headers the API's middleware can still set. */
function passThrough(response: Response): Response {
  return response.status === 101 || response.webSocket
    ? response
    : new Response(response.body, response);
}

function stub(env: Env, userId: string, chatId: string) {
  return durableAgent(env, "Assistant", `${userId}:${chatId}`);
}

assistant.get("/chats", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const rows = await db(c.env.DB)
    .selectFrom("assistant_chats")
    .selectAll()
    .where("user_id", "=", actor.id)
    .orderBy("updated_at", "desc")
    .limit(200)
    .execute();
  const policy = (await accountPolicies(c.env.DB, actor.id)).find(
    (p) => p.id === "assistant-chats",
  );
  const now = new Date().toISOString();
  const expires = (updatedAt: string, index: number) => {
    if (!policy?.enabled) return null;
    const { days = 0, maxPerUser = 0 } = policy.values;
    if (maxPerUser > 0 && index >= maxPerUser) return now;
    return new Date(Date.parse(updatedAt) + days * 86_400_000).toISOString();
  };
  return c.json({
    chats: rows.map((row, index): AssistantChat => ({
      id: row.id,
      title: row.title,
      source: row.source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: expires(row.updated_at, index),
    })),
  });
});

assistant.get("/chats/:id", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const id = c.req.param("id");
  const row = await db(c.env.DB)
    .selectFrom("assistant_chats")
    .selectAll()
    .where("id", "=", id)
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  if (!row) return fail(c, 404, "No such chat.");
  const agent = await stub(c.env, actor.id, id);
  return c.json({ id, title: row.title, source: row.source, messages: await agent.transcript() });
});

assistant.delete("/chats/:id", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const id = c.req.param("id");
  const { numDeletedRows } = await db(c.env.DB)
    .deleteFrom("assistant_chats")
    .where("id", "=", id)
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  if (!numDeletedRows) return fail(c, 404, "No such chat.");
  await purgeInstance(c.env, "Assistant", `${actor.id}:${id}`, "chat deleted");
  return c.body(null, 204);
});

// The web's live connection (WebSocket) and its initial-messages fetch.
assistant.all("/chats/:id/agent/*", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const id = c.req.param("id");
  if (!CHAT_ID.test(id)) return fail(c, 400, "Invalid chat id.");
  return passThrough(await (await stub(c.env, actor.id, id)).fetch(c.req.raw));
});
assistant.all("/chats/:id/agent", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const id = c.req.param("id");
  if (!CHAT_ID.test(id)) return fail(c, 400, "Invalid chat id.");
  return passThrough(await (await stub(c.env, actor.id, id)).fetch(c.req.raw));
});

// One question from `gm ask`, streamed back as newline-delimited JSON events.
assistant.post("/ask", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<AskRequest>(c);
  const question = body.question?.trim();
  if (!question) return fail(c, 400, "Ask a question.");
  if (question.length > 20_000) return fail(c, 400, "Keep the question under 20,000 characters.");
  if (body.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(body.repo))
    return fail(c, 400, "repo is owner/name.");
  const chatId = body.chatId ?? crypto.randomUUID();
  if (!CHAT_ID.test(chatId)) return fail(c, 400, "Invalid chat id.");
  if (body.chatId) {
    const mine = await db(c.env.DB)
      .selectFrom("assistant_chats")
      .select("id")
      .where("id", "=", chatId)
      .where("user_id", "=", actor.id)
      .executeTakeFirst();
    if (!mine) return fail(c, 404, "No such chat.");
  }
  const origin = new URL(c.req.url).origin;
  const agent = await stub(c.env, actor.id, chatId);
  const stream = await agent.ask(question, {
    write: body.write === true,
    repo: body.repo,
    url: `${origin}/?chat=${chatId}`,
  });
  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
});
