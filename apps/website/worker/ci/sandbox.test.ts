import { describe, expect, test, vi } from "vite-plus/test";
import type * as Artifacts from "../artifacts.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { durableStorage } from "../testing/durable.ts";
import { TrackerStore } from "../tracker/store.ts";
import { drainDeletedRepoSources } from "../retention/work-sources.ts";
import { cancelRun } from "./cancel.ts";
import { CiSandbox } from "./sandbox.ts";

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
  ...(await original<typeof Artifacts>()),
  upstreamToken: async () => "sandbox-fixture-read-token",
}));
const tracker = vi.hoisted(() => ({
  getWorkSource: vi.fn(),
  transitionWorkSource: vi.fn(),
}));
vi.mock("../tracker/stub.ts", () => ({ trackerObject: () => tracker }));

describe("Sandbox infrastructure retry cancellation", () => {
  test.each(["stopped", "stop-failed"])(
    "%s preserves evidence and releases source purge only after confirmed shutdown",
    async (shutdown) => {
      const sqlite = migratedDatabase();
      const durable = durableStorage();
      const store = new TrackerStore(durable.sql, durable.transactionSync);
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
        },
      } as unknown as Container;
      const deleted: string[] = [];
      const env = {
        DB: d1(sqlite),
        PUBLIC_URL: "https://gitmatrix.example",
        ARTIFACTS: {
          delete: async (name: string) => {
            deleted.push(name);
          },
        },
      } as unknown as Env;
      sqlite.exec(`
        INSERT INTO accounts(id,kind,slug,display_name) VALUES ('org','org','orbit','Orbit');
        INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote)
          VALUES ('repo','org','app','private','app','https://app');
        INSERT INTO timeline_work_sources
          (source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,
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
      const sandbox = new CiSandbox({ container } as unknown as DurableObjectState, env);
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
        expect(await outcome).toBe(
          shutdown === "stopped" ? infrastructureFailure : shutdownFailure,
        );
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
          expect(running).toBe(true);
          expect(job()).toMatchObject({ status: "running" });
          expect(roots()).toEqual([{ consumer_id: "run" }]);
          await expect(drainDeletedRepoSources(env, "repo")).rejects.toThrow("CI consumers");
          expect(deleted).toEqual([]);
        }
      } finally {
        stopped.resolve();
        await outcome;
        sqlite.close();
        durable.db.close();
      }
    },
  );
});
