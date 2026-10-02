import { Hono } from "hono";
import type { AccessToken, CreatedAccessToken, TokenScope } from "../../shared/api.ts";
import { generateTokenSecret, hashToken, type AppEnv } from "../auth.ts";
import { db } from "../schema.ts";
import { fail, readJson, requireActor, requirePerson } from "./http.ts";

interface TokenRow {
  id: string;
  name: string;
  scope: TokenScope;
  last_four: string;
  created_at: string;
  last_used_at: string | null;
}

function toToken(row: TokenRow): AccessToken {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    lastFour: row.last_four,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export async function issueToken(
  d1: D1Database,
  userId: string,
  name: string,
  scope: TokenScope,
  session?: { expiresAt: string; sshKeyId: string },
  /** The agent the token acts as; it still belongs to `userId`. */
  agentId?: string,
): Promise<CreatedAccessToken> {
  const secret = generateTokenSecret();
  const row = await db(d1)
    .insertInto("access_tokens")
    .values({
      id: `tok_${crypto.randomUUID()}`,
      user_id: userId,
      name,
      scope,
      token_hash: await hashToken(secret),
      last_four: secret.slice(-4),
      expires_at: session?.expiresAt ?? null,
      ssh_key_id: session?.sshKeyId ?? null,
      agent_id: agentId ?? null,
    })
    .returningAll()
    .executeTakeFirst();
  if (!row) throw new Error("The token could not be saved.");
  return { ...toToken(row), secret };
}

export const tokens = new Hono<AppEnv>();

tokens.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const results = await db(c.env.DB)
    .selectFrom("access_tokens")
    .selectAll()
    .where("user_id", "=", actor.id)
    // Sessions minted from SSH keys come and go; they're listed with the keys.
    .where("ssh_key_id", "is", null)
    // Agents' tokens are listed with their agents.
    .where("agent_id", "is", null)
    .orderBy("created_at", "desc")
    .execute();
  return c.json({ tokens: results.map(toToken) });
});

tokens.post("/", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<{ name: string; scope: TokenScope }>(c);
  const name = body.name?.trim() ?? "";
  if (!name || name.length > 80)
    return fail(c, 400, "Give the token a name of up to 80 characters.");
  if (body.scope !== "read" && body.scope !== "write") return fail(c, 400, "Choose read or write.");

  return c.json(await issueToken(c.env.DB, actor.id, name, body.scope), 201);
});

/**
 * Device login for gm: after the device flow (POST /api/identity/device/token)
 * the CLI holds a Better Auth session token. It trades it here, once, for a
 * personal access token, which is what git and the API take.
 */
tokens.post("/device", async (c) => {
  const secret = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const session = secret
    ? await db(c.env.DB)
        .selectFrom("auth_sessions")
        .select(["id", "userId", "expiresAt"])
        .where("token", "=", secret)
        .executeTakeFirst()
    : undefined;
  if (!session || Date.parse(session.expiresAt) <= Date.now())
    return fail(c, 401, "That device sign-in has expired. Run `gm auth login` again.");
  const body = await readJson<{ name?: string }>(c).catch(() => ({ name: undefined }));
  const name = (body.name?.trim() || "gm CLI").slice(0, 80);
  const created = await issueToken(c.env.DB, session.userId, name, "write");
  // The session only existed to make this exchange.
  await db(c.env.DB).deleteFrom("auth_sessions").where("id", "=", session.id).execute();
  return c.json(created, 201);
});

tokens.delete("/:id", async (c) => {
  const actor = requirePerson(c);
  if (actor instanceof Response) return actor;
  const { numDeletedRows } = await db(c.env.DB)
    .deleteFrom("access_tokens")
    .where("id", "=", c.req.param("id"))
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  return numDeletedRows ? c.body(null, 204) : fail(c, 404, "No such token.");
});
