// The API a browser-mode test's page talks to ("Testing" in README.md). It
// replaces `fetch` for the test: each /api request is answered by the first of
//
//   1. a canned handler the test registered with `on()` (the newest wins),
//   2. the world's in-memory server, when the test asked for one: the Worker's
//      real routes over the migrated schema and seed
//      (worker/testing/browser-api.ts, through a Vitest command),
//   3. otherwise a 404, reported in `unhandled`.
//
// Every request is recorded, so a test can say what a page read and what it
// never did.

import { commands } from "vite-plus/test/browser";
import { onTestFinished, vi } from "vite-plus/test";

export type Persona = "priya" | "marco" | "jun" | "sam" | "fward" | null;

interface Served {
  status: number;
  headers: [string, string][];
  body: string;
}

/** The commands vite/browser-commands.ts registers. */
interface Commands {
  gmWorld(action: string, input: unknown): Promise<unknown>;
  gmServe(request: {
    world: string;
    method: string;
    url: string;
    headers: [string, string][];
    body: string | null;
    as?: Persona;
  }): Promise<Served>;
  emulateMedia(media: {
    reducedMotion?: "reduce" | "no-preference";
    colorScheme?: "light" | "dark";
  }): Promise<void>;
  tap(selector: string): Promise<void>;
}

export const browserCommands = commands as unknown as Commands;

export interface CannedRequest {
  method: string;
  url: URL;
  params: Record<string, string | undefined>;
  body: unknown;
}

export type Canned = (request: CannedRequest) => unknown;

export interface Recorded {
  method: string;
  url: URL;
  status: number;
}

/** A JSON response with a status, for canned handlers that answer other than 200. */
export function reply(body: unknown, status = 200): Response {
  return status === 204
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
}

export class TestServer {
  readonly requests: Recorded[] = [];
  readonly unhandled: string[] = [];
  readonly world: string | null;
  #routes: { method: string; pattern: URLPattern; handler: Canned }[] = [];

  private constructor(world: string | null) {
    this.world = world;
  }

  /**
   * Replace `fetch` until the test ends. With `world`, unhandled /api requests
   * go to a fresh in-memory server acting as `persona` (marco by default).
   */
  static async start({
    world = false,
    persona = "marco",
  }: { world?: boolean; persona?: Persona } = {}): Promise<TestServer> {
    const id = world
      ? ((await browserCommands.gmWorld("create", { persona })) as { world: string }).world
      : null;
    const server = new TestServer(id);
    const fetch = vi
      .spyOn(window, "fetch")
      .mockImplementation((input, init) => server.#fetch(new Request(input, init)));
    onTestFinished(async () => {
      fetch.mockRestore();
      if (id) await browserCommands.gmWorld("dispose", { world: id });
    });
    return server;
  }

  /** Answer `method` requests to `pathname` (a URLPattern, e.g. /api/tracker/:owner) with `handler`. */
  on(method: string, pathname: string, handler: Canned): this;
  /** …or always with `value`. */
  on(method: string, pathname: string, value: object): this;
  on(method: string, pathname: string, handler: Canned | object): this {
    this.#routes.unshift({
      method: method.toUpperCase(),
      pattern: new URLPattern({ pathname }),
      handler: typeof handler === "function" ? (handler as Canned) : () => handler,
    });
    return this;
  }

  /** The requests since `mark` (a previous `requests.length`), optionally only those under `prefix`. */
  since(mark: number, prefix = "/api/"): Recorded[] {
    return this.requests.slice(mark).filter((r) => r.url.pathname.startsWith(prefix));
  }

  /** Call the world's server directly, as `as` (the world's persona by default), not as the page. */
  async call<T>(method: string, path: string, body?: unknown, as?: Persona): Promise<T> {
    const served = await this.#serve(
      method,
      path,
      body === undefined ? [] : [["content-type", "application/json"]],
      body === undefined ? null : JSON.stringify(body),
      as,
    );
    if (served.status >= 400)
      throw new Error(`${method} ${path}: ${served.status} ${served.body.slice(0, 500)}`);
    return (served.body ? JSON.parse(served.body) : undefined) as T;
  }

  /** Call the world's server as one of its agents (by id), as its token would. */
  async callAsAgent<T>(agentId: string, method: string, path: string, body?: unknown): Promise<T> {
    const served = await this.#serve(
      method,
      path,
      [
        ["x-browser-test-agent", agentId],
        ...(body === undefined
          ? []
          : ([["content-type", "application/json"]] as [string, string][])),
      ],
      body === undefined ? null : JSON.stringify(body),
    );
    if (served.status >= 400)
      throw new Error(`${method} ${path}: ${served.status} ${served.body.slice(0, 500)}`);
    return (served.body ? JSON.parse(served.body) : undefined) as T;
  }

  /** Act as someone else from now on (null: signed out). */
  async as(persona: Persona): Promise<void> {
    await browserCommands.gmWorld("as", { world: this.#world(), persona });
  }

  /** A repository in the world, as `gm repo create` leaves it. */
  async repo(owner: string, name: string, visibility: "public" | "private" = "public") {
    return (await browserCommands.gmWorld("repo", {
      world: this.#world(),
      owner,
      name,
      visibility,
    })) as { id: string; owner: string; name: string };
  }

  /** Move `branch` of `repo` (owner/name) to `commit`, as a push would; null deletes it. */
  async push(
    repo: string,
    branch: string,
    commit: string | null,
    sourceId?: string,
  ): Promise<void> {
    await browserCommands.gmWorld("push", { world: this.#world(), repo, branch, commit, sourceId });
  }

  /**
   * Run SQL against the world's database, for rows only machinery the world
   * lacks would write (CI runs, deployments, wiki page sets), as it would.
   */
  async sql<T = Record<string, unknown>>(statement: string, ...params: unknown[]): Promise<T[]> {
    return (await browserCommands.gmWorld("sql", {
      world: this.#world(),
      statement,
      params,
    })) as T[];
  }

  /** server.sql() against the registry's database (REGISTRY_DB): feeds, packages, publishes. */
  async registrySql<T = Record<string, unknown>>(
    statement: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return (await browserCommands.gmWorld("sql", {
      world: this.#world(),
      statement,
      params,
      database: "registry",
    })) as T[];
  }

  #world(): string {
    if (!this.world)
      throw new Error("This test server has no world: start it with { world: true }");
    return this.world;
  }

  async #serve(
    method: string,
    url: string,
    headers: [string, string][],
    body: string | null,
    as?: Persona,
  ): Promise<Served> {
    return browserCommands.gmServe({ world: this.#world(), method, url, headers, body, as });
  }

  async #fetch(request: Request): Promise<Response> {
    const url = new URL(request.url, location.origin);
    const aborted = () => new DOMException("The request was aborted.", "AbortError");
    if (request.signal.aborted) throw aborted();
    const response = await this.#answer(request, url);
    if (request.signal.aborted) throw aborted();
    this.requests.push({ method: request.method, url, status: response.status });
    return response;
  }

  async #answer(request: Request, url: URL): Promise<Response> {
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/"))
      return new Response("Not found", { status: 404 });
    for (const route of this.#routes) {
      if (route.method !== request.method) continue;
      const match = route.pattern.exec({ pathname: url.pathname });
      if (!match) continue;
      const text = await request.clone().text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON: the handler gets the text.
      }
      const result = await route.handler({
        method: request.method,
        url,
        params: match.pathname.groups,
        body,
      });
      return result instanceof Response ? result : reply(result);
    }
    if (this.world) {
      const served = await this.#serve(
        request.method,
        url.pathname + url.search,
        [...request.headers],
        request.method === "GET" || request.method === "HEAD" ? null : await request.text(),
      );
      return new Response(served.status === 204 ? null : served.body, {
        status: served.status,
        headers: served.headers,
      });
    }
    this.unhandled.push(`${request.method} ${url.pathname}${url.search}`);
    return reply({ error: "Not found." }, 404);
  }
}
