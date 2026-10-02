// An in-process registry with gitmatrix around it: the registry's catalog in
// one fake D1 and gitmatrix's own tables (accounts, orgs, repositories, tokens,
// CI) in another, both built from their real migrations.
//
// Feeds created by tests belong to the org `test` (OWNER_ID), whose members get
// write. Tokens are real gitmatrix tokens for real accounts. Calls to the old
// artifatrix admin API that the protocol tests still make are translated:
//
//   PUT /api/v1/repositories/:key/permissions {principal, role}
//        admin → org owner, write → org member, read → outside collaborator
//   POST/PATCH /api/v1/repositories[/:key]   → core createRepo / updateRepo
//   GET  /api/v1/audit?repo=:key             → the feed's audit log
//   /api/v1/<format>/…                       → /api/registry/<format>/…

import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FakeD1, FakeQueue, FakeR2Bucket } from "@gitmatrix/testing";
import { isFormatId } from "@gitmatrix/formats/info";

import { buildRegistry } from "../app.ts";
import { JOB_TOKEN_PREFIX, TOKEN_PREFIX } from "../core/auth/authenticate.ts";
import { resetRegistryTokenKeys } from "../core/auth/registry-token.ts";
import type { Actor } from "../core/auth/actor.ts";
import { outsideServices } from "../core/context.ts";
import { createDb, parseJson } from "../core/db.ts";
import { asRegistryError } from "../core/errors.ts";
import {
  createRepo as createFeed,
  getRepoById,
  invalidateRepoCache,
  sealConfig,
  updateRepo,
  type Repository,
} from "../core/repos.ts";
import { resetDerivedKeys } from "../core/secrets.ts";
import { RepoLogic } from "../do/repo-logic.ts";

const REGISTRY_MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url).href);
const GITMATRIX_MIGRATIONS = fileURLToPath(new URL("../../migrations/", import.meta.url).href);
/** Development accounts (personas, Orbit Labs): local-only, applied after the migrations. */
const GITMATRIX_SEED = fileURLToPath(new URL("../../seed/", import.meta.url).href);
export const REGISTRY_URL = "https://pkg.test";
/** The org that owns every feed tests create. */
export const OWNER_ID = "acc_test";

/** In-process Durable Object namespace: one plain object per name. */
class FakeNamespace<T> {
  private readonly instances = new Map<string, T>();
  private readonly create: () => T;
  constructor(create: () => T) {
    this.create = create;
  }
  idFromName(name: string): string {
    return name;
  }
  get(id: string): T {
    let instance = this.instances.get(id);
    if (!instance) {
      instance = this.create();
      this.instances.set(id, instance);
    }
    return instance;
  }
}

/** Rebuilds run immediately so tests see indexes right after a publish. */
class FakeRepoObject {
  private readonly logic: RepoLogic;
  constructor(logic: RepoLogic) {
    this.logic = logic;
  }
  /** Like the real object: a separate context, reached by copies of the arguments. */
  mutate(repoId: string, op: string, payload: unknown, actor?: Actor) {
    return outsideServices(() =>
      this.logic.mutate(repoId, op, structuredClone(payload), structuredClone(actor)),
    );
  }
  requestRebuild(repoId: string) {
    return this.logic.rebuild(repoId);
  }
  rebuildNow(repoId: string) {
    return this.logic.rebuild(repoId);
  }
  lease(key: string, ttlMs: number) {
    return this.logic.lease(key, ttlMs);
  }
  release(key: string) {
    this.logic.release(key);
  }
}

class FakeStateObject {
  private state: unknown = null;
  private version: number | null = null;
  expiresAt: number | null = null;
  async getState<T>(): Promise<T | null> {
    return this.state as T | null;
  }
  async putState<T extends { version: number }>(
    state: T,
    expected: number | null,
  ): Promise<boolean> {
    if (this.version !== expected) return false;
    this.state = state;
    this.version = state.version;
    return true;
  }
  async expireAt(at: number): Promise<void> {
    this.expiresAt = at;
  }
  async clear(): Promise<void> {
    this.state = null;
    this.version = null;
  }
}

class FakeLoginObject {
  private state: {
    status: "pending" | "done" | "taken";
    doneSecretHash: string;
    token?: string;
    expiresAt: number;
  } | null = null;
  async start(state: NonNullable<FakeLoginObject["state"]>) {
    this.state = state;
  }
  async peek() {
    return this.state && this.state.expiresAt > Date.now() ? this.state : null;
  }
  async complete(token: string) {
    if (!this.state || this.state.status !== "pending") return false;
    this.state = { ...this.state, status: "done", token };
    return true;
  }
  async take(hash: string) {
    const state = await this.peek();
    if (!state || state.doneSecretHash !== hash) return null;
    if (state.status !== "done") return { status: state.status };
    this.state = { ...state, status: "taken", token: undefined };
    return { status: "done" as const, token: state.token };
  }
}

export interface JobCredential {
  token: string;
  repoId: string;
  jobId: string;
  runId: string;
  commit: string;
}

export interface Harness {
  env: Env;
  /** The registry's catalog. */
  db: FakeD1;
  /** gitmatrix's own tables. */
  gitmatrix: FakeD1;
  bucket: FakeR2Bucket;
  queue: FakeQueue;
  app: ReturnType<typeof buildRegistry>;
  request(path: string, init?: RequestInit): Promise<Response>;
  /**
   * A gitmatrix token for `user` (created if new, with no access yet). Scopes
   * other than read-only become a write token.
   */
  token(user?: string, scopes?: string[]): string;
  /** A site admin's token. */
  adminToken(): Promise<string>;
  /** A running CI job's credential, in a repository of the `test` org (or `owner`). */
  jobToken(options?: { repo?: string; owner?: string; ref?: string }): JobCredential;
  /** Give `user` a role over everything the test org publishes. */
  grant(user: string, role: "read" | "write" | "admin"): void;
  createRepo(input: Record<string, unknown>): Promise<Response>;
}

export function basic(token: string, user = "token"): string {
  return `Basic ${btoa(`${user}:${token}`)}`;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;

function migrate(db: FakeD1, dir: string): void {
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    db.applySql(readFileSync(`${dir}${file}`, "utf8"));
  }
}

export async function makeHarness(
  overrides: Partial<Record<string, unknown>> = {},
): Promise<Harness> {
  resetRegistryTokenKeys();
  resetDerivedKeys();
  invalidateRepoCache();

  const db = new FakeD1();
  migrate(db, REGISTRY_MIGRATIONS);
  const gitmatrix = new FakeD1();
  migrate(gitmatrix, GITMATRIX_MIGRATIONS);
  migrate(gitmatrix, GITMATRIX_SEED);
  gitmatrix.applySql(
    `INSERT INTO accounts (id, kind, slug, display_name, member_repo_role)
     VALUES (${quote(OWNER_ID)}, 'org', 'test', 'Test Org', 'write')`,
  );

  const bucket = new FakeR2Bucket();
  const queue = new FakeQueue();
  const env = {
    DB: gitmatrix,
    REGISTRY_DB: db,
    REGISTRY_BLOBS: bucket,
    REGISTRY_JOBS: queue,
    DEV_MODE: "false",
    PUBLIC_URL: REGISTRY_URL,
    REGISTRY_KEK: btoa("k".repeat(32)),
    ...overrides,
  } as unknown as Env;
  const repoNamespace = new FakeNamespace(() => new FakeRepoObject(new RepoLogic(env)));
  Object.assign(env, {
    REGISTRY_REPO: repoNamespace,
    REGISTRY_UPLOAD: new FakeNamespace(() => new FakeStateObject()),
    REGISTRY_LOGIN: new FakeNamespace(() => new FakeLoginObject()),
  });
  const kysely = createDb(db as unknown as D1Database);

  const app = buildRegistry();
  const send = (path: string, init?: RequestInit) =>
    Promise.resolve(app.request(new URL(path, REGISTRY_URL).toString(), init, env));

  const ensureUser = (user: string, admin = false) => {
    gitmatrix.applySql(
      `INSERT OR IGNORE INTO accounts (id, kind, slug, display_name, is_site_admin)
       VALUES (${quote(`acc_${user}`)}, 'user', ${quote(user)}, ${quote(user)}, ${admin ? 1 : 0})`,
    );
    return `acc_${user}`;
  };

  const mint = (userId: string, scope: "read" | "write") => {
    const secret = `${TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
    gitmatrix.applySql(
      `INSERT INTO access_tokens (id, user_id, name, scope, token_hash, last_four)
       VALUES (${quote(`tok_${randomBytes(8).toString("hex")}`)}, ${quote(userId)}, 'test',
         ${quote(scope)}, ${quote(sha256(secret))}, ${quote(secret.slice(-4))})`,
    );
    return secret;
  };

  const token = (user = "alice", scopes = ["packages:read", "packages:write"]) =>
    mint(ensureUser(user), scopes.some((s) => s !== "packages:read") ? "write" : "read");

  const adminToken = async () => mint(ensureUser("admin", true), "write");

  let repoCount = 0;
  const gitRepo = (owner: string, name: string) => {
    const id = `repo_${owner}_${name}`;
    gitmatrix.applySql(
      `INSERT OR IGNORE INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
       VALUES (${quote(id)}, ${quote(owner)}, ${quote(name)}, 'private',
         ${quote(`art_${++repoCount}_${name}`)}, 'https://artifacts.test')`,
    );
    return id;
  };

  const grant = (user: string, role: "read" | "write" | "admin") => {
    const userId = ensureUser(user);
    if (role === "read") {
      const repoId = gitRepo(OWNER_ID, "shared");
      gitmatrix.applySql(
        `INSERT OR REPLACE INTO repo_collaborators (repo_id, user_id, role)
         VALUES (${quote(repoId)}, ${quote(userId)}, 'read')`,
      );
      return;
    }
    gitmatrix.applySql(
      `INSERT OR REPLACE INTO org_members (org_id, user_id, role)
       VALUES (${quote(OWNER_ID)}, ${quote(userId)}, ${quote(role === "admin" ? "owner" : "member")})`,
    );
  };

  let jobCount = 0;
  const jobToken = (options: { repo?: string; owner?: string; ref?: string } = {}) => {
    const owner = options.owner ?? OWNER_ID;
    const repoId = gitRepo(owner, options.repo ?? "app");
    const n = ++jobCount;
    const runId = `run_${n}`;
    const jobId = `job_${n}`;
    const commit = sha256(`commit-${n}`).slice(0, 40);
    const secret = `${JOB_TOKEN_PREFIX}${randomBytes(16).toString("hex")}`;
    gitmatrix.applySql(
      `INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, title, status)
       VALUES (${quote(runId)}, ${quote(repoId)}, ${n}, ${quote(commit)},
         ${quote(options.ref ?? "main")}, 'push', 'test', 'running');
       INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner)
       VALUES (${quote(jobId)}, ${quote(runId)}, ${quote(repoId)}, 'build', '{}', 'running', 'local');
       INSERT INTO ci_job_tokens (token_hash, job_id, expires_at)
       VALUES (${quote(sha256(secret))}, ${quote(jobId)}, '2999-01-01T00:00:00.000Z');`,
    );
    return { token: secret, repoId, jobId, runId, commit };
  };

  const json = (body: unknown, status = 200) => Response.json(body, { status });

  const feedByKey = async (key: string): Promise<Repository | null> => {
    const row = await kysely
      .selectFrom("repositories")
      .select("id")
      .where("key", "=", key)
      .executeTakeFirst();
    return row ? getRepoById(kysely, row.id) : null;
  };

  /** `owner` puts the feed under another org (created on demand): access follows owners. */
  const createRepo = async ({ owner, ...input }: Record<string, unknown>) => {
    let ownerId = OWNER_ID;
    if (typeof owner === "string") {
      ownerId = `acc_${owner}`;
      gitmatrix.applySql(
        `INSERT OR IGNORE INTO accounts (id, kind, slug, display_name, member_repo_role)
         VALUES (${quote(ownerId)}, 'org', ${quote(owner)}, ${quote(owner)}, 'write')`,
      );
    }
    try {
      const sealed = await sealConfig(env, input);
      const repo = await createFeed(kysely, { ...sealed, ownerId } as never, "system");
      return json(repo, 201);
    } catch (error) {
      const e = asRegistryError(error);
      return json({ error: e.message, code: e.code }, e.status);
    }
  };

  /** The old admin API, translated into gitmatrix terms (see the header). */
  const request = async (path: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(path, REGISTRY_URL);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = () =>
      parseJson<Record<string, unknown>>(typeof init?.body === "string" ? init.body : "", {});
    const permissions = url.pathname.match(/^\/api\/v1\/repositories\/([^/]+)\/permissions$/);
    if (permissions && method === "PUT") {
      const { principal, role } = body() as { principal: string; role: "read" | "write" | "admin" };
      grant(principal.replace(/^user:/, ""), role);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/api/v1/repositories" && method === "POST") return createRepo(body());
    const repoMatch = url.pathname.match(/^\/api\/v1\/repositories\/([^/]+)$/);
    if (repoMatch && method === "PATCH") {
      const repo = await feedByKey(decodeURIComponent(repoMatch[1] as string));
      if (!repo) return json({ error: "not found" }, 404);
      try {
        return json(await updateRepo(kysely, repo, (await sealConfig(env, body())) as never));
      } catch (error) {
        const e = asRegistryError(error);
        return json({ error: e.message, code: e.code }, e.status);
      }
    }
    if (url.pathname === "/api/v1/audit") {
      const repo = await feedByKey(url.searchParams.get("repo") ?? "");
      const rows = await kysely
        .selectFrom("audit_log")
        .selectAll()
        .where("repo_id", "=", repo?.id ?? "")
        .orderBy("at", "desc")
        .orderBy("id", "desc")
        .execute();
      return json(rows.map((r) => ({ ...r, detail: parseJson(r.detail, {}) })));
    }
    const formatApi = url.pathname.match(/^\/api\/v1\/([a-z]+)(\/.*)$/);
    if (formatApi && isFormatId(formatApi[1] as string)) {
      return send(`/api/registry/${formatApi[1]}${formatApi[2]}${url.search}`, init);
    }
    return send(`${url.pathname}${url.search}`, init);
  };

  return {
    env,
    db,
    gitmatrix,
    bucket,
    queue,
    app,
    request,
    token,
    adminToken,
    jobToken,
    grant,
    createRepo,
  };
}
