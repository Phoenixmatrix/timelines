import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { d1 } from "../testing/d1.ts";
import { onPush, startRun, startWorkflow } from "./trigger.ts";
import {
  candidateProofs,
  executionIdentity,
  SANDBOX_CONTRACT,
  prerequisitesSatisfied,
  previousVerification,
} from "./verification.ts";
import { CiRun } from "./workflow.ts";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { RunParams } from "./trigger.ts";
import { Hono } from "hono";
import type { CiRunDetail } from "../../shared/api.ts";
import { ci } from "./api.ts";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { claim, jobPayload, loadJob } from "./jobs.ts";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import { initializeFreshSpaceInstallation } from "../space-cutover/installation.ts";
import { freshInstallationDatabases, seedSpaceFixture } from "../testing/spaces.ts";

const fixture = vi.hoisted(() => ({
  yaml: "",
  identity: "sandbox-v1:version:image" as string | null,
  execute: async (_jobId: string): Promise<void> => {},
  readIdentity: async (): Promise<void> => {},
  landing: async (_waitUntil: (work: Promise<unknown>) => void): Promise<void> => {},
  queue: async (_waitUntil: (work: Promise<unknown>) => void): Promise<void> => {},
  refs: [] as { shortName: string; oid: string }[],
}));
vi.mock("../artifacts.ts", () => ({
  listRefs: async () => ({ branches: fixture.refs, headBranch: "main" }),
}));
vi.mock("../durable/registry.ts", () => ({
  durableStub: () => ({ verificationIdentity: async () => fixture.identity }),
}));
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
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
  workerDeps: (_env: Env, waitUntil: (work: Promise<unknown>) => void) => ({ waitUntil }),
  afterRun: (_env: Env, deps: { waitUntil: (work: Promise<unknown>) => void }) =>
    fixture.landing(deps.waitUntil),
}));
vi.mock("../merge-queue/index.ts", () => ({
  afterQueueRun: (
    _env: Env,
    _repoId: string,
    _runId: string,
    waitUntil: (work: Promise<unknown>) => void,
  ) => fixture.queue(waitUntil),
}));
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
  fixture.landing = async () => {};
  fixture.queue = async () => {};
  fixture.refs = [{ shortName: "main", oid: commit }];
  const fresh = await freshInstallationDatabases();
  const { sqlite, registry } = fresh;
  databases.push(sqlite, registry);
  const workflows = new Set<string>();
  const env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registry),
    CI_RUNNER: "sandbox",
    CI_RUN: {
      create: async ({ id }: { id: string }) => {
        if (workflows.has(id)) throw new Error("Workflow already exists");
        workflows.add(id);
      },
      get: async (id: string) => {
        if (!workflows.has(id)) throw new Error("No Workflow");
        return { id, status: async () => ({ status: "running" }) };
      },
    },
  } as unknown as Env;
  const admission = installCutoverTestControl(env, fresh.control);
  databases.push(admission.state.db);
  await initializeFreshSpaceInstallation(env);
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('person','user','person','Person')",
  );
  await seedSpaceFixture(env.DB, {
    organization: {
      id: "organization",
      slug: "organization",
      displayName: "Organization",
      kind: "company",
    },
    space: { id: "space", slug: "owner", displayName: "Space" },
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
    VALUES('repo','space','app','private','a','https://a');
    INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four)
    VALUES('credential','person','Fixture','write','fixture-hash','test');`);
  const actor = { id: "person", credential: { kind: "token" as const, id: "credential" } };
  const repo = { id: "repo", artifacts_name: "a", artifacts_remote: "https://a" };
  const start = (options: Partial<Parameters<typeof startRun>[2]> = {}) =>
    startRun(env, repo, {
      runId: target.runId,
      branch: target.branch,
      commit,
      trigger: "push",
      actor,
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
  return { sqlite, env, repo, actor, start, state, workflows, admission };
}

function workflow(t: Awaited<ReturnType<typeof setup>>) {
  const results = new Map<string, unknown>();
  const executed: string[] = [];
  let before = async (_name: string) => {};
  let after = async (_name: string) => {};
  let interrupted: unknown = null;
  fixture.execute = async (jobId) => {
    executed.push(jobId);
    t.sqlite.prepare("UPDATE ci_jobs SET status='succeeded' WHERE id=?").run(jobId);
    t.sqlite.prepare("UPDATE ci_steps SET status='succeeded' WHERE job_id=?").run(jobId);
  };
  const step = {
    async do(name: string, ...args: unknown[]) {
      if (interrupted) throw interrupted;
      if (results.has(name)) return results.get(name);
      // Hook failures simulate isolate death; a caught business callback error
      // still permits the Workflow's durable admission-release step.
      try {
        await before(name);
      } catch (error) {
        interrupted = error;
        throw error;
      }
      const result = await (args.at(-1) as () => Promise<unknown>)();
      try {
        await after(name);
      } catch (error) {
        interrupted = error;
        throw error;
      }
      results.set(name, result);
      return result;
    },
  } as unknown as WorkflowStep;
  const run = () => {
    interrupted = null;
    return new CiRun({} as ExecutionContext, t.env).run(
      {
        payload: { runId: "production" },
        timestamp: new Date(),
        instanceId: "provider-production",
      } as WorkflowEvent<RunParams>,
      step,
    );
  };
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
  app.route("/api/repos/:space/:name/ci", ci);
  const { secret } = await issueToken(t.env.DB, "person", "test", "read");
  const response = await app.request(
    "/api/repos/owner/app/ci/runs/2",
    {
      headers: { authorization: `Bearer ${secret}`, "X-Gitmatrix-Content-Version": "4" },
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

test("a Workflow cannot queue another job after its run fails during startup", async () => {
  const t = await setup("jobs:\n  gate:\n    steps: [echo gate]\n");
  await t.start({ verification: undefined });
  const w = workflow(t);
  w.before(async (name) => {
    if (name === "start:gate")
      t.sqlite.exec(`UPDATE ci_runs SET status='failed',config_error='Startup failure'
        WHERE id='production'`);
  });
  await w.run();
  expect(w.executed).toEqual([]);
  expect(
    t.sqlite.prepare("SELECT status,config_error FROM ci_runs WHERE id='production'").get(),
  ).toEqual({ status: "failed", config_error: "Startup failure" });
  expect(t.sqlite.prepare("SELECT status FROM ci_jobs WHERE run_id='production'").get()).toEqual({
    status: "pending",
  });
});

describe("landed candidate verification", () => {
  test.each(["advancing", "landed"])(
    "push observers defer a %s queue candidate to its verification owner",
    async (status) => {
      const t = await setup(gatePipeline);
      t.state.entry.status = status;
      t.sqlite
        .prepare("UPDATE merge_queue SET status=?,data=?")
        .run(status, JSON.stringify(t.state));
      await onPush(t.env, t.repo, t.actor, () => {});
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
      t.sqlite.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote)
          VALUES('other','space','other','private','other','https://other');
          UPDATE merge_queue SET repo_id='other';`);
    }
    await onPush(t.env, t.repo, t.actor, () => {});
    expect(
      t.sqlite
        .prepare(
          "SELECT j.status,j.verified_by FROM ci_jobs j JOIN ci_runs r ON r.id=j.run_id WHERE r.ref='main' AND j.name='check'",
        )
        .all(),
    ).toEqual([{ status: "pending", verified_by: null }]);
  });

  test.each(["sandbox-v1:new-contract:image", "sandbox-v1:version:new-image", null])(
    "recovery rechecks runtime identity after D1 creation: %s",
    async (identity) => {
      const t = await setup(gatePipeline);
      await t.start();
      expect((await detail(t)).jobs[0]).toMatchObject({ status: "pending", verifiedBy: null });
      expect(await claim(t.env, "production-check", "unapproved-runner")).toBe(false);
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

  test.each(["sandbox-v1:new-contract:image", "sandbox-v1:version:new-image", null])(
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

  test("platform digest plus sandbox contract identifies execution, from a deployed Worker only", () => {
    const version = { id: "12345678-1234-1234-1234-123456789abc" };
    const image = `registry/image@sha256:${"a".repeat(64)}`;
    expect(executionIdentity(image, version)).toBe(`sandbox-v2:${SANDBOX_CONTRACT}:${image}`);
    // Another deploy of the same sandbox contract keeps earlier proofs valid.
    expect(executionIdentity(image, { id: "87654321-4321-4321-4321-cba987654321" })).toBe(
      executionIdentity(image, version),
    );
    expect(executionIdentity("default", version)).toBeNull();
    expect(executionIdentity("registry/image:latest", version)).toBeNull();
    expect(executionIdentity(image, undefined)).toBeNull();
    expect(executionIdentity(image, { id: "development" })).toBeNull();
  });
});

describe("verified change-selection baselines", () => {
  async function baseline() {
    const t = await setup(gatePipeline);
    await t.start({ verification: undefined });
    t.sqlite.exec(`UPDATE ci_jobs SET status='running',claimed_by='sandbox',
      execution_identity='sandbox-v1:version:image' WHERE id='production-check'`);
    return t;
  }

  test("only executed equivalent success supplies a baseline; repository env cannot forge it", async () => {
    const t = await baseline();
    expect(await previousVerification(t.env.DB, "production-check")).toEqual([
      { commit, runNumber: 1, jobId: "gates-check" },
    ]);
    t.sqlite.exec(`UPDATE ci_jobs SET spec=json_set(spec,'$.env.GITMATRIX_VERIFIED_BASE','forged')
      WHERE name='check'`);
    const payload = await jobPayload(t.env, (await loadJob(t.env.DB, "production-check"))!, {
      origin: "https://gm.test",
      token: "test-token",
    });
    expect(JSON.parse(payload.env.GITMATRIX_VERIFIED_BASE ?? "null")).toEqual([
      { commit, runNumber: 1, jobId: "gates-check" },
    ]);
    t.sqlite.exec("UPDATE ci_jobs SET status='skipped', verified_by='{}' WHERE id='gates-check'");
    expect(await previousVerification(t.env.DB, "production-check")).toEqual([]);
  });

  test("returns every qualifying candidate newest first and still applies the filters", async () => {
    const t = await baseline();
    // Copy the verified run, job and steps as runs 10 and 11.
    const copy = (table: string, where: string, set: Record<string, string>) => {
      const columns = (
        t.sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((c) => c.name);
      const select = columns.map((c) => (c in set ? set[c] : c)).join(",");
      t.sqlite.exec(
        `INSERT INTO ${table}(${columns.join(",")}) SELECT ${select} FROM ${table} WHERE ${where}`,
      );
    };
    for (const n of [10, 11]) {
      copy("ci_runs", "id='gates'", { id: `'gates-${n}'`, number: String(n) });
      copy("ci_jobs", "id='gates-check'", { id: `'gates-check-${n}'`, run_id: `'gates-${n}'` });
      copy("ci_steps", "job_id='gates-check'", { job_id: `'gates-check-${n}'` });
    }
    expect(
      (await previousVerification(t.env.DB, "production-check")).map((b) => b.runNumber),
    ).toEqual([11, 10, 1]);
    t.sqlite.exec("UPDATE ci_jobs SET exit_code=1, status='failed' WHERE id='gates-check-11'");
    t.sqlite.exec("DELETE FROM ci_steps WHERE job_id='gates-check-10'");
    expect(await previousVerification(t.env.DB, "production-check")).toEqual([
      { commit, runNumber: 1, jobId: "gates-check" },
    ]);
  });

  test.each([
    "UPDATE ci_jobs SET execution_identity='new-image' WHERE id='production-check'",
    "UPDATE ci_jobs SET execution_identity=NULL WHERE id='production-check'",
    "UPDATE ci_jobs SET runner='local' WHERE id='production-check'",
    "UPDATE ci_jobs SET source_id='other-source' WHERE id='production-check'",
    "UPDATE ci_jobs SET spec=json_set(spec,'$.verification',NULL) WHERE id='production-check'",
    "UPDATE ci_jobs SET spec=json_set(spec,'$.secrets',json('[\"SECRET\"]')) WHERE id='production-check'",
    "UPDATE ci_jobs SET spec=json_set(spec,'$.env.changed','yes') WHERE id='gates-check'",
    "UPDATE ci_jobs SET source_id='other-source' WHERE id='gates-check'",
    "UPDATE ci_jobs SET status='failed',exit_code=1 WHERE id='gates-check'",
    "UPDATE ci_jobs SET finished_at=NULL WHERE id='gates-check'",
    "UPDATE ci_jobs SET source_completion_pending=1 WHERE id='gates-check'",
    "UPDATE ci_runs SET status='running' WHERE id='gates'",
    "UPDATE ci_runs SET covered_by='other' WHERE id='gates'",
    "UPDATE ci_steps SET status='skipped' WHERE job_id='gates-check'",
    "DELETE FROM ci_steps WHERE job_id='gates-check'",
  ])("falls back without complete equivalent evidence: %s", async (change) => {
    const t = await baseline();
    t.sqlite.exec(change);
    expect(await previousVerification(t.env.DB, "production-check")).toEqual([]);
  });
});

test.each(["landing", "queue"] as const)(
  "%s failure retains admission until its already-launched final callback settles",
  async (callback) => {
    const t = await setup();
    await t.start();
    const w = workflow(t);
    const launched = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let published = false;
    fixture[callback] = async (waitUntil) => {
      waitUntil(
        finish.promise.then(() => {
          expect(t.admission.control.activeTickets()).toHaveLength(1);
          t.sqlite.prepare("UPDATE ci_runs SET title='final callback' WHERE id='production'").run();
          published = true;
        }),
      );
      launched.resolve();
      throw new Error("final callback dispatch failed");
    };
    const result = w.run().then(
      () => null,
      (error: unknown) => error,
    );
    await launched.promise;
    expect(t.admission.control.activeTickets()).toHaveLength(1);
    expect(published).toBe(false);
    finish.resolve();
    expect(await result).toEqual(new Error("final callback dispatch failed"));
    expect(published).toBe(true);
    expect(t.admission.control.activeTickets()).toEqual([]);
    expect(t.sqlite.prepare("SELECT title FROM ci_runs WHERE id='production'").get()).toEqual({
      title: "final callback",
    });
  },
);

// The sources that define how a sandbox job runs and what its success proves.
// A change here may leave earlier proofs wrong, so it must be a decision.
const SANDBOX_SOURCES = ["sandbox.ts", "jobs.ts", "registry.ts"];
const RECORDED_SANDBOX_SOURCES = {
  contract: 1,
  sha256: "b0ec3fb3ab41e6be4d1b677e0f1dfb26ee0738ef1e826c89a95e7cae0f415cca",
};

test("a change to the sandbox execution sources is a deliberate contract decision", () => {
  const hash = createHash("sha256");
  for (const file of SANDBOX_SOURCES)
    hash
      .update(`${file}\0`)
      .update(readFileSync(join(dirname(fileURLToPath(import.meta.url)), file)));
  expect(
    hash.digest("hex"),
    "Sandbox execution sources changed. If the change alters how a job runs or what its success proves, bump SANDBOX_CONTRACT in verification.ts. Either way, record the new hash here.",
  ).toBe(RECORDED_SANDBOX_SOURCES.sha256);
  expect(
    RECORDED_SANDBOX_SOURCES.contract,
    "SANDBOX_CONTRACT was bumped: record the sources' hash again next to it.",
  ).toBe(SANDBOX_CONTRACT);
});
