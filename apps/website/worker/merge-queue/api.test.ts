import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { hashToken, type AppEnv } from "../auth.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import {
  queueSourceBranch,
  queueCandidateBranch,
  type QueueResolution,
} from "../../shared/merge-queue.ts";
import { queueApi } from "./index.ts";
import { getQueue, saveQueue } from "./store.ts";
import * as ai from "./ai.ts";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
const boundary = vi.hoisted(() => ({
  refs: new Map<string, string>(),
  cancel: vi.fn(async () => {}),
}));
vi.mock("./scheduler.ts", () => ({
  progressQueue: async () => {},
  afterQueueRun: async () => {},
  sweepQueue: async () => {},
}));
vi.mock("./deps.ts", () => ({
  queueDeps: () => ({ refs: async () => new Map(boundary.refs), cancel: boundary.cancel }),
}));
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});
beforeEach(() => {
  boundary.refs.clear();
  boundary.cancel.mockClear();
});
const commit = "a".repeat(40);
function setup() {
  const sqlite = migratedDatabase();
  databases.push(sqlite);
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner'),('other','user','other','Other'); INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote) VALUES('repo','owner','app','private','a','https://a');",
  );
  const env = { DB: d1(sqlite) } as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const id = c.req.header("x-actor");
    c.set("actor", id ? { id, slug: id, displayName: id, isSiteAdmin: false } : null);
    await next();
  });
  app.route("/api/repos/:owner/:name/queue", queueApi);
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (work: Promise<unknown>) => {
      pending.push(work);
    },
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
  async function call(path = "", method = "GET", body?: unknown, actor: string | null = "owner") {
    const response = await app.request(
      `https://gitmatrix.test/api/repos/owner/app/queue${path}`,
      {
        method,
        headers: { ...(actor ? { "x-actor": actor } : {}), "content-type": "application/json" },
        ...(body !== undefined
          ? { body: typeof body === "string" ? body : JSON.stringify(body) }
          : {}),
      },
      env,
      context,
    );
    await Promise.all(pending.splice(0));
    return response;
  }
  return { sqlite, env, call, app, context };
}
describe("queue HTTP authority and transitions", () => {
  test("private existence is concealed and source admission needs exact pinned ref", async () => {
    const t = setup();
    expect((await t.call("", "GET", undefined, null)).status).toBe(404);
    expect((await t.call("", "GET", undefined, "other")).status).toBe(404);
    expect((await t.call("", "POST", { commit })).status).toBe(409);
    boundary.refs.set(`refs/heads/${queueSourceBranch(commit)}`, "b".repeat(40));
    expect((await t.call("", "POST", { commit })).status).toBe(409);
    boundary.refs.set(`refs/heads/${queueSourceBranch(commit)}`, commit);
    expect((await t.call("", "POST", { commit })).status).toBe(201);
  });
  test.each([
    null,
    [],
    "not-json",
    { commit: "A".repeat(40) },
    { commit, skipGates: true },
    { commit, issues: [12] },
    { commit, issues: Array(51).fill("X") },
  ])("malformed admission is rejected: %j", async (body) => {
    const t = setup();
    expect((await t.call("", "POST", body)).status).toBe(400);
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM merge_queue").get()).toEqual({ n: 0 });
  });
  test("actual request bytes are bounded even without content-length", async () => {
    const t = setup();
    expect(
      (await t.call("", "POST", JSON.stringify({ commit, issues: ["x".repeat(40000)] }))).status,
    ).toBe(400);
  });
  test("repeated and concurrent admission returns one original record, not a second merge", async () => {
    const t = setup();
    boundary.refs.set(`refs/heads/${queueSourceBranch(commit)}`, commit);
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => t.call("", "POST", { commit })),
    );
    expect(responses.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 200, 200, 201]);
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM merge_queue").get()).toEqual({ n: 1 });
    const entry = ((await responses[0]!.json()) as { entry: { status: string; commit: string } })
      .entry;
    expect(entry).toMatchObject({ status: "queued", commit });
    boundary.refs.clear();
    expect((await t.call("", "POST", { commit })).status).toBe(200);
  });
  test("write permission is required even when a public repository is readable", async () => {
    const t = setup();
    t.sqlite.exec("UPDATE repos SET visibility='public'");
    expect((await t.call("", "GET", undefined, "other")).status).toBe(200);
    expect((await t.call("", "POST", { commit }, "other")).status).toBe(403);
  });
  test("cancel and retry are version fenced; advancing and landed cannot be cancelled", async () => {
    const t = setup();
    boundary.refs.set(`refs/heads/${queueSourceBranch(commit)}`, commit);
    await t.call("", "POST", { commit });
    expect((await t.call(`/${commit}/cancel`, "POST")).status).toBe(200);
    expect((await t.call(`/${commit}/cancel`, "POST")).status).toBe(200);
    expect((await t.call(`/${commit}/retry`, "POST")).status).toBe(200);
    expect((await t.call(`/${commit}/retry`, "POST")).status).toBe(409);
    let s = (await getQueue(t.env.DB, "repo", commit))!;
    s = (await saveQueue(t.env.DB, s, { ...s, entry: { ...s.entry, status: "advancing" } }))!;
    expect((await t.call(`/${commit}/cancel`, "POST")).status).toBe(409);
    await saveQueue(t.env.DB, s, { ...s, entry: { ...s.entry, status: "landed" } });
    expect((await t.call(`/${commit}/cancel`, "POST")).status).toBe(409);
  });
  test("a regular repository writer cannot invoke the paid repair endpoint", async () => {
    const t = setup();
    expect((await t.call(`/${commit}/resolve`, "POST", { files: [] })).status).toBe(401);
    expect((await t.call("?status=green")).status).toBe(400);
    expect((await t.call("/invalid")).status).toBe(400);
  });
  test("running-attempt resolution is cached and duplicate callbacks cannot replay paid inference", async () => {
    const t = setup();
    boundary.refs.set(`refs/heads/${queueSourceBranch(commit)}`, commit);
    await t.call("", "POST", { commit });
    const original = (await getQueue(t.env.DB, "repo", commit))!;
    const branch = queueCandidateBranch(commit, 1);
    await saveQueue(t.env.DB, original, {
      ...original,
      mergeRunId: "merge",
      entry: {
        ...original.entry,
        status: "merging",
        attempts: 1,
        base: "b".repeat(40),
        candidateBranch: branch,
      },
    });
    t.sqlite
      .prepare(
        "INSERT INTO ci_runs(id,repo_id,number,commit_oid,ref,trigger,status,queue_id) VALUES('merge','repo',1,?,?,'manual','running',?)",
      )
      .run(commit, branch, commit);
    t.sqlite
      .prepare(
        "INSERT INTO ci_jobs(id,run_id,repo_id,name,spec,status,runner) VALUES('job','merge','repo','land',?,'running','local')",
      )
      .run(JSON.stringify({ queue: { id: commit, attempt: 1 } }));
    const token = "gmj_testqueue";
    t.sqlite
      .prepare(
        "INSERT INTO ci_job_tokens(token_hash,job_id,expires_at) VALUES(?,'job','2999-01-01T00:00:00.000Z')",
      )
      .run(await hashToken(token));
    const file = {
      path: "docs/notes.md",
      base: "Welcome.\n",
      ours: "Welcome.\nNorthern additions.\n",
      theirs: "Welcome.\nSouthern additions.\n",
    };
    const resolution: QueueResolution = {
      decision: {
        action: "manual",
        reason: "Manual resolution required.",
        model: null,
        confidence: null,
      },
      files: [],
      repairModel: null,
    };
    const entered = Promise.withResolvers<void>(),
      answer = Promise.withResolvers<QueueResolution>();
    const model = vi.spyOn(ai, "resolveQueueConflicts").mockImplementation(async () => {
      entered.resolve();
      return answer.promise;
    });
    const resolve = () =>
      t.app.request(
        `https://gitmatrix.test/api/repos/owner/app/queue/${commit}/resolve`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ files: [file] }),
        },
        t.env,
        t.context,
      );
    const first = resolve();
    await entered.promise;
    expect((await resolve()).status).toBe(409);
    answer.resolve(resolution);
    expect((await first).status).toBe(200);
    const repeated = await resolve();
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ resolution });
    expect(model).toHaveBeenCalledTimes(1);
    const current = (await getQueue(t.env.DB, "repo", commit))!;
    await saveQueue(t.env.DB, current, {
      ...current,
      entry: { ...current.entry, status: "cancelled" },
    });
    expect((await resolve()).status).toBe(403);
    expect(model).toHaveBeenCalledTimes(1);
  });
});
