// People manage agent identities and credentials. Agents may read and report
// their own advisory capability profile, but cannot manage other identities.

import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Agent, AgentCapabilities, CreatedAccessToken, TokenScope } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import { accountSummary } from "../db.ts";
import { db, nowIso } from "../schema.ts";
import { fail, readJson, requireActor, requirePerson } from "./http.ts";
import { issueToken } from "./tokens.ts";

/** Lowercase letters, digits and single hyphens, like usernames. */
const NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;

const capabilitiesSchema = z
  .object({
    version: z.literal(1),
    harness: z.string().max(120).trim().nullable(),
    model: z.string().max(120).trim().nullable(),
    environment: z
      .object({
        os: z.string().max(64).trim().min(1),
        arch: z.string().max(64).trim().min(1),
        runtime: z.enum(["host", "container", "vm", "wsl", "cloudflare-worker", "unknown"]),
        cpuCount: z.number().int().positive().max(65536).nullable(),
        memoryBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
      })
      .strict(),
    tags: z.array(z.string().max(64).trim().min(1)).max(64),
    skills: z
      .array(
        z
          .object({
            name: z.string().max(128).trim().min(1),
            description: z.string().max(512).trim(),
            source: z.enum(["detected", "declared"]),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();

function canonicalCapabilities(profile: AgentCapabilities): AgentCapabilities {
  return {
    ...profile,
    tags: [...new Set(profile.tags)].sort(),
    skills: [
      ...new Map(
        profile.skills.map((skill) => [
          JSON.stringify([skill.name, skill.source, skill.description]),
          skill,
        ]),
      ).values(),
    ].sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.source.localeCompare(b.source) ||
        a.description.localeCompare(b.description),
    ),
  };
}

/** Count actual bytes, including chunked requests; never buffer an unbounded body. */
async function profileJson(c: Context<AppEnv>): Promise<unknown> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) return fail(c, 400, "Send a JSON object.");
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256 * 1024) {
        await reader.cancel();
        return fail(c, 413, "Keep the profile request under 256 KiB.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch {
    return fail(c, 400, "Send valid JSON.");
  } finally {
    reader.releaseLock();
  }
}

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
    capabilities: row.capabilities === null ? null : JSON.parse(row.capabilities),
    capabilitiesUpdatedAt: row.capabilities_updated_at,
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
  const raw = await profileJson(c);
  if (raw instanceof Response) return raw;
  const parsed = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      capabilities: capabilitiesSchema.optional(),
    })
    .strict()
    .safeParse(raw);
  if (!parsed.success) return fail(c, 400, "Invalid agent profile.");
  const body = parsed.data;
  const name = body.name.trim();
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
    .values({
      id,
      name,
      accountable_id: actor.id,
      description,
      revoked_at: null,
      capabilities: body.capabilities
        ? JSON.stringify(canonicalCapabilities(body.capabilities))
        : null,
      capabilities_updated_at: body.capabilities ? nowIso() : null,
    })
    .execute();
  const agent = (await listAgents(c.env.DB, actor.id)).find((a) => a.id === id)!;
  return c.json({ agent }, 201);
});

/** A person may inspect their agents; an agent may inspect/report only itself. */
async function profileAgent(c: Context<AppEnv>) {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const requested = c.req.param("id");
  if (requested === "self" && !actor.agent)
    return fail(c, 403, "Sign in with an agent token to use self.");
  const id = requested === "self" ? actor.agent!.id : requested;
  if (actor.agent && id !== actor.agent.id)
    return fail(c, 403, "Agents can only access their own profile.");
  const agent = (await listAgents(c.env.DB, actor.id)).find((row) => row.id === id);
  return agent ?? fail(c, 404, "No such agent.");
}

agents.get("/:id", async (c) => {
  const agent = await profileAgent(c);
  return agent instanceof Response ? agent : c.json({ agent });
});

agents.put("/:id/capabilities", async (c) => {
  const agent = await profileAgent(c);
  if (agent instanceof Response) return agent;
  if (agent.revokedAt) return fail(c, 409, `${agent.name} was revoked.`);
  const raw = await profileJson(c);
  if (raw instanceof Response) return raw;
  const parsed = capabilitiesSchema.safeParse(raw);
  if (!parsed.success) return fail(c, 400, "Invalid agent capabilities.");
  const capabilities = canonicalCapabilities(parsed.data);
  const capabilitiesUpdatedAt = nowIso();
  const result = await db(c.env.DB)
    .updateTable("agents")
    .set({
      capabilities: JSON.stringify(capabilities),
      capabilities_updated_at: capabilitiesUpdatedAt,
    })
    .where("id", "=", agent.id)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  if (!result.numUpdatedRows) return fail(c, 409, `${agent.name} was revoked.`);
  return c.json({ agent: { ...agent, capabilities, capabilitiesUpdatedAt } });
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
