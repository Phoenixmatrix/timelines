import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { AgentPresence } from "../../shared/agent-presence.ts";
import {
  branchEnvironment,
  type Deployment,
  type DeploymentList,
  type EnvironmentList,
  type PreviewSettings,
} from "../../shared/deployments.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { mintJobToken } from "../ci/registry.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { deployments, placement } from "./api.ts";
import { jobRoute } from "./job.ts";
import { previewSettingsApi } from "./settings.ts";

// loadRepo's module reaches the knowledge coordinator, a Durable Object.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");
const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('acc_ann', 'user', 'ann', 'Ann'), ('acc_bob', 'user', 'bob', 'Bob'),
      ('acc_cat', 'user', 'cat', 'Cat');
    INSERT INTO accounts (id, kind, slug, display_name, member_repo_role)
      VALUES ('acc_org', 'org', 'orbit', 'Orbit', 'read');
    INSERT INTO org_members (org_id, user_id, role) VALUES
      ('acc_org', 'acc_ann', 'owner'), ('acc_org', 'acc_cat', 'member');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_builder', 'builder', 'acc_ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('repo', 'acc_org', 'app', 'private', 'a', 'https://a'),
      ('other', 'acc_org', 'site', 'private', 'b', 'https://b');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, actor_id, agent_id, status)
      VALUES
      ('run1', 'repo', 7, '${oid(7)}', 'main', 'push', 'acc_ann', 'agt_builder', 'running'),
      ('run2', 'repo', 8, '${oid(8)}', 'timeline/fast-search', 'push', 'acc_ann', NULL, 'running'),
      ('run3', 'repo', 9, '${oid(9)}', 'topic', 'push', 'acc_ann', NULL, 'running');
    INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES
      ('job1', 'run1', 'repo', 'deploy', '{}', 'running', 'sandbox'),
      ('job2', 'run2', 'repo', 'preview', '{}', 'running', 'sandbox'),
      ('job3', 'run3', 'repo', 'preview', '{}', 'running', 'sandbox'),
      ('job4', 'run1', 'repo', 'done', '{}', 'succeeded', 'sandbox');
  `);
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  // As worker/app.ts: a job credential passes only to its deployment routes.
  app.use("*", async (c, next) => {
    if (jobRoute(c)) {
      c.set("actor", null);
      return next();
    }
    const credential = await tokenCredential(c);
    if (c.req.header("authorization") && credential.kind !== "token")
      return c.json({ error: "Invalid access token." }, 401);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/accounts/:slug/settings/previews", previewSettingsApi);
  app.route("/api/repos/:owner/:name", deployments);
  const token = async (user: string, scope: "read" | "write" = "write", agent?: string) =>
    (await issueToken(env.DB, user, `t-${Math.random()}`, scope, undefined, agent)).secret;
  const tokens = {
    ann: await token("acc_ann"),
    agent: await token("acc_ann", "write", "agt_builder"),
    bob: await token("acc_bob"),
    cat: await token("acc_cat"),
    deploy: await mintJobToken(env.DB, "job1", 30),
    preview: await mintJobToken(env.DB, "job2", 30),
    topic: await mintJobToken(env.DB, "job3", 30),
    ended: await mintJobToken(env.DB, "job4", 30),
  };
  const call = async (token: string, method: string, path: string, body?: unknown) => {
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      path,
      {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
      {
        waitUntil: (work: Promise<unknown>) => {
          pending.push(work);
        },
        passThroughOnException() {},
        props: {},
      } as ExecutionContext,
    );
    await Promise.all(pending);
    return { status: response.status, json: (await response.json()) as never };
  };
  return { call, tokens, sqlite, env };
}

describe("recording deployments", () => {
  test("a CI job records its run's commit, inferring production from the default branch", async () => {
    const t = await setup();
    const { status, json } = await t.call(
      t.tokens.deploy,
      "POST",
      "/api/repos/orbit/app/deployments",
      {
        url: "https://app.example.com",
      },
    );
    expect(status).toBe(201);
    expect(json as Deployment).toMatchObject({
      environment: "production",
      timeline: null,
      commit: oid(7),
      url: "https://app.example.com",
      status: "active",
      run: 7,
      job: "deploy",
      actor: "ann",
      agent: "builder",
      expiresAt: null,
    });
  });

  test("a job on a timeline bookmark records a preview that expires after the idle period", async () => {
    const t = await setup();
    const { status, json } = await t.call(
      t.tokens.preview,
      "POST",
      "/api/repos/orbit/app/deployments",
      {
        url: "https://fast-search.preview.example.com",
        checkpoint: "cp_3",
      },
    );
    expect(status).toBe(201);
    const deployment = json as Deployment;
    expect(deployment).toMatchObject({
      environment: "timeline/fast-search",
      timeline: "fast-search",
      // No tracker in this test: the slug is kept, the id unknown.
      timelineId: null,
      checkpoint: "cp_3",
      commit: oid(8),
      run: 8,
      agent: null,
    });
    const days = (Date.parse(deployment.expiresAt!) - Date.now()) / DAY;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThanOrEqual(7);
  });

  test("a revival's preview run records a rebuilt preview of its checkpoint (CORE-79)", async () => {
    const t = await setup();
    t.sqlite.exec(`
      INSERT INTO deployments (id, repo_id, environment, timeline_slug, checkpoint_id, commit_oid, url, status)
        VALUES (40, 'repo', 'timeline/fast-search', 'fast-search', 'cp_2', '${oid(11)}', 'https://old.example', 'expired');
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, actor_id, status,
                           preview_action, timeline_slug, checkpoint_id, preview_revived, preview_rebuilt_from)
        VALUES ('run5', 'repo', 11, '${oid(11)}', 'timeline/fast-search', 'manual', 'acc_ann', 'running',
                'create', 'fast-search', 'cp_2', 1, 40),
               ('run6', 'repo', 12, '${oid(12)}', 'timeline/fast-search', 'manual', 'acc_ann', 'running',
                'create', 'fast-search', 'cp_3', 0, NULL);
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES
        ('job6', 'run5', 'repo', 'preview', '{}', 'running', 'sandbox'),
        ('job7', 'run6', 'repo', 'preview', '{}', 'running', 'sandbox');
    `);
    const path = "/api/repos/orbit/app/deployments";
    const url = "https://fast-search.preview.example.com";
    const rebuilt = await t.call(await mintJobToken(t.env.DB, "job6", 30), "POST", path, { url });
    expect(rebuilt.status).toBe(201);
    expect(rebuilt.json as Deployment).toMatchObject({
      environment: "timeline/fast-search",
      checkpoint: "cp_2",
      commit: oid(11),
      revived: true,
      rebuiltFrom: 40,
      expiryPinned: false,
    });
    // A first build is the original; an explicit expiry is pinned.
    const original = await t.call(await mintJobToken(t.env.DB, "job7", 30), "POST", path, {
      url,
      expiresAt: "2030-01-01T00:00:00Z",
    });
    expect(original.json as Deployment).toMatchObject({
      checkpoint: "cp_3",
      revived: false,
      rebuiltFrom: null,
      expiryPinned: true,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    // So is one changed by hand; the earlier record is still there.
    const id = (rebuilt.json as Deployment).id;
    const patched = await t.call(t.tokens.ann, "PATCH", `${path}/${id}`, { expiresAt: null });
    expect(patched.json as Deployment).toMatchObject({ expiresAt: null, expiryPinned: true });
    const old = await t.call(t.tokens.ann, "GET", `${path}/40`);
    expect(old.json as Deployment).toMatchObject({ status: "expired", revived: false });
  });

  test("a job on another branch records into branch/<name> unless it names one", async () => {
    const t = await setup();
    const path = "/api/repos/orbit/app/deployments";
    const url = "https://topic.example.com";
    const inferred = await t.call(t.tokens.topic, "POST", path, { url });
    expect(inferred.status).toBe(201);
    expect(inferred.json as Deployment).toMatchObject({
      environment: "branch/topic",
      timeline: null,
      commit: oid(9),
      run: 9,
      expiresAt: null,
    });
    const named = await t.call(t.tokens.topic, "POST", path, { url, environment: "staging" });
    expect(named.status).toBe(201);
    expect((named.json as Deployment).environment).toBe("staging");
    const environments = (await t.call(t.tokens.ann, "GET", "/api/repos/orbit/app/environments"))
      .json as EnvironmentList;
    expect(environments.environments.map((e) => [e.name, e.timeline])).toEqual([
      ["production", null],
      ["staging", null],
      ["branch/topic", null],
    ]);
  });

  test("a job on a nested branch records into its normalised branch/<name>", async () => {
    const t = await setup();
    t.sqlite.exec(`
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, actor_id, status)
        VALUES ('run4', 'repo', 10, '${oid(10)}', 'Feature/Login_v2.1+fix', 'push', 'acc_ann', 'running');
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner)
        VALUES ('job5', 'run4', 'repo', 'preview', '{}', 'running', 'sandbox');
    `);
    const { status, json } = await t.call(
      await mintJobToken(t.env.DB, "job5", 30),
      "POST",
      "/api/repos/orbit/app/deployments",
      { url: "https://login.example.com" },
    );
    expect(status).toBe(201);
    expect(json as Deployment).toMatchObject({
      environment: "branch/feature/login_v2.1-fix",
      timeline: null,
    });
    // The normalised name reads back as an environment of its own.
    const list = (
      await t.call(
        t.tokens.ann,
        "GET",
        "/api/repos/orbit/app/deployments?environment=branch/feature/login_v2.1-fix",
      )
    ).json as DeploymentList;
    expect(list.deployments.map((d) => d.run)).toEqual([10]);
  });

  test("a job only writes its own repository, and only while it runs", async () => {
    const t = await setup();
    const body = { url: "https://x.example.com" };
    expect(
      (await t.call(t.tokens.deploy, "POST", "/api/repos/orbit/site/deployments", body)).status,
    ).toBe(403);
    expect(
      (await t.call(t.tokens.ended, "POST", "/api/repos/orbit/app/deployments", body)).status,
    ).toBe(401);
  });

  test("people and outside systems record with a token and an explicit commit", async () => {
    const t = await setup();
    const path = "/api/repos/orbit/app/deployments";
    const missing = await t.call(t.tokens.ann, "POST", path, { url: "https://a.example.com" });
    expect(missing.status).toBe(400);
    const { status, json } = await t.call(t.tokens.agent, "POST", path, {
      url: "https://a.example.com",
      commit: oid(1).toUpperCase(),
      timeline: "fast-search",
      expiresAt: "2026-12-01T00:00:00Z",
    });
    expect(status).toBe(201);
    expect(json as Deployment).toMatchObject({
      environment: "timeline/fast-search",
      commit: oid(1),
      run: null,
      job: null,
      actor: "ann",
      agent: "builder",
      expiresAt: "2026-12-01T00:00:00.000Z",
    });
    // Readers can't record; strangers don't see the repository.
    expect(
      (await t.call(t.tokens.cat, "POST", path, { url: "https://a.example.com", commit: oid(1) }))
        .status,
    ).toBe(403);
    expect((await t.call(t.tokens.bob, "GET", path)).status).toBe(404);
  });

  test("rejects what isn't a deployment", async () => {
    const t = await setup();
    const path = "/api/repos/orbit/app/deployments";
    const post = (body: unknown) => t.call(t.tokens.deploy, "POST", path, body);
    expect((await post({ url: "ftp://x" })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ url: "https://x.example.com", status: "gone" })).status).toBe(400);
    expect((await post({ url: "https://x.example.com", environment: "Prod" })).status).toBe(400);
    expect((await post({ url: "https://x.example.com", environment: "timeline/x/y" })).status).toBe(
      400,
    );
    // branch/<name> takes slashes, but only in its normal form.
    for (const environment of ["branch/Topic", "branch/a//b", "branch/a b", "branch/-a", "branch/"])
      expect((await post({ url: "https://x.example.com", environment })).status).toBe(400);
    const nested = await post({ url: "https://x.example.com", environment: "branch/a/b.c/d_e-f" });
    expect(nested.status).toBe(201);
    expect((nested.json as Deployment).environment).toBe("branch/a/b.c/d_e-f");
    expect(
      (await post({ url: "https://x.example.com", environment: "production", timeline: "a" }))
        .status,
    ).toBe(400);
    expect((await post({ url: "https://x.example.com", commit: "abc" })).status).toBe(400);
    expect((await post({ url: "https://x.example.com", extra: 1 })).status).toBe(400);
    // A failed deployment may have no address.
    expect((await post({ status: "failed" })).status).toBe(201);
  });
});

describe("reading and updating", () => {
  test("filters, pages, and keeps records after a preview expires", async () => {
    const t = await setup();
    const path = "/api/repos/orbit/app/deployments";
    const made: Deployment[] = [];
    for (const [token, url] of [
      [t.tokens.deploy, "https://app.example.com"],
      [t.tokens.preview, "https://p1.example.com"],
      [t.tokens.preview, "https://p2.example.com"],
    ] as const)
      made.push((await t.call(token, "POST", path, { url })).json);

    const byTimeline = (await t.call(t.tokens.cat, "GET", `${path}?timeline=fast-search`))
      .json as DeploymentList;
    expect(byTimeline.deployments.map((d) => d.url)).toEqual([
      "https://p2.example.com",
      "https://p1.example.com",
    ]);
    const byRun = (await t.call(t.tokens.cat, "GET", `${path}?run=7`)).json as DeploymentList;
    expect(byRun.deployments.map((d) => d.environment)).toEqual(["production"]);
    const byCommit = (await t.call(t.tokens.cat, "GET", `${path}?commit=${oid(7)},${oid(8)}`))
      .json as DeploymentList;
    expect(byCommit.deployments).toHaveLength(3);
    const first = (await t.call(t.tokens.cat, "GET", `${path}?limit=2`)).json as DeploymentList;
    expect(first.deployments).toHaveLength(2);
    const rest = (await t.call(t.tokens.cat, "GET", `${path}?limit=2&before=${first.next}`))
      .json as DeploymentList;
    expect(rest).toMatchObject({ next: null, deployments: [{ id: made[0]!.id }] });

    // The teardown job marks the preview expired; the record stays.
    const expired = await t.call(t.tokens.preview, "PATCH", `${path}/${made[1]!.id}`, {
      status: "expired",
    });
    expect(expired.status).toBe(200);
    expect((expired.json as Deployment).status).toBe("expired");
    const shown = (await t.call(t.tokens.cat, "GET", `${path}/${made[1]!.id}`)).json as Deployment;
    expect(shown).toMatchObject({ status: "expired", url: "https://p1.example.com" });
    const live = (await t.call(t.tokens.cat, "GET", `${path}?status=active`))
      .json as DeploymentList;
    expect(live.deployments).toHaveLength(2);

    // Readers can't update; nothing to change is an error.
    expect(
      (await t.call(t.tokens.cat, "PATCH", `${path}/${made[1]!.id}`, { status: "active" })).status,
    ).toBe(403);
    expect((await t.call(t.tokens.ann, "PATCH", `${path}/${made[1]!.id}`, {})).status).toBe(400);
    expect(
      (await t.call(t.tokens.ann, "PATCH", `${path}/${made[1]!.id}`, { url: null })).status,
    ).toBe(400);
    expect((await t.call(t.tokens.ann, "PATCH", `${path}/999`, { status: "failed" })).status).toBe(
      404,
    );

    const environments = (await t.call(t.tokens.cat, "GET", "/api/repos/orbit/app/environments"))
      .json as EnvironmentList;
    expect(
      environments.environments.map((e) => [e.name, e.timeline, e.latest?.url, e.live, e.total]),
    ).toEqual([
      ["timeline/fast-search", "fast-search", "https://p2.example.com", 1, 2],
      ["production", null, "https://app.example.com", 1, 1],
    ]);
  });

  test("an empty repository still has production", async () => {
    const t = await setup();
    const { json } = await t.call(t.tokens.cat, "GET", "/api/repos/orbit/site/environments");
    expect((json as EnvironmentList).environments).toEqual([
      { name: "production", timeline: null, latest: null, live: 0, total: 0 },
    ]);
  });
});

describe("live timelines", () => {
  test("a job sees every source's live timeline slugs, and nothing else", async () => {
    const t = await setup();
    t.sqlite.exec(`
      INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
      VALUES('work_a','repo','tl_a','search','acc_org','work-a','https://work-a','ready','allocate','canonical','c','t','refs/heads/main','canonical','c','t','refs/heads/main','2026-01-01','2026-01-01');
      INSERT INTO deployments(repo_id,source_id,environment,timeline_slug,commit_oid,url,status) VALUES
        ('repo','work_a','timeline/search','search','${oid(1)}','https://secret-a.example','active'),
        ('repo','work_a','timeline/search','search','${oid(2)}','https://secret-b.example','sleeping'),
        ('repo','canonical','timeline/zebra','zebra','${oid(3)}','https://z.example','sleeping'),
        ('repo','canonical','timeline/gone','gone','${oid(4)}','https://g.example','expired'),
        ('repo','canonical','timeline/broken','broken','${oid(5)}',NULL,'failed'),
        ('repo','canonical','production',NULL,'${oid(6)}','https://app.example','active'),
        ('other','canonical','timeline/elsewhere','elsewhere','${oid(7)}','https://e.example','active');
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, actor_id, status)
        VALUES ('run9', 'other', 1, '${oid(9)}', 'main', 'push', 'acc_ann', 'running');
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner)
        VALUES ('job9', 'run9', 'other', 'reconcile', '{}', 'running', 'sandbox');
    `);
    const path = "/api/repos/orbit/app/deployments/live-timelines";
    // The canonical source's job reads the work source's live timeline too.
    const job = await t.call(t.tokens.preview, "GET", path);
    expect(job.status).toBe(200);
    expect(job.json).toEqual({ timelines: ["search", "zebra"] });
    // Slugs only: no URL, commit, source or record crosses sources.
    expect(JSON.stringify(job.json)).not.toMatch(/secret|example|work_a|0000/);
    // Readers may ask too.
    expect((await t.call(t.tokens.cat, "GET", path)).json).toEqual({
      timelines: ["search", "zebra"],
    });
    // Another repository's job may not; nor may a job that has ended.
    const other = await mintJobToken(t.env.DB, "job9", 30);
    expect((await t.call(other, "GET", path)).status).toBe(403);
    expect((await t.call(t.tokens.ended, "GET", path)).status).toBe(401);
    expect(
      (await t.call(other, "GET", "/api/repos/orbit/site/deployments/live-timelines")).json,
    ).toEqual({ timelines: ["elsewhere"] });

    // A work source's own job (the timeline's preview runs, since CORE-255)
    // sees every source's too.
    t.sqlite.exec(`
      UPDATE timeline_work_sources SET initial_token_revoked=1 WHERE source_id='work_a';
      INSERT INTO ci_runs (id, repo_id, source_id, number, commit_oid, ref, trigger, actor_id, status)
        VALUES ('run10', 'repo', 'work_a', 10, '${oid(10)}', 'work', 'push', 'acc_ann', 'running');
      INSERT INTO ci_jobs (id, run_id, repo_id, source_id, name, spec, status, runner)
        VALUES ('job10', 'run10', 'repo', 'work_a', 'preview-reconcile', '{}', 'running', 'sandbox');
    `);
    const work = await mintJobToken(t.env.DB, "job10", 30);
    const fromWork = await t.call(work, "GET", path);
    expect(fromWork.status).toBe(200);
    expect(fromWork.json).toEqual({ timelines: ["search", "zebra"] });
  });
});

describe("placement", () => {
  test("infers the environment from the timeline, the environment, or the job's branch", () => {
    const job = { ref: "main", defaultBranch: "main" };
    expect(placement({}, null)).toEqual({ environment: "production", timeline: null });
    expect(placement({ timeline: "x" }, null)).toEqual({
      environment: "timeline/x",
      timeline: "x",
    });
    expect(placement({ environment: "timeline/x" }, job)).toEqual({
      environment: "timeline/x",
      timeline: "x",
    });
    expect(placement({ environment: "staging" }, job)).toEqual({
      environment: "staging",
      timeline: null,
    });
    expect(placement({}, { ref: "timeline/y", defaultBranch: "main" })).toEqual({
      environment: "timeline/y",
      timeline: "y",
    });
    expect(placement({}, { ref: "topic", defaultBranch: "main" })).toEqual({
      environment: "branch/topic",
      timeline: null,
    });
    expect(placement({ environment: "staging" }, { ref: "topic", defaultBranch: "main" })).toEqual({
      environment: "staging",
      timeline: null,
    });
    expect(() => placement({ environment: "timeline/x", timeline: "y" }, null)).toThrow();
    // A branch whose name leaves nothing usable must name its environment.
    expect(() => placement({}, { ref: "+++", defaultBranch: "main" })).toThrow(
      /name the environment/,
    );
  });
});

describe("branchEnvironment", () => {
  test("lowercases a branch and keeps its parts, with unsafe characters as '-'", () => {
    expect(branchEnvironment("topic")).toBe("branch/topic");
    expect(branchEnvironment("feature/add-login")).toBe("branch/feature/add-login");
    expect(branchEnvironment("release/1.2.x")).toBe("branch/release/1.2.x");
    expect(branchEnvironment("Fix/Some Bug#12")).toBe("branch/fix/some-bug-12");
    expect(branchEnvironment("deps/@types/node")).toBe("branch/deps/types/node");
    expect(branchEnvironment("users/ann/.wip-")).toBe("branch/users/ann/wip");
    expect(branchEnvironment("timeline/Not_A_Slug")).toBe("branch/timeline/not_a_slug");
    expect(branchEnvironment("+/@")).toBeNull();
    expect(branchEnvironment("x".repeat(300))).toBeNull();
  });
});

describe("preview settings", () => {
  test("default to 2 and 7 days; owners change them, members read them", async () => {
    const t = await setup();
    const path = "/api/accounts/orbit/settings/previews";
    expect((await t.call(t.tokens.cat, "GET", path)).json).toEqual({
      endedDays: 2,
      idleDays: 7,
      updatedAt: null,
      updatedBy: null,
    });
    expect((await t.call(t.tokens.bob, "GET", path)).status).toBe(404);
    expect((await t.call(t.tokens.cat, "PATCH", path, { idleDays: 3 })).status).toBe(403);
    expect((await t.call(t.tokens.agent, "PATCH", path, { idleDays: 3 })).status).toBe(403);
    expect((await t.call(t.tokens.ann, "PATCH", path, { idleDays: 0 })).status).toBe(400);
    expect((await t.call(t.tokens.ann, "PATCH", path, { endedDays: 1.5 })).status).toBe(400);
    const changed = await t.call(t.tokens.ann, "PATCH", path, { idleDays: 3 });
    expect(changed.json as PreviewSettings).toMatchObject({
      endedDays: 2,
      idleDays: 3,
      updatedBy: "ann",
    });
    const again = await t.call(t.tokens.ann, "PATCH", path, { endedDays: 0 });
    expect(again.json as PreviewSettings).toMatchObject({ endedDays: 0, idleDays: 3 });

    // New timeline previews in the org expire after its idle period.
    const { json } = await t.call(t.tokens.preview, "POST", "/api/repos/orbit/app/deployments", {
      url: "https://p.example.com",
    });
    const days = (Date.parse((json as Deployment).expiresAt!) - Date.now()) / DAY;
    expect(days).toBeGreaterThan(2.9);
    expect(days).toBeLessThanOrEqual(3);
  });

  test("a user's own account is theirs to change", async () => {
    const t = await setup();
    const path = "/api/accounts/bob/settings/previews";
    expect((await t.call(t.tokens.bob, "PATCH", path, { endedDays: 5 })).status).toBe(200);
    expect((await t.call(t.tokens.ann, "GET", path)).status).toBe(404);
  });
});

describe("deployment recent presence", () => {
  test("job attribution is not presence; successful agent reads and changes coalesce without reader heartbeats", async () => {
    const t = await setup();
    try {
      const created = await t.call(t.tokens.deploy, "POST", "/api/repos/orbit/app/deployments", {
        url: "https://app.example.com",
      });
      expect(created.status).toBe(201);
      const resource = `/api/repos/orbit/app/deployments/${(created.json as Deployment).id}`;
      const agents = async () =>
        ((await t.call(t.tokens.ann, "GET", `${resource}/presence`)).json as AgentPresence).agents;
      expect(await agents()).toEqual([]);
      await t.call(t.tokens.agent, "GET", `${resource}/presence`);
      await t.call(t.tokens.agent, "GET", "/api/repos/orbit/app/deployments");
      expect(await agents()).toEqual([]);
      expect((await t.call(t.tokens.agent, "GET", `${resource}?source=other`)).status).toBe(404);
      expect((await t.call(t.tokens.agent, "PATCH", resource, { url: "not a url" })).status).toBe(
        400,
      );
      expect(await agents()).toEqual([]);
      expect((await t.call(t.tokens.agent, "GET", resource)).status).toBe(200);
      expect(await agents()).toMatchObject([{ id: "agt_builder", name: "builder" }]);
      expect((await t.call(t.tokens.agent, "PATCH", resource, { status: "sleeping" })).status).toBe(
        200,
      );
      const before = await agents();
      expect(before).toHaveLength(1);
      await t.call(t.tokens.agent, "GET", `${resource}/presence`);
      expect(await agents()).toEqual(before);
      expect((await t.call(t.tokens.ann, "GET", `${resource}/presence?source=other`)).status).toBe(
        404,
      );
      expect((await t.call(t.tokens.bob, "GET", `${resource}/presence`)).status).toBe(404);
      expect(
        (await t.call(t.tokens.ann, "GET", resource.replace("/app/", "/site/") + "/presence"))
          .status,
      ).toBe(404);
      const second = await t.call(t.tokens.agent, "POST", "/api/repos/orbit/app/deployments", {
        commit: oid(7),
        url: "https://second.example.com",
      });
      expect(second.status).toBe(201);
      const secondPresence = await t.call(
        t.tokens.ann,
        "GET",
        `/api/repos/orbit/app/deployments/${(second.json as Deployment).id}/presence`,
      );
      expect((secondPresence.json as AgentPresence).agents).toMatchObject([{ id: "agt_builder" }]);
    } finally {
      t.sqlite.close();
    }
  });
});
