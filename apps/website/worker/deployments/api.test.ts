import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type {
  Deployment,
  DeploymentList,
  EnvironmentList,
  PreviewSettings,
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
    const response = await app.request(
      path,
      {
        method,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
    );
    return { status: response.status, json: (await response.json()) as never };
  };
  return { call, tokens, sqlite };
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

  test("a job on another branch must name its environment", async () => {
    const t = await setup();
    const path = "/api/repos/orbit/app/deployments";
    const url = "https://topic.example.com";
    expect((await t.call(t.tokens.topic, "POST", path, { url })).status).toBe(400);
    const named = await t.call(t.tokens.topic, "POST", path, { url, environment: "staging" });
    expect(named.status).toBe(201);
    expect((named.json as Deployment).environment).toBe("staging");
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
    expect(() => placement({ environment: "timeline/x", timeline: "y" }, null)).toThrow();
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
