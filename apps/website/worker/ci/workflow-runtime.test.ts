import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { CiRun } from "./workflow.ts";
import { KnowledgeBuild } from "../knowledge/build.ts";
import { RepoPurge } from "../retention/repo-purge.ts";
import { CiSandbox } from "./sandbox.ts";
import { fakeDurableState } from "../testing/durable-state.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import {
  dispatchCutoverWorkflowRuntime,
  type CutoverWorkflowBinding,
  type WorkflowRuntimeProbe,
} from "../durable/cutover-workflow-runtime.ts";

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
});
const implementations = { CI_RUN: CiRun, KNOWLEDGE_BUILD: KnowledgeBuild, REPO_PURGE: RepoPurge };
const bindings = ["CI_RUN", "KNOWLEDGE_BUILD", "REPO_PURGE"] as const;

async function fixture(
  mode: "execute" | "lost-response" | "failed" | "queued" = "execute",
  launchedSandbox = false,
) {
  const business = vi.fn(() => {
    throw new Error("Runtime probe touched business storage");
  });
  const ai = vi.fn(() => {
    throw new Error("Runtime probe invoked AI");
  });
  const env = { DB: { prepare: business }, AI: { run: ai } } as unknown as Env;
  const admission = installCutoverTestControl(env);
  dispose.push(admission.close);
  if (launchedSandbox)
    admission.control.acquire("ci-sandbox", 3, {
      kind: "ci-sandbox",
      instanceId: "still-running",
    });
  const run = await admission.fence();
  // Reconciliation is a prerequisite of this isolated producer test, not its subject.
  // No runtime acknowledgements or probe rows are synthesized by the fixture.
  admission.state.ctx.storage.sql.exec(
    "UPDATE control SET value=? WHERE id=1",
    JSON.stringify({
      ...admission.control.status(),
      phase: "reconciled",
      stores: Object.fromEntries(
        [
          "application",
          "registry",
          ...run.manifest.mapping.map((mapping) => `tracker:${mapping.space.id}`),
        ].map((id) => [id, { exported: true, migrated: true, reconciled: true, restored: false }]),
      ),
    }),
  );
  admission.control.approveRelease(
    run.runId,
    run.checkpoint,
    run.preparationVersionId,
    "space",
    "human",
  );
  const statuses = new Map<string, string>();
  const creates: { binding: CutoverWorkflowBinding; id: string; params: WorkflowRuntimeProbe }[] =
    [];
  const execute = async (
    binding: CutoverWorkflowBinding,
    id: string,
    params: WorkflowRuntimeProbe,
    executingEnv = env,
  ) => {
    statuses.set(id, "running");
    const event = {
      instanceId: id,
      payload: params,
      timestamp: new Date(),
    } as WorkflowEvent<WorkflowRuntimeProbe>;
    const step = {
      do: async (_name: string, callback: () => Promise<unknown>) => callback(),
    } as unknown as WorkflowStep;
    try {
      await new implementations[binding]({} as ExecutionContext, executingEnv).run(event, step);
      statuses.set(id, "complete");
    } catch (error) {
      statuses.set(id, "errored");
      throw error;
    }
  };
  for (const binding of bindings) {
    Reflect.set(env, binding, {
      async get(id: string) {
        if (!statuses.has(id)) throw new Error("Provider instance not found");
        return { status: async () => ({ status: statuses.get(id) }) };
      },
      async create({ id, params }: { id: string; params: WorkflowRuntimeProbe }) {
        if (statuses.has(id)) throw new Error("Provider instance already exists");
        creates.push({ binding, id, params });
        statuses.set(id, mode === "failed" ? "errored" : "queued");
        if (mode === "queued" || mode === "failed") return;
        await execute(binding, id, params);
        if (mode === "lost-response") throw new Error("Provider create response lost");
      },
    });
  }
  return { env, admission, run, statuses, creates, execute, business, ai };
}

describe("Executing cutover maintenance runtimes", () => {
  test.each(["execute", "lost-response"] as const)(
    "%s records all three actual runtime4 producers without business work or duplicate launch",
    async (mode) => {
      const f = await fixture(mode);
      const first = await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
      expect(first.map((row) => row.status)).toEqual([
        "acknowledged",
        "acknowledged",
        "acknowledged",
      ]);
      expect(f.creates).toHaveLength(3);
      for (const consumer of ["ci-workflow", "knowledge-build", "repo-purge"])
        expect(f.admission.control.status()?.runtimeConsumers[consumer]).toMatchObject({
          contractVersion: 4,
          checkpoint: f.env.CUTOVER_DEPLOYMENT_CHECKPOINT,
          versionId: f.env.CI_VERSION.id,
        });
      await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
      expect(f.creates).toHaveLength(3);
      expect(f.admission.control.activeTickets()).toEqual([]);
      expect(f.business).not.toHaveBeenCalled();
      expect(f.ai).not.toHaveBeenCalled();
    },
  );

  test("a journaled reservation resumes after interruption without creating a new identity", async () => {
    const f = await fixture();
    const reserved = await f.admission.control.reserveWorkflowRuntimeProbe(
      f.run.runId,
      "CI_RUN",
      f.env.CI_VERSION.id,
      f.env.CUTOVER_DEPLOYMENT_CHECKPOINT,
    );
    expect(f.creates).toEqual([]);
    await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    expect(f.creates.find((row) => row.binding === "CI_RUN")?.id).toBe(reserved.instanceId);
    expect(f.business).not.toHaveBeenCalled();
  });

  test("queued and paused probes remain pending until their real Workflow code executes", async () => {
    const f = await fixture("queued");
    const first = await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    expect(first.every((row) => row.status === "pending")).toBe(true);
    expect(f.admission.control.status()?.runtimeConsumers).toEqual({});
    for (const created of f.creates) f.statuses.set(created.id, "paused");
    const paused = await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    expect(paused.every((row) => row.status === "pending")).toBe(true);
    expect(f.creates).toHaveLength(3);
    for (const created of f.creates) await f.execute(created.binding, created.id, created.params);
    const final = await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    expect(final.every((row) => row.status === "acknowledged")).toBe(true);
  });

  test("provider-confirmed failed probes retry only within the persisted attempt bound", async () => {
    const f = await fixture("failed");
    for (let pass = 0; pass < 4; pass++) await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    const final = await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    expect(final.every((row) => row.status === "blocked")).toBe(true);
    for (const binding of bindings)
      expect(f.creates.filter((row) => row.binding === binding)).toHaveLength(3);
    expect(f.admission.control.status()?.runtimeConsumers).toEqual({});
    expect(f.business).not.toHaveBeenCalled();
  });

  test("a fresh approval cannot reuse a previous same-version runtime receipt", async () => {
    const f = await fixture();
    await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    const old = [...f.creates];
    f.admission.control.approveRelease(
      f.run.runId,
      f.run.checkpoint,
      f.run.preparationVersionId,
      "space",
      "human",
    );
    expect(f.admission.control.status()?.runtimeConsumers).toEqual({});
    await expect(f.execute(old[0]!.binding, old[0]!.id, old[0]!.params)).rejects.toThrow();
    await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    expect(f.creates).toHaveLength(6);
    expect(new Set(f.creates.map((row) => row.id)).size).toBe(6);
  });

  test("unreserved provider identity and a differently deployed producer cannot acknowledge", async () => {
    const f = await fixture("queued");
    await expect(
      f.execute("CI_RUN", "unreserved", { cutoverRuntime: { runId: f.run.runId } }),
    ).rejects.toThrow();
    await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    const created = f.creates[0]!;
    const wrongEnv = { ...f.env, CI_VERSION: { ...f.env.CI_VERSION, id: "another-deployment" } };
    await expect(
      f.execute(created.binding, created.id, created.params, wrongEnv),
    ).rejects.toThrow();
    expect(f.admission.control.status()?.runtimeConsumers).toEqual({});
    expect(f.business).not.toHaveBeenCalled();
    expect(f.ai).not.toHaveBeenCalled();
  });

  test("CiSandbox attests its executing runtime without a container or business admission", async () => {
    const f = await fixture();
    const state = fakeDurableState({ name: "runtime-probe" });
    dispose.push(() => state.db.close());
    const put = vi.spyOn(state.ctx.storage, "put");
    const sandbox = new CiSandbox(state.ctx, f.env);
    expect(await sandbox.cutoverRuntime(f.run.runId)).toMatchObject({
      consumer: "ci-sandbox",
      contractVersion: 4,
      versionId: f.env.CI_VERSION.id,
      checkpoint: f.env.CUTOVER_DEPLOYMENT_CHECKPOINT,
    });
    expect(f.admission.control.status()?.runtimeConsumers["ci-sandbox"]?.contractVersion).toBe(4);
    expect(f.admission.control.activeTickets()).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    expect(f.business).not.toHaveBeenCalled();
  });

  test("runtime acknowledgement does not drain a launched Sandbox ticket", async () => {
    const f = await fixture("execute", true);
    const before = f.admission.control.activeTickets();
    expect(before).toHaveLength(1);
    await dispatchCutoverWorkflowRuntime(f.env, f.run.runId);
    expect(f.admission.control.activeTickets()).toEqual(before);
  });
});
