import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, test, vi } from "vite-plus/test";
import { d1, migratedRegistryDatabase } from "../testing/d1.ts";
import { cancelRun } from "./cancel.ts";
import { claim, failDispatch, report } from "./jobs.ts";
import { ciRuns } from "../retention/cleanups/ci-runs.ts";
import { mintJobToken } from "./registry.ts";
import { jobCaller } from "../deployments/job.ts";
import { authenticate } from "../../registry/core/auth/authenticate.ts";
import { CiSandbox } from "./sandbox.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { captureWorkAuthority } from "./admission.ts";
import { fakeDurableState } from "../testing/durable-state.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
vi.mock("../artifacts.ts", async (original) => ({
  ...(await original<typeof import("../artifacts.ts")>()),
  upstreamToken: async () => "sandbox-fixture-read-token",
}));

const migration = "20261005212506_ci_source_claims.sql";
const directory = fileURLToPath(new URL("../../migrations/", import.meta.url).href);
const oid = "a".repeat(40);

function legacyFixture(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO accounts (id,kind,slug,display_name) VALUES ('org','org','orbit','Orbit');
    INSERT INTO repos (id,owner_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES ('repo','org','app','private','app','https://app');
    INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,state,
       allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
       initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,archived_at)
    VALUES ('work','repo','timeline','timeline','org','work','archived',
      'allocation','canonical','${oid}','${oid}','refs/heads/main',
      'canonical','${oid}','${oid}','refs/heads/main','2025-01-01','2025-01-01','2025-01-01');
  `);
  let number = 0;
  const run = (id: string, status = "queued", landing: string | null = null) =>
    sqlite
      .prepare(`
    INSERT INTO ci_runs (id,repo_id,source_id,number,commit_oid,ref,trigger,status,title,landing_id)
    VALUES (?,'repo','work',?,'${oid}','work','manual',?,'Source claims',?)
  `)
      .run(id, ++number, status, landing);
  const job = (id: string, runId: string, status = "pending") =>
    sqlite
      .prepare(`
    INSERT INTO ci_jobs (id,run_id,repo_id,source_id,name,spec,status,runner)
    VALUES (?,?,'repo','work',?,'{"secrets":[]}',?,'sandbox')
  `)
      .run(id, runId, id, status);
  const runStatus = (id: string, status: string) =>
    sqlite.prepare("UPDATE ci_runs SET status=? WHERE id=?").run(status, id);
  const jobStatus = (id: string, status: string) =>
    sqlite.prepare("UPDATE ci_jobs SET status=? WHERE id=?").run(status, id);
  const roots = () =>
    sqlite
      .prepare(
        "SELECT consumer_id FROM timeline_source_roots WHERE consumer_kind='ci' ORDER BY consumer_id",
      )
      .all()
      .map((row) => row.consumer_id);
  const fence = () =>
    sqlite.exec(
      "UPDATE timeline_work_sources SET expiry_requested_at='2026-10-04' WHERE source_id='work'",
    );
  return { sqlite, run, job, runStatus, jobStatus, roots, fence };
}

async function fixture() {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite, env } = fresh;
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('person','user','person','Person')",
  );
  await seedSpaceFixture(env.DB, {
    organization: { id: "org", slug: "orbit", displayName: "Orbit", kind: "company" },
    space: { id: "space", slug: "orbit", displayName: "Orbit" },
    members: [
      {
        accountId: "person",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "person",
  });
  sqlite.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
    VALUES('repo','space','app','private','app','https://app');
    INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four)
    VALUES('credential','person','Fixture','write','fixture-hash','test');`);
  const authority = await captureWorkAuthority(env, "repo", {
    id: "person",
    credential: { kind: "token", id: "credential" },
  });
  sqlite
    .prepare(`INSERT INTO timeline_work_sources
    (source_id,repo_id,timeline_id,timeline_slug,space_id,authority,artifacts_name,state,
     allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
     initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,archived_at)
    VALUES ('work','repo','timeline','timeline','space',?,'work','archived',
      'allocation','canonical','${oid}','${oid}','refs/heads/main',
      'canonical','${oid}','${oid}','refs/heads/main','2025-01-01','2025-01-01','2025-01-01')`)
    .run(JSON.stringify(authority));
  let number = 0;
  const run = (id: string, status = "queued", landing: string | null = null) =>
    sqlite
      .prepare(`INSERT INTO ci_runs
      (id,repo_id,space_id,migration_epoch,authority,actor_id,agent_id,source_id,number,commit_oid,ref,trigger,status,title,landing_id)
      VALUES (?,'repo','space',?,?,'person',NULL,'work',?,'${oid}','work','manual',?,'Source claims',?)`)
      .run(id, authority.migrationEpoch, JSON.stringify(authority), ++number, status, landing);
  const job = (id: string, runId: string, status = "pending") =>
    sqlite
      .prepare(`INSERT INTO ci_jobs (id,run_id,repo_id,source_id,name,spec,status,runner)
      VALUES (?,?,'repo','work',?,'{"secrets":[]}',?,'sandbox')`)
      .run(id, runId, id, status);
  const runStatus = (id: string, status: string) =>
    sqlite.prepare("UPDATE ci_runs SET status=? WHERE id=?").run(status, id);
  const jobStatus = (id: string, status: string) =>
    sqlite.prepare("UPDATE ci_jobs SET status=? WHERE id=?").run(status, id);
  const roots = () =>
    sqlite
      .prepare(
        "SELECT consumer_id FROM timeline_source_roots WHERE consumer_kind='ci' ORDER BY consumer_id",
      )
      .all()
      .map((row) => row.consumer_id);
  const fence = () =>
    sqlite.exec(
      "UPDATE timeline_work_sources SET expiry_requested_at='2026-10-04' WHERE source_id='work'",
    );
  return { ...fresh, run, job, runStatus, jobStatus, roots, fence };
}

describe("CI source claim lifetime", () => {
  test("cancellation settles only unstarted or confirmed-stopped children and leaves live evidence intact", async () => {
    const t = await fixture();
    const env = t.env;
    try {
      t.run("cancel", "running");
      for (const id of ["unstarted", "stopped", "claimed", "started", "ack", "running"]) {
        t.job(id, "cancel", id === "running" ? "running" : "queued");
        t.sqlite
          .prepare("INSERT INTO ci_steps(job_id,position,name,status) VALUES (?,0,'step',?)")
          .run(id, id === "unstarted" ? "pending" : "running");
      }
      t.sqlite.exec(`
        UPDATE ci_jobs SET claimed_by='runner' WHERE id='claimed';
        UPDATE ci_jobs SET started_at='2026-10-11T04:04:56Z' WHERE id='started';
        UPDATE ci_jobs SET source_completion_pending=1 WHERE id='ack';
        UPDATE ci_jobs SET error='earlier failure',exit_code=137 WHERE id='stopped';
      `);
      await cancelRun(env, "cancel");
      expect(t.sqlite.prepare("SELECT id,status FROM ci_jobs ORDER BY id").all()).toEqual([
        { id: "ack", status: "queued" },
        { id: "claimed", status: "queued" },
        { id: "running", status: "running" },
        { id: "started", status: "queued" },
        { id: "stopped", status: "cancelled" },
        { id: "unstarted", status: "cancelled" },
      ]);
      expect(t.sqlite.prepare("SELECT job_id,status FROM ci_steps ORDER BY job_id").all()).toEqual([
        { job_id: "ack", status: "running" },
        { job_id: "claimed", status: "running" },
        { job_id: "running", status: "running" },
        { job_id: "started", status: "running" },
        { job_id: "stopped", status: "running" },
        { job_id: "unstarted", status: "cancelled" },
      ]);
      expect(t.roots()).toEqual(["cancel"]);
      expect(
        t.sqlite.prepare("SELECT error,exit_code FROM ci_jobs WHERE id='stopped'").get(),
      ).toEqual({ error: "earlier failure", exit_code: 137 });
      for (const id of ["claimed", "started", "ack", "running"])
        await report(env, id, { done: { status: "cancelled" } });
      expect(t.roots()).toEqual([]);
    } finally {
      t.close();
    }
  });

  test.each(["stopped", "stop-failed"])(
    "Sandbox source claim waits for confirmed container shutdown: %s",
    async (shutdown) => {
      const t = await fixture();
      const stopping = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      let running = false;
      const container = {
        get running() {
          return running;
        },
        images: { default: "fixture-image" },
        start() {
          running = true;
        },
        async exec() {
          return {
            stdout: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            exitCode: Promise.resolve(0),
          };
        },
        async destroy() {
          stopping.resolve();
          await stopped.promise;
          if (shutdown === "stop-failed") throw new Error("Container stop not acknowledged");
          running = false;
        },
      } as unknown as Container;
      t.run("sandbox-run", "running");
      t.job("sandbox-job", "sandbox-run", "queued");
      t.sqlite.exec(
        "UPDATE timeline_work_sources SET artifacts_remote='https://work',initial_token_revoked=1 WHERE source_id='work'",
      );
      t.sqlite.prepare("UPDATE ci_jobs SET spec=? WHERE id='sandbox-job'").run(
        JSON.stringify({
          secrets: [],
          env: {},
          steps: [],
          timeoutMinutes: 5,
          instance: "lite",
          image: "default",
        }),
      );
      const env = t.env;
      env.PUBLIC_URL = "https://gitmatrix.example";
      const state = fakeDurableState({ name: "sandbox-job" });
      Reflect.set(state.ctx, "container", container);
      const sandbox = new CiSandbox(state.ctx, env);
      const execution = sandbox.run("sandbox-job");
      const outcome = execution.then(
        () => null,
        (error: unknown) => error,
      );
      try {
        await Promise.race([
          stopping.promise,
          outcome.then((error) => {
            throw error ?? new Error("Job ended before stopping its container");
          }),
        ]);
        t.runStatus("sandbox-run", "cancelled");
        expect(t.roots()).toEqual(["sandbox-run"]);
        stopped.resolve();
        const error = await outcome;
        if (shutdown === "stop-failed") {
          expect(error).toBeInstanceOf(Error);
          expect(t.roots()).toEqual(["sandbox-run"]);
          expect(
            t.sqlite.prepare("SELECT status FROM ci_jobs WHERE id='sandbox-job'").get(),
          ).toEqual({ status: "running" });
        } else {
          expect(error).toBeNull();
          expect(t.roots()).toEqual([]);
          expect(
            t.sqlite.prepare("SELECT status FROM ci_jobs WHERE id='sandbox-job'").get(),
          ).toEqual({ status: "succeeded" });
        }
      } finally {
        stopped.resolve();
        await outcome;
        t.close();
        state.db.close();
      }
    },
  );

  test("a source-aware job is delivered to exactly one runner despite retention trigger writes", async () => {
    const t = await fixture();
    try {
      t.run("run", "running");
      t.job("job", "run", "queued");
      expect(await claim(t.env, "job", "first")).toBe(true);
      expect(await claim(t.env, "job", "second")).toBe(false);
      expect(
        t.sqlite.prepare("SELECT status,claimed_by FROM ci_jobs WHERE id='job'").get(),
      ).toEqual({
        status: "running",
        claimed_by: "first",
      });
      expect(t.roots()).toEqual(["run"]);
    } finally {
      t.close();
    }
  });

  test.each(["cancelled", "failed"])(
    "terminal parent %s revokes execution and publication grants before child acknowledgment",
    async (status) => {
      const t = await fixture();
      const env = t.env;
      try {
        t.run("run", "running");
        t.job("job", "run", "running");
        t.job("queued", "run", "queued");
        const secret = await mintJobToken(env, "job", 20);
        const headers = new Headers({ authorization: `Bearer ${secret}` });
        expect(await jobCaller(env, secret)).toMatchObject({ jobId: "job" });
        expect(await authenticate(env, headers)).toMatchObject({ kind: "job" });
        t.runStatus("run", status);
        expect(await claim(env, "queued", "runner")).toBe(false);
        await cancelRun(env, "run");
        expect(t.roots()).toEqual(["run"]);
        expect(t.sqlite.prepare("SELECT status FROM ci_jobs WHERE id='job'").get()).toEqual({
          status: "running",
        });
        expect(await jobCaller(env, secret)).toBeNull();
        await expect(authenticate(env, headers)).rejects.toThrow();
        expect(await report(env, "job", { logs: [{ step: -1, text: "stopping" }] })).toEqual({
          cancelled: true,
        });
        await report(env, "job", { done: { status: "cancelled" } });
        expect(t.roots()).toEqual([]);
      } finally {
        t.close();
      }
    },
  );

  test("cancellation and dispatch timeout retain running consumers until their acknowledgment", async () => {
    const t = await fixture();
    const env = t.env;
    try {
      t.run("cancel", "running");
      t.job("cancel-running", "cancel", "running");
      t.job("cancel-queued", "cancel", "queued");
      t.run("timeout", "running");
      t.job("timeout-running", "timeout", "running");
      t.fence();
      await cancelRun(env, "cancel");
      await failDispatch(env.DB, "timeout-running", "No runner finished this job in time.");
      t.runStatus("timeout", "failed");
      expect(t.roots()).toEqual(["cancel", "timeout"]);
      expect(t.sqlite.prepare("SELECT id,status FROM ci_jobs ORDER BY id").all()).toEqual([
        { id: "cancel-queued", status: "cancelled" },
        { id: "cancel-running", status: "running" },
        { id: "timeout-running", status: "running" },
      ]);
      expect(
        await report(env, "cancel-running", { logs: [{ step: -1, text: "still stopping" }] }),
      ).toEqual({ cancelled: true });
      expect(t.roots()).toEqual(["cancel", "timeout"]);
      await report(env, "cancel-running", { done: { status: "cancelled" } });
      expect(t.roots()).toEqual(["timeout"]);
      await report(env, "timeout-running", { done: { status: "failed", exitCode: 124 } });
      expect(t.roots()).toEqual([]);
    } finally {
      t.close();
    }
  });

  for (const terminal of ["succeeded", "failed", "cancelled"]) {
    test(`${terminal} parent holds every unfinished child and preserves history on release`, async () => {
      const t = await fixture();
      try {
        t.run("run", "running", "compact-landing");
        t.job("pending", "run");
        t.job("queued", "run", "queued");
        t.job("running", "run", "running");
        t.sqlite.exec(
          "INSERT INTO ci_logs (job_id,seq,step,text) VALUES ('running',1,0,'kept log')",
        );
        t.fence();
        t.runStatus("run", terminal);
        expect(t.roots()).toEqual(["run"]);
        t.jobStatus("pending", "skipped");
        t.jobStatus("queued", "cancelled");
        expect(t.roots()).toEqual(["run"]);
        t.jobStatus("running", "succeeded");
        expect(t.roots()).toEqual([]);
        expect(t.sqlite.prepare("SELECT status,landing_id FROM ci_runs").all()).toEqual([
          { status: terminal, landing_id: "compact-landing" },
        ]);
        expect(t.sqlite.prepare("SELECT text FROM ci_logs").all()).toEqual([{ text: "kept log" }]);
        expect(t.sqlite.prepare("SELECT id FROM ci_jobs ORDER BY id").all()).toEqual([
          { id: "pending" },
          { id: "queued" },
          { id: "running" },
        ]);
      } finally {
        t.close();
      }
    });
  }

  test("finished children do not release an outstanding parent; config failures release jobless runs", async () => {
    const t = await fixture();
    try {
      t.run("run");
      t.job("job", "run");
      t.jobStatus("job", "succeeded");
      expect(t.roots()).toEqual(["run"]);
      t.runStatus("run", "running");
      expect(t.roots()).toEqual(["run"]);
      t.runStatus("run", "succeeded");
      expect(t.roots()).toEqual([]);
      t.run("config-error");
      t.runStatus("config-error", "failed");
      expect(t.roots()).toEqual([]);
    } finally {
      t.close();
    }
  });

  test("unexpired retries reacquire claims but released expired runs and children cannot resurrect", async () => {
    const t = await fixture();
    try {
      t.run("run");
      t.job("job", "run");
      t.jobStatus("job", "failed");
      t.runStatus("run", "failed");
      expect(t.roots()).toEqual([]);
      t.jobStatus("job", "queued");
      expect(t.roots()).toEqual(["run"]);
      t.runStatus("run", "queued");
      t.fence();
      // Already-admitted retries keep the same exact claim while draining.
      t.jobStatus("job", "running");
      t.runStatus("run", "running");
      expect(t.roots()).toEqual(["run"]);
      t.jobStatus("job", "succeeded");
      t.runStatus("run", "succeeded");
      expect(t.roots()).toEqual([]);
      expect(() => t.runStatus("run", "queued")).toThrow();
      expect(() => t.jobStatus("job", "queued")).toThrow();
      expect(() => t.job("late", "run")).toThrow();
      expect(() => t.run("new")).toThrow();
      expect(t.sqlite.prepare("SELECT status FROM ci_runs WHERE id='run'").get()).toEqual({
        status: "succeeded",
      });
      expect(t.sqlite.prepare("SELECT status FROM ci_jobs WHERE id='job'").get()).toEqual({
        status: "succeeded",
      });
      expect(t.roots()).toEqual([]);
    } finally {
      t.close();
    }
  });

  test("migration releases proven terminal history but requires acknowledgment for ambiguous consumers", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const registry = migratedRegistryDatabase();
    try {
      for (const file of readdirSync(directory)
        .filter((name) => name.endsWith(".sql") && name < migration)
        .sort())
        sqlite.exec(readFileSync(join(directory, file), "utf8"));
      const t = legacyFixture(sqlite);
      t.run("completed", "succeeded", "historical-landing");
      t.job("completed-job", "completed", "succeeded");
      t.run("cancelled-active", "cancelled");
      t.job("active-job", "cancelled-active", "running");
      t.run("queued");
      t.run("failed-jobless", "failed");
      t.run("old-cancel", "cancelled");
      t.job("old-cancel-job", "old-cancel", "cancelled");
      t.run("old-timeout", "failed");
      t.job("old-timeout-job", "old-timeout", "failed");
      t.run("known-exit", "failed");
      t.job("known-exit-job", "known-exit", "failed");
      sqlite.exec(`
        UPDATE ci_jobs SET started_at='2025-01-01' WHERE id IN ('old-cancel-job','old-timeout-job','known-exit-job');
        UPDATE ci_jobs SET exit_code=1 WHERE id='known-exit-job';
      `);
      sqlite.exec(
        `INSERT INTO timeline_source_roots VALUES ('repo','work','knowledge','index','${oid}','2025-01-01')`,
      );
      t.fence();
      sqlite.exec(readFileSync(join(directory, migration), "utf8"));
      expect(t.roots()).toEqual(["cancelled-active", "old-cancel", "old-timeout", "queued"]);
      expect(
        sqlite
          .prepare("SELECT id FROM ci_jobs WHERE source_completion_pending=1 ORDER BY id")
          .all(),
      ).toEqual([{ id: "old-cancel-job" }, { id: "old-timeout-job" }]);
      expect(
        sqlite
          .prepare("SELECT consumer_id FROM timeline_source_roots WHERE consumer_kind='knowledge'")
          .all(),
      ).toEqual([{ consumer_id: "index" }]);
      expect(sqlite.prepare("SELECT id FROM ci_runs ORDER BY id").all()).toEqual([
        { id: "cancelled-active" },
        { id: "completed" },
        { id: "failed-jobless" },
        { id: "known-exit" },
        { id: "old-cancel" },
        { id: "old-timeout" },
        { id: "queued" },
      ]);
      t.jobStatus("active-job", "cancelled");
      expect(t.roots()).toEqual(["old-cancel", "old-timeout", "queued"]);
      const env = { DB: d1(sqlite), REGISTRY_DB: d1(registry) } as Env;
      const admission = installCutoverTestControl(env);
      try {
        await expect(
          captureWorkAuthority(env, "repo", {
            id: "org",
            credential: { kind: "token", id: "legacy-credential" },
          }),
        ).rejects.toThrow("space_cutover_fenced");
      } finally {
        admission.close();
      }
    } finally {
      sqlite.close();
      registry.close();
    }
  });

  test("retention excludes ambiguous terminal consumers until their exact acknowledgment", async () => {
    const t = await fixture();
    const { sqlite, env } = t;
    try {
      t.run("old-cancel", "running");
      t.job("old-cancel-job", "old-cancel", "running");
      t.run("old-timeout", "running");
      t.job("old-timeout-job", "old-timeout", "running");
      sqlite.exec(`UPDATE ci_jobs SET started_at='2025-01-01',source_completion_pending=1;
        UPDATE ci_jobs SET status='cancelled' WHERE id='old-cancel-job';
        UPDATE ci_jobs SET status='failed' WHERE id='old-timeout-job';`);
      t.runStatus("old-cancel", "cancelled");
      t.runStatus("old-timeout", "failed");
      t.run("queued");
      t.fence();
      expect(t.roots()).toEqual(["old-cancel", "old-timeout", "queued"]);
      sqlite.exec("UPDATE ci_runs SET created_at='2025-01-01'");
      const context = {
        env,
        target: { kind: "space", id: "space" } as const,
        thresholds: { days: 1, keepLatest: 1 },
        now: new Date("2026-10-04"),
        limit: 50,
      };
      const before = await ciRuns.select(context, null);
      expect(before.items.map((item) => item.id)).not.toContain("old-cancel");
      expect(before.items.map((item) => item.id)).not.toContain("old-timeout");
      await report(env, "old-cancel-job", { done: { status: "cancelled" } });
      await report(env, "old-timeout-job", { done: { status: "failed", exitCode: 124 } });
      expect(t.roots()).toEqual(["queued"]);
      const after = await ciRuns.select(context, null);
      expect(after.items.map((item) => item.id)).toContain("old-cancel");
      expect(after.items.map((item) => item.id)).toContain("old-timeout");
    } finally {
      t.close();
    }
  });
});
