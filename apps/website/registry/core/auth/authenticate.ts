// Native registry credentials do not use the application's JSON-version header.
// Every request re-resolves its credential, accountable person and optional agent.
import { personaActor } from "../../../worker/auth.ts";
import { createAuth } from "../../../worker/better-auth.ts";
import { resolveJobAuthority, WorkAuthorizationError } from "../../../worker/ci/admission.ts";
import { findUserById, type Actor as Person } from "../../../worker/db.ts";
import { db as gitmatrixDb, nowIso, type DB } from "../../../worker/schema.ts";
import { RegistryError } from "../errors.ts";
import {
  ANONYMOUS,
  scopesForTokenScope,
  type Actor,
  type CredentialReference,
  type JobIdentity,
} from "./actor.ts";
import { extractCredential } from "./extract.ts";
import { REGISTRY_TOKEN_ISSUER, verifyRegistryToken } from "./registry-token.ts";

export const TOKEN_PREFIX = "gmx_";
export const JOB_TOKEN_PREFIX = "gmj_";
const PERSONA_COOKIE = "gm_persona";
const SESSION_COOKIE = /(?:^|;\s*)(?:__Secure-)?gm\.session_token=/;

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fresh identity for ACL resolution, including a job's initiating person. */
export async function currentPerson(d1: D1Database, actor: Actor): Promise<Person | null> {
  const id = actor.personId ?? (actor.kind === "user" ? actor.subject : null);
  if (!id || actor.kind === "anonymous") return null;
  const person = await findUserById(d1, id);
  if (!person) return null;
  if (actor.agentId) {
    const agent = await gitmatrixDb(d1)
      .selectFrom("agents")
      .select(["id", "name"])
      .where("id", "=", actor.agentId)
      .where("accountable_id", "=", id)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    if (!agent) return null;
    person.agent = agent;
  }
  return person;
}

function personActor(
  person: Person,
  credential: CredentialReference,
  scope: "read" | "write",
): Actor {
  return {
    kind: "user",
    subject: person.id,
    personId: person.id,
    agentId: person.agent?.id ?? null,
    name: person.slug,
    email: null,
    scopes: scopesForTokenScope(scope),
    tokenId: credential.kind === "token" ? credential.id : null,
    via: credential.kind === "token" ? "token" : "session",
    credential,
    isSiteAdmin: person.isSiteAdmin,
  };
}

async function fromAccessToken(
  d1: D1Database,
  lookup: { hash: string } | { id: string },
): Promise<Actor | null> {
  let query = gitmatrixDb(d1)
    .selectFrom("access_tokens as t")
    .innerJoin("accounts as a", "a.id", "t.user_id")
    .select(["t.id", "t.scope", "t.agent_id", "t.user_id"])
    .where("a.kind", "=", "user")
    .where((eb) => eb.or([eb("t.expires_at", "is", null), eb("t.expires_at", ">", nowIso())]));
  query =
    "hash" in lookup
      ? query.where("t.token_hash", "=", lookup.hash)
      : query.where("t.id", "=", lookup.id);
  const row = await query.executeTakeFirst();
  if (!row) return null;
  const person = await currentPerson(d1, {
    ...ANONYMOUS,
    kind: "user",
    subject: row.user_id,
    agentId: row.agent_id,
  });
  return person ? personActor(person, { kind: "token", id: row.id }, row.scope) : null;
}

async function fromJobToken(env: Env, hash: string): Promise<Actor | null> {
  const row = await gitmatrixDb(env.DB)
    .selectFrom("ci_job_tokens as t")
    .innerJoin("ci_jobs as j", "j.id", "t.job_id")
    .innerJoin("ci_runs as r", "r.id", "j.run_id")
    .select([
      "j.id as job_id",
      "j.name as job_name",
      "j.repo_id",
      "r.id as run_id",
      "r.number",
      "r.commit_oid",
      "r.source_id",
      "r.ref",
    ])
    .where("t.token_hash", "=", hash)
    .where("t.expires_at", ">", nowIso())
    .where("j.status", "in", ["queued", "running"])
    .where("r.status", "in", ["queued", "running"])
    .executeTakeFirst();
  if (!row) return null;
  // This boundary checks current initiating credentials, Space rights and epoch,
  // not merely the still-running job or a claim copied into a registry JWT.
  const resolved = await resolveJobAuthority(env, row.job_id).catch((error: unknown) => {
    if (error instanceof WorkAuthorizationError) return null;
    const message =
      error instanceof Error &&
      (error.message === "space_cutover_fenced" || error.message === "migration_epoch_mismatch")
        ? error.message
        : "CI authorization is temporarily unavailable";
    throw new RegistryError("internal", message, undefined, 503);
  });
  if (!resolved) return null;
  const { authority, actor, repo } = resolved;
  if (repo.id !== row.repo_id || repo.space_id !== authority.spaceId) return null;
  const fullName = `${repo.space_slug}/${repo.name}`;
  const job: JobIdentity = {
    jobId: row.job_id,
    jobName: row.job_name,
    runId: row.run_id,
    runNumber: row.number,
    repoId: repo.id,
    spaceId: authority.spaceId,
    repo: fullName,
    commit: row.commit_oid,
    sourceId: row.source_id,
    ref: row.ref,
    defaultBranch: repo.default_branch,
  };
  return {
    kind: "job",
    subject: row.job_id,
    personId: actor.id,
    agentId: actor.agent?.id ?? null,
    name: fullName,
    email: null,
    scopes: scopesForTokenScope("write"),
    tokenId: null,
    via: "job",
    credential: { kind: "job", hash },
    job,
  };
}

async function fromSession(d1: D1Database, db: DB, id: string): Promise<Actor | null> {
  const session = await db
    .selectFrom("auth_sessions")
    .select("userId")
    .where("id", "=", id)
    .where("expiresAt", ">", nowIso())
    .executeTakeFirst();
  const person = session ? await findUserById(d1, session.userId) : null;
  return person ? personActor(person, { kind: "session", id }, "write") : null;
}

async function fromCookie(env: Env, headers: Headers): Promise<Actor | null> {
  const cookie = headers.get("cookie") ?? "";
  if (SESSION_COOKIE.test(cookie)) {
    const session = await (await createAuth(env)).api.getSession({ headers });
    return session ? fromSession(env.DB, gitmatrixDb(env.DB), session.session.id) : null;
  }
  if (env.DEV_MODE !== "true") return null;
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${PERSONA_COOKIE}=([^;]+)`));
  if (!match?.[1]) return null;
  let secret: string;
  try {
    secret = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const person = await personaActor(env, secret);
  return person?.credential?.kind === "token"
    ? fromAccessToken(env.DB, { id: person.credential.id })
    : null;
}

/** Fresh authority for stored upload actors and verified JWT claims.
 * The saved scopes/access remain caps; neither proves current authorization.
 */
export async function resolveCredentialActor(env: Env, claims: Actor): Promise<Actor | null> {
  if (claims.kind === "anonymous") return { ...ANONYMOUS, via: claims.via, access: claims.access };
  const ref = claims.credential;
  if (!ref) return null;
  let live: Actor | null;
  switch (ref.kind) {
    case "token":
      live = await fromAccessToken(env.DB, { id: ref.id });
      break;
    case "session":
      live = await fromSession(env.DB, gitmatrixDb(env.DB), ref.id);
      break;
    case "job":
      live = await fromJobToken(env, ref.hash);
      break;
  }
  if (
    !live ||
    live.kind !== claims.kind ||
    live.subject !== claims.subject ||
    live.personId !== claims.personId ||
    (live.agentId ?? null) !== (claims.agentId ?? null)
  )
    return null;
  return {
    ...live,
    via: claims.via,
    access: claims.access,
    scopes: new Set([...live.scopes].filter((scope) => claims.scopes.has(scope))),
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

/** Invalid supplied credentials never silently downgrade to anonymous. */
export async function authenticate(env: Env, headers: Headers): Promise<Actor> {
  const credential = extractCredential(headers);
  if (!credential) {
    const actor = await fromCookie(env, headers);
    if (actor) return actor;
    const cookie = headers.get("cookie") ?? "";
    if (
      SESSION_COOKIE.test(cookie) ||
      (env.DEV_MODE === "true" && new RegExp(`(?:^|;\\s*)${PERSONA_COOKIE}=`).test(cookie))
    ) {
      throw RegistryError.unauthorized("The session is invalid or expired");
    }
    return ANONYMOUS;
  }
  const token = credential.token;
  if (token.startsWith(TOKEN_PREFIX)) {
    const actor = await fromAccessToken(env.DB, { hash: await hashSecret(token) });
    if (!actor) throw RegistryError.unauthorized("The access token is invalid, expired or revoked");
    return actor;
  }
  if (token.startsWith(JOB_TOKEN_PREFIX)) {
    const actor = await fromJobToken(env, await hashSecret(token));
    if (!actor) throw RegistryError.unauthorized("The CI job token is invalid or the job ended");
    return actor;
  }
  if (token.split(".").length === 3 && unverifiedIssuer(token) === REGISTRY_TOKEN_ISSUER) {
    const claims = await verifyRegistryToken(env, token);
    const actor = claims ? await resolveCredentialActor(env, claims) : null;
    if (!actor)
      throw RegistryError.unauthorized(
        "The registry token or its underlying credential is invalid, expired or revoked",
      );
    return actor;
  }
  throw RegistryError.unauthorized("Unrecognised credential");
}
