import { Hono } from "hono";
import { describe, expect, test, vi } from "vite-plus/test";
import type { CiLogs, CiRunDetail, CiRunList } from "../../shared/api.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { ci } from "./api.ts";

// loadRepo's module reaches the knowledge coordinator, a Durable Object.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const oid = (n: number) => n.toString(16).padStart(40, "0");

async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('acc_ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('repo', 'acc_ann', 'app', 'private', 'a', 'https://a');
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
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/repos/:owner/:name/ci", ci);
  const { secret } = await issueToken(env.DB, "acc_ann", "t", "read");
  const get = async (path: string) => {
    const response = await app.request(
      path,
      { headers: { authorization: `Bearer ${secret}` } },
      env,
    );
    return { status: response.status, json: (await response.json()) as CiRunList };
  };
  return Object.assign(get, { sqlite });
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
