import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { onPush, startRun, startWorkflow } from "./trigger.ts";
import { candidateProofs, executionIdentity, prerequisitesSatisfied } from "./verification.ts";
import { CiRun } from "./workflow.ts";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RunParams } from "./trigger.ts";
import { Hono } from "hono";
import type { CiRunDetail } from "../../shared/api.ts";
import { ci } from "./api.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { claim } from "./jobs.ts";

const fixture = vi.hoisted(() => ({
  yaml: "",
  identity: "sandbox-v1:version:image" as string | null,
  execute: async (_jobId: string): Promise<void> => {},
  readIdentity: async (): Promise<void> => {},
  refs: [] as { shortName: string; oid: string }[],
}));
vi.mock("../artifacts.ts", () => ({
  listRefs: async () => ({ branches: fixture.refs, headBranch: "main" }),
}));
vi.mock("../durable/registry.ts", () => ({
  durableStub: () => ({ verificationIdentity: async () => fixture.identity }),
}));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkflowEntrypoint: class {
    env: Env;
    constructor(_ctx: unknown, env: Env) {
      this.env = env;
    }
  },
}));
vi.mock("./sandbox.ts", () => ({
  sandbox: () => ({
    verificationIdentity: async () => {
      await fixture.readIdentity();
      return fixture.identity;
    },
    run: (jobId: string) => fixture.execute(jobId),
  }),
}));
vi.mock("../timelines/landing.ts", () => ({
  settled: async () => {},
  afterRun: async () => {},
}));
vi.mock("../merge-queue/index.ts", () => ({ afterQueueRun: async () => {} }));
vi.mock("../steps/runs.ts", () => ({ recordStepRun: async () => {} }));
vi.mock("../objects.ts", () => ({
  RepoReader: class {
    async commit() {
      return { message: "candidate", treeHash: "tree" };
    }
    async entryAt(_tree: string, path: string) {
      return path === ".gitmatrix/ci.yml" ? { type: "blob", hash: "config" } : null;
    }
    async blob() {
      return { bytes: new TextEncoder().encode(fixture.yaml) };
    }
    async close() {}
  },
}));
const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const sqlite of databases.splice(0)) sqlite.close();
});
const commit = "a".repeat(40);
const candidate = { queueId: "queue", attempt: 2, gateRunId: "gates" };
const target = { repoId: "repo", runId: "production", branch: "main", commit };
const yaml = `jobs:
  check:
    verification: context-invariant-v1
    steps: [true]
  context-sensitive:
    steps: ['echo "$GITMATRIX_BRANCH"']
  main-only:
    verification: context-invariant-v1
    if: branch == "main"
    needs: [check]
    steps: [true]
  push-only:
    verification: context-invariant-v1
    if: trigger == "push"
    needs: [main-only]
    steps: [true]
  deploy:
    if: branch == "main"
    needs: [check, context-sensitive, push-only]
    concurrency: production
    steps: [true]
`;

async function setup(config = yaml) {
  fixture.yaml = config.replaceAll("steps: [true]", "steps: ['true']");
  fixture.identity = "sandbox-v1:version:image";
  fixture.readIdentity = async () => {};
  fixture.refs = [{ shortName: "main", oid: commit }];
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(`INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner');
    INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote)
    VALUES('repo','owner','app','private','a','https://a');`);
  const workflows = new Set<string>();
  const env = {
    DB: d1(sqlite),
    CI_RUNNER: "sandbox",
    CI_RUN: {
      create: async ({ id }: { id: string }) => {
        if (workflows.has(id)) throw new Error("Workflow already exists");
        workflows.add(id);
      },
      get: async (id: string) => {
        if (!workflows.has(id)) throw new Error("No Workflow");
        return { id };
      },
    },
  } as unknown as Env;
  const repo = { id: "repo", artifacts_name: "a", artifacts_remote: "https://a" };
  const start = (options: Partial<Parameters<typeof startRun>[2]> = {}) =>
    startRun(env, repo, {
      runId: target.runId,
      branch: target.branch,
      commit,
      trigger: "push",
      actor: null,
      verification: candidate,
      waitUntil: () => {},
      ...options,
    });
  await start({
    runId: "gates",
    branch: "queue/candidate",
    trigger: "landing",
    queueId: "queue",
    queueAttempt: 2,
    verification: undefined,
  });
  sqlite.exec(`UPDATE ci_runs SET status='succeeded',started_at='2026-10-09',finished_at='2026-10-09' WHERE id='gates';
    UPDATE ci_jobs SET status='succeeded',claimed_by='sandbox',exit_code=0,started_at='2026-10-09',finished_at='2026-10-09',execution_identity='sandbox-v1:version:image' WHERE status='pending';
    UPDATE ci_steps SET status='succeeded',exit_code=0,started_at='2026-10-09',finished_at='2026-10-09' WHERE status='pending';`);
  const state = {
    entry: {
      id: "queue",
      status: "landed",
      attempts: 2,
      candidate: commit,
      branch: "main",
      candidateBranch: "queue/candidate",
    },
    gateRunId: "gates",
    deployRunId: "production",
  };
  sqlite
    .prepare(
      "INSERT INTO merge_queue(repo_id,id,status,attempts,gate_run_id,candidate,data,created_at,updated_at) VALUES('repo','queue','landed',2,'gates',?,?,'now','now')",
    )
    .run(commit, JSON.stringify(state));
  return { sqlite, env, repo, start, state, workflows };
}

function workflow(t: Awaited<ReturnType<typeof setup>>) {
  const results = new Map<string, unknown>();
  const executed: string[] = [];
  let before = async (_name: string) => {};
  let after = async (_name: string) => {};
  fixture.execute = async (jobId) => {
    executed.push(jobId);
    t.sqlite.prepare("UPDATE ci_jobs SET status='succeeded' WHERE id=?").run(jobId);
    t.sqlite.prepare("UPDATE ci_steps SET status='succeeded' WHERE job_id=?").run(jobId);
  };
  const step = {
    async do(name: string, ...args: unknown[]) {
      if (results.has(name)) return results.get(name);
      await before(name);
      const result = await (args.at(-1) as () => Promise<unknown>)();
      await after(name);
      results.set(name, result);
      return result;
    },
  } as unknown as WorkflowStep;
  const run = () =>
    new CiRun({} as ExecutionContext, t.env).run(
      {
        payload: { runId: "production" },
        timestamp: new Date(),
      } as WorkflowEvent<RunParams>,
      step,
    );
  return {
    run,
    executed,
    results,
    before: (hook: typeof before) => {
      before = hook;
    },
    after: (hook: typeof after) => {
      after = hook;
    },
  };
}

async function detail(t: Awaited<ReturnType<typeof setup>>) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/repos/:owner/:name/ci", ci);
  const { secret } = await issueToken(t.env.DB, "owner", "test", "read");
  const response = await app.request(
    "/api/repos/owner/app/ci/runs/2",
    {
      headers: { authorization: `Bearer ${secret}` },
    },
    t.env,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as CiRunDetail;
}

const gatePipeline = `jobs:
  check:
    verification: context-invariant-v1
    steps: ['true']
  deploy:
    needs: [check]
    if: branch == "main"
    steps: ['true']
`;

describe("landed candidate verification", () => {
  test.each(["advancing", "landed"])(
    "push observers defer a %s queue candidate to its verification owner",
    async (status) => {
      const t = await setup(gatePipeline);
      t.state.entry.status = status;
      t.sqlite
        .prepare("UPDATE merge_queue SET status=?,data=?")
        .run(status, JSON.stringify(t.state));
      await onPush(t.env, t.repo, null, () => {});
      expect(t.sqlite.prepare("SELECT ref,oid FROM ci_refs").all()).toEqual([
        { ref: "main", oid: commit },
      ]);
      expect(t.sqlite.prepare("SELECT ref FROM ci_runs ORDER BY number").all()).toEqual([
        { ref: "queue/candidate" },
      ]);
      t.state.entry.status = "landed";
      t.sqlite
        .prepare("UPDATE merge_queue SET status='landed',data=?")
        .run(JSON.stringify(t.state));
      await t.start();
      const w = workflow(t);
      await w.run();
      expect(w.executed).toEqual(["production-deploy"]);
      expect((await detail(t)).jobs.find((job) => job.name === "check")).toMatchObject({
        status: "skipped",
        claimedBy: null,
        exitCode: null,
        verifiedBy: {
          runId: "gates",
          runNumber: 1,
          jobId: "gates-check",
          queueId: "queue",
          attempt: 2,
          commit,
          sourceId: "canonical",
          contract: "context-invariant-v1",
          executionIdentity: fixture.identity,
        },
      });
    },
  );

  test.each([
    "different commit",
    "different branch",
    "completed deployment",
    "failed queue",
    "different repository",
  ])("ordinary push execution is not withheld by a %s", async (boundary) => {
    const t = await setup(gatePipeline);
    const state = {
      ...t.state,
      entry: {
        ...t.state.entry,
        candidate: boundary === "different commit" ? "b".repeat(40) : commit,
        branch: boundary === "different branch" ? "another" : "main",
        status: boundary === "failed queue" ? "failed" : "landed",
        deployStatus: boundary === "completed deployment" ? "succeeded" : "queued",
      },
    };
    t.sqlite
      .prepare("UPDATE merge_queue SET status=?,candidate=?,data=?")
      .run(state.entry.status, state.entry.candidate, JSON.stringify(state));
    if (boundary === "different repository") {
      t.sqlite.exec(`INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote)
          VALUES('other','owner','other','private','other','https://other');
          UPDATE merge_queue SET repo_id='other';`);
    }
    await onPush(t.env, t.repo, null, () => {});
    expect(
      t.sqlite
        .prepare(
          "SELECT j.status,j.verified_by FROM ci_jobs j JOIN ci_runs r ON r.id=j.run_id WHERE r.ref='main' AND j.name='check'",
        )
        .all(),
    ).toEqual([{ status: "pending", verified_by: null }]);
  });

  test.each(["sandbox-v1:new-version:image", "sandbox-v1:version:new-image", null])(
    "recovery rechecks runtime identity after D1 creation: %s",
    async (identity) => {
      const t = await setup(gatePipeline);
      await t.start();
      expect((await detail(t)).jobs[0]).toMatchObject({ status: "pending", verifiedBy: null });
      expect(await claim(t.env.DB, "production-check", "unapproved-runner")).toBe(false);
      t.workflows.delete("production");
      fixture.identity = identity;
      await t.start();
      await startWorkflow(t.env, "production");
      const w = workflow(t);
      await w.run();
      expect(w.executed).toEqual(["production-check", "production-deploy"]);
      expect((await detail(t)).jobs[0]).toMatchObject({ status: "succeeded", verifiedBy: null });
      expect(
        t.sqlite.prepare("SELECT verified_by FROM ci_jobs WHERE id='production-check'").get(),
      ).toEqual({ verified_by: null });
    },
  );

  test.each(["sandbox-v1:new-version:image", "sandbox-v1:version:new-image", null])(
    "a cached plan cannot admit a delayed gate with changed identity: %s",
    async (identity) => {
      const t = await setup(gatePipeline);
      await t.start();
      const w = workflow(t);
      w.before(async (name) => {
        if (name === "verification:check") throw new Error("process died before consumption");
      });
      await expect(w.run()).rejects.toThrow("process died before consumption");
      expect(w.results.has("plan")).toBe(true);
      fixture.identity = identity;
      w.before(async () => {});
      await w.run();
      expect(w.executed).toEqual(["production-check", "production-deploy"]);
      expect((await detail(t)).jobs.find((job) => job.name === "check")?.verifiedBy).toBeNull();
    },
  );

  test.each(["accept", "reject"] as const)(
    "D1 %s survives a crash before its Workflow checkpoint",
    async (decision) => {
      const t = await setup(gatePipeline);
      await t.start();
      const w = workflow(t);
      if (decision === "reject") fixture.identity = null;
      w.after(async (name) => {
        if (name === "verification:check") throw new Error("process died after commit");
      });
      await expect(w.run()).rejects.toThrow("process died after commit");
      const check = (await detail(t)).jobs[0]!;
      expect(check).toMatchObject({
        status: decision === "accept" ? "skipped" : "pending",
        startedAt: null,
        finishedAt: null,
        claimedBy: null,
        exitCode: null,
      });
      expect(check.verifiedBy !== null).toBe(decision === "accept");
      expect(check.steps[0]!.status).toBe(decision === "accept" ? "skipped" : "pending");
      fixture.identity = "sandbox-v1:unrelated-deploy:new-image";
      w.after(async () => {});
      await w.run();
      expect(w.executed).toEqual(
        decision === "accept" ? ["production-deploy"] : ["production-check", "production-deploy"],
      );
    },
  );

  test.each(["failed", "cancelled", "skipped"] as const)(
    "a %s main prerequisite rejects proof and blocks downstream with truthful API provenance",
    async (status) => {
      const t = await setup(`jobs:
  prerequisite:
    ${status === "skipped" ? 'if: branch != "main"' : ""}
    steps: ['true']
  check:
    needs: [prerequisite]
    verification: context-invariant-v1
    steps: ['true']
  deploy:
    needs: [check]
    if: branch == "main"
    steps: ['true']
`);
      await t.start();
      expect((await detail(t)).jobs.find((job) => job.name === "check")!.verifiedBy).toBeNull();
      const w = workflow(t);
      fixture.execute = async (jobId) => {
        w.executed.push(jobId);
        t.sqlite.prepare("UPDATE ci_jobs SET status=? WHERE id=?").run(status, jobId);
      };
      w.after(async (name) => {
        if (name === "verification:check") throw new Error("blocked proof committed");
      });
      await expect(w.run()).rejects.toThrow("blocked proof committed");
      expect((await detail(t)).jobs.find((job) => job.name === "check")).toMatchObject({
        status: "skipped",
        verifiedBy: null,
        finishedAt: null,
        error: "Skipped because prerequisite did not succeed.",
      });
      w.after(async () => {});
      await w.run();
      expect(w.executed).toEqual(status === "skipped" ? [] : ["production-prerequisite"]);
      const result = await detail(t);
      expect(result.jobs.find((job) => job.name === "check")).toMatchObject({
        status: "skipped",
        verifiedBy: null,
        error: "Skipped because prerequisite did not succeed.",
        startedAt: null,
        finishedAt: null,
      });
      expect(result.jobs.find((job) => job.name === "deploy")).toMatchObject({
        status: "skipped",
        verifiedBy: null,
        error: "Skipped because check did not succeed.",
      });
      expect(
        t.sqlite.prepare("SELECT verified_by FROM ci_jobs WHERE id='production-check'").get(),
      ).toEqual({ verified_by: null });
    },
  );

  test("accepted consumption stays complete when a later deployment interrupts downstream work", async () => {
    const t = await setup(gatePipeline);
    await t.start();
    const w = workflow(t);
    w.before(async (name) => {
      if (name === "start:deploy") throw new Error("later interruption");
    });
    await expect(w.run()).rejects.toThrow("later interruption");
    expect(w.results.get("verification:check")).toBe("verified");
    fixture.identity = null;
    w.before(async () => {});
    await w.run();
    expect(w.executed).toEqual(["production-deploy"]);
    expect((await detail(t)).jobs[0]).toMatchObject({
      status: "skipped",
      verifiedBy: { jobId: "gates-check" },
      startedAt: null,
      finishedAt: null,
    });
  });

  test("cancellation during the runtime lookup cannot publish or execute proposed proof", async () => {
    const t = await setup(gatePipeline);
    await t.start();
    const w = workflow(t);
    fixture.readIdentity = async () => {
      t.sqlite.exec("UPDATE ci_runs SET status='cancelled' WHERE id='production'");
    };
    await w.run();
    expect(w.executed).toEqual([]);
    expect((await detail(t)).jobs[0]).toMatchObject({
      status: "cancelled",
      verifiedBy: null,
      error: "Cancelled before candidate verification was consumed.",
      startedAt: null,
      finishedAt: null,
    });
    expect(
      t.sqlite.prepare("SELECT verified_by FROM ci_jobs WHERE id='production-check'").get(),
    ).toEqual({ verified_by: null });
  });

  test("keeps the complete main graph and links only opted-in executed proof", async () => {
    const t = await setup();
    await t.start();
    const jobs = t.sqlite
      .prepare(
        "SELECT name,status,spec,verified_by,claimed_by,exit_code,started_at,finished_at FROM ci_jobs WHERE run_id='production' ORDER BY name",
      )
      .all();
    expect(jobs.map((job) => [job.name, job.status])).toEqual([
      ["check", "pending"],
      ["context-sensitive", "pending"],
      ["deploy", "pending"],
      ["main-only", "pending"],
      ["push-only", "pending"],
    ]);
    const check = jobs.find((job) => job.name === "check")!;
    expect(JSON.parse(String(check.verified_by))).toMatchObject({
      runId: "gates",
      jobId: "gates-check",
      queueId: "queue",
      attempt: 2,
      commit,
      sourceId: "canonical",
      contract: "context-invariant-v1",
    });
    expect([check.claimed_by, check.exit_code, check.started_at, check.finished_at]).toEqual([
      null,
      null,
      null,
      null,
    ]);
    expect(JSON.parse(String(jobs.find((job) => job.name === "deploy")!.spec)).needs).toEqual([
      "check",
      "context-sensitive",
      "push-only",
    ]);
    expect(
      t.sqlite.prepare("SELECT status FROM ci_steps WHERE job_id='production-check'").all(),
    ).toEqual([{ status: "pending" }]);
    expect(await t.start()).toEqual({ runId: "production", number: 2 });
    expect(
      t.sqlite.prepare("SELECT count(*) AS n FROM ci_jobs WHERE run_id='production'").get(),
    ).toEqual({ n: 5 });
  });

  test.each([
    "UPDATE ci_runs SET status='failed' WHERE id='gates'",
    "UPDATE ci_runs SET status='cancelled' WHERE id='gates'",
    "UPDATE ci_runs SET finished_at=NULL WHERE id='gates'",
    "UPDATE ci_runs SET queue_attempt=1 WHERE id='gates'",
    "UPDATE ci_runs SET source_id='other' WHERE id='gates'",
    "UPDATE ci_runs SET commit_oid='other' WHERE id='gates'",
    "UPDATE ci_jobs SET status='failed' WHERE name='check'",
    "UPDATE ci_jobs SET status='skipped' WHERE name='check'",
    "UPDATE ci_jobs SET status='cancelled' WHERE name='check'",
    "UPDATE ci_jobs SET runner='local' WHERE name='check'",
    "UPDATE ci_jobs SET claimed_by='manual' WHERE name='check'",
    "UPDATE ci_jobs SET source_id='other' WHERE name='check'",
    "UPDATE ci_jobs SET execution_identity='another-image' WHERE name='check'",
    "UPDATE ci_jobs SET source_completion_pending=1 WHERE name='check'",
    "UPDATE ci_steps SET status='pending' WHERE job_id='gates-check'",
    "DELETE FROM ci_steps WHERE job_id='gates-check'",
    "DELETE FROM ci_jobs WHERE name='check'",
  ])("fails closed for incomplete or mismatched producer: %s", async (mutation) => {
    const t = await setup();
    t.sqlite.exec(mutation);
    await t.start();
    expect(
      t.sqlite.prepare("SELECT status,verified_by FROM ci_jobs WHERE id='production-check'").get(),
    ).toEqual({ status: "pending", verified_by: null });
  });

  test.each([
    "secrets: [TOKEN]",
    "image: custom",
    "env: {MODE: changed}",
    "verification: null",
    "needs: [context-sensitive]",
  ])("executes changed/unsupported effective specifications: %s", async (change) => {
    const t = await setup();
    fixture.yaml = fixture.yaml.replace(
      "verification: context-invariant-v1",
      change === "verification: null" ? "" : `verification: context-invariant-v1\n    ${change}`,
    );
    await t.start();
    expect(
      t.sqlite.prepare("SELECT status,verified_by FROM ci_jobs WHERE id='production-check'").get(),
    ).toEqual({ status: "pending", verified_by: null });
  });

  test("direct pushes, manual reruns and unknown runtime identity execute", async () => {
    const t = await setup();
    for (const [runId, trigger] of [
      ["direct", "push"],
      ["manual", "manual"],
    ] as const) {
      await t.start({ runId, trigger, verification: undefined });
      t.sqlite.prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?").run(runId);
      expect(
        t.sqlite.prepare("SELECT verified_by,status FROM ci_jobs WHERE id=?").get(`${runId}-check`),
      ).toEqual({ verified_by: null, status: "pending" });
    }
    fixture.identity = null;
    await t.start();
    expect(
      t.sqlite.prepare("SELECT verified_by,status FROM ci_jobs WHERE id='production-check'").get(),
    ).toEqual({ verified_by: null, status: "pending" });
  });

  test("a new queue attempt or different deploy owner cannot consume old evidence", async () => {
    const t = await setup();
    expect((await candidateProofs(t.env.DB, target, candidate, fixture.identity)).size).toBe(1);
    expect(
      (await candidateProofs(t.env.DB, target, { ...candidate, attempt: 3 }, fixture.identity))
        .size,
    ).toBe(0);
    expect(
      (await candidateProofs(t.env.DB, { ...target, runId: "other" }, candidate, fixture.identity))
        .size,
    ).toBe(0);
    expect(
      (await candidateProofs(t.env.DB, { ...target, repoId: "other" }, candidate, fixture.identity))
        .size,
    ).toBe(0);
    expect(
      (
        await candidateProofs(
          t.env.DB,
          { ...target, commit: "b".repeat(40) },
          candidate,
          fixture.identity,
        )
      ).size,
    ).toBe(0);
  });

  test("verified prerequisites preserve missing, extra and transitive dependency gates", () => {
    const outcomes = new Map<string, string>([["check", "verified"]]);
    expect(prerequisitesSatisfied(["check"], outcomes)).toBe(true);
    expect(prerequisitesSatisfied(["check", "main-only"], outcomes)).toBe(false);
    outcomes.set("main-only", "skipped");
    expect(prerequisitesSatisfied(["check", "main-only"], outcomes)).toBe(false);
    outcomes.set("main-only", "succeeded");
    expect(prerequisitesSatisfied(["check", "main-only"], outcomes)).toBe(true);
    expect(prerequisitesSatisfied(["push-only"], outcomes)).toBe(false);
    outcomes.set("push-only", "failed");
    expect(prerequisitesSatisfied(["push-only"], outcomes)).toBe(false);
  });

  test("concurrent duplicate creation and replay retain exactly one proof-linked run", async () => {
    const t = await setup();
    const results = await Promise.all([t.start(), t.start()]);
    expect(results[0]).toEqual(results[1]);
    expect(
      t.sqlite.prepare("SELECT count(*) AS n FROM ci_runs WHERE id='production'").get(),
    ).toEqual({ n: 1 });
    expect(
      t.sqlite.prepare("SELECT count(*) AS n FROM ci_jobs WHERE run_id='production'").get(),
    ).toEqual({ n: 5 });
    expect(
      t.sqlite.prepare("SELECT count(*) AS n FROM ci_steps WHERE job_id='production-check'").get(),
    ).toEqual({ n: 1 });
    expect(
      t.sqlite.prepare("SELECT status,config_error FROM ci_runs WHERE id='production'").get(),
    ).toEqual({ status: "queued", config_error: null });
    // Simulate process death after the atomic D1 creation, before Workflow creation.
    t.workflows.delete("production");
    await t.start();
    await startWorkflow(t.env, "production");
    expect(t.workflows.has("production")).toBe(true);
    expect(
      t.sqlite.prepare("SELECT count(*) AS n FROM ci_jobs WHERE run_id='production'").get(),
    ).toEqual({ n: 5 });
  });

  test("only platform digest plus immutable Worker version identifies execution", () => {
    const version = { id: "12345678-1234-1234-1234-123456789abc" };
    const image = `registry/image@sha256:${"a".repeat(64)}`;
    expect(executionIdentity(image, version)).toBe(`sandbox-v1:${version.id}:${image}`);
    expect(executionIdentity("default", version)).toBeNull();
    expect(executionIdentity("registry/image:latest", version)).toBeNull();
    expect(executionIdentity(image, undefined)).toBeNull();
    expect(executionIdentity(image, { id: "development" })).toBeNull();
  });
});
