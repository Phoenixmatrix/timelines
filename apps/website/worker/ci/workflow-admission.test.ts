import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { withWorkflowCutoverAdmission } from "../durable/cutover-admission.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import { CiRun } from "./workflow.ts";
import { KnowledgeBuild, type BuildParams } from "../knowledge/build.ts";
import { RepoPurge, type RepoPurgeParams } from "../retention/repo-purge.ts";
import type { RunParams } from "./trigger.ts";
import { resolveRunAuthority, WorkAuthorizationError } from "./admission.ts";
import type * as Admission from "./admission.ts";
import type * as Jobs from "./jobs.ts";
import { settleStoppedJob } from "./jobs.ts";
import { DatabaseSync } from "node:sqlite";
import { sandbox } from "./sandbox.ts";
import { d1, migratedDatabase, migratedRegistryDatabase } from "../testing/d1.ts";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";

vi.mock("./admission.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Admission>()),
  resolveRunAuthority: vi.fn(),
}));
vi.mock("./jobs.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Jobs>()),
  settleStoppedJob: vi.fn(),
}));
vi.mock("./sandbox.ts", () => ({ sandbox: vi.fn() }));

vi.mock("cloudflare:workers", () => {
  class Base {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  }
  return { DurableObject: Base, WorkflowEntrypoint: Base };
});
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));

const dispose: (() => void)[] = [];
afterEach(() => {
  for (const close of dispose.splice(0)) close();
  vi.resetAllMocks();
});

/** Cached provider steps persist while a fresh run invocation loses JS state. */
function durableSteps() {
  const cache = new Map<string, unknown>();
  let evicted = false;
  const step = {
    async do(name: string, ...args: unknown[]) {
      if (evicted) throw new Error("isolate evicted");
      if (cache.has(name)) return structuredClone(cache.get(name));
      const value = await (args.at(-1) as () => Promise<unknown>)();
      if (evicted) throw new Error("isolate evicted");
      cache.set(name, structuredClone(value));
      return value;
    },
  } as unknown as WorkflowStep;
  return {
    step,
    evict: () => {
      evicted = true;
    },
    resume: () => {
      evicted = false;
    },
  };
}

const event = { instanceId: "provider-workflow-id" };

async function nativeAdmission() {
  const application = migratedDatabase();
  const registry = migratedRegistryDatabase();
  const env = { DB: d1(application), REGISTRY_DB: d1(registry) } as Env;
  const admission = installCutoverTestControl(env);
  dispose.push(
    () => application.close(),
    () => registry.close(),
    admission.close,
  );
  await initializeFreshSpaceInstallation(env);
  return { env, admission };
}

describe("Whole Workflow cutover admission", () => {
  test("eviction reuses one provider-identified ticket and completed replay cannot write", async () => {
    const { env, admission } = await nativeAdmission();
    const steps = durableSteps();
    const writes: string[] = [];
    await expect(
      withWorkflowCutoverAdmission(env, "ci-workflow", event, steps.step, "CI_RUN", async () => {
        await steps.step.do("business", async () => {
          writes.push("committed");
        });
        steps.evict();
        throw new Error("isolate evicted");
      }),
    ).rejects.toThrow("isolate evicted");
    const [ticket] = admission.control.activeTickets();
    expect(ticket?.source).toEqual({
      kind: "workflow",
      binding: "CI_RUN",
      instanceId: event.instanceId,
    });
    const control = env.SPACE_CUTOVER;
    Reflect.deleteProperty(env, "SPACE_CUTOVER");
    await expect(
      withWorkflowCutoverAdmission(env, "ci-workflow", event, steps.step, "CI_RUN", async () => {
        writes.push("unauthorized replay");
      }),
    ).rejects.toThrow("Missing independent Space cutover control binding");
    expect(admission.control.activeTickets().map((entry) => entry.ticket)).toEqual([
      ticket!.ticket,
    ]);
    Reflect.set(env, "SPACE_CUTOVER", control);
    steps.resume();
    await withWorkflowCutoverAdmission(
      env,
      "ci-workflow",
      event,
      steps.step,
      "CI_RUN",
      async () => {
        expect(admission.control.activeTickets().map((entry) => entry.ticket)).toEqual([
          ticket!.ticket,
        ]);
        await steps.step.do("business", async () => {
          writes.push("duplicate");
        });
        writes.push("final callback");
      },
    );
    expect(writes).toEqual(["committed", "final callback"]);
    expect(admission.control.activeTickets()).toEqual([]);
    await expect(
      withWorkflowCutoverAdmission(env, "ci-workflow", event, steps.step, "CI_RUN", async () => {
        writes.push("late replay");
      }),
    ).rejects.toThrow("space_cutover_ticket_mismatch");
    expect(writes).toEqual(["committed", "final callback"]);
  });

  test("failure/finally and recursively launched waitUntil writes settle before release", async () => {
    const { env, admission } = await nativeAdmission();
    const steps = durableSteps();
    const final = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    const writes: string[] = [];
    const execution = withWorkflowCutoverAdmission(
      env,
      "repo-purge",
      event,
      steps.step,
      "REPO_PURGE",
      async (waitUntil) => {
        try {
          writes.push("before step");
          await steps.step.do("mutation", async () => {
            writes.push("step");
          });
          throw new Error("business failed");
        } finally {
          writes.push("finally");
          waitUntil(
            final.promise.then(() => {
              expect(admission.control.activeTickets()).toHaveLength(1);
              writes.push("background");
              waitUntil(
                Promise.resolve().then(() => {
                  expect(admission.control.activeTickets()).toHaveLength(1);
                  writes.push("nested background");
                }),
              );
            }),
          );
          queued.resolve();
        }
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        queued.promise,
        execution.then((error) => {
          throw error ?? new Error("Workflow completed before queuing background work");
        }),
      ]);
      Reflect.deleteProperty(env, "SPACE_CUTOVER");
      expect(admission.control.activeTickets()).toHaveLength(1);
      expect(writes).toEqual(["before step", "step", "finally"]);
    } finally {
      final.resolve();
    }
    expect(await execution).toEqual(new Error("business failed"));
    expect(writes).toEqual(["before step", "step", "finally", "background", "nested background"]);
    expect(admission.control.activeTickets()).toEqual([]);
  });

  test.each(["queued", "running", "paused", "waiting", "waitingForPause", "sleeping", "unknown"])(
    "%s provider status cannot close an orphan ticket",
    async (status) => {
      const get = vi.fn(async () => ({ status: async () => ({ status }) }));
      const env = { CI_RUN: { get } } as unknown as Env;
      const admission = installCutoverTestControl(env);
      dispose.push(admission.close);
      const lease = admission.control.acquire("ci-workflow", 3, {
        kind: "workflow",
        binding: "CI_RUN",
        instanceId: event.instanceId,
      });
      await admission.fence();
      await admission.control.reconcileWorkflowTickets();
      expect(get).toHaveBeenCalledWith(event.instanceId);
      expect(admission.control.activeTickets().map((entry) => entry.ticket)).toEqual([
        lease.ticket,
      ]);
    },
  );

  test.each(["complete", "errored", "terminated"])(
    "authoritative %s provider status closes only the Workflow ticket",
    async (status) => {
      const get = vi.fn(async () => ({ status: async () => ({ status }) }));
      const env = { CI_RUN: { get } } as unknown as Env;
      const admission = installCutoverTestControl(env);
      dispose.push(admission.close);
      admission.control.acquire("ci-workflow", 3, {
        kind: "workflow",
        binding: "CI_RUN",
        instanceId: event.instanceId,
      });
      const sandbox = admission.control.acquire("ci-sandbox", 3, {
        kind: "ci-sandbox",
        instanceId: "provider-sandbox-id",
      });
      await admission.fence();
      await admission.control.reconcileWorkflowTickets();
      expect(get).toHaveBeenCalledWith(event.instanceId);
      expect(admission.control.activeTickets().map((entry) => entry.ticket)).toEqual([
        sandbox.ticket,
      ]);
    },
  );

  test("missing provider status is not proof of termination", async () => {
    const env = {} as Env;
    const admission = installCutoverTestControl(env);
    dispose.push(admission.close);
    admission.control.acquire("knowledge-build", 3, {
      kind: "workflow",
      binding: "KNOWLEDGE_BUILD",
      instanceId: event.instanceId,
    });
    await admission.fence();
    await expect(admission.control.reconcileWorkflowTickets()).rejects.toThrow(
      "binding unavailable",
    );
    expect(admission.control.activeTickets()).toHaveLength(1);
  });

  test.each(["closed", "missing"])(
    "all Workflow entrypoints fail before business access with %s control",
    async (mode) => {
      const prepare = vi.fn(() => {
        throw new Error("Unexpected business access");
      });
      const env = { DB: { prepare } } as unknown as Env;
      if (mode === "closed") {
        const admission = installCutoverTestControl(env);
        dispose.push(admission.close);
        await admission.fence();
      }
      const waitUntil = vi.fn();
      const ctx = { waitUntil } as unknown as ExecutionContext;
      const error =
        mode === "closed" ? "space_cutover_fenced" : "Missing independent Space cutover";
      await expect(
        new CiRun(ctx, env).run(
          { ...event, payload: { runId: "run" } } as WorkflowEvent<RunParams>,
          durableSteps().step,
        ),
      ).rejects.toThrow(error);
      await expect(
        new KnowledgeBuild(ctx, env).run(
          { ...event, payload: { repoId: "repo", buildId: "build" } } as WorkflowEvent<BuildParams>,
          durableSteps().step,
        ),
      ).rejects.toThrow(error);
      await expect(
        new RepoPurge(ctx, env).run(
          { ...event, payload: { repoId: "repo" } } as WorkflowEvent<RepoPurgeParams>,
          durableSteps().step,
        ),
      ).rejects.toThrow(error);
      expect(prepare).not.toHaveBeenCalled();
      expect(waitUntil).not.toHaveBeenCalled();
    },
  );
});

describe("CI current Space authority", () => {
  async function fixture(cached: Record<string, unknown> = {}) {
    const prepare = vi.fn(() => {
      throw new Error("Unauthorized business access");
    });
    const application = migratedDatabase();
    const registry = migratedRegistryDatabase();
    dispose.push(
      () => application.close(),
      () => registry.close(),
    );
    const env = { DB: d1(application), REGISTRY_DB: d1(registry) } as Env;
    const admission = installCutoverTestControl(env);
    dispose.push(admission.close);
    await initializeFreshSpaceInstallation(env);
    Reflect.set(env, "DB", { prepare });
    const callbacks: string[] = [];
    const step = {
      async do(name: string, ...args: unknown[]) {
        if (Object.hasOwn(cached, name)) return structuredClone(cached[name]);
        // Keep real cutover ticket acquisition/completion uncached.
        callbacks.push(name);
        try {
          return await (args.at(-1) as () => Promise<unknown>)();
        } catch (error) {
          // Provider step failures cross a serialization boundary.
          throw structuredClone(error);
        }
      },
    } as unknown as WorkflowStep;
    const workflow = new CiRun({} as ExecutionContext, env);
    const run = () =>
      workflow.run(
        { ...event, payload: { runId: "run" }, timestamp: new Date() } as WorkflowEvent<RunParams>,
        step,
      );
    return { env, admission, prepare, callbacks, run };
  }

  test("cached provider steps cannot preserve revoked consumption authority", async () => {
    const f = await fixture({ "quiet period": null, plan: [], finish: "succeeded" });
    vi.mocked(resolveRunAuthority).mockRejectedValue(new Error("credential revoked"));
    await expect(f.run()).rejects.toThrow("credential revoked");
    expect(resolveRunAuthority).toHaveBeenCalledWith(f.env, "run");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.callbacks).not.toContain("step-artifacts");
  });

  test.each(["plan", "finish", "step-artifacts", "release", "landing", "merge-queue"])(
    "%s rechecks current authority inside its uncached callback",
    async (publication) => {
      const cached: Record<string, unknown> = {
        "quiet period": null,
        plan: [],
        finish: "succeeded",
        "step-artifacts": null,
        release: null,
        landing: null,
        "merge-queue": null,
      };
      delete cached[publication];
      const f = await fixture(cached);
      vi.mocked(resolveRunAuthority)
        .mockResolvedValueOnce(undefined as never)
        .mockRejectedValue(new Error("Space grant revoked"));
      await expect(f.run()).rejects.toThrow("Space grant revoked");
      expect(f.callbacks).toContain(publication);
      expect(f.prepare).not.toHaveBeenCalled();
    },
  );

  test.each(["local", "sandbox"] as const)(
    "%s dispatch cannot reuse authority from a cached queued start",
    async (runner) => {
      const f = await fixture({
        "quiet period": null,
        plan: [
          {
            id: "job",
            name: "job",
            runner,
            status: "pending",
            needs: [],
            timeoutMinutes: 1,
            concurrency: null,
            unchanged: false,
            verification: false,
          },
        ],
        "start:job": "queued",
        "fail:job": null,
      });
      vi.mocked(resolveRunAuthority)
        .mockResolvedValueOnce(undefined as never)
        .mockRejectedValue(new Error("migration epoch changed"));
      await expect(f.run()).rejects.toThrow("migration epoch changed");
      expect(f.callbacks).toContain(runner === "local" ? "dispatch:job" : "run:job");
      expect(sandbox).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.callbacks).not.toContain("finish");
    },
  );

  test("a denied parallel dispatch waits for an already launched Sandbox to settle", async () => {
    const launched = Promise.withResolvers<void>();
    const stopped = Promise.withResolvers<void>();
    const denied = Promise.withResolvers<void>();
    const job = (name: string, runner: "sandbox" | "local") => ({
      id: name,
      name,
      runner,
      status: "pending",
      needs: [],
      timeoutMinutes: 1,
      concurrency: null,
      unchanged: false,
      verification: false,
    });
    const f = await fixture({
      "quiet period": null,
      plan: [job("running", "sandbox"), job("revoked", "local")],
      "start:running": "queued",
      "start:revoked": "queued",
      "result:running": "succeeded",
    });
    vi.mocked(resolveRunAuthority)
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce(undefined as never)
      .mockImplementationOnce(async () => {
        await launched.promise;
        denied.resolve();
        throw new Error("agent revoked");
      });
    vi.mocked(sandbox, { partial: true }).mockReturnValue({
      run: async () => {
        launched.resolve();
        await stopped.promise;
      },
    });
    let settled = false;
    const execution = f.run().then(
      () => null,
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await denied.promise;
    expect(settled).toBe(false);
    expect(f.admission.control.activeTickets()).toHaveLength(1);
    stopped.resolve();
    expect(await execution).toEqual(new Error("agent revoked"));
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.callbacks).not.toContain("finish");
  });

  test.each([
    { runner: "sandbox", pending: 1, drained: true, ticket: null, cancelled: true },
    { runner: "sandbox", pending: 1, drained: false, ticket: "native-ticket", cancelled: false },
    { runner: "sandbox", pending: 0, drained: true, ticket: "native-ticket", cancelled: false },
    { runner: "local", pending: 1, drained: true, ticket: null, cancelled: false },
    { runner: "local", pending: 0, drained: true, ticket: null, cancelled: true },
  ])(
    "revoked $runner settlement preserves unresolved execution ($pending/$ticket)",
    async (state) => {
      const f = await fixture({ "quiet period": null, plan: [] });
      const storage = new DatabaseSync(":memory:");
      dispose.push(() => storage.close());
      storage.exec(`
      CREATE TABLE ci_runs (
        id TEXT PRIMARY KEY, authority TEXT, space_id TEXT, migration_epoch INTEGER,
        actor_id TEXT, agent_id TEXT, status TEXT, finished_at TEXT
      );
      CREATE TABLE ci_jobs (
        id TEXT PRIMARY KEY, run_id TEXT, runner TEXT, status TEXT,
        started_at TEXT, source_completion_pending INTEGER
      );
    `);
      const authority = {
        spaceId: "space",
        migrationEpoch: 0,
        personId: "person",
        agentId: null,
        credential: { kind: "token", id: "credential" },
      };
      storage
        .prepare("INSERT INTO ci_runs VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
        .run("run", JSON.stringify(authority), "space", 0, "person", null, "running");
      storage
        .prepare("INSERT INTO ci_jobs VALUES (?, ?, ?, ?, ?, ?)")
        .run("job", "run", state.runner, "cancelled", "2026-10-11T00:00:00Z", state.pending);
      Reflect.set(f.env, "DB", d1(storage));
      vi.mocked(sandbox, { partial: true }).mockReturnValue({
        cutoverDrainStatus: vi
          .fn<ReturnType<typeof sandbox>["cutoverDrainStatus"]>()
          .mockResolvedValue({
            jobId: "job",
            epoch: 0,
            ticket: state.ticket,
            running: !state.drained,
            containerRunning: !state.drained,
            drained: state.drained,
            [Symbol.dispose]() {},
          }),
      });
      const denial = new WorkAuthorizationError("agent revoked");
      vi.mocked(resolveRunAuthority)
        .mockResolvedValueOnce(undefined as never)
        .mockRejectedValue(denial);
      await expect(f.run()).rejects.toThrow();
      expect(storage.prepare("SELECT status FROM ci_runs WHERE id='run'").get()?.status).toBe(
        state.cancelled ? "cancelled" : "running",
      );
      expect(settleStoppedJob).toHaveBeenCalledTimes(state.cancelled ? 1 : 0);
      expect(f.callbacks).not.toContain("step-artifacts");
      expect(f.callbacks).not.toContain("landing");
    },
  );
});
