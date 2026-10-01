import { AsyncLocalStorage } from "node:async_hooks";

import type { Context } from "hono";

import { AccessControl } from "./acl.ts";
import { type Actor } from "./auth/actor.ts";
import { authenticate } from "./auth/authenticate.ts";
import { createDb, type DB } from "./db.ts";
import type { LoginDO } from "../do/login-do.ts";
import type { RepoDO } from "../do/repo-do.ts";
import type { Repository } from "./repos.ts";

/**
 * Everything a handler needs for one request. Authentication is lazy: public
 * reads never touch an access token, and a request authenticates at most once.
 */
export class Services {
  readonly db: DB;
  private actorPromise: Promise<Actor> | null = null;
  private accessPromise: Promise<AccessControl> | null = null;

  readonly env: Env;
  readonly request: Request;
  readonly waitUntil: (promise: Promise<unknown>) => void;
  readonly requestId: string;

  constructor(
    env: Env,
    request: Request,
    waitUntil: (promise: Promise<unknown>) => void,
    requestId: string = crypto.randomUUID(),
    presetActor?: Actor,
    db?: DB,
  ) {
    this.env = env;
    this.request = request;
    this.waitUntil = waitUntil;
    this.requestId = requestId;
    this.db = db ?? createDb(env.REGISTRY_DB);
    if (presetActor) this.actorPromise = Promise.resolve(presetActor);
  }

  get bucket(): R2Bucket {
    return this.env.REGISTRY_BLOBS;
  }

  /**
   * Public base URL, without a trailing slash: the registry shares gitmatrix's
   * host, so it is wherever the request arrived (PUBLIC_URL for background work).
   */
  get baseUrl(): string {
    const configured = Reflect.get(this.env, "PUBLIC_URL");
    if (typeof configured === "string" && configured) return configured.replace(/\/+$/, "");
    return new URL(this.request.url).origin;
  }

  actor(): Promise<Actor> {
    this.actorPromise ??= authenticate(this.env, this.request.headers);
    return this.actorPromise;
  }

  access(): Promise<AccessControl> {
    this.accessPromise ??= this.actor().then(
      (actor) => new AccessControl(this.db, this.env.DB, actor),
    );
    return this.accessPromise;
  }

  /** The Durable Object that serializes writes and index rebuilds for a feed. */
  repoObject(repo: Pick<Repository, "id">) {
    return repoObject(this.env, repo.id);
  }
}

/** Typed stubs: the config names the classes by string, so bindings can't infer them. */
export function repoObject(env: Env, repoId: string): DurableObjectStub<RepoDO> {
  const ns = env.REGISTRY_REPO as unknown as DurableObjectNamespace<RepoDO>;
  return ns.get(ns.idFromName(repoId));
}

export function loginObject(env: Env, name: string): DurableObjectStub<LoginDO> {
  const ns = env.REGISTRY_LOGIN as unknown as DurableObjectNamespace<LoginDO>;
  return ns.get(ns.idFromName(name));
}

/**
 * The request a registry handler is serving, so code deep in the catalog
 * (the publish gate, provenance) knows who is publishing without every format
 * threading it through.
 */
const current = new AsyncLocalStorage<Services>();

export function withServices<T>(services: Services, run: () => T): T {
  return current.run(services, run);
}

/**
 * Runs `run` with no request in scope, the way a Durable Object sees the
 * world: what crosses an RPC boundary is only what was passed.
 */
export function outsideServices<T>(run: () => T): T {
  return current.exit(run);
}

export function currentServices(): Services | undefined {
  return current.getStore();
}

export type AppEnv = {
  Bindings: Env;
  Variables: { services: Services; repo: Repository };
};

export type AppContext = Context<AppEnv>;

export function services(c: AppContext): Services {
  return c.get("services");
}
