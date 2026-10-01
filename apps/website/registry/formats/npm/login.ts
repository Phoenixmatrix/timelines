import { digestHex } from "@gitmatrix/formats/hash";

import { audit } from "../../core/audit.ts";
import { authenticate } from "../../core/auth/authenticate.ts";
import { loginObject, services, type AppContext } from "../../core/context.ts";
import { RegistryError } from "../../core/errors.ts";
import { randomToken } from "../../core/ids.ts";
import type { Repository } from "../../core/repos.ts";
import type { LoginState } from "../../do/login-do.ts";
import { readBodyText, readJsonBody } from "./common.ts";

/**
 * `npm login`. The legacy (CouchDB) flow takes a gitmatrix access token as the
 * password and hands it back as the npm token. The web flow parks a LoginDO,
 * sends the person to gitmatrix to approve, and lets the CLI collect a token
 * gitmatrix minted (through `completeNpmLogin`) exactly once.
 */

const LOGIN_TTL_MS = 10 * 60 * 1000;
const PUBLIC_ID = /^[A-Za-z0-9_-]{16,64}$/;

/** `PUT /-/user/org.couchdb.user:<name>` with `{name, password}`. */
export async function legacyLogin(
  c: AppContext,
  repo: Repository,
  user: string,
): Promise<Response> {
  const svc = services(c);
  const body = await readJsonBody<{ name?: unknown; password?: unknown }>(c, 64 * 1024);
  const password = typeof body?.password === "string" ? body.password.trim() : "";
  if (!password) throw RegistryError.unauthorized("Use a personal access token as the password");
  let actor;
  try {
    actor = await authenticate(svc.env, new Headers({ authorization: `Bearer ${password}` }));
  } catch {
    throw RegistryError.unauthorized("Log in with a gitmatrix access token as the password");
  }
  if (actor.kind === "anonymous") throw RegistryError.unauthorized();
  await audit(svc.db, actor, "npm.login", { repoId: repo.id, detail: { flow: "legacy", user } });
  return c.json({ ok: true, id: `org.couchdb.user:${user}`, token: password }, 201);
}

/** `POST /-/v1/login`: starts a web login. */
export async function startWebLogin(c: AppContext, repo: Repository): Promise<Response> {
  const svc = services(c);
  let hostname: string | undefined;
  try {
    const text = await readBodyText(c, 16 * 1024);
    const body = text ? (JSON.parse(text) as { hostname?: unknown }) : {};
    if (typeof body?.hostname === "string") hostname = body.hostname.slice(0, 255);
  } catch {
    // The body is advisory.
  }
  const publicId = randomToken(18);
  const doneSecret = randomToken(32);
  const now = Date.now();
  const state: LoginState = {
    status: "pending",
    doneSecretHash: await digestHex("SHA-256", doneSecret),
    createdAt: now,
    expiresAt: now + LOGIN_TTL_MS,
    ...(hostname ? { hostname } : {}),
    repo: repo.key,
  };
  await loginObject(svc.env, publicId).start(state);
  return c.json(
    {
      loginUrl: `${svc.baseUrl}/cli-auth/npm/${publicId}?registry=${encodeURIComponent(repo.key)}`,
      doneUrl: `${svc.baseUrl}/npm/${repo.key}/-/v1/done/${publicId}.${doneSecret}`,
    },
    200,
    { "cache-control": "no-store" },
  );
}

/** `GET /-/v1/done/<publicId>.<doneSecret>`: polled by the CLI. */
export async function webLoginDone(c: AppContext, id: string): Promise<Response> {
  const svc = services(c);
  const dot = id.indexOf(".");
  const publicId = dot === -1 ? "" : id.slice(0, dot);
  const secret = dot === -1 ? "" : id.slice(dot + 1);
  if (!PUBLIC_ID.test(publicId) || !secret) throw RegistryError.notFound("Unknown login");
  const result = await loginObject(svc.env, publicId).take(await digestHex("SHA-256", secret));
  const headers = { "cache-control": "no-store" };
  if (!result) throw RegistryError.notFound("Unknown or expired login");
  if (result.status === "pending") {
    return c.json({}, 202, { ...headers, "retry-after": "2" });
  }
  if (result.status === "done" && result.token)
    return c.json({ token: result.token }, 200, headers);
  return c.json({ error: "This login was already used" }, 410, headers);
}

/**
 * Called by gitmatrix's API once the person approved `publicId`, with a
 * token minted for them. False if the login is unknown, expired or used.
 */
export async function completeNpmLogin(
  env: Env,
  publicId: string,
  token: string,
): Promise<boolean> {
  if (!PUBLIC_ID.test(publicId) || !token) return false;
  return loginObject(env, publicId).complete(token);
}
