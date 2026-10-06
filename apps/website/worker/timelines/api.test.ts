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
vi.mock(import("../ci/trigger.ts"), async (original) => ({ ...(await original()), startRun }));

const oid = (n: number) => n.toString(16).padStart(40, "0");

afterEach(() => {
  vi.unstubAllGlobals();
  startRun.mockReset();
});

async function setup(missingRepoError?: (name: string) => Error) {
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
  const tokens = {
    ann: (await issueToken(env.DB, "ann", "t", "write")).secret,
    ben: (await issueToken(env.DB, "ben", "t", "write")).secret,
    cat: (await issueToken(env.DB, "cat", "t", "write")).secret,
    dan: (await issueToken(env.DB, "dan", "t", "write")).secret,
    bot: (await issueToken(env.DB, "ben", "t", "write", undefined, "agt_bot")).secret,
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
    return { ...git.getByName(row.artifacts_name), sourceId: row.source_id };
  };
  return { sqlite, git, app, lib, call, raw, work, env, trackers, contexts };
}

describe("forking", () => {
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
    expect((await t.call("cat", "POST", "/search/checkpoints", {})).status).toBe(403);
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
        checkpoint: { summary: "Ready", repos: [{ commit: oid(9), base: oid(1) }] },
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
    expect(tracker.sourcePushes("app")).toMatchObject({ ok: true, value: [] });
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
