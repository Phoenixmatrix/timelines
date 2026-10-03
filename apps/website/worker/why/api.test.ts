import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { CheckpointState, Timeline, TimelineEvent } from "../../shared/timelines.ts";
import type { WhyResponse } from "../../shared/why.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import type { PackCommit } from "../git/pack.ts";
import { recordRefs } from "../ref-log/record.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeHistory } from "../testing/history.ts";
import { Timing } from "../timing.ts";
import { byCommit, parseCommit, parseLines, why } from "./api.ts";

// loadRepo's module reaches the knowledge coordinator, a Durable Object.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const CHANGE = "kpqrstuvkpqrstuv";
const file = (...lines: string[]) => ({ "src/app.ts": `${lines.join("\n")}\n` });

beforeEach(() => {
  // RepoReader's shared cache, and no upstream fetches: change ids come from the push log.
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});
afterEach(() => vi.unstubAllGlobals());

/**
 * A timeline's life, end to end: change CHANGE is written on timeline/search
 * as X1 (by an agent), checkpointed, rebased onto a newer main as X2,
 * checkpointed and approved again, and landed on main by a merge.
 */
async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('bob', 'user', 'bob', 'Bob'),
      ('orbit', 'org', 'orbit', 'Orbit');
    INSERT INTO org_members (org_id, user_id, role) VALUES ('orbit', 'ann', 'owner');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'bot', 'ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('app', 'orbit', 'app', 'public', 'why-${crypto.randomUUID()}', 'https://app');
  `);
  const git = fakeHistory();
  const changeIds = new Map<string, string>();
  const make = (spec: Parameters<typeof git.commit>[0], changeId: string) => {
    const oid = git.commit(spec);
    changeIds.set(oid, changeId);
    return oid;
  };
  const m0 = make({ files: file("a", "b", "c"), message: "Start" }, "mmmmzero");
  const x1 = make(
    { parents: [m0], files: file("a", "B2", "c"), message: "Rank search by title (CORE-7)" },
    CHANGE,
  );
  const m1 = make({ parents: [m0], files: file("a", "b", "C3"), message: "Tidy" }, "mmmmone1");
  const x2 = make(
    { parents: [m1], files: file("a", "B2", "C3"), message: "Rank search by title (CORE-7)" },
    CHANGE,
  );
  const landing = make(
    { parents: [m1, x2], files: file("a", "B2", "C3"), message: "Land timeline/search" },
    "llllland",
  );

  const env = { DB: d1(sqlite) } as unknown as Env;
  const reachable = (from: string[]) => {
    const seen = new Set<string>();
    for (const stack = [...from]; stack.length;) {
      const oid = stack.pop()!;
      if (seen.has(oid) || !git.commits.has(oid)) continue;
      seen.add(oid);
      stack.push(...git.commits.get(oid)!.parents);
    }
    return seen;
  };
  const push = (tips: Record<string, string>, agent = false) =>
    recordRefs(
      env.DB,
      "app",
      new Map(Object.entries(tips)),
      { id: "ann", ...(agent ? { agent: { id: "agt_bot", name: "bot" } } : {}) },
      async (want, haves) => {
        const had = reachable(haves);
        const commits: PackCommit[] = [...reachable([want])]
          .filter((oid) => !had.has(oid))
          .map((oid) => ({
            oid,
            parents: git.commits.get(oid)!.parents,
            changeId: changeIds.get(oid) ?? null,
          }))
          // Newest first, as packs have them.
          .sort(
            (a, b) => git.commits.get(b.oid)!.committedAt - git.commits.get(a.oid)!.committedAt,
          );
        return { commits, truncated: false };
      },
    );
  await push({ "refs/heads/main": m0 });
  await push({ "refs/heads/main": m0, "refs/heads/timeline/search": x1 }, true);
  await push({ "refs/heads/main": m1, "refs/heads/timeline/search": x1 });
  await push({ "refs/heads/main": m1, "refs/heads/timeline/search": x2 }, true);
  const landed = await push({ "refs/heads/main": landing, "refs/heads/timeline/search": x2 });
  const landingUpdate = landed.find((u) => u.ref === "refs/heads/main")!.id;

  // Orbit's tracker: the timeline, its merge into main, two checkpoints, one issue.
  const timeline = {
    id: "tl_search",
    slug: "search",
    name: "Search v2",
    policy: "approval",
    experimental: false,
    status: "landed",
  } as Timeline;
  const events: TimelineEvent[] = [
    {
      id: `merge:app:${landing}:${x2}`,
      seq: 9,
      timelineId: "tl_search",
      kind: "merge",
      fromId: "tl_search",
      intoId: null,
      repoId: "app",
      commit: landing,
      parent: x2,
      refUpdateId: landingUpdate,
      actorId: "ann",
      accountableId: "ann",
      createdAt: "2026-10-03T03:00:00.000Z",
    },
  ];
  const checkpoint = (number: number, commit: string, at: string) => ({
    id: `cp_${number}`,
    timelineId: "tl_search",
    number,
    repos: [
      {
        id: "app",
        owner: "orbit",
        name: "app",
        commit,
        base: m0,
        changes: [{ changeId: CHANGE, commit }],
      },
    ],
    summary: `Checkpoint ${number}`,
    actorId: "agt_bot",
    accountableId: "ann",
    createdAt: at,
  });
  const checkpoints: CheckpointState[] = [
    {
      checkpoint: checkpoint(2, x2, "2026-10-03T02:00:00.000Z"),
      current: true,
      approval: {
        requestId: "req_2",
        state: "approved",
        by: "ann",
        at: "2026-10-03T02:30:00.000Z",
        note: "Ship it",
      },
      approved: true,
    },
    {
      checkpoint: checkpoint(1, x1, "2026-10-03T01:00:00.000Z"),
      current: false,
      approval: {
        requestId: "req_1",
        state: "superseded",
        by: "ann",
        at: "2026-10-03T01:30:00.000Z",
        note: "New commits",
      },
      approved: false,
    },
  ];
  const issue = { id: "iss_7", key: "CORE-7", title: "Rank search by title", status: "done" };
  const tracker = {
    listTimelines: async () => ({ ok: true, value: [timeline] }),
    timeline: async (slug: string) =>
      slug === "search"
        ? {
            ok: true,
            value: { timeline, events, next: null, issues: [{ ...issue, doneIn: null }] },
          }
        : { ok: false, status: 404, error: "No timeline", code: "not_found" },
    checkpoints: async () => ({ ok: true, value: checkpoints }),
    subscribedWorkspaces: async () => ({ ok: true, value: ["ws"] }),
    issuesByKey: async (keys: string[]) => ({
      ok: true,
      value: keys.includes(issue.key) ? [{ ...issue, description: "", labels: [] }] : [],
    }),
  };
  Object.assign(env, {
    ARTIFACTS: git.artifacts,
    // Ann's own tracker subscribes nothing to the repository.
    TRACKER: {
      getByName: (id: string) =>
        id === "orbit" ? tracker : { subscribedWorkspaces: async () => ({ ok: true, value: [] }) },
    },
  });

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    c.set("timing", new Timing());
    return next();
  });
  app.route("/api/repos/:owner/:name", why);
  const tokens = {
    ann: (await issueToken(env.DB, "ann", "t", "read")).secret,
    bob: (await issueToken(env.DB, "bob", "t", "read")).secret,
  };
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} };
  const get = async (who: keyof typeof tokens, query: string) => {
    const response = await app.request(
      `/api/repos/orbit/app/why?${query}`,
      { headers: { authorization: `Bearer ${tokens[who]}` } },
      env,
      ctx as unknown as ExecutionContext,
    );
    return { status: response.status, body: (await response.json()) as WhyResponse };
  };
  return { get, commits: { m0, x1, m1, x2, landing }, landingUpdate };
}

describe("GET /why", () => {
  test("follows a line to its commit, change, timeline, issue, checkpoints, approval and landing", async () => {
    const t = await setup();
    const { x1, x2, m1, landing } = t.commits;
    const { status, body } = await t.get("ann", `path=src/app.ts&line=2-3&rev=${landing}`);
    expect(status).toBe(200);
    expect(body.tracker).toEqual({ owner: "orbit", readable: true });
    expect(body.blame).toMatchObject({ source: "server", path: "src/app.ts", head: landing });
    // Line 2 came from the timeline's commit (not the landing merge); line 3 from main.
    expect(body.blame!.lines).toEqual([
      { line: 2, commit: x2, originalLine: 2 },
      { line: 3, commit: m1, originalLine: 3 },
    ]);
    expect(body.chains.map((chain) => chain.oid)).toEqual([x2, m1]);

    const chain = body.chains[0]!;
    expect(chain.commit?.message).toBe("Rank search by title (CORE-7)");
    expect(chain.lines).toEqual([2]);
    expect(chain).toMatchObject({ changeId: CHANGE, changeSource: "push-log" });
    expect(
      chain.refs.map((r) => [r.ref, r.kind, r.firstCommit, r.lastCommit, r.rewritten]),
    ).toEqual([
      ["refs/heads/timeline/search", "timeline", x1, x2, true],
      ["refs/heads/main", "main", x2, x2, false],
    ]);
    // Who pushed it to the timeline: the agent, for Ann.
    expect(chain.refs[0]!.firstUpdate).toMatchObject({ actor: "ann", agent: "bot" });
    expect(chain.timelines.map((tl) => [tl.slug, tl.name, tl.status])).toEqual([
      ["search", "Search v2", "landed"],
    ]);
    expect(chain.merges).toEqual([
      expect.objectContaining({ from: "search", into: null, commit: landing, parent: x2 }),
    ]);
    expect(chain.issues).toEqual([
      expect.objectContaining({ key: "CORE-7", trackerOwner: "orbit", source: "commit" }),
    ]);
    // Both checkpoints pinned the change, the first as X1, before the rebase.
    expect(chain.checkpoints.map((c) => [c.number, c.commit, c.approval?.state])).toEqual([
      [1, x1, "superseded"],
      [2, x2, "approved"],
    ]);
    expect(chain.approval).toMatchObject({
      state: "approved",
      by: "ann",
      timeline: "search",
      number: 2,
      checkpointId: "cp_2",
    });
    expect(chain.landing).toMatchObject({
      ref: "refs/heads/main",
      commit: x2,
      via: "merge",
      timeline: "search",
      update: { id: t.landingUpdate },
      merge: { commit: landing },
    });
    expect(body.people).toEqual({
      ann: { name: "Ann", kind: "person" },
      agt_bot: { name: "bot", kind: "agent" },
    });
    expect(chain.discussions).toEqual({
      available: false,
      reason: expect.stringContaining("CORE-51"),
      threads: [],
    });

    // Main's own commit: pushed straight there, no timeline.
    const tidy = body.chains[1]!;
    expect(tidy).toMatchObject({ changeId: "mmmmone1", timelines: [], checkpoints: [] });
    expect(tidy.landing).toMatchObject({ via: "push", timeline: null, merge: null, commit: m1 });
    // The rebase carried it into the timeline afterwards: listed, but not where it came from.
    expect(tidy.refs.map((r) => [r.ref, r.afterLanding])).toEqual([
      ["refs/heads/main", false],
      ["refs/heads/timeline/search", true],
    ]);
  });

  test("survives a rebase: a commit the server never saw resolves through its change id", async () => {
    const t = await setup();
    // gm blamed a local rewrite of the change (say, after `gm rebase`) and read its change id.
    const local = "f".repeat(40);
    const { status, body } = await t.get("ann", `commit=${local}:${CHANGE}`);
    expect(status).toBe(200);
    expect(body.blame).toBeNull();
    const chain = body.chains[0]!;
    expect(chain).toMatchObject({
      oid: local,
      commit: null,
      changeId: CHANGE,
      changeSource: "client",
    });
    expect(chain.checkpoints.map((c) => c.number)).toEqual([1, 2]);
    expect(chain.approval).toMatchObject({ state: "approved", number: 2 });
    expect(chain.landing).toMatchObject({ via: "merge", timeline: "search", commit: t.commits.x2 });
    // Issue keys come from the change's commits on the server.
    expect(chain.issues.map((i) => i.key)).toEqual(["CORE-7"]);
  });

  test("and the commit before the rebase resolves to the same history", async () => {
    const t = await setup();
    const { body } = await t.get("ann", `commit=${t.commits.x1}`);
    const chain = body.chains[0]!;
    expect(chain).toMatchObject({ changeId: CHANGE, changeSource: "push-log" });
    expect(chain.landing).toMatchObject({ commit: t.commits.x2, timeline: "search" });
  });

  test("someone who can't read the tracker gets the git half only", async () => {
    const t = await setup();
    const { status, body } = await t.get("bob", `path=src/app.ts&line=2&rev=${t.commits.landing}`);
    expect(status).toBe(200);
    expect(body.tracker.readable).toBe(false);
    const chain = body.chains[0]!;
    expect(chain.changeId).toBe(CHANGE);
    expect(chain.refs.map((r) => [r.ref, r.timeline])).toEqual([
      ["refs/heads/timeline/search", null],
      ["refs/heads/main", null],
    ]);
    expect(chain).toMatchObject({ timelines: [], merges: [], checkpoints: [], issues: [] });
    expect(chain.approval).toBeNull();
    expect(chain.landing).toMatchObject({ via: "unknown", timeline: null });
  });

  test("rejects requests it can't answer", async () => {
    const t = await setup();
    const rev = `rev=${t.commits.landing}`;
    expect((await t.get("ann", `path=src/app.ts&${rev}`)).status).toBe(400);
    expect((await t.get("ann", `path=src/app.ts&line=1-500&${rev}`)).status).toBe(400);
    expect((await t.get("ann", `path=../etc&line=1&${rev}`)).status).toBe(400);
    expect((await t.get("ann", `path=src/app.ts&line=9&${rev}`)).status).toBe(400);
    expect((await t.get("ann", `path=src/nope.ts&line=1&${rev}`)).status).toBe(404);
    expect((await t.get("ann", "commit=nope")).status).toBe(400);
  });
});

describe("parsing", () => {
  test("lines and commits", () => {
    expect(parseLines("12")).toEqual({ start: 12, end: 12 });
    expect(parseLines("20-12")).toEqual({ start: 12, end: 20 });
    expect(parseLines("0")).toBeNull();
    expect(parseLines("1-")).toBeNull();
    const oid = "a".repeat(40);
    expect(parseCommit(oid)).toEqual({ oid, changeId: null });
    expect(parseCommit(`${oid}:kkkkmmmm`)).toEqual({ oid, changeId: "kkkkmmmm" });
    expect(parseCommit(`${oid}:K!`)).toBeNull();
    expect(parseCommit("abc")).toBeNull();
  });

  test("groups blamed lines by commit in line order", () => {
    expect([
      ...byCommit([
        { line: 1, commit: "b" },
        { line: 2, commit: "a" },
        { line: 3, commit: "b" },
      ]),
    ]).toEqual([
      ["b", [1, 3]],
      ["a", [2]],
    ]);
  });
});
