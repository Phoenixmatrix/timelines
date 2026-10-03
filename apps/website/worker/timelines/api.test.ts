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

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
// Preview runs (CORE-79) are started through CI's startRun: seen here, not run.
const startRun = vi.hoisted(() => vi.fn());
vi.mock(import("../ci/trigger.ts"), async (original) => ({ ...(await original()), startRun }));

const oid = (n: number) => n.toString(16).padStart(40, "0");
const ZERO = "0".repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
  startRun.mockReset();
});

async function setup() {
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
  const app = git.add("https://app", { "refs/heads/main": oid(1) });
  const lib = git.add("https://lib", { "refs/heads/main": oid(2) });
  git.add("https://side", { "refs/heads/main": oid(3) });
  vi.stubGlobal("fetch", git.fetch);
  const trackers = new Map<string, Tracker>();
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    TRACKER: {
      getByName: (id: string) => {
        if (!trackers.has(id)) {
          const { sql, transactionSync } = durableStorage();
          const ctx = { storage: { sql, transactionSync } } as unknown as DurableObjectState;
          trackers.set(id, new Tracker(ctx, {} as Env));
        }
        return trackers.get(id);
      },
    },
  } as unknown as Env;
  const server = new Hono<AppEnv>();
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
  return { sqlite, git, app, lib, call, raw };
}

describe("forking", () => {
  test("creates the bookmark in each repository at main's tip, then the timeline", async () => {
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
    expect(t.app.refs.get("refs/heads/timeline/search")).toBe(oid(1));
    expect(t.lib.refs.get("refs/heads/timeline/search")).toBe(oid(2));
    // A ref creation, as a push of objects the server has: an empty pack.
    expect(t.app.pushes).toEqual([
      { commands: [`${ZERO} ${oid(1)} refs/heads/timeline/search`], pack: "empty" },
    ]);
    expect(timeline).toMatchObject({
      slug: "search",
      name: "Search rewrite",
      policy: "auto",
      parentId: null,
      forkPoint: { commits: { app: oid(1), lib: oid(2) } },
      repos: [
        { id: "app", owner: "orbit", name: "app", bookmark: "timeline/search" },
        { id: "lib", owner: "orbit", name: "lib", bookmark: "timeline/search" },
      ],
      accountableId: "ben",
      startedBy: "ben",
    });
    // The push log has the new bookmarks as Ben's.
    expect(
      t.sqlite
        .prepare(
          "SELECT repo_id, ref, old_oid, new_oid, actor_id FROM ref_updates WHERE ref LIKE '%timeline%' ORDER BY repo_id",
        )
        .all(),
    ).toEqual([
      {
        repo_id: "app",
        ref: "refs/heads/timeline/search",
        old_oid: null,
        new_oid: oid(1),
        actor_id: "ben",
      },
      {
        repo_id: "lib",
        ref: "refs/heads/timeline/search",
        old_oid: null,
        new_oid: oid(2),
        actor_id: "ben",
      },
    ]);
    const list = (await t.call("cat", "GET", "")).body as TimelineList;
    expect(list.timelines.map((tl) => tl.slug)).toEqual(["search"]);
    const detail = (await t.call("cat", "GET", "/search")).body as TimelineDetail;
    expect(detail.events).toMatchObject([
      { kind: "fork", parentId: null, commits: { app: oid(1), lib: oid(2) }, actorId: "ben" },
    ]);
  });

  test("a fork from a timeline starts at its bookmarks, in its repositories by default", async () => {
    const t = await setup();
    const parent = await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app"] });
    expect(parent.body.timeline).toMatchObject({ startedBy: "agt_bot", agentIds: ["agt_bot"] });
    t.git.commits.add(oid(7));
    t.app.refs.set("refs/heads/timeline/search", oid(7));
    const child = await t.call("ben", "POST", "", { slug: "ranking", parent: "search" });
    expect(child.status).toBe(201);
    expect(t.app.refs.get("refs/heads/timeline/ranking")).toBe(oid(7));
    expect(child.body.timeline).toMatchObject({
      parentId: parent.body.timeline.id,
      repos: [{ id: "app", bookmark: "timeline/ranking" }],
    });
    // A repository the parent doesn't touch forks from main; a commit can be given.
    t.git.commits.add(oid(8));
    const mixed = await t.call("ben", "POST", "", {
      slug: "mixed",
      parent: "search",
      repos: ["orbit/app", { repo: "orbit/lib", commit: oid(8) }],
    });
    expect(mixed.body.timeline.forkPoint.commits).toEqual({ app: oid(7), lib: oid(8) });
  });

  test("any member with write access may fork; others write no bookmark", async () => {
    const t = await setup();
    const cases: [Parameters<typeof t.call>[0], unknown, number, RegExp][] = [
      ["cat", { slug: "a", repos: ["orbit/app"] }, 403, /write access/],
      ["dan", { slug: "a", repos: ["orbit/app"] }, 403, /membership/],
      ["ben", { slug: "a", repos: ["ben/side"] }, 400, /another account/],
      ["ben", { slug: "a", repos: ["orbit/nope"] }, 404, /No repository/],
      ["ben", { slug: "a", repos: ["orbit/app"], policy: "yolo" }, 400, /policy/],
      ["ben", { slug: "a" }, 400, /Name the repositories/],
      ["ben", { slug: "a", repos: [{ repo: "orbit/app", commit: oid(99) }] }, 404, /no commit/],
      ["ben", { slug: "a", repos: ["orbit/app"], parent: "nope" }, 404, /No timeline nope/],
    ];
    for (const [who, body, status, error] of cases) {
      const result = await t.call(who, "POST", "", body);
      expect([result.status, result.body.error]).toEqual([status, expect.stringMatching(error)]);
    }
    expect(t.app.pushes).toEqual([]);
    expect((await t.call("ann", "GET", "")).body.timelines).toEqual([]);
  });

  test("a slug or a bookmark that exists is refused", async () => {
    const t = await setup();
    await t.call("ben", "POST", "", { slug: "search", repos: ["orbit/app"] });
    const again = await t.call("ann", "POST", "", { slug: "search", repos: ["orbit/lib"] });
    expect([again.status, again.body.code]).toEqual([409, "already_exists"]);
    t.lib.refs.set("refs/heads/timeline/taken", oid(2));
    const taken = await t.call("ben", "POST", "", { slug: "taken", repos: ["orbit/lib"] });
    expect([taken.status, taken.body.code]).toEqual([409, "already_exists"]);
  });

  test("when one repository refuses, the bookmarks already made are removed", async () => {
    const t = await setup();
    t.lib.refuse = "pre-receive hook declined";
    const result = await t.call("ben", "POST", "", {
      slug: "search",
      repos: ["orbit/app", "orbit/lib"],
    });
    expect([result.status, result.body.code]).toEqual([409, "bookmark_failed"]);
    expect(result.body.error).toMatch(/hook declined/);
    expect(t.app.refs.has("refs/heads/timeline/search")).toBe(false);
    expect(t.app.pushes.at(-1)!.commands).toEqual([`${oid(1)} ${ZERO} refs/heads/timeline/search`]);
    expect((await t.call("ben", "GET", "")).body.timelines).toEqual([]);
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
    t.git.commits.add(oid(9));
    t.app.refs.set("refs/heads/timeline/search", oid(9));
    for (const who of ["ann", "cat"] as const) {
      const refused = await t.call(who, "POST", "/search/abandon");
      expect([refused.status, refused.body.error]).toEqual([
        403,
        expect.stringMatching(/accountable person/),
      ]);
    }
    expect(t.app.refs.has("refs/heads/timeline/search")).toBe(true);
    const done = await t.call("ben", "POST", "/search/abandon");
    expect(done.status).toBe(200);
    expect(done.body.timeline.status).toBe("abandoned");
    expect(done.body.bookmarks.map((b: { ok: boolean }) => b.ok)).toEqual([true, true]);
    expect(t.app.refs.has("refs/heads/timeline/search")).toBe(false);
    expect(t.lib.refs.has("refs/heads/timeline/search")).toBe(false);
    const detail = (await t.call("cat", "GET", "/search")).body as TimelineDetail;
    expect(detail.timeline.status).toBe("abandoned");
    expect(detail.events.map((e) => e.kind)).toEqual(["fork", "abandon"]);
    expect(detail.events[1]).toMatchObject({
      lastCommits: { app: oid(9), lib: oid(2) },
      actorId: "ben",
    });
    // The deletions are in the push log too.
    expect(
      t.sqlite.prepare("SELECT count(*) AS n FROM ref_updates WHERE new_oid IS NULL").get(),
    ).toEqual({ n: 2 });
    // Again: nothing more to do, and no second event.
    const again = await t.call("bot", "POST", "/search/abandon");
    expect([again.status, again.body.bookmarks]).toEqual([200, []]);
    expect((await t.call("cat", "GET", "/search")).body.events).toHaveLength(2);
  });
});

describe("checkpoints", () => {
  test("pin each bookmark's commit and main's, with its CI runs and previews; writers only", async () => {
    const t = await setup();
    await t.call("bot", "POST", "", { slug: "search", repos: ["orbit/app"] });
    expect((await t.call("bot", "POST", "/search/checkpoints", {})).body.code).toBe("no_work");

    t.app.refs.set("refs/heads/timeline/search", oid(9));
    t.sqlite.exec(`
      INSERT INTO change_refs (repo_id, change_id, ref, first_commit_oid, first_update_id, last_commit_oid)
        VALUES ('app', 'kxyz', 'refs/heads/timeline/search', '${oid(8)}', 1, '${oid(9)}');
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status)
        VALUES ('run1', 'app', 4, '${oid(9)}', 'timeline/search', 'push', 'succeeded'),
               ('run0', 'app', 3, '${oid(1)}', 'main', 'push', 'succeeded');
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
      INSERT INTO deployments (repo_id, environment, timeline_slug, checkpoint_id, commit_oid, url, status)
        VALUES ('app', 'timeline/search', 'search', '${made.checkpoint.id}', '${oid(9)}', 'https://pr.example', 'active');
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
    t.app.refs.set("refs/heads/timeline/search", oid(9));
    t.lib.refs.set("refs/heads/timeline/search", oid(10));
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
          branch: "timeline/search",
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
      INSERT INTO deployments (id, repo_id, environment, timeline_slug, checkpoint_id, commit_oid, url, status)
        VALUES (5, 'app', 'timeline/search', 'search', '${t.made.checkpoint.id}', '${oid(9)}', 'https://pr.example', 'expired');
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
    // The bookmarks are gone: the runs check out main and fetch the commit by id.
    expect(startRun.mock.calls.map(([, , options]) => [options.branch, options.commit])).toEqual([
      ["main", oid(9)],
      ["main", oid(10)],
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
    t.app.refs.set("refs/heads/timeline/search", oid(9));
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
    expect((await t.call("ben", "GET", "/search")).body.timeline.status).toBe("active");
  });
});
