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
import { d1, migratedDatabase, migratedRegistryDatabase } from "../testing/d1.ts";
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
  const registry = migratedRegistryDatabase();
  const env = { DB: d1(sqlite), REGISTRY_DB: d1(registry) } as unknown as Env;
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
  return { call, tokens, sqlite, registry, env };
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
  test.each(["deployments", "environments"])(
    "%s lists enforce the job's source without restricting repository readers",
    async (route) => {
      const t = await setup();
      try {
        const callers = [{ source: "canonical", token: t.tokens.deploy }];
        for (const [index, source] of ["work-a", "work-b"].entries()) {
          t.sqlite
            .prepare(
              `INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,owner_id,
                artifacts_name,artifacts_remote,state,initial_token_revoked,allocation_operation_id,
                fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
                VALUES(?,'repo',?,?,'acc_org',?,'https://owned','ready',1,?,
                  'canonical','head','tree','refs/heads/main','canonical','head','tree','refs/heads/main','now','now')`,
            )
            .run(source, source, source, source, source);
          t.sqlite
            .prepare(
              `INSERT INTO ci_runs(id,repo_id,source_id,number,commit_oid,ref,trigger,status)
                VALUES(?,'repo',?,?,?,'work','manual','running')`,
            )
            .run(source, source, 20 + index, oid(20 + index));
          t.sqlite
            .prepare(
              `INSERT INTO ci_jobs(id,run_id,repo_id,source_id,name,spec,status,runner)
                VALUES(?,?,'repo',?,'deploy','{}','running','sandbox')`,
            )
            .run(source, source, source);
          callers.push({ source, token: await mintJobToken(t.env.DB, source, 30) });
        }
        const made = new Map<string, Deployment>();
        for (const { source, token } of callers) {
          const created = await t.call(token, "POST", "/api/repos/orbit/app/deployments", {
            url: `https://${source}.example.com`,
          });
          expect(created.status).toBe(201);
          made.set(source, created.json as Deployment);
        }
        const records = (json: DeploymentList | EnvironmentList) =>
          "deployments" in json
            ? json.deployments
            : json.environments.flatMap((environment) =>
                environment.latest ? [environment.latest] : [],
              );
        const path = `/api/repos/orbit/app/${route}`;
        for (const caller of callers) {
          for (const { source } of callers) {
            const response = await t.call(caller.token, "GET", `${path}?source=${source}`);
            if (source === caller.source) {
              expect(response.status).toBe(200);
              expect(records(response.json)).toEqual([made.get(source)]);
            } else {
              expect(response.status).toBe(403);
              expect(response.json).toEqual({ error: expect.any(String) });
            }
          }
          // Omitting the selector still means canonical, not the caller's work source.
          const implicit = await t.call(caller.token, "GET", path);
          expect(implicit.status).toBe(caller.source === "canonical" ? 200 : 403);
          if (implicit.status === 200)
            expect(records(implicit.json)).toEqual([made.get("canonical")]);
        }
        for (const token of [t.tokens.cat, t.tokens.agent]) {
          for (const { source } of callers) {
            const response = await t.call(token, "GET", `${path}?source=${source}`);
            expect(response.status).toBe(200);
            expect(records(response.json)).toEqual([made.get(source)]);
          }
        }
        expect((await t.call(t.tokens.ended, "GET", path)).status).toBe(401);
        expect((await t.call(t.tokens.deploy, "GET", path.replace("/app/", "/site/"))).status).toBe(
          403,
        );
      } finally {
        t.sqlite.close();
      }
    },
  );

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
      { name: "production", timeline: null, latest: null, split: [], live: 0, total: 0 },
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

describe("deployment provenance (CORE-351)", () => {
  const path = "/api/repos/orbit/app/deployments";
  const DIGEST = `sha256:${"ab".repeat(32)}`;
  const OTHER = `sha256:${"cd".repeat(32)}`;
  const provider = (versionId: string, deploymentId = "dep-1") => ({
    name: "cloudflare",
    service: "app",
    versionId,
    deploymentId,
  });

  /** Registry publishes: this repo's CI at each source and commit, a sibling, and strays. */
  function publishes(t: Awaited<ReturnType<typeof setup>>) {
    t.registry.exec(`
      INSERT INTO repositories (id, owner_id, key, format, kind, visibility, config, created_at, updated_at) VALUES
        ('feed', 'acc_org', 'orbit', 'npm', 'local', 'private', '{}', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
      INSERT INTO packages (id, repo_id, name, normalized_name, created_at, updated_at) VALUES
        ('pkg', 'feed', '@orbit/app', '@orbit/app', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'),
        ('sib', 'feed', '@orbit/sibling', '@orbit/sibling', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
      INSERT INTO publishes (id, feed_id, format, package_id, version, digest, action, status, git_repo_id, source_id, commit_oid, actor, actor_label, via, at) VALUES
        ('pub-app', 'feed', 'npm', 'pkg', '1.0.0', '${DIGEST}', 'publish', 'active', 'repo', 'canonical', '${oid(7)}', 'job:job1', 'ci', 'job', '2026-10-01T01:00:00Z'),
        ('pub-sib', 'feed', 'npm', 'sib', '1.0.0', '${OTHER}', 'publish', 'active', 'repo', 'canonical', '${oid(7)}', 'job:job1', 'ci', 'job', '2026-10-01T01:00:00Z'),
        ('pub-legacy', 'feed', 'npm', 'pkg', '0.9.0', '${DIGEST}', 'publish', 'active', 'repo', NULL, '${oid(7)}', 'job:job1', 'ci', 'job', '2026-09-01T01:00:00Z'),
        ('pub-work', 'feed', 'npm', 'pkg', '1.1.0', '${DIGEST}', 'publish', 'active', 'repo', 'work_a', '${oid(7)}', 'job:x', 'ci', 'job', '2026-10-01T02:00:00Z'),
        ('pub-other-repo', 'feed', 'npm', 'pkg', '1.2.0', '${DIGEST}', 'publish', 'active', 'other', 'canonical', '${oid(7)}', 'job:y', 'ci', 'job', '2026-10-01T03:00:00Z'),
        ('pub-other-commit', 'feed', 'npm', 'pkg', '1.3.0', '${DIGEST}', 'publish', 'active', 'repo', 'canonical', '${oid(8)}', 'job:z', 'ci', 'job', '2026-10-01T04:00:00Z'),
        ('pub-deleted', 'feed', 'npm', 'pkg', '1.4.0', '${DIGEST}', 'publish', 'deleted', 'repo', 'canonical', '${oid(7)}', 'job:job1', 'ci', 'job', '2026-10-01T05:00:00Z');
    `);
  }

  test("a job records the provider version and publication it deployed, and reads round-trip them", async () => {
    const t = await setup();
    publishes(t);
    const made = await t.call(t.tokens.deploy, "POST", path, {
      url: "https://app.example.com",
      provider: provider("ver-2"),
      artifact: { publishId: "pub-app", digest: DIGEST },
      deployedAt: "2026-10-12T20:00:00Z",
      exposedFrom: "2026-10-12T20:00:05Z",
      percentage: 10,
      replaces: "ver-1",
    });
    expect(made.status).toBe(201);
    const recorded = made.json as Deployment;
    expect(recorded).toMatchObject({
      repoId: "repo",
      sourceId: "canonical",
      commit: oid(7),
      run: 7,
      provider: { name: "cloudflare", service: "app", versionId: "ver-2", deploymentId: "dep-1" },
      artifact: {
        publishId: "pub-app",
        packageId: "pkg",
        format: "npm",
        name: "@orbit/app",
        version: "1.0.0",
        digest: DIGEST,
      },
      deployedAt: "2026-10-12T20:00:00.000Z",
      exposedFrom: "2026-10-12T20:00:05.000Z",
      exposedUntil: null,
      percentage: 10,
      replaces: { versionId: "ver-1", deploymentId: null },
    });
    expect((await t.call(t.tokens.ann, "GET", `${path}/${recorded.id}`)).json).toEqual(recorded);
    const byVersion = await t.call(t.tokens.ann, "GET", `${path}?version=ver-2`);
    expect((byVersion.json as DeploymentList).deployments).toEqual([recorded]);
    expect(
      ((await t.call(t.tokens.ann, "GET", `${path}?version=ver-9`)).json as DeploymentList)
        .deployments,
    ).toEqual([]);
    // By package and version, without a digest, records the publication's own.
    const byName = await t.call(t.tokens.ann, "POST", path, {
      url: "https://b.example.com",
      commit: oid(7),
      artifact: { packageId: "pkg", version: "1.0.0" },
    });
    expect(byName.status).toBe(201);
    expect((byName.json as Deployment).artifact).toMatchObject({
      publishId: "pub-app",
      digest: DIGEST,
    });
    expect((byName.json as Deployment).provider).toBeNull();
  });

  test("old records and clients stay uninstrumented: nothing is filled in", async () => {
    const t = await setup();
    t.sqlite.exec(
      `INSERT INTO deployments(repo_id,environment,commit_oid,url,status,created_at) VALUES ('repo','production','${oid(3)}','https://old.example','active','2026-01-01T00:00:00.000Z')`,
    );
    const list = (await t.call(t.tokens.ann, "GET", path)).json as DeploymentList;
    expect(list.deployments[0]).toMatchObject({
      repoId: "repo",
      sourceId: "canonical",
      provider: null,
      artifact: null,
      deployedAt: null,
      exposedFrom: null,
      exposedUntil: null,
      percentage: null,
      replaces: null,
    });
    const plain = await t.call(t.tokens.deploy, "POST", path, { url: "https://app.example.com" });
    expect(plain.status).toBe(201);
    expect((plain.json as Deployment).provider).toBeNull();
  });

  test.each([
    ["another source's publication", { publishId: "pub-work" }],
    ["another repository's publication", { publishId: "pub-other-repo" }],
    ["another commit's publication", { publishId: "pub-other-commit" }],
    ["a publication recorded before publishes had a source", { publishId: "pub-legacy" }],
    ["a deleted publication", { publishId: "pub-deleted" }],
    ["an unknown publication", { publishId: "nope" }],
    ["a digest that differs", { publishId: "pub-app", digest: OTHER }],
    ["a sibling's digest for this package", { packageId: "pkg", version: "1.0.0", digest: OTHER }],
    ["another source's package version", { packageId: "pkg", version: "1.1.0" }],
  ])("refuses %s, the same as an unknown one", async (_, artifact) => {
    const t = await setup();
    publishes(t);
    const refused = await t.call(t.tokens.deploy, "POST", path, {
      url: "https://app.example.com",
      artifact,
    });
    expect(refused.status).toBe(400);
    expect((refused.json as { error: string }).error).toBe(
      "No publication from this repository's CI, at this source and commit, matches artifact.",
    );
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM deployments").get()).toEqual({ n: 0 });
  });

  test("a sibling built from the same commit is never the deployed artifact", async () => {
    const t = await setup();
    publishes(t);
    const made = await t.call(t.tokens.deploy, "POST", path, {
      url: "https://app.example.com",
      artifact: { publishId: "pub-app" },
    });
    expect((made.json as Deployment).artifact?.name).toBe("@orbit/app");
    const list = (await t.call(t.tokens.ann, "GET", path)).json as DeploymentList;
    expect(list.deployments.map((d) => d.artifact?.publishId)).toEqual(["pub-app"]);
  });

  test("a job attaches an artifact only for its own commit, and a provider version for another only when known", async () => {
    const t = await setup();
    publishes(t);
    const job = (body: Record<string, unknown>) =>
      t.call(t.tokens.deploy, "POST", path, { url: "https://app.example.com", ...body });
    // An earlier commit nothing maps a version to: refused.
    expect((await job({ commit: oid(6), provider: provider("ver-1", "dep-b") })).status).toBe(403);
    // An artifact is always the job's own commit's, known or not.
    expect(
      (await job({ commit: oid(8), artifact: { publishId: "pub-other-commit" } })).status,
    ).toBe(403);
    // Without identity a job may still name another commit, as before.
    expect((await job({ commit: oid(8) })).status).toBe(201);
    // A person with write access names any commit of the repository: ver-1 is oid(6)'s.
    const first = await t.call(t.tokens.ann, "POST", path, {
      url: "https://app.example.com",
      commit: oid(6),
      provider: provider("ver-1", "dep-a"),
    });
    expect(first.status).toBe(201);
    // A canary: the job's new version beside the known older member it keeps serving.
    expect(
      (await job({ provider: provider("ver-2", "dep-b"), percentage: 10, replaces: "ver-1" }))
        .status,
    ).toBe(201);
    const older = await job({
      commit: oid(6),
      provider: provider("ver-1", "dep-b"),
      percentage: 90,
    });
    expect(older.status).toBe(201);
    expect((older.json as Deployment).commit).toBe(oid(6));
    // A known version names only the commit it was recorded for.
    expect((await job({ commit: oid(8), provider: provider("ver-1", "dep-c") })).status).toBe(403);
    // Nor in another environment, where nothing maps it yet.
    expect(
      (await job({ commit: oid(6), environment: "staging", provider: provider("ver-1", "dep-s") }))
        .status,
    ).toBe(403);
    // A rollback to the known version: allowed.
    const rollback = await job({
      commit: oid(6),
      provider: provider("ver-1", "dep-c"),
      replaces: "ver-2",
    });
    expect(rollback.status).toBe(201);
    expect((rollback.json as Deployment).replaces?.versionId).toBe("ver-2");
  });

  test.each([
    [
      { provider: { name: "aws", service: "app", versionId: "v", deploymentId: "d" } },
      /provider.name/,
    ],
    [{ provider: { name: "cloudflare", service: "app", deploymentId: "d" } }, /provider.versionId/],
    [{ provider: { name: "cloudflare", service: "app", versionId: "v" } }, /provider.deploymentId/],
    [
      { provider: { name: "cloudflare", service: "a b", versionId: "v", deploymentId: "d" } },
      /provider.service/,
    ],
    [{ provider: { ...provider("v"), connectionId: "c" } }, /Unknown field: provider.connectionId/],
    [{ percentage: 10 }, /give provider too/],
    [{ replaces: "v0" }, /give provider too/],
    [{ provider: provider("v"), replaces: "v" }, /can't replace itself/],
    [{ provider: provider("v"), percentage: 101 }, /percentage/],
    [{ deployedAt: "2026-10-12T20:00:00+02:00" }, /deployedAt/],
    [
      { deployedAt: "2026-10-12T20:00:00Z", exposedFrom: "2026-10-12T19:00:00Z" },
      /before the deployment/,
    ],
    [{ exposedUntil: "2026-10-12T20:00:00Z" }, /start before it ends/],
    [{ artifact: { digest: DIGEST } }, /publishId, or by packageId and version/],
    [{ artifact: { publishId: "p", packageId: "pkg", version: "1" } }, /not both/],
    [{ artifact: { publishId: "p", digest: "md5" } }, /artifact.digest/],
  ])("refuses %j", async (extra, message) => {
    const t = await setup();
    const refused = await t.call(t.tokens.ann, "POST", path, {
      url: "https://app.example.com",
      commit: oid(7),
      ...extra,
    });
    expect(refused.status).toBe(400);
    expect((refused.json as { error: string }).error).toMatch(message);
  });

  test("a retry with recomputed times answers the first record unchanged; another identity conflicts", async () => {
    const t = await setup();
    publishes(t);
    // What gm sends on each run: `now` and `--expires 2d` differ every time.
    const run = (at: number, extra: Record<string, unknown> = {}, token = t.tokens.deploy) => {
      const now = Date.parse("2026-10-12T20:00:00Z") + at;
      return t.call(token, "POST", path, {
        url: "https://app.example.com",
        provider: provider("ver-2"),
        artifact: { publishId: "pub-app" },
        percentage: 10,
        replaces: "ver-1",
        deployedAt: new Date(now).toISOString(),
        exposedFrom: new Date(now).toISOString(),
        expiresAt: new Date(now + 2 * DAY).toISOString(),
        ...extra,
      });
    };
    const first = await run(0);
    expect(first.status).toBe(201);
    const again = await run(90_000, { url: "https://retried.example.com", status: "sleeping" });
    expect(again.status).toBe(200);
    expect(again.json).toEqual(first.json);
    // A person may name another commit (a job couldn't: 403 first); still a conflict.
    expect((await run(120_000, { commit: oid(6), artifact: undefined }, t.tokens.ann)).status).toBe(
      409,
    );
    for (const differing of [
      { environment: "staging" },
      { artifact: { publishId: "pub-sib" } },
      { percentage: 20 },
      { replaces: "ver-0" },
    ])
      expect((await run(120_000, differing)).status).toBe(409);
    // Another provider deployment of the same version is a record of its own.
    expect((await run(0, { provider: provider("ver-2", "dep-2") })).status).toBe(201);
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM deployments").get()).toEqual({ n: 2 });
  });

  test("a retry that loses the race to a concurrent one answers the record that won", async () => {
    const t = await setup();
    const body = {
      url: "https://app.example.com",
      provider: provider("ver-2"),
      exposedFrom: "2026-10-12T20:00:00Z",
    };
    // The other request inserts between this one's lookup and its insert.
    const real = t.env.DB;
    let raced = false;
    (t.env as { DB: D1Database }).DB = {
      batch: real.batch.bind(real),
      exec: real.exec.bind(real),
      prepare(sql: string) {
        if (!raced && /^insert into "deployments"/i.test(sql)) {
          raced = true;
          t.sqlite
            .exec(`INSERT INTO deployments (repo_id, source_id, environment, commit_oid, url, status,
              provider, provider_service, provider_version_id, provider_deployment_id, exposed_from)
            VALUES ('repo', 'canonical', 'production', '${oid(7)}', 'https://app.example.com', 'active',
              'cloudflare', 'app', 'ver-2', 'dep-1', '2026-10-12T20:00:00.000Z')`);
        }
        return real.prepare(sql);
      },
    } as D1Database;
    const answered = await t.call(t.tokens.deploy, "POST", path, body);
    expect(raced).toBe(true);
    expect(answered.status).toBe(200);
    expect(answered.json).toMatchObject({
      provider: { versionId: "ver-2", deploymentId: "dep-1" },
    });
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM deployments").get()).toEqual({ n: 1 });
    // A racing record with another identity is still a conflict.
    raced = false;
    t.sqlite.exec("DELETE FROM deployments");
    const conflicting = await t.call(t.tokens.deploy, "POST", path, { ...body, percentage: 50 });
    expect(conflicting.status).toBe(409);
  });

  test("a rollback is a record of its own, linked to what it replaced", async () => {
    const t = await setup();
    const record = (commit: string, versionId: string, deploymentId: string, replaces?: string) =>
      t.call(t.tokens.ann, "POST", path, {
        url: "https://app.example.com",
        commit,
        provider: provider(versionId, deploymentId),
        ...(replaces ? { replaces } : {}),
      });
    const one = (await record(oid(6), "ver-1", "dep-a")).json as Deployment;
    const two = (await record(oid(7), "ver-2", "dep-b", "ver-1")).json as Deployment;
    const back = await record(oid(6), "ver-1", "dep-c", "ver-2");
    expect(back.status).toBe(201);
    expect(two.replaces).toEqual({ versionId: "ver-1", deploymentId: one.id });
    expect((back.json as Deployment).replaces).toEqual({
      versionId: "ver-2",
      deploymentId: two.id,
    });
    expect((back.json as Deployment).id).not.toBe(one.id);
    const list = (await t.call(t.tokens.ann, "GET", `${path}?version=ver-1`))
      .json as DeploymentList;
    expect(list.deployments.map((d) => d.provider?.deploymentId)).toEqual(["dep-c", "dep-a"]);
  });

  test("a publication that records no digest refuses one, and is linked without", async () => {
    const t = await setup();
    publishes(t);
    t.registry.exec(`
      INSERT INTO publishes (id, feed_id, format, package_id, version, digest, action, status, git_repo_id, source_id, commit_oid, actor, actor_label, via, at) VALUES
        ('pub-npm', 'feed', 'npm', 'pkg', '2.0.0', NULL, 'npm.publish', 'active', 'repo', 'canonical', '${oid(7)}', 'job:job1', 'ci', 'job', '2026-10-01T06:00:00Z');
    `);
    for (const artifact of [
      { publishId: "pub-npm", digest: DIGEST },
      { packageId: "pkg", version: "2.0.0", digest: DIGEST },
    ]) {
      const refused = await t.call(t.tokens.deploy, "POST", path, {
        url: "https://app.example.com",
        artifact,
      });
      expect(refused.status).toBe(400);
      expect((refused.json as { error: string }).error).toBe(
        "This publication records no digest; omit the artifact's digest.",
      );
    }
    const linked = await t.call(t.tokens.deploy, "POST", path, {
      url: "https://app.example.com",
      artifact: { publishId: "pub-npm" },
    });
    expect(linked.status).toBe(201);
    expect((linked.json as Deployment).artifact).toMatchObject({
      publishId: "pub-npm",
      digest: null,
    });
  });

  test("a rollback links the replaced version's record in the same source and environment", async () => {
    const t = await setup();
    const older = (
      await t.call(t.tokens.ann, "POST", path, {
        url: "https://app.example.com",
        commit: oid(6),
        provider: provider("ver-1", "dep-1"),
      })
    ).json as Deployment;
    await t.call(t.tokens.ann, "POST", path, {
      url: "https://app.example.com",
      commit: oid(6),
      environment: "staging",
      provider: provider("ver-3", "dep-0"),
    });
    const rollback = await t.call(t.tokens.deploy, "POST", path, {
      url: "https://app.example.com",
      provider: provider("ver-2", "dep-2"),
      replaces: "ver-1",
    });
    expect((rollback.json as Deployment).replaces).toEqual({
      versionId: "ver-1",
      deploymentId: older.id,
    });
    // Not across environments: staging's ver-3 is no production record.
    const elsewhere = await t.call(t.tokens.deploy, "POST", path, {
      url: "https://app.example.com",
      provider: provider("ver-4", "dep-4"),
      replaces: "ver-3",
    });
    expect((elsewhere.json as Deployment).replaces).toEqual({
      versionId: "ver-3",
      deploymentId: null,
    });
  });

  test("PATCH ends exposure once, sets a share only while unset, and never rewrites identity", async () => {
    const t = await setup();
    publishes(t);
    const made = (
      await t.call(t.tokens.deploy, "POST", path, {
        url: "https://app.example.com",
        provider: provider("ver-2"),
        artifact: { publishId: "pub-app" },
        exposedFrom: "2026-10-12T20:00:00Z",
      })
    ).json as Deployment;
    const at = `${path}/${made.id}`;
    for (const body of [
      { provider: provider("ver-9") },
      { artifact: { publishId: "pub-sib" } },
      { commit: oid(8) },
      { deployedAt: "2026-10-12T20:00:00Z" },
      { exposedFrom: "2026-10-12T21:00:00Z" },
      { replaces: "ver-0" },
    ])
      expect((await t.call(t.tokens.deploy, "PATCH", at, body)).status).toBe(409);
    expect(
      (await t.call(t.tokens.deploy, "PATCH", at, { exposedUntil: "2026-10-12T19:00:00Z" })).status,
    ).toBe(400);
    const ended = await t.call(t.tokens.deploy, "PATCH", at, {
      exposedUntil: "2026-10-12T21:00:00Z",
      percentage: 25,
    });
    expect(ended.status).toBe(200);
    expect(ended.json).toMatchObject({
      exposedUntil: "2026-10-12T21:00:00.000Z",
      percentage: 25,
      provider: { versionId: "ver-2" },
      artifact: { publishId: "pub-app" },
    });
    // The same values again change nothing; different ones conflict.
    expect(
      (await t.call(t.tokens.deploy, "PATCH", at, { exposedUntil: "2026-10-12T21:00:00Z" })).status,
    ).toBe(200);
    expect(
      (await t.call(t.tokens.deploy, "PATCH", at, { exposedUntil: "2026-10-12T22:00:00Z" })).status,
    ).toBe(409);
    expect((await t.call(t.tokens.deploy, "PATCH", at, { percentage: 50 })).status).toBe(409);
    // An uninstrumented record has no share to set.
    const plain = (
      await t.call(t.tokens.deploy, "POST", path, { url: "https://plain.example.com" })
    ).json as Deployment;
    expect(
      (await t.call(t.tokens.deploy, "PATCH", `${path}/${plain.id}`, { percentage: 5 })).status,
    ).toBe(400);
  });

  test("PATCH sets exposedFrom once while unknown, then its end; a missing record is 404 first", async () => {
    const t = await setup();
    expect(
      (await t.call(t.tokens.ann, "PATCH", `${path}/999`, { provider: provider("v") })).status,
    ).toBe(404);
    const made = (
      await t.call(t.tokens.deploy, "POST", path, {
        url: "https://app.example.com",
        provider: provider("ver-2"),
        deployedAt: "2026-10-12T20:00:00Z",
      })
    ).json as Deployment;
    const at = `${path}/${made.id}`;
    const patch = (body: unknown) => t.call(t.tokens.deploy, "PATCH", at, body);
    // An end needs a start.
    expect((await patch({ exposedUntil: "2026-10-12T21:00:00Z" })).status).toBe(400);
    expect((await patch({ exposedFrom: "2026-10-12T19:00:00Z" })).status).toBe(400);
    expect(
      (await patch({ exposedFrom: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() }))
        .status,
    ).toBe(400);
    const started = await patch({ exposedFrom: "2026-10-12T20:01:00Z" });
    expect(started.status).toBe(200);
    expect((started.json as Deployment).exposedFrom).toBe("2026-10-12T20:01:00.000Z");
    expect((await patch({ exposedFrom: "2026-10-12T20:01:00Z" })).status).toBe(200);
    expect((await patch({ exposedFrom: "2026-10-12T20:02:00Z" })).status).toBe(409);
    expect((await patch({ exposedUntil: "2026-10-12T20:00:30Z" })).status).toBe(400);
    const ended = await patch({ exposedUntil: "2026-10-12T21:00:00Z" });
    expect((ended.json as Deployment).exposedUntil).toBe("2026-10-12T21:00:00.000Z");
  });

  test("/environments reads latest records and canary members in bounded chunks", async () => {
    const t = await setup();
    const rows = Array.from(
      { length: 120 },
      (_, i) =>
        `('repo','canonical','env-${i}','${oid(7)}','https://e${i}.example','active','cloudflare','app','ver-${i % 2}','dep-${i}')`,
    );
    t.sqlite
      .exec(`INSERT INTO deployments(repo_id,source_id,environment,commit_oid,url,status,provider,provider_service,provider_version_id,provider_deployment_id) VALUES ${rows.join(",")};
      INSERT INTO deployments(repo_id,source_id,environment,commit_oid,url,status,provider,provider_service,provider_version_id,provider_deployment_id)
        VALUES ('repo','canonical','env-119','${oid(6)}','https://e119.example','active','cloudflare','app','ver-x','dep-119');`);
    const { environments } = (
      await t.call(t.tokens.ann, "GET", "/api/repos/orbit/app/environments")
    ).json as EnvironmentList;
    expect(environments.filter((e) => e.latest)).toHaveLength(120);
    expect(environments.find((e) => e.name === "env-119")!.split).toHaveLength(2);
    expect(environments.find((e) => e.name === "env-3")!.split).toEqual([]);
  });

  test("an environment lists every live member of its newest canary split", async () => {
    const t = await setup();
    await t.call(t.tokens.ann, "POST", path, {
      url: "https://app.example.com",
      commit: oid(6),
      provider: provider("ver-1", "dep-2"),
      percentage: 90,
    });
    await t.call(t.tokens.ann, "POST", path, {
      url: "https://app.example.com",
      commit: oid(7),
      provider: provider("ver-2", "dep-2"),
      percentage: 10,
    });
    await t.call(t.tokens.ann, "POST", path, {
      url: "https://staging.example.com",
      commit: oid(7),
      environment: "staging",
      provider: provider("ver-2", "dep-s"),
    });
    const { environments } = (
      await t.call(t.tokens.ann, "GET", "/api/repos/orbit/app/environments")
    ).json as EnvironmentList;
    const production = environments.find((e) => e.name === "production")!;
    expect(production.latest?.provider?.versionId).toBe("ver-2");
    expect(production.split.map((d) => [d.provider?.versionId, d.percentage])).toEqual([
      ["ver-2", 10],
      ["ver-1", 90],
    ]);
    expect(environments.find((e) => e.name === "staging")!.split).toEqual([]);
  });
});
