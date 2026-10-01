import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { TokenScope } from "../shared/api.ts";
import type { Timing } from "./timing.ts";
import { actorFromRow, findUserById, type AccountRow, type Actor } from "./db.ts";

export type AppEnv = { Bindings: Env; Variables: { actor: Actor | null; timing: Timing } };

// DEVELOPMENT ONLY. Picking a persona sets this cookie to their account id, with
// no secret involved. Real sign-in replaces this module's session half.
const PERSONA_COOKIE = "gm_persona";

export async function sessionActor(c: Context<AppEnv>): Promise<Actor | null> {
  const id = getCookie(c, PERSONA_COOKIE);
  return id ? findUserById(c.env.DB, id) : null;
}

export function startPersonaSession(c: Context<AppEnv>, accountId: string) {
  setCookie(c, PERSONA_COOKIE, accountId, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function endSession(c: Context<AppEnv>) {
  deleteCookie(c, PERSONA_COOKIE, { path: "/" });
}

// Personal access tokens: "gmx_" + 32 random base62 characters. Only the
// SHA-256 is stored, so a lost token can be revoked but never shown again.
const TOKEN_PREFIX = "gmx_";
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function generateTokenSecret(): string {
  // Bytes of 248 and up are skipped so every character is equally likely.
  let out = "";
  while (out.length < 32) {
    for (const byte of crypto.getRandomValues(new Uint8Array(48))) {
      if (byte < 248 && out.length < 32) out += ALPHABET[byte % 62];
    }
  }
  return TOKEN_PREFIX + out;
}

export async function hashToken(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type TokenCredential =
  | { kind: "anonymous" }
  | { kind: "invalid" }
  | { kind: "token"; actor: Actor; scope: TokenScope; tokenId: string };

/**
 * Resolve a personal access token from the Authorization header, for git and
 * for headless API use. Git sends `Basic user:token` after a 401 challenge; the
 * username is ignored and the token alone identifies the person. `Bearer token`
 * works too.
 */
export async function tokenCredential(c: Context<AppEnv>): Promise<TokenCredential> {
  const header = c.req.header("authorization");
  if (!header) return { kind: "anonymous" };

  let secret: string | undefined;
  const [scheme, value = ""] = header.split(" ", 2);
  if (scheme?.toLowerCase() === "basic") {
    let decoded: string;
    try {
      decoded = atob(value);
    } catch {
      return { kind: "invalid" };
    }
    const separator = decoded.indexOf(":");
    const username = separator === -1 ? decoded : decoded.slice(0, separator);
    const password = separator === -1 ? "" : decoded.slice(separator + 1);
    secret = password || username;
  } else if (scheme?.toLowerCase() === "bearer") {
    secret = value;
  }
  if (!secret?.startsWith(TOKEN_PREFIX)) return { kind: "invalid" };

  const row = await c.env.DB.prepare(
    `SELECT t.id AS token_id, t.scope, a.* FROM access_tokens t
     JOIN accounts a ON a.id = t.user_id WHERE t.token_hash = ?`,
  )
    .bind(await hashToken(secret))
    .first<AccountRow & { token_id: string; scope: TokenScope }>();
  if (!row) return { kind: "invalid" };
  return { kind: "token", actor: actorFromRow(row), scope: row.scope, tokenId: row.token_id };
}
