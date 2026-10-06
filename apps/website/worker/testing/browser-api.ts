// TESTS ONLY: the Worker's own API routes, in memory, for the browser-mode
// tests (src/**/*.browser.test.tsx; "Testing" in README.md). A page under
// test sends its /api requests here through a Vitest command
// (vite/browser-commands.ts), so what it reads is what the real routes answer
// over the migrated schema and the development seed, without a dev server.
//
// Each test makes its own "world": a database with the personas, the
// repositories it creates and the refs it pushes, and a tracker per account.
// Requests act as the world's persona. Bindings are the non-AI agent
// environment's: no model, index or queue; Artifacts remotes hold refs and
// accept ref-only pushes (worker/testing/remote.ts) but no objects; the
// Knowledge coordinator is always idle; CI runs are recorded, never run.
// Anything that needs more (file contents, CI runners, real sessions) belongs
// in a canned response or in E2E.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { AppEnv } from "../auth.ts";
import { accounts } from "../api/accounts.ts";
import { personalSkillsApi } from "../api/personal-skills.ts";
import { assistant } from "../api/assistant.ts";
import { dev } from "../api/dev.ts";
import { repos } from "../api/repos.ts";
import { workspaceAtlas } from "../atlas/workspace.ts";
import { atlas } from "../atlas/api.ts";
import { findRepo, findUserById } from "../db.ts";
import { knowledge } from "../knowledge/api.ts";
import { invalidateRefs } from "../objects.ts";
import { refs } from "../refs/api.ts";
import { trackerReleaseNotes } from "../release-notes/api.ts";
import { search } from "../search/api.ts";
import { aiProvidersApi } from "../ai-providers/api.ts";
import { aiSettingsApi, siteAiSettingsApi } from "../settings/ai.ts";
import { steps } from "../steps/api.ts";
import { timelines } from "../timelines/api.ts";
import { timelineGraph } from "../timelines/graph.ts";
import { resolveSource } from "../timelines/sources.ts";
import { Timing } from "../timing.ts";
import { tracker } from "../tracker/api.ts";
import { agents } from "../api/agents.ts";
import { Tracker } from "../tracker/object.ts";
import { fakeProviders, isProviderUrl } from "./ai-providers.ts";
import { d1, migratedDatabase } from "./d1.ts";
import { durableStorage } from "./durable.ts";
import { fakeRemotes } from "./remote.ts";

/** Who a world's requests act as: a seeded persona, or nobody (signed out). */
export type Persona = "priya" | "marco" | "jun" | "sam" | "fward" | null;

export interface ServedRequest {
  world: string;
  method: string;
  /** Path and query, e.g. /api/repos/orbit/engine. */
  url: string;
  headers: [string, string][];
  body: string | null;
  /** Act as this persona for just this request (a second person in the same world). */
  as?: Persona;
}

export interface ServedResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

const REMOTES = "https://artifacts.test";

interface World {
  persona: Persona;
  env: Env;
  git: ReturnType<typeof fakeRemotes>;
}

const worlds = new Map<string, World>();

function sqlFiles(dir: string): string[] {
  const path = fileURLToPath(dir);
  return readdirSync(path)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(path, f), "utf8"));
}

function registryDatabase(): DatabaseSync {
  const sqlite = new DatabaseSync(":memory:");
  for (const sql of sqlFiles(new URL("../../registry/migrations/", import.meta.url).href))
    sqlite.exec(sql);
  return sqlite;
}

/** A binding the in-memory API must never reach: the call fails loudly. */
function absent(name: string) {
  return new Proxy(
    {},
    {
      get(_, key) {
        if (key === "then") return undefined;
        throw new Error(`The in-memory API has no ${name} (${String(key)}).`);
      },
    },
  );
}

function createWorld(persona: Persona): string {
  const sqlite = migratedDatabase();
  for (const sql of sqlFiles(new URL("../../seed/", import.meta.url).href)) sqlite.exec(sql);
  const git = fakeRemotes();
  const trackers = new Map<string, Tracker>();
  const env: Env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registryDatabase()),
    DEV_MODE: "true",
    BETTER_AUTH_SECRET: "browser-tests-browser-tests-browser-tests",
    // Seals AI provider keys (CORE-294).
    REGISTRY_KEK: btoa("browser-tests-sealing-key-32-bytes"),
    // Tokens and the commits pushed; no trees or blobs.
    ARTIFACTS: {
      get: async (name: string) => ({
        ...(await git.artifacts.get(name)),
        readTree: async () => null,
        readBlob: async () => null,
        log: async () => [],
      }),
    },
    TRACKER: {
      getByName: (id: string) => {
        if (!trackers.has(id)) {
          const { sql, transactionSync } = durableStorage();
          const ctx = { storage: { sql, transactionSync } } as unknown as DurableObjectState;
          trackers.set(id, new Tracker(ctx, env));
        }
        return trackers.get(id);
      },
    },
    // Landing and previews start CI runs: here they start nothing.
    CI_RUNNER: "local",
    CI_RUN: { create: async () => ({}) },
    // Always idle: nothing builds here.
    KNOWLEDGE_COORDINATOR: {
      getByName: () => ({
        status: async () => ({ running: false, pending: false, overlays: {} }),
      }),
    },
    AI: undefined,
    SEARCH: absent("SEARCH"),
    VECTORS: absent("VECTORS"),
    KNOWLEDGE: absent("KNOWLEDGE"),
    KNOWLEDGE_QUEUE: absent("KNOWLEDGE_QUEUE"),
    KNOWLEDGE_BUILD: absent("KNOWLEDGE_BUILD"),
  } as unknown as Env;
  const id = randomUUID();
  worlds.set(id, { persona, env, git });
  return id;
}

function worldOf(id: string): World {
  const world = worlds.get(id);
  if (!world) throw new Error(`No browser-test world ${id}`);
  return world;
}

// The Workers cache, which object reads go through: always a miss here.
const scope = globalThis as unknown as { caches?: unknown };
scope.caches ??= {
  default: { match: async () => undefined, put: async () => {}, delete: async () => false },
};

// Artifacts' git endpoints are what the routes fetch: answer them from the
// world whose remote it is. TypeSafe and OpenRouter are answered in memory
// (worker/testing/ai-providers.ts). Every other fetch is left alone.
const realFetch = globalThis.fetch;
const providers = fakeProviders();
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (isProviderUrl(url)) return providers.fetch(input, init);
  if (!url.startsWith(`${REMOTES}/`)) return realFetch(input, init);
  const world = worlds.get(new URL(url).pathname.split("/")[1] ?? "");
  if (!world) return new Response("Not found", { status: 404 });
  return world.git.fetch(input, init);
};

// The subset of worker/app.ts's API that runs in memory, in the same order.
const app = new Hono<AppEnv>();
app.use(async (c, next) => {
  c.set("timing", new Timing());
  const world = worldOf(c.req.header("x-browser-test-world") ?? "");
  const persona = (c.req.header("x-browser-test-as") || world.persona) as Persona;
  // One of the world's agents, signed in as if with its token (its person's access).
  const agentId = c.req.header("x-browser-test-agent");
  if (agentId) {
    const agent = await c.env.DB.prepare("SELECT id, name, accountable_id FROM agents WHERE id = ?")
      .bind(agentId)
      .first<{ id: string; name: string; accountable_id: string }>();
    if (!agent) throw new Error(`No agent ${agentId}`);
    const person = await findUserById(c.env.DB, agent.accountable_id);
    c.set("actor", person ? { ...person, agent: { id: agent.id, name: agent.name } } : null);
  } else c.set("actor", persona ? await findUserById(c.env.DB, `acc_${persona}`) : null);
  await next();
});
app.route("/api/accounts/:owner/atlas", workspaceAtlas);
app.route("/api/agents", agents);
app.route("/api/accounts/:slug/settings/ai", aiSettingsApi);
app.route("/api/accounts/:slug/ai-providers", aiProvidersApi);
app.route("/api/admin/ai", siteAiSettingsApi);
app.route("/api", accounts);
app.route("/api/account/skills", personalSkillsApi);
app.route("/api/assistant", assistant);
app.route("/api/tracker/:owner/release-notes", trackerReleaseNotes);
app.route("/api/tracker/:owner/timelines", timelines);
app.route("/api/tracker/:owner/timeline-graph", timelineGraph);
app.route("/api", tracker);
app.route("/api/repos/:owner/:name/knowledge", knowledge);
app.route("/api/repos/:owner/:name/atlas", atlas);
app.route("/api/repos/:owner/:name/steps", steps);
app.route("/api/repos", repos);
app.route("/api/dev", dev);
app.route("/api/search", search);
app.route("/api/refs", refs);
app.notFound((c) => c.json({ error: "Not found." }, 404));
app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "Something went wrong on our side." }, 500);
});

/** A request from the page under test, answered by the real routes. */
export async function serve(request: ServedRequest): Promise<ServedResponse> {
  const world = worldOf(request.world);
  const headers = new Headers(request.headers);
  headers.set("x-browser-test-world", request.world);
  if (request.as !== undefined) headers.set("x-browser-test-as", request.as ?? "");
  const pending: Promise<unknown>[] = [];
  const response = await app.request(
    `http://localhost${request.url}`,
    { method: request.method, headers, body: request.body },
    world.env,
    {
      // Background work (cache warming) may fail without objects; it never answers.
      waitUntil: (work: Promise<unknown>) => void pending.push(work.catch(() => {})),
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
  await Promise.all(pending);
  return {
    status: response.status,
    headers: [...response.headers],
    body: await response.text(),
  };
}

async function remoteOf(world: World, repo: string, sourceId?: string | null) {
  const [owner, name] = repo.split("/");
  const row = await findRepo(world.env.DB, null, owner ?? "", name ?? "");
  if (!row) throw new Error(`No repository ${repo}`);
  const resolved = await resolveSource(world.env, row, sourceId);
  const remote = world.git.remotes.get(resolved.repo.artifacts_remote);
  if (!remote) throw new Error(`No source ${sourceId ?? "canonical"} for ${repo}`);
  return { artifacts: resolved.repo.artifacts_name, refs: remote.refs, commits: remote.commits };
}

/** Set up and change a world: what a test arranges before and while the page reads it. */
export async function world(action: string, input: unknown): Promise<unknown> {
  const args = (input ?? {}) as Record<string, string | null | undefined>;
  switch (action) {
    case "create":
      return { world: createWorld("persona" in args ? (args.persona as Persona) : "marco") };
    case "dispose":
      worlds.delete(args.world ?? "");
      return null;
    case "as":
      worldOf(args.world ?? "").persona = (args.persona as Persona) ?? null;
      return null;
    case "repo": {
      // A repository as `gm repo create` leaves it, without the Artifacts round trip.
      const world = worldOf(args.world ?? "");
      const id = `repo_${randomUUID()}`;
      const artifacts = `bt-${randomUUID()}`;
      const remote = `${REMOTES}/${args.world}/${artifacts}`;
      await world.env.DB.prepare(
        `INSERT INTO repos (id, owner_id, name, description, visibility, artifacts_name, artifacts_remote)
         VALUES (?, (SELECT id FROM accounts WHERE slug = ?), ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          args.owner ?? "",
          args.name ?? "",
          args.description ?? "",
          args.visibility ?? "public",
          artifacts,
          remote,
        )
        .run();
      world.git.add(remote, {}, "refs/heads/main", artifacts);
      return { id, owner: args.owner, name: args.name };
    }
    case "push": {
      // Move a branch, as a push would: the routes read it through ls-refs.
      const world = worldOf(args.world ?? "");
      const { artifacts, refs, commits } = await remoteOf(world, args.repo ?? "", args.sourceId);
      const ref = `refs/heads/${args.branch ?? "main"}`;
      if (args.commit) {
        refs.set(ref, args.commit);
        world.git.commits.add(args.commit);
        commits.add(args.commit);
      } else refs.delete(ref);
      invalidateRefs(artifacts);
      await world.env.DB.prepare(`UPDATE repos SET pushed_at = ? WHERE artifacts_name = ?`)
        .bind(new Date().toISOString(), artifacts)
        .run();
      return null;
    }
    case "refs": {
      const world = worldOf(args.world ?? "");
      return Object.fromEntries((await remoteOf(world, args.repo ?? "", args.sourceId)).refs);
    }
    case "sql": {
      // Rows only machinery the world lacks would write (CI runs,
      // deployments, wiki page sets, packages published from CI), as that
      // machinery would leave them; `database: "registry"` for the registry's.
      const {
        statement,
        params = [],
        database,
      } = input as { statement: string; params?: unknown[]; database?: "registry" };
      const world = worldOf(args.world ?? "");
      const target = database === "registry" ? world.env.REGISTRY_DB : world.env.DB;
      const { results } = await target
        .prepare(statement)
        .bind(...params)
        .all();
      return results;
    }
    default:
      throw new Error(`Unknown browser-test world action ${action}`);
  }
}
