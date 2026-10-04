// Preview runs (CORE-79) through startRun, over a fake repository reader that
// serves one ci.yml at every commit, and the variables their jobs get.

import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { jobPayload, loadJob } from "./jobs.ts";
import { startRun } from "./trigger.ts";

const files = vi.hoisted(() => ({ ciYml: "" }));
vi.mock("../objects.ts", () => ({
  RepoReader: class {
    async commit(oid: string) {
      return { message: `Commit ${oid}\n`, treeHash: `tree-${oid}` };
    }
    async entryAt(_tree: string, path: string) {
      return path === ".gitmatrix/ci.yml" ? { type: "blob", hash: "ci" } : null;
    }
    async blob() {
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

function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('org', 'org', 'orbit', 'Orbit'),
      ('ann', 'user', 'ann', 'Ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'org', 'app', 'private', 'a', 'https://a');
  `);
  const created: string[] = [];
  const env = {
    DB: d1(sqlite),
    CI_RUNNER: "sandbox",
    CI_RUN: { create: async ({ id }: { id: string }) => void created.push(id) },
  } as unknown as Env;
  const repo = { id: "repo", artifacts_name: "a", artifacts_remote: "https://a" };
  const start = (options: Partial<Parameters<typeof startRun>[2]> = {}) =>
    startRun(env, repo, {
      branch: "timeline/search",
      commit: oid(9),
      trigger: "preview",
      preview: { action: "create", timeline: "search", checkpoint: "cp_1" },
      actor: { id: "ann" },
      waitUntil: () => {},
      ...options,
    });
  const jobs = (runId: string) =>
    sqlite
      .prepare("SELECT id, name, status FROM ci_jobs WHERE run_id = ? ORDER BY name")
      .all(runId) as { id: string; name: string; status: string }[];
  return { sqlite, env, start, jobs, created };
}

beforeEach(() => {
  files.ciYml = OPTED_IN;
});

describe("preview runs", () => {
  test("a create run records its action, timeline and checkpoint, and runs only its job", async () => {
    const t = setup();
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
    const t = setup();
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
    const t = setup();
    files.ciYml = "jobs:\n  test:\n    steps: [vp test]\n";
    expect(await t.start()).toEqual({ skipped: expect.stringMatching(/doesn't opt in/) });
    files.ciYml = "on: preview\njobs:\n  p:\n    if: action == 'create'\n    steps: [x]\n";
    expect(
      await t.start({ preview: { action: "teardown", timeline: "search", checkpoint: null } }),
    ).toEqual({ skipped: expect.stringMatching(/No job .* runs for preview teardown/) });
    files.ciYml = "jobs: [";
    expect(await t.start()).toEqual({ skipped: expect.stringMatching(/has errors/) });
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM ci_runs").get()).toEqual({ n: 0 });
  });

  test("jobs get the timeline, checkpoint, commit and action", async () => {
    const t = setup();
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
    const payload = await jobPayload(t.env.DB, job!, { origin: "https://gm.test", token: "gmj_x" });
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
    const env = (await jobPayload(t.env.DB, pushed!, { origin: "https://gm.test", token: "x" }))
      .env;
    expect(env).toMatchObject({ GITMATRIX_TRIGGER: "push", GITMATRIX_TIMELINE: "search" });
    expect(env.GITMATRIX_CHECKPOINT).toBeUndefined();
    expect(env.GITMATRIX_PREVIEW_ACTION).toBeUndefined();
  });
});

describe("landing runs", () => {
  test("the gates on a landing's merge are stored as manual with their landing, and say landing", async () => {
    const t = setup();
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
    const payload = await jobPayload(t.env.DB, job!, { origin: "https://gm.test", token: "x" });
    expect(payload.env.GITMATRIX_TRIGGER).toBe("landing");
  });
});

describe("queue gates", () => {
  test("a source staging ref never starts a pipeline, including a manual request", async () => {
    const t = setup();
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
    const t = setup();
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
    const t = setup();
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
    const payload = await jobPayload(t.env.DB, job!, { origin: "https://gm.test", token: "x" });
    expect(payload.env.GITMATRIX_TRIGGER).toBe("landing");
    expect(payload.env.GITMATRIX_QUEUE_ID).toBe(oid(9));
    expect(payload.env.GITMATRIX_TIMELINE).toBeUndefined();
  });
});
