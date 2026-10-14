import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { TokenScope } from "../shared/api.ts";
import { Timing } from "./timing.ts";
import { createAuth, SESSION_CACHE_SECONDS } from "./better-auth.ts";
import { actorFromRow, findSignedInUser, findUserById, sqlNow, type Actor } from "./db.ts";
import { db } from "./schema.ts";

export type AppEnv = {
  Bindings: Env;
  Variables: {
    actor: Actor | null;
    timing: Timing;
    /** This request's cutover admission reads, by contract version (requestAdmission). */
    admissions?: Map<number, Promise<{ allowed: boolean; epoch: number }>>;
  };
};

/**
 * This request's Server-Timing (app.ts starts it). A route reached without that
 * middleware (the cutover operator API, a sub-app under test) gets its own.
 */
export function requestTiming(c: Context<AppEnv>): Timing {
  let timing = c.get("timing") as Timing | undefined;
  if (!timing) c.set("timing", (timing = new Timing()));
  return timing;
}

// DEVELOPMENT ONLY. Picking a persona issues a real revocable credential.
// Production sign-in remains Better Auth (worker/better-auth.ts).
const PERSONA_COOKIE = "gm_persona";

/**
 * Better Auth's session cookie (with its __Secure- variant over HTTPS). Its
 * signed session cache (gm.session_data) means nothing without it, so only
 * this one says a request may be signed in.
 */
const SESSION_COOKIES = ["gm.session_token", "__Secure-gm.session_token"];

/** Requests that read: they may trust the signed session cache. */
const CACHED_SESSION_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * How long after a person's sessions were revoked (accounts.sessions_revoked_at)
 * their reads skip the signed session cache: its age, and a margin for the
 * clocks of the isolates that stamped the revocation and signed a cache.
 */
export const SESSION_REVOCATION_WINDOW_MS = SESSION_CACHE_SECONDS * 1000 + 30_000;

function revokedRecently(at: number | null, now = Date.now()): boolean {
  return at !== null && now - at < SESSION_REVOCATION_WINDOW_MS;
}

/**
 * The signed-in person, if any. A read trusts Better Auth's signed session
 * cookie cache (better-auth.ts SESSION_CACHE_SECONDS) instead of reading the
 * session from D1, unless the person's sessions were revoked within the
 * cache's age (accounts.sessions_revoked_at: any session of theirs deleted
 * through Better Auth, which covers sign-out, /revoke-session(s),
 * /revoke-other-sessions and /change-password, or an administrator's
 * `gm auth account password`). Then a cache signed before the revocation may
 * still be within its age, so the session is read from D1 as well, and a
 * revoked one is signed out at once. The person is read from D1 on every
 * request anyway (one query, with the stamp), so the common read costs no
 * more, and a removed account ends at once. Every other method reads the
 * session from D1, so no POST, PUT, PATCH or DELETE (minting a token, adding a
 * key) runs on a revoked session. Better Auth's own endpoints read D1
 * (better-auth.ts withoutSessionCache), the assistant, Tracker and delayed
 * work revalidate with isActorCredentialLive, and the registry re-reads the
 * session row. No endpoint returns another session's token (/list-sessions is
 * disabled; /get-session returns only the caller's own), and
 * /api/tokens/device trades only the device flow's session, never a
 * browser's.
 * Cookies Better Auth refreshes (the cache, an extended session) go out with
 * the response; after a D1 read for a revoked session, the ones expiring it.
 */
export async function sessionActor(c: Context<AppEnv>): Promise<Actor | null> {
  const timing = requestTiming(c);
  if (SESSION_COOKIES.some((name) => getCookie(c, name))) {
    const auth = await createAuth(c.env, new URL(c.req.url).origin, timing);
    const getSession = (cache: boolean) =>
      timing.measure(
        cache ? "session" : "session-db",
        auth.api.getSession({
          headers: c.req.raw.headers,
          query: cache ? {} : { disableCookieCache: true },
          returnHeaders: true,
        }),
      );
    const cache = CACHED_SESSION_METHODS.has(c.req.method);
    let { headers, response: session } = await getSession(cache);
    let person = session
      ? await timing.measure("user", findSignedInUser(c.env.DB, session.user.id))
      : null;
    // A cache signed before the revocation may still be within its age.
    if (person && cache && revokedRecently(person.sessionsRevokedAt)) {
      ({ headers, response: session } = await getSession(false));
      if (session?.user.id !== person.actor.id) person = null;
    }
    // Only the last read's cookies, so a revoked session's expire the cache.
    for (const cookie of headers?.getSetCookie() ?? [])
      c.header("set-cookie", cookie, { append: true });
    if (session) {
      const actor = person?.actor ?? null;
      if (actor) actor.credential = { kind: "session", id: session.session.id };
      return actor;
    }
  }
  const secret = getCookie(c, PERSONA_COOKIE);
  return secret ? timing.measure("persona", personaActor(c.env, secret)) : null;
}

/**
 * Sign out of Better Auth (if signed in) and drop the persona cookie. Better
 * Auth's sign-out deletes the session and expires both its cookie and the
 * signed session cache.
 */
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
  await endSession(c);
}

export async function startPersonaSession(c: Context<AppEnv>, accountId: string) {
  if (c.env.DEV_MODE !== "true") throw new Error("Persona sessions are development-only");
  const actor = await findUserById(c.env.DB, accountId);
  if (!actor) throw new Error("No such persona");
  await endSession(c);
  const secret = generateTokenSecret();
  await db(c.env.DB)
    .insertInto("access_tokens")
    .values({
      id: `tok_${crypto.randomUUID()}`,
      user_id: actor.id,
      name: "Development persona session",
      scope: "write",
      token_hash: await hashToken(secret),
      last_four: secret.slice(-4),
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    })
    .execute();
  setCookie(c, PERSONA_COOKIE, secret, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function endSession(c: Context<AppEnv>) {
  const secret = getCookie(c, PERSONA_COOKIE);
  if (c.env.DEV_MODE === "true" && secret?.startsWith(TOKEN_PREFIX))
    await db(c.env.DB)
      .deleteFrom("access_tokens")
      .where("token_hash", "=", await hashToken(secret))
      .execute();
  deleteCookie(c, PERSONA_COOKIE, { path: "/" });
}

/** Resolve a development persona using the same persisted credential checks as API tokens. */
export async function personaActor(env: Env, secret: string): Promise<Actor | null> {
  if (env.DEV_MODE !== "true" || !secret.startsWith(TOKEN_PREFIX)) return null;
  const credential = await credentialForSecret(env.DB, secret);
  return credential.kind === "token" ? credential.actor : null;
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

  return credentialForSecret(c.env.DB, secret);
}

async function credentialForSecret(d1: D1Database, secret: string): Promise<TokenCredential> {
  const row = await db(d1)
    .selectFrom("access_tokens as t")
    .innerJoin("accounts as a", "a.id", "t.user_id")
    .leftJoin("agents as g", "g.id", "t.agent_id")
    .select([
      "t.id as token_id",
      "t.scope",
      "t.agent_id",
      "g.name as agent_name",
      "g.revoked_at",
      "g.accountable_id",
    ])
    .selectAll("a")
    .where("t.token_hash", "=", await hashToken(secret))
    .where("a.kind", "=", "user")
    .where((eb) => eb.or([eb("t.expires_at", "is", null), eb("t.expires_at", ">", sqlNow)]))
    .executeTakeFirst();
  if (!row) return { kind: "invalid" };
  // A revoked agent's tokens stop working at once, even before they're deleted.
  if (row.agent_id && (row.revoked_at || !row.agent_name || row.accountable_id !== row.id))
    return { kind: "invalid" };
  const actor = actorFromRow(row);
  actor.credential = { kind: "token", id: row.token_id };
  if (row.agent_id && row.agent_name) actor.agent = { id: row.agent_id, name: row.agent_name };
  return { kind: "token", actor, scope: row.scope, tokenId: row.token_id };
}

/** Revalidate the initiating credential before delayed work; identity alone is not authority. */
export async function isActorCredentialLive(
  d1: D1Database,
  actor: Actor,
  requiredScope: TokenScope = "read",
): Promise<boolean> {
  const credential = actor.credential;
  if (!credential) return false;
  if (credential.kind === "session") {
    if (actor.agent) return false;
    const session = await db(d1)
      .selectFrom("auth_sessions as s")
      .innerJoin("accounts as p", "p.id", "s.userId")
      .select("s.id")
      .where("s.id", "=", credential.id)
      .where("s.userId", "=", actor.id)
      .where("p.kind", "=", "user")
      .where("s.expiresAt", ">", new Date().toISOString())
      .executeTakeFirst();
    return Boolean(session);
  }
  const token = await db(d1)
    .selectFrom("access_tokens as t")
    .innerJoin("accounts as p", "p.id", "t.user_id")
    .leftJoin("agents as g", "g.id", "t.agent_id")
    .select(["t.scope", "t.agent_id", "g.accountable_id", "g.revoked_at"])
    .where("t.id", "=", credential.id)
    .where("t.user_id", "=", actor.id)
    .where("p.kind", "=", "user")
    .where((eb) => eb.or([eb("t.expires_at", "is", null), eb("t.expires_at", ">", sqlNow)]))
    .executeTakeFirst();
  if (!token || (requiredScope === "write" && token.scope !== "write")) return false;
  if (token.agent_id !== (actor.agent?.id ?? null)) return false;
  return !token.agent_id || (token.accountable_id === actor.id && token.revoked_at === null);
}
