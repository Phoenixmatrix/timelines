import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { TimelineChange, TimelineDetail, TimelineList } from "../../shared/timelines.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { durableStorage } from "../testing/durable.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { Tracker } from "../tracker/object.ts";
import { timelines } from "./api.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");
const ZERO = "0".repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
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
  const call = async (who: keyof typeof tokens, method: string, path: string, body?: unknown) => {
    const response = await server.request(
      `/api/tracker/orbit/timelines${path}`,
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
  return { sqlite, git, app, lib, call };
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
