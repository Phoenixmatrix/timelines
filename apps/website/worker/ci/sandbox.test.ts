import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type * as Artifacts from "../artifacts.ts";
import { d1, migratedDatabase, migratedRegistryDatabase } from "../testing/d1.ts";
import { TrackerStore } from "../tracker/store.ts";
import { drainDeletedRepoSources } from "../retention/work-sources.ts";
import { cancelRun } from "./cancel.ts";
import { CiSandbox } from "./sandbox.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import { fakeDurableObjectId, fakeDurableState } from "../testing/durable-state.ts";
import { seedSpaceFixture } from "../testing/spaces.ts";
import { issueToken } from "../api/tokens.ts";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";
import { initializeFreshTrackerSpace } from "../tracker/space-migration.ts";

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
});

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
vi.mock("../artifacts.ts", async (original) => ({
  ...(await original<typeof Artifacts>()),
  upstreamToken: async () => "sandbox-fixture-read-token",
}));
const tracker = vi.hoisted(() => ({
  getWorkSource: vi.fn(),
  transitionWorkSource: vi.fn(),
}));
vi.mock("../tracker/stub.ts", () => ({ trackerObject: () => tracker }));

describe("Sandbox infrastructure retry cancellation", () => {
  test.each(["stopped", "stop-failed", "stop-unacknowledged"])(
    "%s preserves evidence and releases source purge only after confirmed shutdown",
    async (shutdown) => {
      const sqlite = migratedDatabase();
      const registry = migratedRegistryDatabase();
      const durable = fakeDurableState({ name: "org" });
      const stopping = Promise.withResolvers<void>();
      const stopped = Promise.withResolvers<void>();
      const infrastructureFailure = new Error("Fixture infrastructure failure");
      const shutdownFailure = new Error("Container stop not acknowledged");
      let running = false;
      const executions: string[][] = [];
      const container = {
        get running() {
          return running;
        },
        images: { default: "fixture-image" },
        start() {
          running = true;
        },
        async exec(command: string[]) {
          executions.push(command);
          // Fail the actual build dispatch, not a numbered setup exec: registry
          // configuration also runs between checkout and the first user step.
          if (command[4] === "build") throw infrastructureFailure;
          return {
            stdout: new ReadableStream({
              start(controller) {
                if (command[4]?.includes("git clone"))
                  controller.enqueue(new TextEncoder().encode("checkout evidence\n"));
                controller.close();
              },
            }),
            exitCode: Promise.resolve(0),
          };
        },
        async destroy() {
          stopping.resolve();
          await stopped.promise;
          if (shutdown === "stop-failed") throw shutdownFailure;
          running = false;
          if (shutdown === "stop-unacknowledged") throw shutdownFailure;
        },
      } as unknown as Container;
      const deleted: string[] = [];
      const env = {
        DB: d1(sqlite),
        REGISTRY_DB: d1(registry),
        PUBLIC_URL: "https://gitmatrix.example",
        ARTIFACTS: {
          delete: async (name: string) => {
            deleted.push(name);
          },
        },
      } as unknown as Env;
      const admission = installCutoverTestControl(env);
      await initializeFreshSpaceInstallation(env);
      sqlite.exec(
        "INSERT INTO accounts(id,kind,slug,display_name) VALUES ('person','user','person','Person')",
      );
      await seedSpaceFixture(env.DB, {
        organization: {
          id: "organization",
          slug: "orbit-company",
          displayName: "Orbit",
          kind: "company",
        },
        space: { id: "org", slug: "orbit", displayName: "General" },
        members: [
          {
            accountId: "person",
            role: "owner",
            grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
          },
        ],
        actorId: "person",
      });
      env.TRACKER = { idFromName: fakeDurableObjectId } as unknown as Env["TRACKER"];
      await initializeFreshTrackerSpace(env, durable.ctx, "org");
      const store = new TrackerStore(durable.ctx.storage.sql, (fn) =>
        durable.ctx.storage.transactionSync(fn),
      );
      const credential = await issueToken(env.DB, "person", "ci", "write");
      sqlite.exec(`
        INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
          VALUES ('repo','org','app','private','app','https://app');
        INSERT INTO timeline_work_sources
          (source_id,repo_id,timeline_id,timeline_slug,space_id,artifacts_name,artifacts_remote,
           state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
           initial_source_id,initial_commit,initial_tree,initial_ref,initial_token_revoked,
           created_at,updated_at,archived_at)
          VALUES ('work','repo','timeline','timeline','org','work','https://work','archived',
            'allocation','canonical','head','tree','refs/heads/main',
            'canonical','head','tree','refs/heads/main',1,'2025-01-01','2025-01-01','2025-01-01');
        INSERT INTO ci_runs(id,repo_id,source_id,number,commit_oid,ref,trigger,status,title)
          VALUES ('run','repo','work',1,'head','work','manual','running','Retry');
        INSERT INTO ci_jobs(id,run_id,repo_id,source_id,name,spec,status,runner,error,exit_code)
          VALUES ('job','run','repo','work','job','{}','queued','sandbox','earlier failure',137);
        INSERT INTO ci_steps(job_id,position,name,status) VALUES
          ('job',0,'build','pending'),('job',1,'later','pending');
      `);
      sqlite
        .prepare(
          "UPDATE ci_runs SET actor_id=?,space_id=?,migration_epoch=?,authority=? WHERE id='run'",
        )
        .run(
          "person",
          "org",
          0,
          JSON.stringify({
            spaceId: "org",
            migrationEpoch: 0,
            personId: "person",
            agentId: null,
            credential: { kind: "token", id: credential.id },
          }),
        );
      sqlite.prepare("UPDATE ci_jobs SET spec=? WHERE id='job'").run(
        JSON.stringify({
          secrets: [],
          env: {},
          timeoutMinutes: 5,
          instance: "lite",
          image: "default",
          steps: [
            { name: "build", run: "build" },
            { name: "later", run: "later" },
          ],
        }),
      );
      durable.db
        .prepare(
          "INSERT INTO timeline_source_allocations(source_id,timeline_id,repo_id,data) VALUES (?,?,?,?)",
        )
        .run(
          "work",
          "timeline",
          "repo",
          JSON.stringify(
            sqlite.prepare("SELECT * FROM timeline_work_sources WHERE source_id='work'").get(),
          ),
        );
      tracker.getWorkSource.mockImplementation((id: string) => ({
        ok: true,
        value: store.timelines.getWorkSource(id),
      }));
      tracker.transitionWorkSource.mockImplementation(
        (
          id: string,
          version: number,
          state: Parameters<typeof store.timelines.transitionWorkSource>[2],
        ) => ({ ok: true, value: store.timelines.transitionWorkSource(id, version, state) }),
      );
      const state = fakeDurableState({ name: "job" });
      Reflect.set(state.ctx, "container", container);
      const sandbox = new CiSandbox(state.ctx, env);
      const outcome = sandbox.run("job").then(
        () => null,
        (error: unknown) => error,
      );
      const job = () =>
        sqlite
          .prepare(
            "SELECT status,claimed_by,started_at,source_completion_pending,error,exit_code FROM ci_jobs WHERE id='job'",
          )
          .get();
      const roots = () =>
        sqlite
          .prepare("SELECT consumer_id FROM timeline_source_roots WHERE consumer_kind='ci'")
          .all();
      try {
        await Promise.race([
          stopping.promise,
          outcome.then((error) => {
            throw error ?? new Error("Job never reached destruction");
          }),
        ]);
        expect(executions.at(-1)).toEqual(["/bin/bash", "-eo", "pipefail", "-c", "build"]);
        expect(executions.some((command) => command[4] === "later")).toBe(false);
        const dispatches = executions.length;
        expect(running).toBe(true);
        expect(admission.control.activeTickets()).toHaveLength(1);
        expect(await sandbox.cutoverDrainStatus()).toMatchObject({
          running: true,
          containerRunning: true,
          drained: false,
        });
        expect(job()).toMatchObject({
          status: "running",
          claimed_by: "sandbox",
          started_at: expect.any(String),
        });
        const build = sqlite
          .prepare(
            "SELECT status,started_at,finished_at,exit_code FROM ci_steps WHERE job_id='job' AND position=0",
          )
          .get();
        expect(build).toEqual({
          status: "running",
          started_at: expect.any(String),
          finished_at: null,
          exit_code: null,
        });
        expect(sqlite.prepare("SELECT count(*) AS n FROM ci_job_tokens").get()).toEqual({ n: 1 });
        const logs = sqlite.prepare("SELECT seq,step,text FROM ci_logs ORDER BY seq").all();
        expect(logs.some((row) => row.text === "checkout evidence\n")).toBe(true);
        sqlite.exec("UPDATE repos SET deleted_at='2026-10-11' WHERE id='repo'");
        await expect(drainDeletedRepoSources(env, "repo")).rejects.toThrow("CI consumers");
        expect(deleted).toEqual([]);
        stopped.resolve();
        const error = await outcome;
        if (shutdown === "stopped") expect(error).toBe(infrastructureFailure);
        else {
          expect(error).toBeInstanceOf(AggregateError);
          expect((error as AggregateError).errors).toEqual([
            infrastructureFailure,
            shutdownFailure,
          ]);
        }
        expect(admission.control.activeTickets()).toHaveLength(shutdown === "stopped" ? 0 : 1);
        expect(roots()).toEqual([{ consumer_id: "run" }]);
        if (shutdown === "stopped") {
          expect(job()).toEqual({
            status: "queued",
            claimed_by: null,
            started_at: null,
            source_completion_pending: 0,
            error: "earlier failure",
            exit_code: 137,
          });
          expect(sqlite.prepare("SELECT count(*) AS n FROM ci_job_tokens").get()).toEqual({ n: 0 });
        } else {
          expect(job()).toMatchObject({
            status: "running",
            claimed_by: "sandbox",
            started_at: expect.any(String),
          });
          expect(sqlite.prepare("SELECT count(*) AS n FROM ci_job_tokens").get()).toEqual({ n: 1 });
        }
        // Cancel in the Workflow retry delay, without starting another attempt.
        await cancelRun(env, "run");
        expect(
          sqlite.prepare("SELECT position,status FROM ci_steps ORDER BY position").all(),
        ).toEqual([
          { position: 0, status: "running" },
          { position: 1, status: shutdown === "stopped" ? "cancelled" : "pending" },
        ]);
        expect(
          sqlite
            .prepare(
              "SELECT status,started_at,finished_at,exit_code FROM ci_steps WHERE job_id='job' AND position=0",
            )
            .get(),
        ).toEqual(build);
        expect(sqlite.prepare("SELECT seq,step,text FROM ci_logs ORDER BY seq").all()).toEqual(
          logs,
        );
        expect(job()).toMatchObject({ error: "earlier failure", exit_code: 137 });
        if (shutdown === "stopped") {
          expect(running).toBe(false);
          expect(job()).toMatchObject({ status: "cancelled" });
          expect(roots()).toEqual([]);
          await drainDeletedRepoSources(env, "repo");
          expect(deleted).toEqual(["work"]);
          expect(
            sqlite.prepare("SELECT state FROM timeline_work_sources WHERE source_id='work'").get(),
          ).toEqual({ state: "purged" });
          await sandbox.run("job");
          expect(executions).toHaveLength(dispatches);
        } else {
          expect(running).toBe(shutdown === "stop-failed");
          expect(job()).toMatchObject({ status: "running" });
          expect(roots()).toEqual([{ consumer_id: "run" }]);
          await expect(drainDeletedRepoSources(env, "repo")).rejects.toThrow("CI consumers");
          expect(deleted).toEqual([]);
        }
      } finally {
        stopped.resolve();
        await outcome;
        sqlite.close();
        registry.close();
        durable.db.close();
        admission.close();
        state.db.close();
      }
    },
  );
});

describe("Sandbox cutover admission", () => {
  test("a closed fence rejects execution and alarms before business writes", async () => {
    const state = fakeDurableState({ name: "job" });
    const prepare = vi.fn(() => {
      throw new Error("Unexpected business access");
    });
    const put = vi.spyOn(state.ctx.storage, "put");
    const env = { DB: { prepare } } as unknown as Env;
    const admission = installCutoverTestControl(env);
    dispose.push(admission.close, () => state.db.close());
    const sandbox = new CiSandbox(state.ctx, env);
    await admission.fence();
    await expect(sandbox.run("job")).rejects.toThrow("space_cutover_fenced");
    await sandbox.alarm();
    expect(await state.ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
    await expect(sandbox.retire("test", "job")).rejects.toThrow("space_cutover_fenced");
    await expect(sandbox.purge("test")).rejects.toThrow("space_cutover_fenced");
    expect(prepare).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(admission.control.activeTickets()).toEqual([]);
  });

  test("untracked pre-preparation processes remain blocked without destructive stop", async () => {
    const env = {} as Env;
    const admission = installCutoverTestControl(env);
    const destroy = vi.fn();
    const state = fakeDurableState({ name: "job" });
    Reflect.set(state.ctx, "container", { running: true, destroy });
    dispose.push(admission.close, () => state.db.close());
    const sandbox = new CiSandbox(state.ctx, env);
    await expect(sandbox.run("job")).rejects.toThrow("Untracked sandbox execution");
    expect(await sandbox.cutoverDrainStatus()).toMatchObject({
      ticket: null,
      containerRunning: true,
      drained: false,
    });
    expect(destroy).not.toHaveBeenCalled();
  });

  test("a stopped orphan is sealed under the exact fence before its ticket can close", async () => {
    const env = {} as Env;
    const admission = installCutoverTestControl(env);
    let running = true;
    const destroy = vi.fn();
    const state = fakeDurableState({ name: "job" });
    Reflect.set(state.ctx, "container", {
      get running() {
        return running;
      },
      destroy,
    });
    dispose.push(admission.close, () => state.db.close());
    const lease = admission.control.acquire("ci-sandbox", 3, {
      kind: "ci-sandbox",
      instanceId: state.ctx.id.toString(),
    });
    await state.ctx.storage.put("space-cutover-execution", { ...lease, jobId: "job" });
    const sandbox = new CiSandbox(state.ctx, env);
    const { runId } = await admission.fence();
    await expect(
      sandbox.cutoverReconcile("different-run", lease.ticket, lease.epoch),
    ).rejects.toThrow("exact fenced cutover");
    expect(await sandbox.cutoverReconcile(runId, lease.ticket, lease.epoch)).toBe(false);
    expect(admission.control.activeTickets()).toHaveLength(1);
    expect(destroy).not.toHaveBeenCalled();
    running = false; // The provider, not Workflow status, now confirms shutdown.
    expect(await sandbox.cutoverReconcile(runId, lease.ticket, lease.epoch)).toBe(true);
    admission.control.release(lease.ticket);
    const evicted = new CiSandbox(state.ctx, env);
    await expect(evicted.run("job")).rejects.toThrow("sealed by cutover");
    expect(admission.control.activeTickets()).toEqual([]);
    expect(destroy).not.toHaveBeenCalled();
  });
});
