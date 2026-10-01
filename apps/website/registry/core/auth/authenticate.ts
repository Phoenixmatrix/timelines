// Who is calling the registry, in gitmatrix's terms. Every ecosystem's client
// puts its secret somewhere different (extract.ts); what it can be:
//
//   gmx_…          a gitmatrix access token, or an SSH-key session (same table)
//   gmj_…          a CI job's credential, minted when the job starts and gone
//                  when it ends: the job publishes as its repository
//   <JWT>          a token this registry issued (Docker's token service)
//   gm_persona     the web app's sign-in cookie, for downloads from the UI

import { db as gitmatrixDb, nowIso, type DB } from "../../../worker/schema.ts";
import { RegistryError } from "../errors.ts";
import { ANONYMOUS, scopesForTokenScope, type Actor, type JobIdentity } from "./actor.ts";
import { extractCredential } from "./extract.ts";
import { REGISTRY_TOKEN_ISSUER, verifyRegistryToken } from "./registry-token.ts";

export const TOKEN_PREFIX = "gmx_";
export const JOB_TOKEN_PREFIX = "gmj_";
const PERSONA_COOKIE = "gm_persona";

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fromAccessToken(db: DB, secret: string): Promise<Actor | null> {
  const row = await db
    .selectFrom("access_tokens as t")
    .innerJoin("accounts as a", "a.id", "t.user_id")
    .select(["t.id as token_id", "t.scope", "a.id", "a.slug", "a.display_name", "a.is_site_admin"])
    .where("t.token_hash", "=", await hashSecret(secret))
    .where((eb) => eb.or([eb("t.expires_at", "is", null), eb("t.expires_at", ">", nowIso())]))
    .executeTakeFirst();
  if (!row) return null;
  return {
    kind: "user",
    subject: row.id,
    name: row.slug,
    email: null,
    scopes: scopesForTokenScope(row.scope),
    tokenId: row.token_id,
    via: "token",
    isSiteAdmin: row.is_site_admin === 1,
  };
}

async function fromJobToken(db: DB, secret: string): Promise<Actor | null> {
  const row = await db
    .selectFrom("ci_job_tokens as t")
    .innerJoin("ci_jobs as j", "j.id", "t.job_id")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .innerJoin("repos as p", "p.id", "j.repo_id")
    .innerJoin("accounts as o", "o.id", "p.owner_id")
    .select([
      "j.id as job_id",
      "j.name as job_name",
      "r.id as run_id",
      "r.number",
      "r.commit_oid",
      "r.ref",
      "p.id as repo_id",
      "p.owner_id",
      "p.name",
      "o.slug as owner_slug",
    ])
    .where("t.token_hash", "=", await hashSecret(secret))
    .where("t.expires_at", ">", nowIso())
    .where("j.status", "in", ["queued", "running"])
    .executeTakeFirst();
  if (!row) return null;
  const fullName = `${row.owner_slug}/${row.name}`;
  const job: JobIdentity = {
    jobId: row.job_id,
    jobName: row.job_name,
    runId: row.run_id,
    runNumber: row.number,
    repoId: row.repo_id,
    ownerId: row.owner_id,
    repo: fullName,
    commit: row.commit_oid,
    ref: row.ref,
  };
  return {
    kind: "job",
    subject: row.job_id,
    name: fullName,
    email: null,
    scopes: scopesForTokenScope("write"),
    tokenId: null,
    via: "job",
    job,
  };
}

async function fromCookie(db: DB, headers: Headers): Promise<Actor | null> {
  const cookie = headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${PERSONA_COOKIE}=([^;]+)`));
  if (!match?.[1]) return null;
  const row = await db
    .selectFrom("accounts")
    .select(["id", "slug", "display_name", "is_site_admin"])
    .where("id", "=", decodeURIComponent(match[1]))
    .where("kind", "=", "user")
    .executeTakeFirst();
  if (!row) return null;
  return {
    kind: "user",
    subject: row.id,
    name: row.slug,
    email: null,
    scopes: scopesForTokenScope("write"),
    tokenId: null,
    via: "session",
    isSiteAdmin: row.is_site_admin === 1,
  };
}

function unverifiedIssuer(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      iss?: unknown;
    };
    return typeof json.iss === "string" ? json.iss : null;
  } catch {
    return null;
  }
}

/**
 * Resolves the caller. No credential is anonymous; a credential that is
 * present but invalid is always a 401, never a silent downgrade.
 */
export async function authenticate(env: Env, headers: Headers): Promise<Actor> {
  const credential = extractCredential(headers);
  const db = gitmatrixDb(env.DB);
  if (!credential) return (await fromCookie(db, headers)) ?? ANONYMOUS;
  const token = credential.token;

  if (token.startsWith(TOKEN_PREFIX)) {
    const actor = await fromAccessToken(db, token);
    if (!actor) throw RegistryError.unauthorized("The access token is invalid or expired");
    return actor;
  }
  if (token.startsWith(JOB_TOKEN_PREFIX)) {
    const actor = await fromJobToken(db, token);
    if (!actor) throw RegistryError.unauthorized("The CI job token is invalid or the job ended");
    return actor;
  }
  if (token.split(".").length === 3 && unverifiedIssuer(token) === REGISTRY_TOKEN_ISSUER) {
    const actor = await verifyRegistryToken(env, token);
    if (!actor) throw RegistryError.unauthorized("The registry token is invalid or expired");
    return actor;
  }
  throw RegistryError.unauthorized("Unrecognised credential");
}
