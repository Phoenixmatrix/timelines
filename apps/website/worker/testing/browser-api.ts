// TESTS ONLY: the Worker's own API routes, in memory, for the browser-mode
// tests (src/**/*.browser.test.tsx; "Testing" in README.md). A page under
// test sends its /api requests here through a Vitest command
// (vite/browser-commands.ts), so what it reads is what the real routes answer
// over the migrated schema and the development seed, without a dev server.
//
// Each test makes its own "world": a database with the personas, the
// repositories it creates and the refs it pushes, and a tracker per Space.
// Requests act as the world's persona. Bindings are the non-AI agent
// environment's: no model, index or queue; Artifacts remotes hold refs and
// accept ref-only pushes (worker/testing/remote.ts) but no objects; the
// Knowledge coordinator is always idle; CI runs are recorded, never run.
// Step feeds retain real records, but return finite SSE backlog snapshots:
// the Vitest command transport serializes responses and cannot hold streams open.
// Anything that needs more (file contents, CI runners, real sessions) belongs
// in a canned response or in E2E.

import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { isActorCredentialLive, type AppEnv } from "../auth.ts";
import { accounts } from "../api/accounts.ts";
import { personalSkillsApi } from "../api/personal-skills.ts";
import { assistant } from "../api/assistant.ts";
import { dev } from "../api/dev.ts";
import { repos } from "../api/repos.ts";
import { organizations } from "../api/organizations.ts";
import { spaces } from "../api/spaces.ts";
import { contentContractGate } from "../api/content-contract.ts";
import { workspaceAtlas } from "../atlas/workspace.ts";
import { atlas } from "../atlas/api.ts";
import { findRepo, findUserById } from "../db.ts";
import { knowledge } from "../knowledge/api.ts";
import { invalidateRefs } from "../objects.ts";
import { refs } from "../refs/api.ts";
import { trackerReleaseNotes } from "../release-notes/api.ts";
import { search } from "../search/api.ts";
import { aiProvidersApi } from "../ai-providers/api.ts";
import { aiSettingsApi, personAiSettingsApi, siteAiSettingsApi } from "../settings/ai.ts";
import {
  spaceRetentionApi,
  spaceRunsApi,
  personRetentionApi,
  personRunsApi,
  instanceRetentionApi,
} from "../retention/api.ts";
import { spaceUsageApi, personUsageApi, instanceUsageApi } from "../usage/report-api.ts";
import { steps } from "../steps/api.ts";
import { StepFeed, sseEvent, sseRemoved, type StepFeedAccess } from "../steps/feed.ts";
import { timelines } from "../timelines/api.ts";
import { timelineGraph } from "../timelines/graph.ts";
import { resolveSource } from "../timelines/sources.ts";
import { Timing } from "../timing.ts";
import { tracker } from "../tracker/api.ts";
import { adminAccounts } from "../api/admin-accounts.ts";
import { agents } from "../api/agents.ts";
import { createAuth } from "../better-auth.ts";
import { Tracker } from "../tracker/object.ts";
import { fakeProviders, isProviderUrl } from "./ai-providers.ts";
import { d1, migratedDatabase, migratedRegistryDatabase } from "./d1.ts";
import { fakeDurableObjectId, fakeDurableState } from "./durable-state.ts";
import { fakeRemotes } from "./remote.ts";
import { installCutoverTestControl } from "./space-cutover.ts";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";

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
  credentials: Map<string, string>;
  pending: Set<Promise<void>>;
  close(): void;
}

const worlds = new Map<string, World>();

function sqlFiles(dir: string): string[] {
  const path = fileURLToPath(dir);
  return readdirSync(path)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(path, f), "utf8"));
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

/** Real feed persistence and retention, with a finite command-transport response. */
class BrowserStepFeed extends StepFeed {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const raw = request.headers.get("last-event-id") ?? url.searchParams.get("after");
    const after = raw && /^\d+$/.test(raw) ? Number(raw) : 0;
    const access = JSON.parse(
      request.headers.get("x-step-feed-access") ?? "null",
    ) as StepFeedAccess | null;
    if (!access) return new Response("Step feed access required.", { status: 403 });
    // As the real feed replays: every removal (CORE-399), then the records after `after`.
    const backlog = await this.since(access, after);
    const removals = await this.removals();
    return new Response(
      `retry: 5000\n: ${backlog.length} record(s)\n\n${removals.map(sseRemoved).join("")}${backlog.map(sseEvent).join("")}`,
      {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
        },
      },
    );
  }
}

async function createWorld(persona: Persona): Promise<string> {
  const sqlite = migratedDatabase();
  const git = fakeRemotes();
  const trackers = new Map<string, Tracker>();
  const feeds = new Map<string, BrowserStepFeed>();
  const env: Env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(migratedRegistryDatabase()),
    DEV_MODE: "true",
    BETTER_AUTH_SECRET: "browser-tests-browser-tests-browser-tests",
    // Password sign-in counts failures here; nothing is ever locked out.
    AUTH_FAILURES: { limit: async () => ({ success: true }) },
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
      idFromName: fakeDurableObjectId,
      getByName: (id: string) => {
        if (!trackers.has(id)) {
          const ctx = fakeDurableState({ name: id }).ctx;
          trackers.set(id, new Tracker(ctx, env));
        }
        return trackers.get(id);
      },
    },
    STEP_FEED: {
      getByName: (name: string) => {
        if (!feeds.has(name))
          feeds.set(name, new BrowserStepFeed(fakeDurableState({ name }).ctx, env));
        return feeds.get(name)!;
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
  const cutover = installCutoverTestControl(env);
  await initializeFreshSpaceInstallation(env);
  sqlite.exec("BEGIN");
  try {
    for (const sql of sqlFiles(new URL("../../seed/", import.meta.url).href)) sqlite.exec(sql);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
  const id = randomUUID();
  worlds.set(id, {
    persona,
    env,
    git,
    credentials: new Map(),
    pending: new Set(),
    close: cutover.close,
  });
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
  const persona = (c.req.header("x-browser-test-as") ?? world.persona) as Persona;
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
  const actor = c.get("actor");
  if (actor) {
    const key = `${actor.id}:${actor.agent?.id ?? ""}`;
    let tokenId = world.credentials.get(key);
    if (!tokenId) {
      tokenId = `browser_token_${randomUUID()}`;
      const secret = randomUUID();
      await c.env.DB.prepare(
        `INSERT INTO access_tokens (id, user_id, agent_id, name, scope, token_hash, last_four)
         VALUES (?, ?, ?, 'browser fixture', 'write', ?, ?)`,
      )
        .bind(
          tokenId,
          actor.id,
          actor.agent?.id ?? null,
          createHash("sha256").update(secret).digest("hex"),
          secret.slice(-4),
        )
        .run();
      world.credentials.set(key, tokenId);
    }
    actor.credential = { kind: "token", id: tokenId };
    // Never replace a revoked/deleted fixture credential on the next request.
    if (!(await isActorCredentialLive(c.env.DB, actor))) c.set("actor", null);
  }
  await next();
});
app.use("/api/*", contentContractGate);
app.route("/api/organizations", organizations);
app.route("/api/spaces", spaces);
app.route("/api/spaces/:space/atlas", workspaceAtlas);
// Sign-in (password accounts, CORE-404). A session it starts doesn't change
// who the world acts as: that stays the persona.
app.on(["GET", "POST"], "/api/identity/*", async (c) =>
  (await createAuth(c.env, new URL(c.req.url).origin)).handler(c.req.raw),
);
app.route("/api/admin/accounts", adminAccounts);
app.route("/api/agents", agents);
app.route("/api/spaces/:space/settings/ai", aiSettingsApi);
app.route("/api/accounts/:person/settings/ai", personAiSettingsApi);
app.route("/api/spaces/:space/ai-providers", aiProvidersApi);
app.route("/api/admin/ai", siteAiSettingsApi);
app.route("/api/spaces/:space/retention", spaceRetentionApi);
app.route("/api/spaces/:space/retention/runs", spaceRunsApi);
app.route("/api/accounts/:person/retention", personRetentionApi);
app.route("/api/accounts/:person/retention/runs", personRunsApi);
app.route("/api/admin/retention", instanceRetentionApi);
app.route("/api/spaces/:space/usage", spaceUsageApi);
app.route("/api/accounts/:slug/usage", personUsageApi);
app.route("/api/admin/usage", instanceUsageApi);
app.route("/api", accounts);
app.route("/api/account/skills", personalSkillsApi);
app.route("/api/assistant", assistant);
app.route("/api/tracker/:space/release-notes", trackerReleaseNotes);
app.route("/api/tracker/:space/timelines", timelines);
app.route("/api/tracker/:space/timeline-graph", timelineGraph);
app.route("/api", tracker);
app.route("/api/repos/:space/:name/knowledge", knowledge);
app.route("/api/repos/:space/:name/atlas", atlas);
app.route("/api/repos/:space/:name/steps", steps);
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
  const finished = Promise.withResolvers<void>();
  world.pending.add(finished.promise);
  try {
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
  } finally {
    world.pending.delete(finished.promise);
    finished.resolve();
  }
}

async function remoteOf(world: World, repo: string, sourceId?: string | null) {
  const [space, name] = repo.split("/");
  const row = await findRepo(world.env.DB, null, space ?? "", name ?? "");
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
      return { world: await createWorld("persona" in args ? (args.persona as Persona) : "marco") };
    case "dispose": {
      const id = args.world ?? "";
      const current = worlds.get(id);
      if (current) {
        // Router revalidation can still be in flight when the page unmounts.
        while (current.pending.size) await Promise.all(current.pending);
        if (worlds.get(id) === current) {
          current.close();
          worlds.delete(id);
        }
      }
      return null;
    }
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
        `INSERT INTO repos (id, space_id, name, description, visibility, artifacts_name, artifacts_remote)
         VALUES (?, (SELECT id FROM spaces WHERE slug = ?), ?, ?, ?, ?, ?)`,
      )
        .bind(
          id,
          args.space ?? "",
          args.name ?? "",
          args.description ?? "",
          args.visibility ?? "public",
          artifacts,
          remote,
        )
        .run();
      world.git.add(remote, {}, "refs/heads/main", artifacts);
      return { id, space: args.space, name: args.name };
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
