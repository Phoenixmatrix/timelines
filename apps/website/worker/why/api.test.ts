import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { CheckpointState, Landing, Timeline, TimelineEvent } from "../../shared/timelines.ts";
import type { WhyResponse } from "../../shared/why.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import type { PackCommit } from "../git/pack.ts";
import { recordRefs } from "../ref-log/record.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { fakeHistory } from "../testing/history.ts";
import { Timing } from "../timing.ts";
import * as artifacts from "../artifacts.ts";
import { byCommit, parseCommit, parseLines, why } from "./api.ts";

// loadRepo's module reaches the knowledge coordinator, a Durable Object.
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    public ctx: unknown;
    public env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const CHANGE = "kpqrstuvkpqrstuv";
const file = (...lines: string[]) => ({ "src/app.ts": `${lines.join("\n")}\n` });

beforeEach(() => {
  // RepoReader's shared cache, and no upstream fetches: change ids come from the push log.
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});
const closers: (() => void)[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const close of closers.splice(0)) close();
});

/**
 * A timeline's life, end to end: change CHANGE is written on timeline/search
 * as X1 (by an agent), checkpointed, rebased onto a newer main as X2,
 * checkpointed and approved again, and landed on main by a merge.
 */
async function setup() {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  closers.push(close);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('bob', 'user', 'bob', 'Bob');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'bot', 'ann');
  `);
  await seedSpaceFixture(env.DB, {
    organization: { id: "orbit-org", slug: "orbit-org", displayName: "Orbit", kind: "company" },
    space: { id: "orbit", slug: "orbit", displayName: "General" },
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "ann",
  });
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
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
        space: "orbit",
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
  const landingToken = await issueToken(
    env.DB,
    "ann",
    "landing origin",
    "write",
    undefined,
    "agt_bot",
  );
  const authority = await captureWorkAuthority(env, "app", {
    id: "ann",
    agent: { id: "agt_bot", name: "bot" },
    credential: { kind: "token", id: landingToken.id },
  });
  const queued: Landing = {
    id: "ld_search",
    timelineId: timeline.id,
    slug: timeline.slug,
    checkpointId: "cp_2",
    checkpointNumber: 2,
    authority,
    state: "landed",
    repos: [
      {
        id: "app",
        space: "orbit",
        name: "app",
        commit: x2,
        base: m1,
        merge: landing,
        attempt: 1,
        state: "advanced",
        mergeRun: { id: "run_merge", number: 4 },
        gateRun: { id: "run_gates", number: 5 },
        reason: null,
      },
    ],
    reason: null,
    trigger: "approval",
    requestedBy: { actorId: "ann", accountableId: "ann", agentId: "agt_bot" },
    version: 5,
    createdAt: "2026-10-03T02:30:00.000Z",
    updatedAt: "2026-10-03T03:00:00.000Z",
  };
  const tracker = {
    listTimelines: async () => ({ ok: true, value: [timeline] }),
    timeline: async (_access: unknown, slug: string) =>
      slug === "search"
        ? {
            ok: true,
            value: { timeline, events, next: null, issues: [{ ...issue, doneIn: null }] },
          }
        : { ok: false, status: 404, error: "No timeline", code: "not_found" },
    checkpoints: async () => ({ ok: true, value: checkpoints }),
    landingForCommit: async (_access: unknown, repoId: string, commit: string) => ({
      ok: true,
      value: queued.repos.some(
        (repo) => repo.id === repoId && repo.merge === commit && repo.state === "advanced",
      )
        ? queued
        : null,
    }),
    checkpoint: async () => ({ ok: true, value: checkpoints[0]! }),
    subscribedProjects: async () => ({ ok: true, value: ["ws"] }),
    issuesByKey: async (_access: unknown, keys: string[]) => ({
      ok: true,
      value: keys.includes(issue.key) ? [{ ...issue, description: "", labels: [] }] : [],
    }),
  };
  Object.assign(env, {
    ARTIFACTS: git.artifacts,
    // Ann's own tracker subscribes nothing to the repository.
    TRACKER: {
      getByName: (id: string) =>
        id === "orbit" ? tracker : { subscribedProjects: async () => ({ ok: true, value: [] }) },
    },
  });

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    c.set("timing", new Timing());
    return next();
  });
  app.route("/api/repos/:space/:name", why);
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
  return {
    sqlite,
    env,
    git,
    get,
    commits: { m0, x1, m1, x2, landing },
    landingUpdate,
    queued,
    checkpoints,
    events,
    push,
  };
}

describe("GET /why", () => {
  test("an Organization owner loses private Tracker facts immediately when its Space grant is removed", async () => {
    const t = await setup();
    const query = `commit=${t.commits.x1}`;
    expect((await t.get("ann", query)).body.tracker.readable).toBe(true);
    t.sqlite.exec("DELETE FROM space_grants WHERE space_id = 'orbit' AND account_id = 'ann'");
    const { status, body } = await t.get("ann", query);
    expect(status).toBe(200);
    expect(body.tracker).toEqual({ space: "orbit", readable: false });
    expect(body.chains[0]).toMatchObject({ timelines: [], checkpoints: [], issues: [] });
    expect(body.chains[0]!.changeId).toBe(CHANGE);
  });

  test("a repository collaborator gains no Space Tracker facts", async () => {
    const t = await setup();
    t.sqlite.exec(`
      UPDATE repos SET visibility = 'private' WHERE id = 'app';
      INSERT INTO repo_collaborators(repo_id,user_id,role) VALUES('app','bob','read');
    `);
    const { status, body } = await t.get("bob", `commit=${t.commits.x1}`);
    expect(status).toBe(200);
    expect(body.tracker.readable).toBe(false);
    expect(body.chains[0]).toMatchObject({ timelines: [], checkpoints: [], issues: [] });
    t.sqlite.exec("DELETE FROM repo_collaborators WHERE repo_id = 'app' AND user_id = 'bob'");
    expect((await t.get("bob", `commit=${t.commits.x1}`)).status).toBe(404);
  });

  test("work provenance uses exact compact membership and remains truthful after source expiry", async () => {
    const t = await setup();
    const { m0, x1, x2, landing } = t.commits;
    const source = {
      sourceId: "work_search",
      repoId: "app",
      timelineId: "tl_search",
      kind: "timeline-work" as const,
      ref: "refs/heads/work",
    };
    t.sqlite.exec(`
      INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,space_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,initial_token_revoked,created_at,updated_at)
      VALUES('work_search','app','tl_search','search','orbit','work-search','https://work','archived','allocate','canonical','${m0}','base-tree','refs/heads/main','canonical','${m0}','base-tree','refs/heads/main',1,'now','now');
      INSERT INTO source_integration_receipts(id,landing_id,checkpoint_id,repo_id,source_id,source_commit,source_tree,logical_base_json,dependencies_json,canonical_base,canonical_commit,canonical_tree,noop,status,created_at,completed_at)
      VALUES('receipt','ld_search','cp_2','app','work_search','${x2}','work-tree','{}','[]','${m0}','${landing}','canonical-tree',0,'complete','now','now');
      INSERT INTO source_integration_members(receipt_id,repo_id,source_id,commit_oid) VALUES('receipt','app','work_search','${x2}');
    `);
    for (const checkpoint of t.checkpoints)
      checkpoint.checkpoint.repos[0]!.source = {
        ...source,
        commit: checkpoint.checkpoint.repos[0]!.commit,
        tree: "work-tree",
      };
    t.queued.repos[0]!.source = { ...source, commit: x2, tree: "work-tree" };
    const resolve = vi
      .spyOn(artifacts, "lsRefs")
      .mockResolvedValue([{ name: "refs/heads/main", oid: landing }]);
    try {
      const compact = await t.get("ann", `source=work_search&commit=${x2}:${CHANGE}`);
      expect(compact.status).toBe(200);
      expect(compact.body.chains[0]).toMatchObject({
        source,
        lineage: { status: "integrated" },
        landing: { via: "compact", commit: landing, update: null, queue: { id: "ld_search" } },
      });
      expect(compact.body.chains[0]!.checkpoints.map((checkpoint) => checkpoint.commit)).toEqual([
        x2,
      ]);
      const rewritten = await t.get("ann", `source=work_search&commit=${x1}:${CHANGE}`);
      expect(rewritten.body.chains[0]).toMatchObject({
        lineage: { status: "unknown" },
        landing: null,
      });
      t.sqlite.exec(
        "UPDATE timeline_work_sources SET state='purged', artifacts_remote=NULL WHERE source_id='work_search'",
      );
      const expired = await t.get("ann", `source=work_search&commit=${x2}:${CHANGE}`);
      expect(expired.body.chains[0]).toMatchObject({
        commit: null,
        lineage: { status: "expired" },
        landing: { via: "compact", commit: landing },
      });
      expect(
        (await t.get("ann", `source=work_search&path=src/app.ts&line=2&rev=${x2}`)).status,
      ).toBe(410);
    } finally {
      resolve.mockRestore();
    }
  });

  test("follows a line to its commit, change, timeline, issue, checkpoints, approval and landing", async () => {
    const t = await setup();
    const { x1, x2, m1, landing } = t.commits;
    const { status, body } = await t.get("ann", `path=src/app.ts&line=2-3&rev=${landing}`);
    expect(status).toBe(200);
    expect(body.tracker).toEqual({ space: "orbit", readable: true });
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
      expect.objectContaining({ key: "CORE-7", trackerSpace: "orbit", source: "commit" }),
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
      via: "queue",
      timeline: "search",
      update: { id: t.landingUpdate },
      queue: {
        id: "ld_search",
        checkpointId: "cp_2",
        checkpointNumber: 2,
        trigger: "approval",
        requestedBy: { actorId: "ann", accountableId: "ann", agentId: "agt_bot" },
        mergeRun: { id: "run_merge", number: 4 },
        gateRun: { id: "run_gates", number: 5 },
      },
    });
    expect(body.people).toEqual({
      ann: { name: "Ann", kind: "person", slug: "ann" },
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
    expect(tidy.landing).toMatchObject({ via: "push", timeline: null, queue: null, commit: m1 });
    // The rebase carried it into the timeline afterwards: listed, but not where it came from.
    expect(tidy.refs.map((r) => [r.ref, r.afterLanding])).toEqual([
      ["refs/heads/main", false],
      ["refs/heads/timeline/search", true],
    ]);
  });

  test("a landed line shows the step behind it, through its change after a rebase (CORE-243)", async () => {
    const t = await setup();
    const { x1, x2, landing } = t.commits;
    const step = (oid: string, why: string, at: string) =>
      t.sqlite
        .prepare(
          `INSERT INTO step_contexts (repo_id, change_id, commit_oid, author_id, accountable_id,
             timeline, summary, context, committed_at, verified_at)
           VALUES ('app', ?, ?, 'agt_bot', 'ann', 'search', 'Rank search by title', ?, ?, ?)`,
        )
        .run(
          CHANGE,
          oid,
          JSON.stringify({ why, steering: [{ text: "Use titles", source: "hook" }] }),
          at,
          at,
        );
    // Only the step before the rebase was recorded: the landed line still finds it.
    step(x1, "Titles match what people type.", "2026-10-03T01:00:00.000Z");
    let { body } = await t.get("ann", `path=src/app.ts&line=2-3&rev=${landing}`);
    expect(body.chains[0]!.step).toMatchObject({
      changeId: CHANGE,
      commitOid: x1,
      timeline: "search",
      author: { kind: "agent", name: "bot" },
      context: {
        why: "Titles match what people type.",
        steering: [{ text: "Use titles", source: "hook" }],
      },
    });
    // Main's own line has no step.
    expect(body.chains[1]!.step).toBeNull();
    // The landed commit's own step wins once there is one.
    step(x2, "Rebased onto main.", "2026-10-03T02:00:00.000Z");
    ({ body } = await t.get("ann", `path=src/app.ts&line=2&rev=${landing}`));
    expect(body.chains[0]!.step).toMatchObject({
      commitOid: x2,
      context: { why: "Rebased onto main." },
    });
    // Steps are as readable as the repository: Bob reads this public one, step included.
    const bob = await t.get("bob", `path=src/app.ts&line=2&rev=${landing}`);
    expect(bob.body.chains[0]!.step?.commitOid).toBe(x2);
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
    expect(chain.landing).toMatchObject({ via: "queue", timeline: "search", commit: t.commits.x2 });
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
    expect(chain.landing).toMatchObject({ via: "unknown", timeline: null, queue: null });
    expect(body.people).toEqual({});
  });

  test("a queue landing needs no merge event, and survives a subsequent main rewrite", async () => {
    const t = await setup();
    t.events.length = 0;
    await t.push({ "refs/heads/main": t.commits.x1 });
    const { body } = await t.get("ann", `commit=${t.commits.x1}`);
    expect(body.chains[0]!.landing).toMatchObject({
      commit: t.commits.x2,
      update: { new: t.commits.landing },
      via: "queue",
      queue: { id: "ld_search", checkpointId: "cp_2" },
    });
  });

  test("an exact queue advance does not depend on the checkpoint's bounded change index", async () => {
    const t = await setup();
    t.checkpoints[0]!.checkpoint.repos[0]!.changes = [];
    const { body } = await t.get("ann", `commit=${t.commits.x2}`);
    expect(body.chains[0]!.landing).toMatchObject({
      via: "queue",
      timeline: "search",
      update: { new: t.commits.landing },
      queue: { id: "ld_search", checkpointId: "cp_2" },
    });
  });

  test.each(["failed", "conflict", "testing"] as const)(
    "an unadvanced %s attempt is not a landing",
    async (state) => {
      const t = await setup();
      t.queued.repos[0]!.state = state;
      const { body } = await t.get("ann", `commit=${t.commits.x2}`);
      expect(body.chains[0]!.landing).toMatchObject({ via: "push", timeline: null, queue: null });
    },
  );

  test.each(["repo", "checkpoint", "checkpoint repo", "checkpoint timeline", "tip"] as const)(
    "does not attribute an unrelated %s",
    async (mismatch) => {
      const t = await setup();
      if (mismatch === "repo") t.queued.repos[0]!.id = "other";
      if (mismatch === "checkpoint") t.queued.checkpointId = "cp_unrelated";
      if (mismatch === "checkpoint repo")
        t.checkpoints[0]!.checkpoint.repos[0]!.commit = t.commits.m1;
      if (mismatch === "checkpoint timeline")
        t.checkpoints[0]!.checkpoint.timelineId = "tl_unrelated";
      if (mismatch === "tip") t.queued.repos[0]!.merge = t.commits.m1;
      const { body } = await t.get("ann", `commit=${t.commits.x2}`);
      expect(body.chains[0]!.landing).toMatchObject({ via: "push", timeline: null, queue: null });
    },
  );

  test("a partly landed attempt proves only this advanced repository and discloses only its runs", async () => {
    const t = await setup();
    t.queued.state = "failed";
    t.queued.repos.push({
      ...t.queued.repos[0]!,
      id: "private-lib",
      name: "private-lib",
      state: "failed",
      gateRun: { id: "private-run", number: 99 },
    });
    const { body } = await t.get("ann", `commit=${t.commits.x2}`);
    expect(body.chains[0]!.landing?.queue).toEqual({
      id: "ld_search",
      checkpointId: "cp_2",
      checkpointNumber: 2,
      trigger: "approval",
      requestedBy: { actorId: "ann", accountableId: "ann", agentId: "agt_bot" },
      mergeRun: { id: "run_merge", number: 4 },
      gateRun: { id: "run_gates", number: 5 },
    });
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
