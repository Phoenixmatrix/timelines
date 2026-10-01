import { Hono } from "hono";
import type { AccessToken, CreatedAccessToken, TokenScope } from "../../shared/api.ts";
import { generateTokenSecret, hashToken, type AppEnv } from "../auth.ts";
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
  db: D1Database,
  userId: string,
  name: string,
  scope: TokenScope,
): Promise<CreatedAccessToken> {
  const secret = generateTokenSecret();
  const row = await db
    .prepare(
      `INSERT INTO access_tokens (id, user_id, name, scope, token_hash, last_four)
       VALUES (?, ?, ?, ?, ?, ?) RETURNING *`,
    )
    .bind(
      `tok_${crypto.randomUUID()}`,
      userId,
      name,
      scope,
      await hashToken(secret),
      secret.slice(-4),
    )
    .first<TokenRow>();
  if (!row) throw new Error("The token could not be saved.");
  return { ...toToken(row), secret };
}

export const tokens = new Hono<AppEnv>();

tokens.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM access_tokens WHERE user_id = ? ORDER BY created_at DESC",
  )
    .bind(actor.id)
    .all<TokenRow>();
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
  const { meta } = await c.env.DB.prepare("DELETE FROM access_tokens WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), actor.id)
    .run();
  return meta.changes ? c.body(null, 204) : fail(c, 404, "No such token.");
});
