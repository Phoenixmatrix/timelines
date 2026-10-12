import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  CheckpointList,
  CheckpointView,
  TimelineChange,
  TimelineDetail,
  TimelineList,
} from "../../shared/timelines.ts";
import type { OpenRequests } from "../../shared/tracker.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { durableStorage } from "../testing/durable.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { Tracker } from "../tracker/object.ts";
import { tracker as trackerRoutes } from "../tracker/api.ts";
import { timelines } from "./api.ts";
import { TrackerError } from "../tracker/store.ts";
import { reconcileSourcePushes, retainProgress } from "../git/source-push.ts";
import { repos as repoRoutes } from "../api/repos.ts";
import { recoverSourcePush } from "../git/source-push.ts";
import { gitHttp } from "../git/http.ts";
import { FLUSH, pkt } from "../git/pktline.ts";
import { mintJobToken } from "../ci/registry.ts";
import { deliverRecoveredSourcePush } from "../git/source-push-delivery.ts";
import { drainDeletedRepoSources } from "../retention/work-sources.ts";
import { onPush } from "../ci/trigger.ts";
import {
  afterRun,
  retryApprovedLanding,
  settled,
  sweepApprovedLandings,
  sweepLandings,
} from "./landing.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
// Preview runs (CORE-79) are started through CI's startRun: seen here, not run.
const startRun = vi.hoisted(() => vi.fn());
vi.mock(import("../ci/trigger.ts"), async (original) => {
  const module = await original();
  return {
    ...module,
    startRun: (...args: Parameters<typeof module.startRun>) =>
      args[2].sourceRecovery ? module.startRun(...args) : startRun(...args),
  };
});

const oid = (n: number) => n.toString(16).padStart(40, "0");

afterEach(() => {
  vi.unstubAllGlobals();
  startRun.mockReset();
});

async function setup(missingRepoError?: (name: string) => Error) {
  vi.stubGlobal("caches", {
    default: { match: async () => undefined, put: async () => {}, delete: async () => false },
  });
  const sqlite = migratedDatabase();
  // Ann owns Orbit; Ben and Cat are members, and Ben can write to both its
  // repositories; Dan is outside. Ben's agent bot acts for him.
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, member_repo_role) VALUES
      ('ann', 'user', 'ann', 'Ann', NULL), ('ben', 'user', 'ben', 'Ben', NULL),
      ('cat', 'user', 'cat', 'Cat', NULL), ('dan', 'user', 'dan', 'Dan', NULL),
      ('orbit', 'org', 'orbit', 'Orbit', 'read');
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('orbit', 'ann', 'owner'), ('orbit', 'ben', 'member'), ('orbit', 'cat', 'member');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'bot', 'ben');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('app', 'orbit', 'app', 'private', 'r-app', 'https://app'),
      ('lib', 'orbit', 'lib', 'private', 'r-lib', 'https://lib'),
      ('side', 'ben', 'side', 'private', 'r-side', 'https://side');
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES
      ('app', 'ben', 'write'), ('lib', 'ben', 'write');
  `);
  const git = fakeRemotes();
  if (missingRepoError) {
    const get = git.artifacts.get;
    git.artifacts.get = async (name?: string) => {
      try {
        return await get(name);
      } catch (error) {
        if (name && error instanceof Error && "code" in error && error.code === "NOT_FOUND")
          throw missingRepoError(name);
        throw error;
      }
    };
  }
  const app = git.add("https://app", { "refs/heads/main": oid(1) });
  const lib = git.add("https://lib", { "refs/heads/main": oid(2) });
  git.add("https://side", { "refs/heads/main": oid(3) });
  vi.stubGlobal("fetch", git.fetch);
  const trackers = new Map<string, Tracker>();
  const contexts = new Map<string, DurableObjectState>();
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    // Landing (CORE-77) starts merge runs: their Workflow is a no-op here.
    CI_RUNNER: "local",
    CI_RUN: { create: async () => ({}) },
    TRACKER: {
      getByName: (id: string) => {
        if (!trackers.has(id)) {
          const { sql, transactionSync } = durableStorage();
          const ctx = { storage: { sql, transactionSync } } as unknown as DurableObjectState;
          contexts.set(id, ctx);
          trackers.set(id, new Tracker(ctx, env));
        }
        return trackers.get(id);
      },
    },
  } as unknown as Env;
  const server = new Hono<AppEnv>();
  server.onError((error, c) => {
    if (error instanceof TrackerError)
      return c.json({ code: error.code, error: error.message }, error.status);
    throw error;
  });
  server.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  server.route("/api/tracker/:owner/timelines", timelines);
  server.route("/api", trackerRoutes);
  server.route("/api/repos", repoRoutes);
  server.route("/", gitHttp);
  const tokens = {
    ann: (await issueToken(env.DB, "ann", "t", "write")).secret,
    ben: (await issueToken(env.DB, "ben", "t", "write")).secret,
    cat: (await issueToken(env.DB, "cat", "t", "write")).secret,
    dan: (await issueToken(env.DB, "dan", "t", "write")).secret,
    bot: (await issueToken(env.DB, "ben", "t", "write", undefined, "agt_bot")).secret,
    reader: (await issueToken(env.DB, "ben", "read-only", "read")).secret,
  };
  const pending: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (work: Promise<unknown>) => pending.push(work),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const raw = async (who: keyof typeof tokens, method: string, path: string, body?: unknown) => {
    const response = await server.request(
      `/api${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
      executionCtx,
    );
    await Promise.all(pending.splice(0));
    return { status: response.status, body: (await response.json()) as any };
  };
  const call = (who: keyof typeof tokens, method: string, path: string, body?: unknown) =>
    raw(who, method, `/tracker/orbit/timelines${path}`, body);
  const work = (slug = "search", repoId = "app") => {
    const row = sqlite
      .prepare(
        "SELECT artifacts_name, source_id FROM timeline_work_sources WHERE timeline_slug = ? AND repo_id = ?",
      )
      .get(slug, repoId) as { artifacts_name: string; source_id: string };
    return Object.assign(git.getByName(row.artifacts_name), { sourceId: row.source_id });
  };
  return {
    sqlite,
    git,
    app,
    lib,
    call,
    raw,
    work,
    env,
    trackers,
    contexts,
    server,
    tokens,
    executionCtx,
  };
}

describe("recent timeline presence", () => {
  afterEach(() => vi.useRealTimers());

  test("a reader need not participate, and presence polling never renews or creates presence", async () => {
    const t = await setup();
    const created = await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] });
    expect(created.status).toBe(201);
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    expect((await t.call("bot", "GET", "/search/presence")).body.agents).toEqual([]);
    expect((await t.call("bot", "GET", "")).status).toBe(200);
    expect((await t.call("ben", "GET", "/search/presence")).body.agents).toEqual([]);

    const detail = await t.call("bot", "GET", "/search");
    expect(detail.status).toBe(200);
    expect(detail.body.timeline.agentIds).toEqual([]);
    const first = await t.call("cat", "GET", "/search/presence");
    expect(first.status).toBe(200);
    expect(first.body.agents).toMatchObject([
      { id: "agt_bot", name: "bot", accountable: { slug: "ben", displayName: "Ben" } },
    ]);
    const seen = first.body.agents[0].lastSeenAt;

    vi.setSystemTime(now + 60_000);
    expect((await t.call("bot", "GET", "/search/presence")).body.agents[0].lastSeenAt).toBe(seen);
    expect((await t.call("bot", "GET", "/search")).status).toBe(200);
    const renewed = (await t.call("cat", "GET", "/search/presence")).body.agents;
    expect(renewed).toHaveLength(1);
    expect(renewed[0].lastSeenAt).not.toBe(seen);
    vi.setSystemTime(now + 11 * 60_000 + 1);
    expect((await t.call("bot", "GET", "/search/presence")).body.agents).toEqual([]);
  });

  test("denied and missing resources and rejected mutations neither expose nor capture presence", async () => {
    const t = await setup();
    expect((await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] })).status).toBe(
      201,
    );
    expect((await t.call("dan", "GET", "/search/presence")).status).toBe(403);
    expect((await t.call("bot", "GET", "/missing/presence")).status).toBe(404);
    expect((await t.call("bot", "GET", "/missing")).status).toBe(404);
    expect((await t.call("bot", "GET", "/search?limit=bad")).status).toBe(400);
    expect((await t.call("bot", "GET", "/search/checkpoints/99")).status).toBe(404);
    expect((await t.call("bot", "PATCH", "/search", { name: "" })).status).toBe(400);
    expect((await t.call("bot", "POST", "/search/land")).status).toBe(409);
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toEqual([]);

    t.sqlite.exec("DELETE FROM org_members WHERE org_id = 'orbit' AND user_id = 'ben'");
    expect((await t.call("bot", "GET", "/search")).status).toBe(403);
    expect((await t.call("bot", "GET", "/search/presence")).status).toBe(403);
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toEqual([]);
  });

  test.each(["/search/checkpoints", "/search/checkpoints/1", "/search/landing"])(
    "successful specific read %s records its timeline only",
    async (path) => {
      const t = await setup();
      expect(
        (
          await t.call("ben", "POST", "", {
            slug: "search",
            repos: ["orbit/app"],
            policy: "approval",
          })
        ).status,
      ).toBe(201);
      expect(
        (await t.call("ben", "POST", "", { slug: "other", repos: ["orbit/app"] })).status,
      ).toBe(201);
      t.work().commits.add(oid(9));
      t.work().refs.set("refs/heads/work", oid(9));
      expect((await t.call("ben", "POST", "/search/checkpoints", {})).status).toBe(201);
      expect((await t.call("bot", "GET", path)).status).toBe(200);
      expect((await t.call("cat", "GET", "/search/presence")).body.agents).toMatchObject([
        { id: "agt_bot" },
      ]);
      expect((await t.call("cat", "GET", "/other/presence")).body.agents).toEqual([]);
    },
  );

  test("historical participants expire while successful lifecycle actions refresh recent presence", async () => {
    const t = await setup();
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = Date.now();
    const created = await t.call("bot", "POST", "", {
      slug: "search",
      repos: ["orbit/app"],
      policy: "approval",
    });
    expect(created.status).toBe(201);
    expect(created.body.timeline.agentIds).toEqual(["agt_bot"]);
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toMatchObject([
      { id: "agt_bot" },
    ]);
    vi.setSystemTime(now + 11 * 60_000);
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toEqual([]);
    expect((await t.call("cat", "GET", "/search")).body.timeline.agentIds).toEqual(["agt_bot"]);
    expect((await t.call("bot", "PATCH", "/search", { name: "New name" })).status).toBe(200);
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toMatchObject([
      { id: "agt_bot" },
    ]);
    vi.setSystemTime(now + 22 * 60_000);
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toEqual([]);
    t.work().commits.add(oid(9));
    t.work().refs.set("refs/heads/work", oid(9));
    expect((await t.call("bot", "POST", "/search/checkpoints", {})).status).toBe(201);
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toMatchObject([
      { id: "agt_bot" },
    ]);
    vi.setSystemTime(now + 33 * 60_000);
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toEqual([]);
    expect((await t.call("bot", "POST", "/search/abandon")).status).toBe(200);
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toMatchObject([
      { id: "agt_bot" },
    ]);
  });

  test("revoking an agent removes it from recent presence without changing historical participants", async () => {
    const t = await setup();
    expect((await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app"] })).status).toBe(
      201,
    );
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toMatchObject([
      { id: "agt_bot" },
    ]);
    t.sqlite
      .prepare("UPDATE agents SET revoked_at = ? WHERE id = 'agt_bot'")
      .run(new Date().toISOString());
    expect((await t.call("cat", "GET", "/search/presence")).body.agents).toEqual([]);
    expect((await t.call("cat", "GET", "/search")).body.timeline.agentIds).toEqual(["agt_bot"]);
  });
});

describe("forking", () => {
  test("inherits stable repository identity after rename even when the old name is reused", async () => {
    const t = await setup();
    expect((await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] })).status).toBe(
      201,
    );
    const sourceId = t.work().sourceId;
    expect((await t.raw("ann", "PATCH", "/repos/orbit/app", { name: "renamed" })).status).toBe(200);
    t.sqlite.exec(`INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('replacement','orbit','app','private','r-replacement','https://replacement')`);
    const child = await t.call("ben", "POST", "", { slug: "child", parent: "search" });
    expect(child.status).toBe(201);
    expect(child.body.timeline.repos).toMatchObject([{ id: "app", name: "renamed" }]);
    expect(
      t.sqlite
        .prepare(
          "SELECT repo_id,fork_source_id FROM timeline_work_sources WHERE timeline_slug='child'",
        )
        .get(),
    ).toEqual({ repo_id: "app", fork_source_id: sourceId });
    expect(t.work("child").refs.get("refs/heads/work")).toBe(oid(1));
    expect(t.app.refs.get("refs/heads/main")).toBe(oid(1));
  });

  test("projects renamed repositories in live timeline and checkpoint views without rewriting history", async () => {
    const t = await setup();
    const created = await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] });
    expect(created.status).toBe(201);
    t.work().commits.add(oid(9));
    t.work().refs.set("refs/heads/work", oid(9));
    const made = await t.call("ben", "POST", "/search/checkpoints", { summary: "Before rename" });
    expect(made.status).toBe(201);
    const frozen = made.body as CheckpointView;
    expect((await t.raw("ann", "PATCH", "/repos/orbit/app", { name: "renamed" })).status).toBe(200);
    t.sqlite.exec(`INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES('replacement','orbit','app','private','r-replacement','https://replacement')`);

    const liveRepos = [{ ...created.body.timeline.repos[0], name: "renamed" }];
    expect((await t.call("cat", "GET", "/search")).body.timeline.repos).toEqual(liveRepos);
    expect((await t.call("cat", "GET", "")).body.timelines[0].repos).toEqual(liveRepos);
    const liveCheckpoint = {
      ...frozen.checkpoint,
      repos: [{ ...frozen.checkpoint.repos[0], name: "renamed" }],
    };
    expect((await t.call("cat", "GET", "/search/checkpoints/1")).body.checkpoint).toEqual(
      liveCheckpoint,
    );
    expect(
      (await t.call("cat", "GET", "/search/checkpoints")).body.checkpoints[0].checkpoint,
    ).toEqual(liveCheckpoint);
    const storedTimeline = await t.trackers.get("orbit")!.timeline("search", 0, 1);
    const storedCheckpoint = await t.trackers.get("orbit")!.checkpoint("search", "1");
    expect(storedTimeline).toMatchObject({
      ok: true,
      value: { timeline: { repos: created.body.timeline.repos } },
    });
    expect(storedCheckpoint).toMatchObject({ ok: true, value: { checkpoint: frozen.checkpoint } });
  });

  test("allocates isolated owned sources at main's tip without modifying canonical refs", async () => {
    const t = await setup();
    const created = await t.call("ben", "POST", "", {
      slug: "search",
      name: "Search rewrite",
      policy: "auto",
      repos: ["orbit/app", "orbit/lib"],
    });
    expect(created.status).toBe(201);
    const { timeline, bookmarks } = created.body as TimelineChange;
    expect(bookmarks.every((b) => b.ok)).toBe(true);
    expect(t.work().refs.get("refs/heads/work")).toBe(oid(1));
    expect(t.work("search", "lib").refs.get("refs/heads/work")).toBe(oid(2));
    expect(t.app.refs).toEqual(new Map([["refs/heads/main", oid(1)]]));
    expect(t.app.pushes).toEqual([]);
    expect(t.lib.pushes).toEqual([]);
    expect(timeline).toMatchObject({
      slug: "search",
      name: "Search rewrite",
      policy: "auto",
      parentId: null,
      forkPoint: { commits: { app: oid(1), lib: oid(2) } },
      repos: [
        {
          id: "app",
          owner: "orbit",
          name: "app",
          bookmark: "work",
          source: { sourceId: t.work().sourceId, kind: "timeline-work" },
        },
        {
          id: "lib",
          owner: "orbit",
          name: "lib",
          bookmark: "work",
          source: { sourceId: t.work("search", "lib").sourceId, kind: "timeline-work" },
        },
      ],
      accountableId: "ben",
      startedBy: "ben",
    });
    expect(
      t.sqlite
        .prepare(
          "SELECT repo_id, state, initial_token_revoked FROM timeline_work_sources ORDER BY repo_id",
        )
        .all(),
    ).toEqual([
      { repo_id: "app", state: "ready", initial_token_revoked: 1 },
      { repo_id: "lib", state: "ready", initial_token_revoked: 1 },
    ]);
    const list = (await t.call("cat", "GET", "")).body as TimelineList;
    expect(list.timelines.map((tl) => tl.slug)).toEqual(["search"]);
    const detail = (await t.call("cat", "GET", "/search")).body as TimelineDetail;
    expect(detail.events).toMatchObject([
      { kind: "fork", parentId: null, commits: { app: oid(1), lib: oid(2) }, actorId: "ben" },
    ]);
  });

  test("initializes an owned fork when native absence loses its code across RPC", async () => {
    const t = await setup((name) =>
      Object.assign(new Error(`ArtifactsError: Repository not found: ${name}.`), { remote: true }),
    );
    const created = await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] });
    expect(created.status).toBe(201);
    expect(t.work().refs.get("refs/heads/work")).toBe(oid(1));
    expect(
      t.sqlite.prepare("SELECT state, initial_token_revoked FROM timeline_work_sources").all(),
    ).toEqual([{ state: "ready", initial_token_revoked: 1 }]);
    expect(t.app.pushes).toEqual([]);
  });

  test("a fork whose connection dropped is made again under a fresh name, not waited on", async () => {
    const t = await setup();
    const original = t.git.artifacts.get;
    const attempted: string[] = [];
    vi.spyOn(t.git.artifacts, "get").mockImplementation(async (name) => {
      const resource = await original(name);
      if (name !== "r-app") return resource;
      return {
        ...resource,
        fork: async (newName, options) => {
          attempted.push(newName);
          // The first fork's connection drops; Artifacts may leave it in progress for good.
          if (attempted.length === 1)
            throw new Error("Peer closed WebSocket: 1006 WebSocket disconnected");
          return resource.fork(newName, options);
        },
      };
    });
    const created = await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] });
    expect(created.status).toBe(201);
    expect(attempted).toHaveLength(2);
    expect(attempted[1]).not.toBe(attempted[0]);
    expect(
      t.sqlite.prepare("SELECT artifacts_name, state FROM timeline_work_sources").all(),
    ).toEqual([{ artifacts_name: attempted[1], state: "ready" }]);
    expect(t.work().refs.get("refs/heads/work")).toBe(oid(1));
  });

  test("an unknown provider outcome fences the reservation instead of creating another fork", async () => {
    const t = await setup(() =>
      Object.assign(new Error("ArtifactsError: Internal error"), { remote: true }),
    );
    await expect(
      t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] }),
    ).rejects.toThrow();
    expect(t.sqlite.prepare("SELECT state FROM timeline_work_sources").all()).toEqual([
      { state: "creating" },
    ]);
    expect([...t.git.remotes.keys()].sort()).toEqual([
      "https://app",
      "https://lib",
      "https://side",
    ]);
    expect((await t.call("ben", "GET", "")).body.timelines).toEqual([]);
  });

  test("a fork from a timeline starts at its bookmarks, in its repositories by default", async () => {
    const t = await setup();
    const parent = await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app"] });
    expect(parent.body.timeline).toMatchObject({ startedBy: "agt_bot", agentIds: ["agt_bot"] });
    t.work().commits.add(oid(7));
    t.work().refs.set("refs/heads/work", oid(7));
    const child = await t.call("ben", "POST", "", { slug: "ranking", parent: "search" });
    expect(child.status).toBe(201);
    expect(t.work("ranking").refs.get("refs/heads/work")).toBe(oid(7));
    expect(child.body.timeline).toMatchObject({
      parentId: parent.body.timeline.id,
      repos: [
        {
          id: "app",
          bookmark: "work",
          logicalBase: { sourceId: t.work().sourceId, commit: oid(7) },
        },
      ],
    });
    // A repository the parent doesn't touch forks from main; a commit can be given.
    t.lib.commits.add(oid(8));
    const mixed = await t.call("ben", "POST", "", {
      slug: "mixed",
      parent: "search",
      repos: ["orbit/app", { repo: "orbit/lib", commit: oid(8) }],
    });
    expect(mixed.body.timeline.forkPoint.commits).toEqual({ app: oid(7), lib: oid(8) });
  });

  test("any member with write access may fork; others write no bookmark", async () => {
    const t = await setup();
    const cases: [Parameters<typeof t.call>[0], unknown, number][] = [
      ["cat", { slug: "a", repos: ["orbit/app"] }, 403],
      ["dan", { slug: "a", repos: ["orbit/app"] }, 403],
      ["ben", { slug: "a", repos: ["ben/side"] }, 400],
      ["ben", { slug: "a", repos: ["orbit/nope"] }, 404],
      ["ben", { slug: "a", repos: ["orbit/app"], policy: "yolo" }, 400],
      ["ben", { slug: "a" }, 400],
      ["ben", { slug: "a", repos: [{ repo: "orbit/app", commit: oid(99) }] }, 404],
      ["ben", { slug: "a", repos: ["orbit/app"], parent: "nope" }, 404],
    ];
    for (const [who, body, status] of cases) {
      const result = await t.call(who, "POST", "", body);
      expect(result.status).toBe(status);
    }
    expect(t.app.pushes).toEqual([]);
    expect((await t.call("ann", "GET", "")).body.timelines).toEqual([]);
  });

  test("reserved slugs are exclusive but canonical legacy bookmark names do not collide", async () => {
    const t = await setup();
    await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] });
    const again = await t.call("ann", "POST", "", { slug: "search", repos: ["orbit/lib"] });
    expect([again.status, again.body.code]).toEqual([409, "already_exists"]);
    t.lib.refs.set("refs/heads/timeline/taken", oid(2));
    const taken = await t.call("ben", "POST", "", { slug: "taken", repos: ["orbit/lib"] });
    expect(taken.status).toBe(201);
    expect(t.lib.refs.get("refs/heads/timeline/taken")).toBe(oid(2));
    expect(t.work("taken", "lib").refs.get("refs/heads/work")).toBe(oid(2));
  });

  test.each(["retry", "cancel"] as const)(
    "a refused allocation supports explicit %s without canonical compensation",
    async (action) => {
      const t = await setup();
      const prepare = t.env.DB.prepare.bind(t.env.DB);
      const admission = vi.spyOn(t.env.DB, "prepare").mockImplementation((query) => {
        const statement = prepare(query);
        if (query.includes("SET state='creating'")) {
          const bind = statement.bind.bind(statement);
          vi.spyOn(statement, "bind").mockImplementation((...values) => {
            if (values[1] === "lib")
              throw new TrackerError(409, "allocation_refused", "Allocation admission failed.");
            return bind(...values);
          });
        }
        return statement;
      });
      const result = await t.call("ben", "POST", "", {
        slug: "search",
        repos: ["orbit/app", "orbit/lib"],
      });
      admission.mockRestore();
      expect(result.status).toBe(409);
      const rows = t.sqlite
        .prepare("SELECT source_id, repo_id, state FROM timeline_work_sources ORDER BY repo_id")
        .all();
      expect(rows).toEqual([
        { source_id: t.work().sourceId, repo_id: "app", state: "ready" },
        { source_id: expect.stringMatching(/^work_/), repo_id: "lib", state: "reserved" },
      ]);
      expect(t.app.pushes).toEqual([]);
      expect(t.lib.pushes).toEqual([]);
      expect((await t.call("ben", "GET", "")).body.timelines).toEqual([]);
      if (action === "cancel") {
        const remove = t.git.artifacts.delete.bind(t.git.artifacts);
        let interrupted = false;
        vi.spyOn(t.git.artifacts, "delete").mockImplementation(async (name) => {
          await remove(name);
          if (!interrupted) {
            interrupted = true;
            throw new Error("interrupted after physical deletion");
          }
        });
        await expect(t.call("ben", "POST", "/search/abandon")).rejects.toThrow(
          "interrupted after physical deletion",
        );
        t.trackers.set("orbit", new Tracker(t.contexts.get("orbit")!, t.env));
        expect((await t.call("ben", "POST", "/search/abandon")).body).toEqual({
          cancelled: true,
          slug: "search",
          bookmarks: [],
        });
        expect((await t.call("ben", "POST", "/search/abandon")).status).toBe(200);
        expect(
          t.sqlite
            .prepare("SELECT state FROM timeline_work_sources WHERE timeline_slug='search'")
            .all(),
        ).toEqual([{ state: "purged" }, { state: "purged" }]);
        expect(t.app.refs.get("refs/heads/main")).toBe(oid(1));
        expect(t.lib.refs.get("refs/heads/main")).toBe(oid(2));
        t.sqlite.close();
        return;
      }
      const retried = await t.call("ben", "POST", "", {
        slug: "search",
        repos: ["orbit/app", "orbit/lib"],
      });
      expect(retried.status).toBe(201);
      expect(
        retried.body.timeline.repos.map(
          (repo: { source: { sourceId: string } }) => repo.source.sourceId,
        ),
      ).toEqual(rows.map((row) => row.source_id));
    },
  );
  test("cancels partial creation, drains its initializer, and cannot resurrect it", async () => {
    const t = await setup();
    await t.call("ben", "POST", "", { slug: "other", repos: ["orbit/app"] });
    const unrelated = t.work("other");
    const original = t.git.artifacts.get;
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    vi.spyOn(t.git.artifacts, "get").mockImplementation(async (name) => {
      const resource = await original(name);
      if (name !== "r-lib") return resource;
      return {
        ...resource,
        fork: async (newName, options) => {
          const result = await resource.fork(newName, options);
          entered.resolve();
          await resume.promise;
          return result;
        },
      };
    });
    const creating = t.call("ben", "POST", "", {
      slug: "partial",
      repos: ["orbit/app", "orbit/lib"],
    });
    await entered.promise;
    const tracker = t.trackers.get("orbit")!;
    const access = {
      actorId: "ben",
      principalId: "ben",
      agents: [],
      members: [],
      repos: [],
      owner: { id: "orbit", slug: "orbit", displayName: "Orbit" },
      canAdmin: false,
    };
    // RPC persists the cancellation fence before its first await.
    const cancelling = tracker.cancelReservedCreation(access, "partial");
    resume.resolve();
    expect((await creating).status).toBe(409);
    expect(await cancelling).toMatchObject({
      ok: true,
      value: { cancelled: true, slug: "partial" },
    });
    expect((await t.call("ben", "POST", "/partial/abandon")).status).toBe(200);
    expect(
      (await t.call("ben", "POST", "", { slug: "partial", repos: ["orbit/app", "orbit/lib"] })).body
        .code,
    ).toBe("creation_cancelled");
    const allocations = t.sqlite
      .prepare(
        "SELECT artifacts_name,state FROM timeline_work_sources WHERE timeline_slug='partial'",
      )
      .all();
    expect(allocations.map((row) => row.state)).toEqual(["purged", "purged"]);
    for (const row of allocations)
      expect(() => t.git.getByName(String(row.artifacts_name))).toThrow();
    expect(t.work("other").sourceId).toBe(unrelated.sourceId);
    expect(t.app.refs.get("refs/heads/main")).toBe(oid(1));
    expect(t.lib.refs.get("refs/heads/main")).toBe(oid(2));
    t.sqlite.close();
  });
});

describe("changing and abandoning", () => {
  test("any member flags it experimental", async () => {
    const t = await setup();
    await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] });
    const flagged = await t.call("cat", "PATCH", "/search", { experimental: true });
    expect(flagged.body).toMatchObject({ experimental: true, version: 2 });
    const bad = await t.call("cat", "PATCH", "/search", { policy: "auto" });
    expect(bad.status).toBe(400);
    const cleared = await t.call("bot", "PATCH", "/search", {
      experimental: false,
      expectedVersion: 2,
    });
    expect(cleared.body).toMatchObject({ experimental: false, version: 3 });
    const stale = await t.call("cat", "PATCH", "/search", {
      experimental: true,
      expectedVersion: 2,
    });
    expect(stale.status).toBe(409);
  });

  test("stalled lists leave experimental timelines out", async () => {
    const t = await setup();
    await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] });
    await t.call("ben", "POST", "", { slug: "ranking", repos: ["orbit/app"], experimental: true });
    const now = Date.now();
    const stalled = async () => (await t.call("cat", "GET", "?stalled=true")).body as TimelineList;
    // Fresh forks haven't stalled.
    expect((await stalled()).timelines).toEqual([]);
    // Eight quiet days later, past the default seven, only the one expected to land has.
    const later = vi.spyOn(Date, "now").mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);
    try {
      const list = await stalled();
      expect(list.timelines.map((timeline) => timeline.slug)).toEqual(["search"]);
      expect(list.idleDays).toBe(7);
      // Every timeline is still listed without the filter, and unflagging brings it in.
      const all = (await t.call("cat", "GET", "")).body as TimelineList;
      expect(all.timelines.map((timeline) => timeline.slug).sort()).toEqual(["ranking", "search"]);
      await t.call("cat", "PATCH", "/ranking", { experimental: false });
      expect((await stalled()).timelines.map((timeline) => timeline.slug).sort()).toEqual([
        "ranking",
        "search",
      ]);
    } finally {
      later.mockRestore();
    }
    expect((await t.call("cat", "GET", "?stalled=maybe")).status).toBe(400);
  });

  test("only the accountable person or the starting agent abandons; history stays", async () => {
    const t = await setup();
    await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app", "orbit/lib"] });
    t.work().commits.add(oid(9));
    t.work().refs.set("refs/heads/work", oid(9));
    for (const who of ["ann", "cat"] as const) {
      const refused = await t.call(who, "POST", "/search/abandon");
      expect([refused.status, refused.body.error]).toEqual([
        403,
        expect.stringMatching(/accountable person/),
      ]);
    }
    expect(t.work().refs.get("refs/heads/work")).toBe(oid(9));
    const done = await t.call("ben", "POST", "/search/abandon");
    expect(done.status).toBe(200);
    expect(done.body.timeline.status).toBe("abandoned");
    expect(t.work().refs.get("refs/heads/work")).toBe(oid(9));
    expect(t.work("search", "lib").refs.get("refs/heads/work")).toBe(oid(2));
    const detail = (await t.call("cat", "GET", "/search")).body as TimelineDetail;
    expect(detail.timeline.status).toBe("abandoned");
    expect(detail.events.map((e) => e.kind)).toEqual(["fork", "abandon"]);
    expect(detail.events[1]).toMatchObject({
      lastCommits: { app: oid(9), lib: oid(2) },
      actorId: "ben",
    });
    expect(
      t.sqlite.prepare("SELECT state FROM timeline_work_sources ORDER BY repo_id").all(),
    ).toEqual([{ state: "archived" }, { state: "archived" }]);
    // Again: nothing more to do, and no second event.
    const again = await t.call("bot", "POST", "/search/abandon");
    expect(again.status).toBe(200);
    expect(
      (await t.call("cat", "GET", "/search")).body.events.map(
        (event: { kind: string }) => event.kind,
      ),
    ).toEqual(["fork", "abandon"]);
  });
});

describe("checkpoints", () => {
  test("pin each bookmark's commit and main's, with its CI runs and previews; writers only", async () => {
    const t = await setup();
    await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app"] });
    expect((await t.call("bot", "POST", "/search/checkpoints", {})).body.code).toBe("no_work");

    t.work().commits.add(oid(9));
    t.work().refs.set("refs/heads/work", oid(9));
    t.sqlite.exec(`
      INSERT INTO ref_updates (id, repo_id, source_id, ref, old_oid, new_oid)
        VALUES (1, 'app', '${t.work().sourceId}', 'refs/heads/work', '${oid(1)}', '${oid(9)}');
      INSERT INTO change_refs (repo_id, source_id, change_id, ref, first_commit_oid, first_update_id, last_commit_oid)
        VALUES ('app', '${t.work().sourceId}', 'kxyz', 'refs/heads/work', '${oid(8)}', 1, '${oid(9)}');
      INSERT INTO ci_runs (id, repo_id, source_id, number, commit_oid, ref, trigger, status)
        VALUES ('run1', 'app', '${t.work().sourceId}', 4, '${oid(9)}', 'work', 'push', 'succeeded'),
               ('run0', 'app', 'canonical', 3, '${oid(1)}', 'main', 'push', 'succeeded');
    `);
    // Cat can read the repository but not write to it.
    expect((await t.call("cat", "POST", "/search/checkpoints", { syncMain: true })).status).toBe(
      403,
    );
    const created = await t.call("bot", "POST", "/search/checkpoints", { summary: "Ranking v2" });
    expect(created.status).toBe(201);
    const made = created.body as CheckpointView;
    expect(made).toMatchObject({
      timeline: { slug: "search", policy: "approval" },
      checkpoint: {
        number: 1,
        summary: "Ranking v2",
        actorId: "agt_bot",
        accountableId: "ben",
        repos: [
          {
            id: "app",
            owner: "orbit",
            name: "app",
            commit: oid(9),
            base: oid(1),
            changes: [{ changeId: "kxyz", commit: oid(9) }],
          },
        ],
      },
      current: true,
      approval: null,
      runs: [{ repoId: "app", number: 4, status: "succeeded", commit: oid(9) }],
      previews: [],
    });
    expect((await t.call("bot", "POST", "/search/checkpoints", {})).body.code).toBe("unchanged");

    // A preview recorded for it afterwards shows up: read live, not stored.
    t.sqlite.exec(`
      INSERT INTO deployments (repo_id, source_id, environment, timeline_slug, checkpoint_id, commit_oid, url, status)
        VALUES ('app', '${t.work().sourceId}', 'timeline/search', 'search', '${made.checkpoint.id}', '${oid(9)}', 'https://pr.example', 'active');
    `);
    const listed = (await t.call("cat", "GET", "/search/checkpoints")).body as CheckpointList;
    expect(listed.checkpoints.map((c) => c.checkpoint.id)).toEqual([made.checkpoint.id]);
    expect(listed.checkpoints[0]!.previews).toMatchObject([
      { url: "https://pr.example", status: "active", commit: oid(9) },
    ]);
    const one = await t.call("cat", "GET", "/search/checkpoints/1");
    expect(one.body.checkpoint).toEqual(made.checkpoint);
    expect((await t.call("cat", "GET", "/search/checkpoints/2")).status).toBe(404);
  });

  test("canonical renewal rejects a coerced boolean without creating a checkpoint", async () => {
    const t = await setup();
    await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app"] });
    const rejected = await t.call("bot", "POST", "/search/checkpoints", { syncMain: "true" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("invalid_input");
    const listed = (await t.call("bot", "GET", "/search/checkpoints")).body as CheckpointList;
    expect(listed.checkpoints).toEqual([]);
  });
});

describe("previews (CORE-79)", () => {
  async function checkpointed() {
    const t = await setup();
    startRun.mockResolvedValue({ runId: "run-p", number: 12 });
    await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app", "orbit/lib"] });
    t.work().commits.add(oid(9));
    t.work().refs.set("refs/heads/work", oid(9));
    t.work("search", "lib").commits.add(oid(10));
    t.work("search", "lib").refs.set("refs/heads/work", oid(10));
    const made = (await t.call("bot", "POST", "/search/checkpoints", { summary: "v2" }))
      .body as CheckpointView;
    return { ...t, made };
  }

  test("a new checkpoint starts a preview create run in each repository, at its commit", async () => {
    const t = await checkpointed();
    expect(startRun).toHaveBeenCalledTimes(2);
    const calls = startRun.mock.calls.map(([, repo, options]) => ({ repo: repo.id, ...options }));
    expect(calls).toEqual(
      ["app", "lib"].map((repo, i) =>
        expect.objectContaining({
          repo,
          branch: "work",
          commit: oid(9 + i),
          trigger: "preview",
          preview: { action: "create", timeline: "search", checkpoint: t.made.checkpoint.id },
          actor: expect.objectContaining({
            id: "ben",
            agent: expect.objectContaining({ id: "agt_bot" }),
          }),
        }),
      ),
    );
  });

  test("any checkpoint's preview revives as a rebuild of its record, even after abandoning", async () => {
    const t = await checkpointed();
    startRun.mockClear();
    t.sqlite.exec(`
      INSERT INTO deployments (id, repo_id, source_id, environment, timeline_slug, checkpoint_id, commit_oid, url, status)
        VALUES (5, 'app', '${t.work().sourceId}', 'timeline/search', 'search', '${t.made.checkpoint.id}', '${oid(9)}', 'https://pr.example', 'expired');
    `);
    await t.call("ben", "POST", "/search/abandon");
    // Cat may read the repositories, not start runs in them.
    expect((await t.call("cat", "POST", "/search/checkpoints/1/revive")).status).toBe(403);
    startRun
      .mockResolvedValueOnce({ runId: "run-a", number: 13 })
      .mockResolvedValueOnce({ skipped: "no on: preview" });
    const revived = await t.call(
      "bot",
      "POST",
      `/search/checkpoints/${t.made.checkpoint.id}/revive`,
    );
    expect(revived.status).toBe(201);
    expect(revived.body.runs).toEqual([
      { repoId: "app", number: 13, runId: "run-a" },
      { repoId: "lib", skipped: "no on: preview" },
    ]);
    expect(revived.body.checkpoint.previews).toMatchObject([{ id: 5, status: "expired" }]);
    // Archived owned sources remain readable and keep their exact work ref.
    expect(startRun.mock.calls.map(([, , options]) => [options.branch, options.commit])).toEqual([
      ["work", oid(9)],
      ["work", oid(10)],
    ]);
    const previews = startRun.mock.calls.map(([, repo, options]) => [repo.id, options.preview]);
    expect(previews).toEqual([
      [
        "app",
        {
          action: "create",
          timeline: "search",
          checkpoint: t.made.checkpoint.id,
          revived: true,
          rebuiltFrom: 5,
        },
      ],
      [
        "lib",
        {
          action: "create",
          timeline: "search",
          checkpoint: t.made.checkpoint.id,
          revived: true,
          rebuiltFrom: null,
        },
      ],
    ]);
    expect((await t.call("bot", "POST", "/search/checkpoints/7/revive")).status).toBe(404);
  });
});

describe("approving a checkpoint", () => {
  test("the inbox shows the checkpoint; only a person with write access approves the head", async () => {
    const t = await setup();
    await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app"] });
    t.work().commits.add(oid(9));
    t.work().refs.set("refs/heads/work", oid(9));
    const made = (await t.call("bot", "POST", "/search/checkpoints", { summary: "Ready" }))
      .body as CheckpointView;
    expect((await t.raw("ann", "PATCH", "/repos/orbit/app", { name: "renamed" })).status).toBe(200);
    const mutate = (who: "ann" | "ben" | "cat" | "bot", mutation: unknown) =>
      t.raw(who, "POST", "/tracker/orbit/mutate", {
        operationId: crypto.randomUUID(),
        mutations: [mutation],
      });
    expect(
      (
        await mutate("ann", {
          kind: "team.create",
          id: "team",
          data: { key: "ENG", name: "Engineering" },
        })
      ).status,
    ).toBe(200);
    await mutate("bot", {
      kind: "issue.create",
      id: "issue",
      data: { teamId: "team", title: "S" },
    });
    const asked = await mutate("bot", {
      kind: "request.open",
      id: "req",
      data: {
        issueId: "issue",
        kind: "approval",
        prompt: "Land search?",
        checkpoint: made.checkpoint.id,
      },
    });
    expect(asked.status).toBe(200);
    expect((await t.call("ben", "GET", "/search")).body.timeline.status).toBe("waiting");

    const inbox = (await t.raw("ben", "GET", "/requests")).body as OpenRequests;
    expect(inbox.requests).toHaveLength(1);
    expect(inbox.requests[0]).toMatchObject({
      request: { id: "req", checkpoint: { id: made.checkpoint.id, timeline: "search", number: 1 } },
      checkpoint: {
        checkpoint: {
          summary: "Ready",
          repos: [{ id: "app", owner: "orbit", name: "renamed", commit: oid(9), base: oid(1) }],
        },
        current: true,
        approval: { state: "pending" },
      },
    });

    const answer = { kind: "request.answer", id: "req", data: { approved: true } };
    // Cat is a member who can only read the repository; the agent is never a person.
    expect((await mutate("cat", answer)).status).toBe(403);
    expect((await mutate("bot", answer)).status).toBe(403);
    expect((await mutate("ben", answer)).status).toBe(200);
    const after = (await t.call("ben", "GET", "/search/checkpoints/1")).body as CheckpointView;
    expect(after).toMatchObject({ approved: true, approval: { state: "approved", by: "ben" } });
    // Approved while it's the head: the approval timeline enters the landing queue (CORE-77).
    expect((await t.call("ben", "GET", "/search")).body.timeline.status).toBe("landing");
    expect((await t.call("ben", "GET", "/search/landing")).body.landing.repos).toMatchObject([
      { id: "app", owner: "orbit", name: "renamed", commit: oid(9) },
    ]);
  });
});

describe("approve when green (CORE-378)", () => {
  /** An approval timeline at a checkpoint, an issue, and helpers for runs and requests. */
  async function green() {
    const t = await setup();
    await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app"] });
    t.work().commits.add(oid(9));
    t.work().refs.set("refs/heads/work", oid(9));
    const made = (await t.call("bot", "POST", "/search/checkpoints", { summary: "Ready" }))
      .body as CheckpointView;
    const mutate = (who: "ann" | "ben" | "cat" | "bot", ...mutations: unknown[]) =>
      t.raw(who, "POST", "/tracker/orbit/mutate", {
        operationId: crypto.randomUUID(),
        mutations,
      });
    await mutate("ann", {
      kind: "team.create",
      id: "team",
      data: { key: "ENG", name: "Engineering" },
    });
    await mutate("bot", {
      kind: "issue.create",
      id: "issue",
      data: { teamId: "team", title: "S" },
    });
    let asked = 0;
    const ask = async () => {
      const id = `req-${++asked}`;
      const reply = await mutate("bot", {
        kind: "request.open",
        id,
        data: {
          issueId: "issue",
          kind: "approval",
          prompt: "Land?",
          checkpoint: made.checkpoint.id,
        },
      });
      expect(reply.status).toBe(200);
      return id;
    };
    const setting = (who: "ann" | "ben" | "bot", enabled: boolean, person = "ben") =>
      mutate(who, { kind: "automation.approveWhenGreen", id: person, data: { enabled } });
    let runs = 0;
    /** The timeline's CI run of the checkpoint's commit, as CI records it. */
    const run = (status: string, step = 0, preview: "create" | "teardown" | null = null) => {
      const id = `run-${++runs}`;
      t.sqlite
        .prepare(
          "INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, step, source_id, preview_action) VALUES (?, 'app', ?, ?, 'work', ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          runs,
          oid(9),
          preview ? "manual" : "push",
          status,
          step,
          t.work().sourceId,
          preview,
        );
      return id;
    };
    /** CI finished a run: what ci/workflow.ts does next. */
    const finished = (runId: string) => settled(t.env, (deps) => afterRun(t.env, deps, runId));
    const request = async (id: string) =>
      (
        (await t.raw("ben", "GET", "/tracker/orbit/snapshot")).body as {
          requests: {
            id: string;
            status: string;
            via?: string;
            answeredBy: string | null;
            autoApproveSkipped?: { checkpointId: string; reason: string; at: string };
          }[];
        }
      ).requests.find((r) => r.id === id)!;
    const checkpoint = async () =>
      (await t.call("ben", "GET", "/search/checkpoints/1")).body as CheckpointView;
    /** Main's commit and the checkpoint's, each with a .gitmatrix/ci.yml (blob ids). */
    const ciFiles = (main: string, checkpoint: string) => {
      const tree = (name: string, ci: string, extra: string) => {
        t.git.trees.set(`${name}-root`, [
          { name: ".gitmatrix", mode: "40000", hash: `${name}-gitmatrix`, type: "tree" },
          { name: "README.md", mode: "100644", hash: extra, type: "blob" },
        ]);
        t.git.trees.set(`${name}-gitmatrix`, [
          { name: "ci.yml", mode: "100644", hash: ci, type: "blob" },
        ]);
        return `${name}-root`;
      };
      t.git.treeOf.set(oid(1), tree("main", main, "readme-1"));
      t.git.treeOf.set(oid(9), tree("work", checkpoint, "readme-9"));
    };
    return { ...t, made, mutate, ask, setting, run, finished, request, checkpoint, ciFiles };
  }

  test("only the person sets it; once a run of the checkpoint succeeds, it approves as them and lands", async () => {
    const t = await green();
    // Never an agent, never an owner for someone else.
    expect(await t.setting("bot", true)).toMatchObject({ status: 403 });
    expect(await t.setting("ann", true)).toMatchObject({ status: 403 });
    expect((await t.setting("ben", true)).status).toBe(200);
    expect((await t.raw("ben", "GET", "/tracker/orbit/snapshot")).body.approveWhenGreen).toEqual([
      "ben",
    ]);

    // No run yet: nothing to call green.
    const id = await t.ask();
    expect((await t.request(id)).status).toBe("open");
    const inbox = (await t.raw("ben", "GET", "/requests")).body as OpenRequests;
    expect(inbox.requests[0]).toMatchObject({ request: { id }, approvesWhenGreen: true });

    // Pending, failed or a light step run: the request stays open for Ben.
    const running = t.run("running");
    await t.finished(running);
    expect((await t.request(id)).status).toBe("open");
    t.sqlite.prepare("UPDATE ci_runs SET status = 'failed' WHERE id = ?").run(running);
    await t.finished(running);
    expect((await t.request(id)).status).toBe("open");
    const step = t.run("succeeded", 1);
    await t.finished(step);
    expect((await t.request(id)).status).toBe("open");
    expect((await t.checkpoint()).approved).toBe(false);

    // A run that succeeds: approved by Ben's setting, as Ben, and the timeline lands.
    const passed = t.run("succeeded");
    // Two runs ending at once approve it once.
    await Promise.all([t.finished(passed), t.finished(passed)]);
    expect(await t.request(id)).toMatchObject({
      status: "answered",
      answeredBy: "ben",
      via: "auto-approve",
    });
    expect(await t.checkpoint()).toMatchObject({
      approved: true,
      approval: { requestId: id, state: "approved", by: "ben", via: "auto-approve" },
    });
    const events = (await t.call("ben", "GET", "/search")).body.events as {
      kind: string;
      via?: string;
    }[];
    expect(events.filter((event) => event.kind === "approval")).toMatchObject([
      { via: "auto-approve" },
    ]);
    expect((await t.call("ben", "GET", "/search")).body.timeline.status).toBe("landing");
    expect((await t.call("ben", "GET", "/search/landing")).body.landing).toMatchObject({
      trigger: "approval",
      requestedBy: { accountableId: "ben", agentId: null },
    });
  });

  test("turned off before CI completes: nothing is approved", async () => {
    const t = await green();
    await t.setting("ben", true);
    const id = await t.ask();
    const passed = t.run("running");
    await t.setting("ben", false);
    t.sqlite.prepare("UPDATE ci_runs SET status = 'succeeded' WHERE id = ?").run(passed);
    await t.finished(passed);
    expect((await t.request(id)).status).toBe("open");
    expect((await t.checkpoint()).approved).toBe(false);
    expect((await t.call("ben", "GET", "/search")).body.timeline.status).toBe("waiting");
  });

  test("a checkpoint that changes ci.yml is left to its person, saying why, once", async () => {
    const t = await green();
    t.ciFiles("ci-main", "ci-weakened");
    await t.setting("ben", true);
    const passed = t.run("succeeded");
    const id = await t.ask();
    const left = await t.request(id);
    expect(left).toMatchObject({
      status: "open",
      autoApproveSkipped: {
        checkpointId: t.made.checkpoint.id,
        reason: "Changes CI configuration (.gitmatrix/ci.yml in orbit/app): approve it yourself.",
      },
    });
    // CI ending again changes nothing, and doesn't note it twice.
    await t.finished(passed);
    expect(await t.request(id)).toEqual(left);
    expect((await t.checkpoint()).approved).toBe(false);
    const inbox = (await t.raw("ben", "GET", "/requests")).body as OpenRequests;
    expect(inbox.requests[0]).toMatchObject({
      approvesWhenGreen: true,
      request: { autoApproveSkipped: { reason: expect.stringMatching(/^Changes CI/) } },
    });
    // Ben approves it himself.
    expect(
      (await t.mutate("ben", { kind: "request.answer", id, data: { approved: true } })).status,
    ).toBe(200);
    expect((await t.checkpoint()).approval).toMatchObject({ state: "approved", by: "ben" });
    expect((await t.checkpoint()).approval?.via).toBeUndefined();
  });

  test("other changes, with ci.yml as main has it, are approved", async () => {
    const t = await green();
    t.ciFiles("ci-main", "ci-main");
    await t.setting("ben", true);
    t.run("succeeded");
    const id = await t.ask();
    expect(await t.request(id)).toMatchObject({ status: "answered", via: "auto-approve" });
    expect((await t.request(id)).autoApproveSkipped).toBeUndefined();
  });

  test("when the CI configuration can't be compared, nothing is approved", async () => {
    const t = await green();
    await t.setting("ben", true);
    t.run("succeeded");
    const name = (
      t.sqlite
        .prepare("SELECT artifacts_name FROM timeline_work_sources WHERE timeline_slug = 'search'")
        .get() as { artifacts_name: string }
    ).artifacts_name;
    const get = t.git.artifacts.get;
    t.git.artifacts.get = async (wanted?: string) => {
      if (wanted === name) throw new Error("Artifacts INTERNAL_ERROR");
      return get(wanted);
    };
    const id = await t.ask();
    t.git.artifacts.get = get;
    expect(await t.request(id)).toMatchObject({
      status: "open",
      autoApproveSkipped: {
        reason:
          "Couldn't check whether it changes CI configuration in orbit/app: approve it yourself.",
      },
    });
    expect((await t.checkpoint()).approved).toBe(false);
  });

  test("someone who left the tracker approves nothing, setting or not", async () => {
    const t = await green();
    await t.setting("ben", true);
    const id = await t.ask();
    t.sqlite.exec("DELETE FROM org_members WHERE org_id = 'orbit' AND user_id = 'ben'");
    const passed = t.run("succeeded");
    await t.finished(passed);
    t.sqlite.exec(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ('orbit', 'ben', 'member')",
    );
    expect((await t.request(id)).status).toBe("open");
    expect((await t.checkpoint()).approved).toBe(false);
    // Rejoining doesn't bring back the consent given before leaving.
    expect((await t.raw("ben", "GET", "/tracker/orbit/snapshot")).body.approveWhenGreen).toEqual(
      [],
    );
    await t.finished(passed);
    expect((await t.request(id)).status).toBe("open");
  });

  test("a preview's deploy is never green, and its run ending sets nothing off", async () => {
    const t = await green();
    await t.setting("ben", true);
    const id = await t.ask();
    const failed = t.run("failed");
    await t.finished(failed);
    const preview = t.run("succeeded", 0, "create");
    await t.finished(preview);
    expect((await t.request(id)).status).toBe("open");
    expect((await t.checkpoint()).approved).toBe(false);
    // A push run that passed, but only a preview's run has ended since: nothing yet.
    const passed = t.run("succeeded");
    const teardown = t.run("succeeded", 0, "teardown");
    await t.finished(teardown);
    expect((await t.request(id)).status).toBe("open");
    await t.finished(passed);
    expect(await t.request(id)).toMatchObject({ status: "answered", via: "auto-approve" });
  });

  test("an approval someone else asked of them stays theirs to answer", async () => {
    const t = await green();
    await t.setting("ben", true);
    t.run("succeeded");
    const reply = await t.mutate("cat", {
      kind: "request.open",
      id: "from-cat",
      data: {
        issueId: "issue",
        kind: "approval",
        prompt: "Land?",
        checkpoint: t.made.checkpoint.id,
        routeTo: "ben",
      },
    });
    expect(reply.status).toBe(200);
    expect((await t.request("from-cat")).status).toBe("open");
    const inbox = (await t.raw("ben", "GET", "/requests")).body as OpenRequests;
    expect(inbox.requests.find((item) => item.request.id === "from-cat")).not.toHaveProperty(
      "approvesWhenGreen",
    );
    // His own agent's request on the same checkpoint is approved.
    const own = await t.ask();
    expect(await t.request(own)).toMatchObject({ status: "answered", via: "auto-approve" });
  });

  test("asked of someone with it on, on a checkpoint that's already green: approved at once", async () => {
    const t = await green();
    await t.setting("ben", true);
    t.run("succeeded");
    const id = await t.ask();
    expect(await t.request(id)).toMatchObject({ status: "answered", via: "auto-approve" });
    expect((await t.call("ben", "GET", "/search")).body.timeline.status).toBe("landing");
  });

  test("turning it on approves what's already green and waiting", async () => {
    const t = await green();
    t.run("succeeded");
    const id = await t.ask();
    expect((await t.request(id)).status).toBe("open");
    await t.setting("ben", true);
    expect(await t.request(id)).toMatchObject({ status: "answered", via: "auto-approve" });
  });

  test("a request routed to someone without it waits for them", async () => {
    const t = await green();
    await t.setting("ben", true);
    t.run("succeeded");
    const reply = await t.mutate("bot", {
      kind: "request.open",
      id: "for-ann",
      data: {
        issueId: "issue",
        kind: "approval",
        prompt: "Land?",
        checkpoint: t.made.checkpoint.id,
        routeTo: "ann",
      },
    });
    expect(reply.status).toBe(200);
    expect((await t.request("for-ann")).status).toBe("open");
  });
});

describe("approved but never landed (CORE-390)", () => {
  /** Ben approves search's checkpoint #1; the landing that should follow fails to begin once. */
  async function approvedUnlanded() {
    const t = await setup();
    await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app"] });
    t.work().commits.add(oid(9));
    t.work().refs.set("refs/heads/work", oid(9));
    await t.call("bot", "POST", "/search/checkpoints", { summary: "Ready" });
    const checkpoint = (await t.call("ben", "GET", "/search/checkpoints/1")).body as CheckpointView;
    const mutate = (who: "ann" | "ben" | "bot", ...mutations: unknown[]) =>
      t.raw(who, "POST", "/tracker/orbit/mutate", { operationId: crypto.randomUUID(), mutations });
    await mutate("ann", { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } });
    await mutate("bot", {
      kind: "issue.create",
      id: "issue",
      data: { teamId: "team", title: "S" },
    });
    await mutate("bot", {
      kind: "request.open",
      id: "req",
      data: {
        issueId: "issue",
        kind: "approval",
        prompt: "Land?",
        checkpoint: checkpoint.checkpoint.id,
      },
    });
    // The Durable Object resets mid-call, once: the approval's landing never begins.
    const tracker = t.trackers.get("orbit")!;
    const begin = tracker.beginLanding.bind(tracker);
    let failures = 1;
    tracker.beginLanding = ((...args: Parameters<typeof begin>) => {
      if (failures-- > 0) throw new Error("Durable Object reset");
      return begin(...args);
    }) as typeof tracker.beginLanding;
    expect(
      (await mutate("ben", { kind: "request.answer", id: "req", data: { approved: true } })).status,
    ).toBe(200);
    const landing = async () =>
      (await t.call("ben", "GET", "/search/landing")).body.landing as {
        id: string;
        checkpointId: string;
        trigger: string;
        requestedBy: { accountableId: string; agentId: string | null };
      } | null;
    expect(await landing()).toBeNull();
    expect((await t.call("ben", "GET", "/search/checkpoints/1")).body).toMatchObject({
      approved: true,
    });
    const sweep = () => settled(t.env, (deps) => sweepLandings(t.env, deps));
    return { ...t, checkpoint, landing, sweep };
  }

  type Landed = { id: string; checkpointId: string; state: string; trigger: string } | null;
  /**
   * In an existing world: Ben approves checkpoint #1 of a timeline in `owner`'s
   * tracker, on `repo` (its id), and the landing fails to begin `failures` times.
   */
  async function approveIn(
    t: Awaited<ReturnType<typeof setup>>,
    owner: "orbit" | "ben",
    repo: string,
    failures = 1,
  ) {
    const base = `/tracker/${owner}/timelines`;
    await t.raw("bot", "POST", base, { slug: "search", repos: [`${owner}/${repo}`] });
    t.work("search", repo).commits.add(oid(9));
    t.work("search", repo).refs.set("refs/heads/work", oid(9));
    await t.raw("bot", "POST", `${base}/search/checkpoints`, { summary: "Ready" });
    const mutate = (who: "ann" | "ben" | "bot", ...mutations: unknown[]) =>
      t.raw(who, "POST", `/tracker/${owner}/mutate`, {
        operationId: crypto.randomUUID(),
        mutations,
      });
    const checkpoint = (await t.raw("ben", "GET", `${base}/search/checkpoints/1`))
      .body as CheckpointView;
    await mutate(owner === "orbit" ? "ann" : "ben", {
      kind: "team.create",
      id: "team",
      data: { key: "ENG", name: "Eng" },
    });
    await mutate("bot", {
      kind: "issue.create",
      id: "issue",
      data: { teamId: "team", title: "S" },
    });
    await mutate("bot", {
      kind: "request.open",
      id: "req",
      data: {
        issueId: "issue",
        kind: "approval",
        prompt: "Land?",
        checkpoint: checkpoint.checkpoint.id,
      },
    });
    const tracker = t.trackers.get(owner)!;
    const begin = tracker.beginLanding.bind(tracker);
    let left = failures;
    tracker.beginLanding = ((...args: Parameters<typeof begin>) => {
      if (left-- > 0) throw new Error("Durable Object reset");
      return begin(...args);
    }) as typeof tracker.beginLanding;
    await mutate("ben", { kind: "request.answer", id: "req", data: { approved: true } });
    const landing = async () =>
      (await t.raw("ben", "GET", `${base}/search/landing`)).body.landing as Landed;
    expect(await landing()).toBeNull();
    return { tracker, begin, mutate, checkpoint, landing };
  }

  test("the sweep's budget is for landing attempts, and where it starts rotates", async () => {
    const t = await setup();
    // Ben's own tracker is stuck: every landing attempt fails. Orbit's isn't.
    const stuck = await approveIn(t, "ben", "side", Infinity);
    const orbit = await approveIn(t, "orbit", "app");
    const sweep = (hour: number) =>
      settled(t.env, (deps) => sweepApprovedLandings(t.env, deps, { limit: 1, hour }));
    // Hour 0 starts with ben (by id): its one failed attempt spends the budget.
    await sweep(0);
    expect(await stuck.landing()).toBeNull();
    expect(await orbit.landing()).toBeNull();
    // Hour 1 starts with orbit: it lands, though ben is still stuck.
    await sweep(1);
    expect(await orbit.landing()).toMatchObject({ trigger: "approval" });
    expect(await stuck.landing()).toBeNull();
  });

  test("skips that try nothing cost nothing: an approver who left doesn't block the next", async () => {
    const t = await setup();
    const side = await approveIn(t, "ben", "side");
    const orbit = await approveIn(t, "orbit", "app");
    // Ben can't write to side any more (it moved to Ann): skipped without trying.
    t.sqlite.exec("UPDATE repos SET owner_id = 'ann' WHERE id = 'side'");
    let attempts = -1;
    await settled(t.env, async (deps) => {
      attempts = await sweepApprovedLandings(t.env, deps, { limit: 1, hour: 0 });
    });
    t.sqlite.exec("UPDATE repos SET owner_id = 'ben' WHERE id = 'side'");
    expect(attempts).toBe(1);
    expect(await side.landing()).toBeNull();
    expect(await orbit.landing()).toMatchObject({ trigger: "approval" });
  });

  test("one tracker failing, or the landings sweep before it failing, skips nobody else", async () => {
    const t = await setup();
    const side = await approveIn(t, "ben", "side");
    const orbit = await approveIn(t, "orbit", "app");
    side.tracker.approvedUnlanded = () => {
      throw new Error("Durable Object overloaded");
    };
    const prepare = t.env.DB.prepare.bind(t.env.DB);
    (t.env.DB as { prepare: typeof prepare }).prepare = (query: string) => {
      if (query.includes("source_integration_receipts")) throw new Error("D1 overloaded");
      return prepare(query);
    };
    await settled(t.env, (deps) => sweepLandings(t.env, deps));
    expect(await orbit.landing()).toMatchObject({ trigger: "approval" });
  });

  test("not after a rejection or a new ask, and not once abandoned", async () => {
    const t = await setup();
    const orbit = await approveIn(t, "orbit", "app");
    const sweep = () => settled(t.env, (deps) => sweepApprovedLandings(t.env, deps, { hour: 0 }));
    // Asked again: the approval no longer stands until answered.
    await orbit.mutate("bot", {
      kind: "request.open",
      id: "again",
      data: {
        issueId: "issue",
        kind: "approval",
        prompt: "Again?",
        checkpoint: orbit.checkpoint.checkpoint.id,
      },
    });
    await sweep();
    expect(await orbit.landing()).toBeNull();
    // Rejected: still nothing.
    await orbit.mutate("ben", { kind: "request.answer", id: "again", data: { approved: false } });
    await sweep();
    expect(await orbit.landing()).toBeNull();
    const fresh = await setup();
    const abandoned = await approveIn(fresh, "orbit", "app");
    expect((await fresh.call("ben", "POST", "/search/abandon")).status).toBe(200);
    await settled(fresh.env, (deps) => sweepApprovedLandings(fresh.env, deps, { hour: 0 }));
    expect(await abandoned.landing()).toBeNull();
  });

  test("an approval over a day old waits for a person: neither the sweep nor a CI run lands it", async () => {
    const t = await setup();
    const orbit = await approveIn(t, "orbit", "app");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 25 * 3600_000);
      await settled(t.env, (deps) => sweepLandings(t.env, deps));
      expect(await orbit.landing()).toBeNull();
      t.sqlite
        .prepare(
          "INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, step, source_id) VALUES ('run', 'app', 1, ?, 'work', 'push', 'succeeded', 0, ?)",
        )
        .run(oid(9), t.work("search", "app").sourceId);
      await settled(t.env, (deps) => afterRun(t.env, deps, "run"));
      expect(await orbit.landing()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
    // A person still can.
    expect((await t.call("ben", "POST", "/search/land")).status).toBe(202);
    expect(await orbit.landing()).toMatchObject({ trigger: "request" });
  });

  test("a landing that began and stopped between the check and the retry isn't restarted", async () => {
    const t = await setup();
    const orbit = await approveIn(t, "orbit", "app");
    // Someone lands it by hand just before the retry's call, and it stops.
    orbit.tracker.beginLanding = ((...args: Parameters<typeof orbit.begin>) => {
      const [access, slug, request] = args;
      if (request.onlyIfUnlanded) {
        const started = orbit.begin(access, slug, {
          trigger: "request",
          green: { ok: true, why: null },
          agentId: null,
        });
        if (!started.ok) throw new Error(started.error);
        const stopped = orbit.tracker.saveLanding(
          { ...started.value.landing, state: "failed", reason: "Gates failed" },
          started.value.landing.version,
          "ben",
        );
        if (!stopped.ok) throw new Error(stopped.error);
      }
      return orbit.begin(...args);
    }) as typeof orbit.tracker.beginLanding;
    let retried: Awaited<ReturnType<typeof retryApprovedLanding>> | null = null;
    await settled(t.env, async (deps) => {
      retried = await retryApprovedLanding(t.env, deps, "orbit", "search");
    });
    expect(retried).toEqual({ attempted: true, landing: null });
    const landing = await orbit.landing();
    expect(landing).toMatchObject({ state: "failed", trigger: "request" });
    // Nor by the sweep later.
    await settled(t.env, (deps) => sweepApprovedLandings(t.env, deps, { hour: 0 }));
    expect(await orbit.landing()).toEqual(landing);
  });

  test("the hourly sweep queues it for the approver, once", async () => {
    const t = await approvedUnlanded();
    await t.sweep();
    const queued = await t.landing();
    expect(queued).toMatchObject({
      checkpointId: t.checkpoint.checkpoint.id,
      trigger: "approval",
      requestedBy: { accountableId: "ben", agentId: null },
    });
    expect((await t.call("ben", "GET", "/search")).body.timeline.status).toBe("landing");
    // Swept again: the landing already under way answers for it.
    await t.sweep();
    expect((await t.landing())?.id).toBe(queued!.id);
  });

  test("the timeline's next CI run ending queues it too", async () => {
    const t = await approvedUnlanded();
    t.sqlite
      .prepare(
        "INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, step, source_id) VALUES ('run', 'app', 1, ?, 'work', 'push', 'succeeded', 0, ?)",
      )
      .run(oid(9), t.work().sourceId);
    await settled(t.env, (deps) => afterRun(t.env, deps, "run"));
    expect(await t.landing()).toMatchObject({
      checkpointId: t.checkpoint.checkpoint.id,
      trigger: "approval",
      requestedBy: { accountableId: "ben" },
    });
  });

  test("not for an approver who left the tracker or can't write to it any more", async () => {
    const t = await approvedUnlanded();
    t.sqlite.exec("DELETE FROM org_members WHERE org_id = 'orbit' AND user_id = 'ben'");
    await t.sweep();
    t.sqlite.exec(
      "INSERT INTO org_members (org_id, user_id, role) VALUES ('orbit', 'ben', 'member')",
    );
    expect(await t.landing()).toBeNull();
    t.sqlite.exec("DELETE FROM repo_collaborators WHERE repo_id = 'app' AND user_id = 'ben'");
    await t.sweep();
    expect(await t.landing()).toBeNull();
    // Write access back: it lands.
    t.sqlite.exec(
      "INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('app', 'ben', 'write')",
    );
    await t.sweep();
    expect(await t.landing()).toMatchObject({ requestedBy: { accountableId: "ben" } });
  });
});

test("interrupted progress-root recording blocks checkpoints until both rewritten versions are retained", async () => {
  const t = await setup();
  const created = await t.call("ben", "POST", "", { slug: "progress", repos: ["orbit/app"] });
  const timeline = (created.body as TimelineChange).timeline;
  const sourceId = timeline.repos[0]!.source!.sourceId;
  const source = {
    id: "app",
    ...(t.sqlite
      .prepare(
        "SELECT source_id,artifacts_name,artifacts_remote FROM timeline_work_sources WHERE source_id=?",
      )
      .get(sourceId) as {
      source_id: string;
      artifacts_name: string;
      artifacts_remote: string;
    }),
  };
  const remote = t.git.getByName(source.artifacts_name);
  const tracker = t.trackers.get("orbit")!;
  const operation = (operationId: string, old: string, next: string) => ({
    operationId,
    timelineId: timeline.id,
    repoId: "app",
    sourceId,
    commands: [{ ref: "refs/heads/work", old, new: next }],
    actorId: "ben",
    accountableId: "ben",
  });
  await tracker.beginSourcePush(operation("original", oid(1), oid(7)));
  await retainProgress(t.env, source, "original", oid(1));
  remote.commits.add(oid(7));
  remote.parents.set(oid(7), [oid(1)]);
  remote.refs.set("refs/heads/work", oid(7));
  await retainProgress(t.env, source, "original", oid(7));
  await tracker.finishSourcePush("original", "accepted");
  await tracker.beginSourcePush(operation("interrupted", oid(7), oid(8)));
  remote.commits.add(oid(8));
  remote.parents.set(oid(8), [oid(1)]); // An amend removes 7 from the active graph.
  remote.refs.set("refs/heads/work", oid(8));
  remote.refuse = "root write interrupted";
  await expect(reconcileSourcePushes(t.env, "app", sourceId)).rejects.toThrow();
  expect(
    await t.call("ben", "POST", "/progress/checkpoints", { summary: "Recovered exact source" }),
  ).toMatchObject({
    status: 409,
    body: { code: "source_busy" },
  });
  expect(remote.refs.get(`refs/gitmatrix/progress/${oid(7)}`)).toBe(oid(7));
  expect(remote.refs.has(`refs/gitmatrix/progress/${oid(8)}`)).toBe(false);
  delete remote.refuse;
  await reconcileSourcePushes(t.env, "app", sourceId);
  const checkpoint = await t.call("ben", "POST", "/progress/checkpoints", {
    summary: "Recovered exact source",
  });
  expect(checkpoint).toMatchObject({
    status: 201,
    body: { checkpoint: { repos: [{ commit: oid(8), source: { sourceId } }] } },
  });
  expect(
    t.sqlite
      .prepare(
        "SELECT commit_oid FROM source_progress_members WHERE source_id=? ORDER BY commit_oid",
      )
      .all(sourceId),
  ).toEqual([oid(1), oid(7), oid(8)].map((commit_oid) => ({ commit_oid })));
  expect(
    t.sqlite.prepare("SELECT state FROM source_operations WHERE id='interrupted'").get(),
  ).toEqual({ state: "accepted" });
  expect((await t.call("ben", "POST", "/progress/abandon", {})).status).toBe(200);
  for (const commit of [oid(7), oid(8)])
    expect(remote.refs.get(`refs/gitmatrix/progress/${commit}`)).toBe(commit);
  expect([...t.app.refs]).toEqual([["refs/heads/main", oid(1)]]);
  t.sqlite.close();
});

test.each(["accepted", "rejected"] as const)(
  "repairs %s Tracker outcome after the D1 projection fails",
  async (outcome) => {
    const t = await setup();
    const created = await t.call("ben", "POST", "", { slug: "projection", repos: ["orbit/app"] });
    const timeline = (created.body as TimelineChange).timeline;
    const tracker = t.trackers.get("orbit")!;
    const operation = {
      operationId: `projection-${outcome}`,
      timelineId: timeline.id,
      repoId: "app",
      sourceId: timeline.repos[0]!.source!.sourceId,
      commands: [{ ref: "refs/heads/work", old: oid(1), new: oid(1) }],
      actorId: "ben",
      accountableId: "ben",
    };
    expect(await tracker.beginSourcePush(operation)).toMatchObject({ ok: true });
    const prepare = t.env.DB.prepare.bind(t.env.DB);
    const failed = vi.spyOn(t.env.DB, "prepare").mockImplementation((query) => {
      if (query.startsWith("UPDATE source_operations SET state="))
        throw new Error("projection interrupted");
      return prepare(query);
    });
    await expect(tracker.finishSourcePush(operation.operationId, outcome)).rejects.toThrow(
      "projection interrupted",
    );
    failed.mockRestore();
    expect(tracker.sourcePushes("app")).toMatchObject({
      ok: true,
      value: [{ state: outcome, projectionPending: true }],
    });
    expect(
      t.sqlite.prepare("SELECT state FROM source_operations WHERE id=?").get(operation.operationId),
    ).toEqual({ state: "admitted" });
    // Recovery must not reopen the source or contact its physical repository.
    const provider = vi
      .spyOn(t.git.artifacts, "get")
      .mockRejectedValue(new Error("no provider replay"));
    expect(await reconcileSourcePushes(t.env, "app", operation.sourceId)).toEqual([
      operation.operationId,
    ]);
    expect(provider).not.toHaveBeenCalled();
    expect(
      t.sqlite.prepare("SELECT state FROM source_operations WHERE id=?").get(operation.operationId),
    ).toEqual({ state: outcome });
    expect(
      t.sqlite
        .prepare(
          "SELECT id FROM source_operations WHERE repo_id='app' AND state IN ('admitted','ambiguous')",
        )
        .all(),
    ).toEqual([]);
    expect(await reconcileSourcePushes(t.env, "app", operation.sourceId)).toEqual([]);
    provider.mockRestore();
    t.sqlite.close();
  },
);

test("failed admission projection cannot authorize a provider push or leave its Tracker fence stuck", async () => {
  const t = await setup();
  const created = await t.call("ben", "POST", "", { slug: "admission", repos: ["orbit/app"] });
  const timeline = (created.body as TimelineChange).timeline;
  const tracker = t.trackers.get("orbit")!;
  const operation = {
    operationId: "admission-failure",
    timelineId: timeline.id,
    repoId: "app",
    sourceId: timeline.repos[0]!.source!.sourceId,
    commands: [{ ref: "refs/heads/work", old: oid(1), new: oid(1) }],
    actorId: "ben",
    accountableId: "ben",
  };
  const prepare = t.env.DB.prepare.bind(t.env.DB);
  const failure = vi.spyOn(t.env.DB, "prepare").mockImplementation((query) => {
    if (query.startsWith("INSERT INTO source_operations"))
      throw new Error("admission projection failed");
    return prepare(query);
  });
  await expect(tracker.beginSourcePush(operation)).rejects.toThrow("admission projection failed");
  failure.mockRestore();
  expect(tracker.sourcePush(operation.operationId, "app", operation.sourceId)).toMatchObject({
    ok: true,
    value: { state: "rejected" },
  });
  expect(tracker.sourcePushes("app")).toMatchObject({ ok: true, value: [] });
  expect(
    await tracker.beginSourcePush({ ...operation, operationId: "next-admission" }),
  ).toMatchObject({ ok: true });
  await tracker.finishSourcePush("next-admission", "rejected");
  t.sqlite.close();
});

test("cancelled creation retains ambiguous allocation inventory across restart until the late fork completes", async () => {
  const t = await setup();
  await t.call("ben", "POST", "", { slug: "unrelated", repos: ["orbit/app"] });
  const unrelated = t.work("unrelated");
  const original = t.git.artifacts.get;
  let completeFork: (() => Promise<unknown>) | undefined;
  const interrupted = vi.spyOn(t.git.artifacts, "get").mockImplementation(async (name) => {
    const resource = await original(name);
    if (name !== "r-lib") return resource;
    return {
      ...resource,
      fork: async (newName, options) => {
        // The remote request can still complete after its caller lost the reply.
        completeFork = () => resource.fork(newName, options);
        throw new TrackerError(409, "allocation_unresolved", "Allocation outcome is unresolved.");
      },
    };
  });
  expect(
    (
      await t.call("ben", "POST", "", {
        slug: "ambiguous-creation",
        repos: ["orbit/app", "orbit/lib"],
      })
    ).status,
  ).toBe(409);
  interrupted.mockRestore();
  const allocation = t.sqlite
    .prepare(
      "SELECT source_id,artifacts_name FROM timeline_work_sources WHERE timeline_slug='ambiguous-creation' AND repo_id='lib'",
    )
    .get() as { source_id: string; artifacts_name: string };
  expect(() => t.git.getByName(String(allocation.artifacts_name))).toThrow();
  t.trackers.set("orbit", new Tracker(t.contexts.get("orbit")!, t.env));
  const blocked = await t.call("ben", "POST", "/ambiguous-creation/abandon");
  expect(blocked.status).toBe(409);
  expect(blocked.body.code).toBe("source_initialization_pending");
  expect(
    t.sqlite
      .prepare("SELECT state FROM timeline_work_sources WHERE source_id=?")
      .get(allocation.source_id),
  ).toEqual({ state: "creating" });
  expect(
    (
      await t.call("ben", "POST", "", {
        slug: "ambiguous-creation",
        repos: ["orbit/app", "orbit/lib"],
      })
    ).body.code,
  ).toBe("creation_cancelled");
  if (!completeFork) throw new Error("No interrupted allocation");
  await completeFork();
  expect((await t.call("ben", "POST", "/ambiguous-creation/abandon")).body).toEqual({
    cancelled: true,
    slug: "ambiguous-creation",
    bookmarks: [],
  });
  expect(
    t.sqlite
      .prepare("SELECT state FROM timeline_work_sources WHERE source_id=?")
      .get(allocation.source_id),
  ).toEqual({ state: "purged" });
  expect(() => t.git.getByName(String(allocation.artifacts_name))).toThrow();
  expect(t.work("unrelated").sourceId).toBe(unrelated.sourceId);
  expect(t.app.refs.get("refs/heads/main")).toBe(oid(1));
  expect(t.lib.refs.get("refs/heads/main")).toBe(oid(2));
  expect((await t.call("ben", "POST", "/ambiguous-creation/abandon")).status).toBe(200);
  t.sqlite.close();
});

async function pendingRecovery() {
  const t = await setup();
  const created = await t.call("ben", "POST", "", { slug: "recovery", repos: ["orbit/app"] });
  const timeline = (created.body as TimelineChange).timeline;
  const sourceId = timeline.repos[0]!.source!.sourceId;
  const tracker = t.trackers.get("orbit")!;
  const operation = {
    operationId: crypto.randomUUID(),
    timelineId: timeline.id,
    repoId: "app",
    sourceId,
    commands: [{ ref: "refs/heads/work", old: oid(1), new: oid(7) }],
    actorId: "agt_bot",
    accountableId: "ben",
  };
  expect(await tracker.beginSourcePush(operation)).toMatchObject({ ok: true });
  expect(await tracker.finishSourcePush(operation.operationId, "ambiguous")).toMatchObject({
    ok: true,
  });
  const path = `/repos/orbit/app/sources/${sourceId}/pushes`;
  return { ...t, tracker, operation, sourceId, path, remote: t.work("recovery") };
}

test("source recovery API scopes inspection and rejects read-only, wrong-source and canonical writes", async () => {
  const t = await pendingRecovery();
  const recover = `${t.path}/${t.operation.operationId}/recover`;
  expect((await t.raw("cat", "POST", recover, {})).status).toBe(403);
  expect((await t.raw("reader", "POST", recover, {})).status).toBe(403);
  expect((await t.raw("dan", "POST", recover, {})).status).toBe(404);
  expect((await t.raw("ben", "POST", recover.replace(t.sourceId, "canonical"), {})).status).toBe(
    404,
  );
  expect((await t.raw("ben", "POST", recover.replace(t.sourceId, "work_missing"), {})).status).toBe(
    404,
  );
  expect((await t.raw("ben", "GET", `${t.path}/missing`)).status).toBe(404);
  expect((await t.raw("ben", "GET", t.path)).body.operations).toMatchObject([
    {
      operationId: t.operation.operationId,
      state: "ambiguous",
      actorId: "agt_bot",
    },
  ]);
  const other = await t.call("ben", "POST", "", { slug: "other-source", repos: ["orbit/app"] });
  const otherId = (other.body as TimelineChange).timeline.repos[0]!.source!.sourceId;
  expect((await t.raw("ben", "POST", recover.replace(t.sourceId, otherId), {})).status).toBe(404);
  expect((await t.raw("ben", "GET", t.path.replace(t.sourceId, otherId))).body.operations).toEqual(
    [],
  );
  const anonymous = await t.server.request(`/api${recover}`, { method: "POST", body: "{}" }, t.env);
  expect(anonymous.status).toBe(401);
  expect(t.tracker.sourcePush(t.operation.operationId, "app", t.sourceId)).toMatchObject({
    ok: true,
    value: { state: "ambiguous", commands: t.operation.commands },
  });
  t.sqlite.close();
});

test("concurrent recovery uses one durable same-tree marker and preserves original attribution", async () => {
  const t = await pendingRecovery();
  const recover = `${t.path}/${t.operation.operationId}/recover`;
  const replies = await Promise.all([
    t.raw("ben", "POST", recover, {}),
    t.raw("bot", "POST", recover, {}),
  ]);
  for (const reply of replies)
    expect(reply).toMatchObject({
      status: 200,
      body: { state: "rejected", syncRequired: true, sourceId: t.sourceId },
    });
  expect(replies[0].body.recoveryId).toBe(replies[1].body.recoveryId);
  const marker = replies[0].body.fenceCommit;
  expect(t.remote.refs.get("refs/heads/work")).toBe(marker);
  expect(t.remote.parents.get(marker)).toEqual([oid(1)]);
  const inspected = await t.raw("ben", "GET", `${t.path}/${t.operation.operationId}`);
  expect(inspected.body).toMatchObject({
    actorId: "agt_bot",
    accountableId: "ben",
    commands: t.operation.commands,
    recovery: {
      priorState: "ambiguous",
      commit: marker,
      base: oid(1),
      tree: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      outcome: "rejected",
      projected: true,
    },
  });
  const writes = t.remote.pushes.length;
  expect((await t.raw("ben", "POST", recover, {})).body).toEqual(replies[0].body);
  expect(t.remote.pushes).toHaveLength(writes);
  expect(await t.tracker.finishSourcePush(t.operation.operationId, "accepted")).toMatchObject({
    ok: false,
    code: "operation_settled",
  });
  expect(t.tracker.sourcePushes("app")).toMatchObject({ ok: true, value: [] });
  expect(
    t.sqlite
      .prepare("SELECT commit_oid FROM source_progress_members WHERE source_id=?")
      .all(t.sourceId),
  ).toEqual(expect.arrayContaining([{ commit_oid: marker }, { commit_oid: oid(1) }]));
  expect([...t.app.refs]).toEqual([["refs/heads/main", oid(1)]]);
  t.sqlite.close();
});

test("unchanged old head stays fenced after a refused marker; replay keeps its intent across tracker restart", async () => {
  const t = await pendingRecovery();
  t.remote.refuse = "temporary provider refusal";
  const recover = `${t.path}/${t.operation.operationId}/recover`;
  expect(await t.raw("ben", "POST", recover, {})).toMatchObject({
    status: 409,
    body: { code: "source_busy" },
  });
  const first = (await t.raw("ben", "GET", `${t.path}/${t.operation.operationId}`)).body;
  expect(first.state).toBe("ambiguous");
  expect(first.recovery.commit).not.toBe(oid(1));
  expect(await t.tracker.finishSourcePush(t.operation.operationId, "rejected")).toMatchObject({
    ok: false,
    code: "recovery_active",
  });
  t.trackers.set("orbit", new Tracker(t.contexts.get("orbit")!, t.env));
  delete t.remote.refuse;
  const replay = await t.raw("ben", "POST", recover, {});
  expect(replay).toMatchObject({
    status: 200,
    body: {
      state: "rejected",
      fenceCommit: first.recovery.commit,
      recoveryId: first.recovery.id,
    },
  });
  t.sqlite.close();
});

test("original provider CAS winning the recovery race is accepted, not fenced away", async () => {
  const t = await pendingRecovery();
  const fetch = t.git.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (
      String(input).endsWith("/git-receive-pack") &&
      init?.body instanceof Uint8Array &&
      new TextDecoder().decode(init.body).includes("refs/heads/work")
    ) {
      t.remote.commits.add(oid(7));
      t.remote.parents.set(oid(7), [oid(1)]);
      t.remote.refs.set("refs/heads/work", oid(7));
    }
    return fetch(input, init);
  });
  expect(
    await t.raw("ben", "POST", `${t.path}/${t.operation.operationId}/recover`, {}),
  ).toMatchObject({ status: 200, body: { state: "accepted", head: oid(7), syncRequired: false } });
  expect(t.remote.refs.get("refs/heads/work")).toBe(oid(7));
  t.sqlite.close();
});

test("lost marker response is resolved from its ref, and projection failure replays without provider writes", async () => {
  const t = await pendingRecovery();
  const fetch = t.git.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (
      String(input).endsWith("/git-receive-pack") &&
      init?.body instanceof Uint8Array &&
      new TextDecoder().decode(init.body).includes("refs/heads/work")
    )
      throw new Error("provider response lost");
    return response;
  });
  const prepare = t.env.DB.prepare.bind(t.env.DB);
  const failure = vi.spyOn(t.env.DB, "prepare").mockImplementation((query) => {
    if (query.startsWith("UPDATE source_operations SET state="))
      throw new Error("projection interrupted");
    return prepare(query);
  });
  await expect(
    recoverSourcePush(
      t.env,
      { id: "app", owner_id: "orbit" },
      t.sourceId,
      t.operation.operationId,
      "ben",
      "ben",
    ),
  ).rejects.toThrow("projection interrupted");
  expect(t.tracker.sourcePushes("app")).toMatchObject({
    ok: true,
    value: [
      {
        state: "rejected",
        recovery: { outcome: "rejected", projected: false },
      },
    ],
  });
  expect(await t.tracker.beginSourcePush({ ...t.operation, operationId: "next" })).toMatchObject({
    ok: false,
    code: "source_busy",
  });
  failure.mockRestore();
  const writes = t.remote.pushes.length;
  t.trackers.set("orbit", new Tracker(t.contexts.get("orbit")!, t.env));
  expect(
    await t.raw("ben", "POST", `${t.path}/${t.operation.operationId}/recover`, {}),
  ).toMatchObject({ status: 200, body: { state: "rejected", syncRequired: true } });
  expect(t.remote.pushes).toHaveLength(writes);
  expect(t.trackers.get("orbit")!.sourcePushes("app")).toMatchObject({ ok: true, value: [] });
  t.sqlite.close();
});

test("provider accepted with a lost original response recovers without a marker", async () => {
  const t = await pendingRecovery();
  t.remote.commits.add(oid(7));
  t.remote.parents.set(oid(7), [oid(1)]);
  t.remote.refs.set("refs/heads/work", oid(7));
  expect(
    await t.raw("ben", "POST", `${t.path}/${t.operation.operationId}/recover`, {}),
  ).toMatchObject({
    status: 200,
    body: {
      state: "accepted",
      head: oid(7),
      recoveryId: null,
      fenceCommit: null,
      syncRequired: false,
    },
  });
  t.sqlite.close();
});

test("failure before forwarding is proven rejected, not ambiguous", async () => {
  const t = await setup();
  await t.call("ben", "POST", "", { slug: "pre-forward", repos: ["orbit/app"] });
  const remote = t.work("pre-forward");
  const prepare = t.env.DB.prepare.bind(t.env.DB);
  const failure = vi.spyOn(t.env.DB, "prepare").mockImplementation((query) => {
    if (query.includes('insert into "source_progress_members"'))
      throw new Error("retention interrupted");
    return prepare(query);
  });
  const bytes = `${pkt(`${oid(1)} ${oid(7)} refs/heads/work\0report-status\n`)}${FLUSH}`;
  const response = await t.server.request(
    "/orbit/app@pre-forward.git/git-receive-pack",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${t.tokens.ben}`,
        "content-type": "application/x-git-receive-pack-request",
      },
      body: bytes,
    },
    t.env,
    t.executionCtx,
  );
  failure.mockRestore();
  expect(response.status).toBe(500);
  const operations = t.sqlite
    .prepare("SELECT state FROM source_operations WHERE source_id=?")
    .all(remote.sourceId);
  expect(operations).toEqual([{ state: "rejected" }]);
  expect(remote.refs.get("refs/heads/work")).toBe(oid(1));
  t.sqlite.close();
});

test("recovery cannot reactivate an archived source or guess an unexpected provider head", async () => {
  const t = await pendingRecovery();
  const recover = `${t.path}/${t.operation.operationId}/recover`;
  const writes = t.remote.pushes.length;
  t.sqlite
    .prepare("UPDATE timeline_work_sources SET state='archived' WHERE source_id=?")
    .run(t.sourceId);
  expect(await t.raw("ben", "POST", recover, {})).toMatchObject({
    status: 409,
    body: { code: "source_expired" },
  });
  expect(t.remote.pushes).toHaveLength(writes);
  t.sqlite
    .prepare("UPDATE timeline_work_sources SET state='ready' WHERE source_id=?")
    .run(t.sourceId);
  t.remote.refs.set("refs/heads/work", oid(99));
  expect(await t.raw("ben", "POST", recover, {})).toMatchObject({
    status: 409,
    body: { code: "recovery_conflict" },
  });
  expect(t.remote.pushes).toHaveLength(writes);
  expect((await t.raw("ben", "GET", t.path)).body.operations).toHaveLength(1);
  t.sqlite.close();
});

test("future source writes cannot restore a recovery base and revive a delayed CAS", async () => {
  const t = await pendingRecovery();
  const recovered = await t.raw("ben", "POST", `${t.path}/${t.operation.operationId}/recover`, {});
  expect(recovered.status).toBe(200);
  expect(
    await t.tracker.beginSourcePush({
      ...t.operation,
      operationId: "restore-base",
      commands: [{ ref: "refs/heads/work", old: recovered.body.head, new: oid(1) }],
    }),
  ).toMatchObject({ ok: false, code: "recovery_fence" });
  expect(
    await t.tracker.beginSourcePush({
      ...t.operation,
      operationId: "synced-work",
      commands: [{ ref: "refs/heads/work", old: recovered.body.head, new: oid(8) }],
    }),
  ).toMatchObject({ ok: true });
  t.sqlite.close();
});

test("marker-written recovery resumes after failed progress retention without choosing another marker", async () => {
  const t = await pendingRecovery();
  const fetch = t.git.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (
      String(input).endsWith("/git-receive-pack") &&
      init?.body instanceof Uint8Array &&
      new TextDecoder().decode(init.body).includes("refs/heads/work")
    )
      t.remote.refuse = "progress retention interrupted";
    return response;
  });
  await expect(
    recoverSourcePush(
      t.env,
      { id: "app", owner_id: "orbit" },
      t.sourceId,
      t.operation.operationId,
      "ben",
      "ben",
    ),
  ).rejects.toThrow("retain progress");
  const marker = t.remote.refs.get("refs/heads/work");
  expect(marker).not.toBe(oid(1));
  expect(t.tracker.sourcePushes("app")).toMatchObject({
    ok: true,
    value: [{ state: "ambiguous", recovery: { commit: marker } }],
  });
  t.trackers.set("orbit", new Tracker(t.contexts.get("orbit")!, t.env));
  delete t.remote.refuse;
  vi.stubGlobal("fetch", fetch);
  expect(
    await t.raw("ben", "POST", `${t.path}/${t.operation.operationId}/recover`, {}),
  ).toMatchObject({ status: 200, body: { state: "rejected", head: marker, fenceCommit: marker } });
  expect(t.remote.refs.get("refs/heads/work")).toBe(marker);
  expect(
    t.sqlite
      .prepare("SELECT commit_oid FROM source_progress_members WHERE source_id=?")
      .all(t.sourceId),
  ).toContainEqual({ commit_oid: marker });
  t.sqlite.close();
});

test("terminal recovery on an ended source returns its established outcome without reactivation", async () => {
  const t = await pendingRecovery();
  const path = `${t.path}/${t.operation.operationId}/recover`;
  const first = await t.raw("ben", "POST", path, {});
  expect(first.status).toBe(200);
  expect((await t.call("ben", "POST", "/recovery/abandon", {})).status).toBe(200);
  const ended = (await t.call("ben", "GET", "/recovery")).body.timeline;
  const writes = t.remote.pushes.length;
  expect((await t.raw("ben", "POST", path, {})).body).toEqual(first.body);
  expect((await t.call("ben", "GET", "/recovery")).body.timeline.status).toBe(ended.status);
  expect(t.remote.pushes).toHaveLength(writes);
  t.sqlite.close();
});

test("historical recovery replay keeps the latest source head and delivers current CI observation", async () => {
  const t = await pendingRecovery();
  const path = `${t.path}/${t.operation.operationId}/recover`;
  const first = await t.raw("ben", "POST", path, {});
  expect(first.status).toBe(200);
  const next = {
    ...t.operation,
    operationId: "later-work",
    commands: [{ ref: "refs/heads/work", old: first.body.head, new: oid(8) }],
  };
  expect(await t.tracker.beginSourcePush(next)).toMatchObject({ ok: true });
  t.remote.commits.add(oid(8));
  t.remote.parents.set(oid(8), [first.body.head]);
  t.remote.refs.set("refs/heads/work", oid(8));
  expect(await t.tracker.finishSourcePush(next.operationId, "accepted")).toMatchObject({
    ok: true,
  });
  await onPush(t.env, recoveryRepo(t), null, () => {});
  expect((await t.raw("ben", "POST", path, {})).body).toEqual(first.body);
  expect(t.remote.refs.get("refs/heads/work")).toBe(oid(8));
  expect(
    t.contexts
      .get("orbit")!
      .storage.sql.exec(
        "SELECT oid FROM timeline_heads WHERE timeline_id=? AND repo_id=?",
        t.operation.timelineId,
        "app",
      )
      .toArray(),
  ).toEqual([{ oid: oid(8) }]);
  expect(
    t.sqlite
      .prepare("SELECT oid FROM repo_refs WHERE source_id=? AND ref='refs/heads/work'")
      .get(t.sourceId),
  ).toEqual({ oid: oid(8) });
  expect(
    t.sqlite.prepare("SELECT oid FROM ci_refs WHERE source_id=? AND ref='work'").get(t.sourceId),
  ).toEqual({ oid: oid(8) });
  t.sqlite.close();
});

test("CI job credentials cannot inspect or recover source operations", async () => {
  const t = await pendingRecovery();
  t.sqlite
    .prepare(`INSERT INTO ci_runs
    (id,repo_id,number,commit_oid,ref,trigger,status,source_id)
    VALUES ('recovery-run','app',1,?,'work','push','running',?)`)
    .run(oid(1), t.sourceId);
  t.sqlite
    .prepare(`INSERT INTO ci_jobs
    (id,run_id,repo_id,name,spec,status,runner,source_id)
    VALUES ('recovery-job','recovery-run','app','build','{"steps":[]}','running','sandbox',?)`)
    .run(t.sourceId);
  const token = await mintJobToken(t.env.DB, "recovery-job", 30);
  for (const method of ["GET", "POST"]) {
    const path = method === "GET" ? t.path : `${t.path}/${t.operation.operationId}/recover`;
    const response = await t.server.request(
      `/api${path}`,
      {
        method,
        headers: { authorization: `Bearer ${token}` },
        ...(method === "POST" ? { body: "{}" } : {}),
      },
      t.env,
    );
    expect(response.status).toBe(401);
  }
  expect(t.tracker.sourcePush(t.operation.operationId, "app", t.sourceId)).toMatchObject({
    ok: true,
    value: { state: "ambiguous" },
  });
  t.sqlite.close();
});

function recoveryRepo(t: { sqlite: DatabaseSync; sourceId: string }) {
  const source = t.sqlite
    .prepare("SELECT artifacts_name, artifacts_remote FROM timeline_work_sources WHERE source_id=?")
    .get(t.sourceId) as { artifacts_name: string; artifacts_remote: string };
  return {
    ...source,
    id: "app",
    owner_id: "orbit",
    owner_slug: "orbit",
    name: "app",
    default_branch: "work",
    source_id: t.sourceId,
  };
}

function recoveryPipeline(env: Env) {
  const artifacts = env.ARTIFACTS;
  const get = artifacts.get.bind(artifacts);
  const config = new Blob([
    "on:\n  push:\n    branches: [work]\n  step: {}\njobs:\n  gate:\n    on: [push, step]\n    steps: [echo recovery]\n",
  ]);
  Object.assign(env, {
    ARTIFACTS: {
      ...artifacts,
      get: async (name: string) => {
        const repository = await get(name);
        return {
          ...repository,
          readCommit: async (hash: string) => {
            const commit = await repository.readCommit(hash);
            return commit && { ...commit, treeHash: oid(90) };
          },
          readTree: async (hash: string) =>
            hash === oid(90)
              ? [{ name: ".gitmatrix", type: "tree", hash: oid(91), mode: "040000" }]
              : [{ name: "ci.yml", type: "blob", hash: oid(92), mode: "100644" }],
          readBlob: async () => config,
        };
      },
    },
  });
  const started = new Set<string>();
  Object.assign(env, {
    CI_RUN: {
      create: async ({ id }: { id: string }) => {
        if (started.has(id)) throw new Error("Workflow already exists");
        started.add(id);
        return {};
      },
      get: async (id: string) => {
        if (!started.has(id)) throw new Error("Workflow not found");
        return { status: async () => ({ status: "running" }) };
      },
    },
  });
  return { started };
}

test("deletion drains a proven recovery whose terminal D1 projection failed", async () => {
  const t = await pendingRecovery();
  const prepare = t.env.DB.prepare.bind(t.env.DB);
  const failure = vi.spyOn(t.env.DB, "prepare").mockImplementation((query) => {
    if (query.startsWith("UPDATE source_operations SET state="))
      throw new Error("projection interrupted");
    return prepare(query);
  });
  await expect(
    recoverSourcePush(
      t.env,
      { id: "app", owner_id: "orbit" },
      t.sourceId,
      t.operation.operationId,
      "ben",
      "ben",
    ),
  ).rejects.toThrow("projection interrupted");
  failure.mockRestore();
  t.sqlite.exec("UPDATE repos SET deleted_at=CURRENT_TIMESTAMP WHERE id='app'");
  expect(
    (await t.raw("ben", "POST", `${t.path}/${t.operation.operationId}/recover`, {})).status,
  ).toBe(404);
  const transport = vi.fn(async () => {
    throw new Error("No provider ref replay after tombstone");
  });
  vi.stubGlobal("fetch", transport);
  await drainDeletedRepoSources(t.env, "app");
  await drainDeletedRepoSources(t.env, "app");
  expect(transport).not.toHaveBeenCalled();
  expect(t.tracker.sourcePushes("app")).toMatchObject({ ok: true, value: [] });
  expect(
    t.sqlite.prepare("SELECT state FROM source_operations WHERE id=?").get(t.operation.operationId),
  ).toEqual({ state: "rejected" });
  expect(
    t.sqlite.prepare("SELECT state FROM timeline_work_sources WHERE source_id=?").get(t.sourceId),
  ).toEqual({ state: "purged" });
  t.sqlite.close();
});

test("recovery retries CI admission after cursor observation, across restart, without duplicate completed runs", async () => {
  const t = await pendingRecovery();
  const pipeline = recoveryPipeline(t.env);
  const result = await recoverSourcePush(
    t.env,
    { id: "app", owner_id: "orbit" },
    t.sourceId,
    t.operation.operationId,
    "ben",
    "ben",
  );
  const physical = recoveryRepo(t);
  const prepare = t.env.DB.prepare.bind(t.env.DB);
  const failure = vi.spyOn(t.env.DB, "prepare").mockImplementation((query) => {
    if (query.includes('insert into "ci_runs"')) throw new Error("CI admission interrupted");
    return prepare(query);
  });
  await expect(
    deliverRecoveredSourcePush(t.env, physical, t.operation.operationId, null, () => {}),
  ).rejects.toThrow("CI admission interrupted");
  failure.mockRestore();
  expect(
    t.sqlite.prepare("SELECT oid FROM ci_refs WHERE source_id=? AND ref='work'").get(t.sourceId),
  ).toEqual({ oid: result.head });
  expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM ci_runs").get()).toEqual({ n: 0 });
  const pending = t.tracker.sourcePush(t.operation.operationId, "app", t.sourceId);
  if (!pending.ok) throw new Error(pending.error);
  expect(pending.value.delivery?.runs.push.state).toBe("pending");
  t.trackers.set("orbit", new Tracker(t.contexts.get("orbit")!, t.env));
  await deliverRecoveredSourcePush(t.env, physical, t.operation.operationId, null, () => {});
  expect(pipeline.started.size).toBe(2);
  expect(t.sqlite.prepare("SELECT id FROM ci_runs ORDER BY step").all()).toEqual([
    { id: pending.value.delivery!.runs.push.id },
    { id: pending.value.delivery!.runs.step.id },
  ]);
  t.sqlite.exec("UPDATE ci_runs SET status='succeeded'");
  const next = {
    ...t.operation,
    operationId: "later-delivery",
    commands: [{ ref: "refs/heads/work", old: result.head, new: oid(8) }],
  };
  expect(await t.trackers.get("orbit")!.beginSourcePush(next)).toMatchObject({ ok: true });
  t.remote.commits.add(oid(8));
  t.remote.parents.set(oid(8), [result.head!]);
  t.remote.refs.set("refs/heads/work", oid(8));
  expect(
    await t.trackers.get("orbit")!.finishSourcePush(next.operationId, "accepted"),
  ).toMatchObject({ ok: true });
  await onPush(t.env, physical, null, () => {});
  const count = t.sqlite.prepare("SELECT COUNT(*) AS n FROM ci_runs").get();
  t.sqlite.exec("UPDATE ci_runs SET status='succeeded'");
  await deliverRecoveredSourcePush(t.env, physical, t.operation.operationId, null, () => {});
  expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM ci_runs").get()).toEqual(count);
  expect(
    t.sqlite.prepare("SELECT oid FROM ci_refs WHERE source_id=? AND ref='work'").get(t.sourceId),
  ).toEqual({ oid: oid(8) });
  t.sqlite.close();
});

test("recovery resumes a persisted queued CI run after Workflow startup failure", async () => {
  const t = await pendingRecovery();
  const pipeline = recoveryPipeline(t.env);
  await recoverSourcePush(
    t.env,
    { id: "app", owner_id: "orbit" },
    t.sourceId,
    t.operation.operationId,
    "ben",
    "ben",
  );
  const physical = recoveryRepo(t);
  const create = vi
    .spyOn(t.env.CI_RUN, "create")
    .mockRejectedValueOnce(new Error("Workflow startup interrupted"));
  await expect(
    deliverRecoveredSourcePush(t.env, physical, t.operation.operationId, null, () => {}),
  ).rejects.toThrow("Workflow startup interrupted");
  expect(t.sqlite.prepare("SELECT status FROM ci_runs").all()).toEqual([{ status: "queued" }]);
  t.trackers.set("orbit", new Tracker(t.contexts.get("orbit")!, t.env));
  await deliverRecoveredSourcePush(t.env, physical, t.operation.operationId, null, () => {});
  expect(pipeline.started.size).toBe(2);
  expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM ci_runs").get()).toEqual({ n: 2 });
  create.mockRestore();
  t.sqlite.close();
});

test("recovery replays lost CI acknowledgement after the Workflow completed using the same run IDs", async () => {
  const t = await pendingRecovery();
  recoveryPipeline(t.env);
  await recoverSourcePush(
    t.env,
    { id: "app", owner_id: "orbit" },
    t.sourceId,
    t.operation.operationId,
    "ben",
    "ben",
  );
  const ack = vi.spyOn(t.tracker, "completeSourcePushDelivery").mockImplementationOnce(() => {
    throw new Error("Delivery acknowledgement lost");
  });
  await expect(
    deliverRecoveredSourcePush(t.env, recoveryRepo(t), t.operation.operationId, null, () => {}),
  ).rejects.toThrow("Delivery acknowledgement lost");
  const first = t.sqlite.prepare("SELECT id FROM ci_runs").get();
  t.sqlite.exec("UPDATE ci_runs SET status='succeeded'");
  ack.mockRestore();
  t.trackers.set("orbit", new Tracker(t.contexts.get("orbit")!, t.env));
  await deliverRecoveredSourcePush(t.env, recoveryRepo(t), t.operation.operationId, null, () => {});
  expect(t.sqlite.prepare("SELECT id FROM ci_runs WHERE step=0").get()).toEqual(first);
  expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM ci_runs").get()).toEqual({ n: 2 });
  t.sqlite.close();
});

test("first recovery delivery adopts completed ordinary runs rather than rerunning gates", async () => {
  const t = await pendingRecovery();
  const pipeline = recoveryPipeline(t.env);
  await recoverSourcePush(
    t.env,
    { id: "app", owner_id: "orbit" },
    t.sourceId,
    t.operation.operationId,
    "ben",
    "ben",
  );
  const physical = recoveryRepo(t);
  await onPush(t.env, physical, null, () => {});
  const runs = t.sqlite.prepare("SELECT id FROM ci_runs ORDER BY step").all();
  expect(runs).toHaveLength(2);
  t.sqlite.exec("UPDATE ci_runs SET status='succeeded'");
  await deliverRecoveredSourcePush(t.env, physical, t.operation.operationId, null, () => {});
  expect(t.sqlite.prepare("SELECT id FROM ci_runs ORDER BY step").all()).toEqual(runs);
  expect(pipeline.started.size).toBe(2);
  const inspected = t.tracker.sourcePush(t.operation.operationId, "app", t.sourceId);
  if (!inspected.ok) throw new Error(inspected.error);
  expect(inspected.value.delivery?.runs).toMatchObject({
    push: { id: runs[0]!.id, state: "started" },
    step: { id: runs[1]!.id, state: "started" },
  });
  t.sqlite.close();
});

test("deletion cannot mistake an unresolved recovery intent for terminal projection repair", async () => {
  const t = await pendingRecovery();
  t.remote.refuse = "marker CAS unavailable";
  expect(
    (await t.raw("ben", "POST", `${t.path}/${t.operation.operationId}/recover`, {})).status,
  ).toBe(409);
  t.sqlite.exec("UPDATE repos SET deleted_at=CURRENT_TIMESTAMP WHERE id='app'");
  const writes = t.remote.pushes.length;
  await expect(drainDeletedRepoSources(t.env, "app")).rejects.toThrow("still draining");
  expect(t.remote.pushes).toHaveLength(writes);
  expect(
    t.sqlite.prepare("SELECT state FROM timeline_work_sources WHERE source_id=?").get(t.sourceId),
  ).toEqual({ state: "ready" });
  t.sqlite.close();
});
