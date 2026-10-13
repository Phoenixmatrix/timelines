import { Hono } from "hono";
import { FakeR2Bucket } from "@gitmatrix/testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { Step, StepArtifact, StepPage, StepUpload, StepVersions } from "../../shared/steps.ts";
import { STEP_ARTIFACT_LIMITS, STEP_LIMITS } from "../../shared/steps.ts";
import { hashToken } from "../auth.ts";
import { jobRoute } from "../deployments/job.ts";
import { stepArtifacts } from "../retention/cleanups/steps.ts";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { fakeDurableState } from "../testing/durable-state.ts";
import { StepFeed } from "./feed.ts";
import { steps } from "./api.ts";
import { fakeHistory } from "../testing/history.ts";
import { Timing } from "../timing.ts";
import { readAgentPresence } from "../agent-presence.ts";
import { RepoReader } from "../objects.ts";
import { sha256 } from "../api/bytes.ts";

beforeEach(() => {
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
});
afterEach(() => vi.unstubAllGlobals());

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const annsAgent: Actor = { ...ann, agent: { id: "agt_builder", name: "builder" } };
const ben: Actor = { id: "ben", slug: "ben", displayName: "Ben", isSiteAdmin: false };
const cid: Actor = { id: "cid", slug: "cid", displayName: "Cid", isSiteAdmin: false };

const oid = (n: number) => n.toString(16).padStart(40, "0");

function setup(visibility: "public" | "private" = "private") {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben'), ('cid', 'user', 'cid', 'Cid');
    INSERT INTO agents (id, name, accountable_id) VALUES ('agt_builder', 'builder', 'ann');
    INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'ann', 'app', '${visibility}', 'steps-${crypto.randomUUID()}', 'https://a');
    INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('repo', 'ben', 'write');
  `);
  // Live feeds (CORE-239), real objects over fake storage, by name.
  const feeds = new Map<string, StepFeed>();
  const git = fakeHistory();
  const files = new FakeR2Bucket();
  const env = {
    DB: d1(sqlite),
    ARTIFACTS: git.artifacts,
    STEP_ARTIFACTS: files,
    STEP_FEED: {
      getByName: (name: string) => {
        if (!feeds.has(name))
          feeds.set(name, new StepFeed(fakeDurableState().ctx as never, {} as Env));
        return feeds.get(name)!;
      },
    },
  } as unknown as Env;
  let actor: Actor | null = annsAgent;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    c.set("timing", new Timing());
    await next();
  });
  app.route("/api/repos/:owner/:name/steps", steps);
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil: (work: Promise<unknown>) => pending.push(work),
    passThroughOnException: () => {},
    props: {},
  };
  const call = async (path: string, init?: RequestInit) => {
    const response = await app.request(
      `/api/repos/ann/app/steps${path}`,
      init,
      env,
      context as unknown as ExecutionContext,
    );
    while (pending.length) await Promise.all(pending.splice(0));
    return response;
  };
  /** A running CI job of `repo` (run `runId`, commit oid(1)) and its credential. */
  const jobFor = async (jobId: string, runId: string, repoId = "repo", name = "visuals") => {
    const number = Number(sqlite.prepare("SELECT COUNT(*) AS n FROM ci_runs").get()!.n) + 1;
    sqlite.exec(`
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, step)
        VALUES ('${runId}', '${repoId}', ${number}, '${oid(1)}', 'timeline/search', 'manual', 'running', 1);
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner)
        VALUES ('${jobId}', '${runId}', '${repoId}', '${name}', '{}', 'running', 'sandbox');
    `);
    const secret = `gmj_${jobId}`;
    sqlite
      .prepare("INSERT INTO ci_job_tokens (token_hash, job_id, expires_at) VALUES (?, ?, ?)")
      .run(await hashToken(secret), jobId, "2099-01-01T00:00:00.000Z");
    return secret;
  };
  return {
    sqlite,
    git,
    files,
    env,
    jobFor,
    /** A request to a second repository, ann/other. */
    other: (path: string) =>
      app.request(
        `/api/repos/ann/other/steps${path}`,
        {},
        env,
        context as unknown as ExecutionContext,
      ),
    presence: (commit: string) =>
      readAgentPresence(env.DB, {
        kind: "commit",
        scopeId: "repo",
        resourceId: commit,
        sourceId: "canonical",
      }),
    feeds,
    as: (next: Actor | null) => {
      actor = next;
    },
    call,
    upload: (step: Partial<StepUpload>) => call("", { method: "POST", body: JSON.stringify(step) }),
  };
}

const step = (n: number, over: Partial<StepUpload> = {}): StepUpload => ({
  changeId: `change${String(n).padStart(4, "0")}`,
  commitOid: oid(n),
  summary: `Step ${n}`,
  committedAt: `2026-10-04T00:${String(n).padStart(2, "0")}:00.000Z`,
  timeline: "search",
  issue: "CORE-9",
  instructions: [{ text: "Rank results by recency", source: "hook" }],
  steering: [{ text: "Keep the old order as a fallback", source: "hook" }],
  why: "Recency matters more than score here.",
  challenges: "The first index didn't cover updated_at.",
  tests: [{ command: "vp test run search", exit: 0, summary: "12 passed", origin: "local" }],
  coverage: { instructions: "hook:claude-code", steering: "hook:claude-code" },
  harness: "claude-code",
  model: "claude-opus-5-5",
  ...over,
});

describe("step context", () => {
  test("single successful remote context inspection records only an existing commit, never a batch", async () => {
    const s = setup();
    const first = s.git.commit({ files: { a: "a\n" } });
    const second = s.git.commit({ parents: [first], files: { a: "b\n" } });
    await s.upload(step(1, { commitOid: first }));
    await s.upload(step(2, { commitOid: second }));
    await s.upload(step(3));
    expect((await s.call(`?commits=${first},${second}`)).status).toBe(200);
    expect((await s.presence(first)).agents).toEqual([]);
    expect((await s.presence(second)).agents).toEqual([]);
    expect((await s.call(`?commits=${oid(3)}`)).status).toBe(200);
    expect((await s.presence(oid(3))).agents).toEqual([]);
    expect((await s.call(`?commits=${first}&source=unknown`)).status).toBe(404);
    s.as(cid);
    expect((await s.call(`?commits=${first}`)).status).toBe(404);
    s.as(ann);
    expect((await s.call(`?commits=${first}`)).status).toBe(200);
    expect((await s.presence(first)).agents).toEqual([]);
    s.as(annsAgent);
    expect((await s.call(`?commits=${first}`)).status).toBe(200);
    expect((await s.presence(first)).agents.map((agent) => agent.id)).toEqual(["agt_builder"]);
    expect((await s.presence(second)).agents).toEqual([]);
  });

  test("single commit inspection records existing commits even without uploaded context", async () => {
    const s = setup();
    const commit = s.git.commit({ files: { a: "a\n" } });
    const missing = oid(99);
    const absent = await s.call(`?commits=${missing}`);
    expect(absent.status).toBe(200);
    expect(await absent.json()).toEqual({ steps: [], cursor: null });
    expect((await s.presence(missing)).agents).toEqual([]);

    const response = await s.call(`?commits=${commit}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ steps: [], cursor: null });
    expect((await s.presence(commit)).agents.map((agent) => agent.id)).toEqual(["agt_builder"]);
  });

  test.each(["lookup", "close", "lookup and close"] as const)(
    "auxiliary object %s failure preserves context without recording presence",
    async (failure) => {
      const s = setup();
      const commit = s.git.commit({ files: { a: "a\n" } });
      await s.upload(step(1, { commitOid: commit }));
      s.as(ann);
      const original = await s.call(`?commits=${commit}`);
      expect(original.status).toBe(200);
      const body = await original.json();
      s.as(annsAgent);

      const lookup = vi.spyOn(RepoReader.prototype, "commit");
      const close = vi.spyOn(RepoReader.prototype, "close");
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      if (failure !== "close")
        lookup.mockRejectedValueOnce(new Error("sensitive provider lookup details"));
      if (failure !== "lookup")
        close.mockRejectedValueOnce(new Error("sensitive provider close details"));
      try {
        const response = await s.call(`?commits=${commit}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(body);
        expect(lookup).toHaveBeenCalledWith(commit);
        expect(close).toHaveBeenCalledTimes(1);
        expect((await s.presence(commit)).agents).toEqual([]);
        expect(warnings.mock.calls).toEqual([["Recent agent presence could not be recorded."]]);
      } finally {
        lookup.mockRestore();
        close.mockRestore();
        warnings.mockRestore();
      }
    },
  );

  test("a feed that fails never fails the upload or the reads (S11)", async () => {
    const s = setup();
    s.feeds.set("repo:search", {
      publish: async () => {
        throw new Error("feed down");
      },
    } as unknown as StepFeed);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const made = await s.upload(step(1));
    expect(made.status).toBe(201);
    expect(errors).toHaveBeenCalledWith(
      "Steps: publishing to the live feed failed",
      expect.anything(),
    );
    errors.mockRestore();
    const page = (await (await s.call("?timeline=search")).json()) as StepPage;
    expect(page.steps.map((x) => x.summary)).toEqual(["Step 1"]);
  });

  test("a new timeline step goes out on its live feed, read by whoever can read the repo (CORE-239)", async () => {
    const s = setup();
    await s.upload(step(1));
    // A retry doesn't go out twice; a step outside a timeline doesn't at all.
    await s.upload(step(1));
    await s.upload(step(2, { timeline: undefined }));
    const feed = s.feeds.get("repo:search")!;
    const records = await feed.since(0);
    expect(records.map((r) => [r.seq, r.summary, r.repo, r.timeline])).toEqual([
      [1, "Step 1", "ann/app", "search"],
    ]);
    expect(records[0]).toMatchObject({
      author: { id: "agt_builder", kind: "agent", name: "builder" },
      tests: { passed: 1, failed: 0 },
      why: "Recency matters more than score here.",
    });

    // Ben can read: the stream has the step.
    s.as(ben);
    const live = await s.call("/live?timeline=search");
    expect(live.status).toBe(200);
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    const reader = live.body!.getReader();
    let text = "";
    while (!text.includes("Step 1")) text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain("id: 1\nevent: step\n");
    // Cid can't read the private repository: nothing, not even that it exists.
    s.as(cid);
    expect((await s.call("/live?timeline=search")).status).toBe(404);
    s.as(ben);
    expect((await s.call("/live?timeline=Not%20a%20slug")).status).toBe(400);
  });

  test("a step carries its step runs' artifacts, newest first (CORE-235)", async () => {
    const s = setup();
    await s.upload(step(1));
    const summary = (status: string) =>
      JSON.stringify({
        status,
        passed: 1,
        failed: 0,
        jobs: [{ name: "lint", status: "succeeded", exitCode: 0, durationMs: 900 }],
      });
    s.sqlite.exec(`
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, step)
        VALUES ('run1', 'repo', 1, '${oid(1)}', 'timeline/search', 'manual', 'failed', 1),
               ('run2', 'repo', 2, '${oid(1)}', 'timeline/search', 'manual', 'succeeded', 1);
      INSERT INTO step_artifacts (id, repo_id, commit_oid, run_id, kind, data, created_at) VALUES
        ('run1:test-summary', 'repo', '${oid(1)}', 'run1', 'test-summary', '${summary("failed")}', '2026-10-04T00:01:00.000Z'),
        ('run2:test-summary', 'repo', '${oid(1)}', 'run2', 'test-summary', '${summary("succeeded")}', '2026-10-04T00:02:00.000Z');
    `);
    const page = (await (await s.call("")).json()) as StepPage;
    expect(
      page.steps[0]!.artifacts.map((a) => [
        a.runNumber,
        a.kind,
        a.kind === "test-summary" ? a.data.status : undefined,
      ]),
    ).toEqual([
      [2, "test-summary", "succeeded"],
      [1, "test-summary", "failed"],
    ]);
    const versions = (await (await s.call("/change0001")).json()) as StepVersions;
    expect(versions.versions[0]!.artifacts).toHaveLength(2);
    await s.upload(step(2));
    const two = (await (await s.call("")).json()) as StepPage;
    expect(two.steps.find((x) => x.commitOid === oid(2))!.artifacts).toEqual([]);
  });

  test("an agent uploads a step; it reads back with its context and author", async () => {
    const s = setup();
    const made = await s.upload(step(1));
    expect(made.status).toBe(201);
    const body = (await made.json()) as Step;
    expect(body).toMatchObject({
      changeId: "change0001",
      commitOid: oid(1),
      summary: "Step 1",
      timeline: "search",
      issue: "CORE-9",
      verified: false,
      deleted: false,
      author: {
        id: "agt_builder",
        kind: "agent",
        name: "builder",
        accountable: { id: "ann", slug: "ann", displayName: "Ann" },
      },
      context: {
        why: "Recency matters more than score here.",
        steering: [{ text: "Keep the old order as a fallback", source: "hook" }],
        tests: [{ command: "vp test run search", exit: 0, origin: "local" }],
        coverage: { instructions: "hook:claude-code", steering: "hook:claude-code" },
      },
    });
  });

  test("is verified when a push has shown its commit as that change", async () => {
    const s = setup();
    s.sqlite.exec(`
      INSERT INTO ref_updates (repo_id, ref, new_oid, actor_id) VALUES ('repo', 'refs/heads/timeline/search', '${oid(2)}', 'ann');
      INSERT INTO change_refs (repo_id, change_id, ref, first_commit_oid, first_update_id, last_commit_oid)
      VALUES ('repo', 'change0002', 'refs/heads/timeline/search', '${oid(2)}', 1, '${oid(2)}');
    `);
    expect(((await (await s.upload(step(2))).json()) as Step).verified).toBe(true);
    // A different incarnation of the change isn't the commit the push showed.
    expect(
      ((await (await s.upload(step(2, { commitOid: oid(99) }))).json()) as Step).verified,
    ).toBe(false);
  });

  test("retained exact source membership verifies overwritten versions without change-ref endpoints", async () => {
    const s = setup();
    const original = step(2);
    expect(((await (await s.upload(original)).json()) as Step).verified).toBe(false);
    s.sqlite
      .prepare(
        "INSERT INTO source_progress_members(repo_id,source_id,commit_oid,operation_id,created_at) VALUES(?,?,?,?,?)",
      )
      .run("repo", "work_retained", original.commitOid, "accepted-push", "2026-10-04T00:00:00Z");
    const verified = await s.upload({ ...original, why: "Retained original revision" });
    expect((await verified.json()) as Step).toMatchObject({
      verified: true,
      context: { why: "Retained original revision" },
    });
    const rewritten = await s.upload({ ...original, commitOid: oid(99), why: "New revision" });
    expect((await rewritten.json()) as Step).toMatchObject({ verified: false, commitOid: oid(99) });
    s.as(ben);
    expect((await s.upload({ ...original, why: "Foreign overwrite" })).status).toBe(409);
    s.as(ann);
    expect(
      (await s.call(`/${original.changeId}/${original.commitOid}`, { method: "DELETE" })).status,
    ).toBe(204);
    s.as(annsAgent);
    expect((await s.upload(original)).status).toBe(410);
    const versions = (await (await s.call(`/${original.changeId}`)).json()) as StepVersions;
    expect(
      versions.versions.find((version) => version.commitOid === original.commitOid),
    ).toMatchObject({ verified: true, deleted: true, context: { why: "" } });
    expect(versions.versions.find((version) => version.commitOid === oid(99))).toMatchObject({
      deleted: false,
      context: { why: "New revision" },
    });
  });

  test("retries replace the author's own record; nobody else can overwrite it", async () => {
    const s = setup();
    await s.upload(step(1));
    const again = await s.upload(step(1, { why: "Better reason." }));
    expect(again.status).toBe(200);
    expect(((await again.json()) as Step).context.why).toBe("Better reason.");
    s.as(ben);
    expect((await s.upload(step(1))).status).toBe(409);
  });

  test("checks its input and bounds", async () => {
    const s = setup();
    expect((await s.upload(step(1, { changeId: "NOT A CHANGE" }))).status).toBe(400);
    expect((await s.upload(step(1, { commitOid: "abc" }))).status).toBe(400);
    expect((await s.upload(step(1, { committedAt: "yesterday" }))).status).toBe(400);
    // Per-field caps bound why and challenges; the overall cap bounds the rest.
    const many = Array.from({ length: STEP_LIMITS.entries }, () => ({
      text: "x".repeat(3000),
      source: "hook" as const,
    }));
    expect((await s.upload(step(1, { instructions: many }))).status).toBe(413);
    // Unknown or malformed parts are dropped, not stored.
    const odd = await s.upload({
      ...step(3),
      steering: [
        { text: "ok", source: "nonsense" as never },
        { nope: 1 } as never,
        { text: "  ", source: "hook" },
      ],
      tests: [{ command: "x" } as never],
    } as StepUpload);
    const stored = (await odd.json()) as Step;
    expect(stored.context.steering).toEqual([{ text: "ok", source: "agent" }]);
    expect(stored.context.tests).toEqual([]);
  });

  test("readers read, only writers upload, outsiders see nothing", async () => {
    const s = setup();
    await s.upload(step(1));
    s.as(cid);
    expect((await s.call("")).status).toBe(404);
    expect((await s.call("/change0001")).status).toBe(404);
    expect((await s.upload(step(2))).status).toBe(404);

    const open = setup("public");
    await open.upload(step(1));
    open.as(cid);
    expect(((await (await open.call("")).json()) as StepPage).steps).toHaveLength(1);
    expect((await open.upload(step(2))).status).toBe(403);
    open.as(null);
    expect((await open.call("")).status).toBe(200);
  });

  test("lists newest first, filters by timeline, issue and commits, and pages without repeats", async () => {
    const s = setup();
    for (let n = 1; n <= 7; n++)
      await s.upload(step(n, n > 5 ? { timeline: "other", issue: "CORE-8" } : {}));
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await (
        await s.call(`?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)
      ).json()) as StepPage;
      all.push(...page.steps.map((x) => x.summary));
      cursor = page.cursor;
    } while (cursor);
    expect(all).toEqual(["Step 7", "Step 6", "Step 5", "Step 4", "Step 3", "Step 2", "Step 1"]);
    const timeline = (await (await s.call("?timeline=search")).json()) as StepPage;
    expect(timeline.steps.map((x) => x.summary)).toEqual([
      "Step 5",
      "Step 4",
      "Step 3",
      "Step 2",
      "Step 1",
    ]);
    const issue = (await (await s.call("?issue=CORE-8")).json()) as StepPage;
    expect(issue.steps).toHaveLength(2);
    const commits = (await (
      await s.call(`?commits=${oid(2)},${oid(6)},${oid(99)}`)
    ).json()) as StepPage;
    expect(commits.steps.map((x) => x.summary)).toEqual(["Step 6", "Step 2"]);
    expect((await s.call("?commits=abc")).status).toBe(400);
    expect((await s.call("?cursor=junk")).status).toBe(400);
    expect((await s.call("?limit=500")).status).toBe(400);
  });

  test("keeps every version of an amended change", async () => {
    const s = setup();
    await s.upload(step(1));
    await s.upload(
      step(1, {
        commitOid: oid(50),
        committedAt: "2026-10-04T01:00:00.000Z",
        why: "After review.",
      }),
    );
    const versions = (await (await s.call("/change0001")).json()) as StepVersions;
    expect(versions.versions.map((v) => [v.commitOid, v.context.why])).toEqual([
      [oid(50), "After review."],
      [oid(1), "Recency matters more than score here."],
    ]);
    expect((await s.call("/nochange00")).status).toBe(404);
  });

  test("admins delete a step's context, leaving the step; it can't be re-uploaded", async () => {
    const s = setup();
    await s.upload(step(1));
    s.as(ben);
    expect((await s.call(`/change0001/${oid(1)}`, { method: "DELETE" })).status).toBe(403);
    s.as(ann);
    expect((await s.call(`/change0001/${oid(1)}`, { method: "DELETE" })).status).toBe(204);
    const [kept] = ((await (await s.call("")).json()) as StepPage).steps;
    expect(kept).toMatchObject({ deleted: true, summary: "", context: { why: "", steering: [] } });
    s.as(annsAgent);
    expect((await s.upload(step(1))).status).toBe(410);
  });

  test("deleting a step makes its live feed forget it, before the answer (CORE-399)", async () => {
    const s = setup();
    await s.upload(step(1));
    await s.upload(step(2));
    // No timeline, no feed.
    await s.upload(step(3, { timeline: undefined }));
    const feed = s.feeds.get("repo:search")!;
    expect((await feed.since(0)).map((r) => r.seq)).toEqual([1, 2]);
    s.as(ann);
    expect((await s.call(`/change0001/${oid(1)}`, { method: "DELETE" })).status).toBe(204);
    expect((await feed.since(0)).map((r) => r.summary)).toEqual(["Step 2"]);
    expect(await feed.removals()).toEqual([
      { repo: "ann/app", changeId: "change0001", commitOid: oid(1) },
    ]);
    expect((await s.call(`/change0003/${oid(3)}`, { method: "DELETE" })).status).toBe(204);
    expect([...s.feeds.keys()]).toEqual(["repo:search"]);
    // Readers are told to drop it, and its summary and why never come again.
    s.as(ben);
    const live = await s.call("/live?timeline=search&after=2");
    const reader = live.body!.getReader();
    let text = "";
    while (!text.includes("event: removed"))
      text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).toContain(
      `event: removed\ndata: {"repo":"ann/app","changeId":"change0001","commitOid":"${oid(1)}"}\n\n`,
    );
    expect(text).not.toContain("Step 1");
    expect(text).not.toContain("Recency matters");
    // Already deleted: 404, and the feed isn't told twice.
    s.as(ann);
    expect((await s.call(`/change0001/${oid(1)}`, { method: "DELETE" })).status).toBe(404);
    expect(await feed.removals()).toHaveLength(1);
  });

  test("a feed that fails never fails the deletion; the next reader's connection heals it", async () => {
    const s = setup();
    await s.upload(step(1));
    const feed = s.feeds.get("repo:search")!;
    const forget = vi.spyOn(feed, "forget").mockRejectedValueOnce(new Error("feed down"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    s.as(ann);
    try {
      expect((await s.call(`/change0001/${oid(1)}`, { method: "DELETE" })).status).toBe(204);
      expect(errors).toHaveBeenCalledWith(
        "Steps: removing a deleted step from the live feed failed",
        expect.anything(),
      );
    } finally {
      errors.mockRestore();
    }
    expect((await feed.since(0)).map((r) => r.summary)).toEqual(["Step 1"]);
    // The next connection asks D1 which steps were deleted, and the feed forgets them.
    s.as(ben);
    const live = await s.call("/live?timeline=search");
    const reader = live.body!.getReader();
    let text = "";
    while (!text.includes("event: removed"))
      text += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    expect(text).not.toContain("Step 1");
    expect(await feed.since(0)).toEqual([]);
    expect(forget).toHaveBeenCalledTimes(2);
    // Once forgotten, a connection doesn't tell anyone again.
    await (await s.call("/live?timeline=search")).body!.cancel();
    expect(await feed.removals()).toHaveLength(1);
  });
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_TWO = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

describe("step artifacts (CORE-383)", () => {
  async function ready() {
    const s = setup();
    await s.upload(step(1));
    const secret = await s.jobFor("job1", "run1");
    s.as(null);
    const put = (secret: string | null, path: string, body: BodyInit | null, type?: string) =>
      s.call(`/artifacts/${path}`, {
        method: "PUT",
        headers: { ...(secret ? bearer(secret) : {}), ...(type ? { "content-type": type } : {}) },
        body,
      });
    return { s, secret, put };
  }

  test("a job uploads a screenshot and a diagram; the step lists them", async () => {
    const { s, secret, put } = await ready();
    const shot = await put(secret, "screenshots/Home page", PNG, "text/plain");
    expect(shot.status).toBe(201);
    const stored = (await shot.json()) as Extract<StepArtifact, { kind: "screenshot" }>;
    expect(stored).toMatchObject({
      id: "run1:screenshot:Home page",
      runId: "run1",
      kind: "screenshot",
      data: { name: "Home page", contentType: "image/png", bytes: PNG.length, job: "visuals" },
    });
    expect(stored.data.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.url).toBe(
      `/api/repos/ann/app/steps/artifacts/run1%3Ascreenshot%3AHome%20page?v=${stored.data.sha256.slice(0, 16)}`,
    );
    expect([...s.files.objects.keys()]).toEqual([
      `step-artifacts/repo/run1/${stored.data.sha256}.png`,
    ]);

    const doc = await put(
      secret,
      "documents/Flow",
      JSON.stringify({ format: "mermaid", source: "graph TD; A-->B" }),
    );
    expect(doc.status).toBe(201);
    expect(await doc.json()).toMatchObject({
      id: "run1:document:Flow",
      kind: "document",
      data: { name: "Flow", format: "mermaid", source: "graph TD; A-->B", job: "visuals" },
    });

    s.as(ann);
    const page = (await (await s.call("")).json()) as StepPage;
    const artifacts = page.steps.find((x) => x.commitOid === oid(1))!.artifacts;
    expect(artifacts.map((a) => [a.kind, a.id])).toEqual([
      ["document", "run1:document:Flow"],
      ["screenshot", "run1:screenshot:Home page"],
    ]);
    expect(artifacts.find((a) => a.kind === "screenshot")).toMatchObject({ url: stored.url });
    expect(artifacts.find((a) => a.kind === "document")).not.toHaveProperty("url");
  });

  test("only a job's own credential uploads, only for its own repository", async () => {
    const { s, secret, put } = await ready();
    expect((await put(null, "screenshots/a", PNG)).status).toBe(401);
    expect((await put("gmj_unknown", "screenshots/a", PNG)).status).toBe(401);
    expect((await put("gm_personal_token", "screenshots/a", PNG)).status).toBe(401);
    // A person (with write access) is not a job.
    s.as(ann);
    expect((await put(null, "screenshots/a", PNG)).status).toBe(401);
    s.as(null);
    // Another repository's job.
    s.sqlite.exec(`
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('repo2', 'ann', 'other', 'private', 'steps-${crypto.randomUUID()}', 'https://a');
    `);
    const stranger = await s.jobFor("job2", "run2", "repo2");
    expect((await put(stranger, "screenshots/a", PNG)).status).toBe(403);
    // An ended job.
    s.sqlite.exec("UPDATE ci_jobs SET status = 'succeeded' WHERE id = 'job1'");
    expect((await put(secret, "screenshots/a", PNG)).status).toBe(401);
    expect(s.files.objects.size).toBe(0);
  });

  test("a job's credential reaches artifact uploads and no other steps route", async () => {
    const route = (path: string) =>
      jobRoute({
        req: { header: () => "Bearer gmj_x", path },
      } as unknown as Parameters<typeof jobRoute>[0]);
    const base = "/api/repos/ann/app/steps";
    expect(route(`${base}/artifacts/screenshots/home`)).toBe(true);
    expect(route(`${base}/artifacts/documents/flow`)).toBe(true);
    for (const other of ["", "/live", "/change0001", "/change0001/" + oid(1), "/artifactsx/a"])
      expect(route(base + other)).toBe(false);
    // Past the middleware, a job (no actor) can't use the person routes either.
    const { s, secret } = await ready();
    expect((await s.call("", { headers: bearer(secret) })).status).toBe(404);
    expect(
      (await s.call("", { method: "POST", headers: bearer(secret), body: JSON.stringify(step(2)) }))
        .status,
    ).toBe(401);
  });

  test("names are checked; only PNG, JPEG and WebP bytes are accepted", async () => {
    const { s, secret, put } = await ready();
    expect((await put(secret, "screenshots/.hidden", PNG)).status).toBe(400);
    expect((await put(secret, `screenshots/${"x".repeat(81)}`, PNG)).status).toBe(400);
    expect((await put(secret, "screenshots/a%2Fb", PNG)).status).toBe(400);
    expect((await put(secret, "documents/.hidden", "{}")).status).toBe(400);
    expect((await put(secret, "screenshots/ok name", SVG, "image/png")).status).toBe(415);
    expect((await put(secret, "screenshots/ok name", new Uint8Array(), "image/png")).status).toBe(
      415,
    );
    expect(
      (await put(secret, "screenshots/ok name", Uint8Array.from([0xff, 0xd8, 0xff, 1]))).status,
    ).toBe(201);
    expect(
      (await put(secret, "screenshots/webp", new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ")))
        .status,
    ).toBe(201);
    const big = new Uint8Array(STEP_ARTIFACT_LIMITS.imageBytes + 1);
    big.set(PNG);
    expect((await put(secret, "screenshots/big", big)).status).toBe(413);
    expect(s.sqlite.prepare("SELECT COUNT(*) AS n FROM step_artifacts").get()!.n).toBe(2);
  });

  test("a diagram is JSON with mermaid source within the limit", async () => {
    const { put, secret } = await ready();
    const doc = (body: unknown) => put(secret, "documents/d", JSON.stringify(body));
    expect((await put(secret, "documents/d", "not json")).status).toBe(400);
    expect((await doc({ format: "dot", source: "digraph {}" })).status).toBe(400);
    expect((await doc({ format: "mermaid", source: "  " })).status).toBe(400);
    expect((await doc({ format: "mermaid" })).status).toBe(400);
    expect(
      (
        await doc({
          format: "mermaid",
          source: "a".repeat(STEP_ARTIFACT_LIMITS.documentChars + 1),
        })
      ).status,
    ).toBe(413);
    expect((await doc({ format: "mermaid", source: "graph TD; A-->B" })).status).toBe(201);
  });

  test("re-uploading a name replaces it and its old image; a shared image stays", async () => {
    const { s, secret, put } = await ready();
    const first = (await (await put(secret, "screenshots/home", PNG)).json()) as Extract<
      StepArtifact,
      { kind: "screenshot" }
    >;
    // The same picture under a second name shares the object.
    await put(secret, "screenshots/copy", PNG);
    expect(s.files.objects.size).toBe(1);
    const again = await put(secret, "screenshots/home", PNG_TWO);
    expect(again.status).toBe(200);
    const second = (await again.json()) as Extract<StepArtifact, { kind: "screenshot" }>;
    expect(second.data.sha256).not.toBe(first.data.sha256);
    expect(
      s.sqlite.prepare("SELECT COUNT(*) AS n FROM step_artifacts WHERE kind = 'screenshot'").get()!
        .n,
    ).toBe(2);
    // "copy" still shows the old image, so it stays; replace it and it goes.
    expect(s.files.objects.size).toBe(2);
    await put(secret, "screenshots/copy", PNG_TWO);
    expect([...s.files.objects.keys()]).toEqual([
      `step-artifacts/repo/run1/${second.data.sha256}.png`,
    ]);
    // Uploading the same bytes again keeps the object.
    expect((await put(secret, "screenshots/home", PNG_TWO)).status).toBe(200);
    expect(s.files.objects.size).toBe(1);
  });

  test("a run attaches a bounded number, though replacing one is always allowed", async () => {
    const { s, secret, put } = await ready();
    for (let n = 0; n < STEP_ARTIFACT_LIMITS.perRun; n++)
      expect(
        (await put(secret, `documents/d${n}`, JSON.stringify({ format: "mermaid", source: "a" })))
          .status,
      ).toBe(201);
    expect((await put(secret, "screenshots/one-too-many", PNG)).status).toBe(409);
    expect(
      (await put(secret, "documents/d0", JSON.stringify({ format: "mermaid", source: "b" })))
        .status,
    ).toBe(200);
    // The test summary doesn't count, and another run starts fresh.
    const next = await s.jobFor("job3", "run3");
    expect((await put(next, "screenshots/fresh", PNG)).status).toBe(201);
  });

  test("readers fetch the image with hardened headers; others can't see it", async () => {
    const { s, secret, put } = await ready();
    const stored = (await (await put(secret, "screenshots/Home page", PNG)).json()) as Extract<
      StepArtifact,
      { kind: "screenshot" }
    >;
    const path = stored.url.slice("/api/repos/ann/app/steps".length);
    s.as(ben);
    const res = await s.call(path);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    // Without the current hash in the link, the bytes may have been replaced.
    const bare = await s.call(path.split("?")[0]!);
    expect(bare.headers.get("cache-control")).toBe("private, no-cache");
    const stale = await s.call(`${path.split("?")[0]}?v=0000000000000000`);
    expect(stale.headers.get("cache-control")).toBe("private, no-cache");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // A document has no image; an unknown id is missing; a stranger can't tell it exists.
    await put(secret, "documents/Flow", JSON.stringify({ format: "mermaid", source: "a" }));
    expect((await s.call(`/artifacts/${encodeURIComponent("run1:document:Flow")}`)).status).toBe(
      404,
    );
    expect((await s.call("/artifacts/nope")).status).toBe(404);
    s.as(cid);
    expect((await s.call(path)).status).toBe(404);
    s.as(null);
    expect((await s.call(path)).status).toBe(404);
  });

  test("an image is served only through its own repository", async () => {
    const { s, secret, put } = await ready();
    const stored = (await (await put(secret, "screenshots/a", PNG)).json()) as Extract<
      StepArtifact,
      { kind: "screenshot" }
    >;
    s.sqlite.exec(`
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('repo2', 'ann', 'other', 'public', 'steps-${crypto.randomUUID()}', 'https://a');
    `);
    const res = await s.other(`/artifacts/${encodeURIComponent(stored.id)}`);
    expect(res.status).toBe(404);
  });

  test("an artifact whose data isn't the expected shape is skipped, not fatal", async () => {
    const { s } = await ready();
    s.as(ann);
    s.sqlite.exec(`
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, step)
        VALUES ('runx', 'repo', 9, '${oid(1)}', 'timeline/search', 'manual', 'succeeded', 1);
      INSERT INTO step_artifacts (id, repo_id, commit_oid, run_id, kind, data, created_at) VALUES
        ('runx:screenshot:bad', 'repo', '${oid(1)}', 'runx', 'screenshot', '{"name":1}', '2026-10-04T00:01:00.000Z'),
        ('runx:document:bad', 'repo', '${oid(1)}', 'runx', 'document', 'not json', '2026-10-04T00:02:00.000Z');
    `);
    const page = (await (await s.call("")).json()) as StepPage;
    expect(page.steps[0]!.artifacts).toEqual([]);
  });

  test("retention removes a screenshot's image with its row, unless another row shows it", async () => {
    const { s, secret, put } = await ready();
    await put(secret, "screenshots/a", PNG);
    await put(secret, "screenshots/b", PNG);
    await put(secret, "screenshots/c", PNG_TWO);
    s.sqlite.exec(
      "UPDATE step_artifacts SET created_at = '2020-01-01T00:00:00.000Z' WHERE id LIKE '%:screenshot:_'",
    );
    // Only "b" and "c" are old enough to remove below.
    s.sqlite.exec(
      "UPDATE step_artifacts SET created_at = '2099-01-01T00:00:00.000Z' WHERE id LIKE '%:screenshot:a'",
    );
    const ctx = {
      env: s.env,
      now: new Date("2026-10-12T00:00:00.000Z"),
      limit: 100,
      thresholds: { days: 90 },
      target: { scope: "account", accountId: "ann" },
    } as unknown as Parameters<typeof stepArtifacts.select>[0];
    const selected = await stepArtifacts.select(ctx, null);
    expect(selected.items.map((i) => i.id)).toEqual(["run1:screenshot:b", "run1:screenshot:c"]);
    expect(selected.bytes).toBeGreaterThan(PNG.length + PNG_TWO.length);
    const removed = await stepArtifacts.remove(ctx, selected.items);
    expect(removed.count).toBe(2);
    // "a" still shows the shared PNG; the other image went.
    expect([...s.files.objects.keys()]).toEqual([
      `step-artifacts/repo/run1/${await sha256(PNG)}.png`,
    ]);
    expect(s.files.objects.has(`step-artifacts/repo/run1/${await sha256(PNG_TWO)}.png`)).toBe(
      false,
    );
  });
});
