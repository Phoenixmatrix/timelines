import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { TokenScope } from "../shared/api.ts";
import type { Timing } from "./timing.ts";
import { createAuth } from "./better-auth.ts";
import { actorFromRow, findUserById, sqlNow, type Actor } from "./db.ts";
import { db } from "./schema.ts";

export type AppEnv = { Bindings: Env; Variables: { actor: Actor | null; timing: Timing } };

// DEVELOPMENT ONLY. Picking a persona sets this cookie to their account id, with
// no secret involved. Real sign-in is Better Auth (worker/better-auth.ts).
const PERSONA_COOKIE = "gm_persona";

/** Better Auth's session cookie (with its __Secure- variant over HTTPS). */
const SESSION_COOKIES = ["gm.session_token", "__Secure-gm.session_token"];

export async function sessionActor(c: Context<AppEnv>): Promise<Actor | null> {
  if (SESSION_COOKIES.some((name) => getCookie(c, name))) {
    const auth = await createAuth(c.env, new URL(c.req.url).origin);
    const session = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
    if (session) return findUserById(c.env.DB, session.user.id);
  }
  if (c.env.DEV_MODE !== "true") return null;
  const id = getCookie(c, PERSONA_COOKIE);
  return id ? findUserById(c.env.DB, id) : null;
}

/** Sign out of Better Auth (if signed in) and drop the persona cookie. */
export async function endAllSessions(c: Context<AppEnv>) {
  if (SESSION_COOKIES.some((name) => getCookie(c, name))) {
    const auth = await createAuth(c.env, new URL(c.req.url).origin);
    const response = await auth.api.signOut({
      headers: c.req.raw.headers,
      asResponse: true,
    });
    for (const cookie of response.headers.getSetCookie())
      c.header("set-cookie", cookie, { append: true });
  }
  endSession(c);
}

export function startPersonaSession(c: Context<AppEnv>, accountId: string) {
  if (c.env.DEV_MODE !== "true") throw new Error("Persona sessions are development-only");
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
 * Resolve a personal access token (or an SSH session token, until it expires)
 * from the Authorization header, for git and for headless API use. Git sends `Basic user:token` after a 401 challenge; the
 * username is ignored and the token alone identifies the person. `Bearer token`
 * works too.
 */
/** The personal access token an Authorization header carries (Bearer, or Basic's password), if any. */
export function accessTokenSecret(header: string): string | undefined {
  let secret: string | undefined;
  const [scheme, value = ""] = header.split(" ", 2);
  if (scheme?.toLowerCase() === "basic") {
    let decoded: string;
    try {
      decoded = atob(value);
    } catch {
      return undefined;
    }
    const separator = decoded.indexOf(":");
    const username = separator === -1 ? decoded : decoded.slice(0, separator);
    const password = separator === -1 ? "" : decoded.slice(separator + 1);
    secret = password || username;
  } else if (scheme?.toLowerCase() === "bearer") {
    secret = value;
  }
  return secret?.startsWith(TOKEN_PREFIX) ? secret : undefined;
}

export async function tokenCredential(c: Context<AppEnv>): Promise<TokenCredential> {
  const header = c.req.header("authorization");
  if (!header) return { kind: "anonymous" };

  const secret = accessTokenSecret(header);
  if (!secret) return { kind: "invalid" };

  const row = await db(c.env.DB)
    .selectFrom("access_tokens as t")
    .innerJoin("accounts as a", "a.id", "t.user_id")
    .leftJoin("agents as g", "g.id", "t.agent_id")
    .select(["t.id as token_id", "t.scope", "t.agent_id", "g.name as agent_name", "g.revoked_at"])
    .selectAll("a")
    .where("t.token_hash", "=", await hashToken(secret))
    .where((eb) => eb.or([eb("t.expires_at", "is", null), eb("t.expires_at", ">", sqlNow)]))
    .executeTakeFirst();
  if (!row) return { kind: "invalid" };
  // A revoked agent's tokens stop working at once, even before they're deleted.
  if (row.agent_id && (row.revoked_at || !row.agent_name)) return { kind: "invalid" };
  const actor = actorFromRow(row);
  if (row.agent_id && row.agent_name) actor.agent = { id: row.agent_id, name: row.agent_name };
  return { kind: "token", actor, scope: row.scope, tokenId: row.token_id };
}
