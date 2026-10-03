// The landing queue (CORE-77): two timelines landing in parallel (one when
// green, one after approval), a conflict that asks for a sync, gates that
// fail, and a multi-repository landing that is partly landed and retries.
// Git and CI are the in-memory fakes: a merge job "runs" when a test points
// the landing branch at a merge commit and marks its run finished.

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { Landing, LandResult, TimelineDetail } from "../../shared/timelines.ts";
import type { Issue, Snapshot } from "../../shared/tracker.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { durableStorage } from "../testing/durable.ts";
import { fakeRemotes, type FakeRemote } from "../testing/remote.ts";
import { Tracker } from "../tracker/object.ts";
import { tracker as trackerRoutes } from "../tracker/api.ts";
import { trackerObject } from "../tracker/stub.ts";
import { logPush } from "./activity.ts";
import { timelines } from "./api.ts";
import { afterRun, progress, workerDeps, type LandingDeps } from "./landing.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");

afterEach(() => {
  vi.unstubAllGlobals();
});

async function setup() {
  const sqlite = migratedDatabase();
  // Ann owns Orbit; Ben writes to its repositories; his agent bot works for him.
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name, member_repo_role) VALUES
      ('ann', 'user', 'ann', 'Ann', NULL), ('ben', 'user', 'ben', 'Ben', NULL),
      ('orbit', 'org', 'orbit', 'Orbit', 'read');
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('orbit', 'ann', 'owner'), ('orbit', 'ben', 'member');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_bot', 'bot', 'ben');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('app', 'orbit', 'app', 'private', 'r-app', 'https://app'),
      ('lib', 'orbit', 'lib', 'private', 'r-lib', 'https://lib');
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES
      ('app', 'ben', 'write'), ('lib', 'ben', 'write');
  `);
  const git = fakeRemotes();
  const remotes: Record<string, FakeRemote> = {
    app: git.add("https://app", { "refs/heads/main": oid(1) }),
    lib: git.add("https://lib", { "refs/heads/main": oid(2) }),
  };
  vi.stubGlobal("fetch", git.fetch);
  const trackers = new Map<string, Tracker>();
  const workflows: string[] = [];
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    CI_RUNNER: "local",
    // Like Workflows: an instance id is created once.
    CI_RUN: {
      create: async ({ id }: { id: string }) => {
        if (workflows.includes(id)) throw new Error(`instance ${id} already exists`);
        workflows.push(id);
        return { id };
      },
      get: async (id: string) => {
        if (!workflows.includes(id)) throw new Error(`no instance ${id}`);
        return { id };
      },
    },
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
    bot: (await issueToken(env.DB, "ben", "t", "write", undefined, "agt_bot")).secret,
  };
  const pending: Promise<unknown>[] = [];
  const drain = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
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
    await drain();
    return { status: response.status, body: (await response.json()) as any };
  };
  const call = (who: keyof typeof tokens, method: string, path: string, body?: unknown) =>
    raw(who, method, `/tracker/orbit/timelines${path}`, body);

  // CI as the queue sees it: merge jobs start for real (rows and a Workflow);
  // gates are rows the test finishes; parents are what the merge job made.
  const parents = new Map<string, string[]>();
  const moved: string[] = [];
  /** Ref writes go through here: a test may step in, as another worker would. */
  const hooks: {
    beforeWrite?: (repo: string, ref: string) => void | Promise<void>;
  } = {};
  const base = workerDeps(env, (work) => pending.push(work));
  const deps: LandingDeps = {
    ...base,
    writeRefs: async (repo, writes) => {
      for (const write of writes) await hooks.beforeWrite?.(repo.id, write.ref);
      return base.writeRefs(repo, writes);
    },
    parents: async (_repo, commit) => parents.get(commit) ?? (git.commits.has(commit) ? [] : null),
    startGates: async (repo, options) => {
      sqlite
        .prepare(
          `INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, title, status, landing_id)
           VALUES (?, ?, (SELECT coalesce(max(number), 0) + 1 FROM ci_runs WHERE repo_id = ?), ?, ?, 'manual', 'gates', 'queued', ?)`,
        )
        .run(options.runId, repo.id, repo.id, options.commit, options.branch, options.landingId);
      sqlite
        .prepare(
          `INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES (?, ?, ?, 'test', '{}', 'queued', 'local')`,
        )
        .run(`job-${options.runId}`, options.runId, repo.id);
      return { runId: options.runId };
    },
    mainMoved: (repo, actor) => {
      moved.push(repo.id);
      pending.push(logPush(env, repo, actor));
    },
  };

  let commit = 100;
  /** Push work to a timeline's bookmark in a repository. */
  const push = (repo: string, slug: string) => {
    const at = oid(++commit);
    git.commits.add(at);
    remotes[repo]!.refs.set(`refs/heads/timeline/${slug}`, at);
    return at;
  };
  const landing = async (slug: string): Promise<Landing> =>
    (await call("ben", "GET", `/${slug}/landing`)).body.landing;
  const repoOf = async (slug: string, repo: string) =>
    (await landing(slug)).repos.find((r) => r.id === repo)!;
  const finish = async (runId: string, status: "succeeded" | "failed", exitCode?: number) => {
    sqlite
      .prepare(`UPDATE ci_runs SET status = ?, finished_at = ? WHERE id = ?`)
      .run(status, new Date().toISOString(), runId);
    sqlite
      .prepare(`UPDATE ci_jobs SET status = ?, exit_code = ? WHERE run_id = ?`)
      .run(status, exitCode ?? (status === "succeeded" ? 0 : 1), runId);
    await afterRun(env, deps, runId);
    await drain();
  };
  /** The merge job of a repository's current attempt merged cleanly. */
  const merged = async (slug: string, repo: string) => {
    const r = await repoOf(slug, repo);
    const merge = oid(++commit);
    git.commits.add(merge);
    parents.set(merge, [r.base!, r.commit]);
    remotes[repo]!.refs.set(`refs/heads/gitmatrix/landing/${slug}`, merge);
    await finish(r.mergeRun!.id, "succeeded");
    return merge;
  };
  /** The gates on a repository's merge finished. */
  const gates = async (slug: string, repo: string, status: "succeeded" | "failed" = "succeeded") =>
    finish((await repoOf(slug, repo)).gateRun!.id, status);
  const mutate = (who: keyof typeof tokens, mutations: unknown[], timeline?: string) =>
    raw(who, "POST", "/tracker/orbit/mutate", {
      operationId: crypto.randomUUID(),
      mutations,
      ...(timeline ? { timeline } : {}),
    });
  const snapshot = async (timeline?: string): Promise<Snapshot> =>
    (await raw("ben", "GET", `/tracker/orbit/snapshot${timeline ? `?timeline=${timeline}` : ""}`))
      .body;
  await mutate("ann", [
    { kind: "team.create", id: "team", data: { key: "ENG", name: "Eng" } },
    { kind: "issue.create", id: "a", data: { teamId: "team", title: "Search" } },
    { kind: "issue.create", id: "b", data: { teamId: "team", title: "UI" } },
  ]);
  /** The bot claims and finishes an issue inside a timeline. */
  const finishIssue = async (id: string, slug: string) => {
    const claimed = await mutate(
      "bot",
      [{ kind: "issue.claim", id, data: { agent: "bot" } }],
      slug,
    );
    await mutate(
      "bot",
      [
        {
          kind: "issue.complete",
          id,
          data: { leaseToken: claimed.body.results[0].leaseToken, evidence: "Done." },
        },
      ],
      slug,
    );
  };
  const fork = async (slug: string, policy: "auto" | "approval", repos = ["orbit/app"]) =>
    (await call("bot", "POST", "", { slug, policy, repos })).body.timeline;
  const checkpoint = async (slug: string) =>
    (await call("bot", "POST", `/${slug}/checkpoints`, {})).body;
  /** A CI run of a commit on the bookmark, still running. */
  const running = (repo: string, slug: string, commit: string) => {
    const id = crypto.randomUUID().replaceAll("-", "");
    sqlite
      .prepare(
        `INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, title, status)
         VALUES (?, ?, (SELECT coalesce(max(number), 0) + 1 FROM ci_runs WHERE repo_id = ?), ?, ?, 'push', 'x', 'running')`,
      )
      .run(id, repo, repo, commit, `timeline/${slug}`);
    return id;
  };
  /** A green CI run of the checkpoint's commit on the bookmark, which just ended. */
  const green = (repo: string, slug: string, commit: string) =>
    finish(running(repo, slug, commit), "succeeded");
  const detail = async (slug: string): Promise<TimelineDetail> =>
    (await call("ben", "GET", `/${slug}`)).body;
  return {
    env,
    deps,
    sqlite,
    remotes,
    hooks,
    workflows,
    moved,
    call,
    mutate,
    snapshot,
    push,
    fork,
    checkpoint,
    green,
    running,
    merged,
    gates,
    finish,
    landing,
    repoOf,
    finishIssue,
    detail,
  };
}

describe("the landing queue", () => {
  test("two timelines land in parallel: one when green, one after approval", async () => {
    const t = await setup();
    await t.fork("search", "auto");
    await t.fork("ui", "approval");
    await t.finishIssue("a", "search");
    await t.finishIssue("b", "ui");
    const searchWork = t.push("app", "search");
    const uiWork = t.push("app", "ui");
    const searchRun = t.running("app", "search", searchWork);
    await t.checkpoint("search");
    const ui = await t.checkpoint("ui");
    // Its CI is still running: not green, not queued.
    expect(await t.landing("search")).toBeNull();
    const wait = await t.call("bot", "POST", "/search/land");
    expect(wait.body).toMatchObject({ code: "not_green" });
    expect(wait.body.error).toMatch(/CI run #1 on orbit\/app is still running/);

    // An approval timeline doesn't land on its own, nor on request, before approval.
    const early = await t.call("bot", "POST", "/ui/land");
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject({ code: "needs_approval" });
    expect(early.body.error).toMatch(/needs a person's approval/);

    // The auto timeline's checkpoint goes green: it enters the queue.
    await t.finish(searchRun, "succeeded");
    expect(await t.landing("search")).toMatchObject({
      state: "merging",
      trigger: "auto",
      repos: [{ id: "app", base: oid(1), commit: searchWork, attempt: 1 }],
    });
    expect(t.remotes.app!.refs.get("refs/heads/gitmatrix/landing/search")).toBe(searchWork);
    expect((await t.detail("search")).timeline.status).toBe("landing");

    // A person approves ui's checkpoint: it enters the queue too.
    const ask = await t.mutate("bot", [
      {
        kind: "request.open",
        id: "req-ui",
        data: {
          issueId: "b",
          kind: "approval",
          prompt: "Land ui?",
          checkpoint: ui.checkpoint.id,
        },
      },
    ]);
    expect(ask.status).toBe(200);
    await t.mutate("ben", [{ kind: "request.answer", id: "req-ui", data: { approved: true } }]);
    expect(await t.landing("ui")).toMatchObject({ state: "merging", trigger: "approval" });

    // search merges, its gates pass, and main advances to the tested merge.
    const searchMerge = await t.merged("search", "app");
    expect(await t.repoOf("search", "app")).toMatchObject({ state: "testing", merge: searchMerge });
    expect(t.remotes.app!.refs.get("refs/heads/main")).toBe(oid(1));
    expect(await trackerObject(t.env, "orbit").landingForCommit("app", searchMerge)).toEqual({
      ok: true,
      value: null,
    });
    await t.gates("search", "app");
    expect(t.remotes.app!.refs.get("refs/heads/main")).toBe(searchMerge);
    expect(await t.landing("search")).toMatchObject({ state: "landed" });
    expect(t.moved).toEqual(["app"]);

    // ui's merge was tested on the old main: main moved, so it merges again.
    await t.merged("ui", "app");
    await t.gates("ui", "app");
    expect(t.remotes.app!.refs.get("refs/heads/main")).toBe(searchMerge);
    expect(await t.repoOf("ui", "app")).toMatchObject({
      state: "merging",
      attempt: 2,
      base: searchMerge,
      commit: uiWork,
    });
    const uiMerge = await t.merged("ui", "app");
    await t.gates("ui", "app");
    expect(t.remotes.app!.refs.get("refs/heads/main")).toBe(uiMerge);
    expect(await t.landing("ui")).toMatchObject({ state: "landed" });
    // Exact repository advances remain discoverable after a later landing.
    expect(await trackerObject(t.env, "orbit").landingForCommit("app", searchMerge)).toEqual({
      ok: true,
      value: await t.landing("search"),
    });
    expect(await trackerObject(t.env, "orbit").landingForCommit("lib", searchMerge)).toEqual({
      ok: true,
      value: null,
    });

    // Both landed: bookmarks and landing branches gone, issues done, leases released.
    for (const slug of ["search", "ui"]) {
      const { timeline, events } = await t.detail(slug);
      expect(timeline.status).toBe("landed");
      expect(timeline.endedAt).toEqual(expect.any(String));
      expect(t.remotes.app!.refs.has(`refs/heads/timeline/${slug}`)).toBe(false);
      expect(t.remotes.app!.refs.has(`refs/heads/gitmatrix/landing/${slug}`)).toBe(false);
      expect(
        events.filter((e) => e.kind === "landing").map((e) => (e as { outcome: string }).outcome),
      ).toEqual(["queued", "landed"]);
    }
    const main = await t.snapshot();
    for (const id of ["a", "b"])
      expect(main.issues.find((i) => i.id === id)).toMatchObject({
        status: "done",
        doneIn: null,
        claim: null,
      });
  });

  test("a conflict stops the landing and asks for a sync; main doesn't move", async () => {
    const t = await setup();
    await t.fork("search", "auto");
    await t.finishIssue("a", "search");
    const work = t.push("app", "search");
    await t.checkpoint("search");
    await t.green("app", "search", work);
    const run = (await t.repoOf("search", "app")).mergeRun!;
    await t.finish(run.id, "failed", 42);
    const landing = await t.landing("search");
    expect(landing).toMatchObject({
      state: "conflict",
      repos: [{ state: "conflict" }],
    });
    expect(landing.reason).toMatch(/needs a sync: merge main into timeline\/search/);
    expect(t.remotes.app!.refs.get("refs/heads/main")).toBe(oid(1));
    const { timeline, events } = await t.detail("search");
    expect(timeline.status).toBe("active");
    expect(events.at(-1)).toMatchObject({ kind: "landing", outcome: "conflict" });
    // The issue is still done in the timeline, its lease retained.
    const issue = (await t.snapshot()).issues.find((i) => i.id === "a") as Issue;
    expect(issue).toMatchObject({
      status: "done_in_timeline",
      claim: { retainedIn: { slug: "search" } },
    });
    // Green again doesn't retry the same checkpoint on its own.
    await t.green("app", "search", work);
    expect((await t.landing("search")).id).toBe(landing.id);
    // After a sync and a new checkpoint, it lands.
    const synced = t.push("app", "search");
    await t.checkpoint("search");
    await t.green("app", "search", synced);
    expect(await t.landing("search")).toMatchObject({ state: "merging" });
    await t.merged("search", "app");
    await t.gates("search", "app");
    expect(await t.landing("search")).toMatchObject({ state: "landed" });
  });

  test("failing gates stop it: main never advances to an untested merge", async () => {
    const t = await setup();
    await t.fork("search", "approval");
    t.push("app", "search");
    await t.checkpoint("search");
    // Approval timelines need a person; asking to land without one says so.
    const refused = await t.call("ben", "POST", "/search/land");
    expect(refused.body.code).toBe("needs_approval");
    await t.fork("quick", "auto");
    t.push("app", "quick");
    await t.checkpoint("quick");
    // No CI ran on it: nothing to wait for, so it's green and queued already.
    const queued = await t.call("ben", "POST", "/quick/land");
    expect(queued.status).toBe(200);
    expect((queued.body as LandResult).queued).toBe(false);
    await t.merged("quick", "app");
    await t.gates("quick", "app", "failed");
    const landing = await t.landing("quick");
    expect(landing.state).toBe("failed");
    expect(landing.reason).toMatch(/The gates failed on the merge into orbit\/app's main/);
    expect(t.remotes.app!.refs.get("refs/heads/main")).toBe(oid(1));
    expect((await t.detail("quick")).timeline.status).toBe("active");
    // Asking again retries.
    const again = await t.call("ben", "POST", "/quick/land");
    expect(again.status).toBe(202);
    expect((again.body as LandResult).landing.id).not.toBe(landing.id);
  });

  test("across repositories: prepared everywhere first, then partly landed, then retried", async () => {
    const t = await setup();
    await t.fork("wide", "auto", ["orbit/app", "orbit/lib"]);
    t.push("app", "wide");
    t.push("lib", "wide");
    await t.checkpoint("wide");
    await t.call("ben", "POST", "/wide/land");
    expect((await t.landing("wide")).repos.map((r) => r.state)).toEqual(["merging", "merging"]);
    await t.merged("wide", "app");
    await t.gates("wide", "app");
    // app's merge passed, but lib isn't prepared: nothing advances yet.
    expect(t.remotes.app!.refs.get("refs/heads/main")).toBe(oid(1));
    expect(await t.landing("wide")).toMatchObject({ state: "merging" });
    const libMerge = await t.merged("wide", "lib");
    // Meanwhile someone pushes to lib's main.
    t.remotes.lib!.refs.set("refs/heads/main", oid(900));
    await t.gates("wide", "lib");
    const partly = await t.landing("wide");
    expect(t.remotes.app!.refs.get("refs/heads/main")).not.toBe(oid(1));
    expect(t.remotes.lib!.refs.get("refs/heads/main")).toBe(oid(900));
    expect(partly.repos).toMatchObject([
      { id: "app", state: "advanced" },
      { id: "lib", state: "merging", attempt: 2, base: oid(900) },
    ]);
    expect(partly.repos[1]!.reason).toBeNull();
    expect(libMerge).not.toBe(oid(900));
    const { timeline, events } = await t.detail("wide");
    expect(timeline.status).toBe("partly_landed");
    expect(events.at(-1)).toMatchObject({ kind: "landing", outcome: "partly_landed" });
    expect(
      await trackerObject(t.env, "orbit").landingForCommit("app", partly.repos[0]!.merge!),
    ).toEqual({ ok: true, value: partly });
    expect(await trackerObject(t.env, "orbit").landingForCommit("lib", libMerge)).toEqual({
      ok: true,
      value: null,
    });
    // lib retries onto its new main, and the timeline lands.
    const retried = await t.merged("wide", "lib");
    await t.gates("wide", "lib");
    expect(t.remotes.lib!.refs.get("refs/heads/main")).toBe(retried);
    expect((await t.detail("wide")).timeline.status).toBe("landed");
    expect(await t.landing("wide")).toMatchObject({
      state: "landed",
      repos: [{ state: "advanced" }, { state: "advanced", attempt: 2 }],
    });
    expect(await trackerObject(t.env, "orbit").landingForCommit("lib", retried)).toEqual({
      ok: true,
      value: await t.landing("wide"),
    });
    expect(await trackerObject(t.env, "orbit").landingForCommit("lib", libMerge)).toEqual({
      ok: true,
      value: null,
    });
  });

  test("an approval of a checkpoint that's no longer the head doesn't land", async () => {
    const t = await setup();
    await t.fork("ui", "approval");
    t.push("app", "ui");
    const cp = await t.checkpoint("ui");
    await t.mutate("bot", [
      {
        kind: "request.open",
        id: "req",
        data: { issueId: "b", kind: "approval", prompt: "Land?", checkpoint: cp.checkpoint.id },
      },
    ]);
    // New commits: the request is withdrawn as superseded, so approving fails.
    t.push("app", "ui");
    await t.checkpoint("ui");
    const answer = await t.mutate("ben", [
      { kind: "request.answer", id: "req", data: { approved: true } },
    ]);
    expect(answer.status).toBe(409);
    expect(await t.landing("ui")).toBeNull();
  });

  test("abandoning a timeline while it lands stops the landing", async () => {
    const t = await setup();
    await t.fork("search", "auto");
    t.push("app", "search");
    await t.checkpoint("search");
    await t.merged("search", "app");
    const abandoned = await t.call("bot", "POST", "/search/abandon");
    expect(abandoned.status).toBe(200);
    await t.gates("search", "app");
    expect(await t.landing("search")).toMatchObject({
      state: "failed",
      reason: "search was abandoned while it was landing.",
    });
    expect(t.remotes.app!.refs.get("refs/heads/main")).toBe(oid(1));
    expect((await t.detail("search")).timeline).toMatchObject({
      status: "abandoned",
      endedAt: expect.any(String),
    });
  });

  test("two looks at the same landing at once start one merge, and neither fails", async () => {
    const t = await setup();
    await t.fork("race", "approval");
    const work = t.push("app", "race");
    await t.checkpoint("race");
    const tracker = (t.env.TRACKER as unknown as { getByName(id: string): Tracker }).getByName(
      "orbit",
    );
    const access = {
      actorId: "ben",
      principalId: "ben",
      agents: [],
      owner: { id: "orbit", slug: "orbit", displayName: "Orbit" },
      canAdmin: false,
      members: [],
      repos: [],
    };
    const cp = (await t.call("ben", "GET", "/race/checkpoints/1")).body;
    await t.mutate("bot", [
      {
        kind: "request.open",
        id: "req-race",
        data: { issueId: "a", kind: "approval", prompt: "Land?", checkpoint: cp.checkpoint.id },
      },
    ]);
    // Approve in the tracker itself, without the route's own look: both looks
    // below are the first to move the queued landing on.
    const answered = tracker.mutate(
      { ...access, writableRepoIds: ["app"] },
      {
        operationId: "approve-race",
        mutations: [{ kind: "request.answer", id: "req-race", data: { approved: true } }],
      },
    );
    expect(answered.ok).toBe(true);
    const begun = tracker.beginLanding(access, "race", {
      trigger: "approval",
      green: { ok: true, why: null },
      agentId: null,
    });
    if (!begun.ok) throw new Error(begun.error);
    // The look that saves the merge run first is slow to write the landing
    // branch: the other finds the run saved but not started, starts it, and
    // the first one's write then finds the branch already moved.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held = 0;
    t.hooks.beforeWrite = async (_repo, ref) => {
      if (ref === "refs/heads/gitmatrix/landing/race" && held++ === 0) await gate;
    };
    const first = progress(t.env, t.deps, "orbit", begun.value.landing);
    const second = progress(t.env, t.deps, "orbit", begun.value.landing);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(held).toBe(2);
    expect(a.id).toBe(b.id);
    const landing = await t.landing("race");
    expect(landing).toMatchObject({ state: "merging", reason: null, repos: [{ attempt: 1 }] });
    const runs = t.sqlite
      .prepare(`SELECT id FROM ci_runs WHERE landing_id = ?`)
      .all(landing.id) as { id: string }[];
    expect(runs.map((r) => r.id)).toEqual([landing.repos[0]!.mergeRun!.id]);
    expect(t.workflows.filter((id) => id === runs[0]!.id)).toHaveLength(1);
    expect(
      t.sqlite.prepare(`SELECT count(*) AS n FROM ci_jobs WHERE run_id = ?`).get(runs[0]!.id),
    ).toEqual({ n: 1 });
    expect(t.remotes.app!.refs.get("refs/heads/gitmatrix/landing/race")).toBe(work);
    // And it goes on to land.
    t.hooks.beforeWrite = undefined;
    await t.merged("race", "app");
    await t.gates("race", "app");
    expect(await t.landing("race")).toMatchObject({ state: "landed" });
  });

  test("asking to land while the auto queue moves it on answers with the landing", async () => {
    const t = await setup();
    await t.fork("both", "auto");
    t.push("app", "both");
    const [made, asked] = await Promise.all([
      t.checkpoint("both"),
      new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
        t.call("bot", "POST", "/both/land"),
      ),
    ]);
    expect(made.checkpoint.number).toBe(1);
    // Before the checkpoint it says why not; after, it's the same landing.
    if (asked.status === 409) expect(asked.body.code).toBe("no_checkpoint");
    else expect([200, 202]).toContain(asked.status);
    const landing = await t.landing("both");
    expect(landing).toMatchObject({ state: "merging", reason: null });
  });

  test("a landing branch someone else already pointed at the checkpoint isn't an error", async () => {
    const t = await setup();
    // Green after the checkpoint: the run's end queues it, through this test's deps,
    // and another worker writes the landing branch just before this one does.
    const queue = async (slug: string, other: (work: string) => string) => {
      await t.fork(slug, "auto");
      const work = t.push("app", slug);
      const run = t.running("app", slug, work);
      await t.checkpoint(slug);
      const branch = `refs/heads/gitmatrix/landing/${slug}`;
      let raced = false;
      t.hooks.beforeWrite = (repo, ref) => {
        if (repo !== "app" || ref !== branch) return;
        t.hooks.beforeWrite = undefined;
        raced = true;
        t.remotes.app!.refs.set(branch, other(work));
      };
      await t.finish(run, "succeeded");
      expect(raced).toBe(true);
      return { work, landing: await t.landing(slug) };
    };
    // It already points at the checkpoint: carry on, and start the merge once.
    const same = await queue("stale", (work) => work);
    expect(same.landing).toMatchObject({ state: "merging", reason: null });
    expect(t.workflows.filter((id) => id === same.landing.repos[0]!.mergeRun!.id)).toHaveLength(1);
    // It points somewhere else: stop, saying why.
    const moved = await queue("moved", () => oid(1));
    expect(moved.landing).toMatchObject({
      state: "failed",
      reason: expect.stringMatching(/Couldn't point gitmatrix\/landing\/moved at the checkpoint/),
    });
  });
});
