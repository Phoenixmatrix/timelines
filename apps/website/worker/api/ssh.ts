// SSH keys over HTTPS. Workers speak HTTP, not the SSH protocol, so instead
// of an SSH handshake a client proves it holds a registered key by signing a
// one-time challenge, the way `ssh-keygen -Y sign` does, and gets a session
// token that git and the API accept like any other token:
//
//   POST /api/auth/ssh/challenge  {fingerprints}       -> SshChallenge
//        the first registered key among those offered (in the client's order,
//        like ssh trying identities), and a nonce for it
//   POST /api/auth/ssh/token      {nonce, signature}   -> SshSession
//        the SSHSIG of the challenge message; the nonce is single-use
//
// Keys are managed by their owner:
//   GET    /api/ssh-keys          list
//   POST   /api/ssh-keys          {title, key, scope}
//   DELETE /api/ssh-keys/:id      also ends that key's sessions

import { Hono, type Context } from "hono";
import type { SshChallenge, SshKey, SshSession, TokenScope } from "../../shared/api.ts";
import type { AppEnv } from "../auth.ts";
import { accountSummary, sqlNow, type AccountRow } from "../db.ts";
import { batch, db } from "../schema.ts";
import {
  challengeMessage,
  fingerprint,
  parsePublicKey,
  SSH_NAMESPACE,
  SshError,
  verifySshSig,
} from "../ssh.ts";
import { fail, readJson, requireActor } from "./http.ts";
import { issueToken } from "./tokens.ts";

const CHALLENGE_SECONDS = 120;
const SESSION_SECONDS = 60 * 60;
const MAX_OFFERED = 50;

interface KeyRow {
  id: string;
  user_id: string;
  title: string;
  key_type: string;
  public_key: string;
  fingerprint: string;
  scope: TokenScope;
  created_at: string;
  last_used_at: string | null;
}

const toKey = (row: KeyRow): SshKey => ({
  id: row.id,
  title: row.title,
  type: row.key_type,
  fingerprint: row.fingerprint,
  scope: row.scope,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
const origin = (c: Context<AppEnv>) => new URL(c.req.url).origin;

export const sshKeys = new Hono<AppEnv>();

sshKeys.get("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const results = await db(c.env.DB)
    .selectFrom("ssh_keys")
    .selectAll()
    .where("user_id", "=", actor.id)
    .orderBy("created_at", "desc")
    .execute();
  return c.json({ keys: results.map(toKey) });
});

sshKeys.post("/", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const body = await readJson<{ title: string; key: string; scope: TokenScope }>(c);
  const scope = body.scope ?? "write";
  if (scope !== "read" && scope !== "write") return fail(c, 400, "Choose read or write.");
  let key;
  try {
    key = parsePublicKey(body.key ?? "");
  } catch (error) {
    if (error instanceof SshError) return fail(c, 400, error.message);
    throw error;
  }
  const title = (body.title ?? "").trim() || key.comment || key.type;
  if (title.length > 80) return fail(c, 400, "Give the key a title of up to 80 characters.");
  const print = await fingerprint(key.blob);
  const existing = await db(c.env.DB)
    .selectFrom("ssh_keys")
    .select("user_id")
    .where("fingerprint", "=", print)
    .executeTakeFirst();
  if (existing) {
    return fail(
      c,
      409,
      existing.user_id === actor.id
        ? "You already added this key."
        : "This key is already in use by another account.",
    );
  }
  const row = await db(c.env.DB)
    .insertInto("ssh_keys")
    .values({
      id: `key_${crypto.randomUUID()}`,
      user_id: actor.id,
      title,
      key_type: key.type,
      public_key: key.text,
      fingerprint: print,
      scope,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return c.json<SshKey>(toKey(row), 201);
});

sshKeys.delete("/:id", async (c) => {
  const actor = requireActor(c);
  if (actor instanceof Response) return actor;
  const id = c.req.param("id");
  const [deleted] = await batch(c.env.DB, [
    db(c.env.DB)
      .deleteFrom("ssh_keys")
      .where("id", "=", id)
      .where("user_id", "=", actor.id)
      .returning("id"),
    // Explicit, in case foreign keys aren't enforced.
    db(c.env.DB)
      .deleteFrom("access_tokens")
      .where("ssh_key_id", "=", id)
      .where("user_id", "=", actor.id),
  ]);
  if (!deleted?.results.length) return fail(c, 404, "No such key.");
  return c.json({ ok: true });
});

export const sshAuth = new Hono<AppEnv>();

sshAuth.post("/challenge", async (c) => {
  const { fingerprints } = await readJson<{ fingerprints: string[] }>(c);
  const offered = (Array.isArray(fingerprints) ? fingerprints : [])
    .filter((f): f is string => typeof f === "string" && f.startsWith("SHA256:"))
    .slice(0, MAX_OFFERED);
  if (offered.length === 0) return fail(c, 400, "Offer at least one key fingerprint.");
  const results = await db(c.env.DB)
    .selectFrom("ssh_keys")
    .select(["id", "fingerprint"])
    .where("fingerprint", "in", offered)
    .execute();
  const byPrint = new Map(results.map((r) => [r.fingerprint, r.id]));
  const chosen = offered.find((f) => byPrint.has(f));
  if (!chosen) {
    return fail(
      c,
      401,
      "None of these SSH keys is registered. Add one with `gm auth ssh-key add` or under SSH keys in the web app.",
    );
  }
  const nonce = [...crypto.getRandomValues(new Uint8Array(24))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const expiresAt = inSeconds(CHALLENGE_SECONDS);
  await batch(c.env.DB, [
    db(c.env.DB).deleteFrom("ssh_challenges").where("expires_at", "<", sqlNow),
    db(c.env.DB)
      .insertInto("ssh_challenges")
      .values({ nonce, key_id: byPrint.get(chosen)!, origin: origin(c), expires_at: expiresAt }),
  ]);
  return c.json<SshChallenge>({
    fingerprint: chosen,
    nonce,
    message: challengeMessage(origin(c), nonce, chosen),
    namespace: SSH_NAMESPACE,
    expiresAt,
  });
});

sshAuth.post("/token", async (c) => {
  const { nonce, signature } = await readJson<{ nonce: string; signature: string }>(c);
  if (typeof nonce !== "string" || typeof signature !== "string") {
    return fail(c, 400, "Send the challenge nonce and its signature.");
  }
  // Single use: the challenge is gone whether or not the signature checks out.
  const challenge = await db(c.env.DB)
    .deleteFrom("ssh_challenges")
    .where("nonce", "=", nonce)
    .returning(["key_id", "origin", "expires_at"])
    .executeTakeFirst();
  if (!challenge || Date.parse(challenge.expires_at) < Date.now()) {
    return fail(c, 401, "That challenge expired or was already used. Ask for a new one.");
  }
  if (challenge.origin !== origin(c)) return fail(c, 401, "That challenge was for another server.");
  const key = await db(c.env.DB)
    .selectFrom("ssh_keys as k")
    .innerJoin("accounts as a", "a.id", "k.user_id")
    .selectAll("k")
    .select(["a.id as account_id", "a.kind", "a.slug", "a.display_name"])
    .where("k.id", "=", challenge.key_id)
    .executeTakeFirst();
  if (!key) return fail(c, 401, "That key was removed.");

  let valid = false;
  try {
    valid = await verifySshSig(
      signature,
      challengeMessage(challenge.origin, nonce, key.fingerprint),
      parsePublicKey(key.public_key),
    );
  } catch (error) {
    if (error instanceof SshError) return fail(c, 400, error.message);
    throw error;
  }
  if (!valid) return fail(c, 401, "The signature doesn't match the key.");

  const expiresAt = inSeconds(SESSION_SECONDS);
  const session = await issueToken(c.env.DB, key.user_id, `SSH: ${key.title}`, key.scope, {
    expiresAt,
    sshKeyId: key.id,
  });
  c.executionCtx.waitUntil(
    batch(c.env.DB, [
      db(c.env.DB).updateTable("ssh_keys").set({ last_used_at: sqlNow }).where("id", "=", key.id),
      db(c.env.DB)
        .deleteFrom("access_tokens")
        .where("ssh_key_id", "is not", null)
        .where("expires_at", "<", sqlNow),
    ]),
  );
  return c.json<SshSession>({
    token: session.secret,
    expiresAt,
    scope: key.scope,
    user: accountSummary({
      id: key.account_id,
      kind: key.kind,
      slug: key.slug,
      display_name: key.display_name,
    } as AccountRow),
    key: { fingerprint: key.fingerprint, title: key.title },
  });
});
