import { Hono } from "hono";
import type { AccessToken, CreatedAccessToken, TokenScope } from "../../shared/api.ts";
import { generateTokenSecret, hashToken, type AppEnv } from "../auth.ts";
import { db } from "../schema.ts";
import { fail, readJson, requireActor } from "./http.ts";

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
    .orderBy("created_at", "desc")
    .execute();
  return c.json({ tokens: results.map(toToken) });
});

tokens.post("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<{ name: string; scope: TokenScope }>(c);
  const name = body.name?.trim() ?? "";
  if (!name || name.length > 80)
    return fail(c, 400, "Give the token a name of up to 80 characters.");
  if (body.scope !== "read" && body.scope !== "write") return fail(c, 400, "Choose read or write.");

  return c.json(await issueToken(c.env.DB, actor.id, name, body.scope), 201);
});

tokens.delete("/:id", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const { numDeletedRows } = await db(c.env.DB)
    .deleteFrom("access_tokens")
    .where("id", "=", c.req.param("id"))
    .where("user_id", "=", actor.id)
    .executeTakeFirst();
  return numDeletedRows ? c.body(null, 204) : fail(c, 404, "No such token.");
});
