// Preview runs (CORE-79) through startRun, over a fake repository reader that
// serves one ci.yml at every commit, and the variables their jobs get.

import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { d1 } from "../testing/d1.ts";
import { freshInstallationDatabases, seedSpaceFixture } from "../testing/spaces.ts";
import { withoutWaiting } from "../testing/timers.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";
import type { DatabaseSync } from "node:sqlite";
import { jobPayload, loadJob } from "./jobs.ts";
import { recordStepRun } from "../steps/runs.ts";
import { timelineQuietMs } from "../timelines/quiet.ts";
import { captureWorkAuthority } from "./admission.ts";
import { onPush, releaseQuiet, startRun, startWorkflow } from "./trigger.ts";

const files = vi.hoisted(() => ({ ciYml: "", failReads: 0 }));
const refs = vi.hoisted(() => ({
  branches: [] as { shortName: string; oid: string }[],
  headBranch: "main",
}));
vi.mock("../artifacts.ts", () => ({ listRefs: async () => refs }));
vi.mock("../objects.ts", () => ({
  RepoReader: class {
    async commit(oid: string) {
      return { message: `Commit ${oid}\n`, treeHash: `tree-${oid}` };
    }
    async entryAt(_tree: string, path: string) {
      return path === ".gitmatrix/ci.yml" ? { type: "blob", hash: "ci" } : null;
    }
    async blob() {
      if (files.failReads > 0) {
        files.failReads--;
        throw new Error("Peer closed WebSocket: 1006");
      }
      return { bytes: new TextEncoder().encode(files.ciYml) };
    }
    async close() {}
  },
}));

const oid = (n: number) => n.toString(16).padStart(40, "0");

const OPTED_IN = `
on:
  preview: {}
jobs:
  test:
    steps: [vp test]
  preview:
    if: trigger == "preview" && action == "create"
    steps: [./deploy-preview.sh]
  preview-teardown:
    if: trigger == "preview" && action == "teardown"
    steps: [./teardown.sh]
`;

const closeControls: Array<() => void> = [];
afterEach(() => {
  for (const close of closeControls.splice(0)) close();
});
const initiatingActor = { id: "ann", credential: { kind: "token" as const, id: "ann-token" } };

async function setup() {
  const fresh = await freshInstallationDatabases();
  const { sqlite, registry } = fresh;
  closeControls.push(() => registry.close());
  const created: string[] = [];
  const env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registry),
    CI_RUNNER: "sandbox",
    CI_RUN: { create: async ({ id }: { id: string }) => void created.push(id) },
  } as unknown as Env;
  closeControls.push(installCutoverTestControl(env, fresh.control).close);
  await initializeFreshSpaceInstallation(env);
  sqlite.exec(`INSERT INTO accounts (id,kind,slug,display_name) VALUES ('ann','user','ann','Ann')`);
  await seedSpaceFixture(env.DB, {
    organization: { id: "company", slug: "company", displayName: "Orbit", kind: "company" },
    space: { id: "org", slug: "orbit", displayName: "Orbit" },
    actorId: "ann",
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sqlite.exec(`
    INSERT INTO repos (id,space_id,name,visibility,artifacts_name,artifacts_remote)
      VALUES ('repo','org','app','private','a','https://a');
    INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four)
      VALUES ('ann-token','ann','CI initiator','write','ci-ann-hash','hash');
  `);
  const repo = { id: "repo", artifacts_name: "a", artifacts_remote: "https://a" };
  const start = (options: Partial<Parameters<typeof startRun>[2]> = {}) =>
    startRun(env, repo, {
      branch: "timeline/search",
      commit: oid(9),
      trigger: "preview",
      preview: { action: "create", timeline: "search", checkpoint: "cp_1" },
      actor: initiatingActor,
      waitUntil: () => {},
      ...options,
    });
  const jobs = (runId: string) =>
    sqlite
      .prepare("SELECT id, name, status FROM ci_jobs WHERE run_id = ? ORDER BY name")
      .all(runId) as { id: string; name: string; status: string }[];
  return { sqlite, env, repo, start, jobs, created };
}

beforeEach(() => {
  files.ciYml = OPTED_IN;
});

describe("CI initiating authority", () => {
  test("a captured run cannot start after its credential is revoked", async () => {
    const t = await setup();
    const authority = await captureWorkAuthority(t.env, "repo", initiatingActor);
    t.sqlite.prepare("DELETE FROM access_tokens WHERE id = ?").run(initiatingActor.credential.id);
    await expect(t.start({ authority })).rejects.toThrow("credential");
    expect(t.created).toEqual([]);
    t.sqlite.close();
  });

  test("an organization owner without a live Space grant cannot enqueue work", async () => {
    const t = await setup();
    t.sqlite.exec("DELETE FROM space_grants");
    await expect(t.start()).rejects.toThrow("authorization");
    expect(t.created).toEqual([]);
    t.sqlite.close();
  });
});

describe("Workflow startup terminalization", () => {
  test("a duplicate landing start joins the existing Workflow without failing its queued gate", async () => {
    const t = await setup();
    files.ciYml = "jobs:\n  gate:\n    steps: [echo gate]\n";
    const failure = new Error("WorkflowError(instance.already_exists)");
    t.env.CI_RUN = {
      async create({ id }: { id: string }) {
        t.sqlite.prepare("UPDATE ci_jobs SET status='queued' WHERE run_id=?").run(id);
        throw failure;
      },
      async get() {
        return { status: async () => ({ status: "running" }) };
      },
    } as unknown as Env["CI_RUN"];
    try {
      const result = await t.start({
        trigger: "landing",
        preview: undefined,
        runId: "landing-run",
      });
      expect(result).toEqual({ runId: "landing-run", number: 1 });
      expect(t.sqlite.prepare("SELECT status,config_error FROM ci_runs").get()).toEqual({
        status: "queued",
        config_error: null,
      });
      expect(t.jobs("landing-run")[0]?.status).toBe("queued");
    } finally {
      t.sqlite.close();
    }
  });

  test("a failed start preserves its error and settles only unstarted jobs", async () => {
    const t = await setup();
    files.ciYml = "jobs:\n  gate:\n    steps: [echo gate]\n";
    const failure = new Error("Workflow unavailable");
    t.env.CI_RUN = {
      create: async () => {
        throw failure;
      },
      get: async () => {
        throw new Error("No instance");
      },
    } as unknown as Env["CI_RUN"];
    try {
      await expect(
        t.start({ trigger: "landing", preview: undefined, runId: "failed-start" }),
      ).rejects.toBe(failure);
      expect(t.sqlite.prepare("SELECT status,config_error FROM ci_runs").get()).toEqual({
        status: "failed",
        config_error: `The run could not be started: ${String(failure)}`,
      });
      expect(t.jobs("failed-start")[0]?.status).toBe("cancelled");
      expect(t.sqlite.prepare("SELECT status FROM ci_steps").get()).toEqual({
        status: "cancelled",
      });
    } finally {
      t.sqlite.close();
    }
  });
});

describe("preview runs", () => {
  test("deletion fences new CI and workflow recovery but permits purge teardown", async () => {
    const t = await setup();
    try {
      const original = await t.start();
      if (!("runId" in original)) throw new Error(original.skipped);
      const authority = await captureWorkAuthority(t.env, "repo", initiatingActor);
      t.created.length = 0;
      t.sqlite.exec("UPDATE repos SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'repo'");
      await startWorkflow(t.env, original.runId);
      expect(t.created).toEqual([]);
      await expect(
        t.start({ commit: oid(10), trigger: "push", preview: undefined }),
      ).rejects.toThrow();
      expect(t.sqlite.prepare("SELECT commit_oid FROM ci_runs ORDER BY number").all()).toEqual([
        { commit_oid: oid(9) },
      ]);
      await expect(
        t.start({
          preview: { action: "teardown", timeline: "search", checkpoint: "cp_1" },
        }),
      ).rejects.toThrow();
      t.sqlite
        .prepare(`INSERT INTO deployments
        (id,repo_id,environment,timeline_slug,checkpoint_id,commit_oid,url,status,authority)
        VALUES(1,'repo','timeline/search','search','cp_1',?,'https://preview','expired',?)`)
        .run(oid(9), JSON.stringify(authority));
      const teardown = await t.start({
        preview: { action: "teardown", timeline: "search", checkpoint: "cp_1", teardownOf: 1 },
      });
      if (!("runId" in teardown)) throw new Error(teardown.skipped);
      expect(t.created).toEqual([teardown.runId]);
      expect(t.jobs(teardown.runId).find((job) => job.status === "pending")?.name).toBe(
        "preview-teardown",
      );
    } finally {
      t.sqlite.close();
    }
  });
  test("a create run records its action, timeline and checkpoint, and runs only its job", async () => {
    const t = await setup();
    const started = await t.start();
    if (!("runId" in started)) throw new Error(started.skipped);
    expect(t.created).toEqual([started.runId]);
    const run = t.sqlite.prepare("SELECT * FROM ci_runs WHERE id = ?").get(started.runId) as Record<
      string,
      unknown
    >;
    expect(run).toMatchObject({
      ref: "timeline/search",
      commit_oid: oid(9),
      // The CHECK predates previews; the action says what it is.
      trigger: "manual",
      preview_action: "create",
      timeline_slug: "search",
      checkpoint_id: "cp_1",
      preview_revived: 0,
      status: "queued",
    });
    expect(t.jobs(started.runId).map((j) => [j.name, j.status])).toEqual([
      ["preview", "pending"],
      ["preview-teardown", "skipped"],
      ["test", "skipped"],
    ]);
    // The same action for the same checkpoint in flight answers for it.
    expect(await t.start()).toEqual(started);
  });

  test("a teardown runs the teardown job; a push of the same commit is a run of its own", async () => {
    const t = await setup();
    const teardown = await t.start({
      preview: { action: "teardown", timeline: "search", checkpoint: "cp_1" },
    });
    if (!("runId" in teardown)) throw new Error(teardown.skipped);
    expect(t.jobs(teardown.runId).find((j) => j.status === "pending")?.name).toBe(
      "preview-teardown",
    );
    const push = await t.start({ trigger: "push", preview: undefined });
    if (!("runId" in push)) throw new Error(push.skipped);
    expect(push.runId).not.toBe(teardown.runId);
    expect(t.jobs(push.runId).map((j) => [j.name, j.status])).toEqual([
      ["preview", "skipped"],
      ["preview-teardown", "skipped"],
      ["test", "pending"],
    ]);
  });

  test("a project that doesn't opt in, or has no job for the action, gets no run", async () => {
    const t = await setup();
    files.ciYml = "jobs:\n  test:\n    steps: [vp test]\n";
    await t.start();
    files.ciYml = "on: preview\njobs:\n  p:\n    if: action == 'create'\n    steps: [x]\n";
    const unmanaged = await t.start({
      preview: { action: "teardown", timeline: "search", checkpoint: null },
    });
    expect(unmanaged).toMatchObject({ teardownUnmanaged: true });
    files.ciYml = "jobs: [";
    await t.start();
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM ci_runs").get()).toEqual({ n: 0 });
  });

  test("jobs get the timeline, checkpoint, commit and action", async () => {
    const t = await setup();
    const started = await t.start({
      preview: {
        action: "create",
        timeline: "search",
        checkpoint: "cp_1",
        revived: true,
        rebuiltFrom: null,
      },
    });
    if (!("runId" in started)) throw new Error(started.skipped);
    const job = await loadJob(
      t.env.DB,
      t.jobs(started.runId).find((j) => j.name === "preview")!.id,
    );
    const payload = await jobPayload(t.env, job!, { origin: "https://gm.test", token: "gmj_x" });
    expect(payload.env).toMatchObject({
      GITMATRIX_TRIGGER: "preview",
      GITMATRIX_TIMELINE: "search",
      GITMATRIX_CHECKPOINT: "cp_1",
      GITMATRIX_COMMIT: oid(9),
      GITMATRIX_PREVIEW_ACTION: "create",
      GITMATRIX_BRANCH: "timeline/search",
    });
    expect(
      t.sqlite.prepare("SELECT preview_revived FROM ci_runs WHERE id = ?").get(started.runId),
    ).toEqual({ preview_revived: 1 });

    // A push to a timeline's bookmark names the timeline, and nothing else.
    const push = await t.start({ trigger: "push", preview: undefined });
    if (!("runId" in push)) throw new Error(push.skipped);
    const pushed = await loadJob(t.env.DB, t.jobs(push.runId).find((j) => j.name === "test")!.id);
    const env = (await jobPayload(t.env, pushed!, { origin: "https://gm.test", token: "x" })).env;
    expect(env).toMatchObject({ GITMATRIX_TRIGGER: "push", GITMATRIX_TIMELINE: "search" });
    expect(env.GITMATRIX_CHECKPOINT).toBeUndefined();
    expect(env.GITMATRIX_PREVIEW_ACTION).toBeUndefined();
  });
});

describe("landing runs", () => {
  test("the gates on a landing's merge are stored as manual with their landing, and say landing", async () => {
    const t = await setup();
    files.ciYml = `
jobs:
  test:
    steps: [vp test]
  gate:
    if: trigger == "landing"
    steps: [./gate.sh]
  deploy:
    if: branch == "main"
    steps: [./deploy.sh]
`;
    const started = await t.start({
      branch: "gitmatrix/landing/search",
      trigger: "landing",
      preview: undefined,
      landingId: "ld_1",
    });
    if (!("runId" in started)) throw new Error(started.skipped);
    expect(
      t.sqlite
        .prepare("SELECT trigger, landing_id, preview_action FROM ci_runs WHERE id = ?")
        .get(started.runId),
    ).toEqual({ trigger: "manual", landing_id: "ld_1", preview_action: null });
    expect(t.jobs(started.runId).map((j) => [j.name, j.status])).toEqual([
      ["deploy", "skipped"],
      ["gate", "pending"],
      ["test", "pending"],
    ]);
    const job = await loadJob(t.env.DB, t.jobs(started.runId).find((j) => j.name === "gate")!.id);
    const payload = await jobPayload(t.env, job!, { origin: "https://gm.test", token: "x" });
    expect(payload.env.GITMATRIX_TRIGGER).toBe("landing");
  });
});

describe("queue gates", () => {
  test("a source staging ref never starts a pipeline, including a manual request", async () => {
    const t = await setup();
    for (const trigger of ["push", "manual"] as const) {
      expect(
        await t.start({
          branch: `gitmatrix/queue/${oid(9)}`,
          trigger,
          preview: undefined,
        }),
      ).toEqual({ skipped: expect.stringContaining("staging only") });
    }
    expect(t.created).toEqual([]);
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM ci_runs").get()).toEqual({ n: 0 });
  });

  test("a queue with no runnable landing gate is not an all-skipped success", async () => {
    const t = await setup();
    files.ciYml = "jobs:\n  deploy:\n    if: trigger == 'push'\n    steps: [deploy]\n";
    expect(
      await t.start({
        branch: `gitmatrix/landing/queue-${oid(9)}-1`,
        trigger: "landing",
        preview: undefined,
        queueId: oid(9),
        runId: "queue-gates",
      }),
    ).toEqual({ skipped: expect.stringContaining("No job") });
    expect(t.created).toEqual([]);
  });

  test("the current queue gate cannot adopt an unrelated manual run of the same object", async () => {
    const t = await setup();
    files.ciYml = "jobs:\n  gate:\n    steps: [check]\n";
    const branch = `gitmatrix/landing/queue-${oid(9)}-1`;
    const manual = await t.start({ branch, trigger: "manual", preview: undefined });
    if (!("runId" in manual)) throw new Error(manual.skipped);
    const gates = await t.start({
      branch,
      trigger: "landing",
      preview: undefined,
      queueId: oid(9),
      runId: "queue-gates",
    });
    expect(gates).toEqual({ runId: "queue-gates", number: 2 });
    expect(t.jobs("queue-gates")).toEqual([
      { id: expect.any(String), name: "gate", status: "pending" },
    ]);
    const job = await loadJob(t.env.DB, t.jobs("queue-gates")[0]!.id);
    const payload = await jobPayload(t.env, job!, { origin: "https://gm.test", token: "x" });
    expect(payload.env.GITMATRIX_TRIGGER).toBe("landing");
    expect(payload.env.GITMATRIX_QUEUE_ID).toBe(oid(9));
    expect(payload.env.GITMATRIX_TIMELINE).toBeUndefined();
  });
});

describe("step runs (CORE-235)", () => {
  const STEPS = `
on:
  push: {}
  step: {}
jobs:
  lint:
    on: step
    local: true
    steps: [vp check]
  unit:
    on: [push, step]
    needs: [lint]
    steps: [vp test run]
  build:
    steps: [vp build]
`;
  const runs = (t: { sqlite: DatabaseSync }) =>
    t.sqlite
      .prepare("SELECT id, ref, trigger, step, commit_oid FROM ci_runs ORDER BY number")
      .all() as { id: string; ref: string; trigger: string; step: number; commit_oid: string }[];

  test("a timeline push starts its push run and a step run of only the step jobs", async () => {
    files.ciYml = STEPS;
    const t = await setup();
    // CI has seen the repository before; main and a timeline move.
    t.sqlite.exec(`INSERT INTO ci_refs (repo_id, ref, oid) VALUES ('repo', 'main', '${oid(1)}')`);
    refs.branches = [
      { shortName: "main", oid: oid(2) },
      { shortName: "timeline/search", oid: oid(3) },
    ];
    await onPush(
      t.env,
      { id: "repo", artifacts_name: "a", artifacts_remote: "https://a" },
      initiatingActor,
      () => {},
    );
    const all = runs(t);
    expect(all.map((r) => [r.ref, r.trigger, r.step])).toEqual([
      ["main", "push", 0],
      ["timeline/search", "push", 0],
      ["timeline/search", "manual", 1],
    ]);
    const step = all[2]!;
    expect(t.jobs(step.id).map((j) => [j.name, j.status])).toEqual([
      ["build", "skipped"],
      ["lint", "pending"],
      ["unit", "pending"],
    ]);
    // The push run keeps its own jobs.
    expect(t.jobs(all[1]!.id).map((j) => [j.name, j.status])).toEqual([
      ["build", "pending"],
      ["lint", "skipped"],
      ["unit", "pending"],
    ]);
    const job = await loadJob(t.env.DB, t.jobs(step.id).find((j) => j.name === "lint")!.id);
    const env = (await jobPayload(t.env, job!, { origin: "https://gm.test", token: "x" })).env;
    expect(env).toMatchObject({ GITMATRIX_TRIGGER: "step", GITMATRIX_TIMELINE: "search" });
    refs.branches = [];
  });

  test("a work source's first push to work starts its runs; the fork's copies of canonical don't", async () => {
    files.ciYml = STEPS;
    const t = await setup();
    t.sqlite.exec(`
      INSERT INTO timeline_work_sources
        (source_id,repo_id,timeline_id,timeline_slug,space_id,artifacts_name,artifacts_remote,
         initial_token_revoked,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,
         fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
      VALUES ('work_search','repo','tl_search','search','org','w','https://w',1,'ready',
        'allocation','canonical','${oid(1)}','${oid(1)}','refs/heads/main',
        'canonical','${oid(1)}','${oid(1)}','refs/heads/main','2026-10-05','2026-10-05');
    `);
    t.sqlite
      .prepare("UPDATE timeline_work_sources SET authority = ? WHERE source_id = ?")
      .run(
        JSON.stringify(await captureWorkAuthority(t.env, "repo", initiatingActor)),
        "work_search",
      );
    // A canonical queue's same branch/OID must not suppress a physical work source.
    t.sqlite
      .prepare(
        "INSERT INTO merge_queue(repo_id,id,status,attempts,candidate,data,created_at,updated_at) VALUES('repo','canonical-queue','landed',1,?,?,'now','now')",
      )
      .run(oid(3), JSON.stringify({ entry: { branch: "work", deployStatus: "queued" } }));
    // CI has never seen this source: a fork copies every canonical branch.
    refs.branches = [
      { shortName: "main", oid: oid(1) },
      { shortName: "timeline/other", oid: oid(4) },
      { shortName: "work", oid: oid(3) },
    ];
    await onPush(
      t.env,
      { id: "repo", source_id: "work_search", artifacts_name: "w", artifacts_remote: "https://w" },
      initiatingActor,
      () => {},
    );
    expect(runs(t).map((r) => [r.ref, r.trigger, r.step, r.commit_oid])).toEqual([
      ["work", "push", 0, oid(3)],
      ["work", "manual", 1, oid(3)],
    ]);
    // Its jobs name the source's timeline, though the ref is just `work` (CORE-296).
    const run = runs(t).find((r) => r.trigger === "push")!;
    const job = await loadJob(t.env.DB, t.jobs(run.id)[0]!.id);
    const payload = await jobPayload(t.env, job!, { origin: "https://gm.test", token: "x" });
    expect(payload.env.GITMATRIX_TIMELINE).toBe("search");
    refs.branches = [];
  });

  test("a push whose run start hits a transient provider error is retried, once (CORE-305)", async () => {
    files.ciYml = STEPS;
    files.failReads = 1;
    const t = await setup();
    refs.branches = [{ shortName: "main", oid: oid(2) }];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The retry's pause (START_RETRY_MS) takes no real second.
    await withoutWaiting(() => onPush(t.env, t.repo, initiatingActor, () => {}));
    expect(runs(t).map((r) => [r.ref, r.trigger, r.step, r.commit_oid])).toEqual([
      ["main", "push", 0, oid(2)],
    ]);
    expect(warn).toHaveBeenCalledWith("CI: starting a run failed; retrying it", expect.anything());
    warn.mockRestore();
    refs.branches = [];
  });

  test("a step run neither answers for nor is answered by the push run of its commit", async () => {
    files.ciYml = STEPS;
    const t = await setup();
    const push = await t.start({ trigger: "push", preview: undefined });
    const step = await t.start({ trigger: "step", preview: undefined });
    if (!("runId" in push) || !("runId" in step)) throw new Error("both should start");
    expect(step.runId).not.toBe(push.runId);
    // A second step run of the same commit while one is in flight is the same run.
    const again = await t.start({ trigger: "step", preview: undefined });
    expect("runId" in again && again.runId).toBe(step.runId);
  });

  test("repositories that don't opt in get no step run", async () => {
    const t = await setup();
    expect(await t.start({ trigger: "step", preview: undefined })).toEqual({
      skipped: `.gitmatrix/ci.yml at ${oid(9).slice(0, 12)} doesn't opt in to step runs (on: step).`,
    });
    files.ciYml = "on: step\njobs:\n  a:\n    steps: [x]";
    expect(await t.start({ trigger: "step", preview: undefined })).toEqual({
      skipped: "No job in .gitmatrix/ci.yml runs on step.",
    });
  });

  test("a finished step run leaves a test summary on its step, once", async () => {
    files.ciYml = STEPS;
    const t = await setup();
    const push = await t.start({ trigger: "push", preview: undefined });
    const step = await t.start({ trigger: "step", preview: undefined });
    if (!("runId" in push) || !("runId" in step)) throw new Error("both should start");
    t.sqlite.exec(`
      UPDATE ci_jobs SET status = 'succeeded', exit_code = 0,
        started_at = '2026-10-04T00:00:00.000Z', finished_at = '2026-10-04T00:00:02.500Z'
        WHERE run_id = '${step.runId}' AND name = 'lint';
      UPDATE ci_jobs SET status = 'failed', exit_code = 1,
        started_at = '2026-10-04T00:00:03.000Z', finished_at = '2026-10-04T00:00:04.000Z'
        WHERE run_id = '${step.runId}' AND name = 'unit';
      UPDATE ci_runs SET status = 'failed' WHERE id = '${step.runId}';
      UPDATE ci_runs SET status = 'succeeded' WHERE id = '${push.runId}';
    `);
    expect(await recordStepRun(t.env, push.runId)).toBe(false);
    expect(await recordStepRun(t.env, step.runId)).toBe(true);
    expect(await recordStepRun(t.env, step.runId)).toBe(true);
    const rows = t.sqlite.prepare("SELECT commit_oid, kind, data FROM step_artifacts").all() as {
      commit_oid: string;
      kind: string;
      data: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commit_oid).toBe(oid(9));
    expect(JSON.parse(rows[0]!.data)).toEqual({
      status: "failed",
      passed: 1,
      failed: 1,
      jobs: [
        { name: "lint", status: "succeeded", exitCode: 0, durationMs: 2500 },
        { name: "unit", status: "failed", exitCode: 1, durationMs: 1000 },
      ],
    });
  });
});

describe("a timeline's quiet period (CORE-238)", () => {
  const PIPE =
    "on:\n  push: {}\n  step: {}\njobs:\n  lint:\n    on: step\n    steps: [x]\n  test:\n    steps: [y]\n";
  const runs = (t: { sqlite: DatabaseSync }) =>
    t.sqlite
      .prepare(
        "SELECT id, number, ref, step, status, quiet_until, covered_by FROM ci_runs ORDER BY number",
      )
      .all() as {
      id: string;
      number: number;
      ref: string;
      step: number;
      status: string;
      quiet_until: string | null;
      covered_by: number | null;
    }[];

  test("a timeline's push run waits; its step run and main's runs don't", async () => {
    files.ciYml = PIPE;
    const t = await setup();
    const before = Date.now();
    await t.start({ trigger: "push", preview: undefined });
    await t.start({ trigger: "step", preview: undefined });
    await t.start({ trigger: "push", preview: undefined, branch: "main", commit: oid(8) });
    const [push, step, main] = runs(t);
    const waits = Date.parse(push!.quiet_until!) - before;
    expect(waits).toBeGreaterThanOrEqual(600_000);
    expect(waits).toBeLessThan(610_000);
    expect(step!.quiet_until).toBeNull();
    expect(main!.quiet_until).toBeNull();
    // The Workflow starts at once and does the waiting.
    expect(t.created).toHaveLength(3);
  });

  test("a newer push covers the run still waiting; a checkpoint releases the newest", async () => {
    files.ciYml = PIPE;
    const t = await setup();
    const events: { id: string; type: string }[] = [];
    Object.assign(t.env, {
      CI_RUN: {
        create: async ({ id }: { id: string }) => void t.created.push(id),
        get: async (id: string) => ({
          sendEvent: async ({ type }: { type: string }) => void events.push({ id, type }),
        }),
      },
    });
    await t.start({ trigger: "push", preview: undefined, commit: oid(1) });
    await t.start({ trigger: "push", preview: undefined, commit: oid(2) });
    const [first, second] = runs(t);
    expect(first).toMatchObject({ status: "cancelled", covered_by: second!.number });
    expect(second).toMatchObject({ status: "queued", covered_by: null });

    expect(await releaseQuiet(t.env, "repo", "timeline/search", oid(2))).toBe(1);
    expect(events).toEqual([{ id: second!.id, type: "quiet-release" }]);
    // Nothing waits on another branch.
    expect(await releaseQuiet(t.env, "repo", "timeline/other", oid(2))).toBe(0);
  });

  test("a checkpoint that beats its push's run still releases it", async () => {
    files.ciYml = PIPE;
    const t = await setup();
    // The bookmark CI already follows; the checkpoint of oid(3) comes first.
    t.sqlite.exec(
      `INSERT INTO ci_refs (repo_id, ref, oid) VALUES ('repo', 'timeline/search', '${oid(2)}')`,
    );
    expect(await releaseQuiet(t.env, "repo", "timeline/search", oid(3))).toBe(0);
    await t.start({ trigger: "push", preview: undefined, commit: oid(3) });
    await t.start({ trigger: "push", preview: undefined, commit: oid(4) });
    const [released, later] = runs(t);
    expect(released!.quiet_until).toBeNull();
    // Only that commit: the next push waits again.
    expect(later!.quiet_until).not.toBeNull();
  });

  test("the quiet period comes from the environment in development", () => {
    expect(timelineQuietMs({} as Env)).toBe(600_000);
    expect(timelineQuietMs({ TIMELINE_QUIET_SECONDS: "3" } as unknown as Env)).toBe(3_000);
    expect(timelineQuietMs({ TIMELINE_QUIET_SECONDS: "0" } as unknown as Env)).toBe(0);
    expect(timelineQuietMs({ TIMELINE_QUIET_SECONDS: "soon" } as unknown as Env)).toBe(600_000);
  });
});
