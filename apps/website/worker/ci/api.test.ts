import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { CiLogs, CiRunDetail, CiRunList } from "../../shared/api.ts";
import type { AgentPresence } from "../../shared/agent-presence.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { ci } from "./api.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { CONTENT_CONTRACT_HEADER } from "../../shared/spaces.ts";

// loadRepo's module reaches the knowledge coordinator, a Durable Object.
vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

const oid = (n: number) => n.toString(16).padStart(40, "0");

async function setup() {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  closers.push(close);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_ann', 'user', 'ann', 'Ann');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_monitor', 'monitor', 'acc_ann');
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_bob', 'user', 'bob', 'Bob');
  `);
  await seedSpaceFixture(env.DB, {
    organization: {
      id: "organization",
      slug: "ann-personal",
      displayName: "Ann",
      kind: "personal",
      personalAccountId: "acc_ann",
    },
    space: { id: "space", slug: "ann", displayName: "General" },
    members: [
      {
        accountId: "acc_ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "acc_ann",
  });
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('repo', 'space', 'app', 'private', 'a', 'https://a');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES
      ('run1', 'repo', 1, '${oid(1)}', 'main', 'push', 'succeeded'),
      ('run2', 'repo', 2, '${oid(2)}', 'timeline/fast-search', 'push', 'failed'),
      ('run3', 'repo', 3, '${oid(3)}', 'topic', 'push', 'succeeded'),
      ('run4', 'repo', 4, '${oid(4)}', 'timeline/fast-search', 'push', 'succeeded');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, landing_id) VALUES
      ('run5', 'repo', 5, '${oid(5)}', 'gitmatrix/landing/fast-search', 'manual', 'running', 'ld_1');
    INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, queue_id) VALUES
      ('run6', 'repo', 6, '${oid(6)}', 'gitmatrix/landing/queue-${oid(6)}-1', 'manual', 'running', '${oid(6)}');
  `);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/repos/:space/:name/ci", ci);
  const { secret } = await issueToken(env.DB, "acc_ann", "t", "read");
  const agent = (await issueToken(env.DB, "acc_ann", "monitor", "read", undefined, "agt_monitor"))
    .secret;
  const outsider = (await issueToken(env.DB, "acc_bob", "outsider", "read")).secret;
  const get = async (path: string, token = secret) => {
    const pending: Promise<unknown>[] = [];
    const response = await app.request(
      path,
      { headers: { authorization: `Bearer ${token}`, [CONTENT_CONTRACT_HEADER]: "4" } },
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
    return { status: response.status, json: (await response.json()) as CiRunList };
  };
  return Object.assign(get, { sqlite, agent, outsider });
}

describe("CI runs list", () => {
  test("lists every branch's runs, newest first", async () => {
    const get = await setup();
    const { json } = await get("/api/repos/ann/app/ci");
    expect(json.runs.map((run) => run.number)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(json.runs[0]).toMatchObject({
      trigger: "landing",
      queueId: oid(6),
      landing: null,
      preview: null,
    });
    // A landing's run (CORE-77) is stored as manual and reported as a landing.
    expect(json.runs[1]).toMatchObject({
      trigger: "landing",
      landing: { id: "ld_1", timeline: "fast-search" },
      preview: null,
    });
    expect(json.runs[2]).toMatchObject({ trigger: "push", landing: null, queueId: null });
  });

  test("?ref= lists one branch's runs: a timeline's bookmark in its scope", async () => {
    const get = await setup();
    const scoped = await get("/api/repos/ann/app/ci?ref=timeline/fast-search");
    expect(scoped.json.runs.map((run) => run.number)).toEqual([4, 2]);
    const full = await get("/api/repos/ann/app/ci?ref=refs/heads/timeline/fast-search&before=4");
    expect(full.json.runs.map((run) => run.number)).toEqual([2]);
  });

  test("?commit= lists one commit's runs, for the commit panel; a short hash is refused", async () => {
    const get = await setup();
    get.sqlite.exec(`INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status)
      VALUES ('run7', 'repo', 7, '${oid(3)}', 'topic', 'manual', 'failed')`);
    const runs = await get(`/api/repos/ann/app/ci?commit=${oid(3).toUpperCase()}`);
    expect(runs.json.runs.map((run) => run.number)).toEqual([7, 3]);
    expect((await get(`/api/repos/ann/app/ci?commit=${oid(3).slice(0, 7)}`)).status).toBe(400);
  });
});

test("run detail exposes verification provenance without executed success or timestamps", async () => {
  const get = await setup();
  try {
    const proof = {
      runId: "run6",
      runNumber: 6,
      jobId: "producer",
      queueId: oid(6),
      attempt: 1,
      commit: oid(1),
      sourceId: "canonical",
      contract: "context-invariant-v1",
      executionIdentity: "sandbox-v1:version:sha256:digest",
    };
    get.sqlite
      .prepare(
        "INSERT INTO ci_jobs(id,run_id,repo_id,name,spec,status,runner,verified_by) VALUES('verified','run1','repo','check','{\"needs\":[]}','skipped','sandbox',?)",
      )
      .run(JSON.stringify(proof));
    const response = await get("/api/repos/ann/app/ci/runs/1");
    expect(response.status).toBe(200);
    const detail = response.json as unknown as CiRunDetail;
    expect(detail.jobs[0]).toMatchObject({
      status: "skipped",
      claimedBy: null,
      exitCode: null,
      startedAt: null,
      finishedAt: null,
      verifiedBy: proof,
    });
  } finally {
    get.sqlite.close();
  }
});

describe("after retention (CORE-200)", () => {
  test("a job's removed log says when, and a removed run says it was removed", async () => {
    const get = await setup();
    get.sqlite.exec(`
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, finished_at, logs_removed_at)
        VALUES ('j1', 'run3', 'repo', 'build', '{"needs":[]}', 'succeeded', 'sandbox',
                '2026-01-01T00:00:00.000Z', '2026-10-01T12:00:00.000Z');
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner, finished_at)
        VALUES ('j2', 'run3', 'repo', 'test', '{"needs":[]}', 'succeeded', 'sandbox',
                '2026-01-01T00:00:00.000Z');
      INSERT INTO ci_logs (job_id, seq, step, text) VALUES ('j2', 1, 0, 'kept');
      DELETE FROM ci_runs WHERE id = 'run2';
    `);
    const run = (await get("/api/repos/ann/app/ci/runs/3")).json as unknown as CiRunDetail;
    expect(run.jobs.map((j) => [j.name, j.logsRemovedAt])).toEqual([
      ["build", "2026-10-01T12:00:00.000Z"],
      ["test", null],
    ]);
    const removed = (await get("/api/repos/ann/app/ci/jobs/j1/logs")).json as unknown as CiLogs;
    expect(removed).toEqual({
      chunks: [],
      next: 0,
      done: true,
      removedAt: "2026-10-01T12:00:00.000Z",
    });
    const kept = (await get("/api/repos/ann/app/ci/jobs/j2/logs")).json as unknown as CiLogs;
    expect(kept).toMatchObject({ chunks: [{ text: "kept" }], removedAt: null });

    const gone = await get("/api/repos/ann/app/ci/runs/2");
    expect(gone).toEqual({ status: 404, json: { error: "Run #2 was removed by retention." } });
    const never = await get("/api/repos/ann/app/ci/runs/9");
    expect(never).toEqual({ status: 404, json: { error: "No such run." } });
  });
});

describe("CI recent presence", () => {
  test("only successful resource reads count; logs resolve the run and presence reads never renew", async () => {
    const get = await setup();
    try {
      const presence = "/api/repos/ann/app/ci/runs/1/presence";
      const agents = async () => ((await get(presence)).json as unknown as AgentPresence).agents;
      await get(presence, get.agent);
      await get("/api/repos/ann/app/ci", get.agent);
      expect(await agents()).toEqual([]);
      expect((await get("/api/repos/ann/app/ci/runs/1?source=other", get.agent)).status).toBe(404);
      expect((await get("/api/repos/ann/app/ci/runs/99", get.agent)).status).toBe(404);
      expect(await agents()).toEqual([]);
      expect((await get("/api/repos/ann/app/ci/runs/1", get.agent)).status).toBe(200);
      expect(await agents()).toMatchObject([{ id: "agt_monitor", name: "monitor" }]);
      get.sqlite.exec(`INSERT INTO ci_jobs(id,run_id,repo_id,name,spec,status,runner)
        VALUES('observed','run1','repo','build','{"needs":[]}','succeeded','sandbox')`);
      expect(
        (await get("/api/repos/ann/app/ci/jobs/observed/logs?source=other", get.agent)).status,
      ).toBe(404);
      expect((await get("/api/repos/ann/app/ci/jobs/observed/logs", get.agent)).status).toBe(200);
      const before = await agents();
      expect(before).toHaveLength(1);
      await get(presence, get.agent);
      expect(await agents()).toEqual(before);
      expect((await get(`${presence}?source=other`)).status).toBe(404);
      expect((await get(presence, get.outsider)).status).toBe(404);
      expect((await get("/api/repos/ann/missing/ci/runs/1/presence")).status).toBe(404);
    } finally {
      get.sqlite.close();
    }
  });
});
