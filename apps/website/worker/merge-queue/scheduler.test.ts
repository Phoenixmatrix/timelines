import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import { LEGACY_AI_SNAPSHOT } from "../../shared/ai.ts";
import {
  queueCandidateBranch,
  queueSourceBranch,
  type QueueDecision,
} from "../../shared/merge-queue.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { captureWorkAuthority } from "../ci/admission.ts";
import { runOutcome } from "../ci/landing.ts";
import { startRun } from "../ci/trigger.ts";
import type { QueueDeps } from "./deps.ts";
import { progressQueue, ancestor } from "./scheduler.ts";
import {
  admitQueue,
  cancelCombined,
  getQueue,
  saveQueue,
  type QueueState,
  type StoredQueue,
} from "./store.ts";
import * as queueStore from "./store.ts";
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    public ctx: DurableObjectState;
    public env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
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
const environments: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of environments.splice(0)) close();
});
const oid = (n: number) => n.toString(16).padStart(40, "0");
async function setup() {
  const { sqlite, env, close } = await createFreshSpaceTestEnvironment();
  environments.push(close);
  Object.assign(env, { CI_RUNNER: "local" });
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner'); INSERT INTO access_tokens(id,user_id,name,scope,token_hash,last_four) VALUES('owner-token','owner','Queue','write','queue-token-hash','hash');",
  );
  await seedSpaceFixture(env.DB, {
    organization: {
      id: "organization",
      slug: "organization",
      displayName: "Organization",
      kind: "personal",
      personalAccountId: "owner",
    },
    space: { id: "space", slug: "owner", displayName: "Queue Space" },
    members: [
      {
        accountId: "owner",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "owner",
  });
  sqlite.exec(
    "INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES('repo','space','app','private','a','https://a')",
  );
  const authority = await captureWorkAuthority(env, "repo", {
    id: "owner",
    credential: { kind: "token", id: "owner-token" },
  });
  const refs = new Map([["refs/heads/main", oid(1)]]),
    parents = new Map<string, string[]>();
  let sequence = 0;
  const behavior = {
    gates: "succeeded",
    merge: "succeeded",
    deploy: "succeeded",
    badParents: false,
    uncertainCas: false,
    trackerFails: false,
    effectsFail: false,
    combine: false,
  };
  const insertRun = (s: StoredQueue, kind: "merge" | "gates" | "deploy") => {
    const id = kind === "merge" ? s.mergeRunId! : kind === "gates" ? s.gateRunId! : s.deployRunId!;
    const status =
      kind === "merge" ? behavior.merge : kind === "gates" ? behavior.gates : behavior.deploy;
    const existing = sqlite.prepare("SELECT number FROM ci_runs WHERE id=?").get(id) as
      | { number: number }
      | undefined;
    if (existing) return { runId: id, number: existing.number };
    const number = ++sequence;
    sqlite
      .prepare(
        "INSERT INTO ci_runs(id,repo_id,number,commit_oid,ref,trigger,status,queue_id,space_id,migration_epoch,authority,actor_id,agent_id) VALUES(?,'repo',?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        number,
        kind === "merge" ? s.mergeSource : s.entry.candidate!,
        kind === "deploy" ? "main" : s.entry.candidateBranch,
        kind === "deploy" ? "push" : "manual",
        status === "skipped" ? "succeeded" : status,
        kind === "deploy" ? null : s.entry.id,
        s.authority.spaceId,
        s.authority.migrationEpoch,
        JSON.stringify(s.authority),
        s.authority.personId,
        s.authority.agentId,
      );
    sqlite
      .prepare(
        "INSERT INTO ci_jobs(id,run_id,repo_id,name,spec,status,runner,exit_code) VALUES(?,?,'repo',?,?,?,'local',?)",
      )
      .run(
        id + "j",
        id,
        kind === "merge" ? "land" : "check",
        JSON.stringify({ if: null }),
        status,
        kind === "merge" && status === "failed" ? 42 : 0,
      );
    return { runId: id, number };
  };
  const deps: QueueDeps = {
    refs: async () => new Map(refs),
    parents: async (_repo, commit) => parents.get(commit) ?? [],
    write: vi.fn<QueueDeps["write"]>(async (_repo, writes) =>
      writes.map((write) => {
        const ok =
          (refs.get(write.ref) ?? null) === (write.old === "0".repeat(40) ? null : write.old);
        if (ok) {
          if (write.new) refs.set(write.ref, write.new);
          else refs.delete(write.ref);
        }
        if (write.ref === "refs/heads/main" && ok && behavior.uncertainCas)
          throw new Error("response lost after CAS");
        return { ref: write.ref, ok, ...(ok ? {} : { reason: "CAS lost" }) };
      }),
    ),
    merge: vi.fn(async (_repo, s) => {
      const candidate = oid(100 + s.entry.attempts + sequence);
      refs.set(`refs/heads/${s.entry.candidateBranch}`, candidate);
      parents.set(
        candidate,
        behavior.badParents ? [oid(999), s.mergeSource] : [s.entry.base!, s.mergeSource],
      );
      return insertRun(s, "merge");
    }),
    gates: vi.fn(async (_repo, s) =>
      behavior.gates === "none" ? { skipped: "No configured gates" } : insertRun(s, "gates"),
    ),
    deploy: vi.fn(async (_repo, s) => insertRun(s, "deploy")),
    outcome: (id) => runOutcome(env.DB, id),
    recover: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    effects: vi.fn(async () => {
      if (behavior.effectsFail) throw new Error("effects unavailable");
    }),
    classify: vi.fn<QueueDeps["classify"]>(async () => ({
      action: behavior.combine ? "combine" : "separate",
      reason: "scheduling verdict",
      model: behavior.combine ? "clef" : null,
      confidence: behavior.combine ? 0.99 : null,
    })),
    remediate: vi.fn(async () => {
      if (behavior.trackerFails) throw new Error("Tracker unavailable");
      return { id: "remediation" };
    }),
    // Retries in place are tested on their own below.
    stepRetryMs: [],
  };
  async function admit(n: number) {
    const commit = oid(n),
      now = new Date(1700000000000 + n).toISOString();
    refs.set(`refs/heads/${queueSourceBranch(commit)}`, commit);
    const state: QueueState = {
      entry: {
        id: commit,
        repo: { id: "repo", space: "owner", name: "app" },
        commit,
        branch: "main",
        sourceBranch: queueSourceBranch(commit),
        candidateBranch: queueCandidateBranch(commit),
        status: "queued",
        base: null,
        candidate: null,
        mergeRun: null,
        gateRun: null,
        deployRun: null,
        deployStatus: null,
        coveredBy: null,
        issueIds: [],
        remediationIssueId: null,
        failure: null,
        decision: null,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      },
      authority,
      actor: { id: "owner" },
      snapshot: LEGACY_AI_SNAPSHOT,
      mergeSource: commit,
      combinedIds: [],
      rebaseAttempts: 0,
      mergeRunId: null,
      gateRunId: null,
      deployRunId: null,
      resolution: null,
      resolutionInput: null,
      resolutionClaimed: false,
      classificationClaimed: false,
      effectsPending: false,
      remediationPending: false,
      history: [],
    };
    await admitQueue(env.DB, state);
    return state;
  }
  const state = async (n: number) => (await getQueue(env.DB, "repo", oid(n)))!;
  const progress = () => progressQueue(env, "repo", () => {}, deps);
  async function settle(n: number) {
    for (let i = 0; i < 12; i++) {
      await progress();
      if (["landed", "failed", "cancelled", "covered"].includes((await state(n)).entry.status))
        return;
    }
  }
  return { sqlite, env, refs, parents, deps, behavior, admit, state, progress, settle };
}

const MIXED_TRIGGER_PIPELINE = `
on: [push, step, preview]
jobs:
  check:
    steps: [check]
  shared:
    on: [push, step]
    steps: [shared-check]
  step-only:
    on: step
    steps: [step-check]
  preview-only:
    on: preview
    steps: [preview-check]
`;

function usePersistedPipeline(
  t: { env: Env; sqlite: DatabaseSync; deps: QueueDeps },
  pipeline = MIXED_TRIGGER_PIPELINE,
) {
  files.ciYml = pipeline;
  Object.assign(t.env, { CI_RUN: { create: vi.fn(async () => {}) } });
  const start = async (s: StoredQueue, deploy: boolean) => {
    const result = await startRun(
      t.env,
      { id: "repo", artifacts_name: "a", artifacts_remote: "https://a" },
      {
        branch: deploy ? "main" : s.entry.candidateBranch,
        commit: s.entry.candidate!,
        trigger: deploy ? "push" : "landing",
        queueId: deploy ? undefined : s.entry.id,
        runId: deploy ? s.deployRunId! : s.gateRunId!,
        actor: s.actor,
        authority: s.authority,
        waitUntil: () => {},
      },
    );
    if ("runId" in result && deploy) {
      t.sqlite
        .prepare(
          "UPDATE ci_jobs SET status='succeeded',exit_code=0 WHERE run_id=? AND status='pending'",
        )
        .run(result.runId);
      t.sqlite.prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?").run(result.runId);
    }
    return result;
  };
  t.deps.gates = vi.fn(async (_repo, s) => start(s, false));
  t.deps.deploy = vi.fn(async (_repo, s) => start(s, true));
}
describe("durable independent merge queue", () => {
  test.each(["grant", "credential"] as const)(
    "revoking the initiating %s blocks queued execution without losing its authority",
    async (kind) => {
      const t = await setup();
      const admitted = await t.admit(2);
      if (kind === "grant") t.sqlite.exec("DELETE FROM space_grants WHERE space_id='space'");
      else t.sqlite.exec("DELETE FROM access_tokens WHERE id='owner-token'");
      vi.spyOn(console, "error").mockImplementation(() => {});
      await t.progress();
      expect(t.deps.merge).not.toHaveBeenCalled();
      expect(t.deps.gates).not.toHaveBeenCalled();
      expect(t.deps.write).not.toHaveBeenCalled();
      expect(t.refs.get("refs/heads/main")).toBe(oid(1));
      expect((await t.state(2)).authority).toEqual(admitted.authority);
    },
  );
  test("concurrent admissions and progress claim one repository slot, land once, and retain exact gate proof", async () => {
    const t = await setup(),
      s = await t.admit(2);
    expect(await Promise.all(Array.from({ length: 4 }, () => admitQueue(t.env.DB, s)))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    await t.admit(3);
    await Promise.all(Array.from({ length: 6 }, () => t.progress()));
    const active = t.sqlite
      .prepare("SELECT id FROM merge_queue WHERE status IN ('merging','testing','advancing')")
      .all();
    expect(active).toHaveLength(1);
    await t.settle(2);
    await t.settle(3);
    expect((await t.state(2)).entry.status).toBe("landed");
    expect((await t.state(3)).entry.status).toBe("landed");
    expect(t.refs.get("refs/heads/main")).toBe((await t.state(3)).entry.candidate);
    expect((await t.state(3)).entry.base).toBe((await t.state(2)).entry.candidate);
  });
  test("persisted trigger restrictions let successful landing gates advance main and finish deployment", async () => {
    const t = await setup();
    usePersistedPipeline(t);
    await t.admit(2);
    await t.settle(2);
    const testing = await t.state(2);
    expect(testing.entry.status).toBe("testing");
    expect(
      t.sqlite
        .prepare("SELECT name,status FROM ci_jobs WHERE run_id=? ORDER BY name")
        .all(testing.gateRunId!),
    ).toEqual([
      { name: "check", status: "pending" },
      { name: "preview-only", status: "skipped" },
      { name: "shared", status: "pending" },
      { name: "step-only", status: "skipped" },
    ]);
    // Simulate runner completion, leaving startRun's skipped jobs and specs untouched.
    t.sqlite
      .prepare(
        "UPDATE ci_jobs SET status='succeeded',exit_code=0 WHERE run_id=? AND status='pending'",
      )
      .run(testing.gateRunId!);
    t.sqlite.prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?").run(testing.gateRunId!);
    await t.settle(2);
    await t.progress();
    const landed = await t.state(2);
    expect(landed.entry.status).toBe("landed");
    expect(t.refs.get("refs/heads/main")).toBe(testing.entry.candidate);
    expect(landed.entry.gateRun).toBe(testing.entry.gateRun);
    expect(landed.entry.deployRun).toEqual(expect.any(Number));
    expect(landed.entry.deployStatus).toBe("succeeded");
    expect(landed.entry.failure).toBeNull();
    expect(t.deps.remediate).not.toHaveBeenCalled();
  });
  test.each(["failed", "skipped"])(
    "a persisted push-and-step gate that is %s still blocks main despite another successful gate",
    async (status) => {
      const t = await setup();
      usePersistedPipeline(t);
      await t.admit(2);
      await t.settle(2);
      const testing = await t.state(2);
      t.sqlite
        .prepare(
          "UPDATE ci_jobs SET status='succeeded',exit_code=0 WHERE run_id=? AND name='check'",
        )
        .run(testing.gateRunId!);
      t.sqlite
        .prepare("UPDATE ci_jobs SET status=? WHERE run_id=? AND name='shared'")
        .run(status, testing.gateRunId!);
      // Even a successful aggregate cannot substitute for the required job's evidence.
      t.sqlite.prepare("UPDATE ci_runs SET status='succeeded' WHERE id=?").run(testing.gateRunId!);
      await t.settle(2);
      expect((await t.state(2)).entry.status).toBe("failed");
      expect((await t.state(2)).entry.failure).toMatchObject({
        stage: "gates",
        kind: "configuration",
      });
      expect(t.refs.get("refs/heads/main")).toBe(oid(1));
      expect(t.deps.deploy).not.toHaveBeenCalled();
    },
  );
  test("a persisted step-only pipeline has no runnable landing gates and never advances main", async () => {
    const t = await setup();
    usePersistedPipeline(t, "on: step\njobs:\n  step-only:\n    on: step\n    steps: [check]\n");
    await t.admit(2);
    await t.settle(2);
    expect((await t.state(2)).entry.status).toBe("failed");
    expect((await t.state(2)).entry.failure).toMatchObject({
      stage: "gates",
      kind: "configuration",
    });
    expect(t.refs.get("refs/heads/main")).toBe(oid(1));
    expect(t.deps.deploy).not.toHaveBeenCalled();
  });
  test.each(["failed", "skipped", "none"])(
    "%s gates fail closed and the next good submission still lands",
    async (gates) => {
      const t = await setup();
      await t.admit(2);
      t.behavior.gates = gates;
      t.behavior.trackerFails = true;
      await t.settle(2);
      expect((await t.state(2)).entry.status).toBe("failed");
      expect((await t.state(2)).remediationPending).toBe(true);
      expect(t.refs.get("refs/heads/main")).toBe(oid(1));
      t.behavior.gates = "succeeded";
      await t.admit(3);
      await t.settle(3);
      expect((await t.state(3)).entry.status).toBe("landed");
    },
  );
  test("wrong ordered candidate parents never start gates or advance main", async () => {
    const t = await setup();
    t.behavior.badParents = true;
    await t.admit(2);
    await t.settle(2);
    expect((await t.state(2)).entry.failure?.reason).toMatch(/parents/);
    expect(t.deps.gates).not.toHaveBeenCalled();
    expect(t.refs.get("refs/heads/main")).toBe(oid(1));
  });
  test("uncertain successful main CAS is recognized without a second merge", async () => {
    const t = await setup();
    t.behavior.uncertainCas = true;
    await t.admit(2);
    await t.settle(2);
    expect((await t.state(2)).entry.status).toBe("landed");
    expect(t.deps.merge).toHaveBeenCalledTimes(1);
  });
  test("a stale main requires a fresh candidate, attempt ref, and gates", async () => {
    const t = await setup();
    await t.admit(2);
    await t.progress();
    await t.progress();
    const previous = await t.state(2);
    expect(previous.entry.status).toBe("testing");
    t.refs.set("refs/heads/main", oid(9));
    await t.settle(2);
    const landed = await t.state(2);
    expect(landed.entry.status).toBe("landed");
    expect(landed.entry.base).toBe(oid(9));
    expect(landed.entry.attempts).toBe(2);
    expect(landed.entry.candidateBranch).not.toBe(previous.entry.candidateBranch);
    expect(t.deps.gates).toHaveBeenCalledTimes(2);
  });
  test("late old-attempt state cannot overwrite a cancellation and retry", async () => {
    const t = await setup();
    await t.admit(2);
    await t.progress();
    const old = await t.state(2);
    const cancelled = await saveQueue(t.env.DB, old, {
      ...old,
      entry: { ...old.entry, status: "cancelled" },
    });
    expect(cancelled).not.toBeNull();
    const retried = await saveQueue(t.env.DB, cancelled!, {
      ...cancelled!,
      entry: { ...cancelled!.entry, status: "queued", decision: null },
    });
    expect(retried).not.toBeNull();
    expect(
      await saveQueue(t.env.DB, old, { ...old, entry: { ...old.entry, status: "advancing" } }),
    ).toBeNull();
    await t.settle(2);
    const latest = await t.state(2);
    expect(latest.entry.status).toBe("landed");
    expect(latest.entry.attempts).toBe(2);
    expect(latest.mergeRunId).not.toBe(old.mergeRunId);
  });
  test("missing merge rows and missing Workflow callbacks are recovered from durable queue state", async () => {
    const t = await setup();
    await t.admit(2);
    await t.progress();
    let s = await t.state(2);
    t.sqlite.prepare("DELETE FROM ci_runs WHERE id=?").run(s.mergeRunId!);
    await t.progress();
    await t.settle(2);
    s = await t.state(2);
    expect(s.entry.status).toBe("landed");
    expect(t.deps.merge).toHaveBeenCalledTimes(2);
  });
  test("a running gate whose start lost its answer is still reported on the entry", async () => {
    const t = await setup();
    t.behavior.gates = "running";
    const gates = t.deps.gates;
    // The run row commits, then the Workflow start's response is lost (CORE-256).
    t.deps.gates = vi.fn<QueueDeps["gates"]>(async (repo, s) => {
      await gates(repo, s);
      throw new Error("Workflow start response lost");
    });
    await t.admit(2);
    for (let i = 0; i < 3; i++) await t.progress();
    const s = await t.state(2);
    const run = t.sqlite.prepare("SELECT number FROM ci_runs WHERE id=?").get(s.gateRunId!) as {
      number: number;
    };
    expect(s.entry.status).toBe("testing");
    expect(s.entry.gateRun).toBe(run.number);
    expect(t.deps.gates).toHaveBeenCalledTimes(1);
    expect(t.deps.recover).toHaveBeenCalledWith(s.gateRunId);
  });
  test("concurrent recovery never starts a merge while a paid scheduling claim is in flight", async () => {
    const t = await setup();
    await t.admit(2);
    const entered = Promise.withResolvers<void>(),
      answer = Promise.withResolvers<QueueDecision>();
    t.deps.classify = vi.fn(async () => {
      entered.resolve();
      return answer.promise;
    });
    const first = t.progress();
    await entered.promise;
    await t.progress();
    expect(t.deps.merge).not.toHaveBeenCalled();
    expect(t.deps.classify).toHaveBeenCalledTimes(1);
    answer.resolve({ action: "separate", reason: "Separate", model: null, confidence: null });
    await first;
  });
  test("only proven descendants are covered and a combined failure splits the members", async () => {
    const t = await setup();
    t.behavior.combine = true;
    t.behavior.gates = "failed";
    await t.admit(2);
    await t.admit(3);
    await t.admit(4);
    t.parents.set(oid(3), [oid(2)]);
    await t.progress();
    expect((await t.state(3)).entry.coveredBy).toBe(oid(2));
    expect((await t.state(4)).entry.coveredBy).toBeNull();
    await t.settle(2);
    expect((await t.state(2)).entry.status).toBe("failed");
    expect((await t.state(3)).entry.coveredBy).toBeNull();
    t.behavior.gates = "succeeded";
    await t.settle(3);
    expect((await t.state(3)).entry.status).toBe("landed");
  });
  test("combined cancellation fences the candidate but requeues unrelated submissions", async () => {
    const t = await setup();
    t.behavior.combine = true;
    await t.admit(2);
    await t.admit(3);
    t.parents.set(oid(3), [oid(2)]);
    await t.progress();
    const leader = await t.state(2),
      member = await t.state(3);
    expect(await cancelCombined(t.env.DB, member, leader)).toBe(true);
    expect((await t.state(2)).entry.status).toBe("queued");
    expect((await t.state(3)).entry.status).toBe("cancelled");
    expect(
      await saveQueue(t.env.DB, leader, {
        ...leader,
        entry: { ...leader.entry, status: "advancing" },
      }),
    ).toBeNull();
    await t.settle(2);
    expect((await t.state(2)).mergeSource).toBe(oid(2));
    expect((await t.state(2)).entry.status).toBe("landed");
  });
  test("a paused old release cannot detach a recombined member from its new cancellation fence", async () => {
    const t = await setup();
    t.behavior.combine = true;
    await t.admit(2);
    await t.admit(3);
    t.parents.set(oid(3), [oid(2)]);
    await t.progress();
    await t.progress();
    expect((await t.state(2)).entry.status).toBe("testing");
    t.refs.set("refs/heads/main", oid(9));
    const entered = Promise.withResolvers<void>(),
      resume = Promise.withResolvers<void>(),
      read = queueStore.getQueue;
    let paused = false;
    vi.spyOn(queueStore, "getQueue").mockImplementation(async (database, repo, id) => {
      if (
        !paused &&
        id === oid(3) &&
        (await read(database, repo, oid(2)))?.entry.status === "queued"
      ) {
        paused = true;
        entered.resolve();
        await resume.promise;
      }
      return read(database, repo, id);
    });
    const stale = t.progress();
    await entered.promise;
    t.behavior.gates = "running";
    await t.progress();
    await t.progress();
    const recombined = await t.state(2);
    expect(recombined.entry.attempts).toBe(2);
    expect(recombined.entry.status).toBe("testing");
    resume.resolve();
    await stale;
    const member = await t.state(3),
      leader = await t.state(2);
    expect(member.entry.coveredBy).toBe(leader.entry.id);
    expect(await cancelCombined(t.env.DB, member, leader)).toBe(true);
    t.behavior.gates = "succeeded";
    await t.settle(2);
    const landed = await t.state(2);
    expect(landed.entry.status).toBe("landed");
    expect(landed.mergeSource).toBe(oid(2));
    expect((await t.state(3)).entry.status).toBe("cancelled");
    expect(
      await ancestor(
        t.deps,
        {
          id: "repo",
          space_id: "space",
          space_slug: "owner",
          name: "app",
          default_branch: "main",
          artifacts_name: "a",
          artifacts_remote: "https://a",
        },
        oid(3),
        t.refs.get("refs/heads/main")!,
      ),
    ).toBe(false);
  });
  test("progression releases old members even when its recovery pre-pass preceded the requeue", async () => {
    const t = await setup();
    t.behavior.combine = true;
    await t.admit(2);
    await t.admit(3);
    t.parents.set(oid(3), [oid(2)]);
    await t.progress();
    await t.progress();
    const beforeLoop = Promise.withResolvers<void>(),
      resumeLoop = Promise.withResolvers<void>(),
      beforeRelease = Promise.withResolvers<void>(),
      resumeRelease = Promise.withResolvers<void>(),
      list = queueStore.listQueue,
      read = queueStore.getQueue;
    let lists = 0,
      pausedRelease = false;
    vi.spyOn(queueStore, "listQueue").mockImplementation(async (database, repo) => {
      if (++lists === 2) {
        beforeLoop.resolve();
        await resumeLoop.promise;
      }
      return list(database, repo);
    });
    const alreadyScanned = t.progress();
    await beforeLoop.promise;
    vi.spyOn(queueStore, "getQueue").mockImplementation(async (database, repo, id) => {
      if (
        !pausedRelease &&
        id === oid(3) &&
        (await read(database, repo, oid(2)))?.entry.status === "queued"
      ) {
        pausedRelease = true;
        beforeRelease.resolve();
        await resumeRelease.promise;
      }
      return read(database, repo, id);
    });
    t.refs.set("refs/heads/main", oid(9));
    const requeue = t.progress();
    await beforeRelease.promise;
    t.behavior.combine = false;
    resumeLoop.resolve();
    await alreadyScanned;
    expect((await t.state(2)).entry.attempts).toBe(2);
    expect((await t.state(3)).entry.coveredBy).toBeNull();
    resumeRelease.resolve();
    await requeue;
    await t.settle(2);
    await t.settle(3);
    expect((await t.state(2)).entry.status).toBe("landed");
    expect((await t.state(3)).entry.status).toBe("landed");
  });
  test("successful coverage is only reported after the real candidate lands", async () => {
    const t = await setup();
    t.behavior.combine = true;
    await t.admit(2);
    await t.admit(3);
    t.parents.set(oid(3), [oid(2)]);
    await t.progress();
    expect((await t.state(3)).entry.status).toBe("queued");
    await t.settle(2);
    expect((await t.state(3)).entry.status).toBe("covered");
    expect((await t.state(3)).entry.candidate).toBe((await t.state(2)).entry.candidate);
  });
  test("main effects and remediation recover independently after landing", async () => {
    const t = await setup();
    t.behavior.effectsFail = true;
    await t.admit(2);
    await t.settle(2);
    expect((await t.state(2)).entry.status).toBe("landed");
    expect((await t.state(2)).effectsPending).toBe(true);
    t.behavior.effectsFail = false;
    await t.progress();
    expect((await t.state(2)).effectsPending).toBe(false);
    expect((await t.state(2)).entry.deployStatus).toBe("succeeded");
  });
  test("notification outage cannot block deployment startup or its failure remediation", async () => {
    const t = await setup();
    t.behavior.effectsFail = true;
    t.behavior.deploy = "failed";
    await t.admit(2);
    await t.settle(2);
    const failed = await t.state(2);
    expect(failed.effectsPending).toBe(true);
    expect(failed.entry.deployStatus).toBe("failed");
    expect(failed.entry.failure).toMatchObject({ stage: "deployment", failedJobs: ["check"] });
    expect(failed.entry.remediationIssueId).toBe("remediation");
    await t.progress();
    expect(t.deps.remediate).toHaveBeenCalledTimes(1);
    t.behavior.effectsFail = false;
    await t.progress();
    expect((await t.state(2)).effectsPending).toBe(false);
  });
  test.each(["succeeded", "failed", "missing"] as const)(
    "delayed main effects with missing old pipeline follow newer main only with real %s coverage",
    async (status) => {
      const t = await setup();
      t.behavior.effectsFail = true;
      t.behavior.deploy = "running";
      await t.admit(2);
      await t.settle(2);
      const landed = await t.state(2);
      t.sqlite.prepare("DELETE FROM ci_runs WHERE id=?").run(landed.deployRunId!);
      t.refs.set("refs/heads/main", oid(900));
      t.parents.set(oid(900), [landed.entry.candidate!]);
      if (status !== "missing") {
        t.sqlite
          .prepare(
            "INSERT INTO ci_runs(id,repo_id,number,commit_oid,ref,trigger,status,space_id,migration_epoch,authority,actor_id,agent_id) VALUES('new-main','repo',99,?,'main','push',?,?,?,?,?,?)",
          )
          .run(
            oid(900),
            status,
            landed.authority.spaceId,
            landed.authority.migrationEpoch,
            JSON.stringify(landed.authority),
            landed.authority.personId,
            landed.authority.agentId,
          );
        t.sqlite
          .prepare(
            "INSERT INTO ci_jobs(id,run_id,repo_id,name,spec,status,runner) VALUES('new-main-job','new-main','repo','deploy','{}',?,'local')",
          )
          .run(status);
      }
      vi.mocked(t.deps.deploy).mockClear();
      t.behavior.effectsFail = false;
      await t.progress();
      const recovered = await t.state(2);
      expect(t.deps.deploy).not.toHaveBeenCalled();
      expect(recovered.effectsPending).toBe(false);
      expect(t.refs.get("refs/heads/main")).toBe(oid(900));
      if (status === "missing") {
        expect(recovered.entry.deployStatus).toBe("running");
        expect(recovered.entry.failure).toBeNull();
        const expired = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
        t.sqlite
          .prepare("UPDATE merge_queue SET data=json_set(data,'$.entry.updatedAt',?) WHERE id=?")
          .run(expired, oid(2));
        await t.progress();
        expect((await t.state(2)).entry.failure).toMatchObject({
          stage: "deployment",
          kind: "infrastructure",
          runNumber: null,
        });
        expect(t.deps.deploy).not.toHaveBeenCalled();
      } else {
        expect(recovered.entry.deployRun).toBe(99);
        expect(recovered.entry.deployStatus).toBe(status);
        if (status === "failed") {
          expect(recovered.entry.failure).toMatchObject({
            stage: "deployment",
            runNumber: 99,
            failedJobs: ["deploy"],
          });
          expect(recovered.entry.remediationIssueId).toBe("remediation");
        } else expect(recovered.entry.failure).toBeNull();
      }
    },
  );
  test("a transient step failure is retried in place instead of failing the entry", async () => {
    const t = await setup();
    t.deps.stepRetryMs = [0, 0];
    vi.mocked(t.deps.merge).mockImplementationOnce(async () => {
      throw new Error("Peer closed WebSocket: 1006");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await t.admit(2);
    await t.settle(2);
    expect((await t.state(2)).entry).toMatchObject({ status: "landed", failure: null });
    expect(t.deps.merge).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
  test("a step that keeps failing fails the entry after its retries", async () => {
    const t = await setup();
    t.deps.stepRetryMs = [0, 0];
    vi.mocked(t.deps.merge).mockImplementation(async () => {
      throw new Error("Peer closed WebSocket: 1006");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await t.admit(2);
    await t.settle(2);
    expect(t.deps.merge).toHaveBeenCalledTimes(3);
    expect((await t.state(2)).entry).toMatchObject({
      status: "failed",
      failure: { stage: "merge", kind: "infrastructure" },
    });
    warn.mockRestore();
    error.mockRestore();
  });
  test("cyclic Git ancestry never invents coverage", async () => {
    const t = await setup();
    t.parents.set(oid(2), [oid(3)]);
    t.parents.set(oid(3), [oid(2)]);
    expect(
      await ancestor(
        t.deps,
        {
          id: "repo",
          space_id: "space",
          space_slug: "owner",
          name: "app",
          default_branch: "main",
          artifacts_name: "a",
          artifacts_remote: "https://a",
        },
        oid(8),
        oid(2),
      ),
    ).toBe(false);
  });
  test.each([false, true])(
    "already-included source (deeper ancestor=%s) reports existing main without a merge or invented gates",
    async (deeper) => {
      const t = await setup();
      await t.admit(2);
      t.refs.set("refs/heads/main", deeper ? oid(5) : oid(2));
      if (deeper) t.parents.set(oid(5), [oid(4)]);
      if (deeper) t.parents.set(oid(4), [oid(2)]);
      t.behavior.deploy = "running";
      await t.settle(2);
      const s = await t.state(2);
      expect(s.entry.status).toBe("landed");
      expect(s.entry.candidate).toBe(deeper ? oid(5) : oid(2));
      expect(s.entry.gateRun).toBeNull();
      expect(s.entry.deployStatus).toBe("running");
      expect(t.deps.merge).not.toHaveBeenCalled();
      expect(t.deps.write).not.toHaveBeenCalled();
      expect(t.deps.effects).not.toHaveBeenCalled();
    },
  );
  test("main deployment failure creates remediation without rewinding landed state or blocking the next push", async () => {
    const t = await setup();
    t.behavior.deploy = "failed";
    await t.admit(2);
    await t.settle(2);
    const s = await t.state(2);
    expect(s.entry.status).toBe("landed");
    expect(s.entry.failure?.stage).toBe("deployment");
    expect(s.entry.remediationIssueId).toBe("remediation");
    expect(t.refs.get("refs/heads/main")).toBe(s.entry.candidate);
    t.behavior.deploy = "succeeded";
    await t.admit(3);
    await t.settle(3);
    expect((await t.state(3)).entry.status).toBe("landed");
  });
  test.each([
    ["failed", "before"],
    ["failed", "after"],
  ] as const)(
    "deployment %s survives interruption %s its terminal evidence commit",
    async (status, interruption) => {
      const t = await setup();
      t.behavior.combine = true;
      t.behavior.deploy = "running";
      await t.admit(2);
      await t.admit(3);
      t.parents.set(oid(3), [oid(2)]);
      await t.settle(2);
      const landed = await t.state(2);
      t.sqlite.prepare("UPDATE ci_runs SET status=? WHERE id=?").run(status, landed.deployRunId!);
      t.sqlite
        .prepare(
          "UPDATE ci_jobs SET status='failed',error='deploy rejected',exit_code=1 WHERE run_id=?",
        )
        .run(landed.deployRunId!);
      let interrupted = false;
      const read = queueStore.getQueue,
        outcome = t.deps.outcome;
      if (interruption === "before") {
        t.deps.outcome = async (id) => {
          if (!interrupted && id === landed.deployRunId) {
            interrupted = true;
            throw new Error("Worker interrupted before evidence read");
          }
          return outcome(id);
        };
      } else {
        vi.spyOn(queueStore, "getQueue").mockImplementation(async (database, repo, id) => {
          if (
            !interrupted &&
            id === oid(3) &&
            (await read(database, repo, oid(2)))?.entry.deployStatus === status
          ) {
            interrupted = true;
            throw new Error("Worker interrupted after terminal commit");
          }
          return read(database, repo, id);
        });
      }
      await t.progress();
      expect(interrupted).toBe(true);
      const durable = await t.state(2);
      expect(durable.entry.status).toBe("landed");
      if (interruption === "before") {
        expect(durable.entry.deployStatus).toBe("running");
        expect(durable.entry.failure).toBeNull();
      } else {
        expect(durable.entry.deployStatus).toBe(status);
        expect(durable.remediationPending).toBe(true);
        expect(durable.entry.failure).toMatchObject({
          queueId: oid(2),
          commit: oid(2),
          attempt: 1,
          stage: "deployment",
          kind: "build_failed",
          reason: `Main pipeline ${status}.`,
          runNumber: landed.entry.deployRun,
          failedJobs: ["check"],
        });
      }
      expect(t.deps.remediate).not.toHaveBeenCalled();
      await t.progress();
      await t.progress();
      const recovered = await t.state(2);
      expect(recovered.entry.deployStatus).toBe(status);
      expect(recovered.entry.failure?.failedJobs).toEqual(["check"]);
      expect(recovered.entry.remediationIssueId).toBe("remediation");
      expect(recovered.remediationPending).toBe(false);
      expect(t.deps.remediate).toHaveBeenCalledTimes(1);
      expect(t.refs.get("refs/heads/main")).toBe(landed.entry.candidate);
      if (durable.entry.failure) expect(recovered.entry.failure).toEqual(durable.entry.failure);
    },
  );
  test("main CI coverage cycles fail honestly while main remains landed", async () => {
    const t = await setup();
    t.behavior.deploy = "running";
    await t.admit(2);
    await t.settle(2);
    const s = await t.state(2);
    t.sqlite
      .prepare("UPDATE ci_runs SET covered_by=number,status='cancelled' WHERE id=?")
      .run(s.deployRunId!);
    await t.progress();
    const failed = await t.state(2);
    expect(failed.entry.status).toBe("landed");
    expect(failed.entry.failure?.reason).toMatch(/cycle/);
    expect(failed.entry.deployStatus).toBe("failed");
    expect(failed.entry.remediationIssueId).toBe("remediation");
  });
  test("advance winning the cancellation race leaves both combined members unchanged", async () => {
    const t = await setup();
    t.behavior.combine = true;
    await t.admit(2);
    await t.admit(3);
    t.parents.set(oid(3), [oid(2)]);
    await t.progress();
    const old = await t.state(2),
      member = await t.state(3);
    await saveQueue(t.env.DB, old, { ...old, entry: { ...old.entry, status: "advancing" } });
    expect(await cancelCombined(t.env.DB, member, old)).toBe(false);
    expect((await t.state(3)).entry.status).toBe("queued");
    expect((await t.state(2)).entry.status).toBe("advancing");
  });
  test("repository deletion cascades queue ownership and cannot strand an active slot", async () => {
    const t = await setup();
    await t.admit(2);
    await t.progress();
    t.sqlite.exec("DELETE FROM repos WHERE id='repo'");
    expect(await getQueue(t.env.DB, "repo", oid(2))).toBeNull();
    await t.progress();
  });
  test.each(["queued", "merging", "advancing", "landed"] as const)(
    "a tombstone fences %s work, pending effects, retries and admission",
    async (status) => {
      const t = await setup();
      const admission = await t.admit(2);
      const before = await t.state(2);
      const saved = (await saveQueue(t.env.DB, before, {
        ...before,
        effectsPending: true,
        remediationPending: true,
        entry: { ...before.entry, status, base: oid(1), candidate: oid(3) },
      }))!;
      t.sqlite.exec("UPDATE repos SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'repo'");
      const other = { ...admission, entry: { ...admission.entry, id: oid(4), commit: oid(4) } };
      expect(await admitQueue(t.env.DB, other)).toBe(false);
      expect(
        await saveQueue(t.env.DB, saved, {
          ...saved,
          entry: { ...saved.entry, status: "queued" },
        }),
      ).toBeNull();
      await t.progress();
      expect(t.refs.get("refs/heads/main")).toBe(oid(1));
      for (const operation of [
        "write",
        "merge",
        "gates",
        "deploy",
        "effects",
        "remediate",
        "recover",
      ] as const)
        expect(t.deps[operation]).not.toHaveBeenCalled();
      expect((await t.state(2)).version).toBe(saved.version);
    },
  );
  test("deletion during the advancing ref read prevents publishing the tested candidate", async () => {
    const t = await setup();
    await t.admit(2);
    const before = await t.state(2);
    await saveQueue(t.env.DB, before, {
      ...before,
      entry: { ...before.entry, status: "advancing", base: oid(1), candidate: oid(3) },
    });
    t.deps.refs = async () => {
      t.sqlite.exec("UPDATE repos SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'repo'");
      return new Map(t.refs);
    };
    await t.progress();
    expect(t.deps.write).not.toHaveBeenCalled();
    expect(t.deps.effects).not.toHaveBeenCalled();
    expect(t.refs.get("refs/heads/main")).toBe(oid(1));
  });
  test("an expired uncertain scheduling answer falls back to FIFO without provider replay", async () => {
    const t = await setup();
    await t.admit(2);
    const s = await t.state(2);
    await saveQueue(t.env.DB, s, {
      ...s,
      classificationClaimed: true,
      mergeRunId: "uncertain",
      entry: {
        ...s.entry,
        status: "merging",
        attempts: 1,
        base: oid(1),
        candidateBranch: queueCandidateBranch(oid(2), 1),
        decision: null,
      },
    });
    const expired = new Date(Date.now() - 180000).toISOString();
    t.sqlite
      .prepare(
        "UPDATE merge_queue SET updated_at=?, data=json_set(data,'$.entry.updatedAt',?) WHERE id=?",
      )
      .run(expired, expired, oid(2));
    await t.settle(2);
    expect((await t.state(2)).entry.status).toBe("landed");
    expect(t.deps.classify).not.toHaveBeenCalled();
  });
});
