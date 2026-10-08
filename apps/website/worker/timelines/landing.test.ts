import { describe, expect, test, vi } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Landing, LandingRepo, Timeline } from "../../shared/timelines.ts";
import type { SourceSnapshot } from "../../shared/code-source.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { initializeWorkSource, type WorkSourceRow } from "./sources.ts";
import { retainProgress } from "../git/source-push.ts";
import type { RepoRow } from "../db.ts";
import { progress, type LandingDeps } from "./landing.ts";
import { measure } from "./checkpoints.ts";
import { lsRefs } from "../artifacts.ts";
import type * as Artifacts from "../artifacts.ts";
import {
  admittedReceipts,
  recordIntent,
  revisionClosure,
  validateDependencies,
  validateMergeEdges,
} from "./integration.ts";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
vi.mock("../artifacts.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Artifacts>()),
  lsRefs: vi.fn(),
}));
vi.mock("../tracker/stub.ts", () => ({
  trackerObject: (env: Env, owner: string) => env.TRACKER.getByName(owner),
}));
const oid = (value: number) => value.toString(16).padStart(40, "0");
function fixture(count = 2) {
  const sqlite = migratedDatabase();
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner')",
  );
  const graphs = new Map<
    string,
    Map<string, { parents: string[]; treeHash: string; hash: string; message: string }>
  >();
  const refs = new Map<string, Map<string, string>>();
  const repos: LandingRepo[] = [];
  for (let n = 0; n < count; n++) {
    const id = `repo${n}`,
      sourceId = `work_${n}`,
      base = oid(n * 10 + 1),
      work = oid(n * 10 + 2),
      candidate = oid(n * 10 + 3);
    sqlite.exec(`INSERT INTO repos(id,owner_id,name,visibility,artifacts_name,artifacts_remote) VALUES('${id}','owner','${id}','private','${id}','https://${id}');
      INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
      VALUES('${sourceId}','${id}','timeline','test','owner','${sourceId}','https://${sourceId}','ready','allocation${n}','canonical','${base}','${oid(101)}','refs/heads/main','canonical','${base}','${oid(101)}','refs/heads/main','now','now',1);`);
    graphs.set(
      id,
      new Map([
        [base, { parents: [], treeHash: oid(101), hash: base, message: "base" }],
        [candidate, { parents: [base], treeHash: oid(102), hash: candidate, message: "compact" }],
      ]),
    );
    graphs.set(
      sourceId,
      new Map([
        [base, { parents: [], treeHash: oid(101), hash: base, message: "base" }],
        [work, { parents: [base], treeHash: oid(102), hash: work, message: "work" }],
      ]),
    );
    refs.set(
      id,
      new Map([
        ["refs/heads/main", base],
        ["refs/heads/gitmatrix/landing/test", candidate],
      ]),
    );
    refs.set(sourceId, new Map([["refs/heads/work", work]]));
    const source: SourceSnapshot = {
      repoId: id,
      sourceId,
      kind: "timeline-work",
      timelineId: "timeline",
      ref: "refs/heads/work",
      commit: work,
      tree: oid(102),
    };
    repos.push({
      id,
      owner: "owner",
      name: id,
      commit: work,
      base,
      merge: candidate,
      attempt: 1,
      state: "tested",
      mergeRun: { id: `merge${n}`, number: 1 },
      gateRun: null,
      reason: null,
      source,
      logicalBase: {
        repoId: id,
        sourceId: "canonical",
        kind: "canonical",
        timelineId: null,
        ref: "refs/heads/main",
        commit: base,
        tree: oid(101),
      },
      dependencies: [],
    });
  }
  let current: Landing = {
    id: "landing",
    timelineId: "timeline",
    slug: "test",
    checkpointId: "checkpoint",
    checkpointNumber: 1,
    state: "advancing",
    repos,
    reason: null,
    trigger: "request",
    requestedBy: { actorId: "owner", accountableId: "owner", agentId: null },
    version: 1,
    createdAt: "now",
    updatedAt: "now",
  };
  const tracker = {
    saveLanding: async (next: Landing, version: number) => {
      if (version !== current.version) return { ok: false, code: "version_conflict" };
      current = { ...next, version: version + 1 };
      return { ok: true, value: current };
    },
    landing: async () => ({ ok: true, value: current }),
    completeLanding: async (_access: unknown, next: Landing) => {
      current = { ...next, state: "landed", version: next.version + 1 };
      return { ok: true, value: current };
    },
    transitionWorkSource: async (sourceId: string, version: number, state: string) => ({
      ok: true,
      value: {
        source_id: sourceId,
        version: version + 1,
        state,
        archived_at: "2026-10-04T00:00:00Z",
        updated_at: "2026-10-04T00:00:00Z",
      },
    }),
  };
  const env = {
    DB: d1(sqlite),
    TRACKER: { getByName: () => tracker },
    ARTIFACTS: {
      get: async (name: string) => ({
        readCommit: async (commit: string) => graphs.get(name)?.get(commit) ?? null,
        [Symbol.dispose]() {},
      }),
    },
  } as unknown as Env;
  const writes: string[] = [],
    starts: string[] = [];
  const deps: LandingDeps = {
    refs: async (repo) => new Map(refs.get(repo.artifacts_name)),
    parents: async (repo, commit) => graphs.get(repo.artifacts_name)?.get(commit)?.parents ?? null,
    writeRefs: async (repo, changes) =>
      changes.map((change) => {
        const target = refs.get(repo.artifacts_name)!;
        if ((target.get(change.ref) ?? null) !== change.old)
          return { ref: change.ref, ok: false, reason: "stale" };
        if (change.new) target.set(change.ref, change.new);
        else target.delete(change.ref);
        if (change.ref === "refs/heads/main") writes.push(repo.id);
        return { ref: change.ref, ok: true };
      }),
    startMerge: async (repo) => {
      starts.push(repo.id);
    },
    startGates: async () => ({ skipped: "no pipeline" }),
    runOutcome: async () => null,
    mainMoved() {},
    refsDeleted: async () => {},
    // Most tests change the world between looks; retries in place are tested below.
    stepRetryMs: [],
  };
  return {
    sqlite,
    env,
    deps,
    refs,
    graphs,
    writes,
    starts,
    get current() {
      return current;
    },
    run: () => progress(env, deps, "owner", current),
  };
}

describe("compact landing state", () => {
  test("a failing gate blocks every repository", async () => {
    const f = fixture();
    f.current.repos[1]!.state = "testing";
    f.current.repos[1]!.gateRun = { id: "gate", number: 2 };
    f.deps.runOutcome = async () => ({
      number: 2,
      status: "failed",
      conflict: false,
      failedJobs: ["verify"],
    });
    expect((await f.run()).state).toBe("failed");
    expect(f.writes).toEqual([]);
  });
  test("moving B is rematerialized before any CAS on A", async () => {
    const f = fixture();
    const b = f.current.repos[1]!;
    f.graphs.get(b.id)!.set(oid(99), {
      parents: [b.base!],
      treeHash: oid(103),
      hash: oid(99),
      message: "main moved",
    });
    f.refs.get(b.id)!.set("refs/heads/main", oid(99));
    await f.run();
    expect(f.writes).toEqual([]);
    expect(f.starts).toContain(b.id);
    expect(f.current.repos[1]!.base).toBe(oid(99));
  });
  test("concurrent progress waits for the admitted CAS instead of failing a live publication", async () => {
    const f = fixture(1);
    const base = f.current.repos[0]!.base!;
    const write = f.deps.writeRefs.bind(f.deps);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.deps.writeRefs = async (repo, changes) => {
      if (changes[0]!.ref === "refs/heads/main") {
        entered.resolve();
        await release.promise;
      }
      return write(repo, changes);
    };
    const first = f.run();
    await entered.promise;
    try {
      expect((await f.run()).state).toBe("advancing");
      expect(f.refs.get("repo0")!.get("refs/heads/main")).toBe(base);
      expect(f.writes).toEqual([]);
    } finally {
      release.resolve();
      await first;
    }
    expect((await f.run()).state).toBe("landed");
    expect(f.writes).toEqual(["repo0"]);
    expect(f.sqlite.prepare("SELECT status FROM source_integration_receipts").get()).toEqual({
      status: "complete",
    });
  });
  test("a tombstone before provider submission releases the known-unsubmitted admission", async () => {
    const f = fixture(1);
    const base = f.current.repos[0]!.base!;
    f.sqlite.exec(`CREATE TRIGGER tombstone_after_landing_admission
      AFTER INSERT ON source_operations WHEN NEW.kind='landing'
      BEGIN UPDATE repos SET deleted_at='2026-10-04' WHERE id=NEW.repo_id; END`);
    await f.run();
    expect(f.writes).toEqual([]);
    expect(f.refs.get("repo0")!.get("refs/heads/main")).toBe(base);
    expect(f.sqlite.prepare("SELECT state FROM source_operations").get()).toEqual({
      state: "rejected",
    });
  });
  test("timeout after CAS reconciles candidate ancestry without duplicate publication", async () => {
    const f = fixture(1),
      write = f.deps.writeRefs.bind(f.deps);
    f.deps.writeRefs = async (repo, changes) => {
      const result = await write(repo, changes);
      if (changes[0]!.ref === "refs/heads/main") throw new Error("timeout after provider success");
      return result;
    };
    await f.run();
    expect(f.writes).toEqual(["repo0"]);
    const candidate = f.current.repos[0]!.merge!;
    f.graphs.get("repo0")!.set(oid(90), {
      parents: [candidate],
      treeHash: oid(105),
      hash: oid(90),
      message: "later main",
    });
    f.refs.get("repo0")!.set("refs/heads/main", oid(90));
    expect((await f.run()).state).toBe("landed");
    expect(f.writes).toEqual(["repo0"]);
    expect(f.sqlite.prepare("SELECT status FROM source_integration_receipts").get()).toEqual({
      status: "complete",
    });
  });
  test.each(["a successful CAS", "reconciling a timed-out CAS"] as const)(
    "main rewritten after %s is re-read before recording an integration",
    async (path) => {
      const f = fixture(1),
        write = f.deps.writeRefs.bind(f.deps),
        parents = f.deps.parents.bind(f.deps);
      const rewrite = () => {
        f.graphs.get("repo0")!.set(oid(91), {
          parents: [],
          treeHash: oid(101),
          hash: oid(91),
          message: "unrelated rewrite",
        });
        f.refs.get("repo0")!.set("refs/heads/main", oid(91));
      };
      if (path === "a successful CAS") {
        f.deps.writeRefs = async (repo, changes) => {
          const result = await write(repo, changes);
          if (changes[0]!.ref === "refs/heads/main") rewrite();
          return result;
        };
      } else {
        f.deps.writeRefs = async (repo, changes) => {
          await write(repo, changes);
          throw new Error("timeout after provider success");
        };
        await f.run();
        // The rewrite lands while reconciling walks the history it read (the
        // first walk validates dependencies).
        let walks = 0;
        f.deps.parents = async (repo, commit) => {
          if (commit === f.current.repos[0]!.merge && ++walks === 2) rewrite();
          return parents(repo, commit);
        };
      }
      const landing = await f.run();
      expect(landing.state).toBe("failed");
      expect(landing.reason).toMatch(/outcome is unknown/);
      expect(f.sqlite.prepare("SELECT status FROM source_integration_receipts").get()).toEqual({
        status: "intent",
      });
    },
  );
  test.each(["before", "after"] as const)(
    "publication %s the main observation preserves prepared candidates and gates",
    async (timing) => {
      const f = fixture();
      for (const [index, repo] of f.current.repos.entries())
        repo.gateRun = { id: `gate${index}`, number: 2 };
      const prepared = structuredClone(f.current.repos);
      const a = prepared[0]!;
      const readRefs = f.deps.refs.bind(f.deps);
      let reads = 0;
      f.deps.refs = async (repo) => {
        if (repo.id === a.id && repo.artifacts_name === a.id && ++reads === 2) {
          const observed = new Map(await readRefs(repo));
          // Another progress request completes CAS after this request's initial
          // validation, but crashes before saving the advanced Tracker state.
          await recordIntent(f.env, f.current, a, oid(102));
          await f.deps.writeRefs(repo, [{ ref: "refs/heads/main", old: a.base, new: a.merge }]);
          f.sqlite.exec(`INSERT INTO source_operations
          (id,owner_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
          VALUES('landing:landing:repo0','owner','timeline','repo0','work_0','landing','accepted','{}','now','now')`);
          f.graphs.get(a.id)!.set(oid(90), {
            parents: [a.merge!],
            treeHash: oid(105),
            hash: oid(90),
            message: "independent main movement after CAS",
          });
          f.refs.get(a.id)!.set("refs/heads/main", oid(90));
          return timing === "after" ? observed : readRefs(repo);
        }
        return readRefs(repo);
      };
      const gates = vi.spyOn(f.deps, "startGates");
      expect((await f.run()).state).toBe("landed");
      expect(f.starts).toEqual([]);
      expect(gates).not.toHaveBeenCalled();
      expect(f.writes).toEqual(["repo0", "repo1"]);
      expect(f.refs.get(a.id)!.get("refs/heads/main")).toBe(oid(90));
      for (const [index, repo] of f.current.repos.entries()) {
        expect(repo.merge).toBe(prepared[index]!.merge);
        expect(repo.mergeRun).toEqual(prepared[index]!.mergeRun);
        expect(repo.gateRun).toEqual(prepared[index]!.gateRun);
      }
      expect(
        f.sqlite
          .prepare("SELECT repo_id,status FROM source_integration_receipts ORDER BY repo_id")
          .all(),
      ).toEqual([
        { repo_id: "repo0", status: "complete" },
        { repo_id: "repo1", status: "complete" },
      ]);
    },
  );
  test("a dependency read transport failure preserves prepared work for the next progress request", async () => {
    const f = fixture();
    for (const [index, repo] of f.current.repos.entries())
      repo.gateRun = { id: `gate${index}`, number: 2 };
    const prepared = structuredClone(f.current.repos);
    const parents = f.deps.parents.bind(f.deps);
    let interrupted = false;
    f.deps.parents = async (repo, commit) => {
      if (repo.id === "repo1" && f.writes.includes("repo0") && !interrupted) {
        interrupted = true;
        throw new Error("Peer closed WebSocket: 1006");
      }
      return parents(repo, commit);
    };
    const gates = vi.spyOn(f.deps, "startGates");
    expect((await f.run()).state).toBe("advancing");
    expect(f.current.repos[0]!.state).toBe("advanced");
    expect(f.current.repos[1]!.state).toBe("tested");
    expect(f.writes).toEqual(["repo0"]);

    expect((await f.run()).state).toBe("landed");
    expect(f.writes).toEqual(["repo0", "repo1"]);
    expect(f.starts).toEqual([]);
    expect(gates).not.toHaveBeenCalled();
    for (const [index, repo] of f.current.repos.entries()) {
      expect(repo.merge).toBe(prepared[index]!.merge);
      expect(repo.mergeRun).toEqual(prepared[index]!.mergeRun);
      expect(repo.gateRun).toEqual(prepared[index]!.gateRun);
    }
  });
  test("a transient step failure is retried in place instead of waiting for the next look", async () => {
    const f = fixture();
    for (const [index, repo] of f.current.repos.entries())
      repo.gateRun = { id: `gate${index}`, number: 2 };
    f.deps.stepRetryMs = [0, 0];
    const parents = f.deps.parents.bind(f.deps);
    let interrupted = false;
    f.deps.parents = async (repo, commit) => {
      if (repo.id === "repo1" && f.writes.includes("repo0") && !interrupted) {
        interrupted = true;
        throw new Error("Peer closed WebSocket: 1006");
      }
      return parents(repo, commit);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await f.run()).state).toBe("landed");
    expect(interrupted).toBe(true);
    expect(f.writes).toEqual(["repo0", "repo1"]);
    expect(warn).toHaveBeenCalledWith("Landing: a step failed; retrying it", expect.anything());
    warn.mockRestore();
  });
  test("a step that keeps failing is left to the next look after its retries", async () => {
    const f = fixture();
    for (const [index, repo] of f.current.repos.entries())
      repo.gateRun = { id: `gate${index}`, number: 2 };
    f.deps.stepRetryMs = [0, 0];
    let attempts = 0;
    f.deps.parents = async () => {
      attempts++;
      throw new Error("Peer closed WebSocket: 1006");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await f.run()).state).not.toBe("landed");
    expect(attempts).toBe(3);
    expect(f.writes).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      "Landing: a step failed; the next look retries it",
      expect.anything(),
    );
    warn.mockRestore();
    error.mockRestore();
  });
  test("confirmed missing source evidence still blocks before any canonical publication", async () => {
    const f = fixture();
    f.graphs.get("work_1")!.delete(f.current.repos[1]!.commit);
    expect((await f.run()).state).toBe("blocked_dependency");
    expect(f.current.repos[1]!.state).toBe("blocked_dependency");
    expect(f.writes).toEqual([]);
    for (const repo of f.current.repos)
      expect(f.refs.get(repo.id)!.get("refs/heads/main")).toBe(repo.base);
  });
  test("unknown force-rewritten CAS outcome blocks without recomputing or replaying", async () => {
    const f = fixture(1),
      write = f.deps.writeRefs.bind(f.deps);
    f.deps.writeRefs = async (repo, changes) => {
      await write(repo, changes);
      throw new Error("timeout");
    };
    await f.run();
    f.graphs
      .get("repo0")!
      .set(oid(95), { parents: [], treeHash: oid(105), hash: oid(95), message: "force rewrite" });
    f.refs.get("repo0")!.set("refs/heads/main", oid(95));
    expect((await f.run()).state).toBe("failed");
    expect(f.writes).toEqual(["repo0"]);
    expect(f.current.repos[0]!.casIntent).toBeDefined();
  });
  test("a reset exactly to the CAS base cannot replay an admitted outcome", async () => {
    const f = fixture(1);
    const base = f.current.repos[0]!.base!;
    const write = f.deps.writeRefs.bind(f.deps);
    f.deps.writeRefs = async (repo, changes) => {
      await write(repo, changes);
      throw new Error("lost result after success");
    };
    await f.run();
    f.refs.get("repo0")!.set("refs/heads/main", base);
    f.deps.writeRefs = write;
    expect((await f.run()).state).toBe("failed");
    expect(f.writes).toEqual(["repo0"]);
    expect(f.refs.get("repo0")!.get("refs/heads/main")).toBe(base);
    expect(f.sqlite.prepare("SELECT state FROM source_operations").get()).toEqual({
      state: "ambiguous",
    });
  });
  test("a prepared intent without admission reprepares against moved main", async () => {
    const f = fixture(1);
    const repo = f.current.repos[0]!;
    await recordIntent(f.env, f.current, repo, oid(102));
    repo.casIntent = { base: repo.base!, candidate: repo.merge!, tree: oid(102) };
    f.graphs.get(repo.id)!.set(oid(94), {
      parents: [repo.base!],
      treeHash: oid(194),
      hash: oid(94),
      message: "new main",
    });
    f.refs.get(repo.id)!.set("refs/heads/main", oid(94));
    await f.run();
    expect(f.writes).toEqual([]);
    expect(f.current.repos[0]).toMatchObject({ base: oid(94), attempt: repo.attempt + 1 });
    expect(f.current.repos[0]?.mergeRun?.id).not.toBe(repo.mergeRun?.id);
    expect(f.refs.get(repo.id)?.get("refs/heads/main")).toBe(oid(94));
  });
  test("partial success is fixed while B reprepares and is not replayed after canonical revert", async () => {
    const f = fixture(),
      write = f.deps.writeRefs.bind(f.deps);
    f.deps.writeRefs = async (repo, changes) => {
      const result = await write(repo, changes);
      if (repo.id === "repo0" && changes[0]!.ref === "refs/heads/main") {
        const b = f.current.repos[1]!;
        f.graphs.get(b.id)!.set(oid(91), {
          parents: [b.base!],
          treeHash: oid(106),
          hash: oid(91),
          message: "moved B",
        });
        f.refs.get(b.id)!.set("refs/heads/main", oid(91));
      }
      return result;
    };
    await f.run();
    expect(f.writes).toEqual(["repo0"]);
    expect(f.current.repos[0]!.state).toBe("advanced");
    const a = f.current.repos[0]!;
    f.graphs.get(a.id)!.set(oid(92), {
      parents: [a.merge!],
      treeHash: oid(101),
      hash: oid(92),
      message: "reverted A",
    });
    f.refs.get(a.id)!.set("refs/heads/main", oid(92));
    await f.run();
    expect(f.writes).toEqual(["repo0"]);
  });
  test("a step that read main before a fixture barrier was hit does not act on it after release", async () => {
    // CORE-307: the E2E holds A after its CAS, force-rewrites main, then releases.
    // A progress request already reading main must not record the stale integration.
    const f = fixture();
    try {
      Object.assign(f.env, { DEV_MODE: "true", AGENT_ID: "landing-barrier-test" });
      f.current.slug = "source-landing-12345678-unknown-rewrite";
      for (const [index, repo] of f.current.repos.entries()) {
        repo.owner = "orbit";
        repo.name = `queue-${String(index).padStart(8, "0")}`;
      }
      f.sqlite.exec(`CREATE TABLE dev_landing_barriers
        (timeline_id TEXT PRIMARY KEY, point TEXT, repo_id TEXT, hit INTEGER DEFAULT 0, released INTEGER DEFAULT 0);
        INSERT INTO dev_landing_barriers(timeline_id,point,repo_id) VALUES('timeline','after-cas','repo0')`);
      // The first request publishes A, then pauses before its after-cas boundary.
      const write = f.deps.writeRefs.bind(f.deps);
      const published = Promise.withResolvers<void>();
      const finishCas = Promise.withResolvers<void>();
      f.deps.writeRefs = async (repo, changes) => {
        const result = await write(repo, changes);
        if (changes[0]!.ref === "refs/heads/main") {
          published.resolve();
          await finishCas.promise;
        }
        return result;
      };
      const casRequest = f.run();
      await published.promise;
      // A second request reconciles A against main with the published candidate (after
      // validating each source against main), and that answer is slow.
      const refs = f.deps.refs.bind(f.deps);
      const reading = Promise.withResolvers<void>();
      const finishRead = Promise.withResolvers<void>();
      let mainReads = 0;
      f.deps.refs = async (repo) => {
        const observed = await refs(repo);
        if (repo.artifacts_name === "repo0" && ++mainReads === 2) {
          expect(observed.get("refs/heads/main")).toBe(f.current.repos[0]!.merge);
          f.deps.refs = refs;
          reading.resolve();
          await finishRead.promise;
        }
        return observed;
      };
      const staleRequest = f.run();
      await reading.promise;
      finishCas.resolve();
      await casRequest;
      expect(f.sqlite.prepare("SELECT hit, released FROM dev_landing_barriers").get()).toEqual({
        hit: 1,
        released: 0,
      });
      // The fixture rewrites main and releases the barrier while the read is in flight.
      f.graphs
        .get("repo0")!
        .set(oid(95), { parents: [], treeHash: oid(105), hash: oid(95), message: "force rewrite" });
      f.refs.get("repo0")!.set("refs/heads/main", oid(95));
      f.sqlite.exec("UPDATE dev_landing_barriers SET released=1");
      finishRead.resolve();
      await staleRequest;
      expect(f.sqlite.prepare("SELECT status FROM source_integration_receipts").all()).toEqual([
        { status: "intent" },
      ]);
      // A request after the release reads main afresh and refuses the unknown outcome.
      expect((await f.run()).state).toBe("failed");
      expect(f.sqlite.prepare("SELECT status FROM source_integration_receipts").all()).toEqual([
        { status: "intent" },
      ]);
      expect(f.writes).toEqual(["repo0"]);
    } finally {
      f.sqlite.close();
    }
  });
  test("no-op records complete membership without adding a commit", async () => {
    const f = fixture(1),
      repo = f.current.repos[0]!;
    repo.merge = repo.base;
    expect((await f.run()).state).toBe("landed");
    expect(f.writes).toEqual([]);
    expect(f.sqlite.prepare("SELECT noop,status FROM source_integration_receipts").get()).toEqual({
      noop: 1,
      status: "complete",
    });
  });
});

describe("exact nested admission", () => {
  test.each(["separate tips", "first merge push", "legacy allocation"])(
    "%s: local Git branches land without importing WIP ancestry",
    async (mode) => {
      const directory = mkdtempSync(join(tmpdir(), "same-source-merge-"));
      const git = (args: string[], input?: string) =>
        execFileSync("git", args, {
          cwd: directory,
          input,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Source test",
            GIT_AUTHOR_EMAIL: "source@example.com",
            GIT_COMMITTER_NAME: "Source test",
            GIT_COMMITTER_EMAIL: "source@example.com",
          },
        }).trim();
      const f = fixture(1);
      try {
        git(["init", "--quiet"]);
        const baseTree = git(["mktree"], "");
        const blob = git(["hash-object", "-w", "--stdin"], "merged work\n");
        const workTree = git(["mktree"], `100644 blob ${blob}\twork.txt\n`);
        const commit = (tree: string, parents: string[], message: string) =>
          git(["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message]);
        const base = commit(baseTree, [], "B");
        const left = commit(workTree, [base], "L");
        const right = commit(workTree, [base], "R");
        const merge = commit(workTree, [left, right], "WIP merge");
        const compact = commit(workTree, [base], "Canonical landing");
        const repo = f.current.repos[0]!;
        const source = { ...repo.source!, commit: merge, tree: workTree };
        Object.assign(repo, {
          source,
          commit: merge,
          base,
          merge: compact,
          logicalBase: { ...repo.logicalBase!, commit: base, tree: baseTree },
        });
        for (const name of ["repo0", "work_0"]) {
          const graph = f.graphs.get(name)!;
          graph.clear();
          for (const hash of [base, left, right, merge, compact]) {
            const [treeHash, parents, ...message] = git([
              "show",
              "-s",
              "--format=%T%n%P%n%B",
              hash,
            ]).split("\n");
            graph.set(hash, {
              hash,
              treeHash: treeHash!,
              parents: parents ? parents.split(" ") : [],
              message: message.join("\n"),
            });
          }
        }
        f.refs.get("repo0")!.set("refs/heads/main", base);
        f.refs.get("repo0")!.set("refs/heads/gitmatrix/landing/test", compact);
        f.refs.get("work_0")!.set("refs/heads/work", merge);
        git(["update-ref", "refs/heads/main", base]);
        vi.mocked(lsRefs).mockImplementation(async (_env, name) =>
          [...f.refs.get(name)!].map(([name, oid]) => ({ name, oid })),
        );
        const retain = async (id: string, tip: string) => {
          f.sqlite
            .prepare(`INSERT INTO source_operations
          (id,owner_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
          VALUES(?,'owner','timeline','repo0','work_0','push','accepted',?,'now','now')`)
            .run(
              id,
              JSON.stringify({ commands: [{ ref: "refs/heads/work", old: base, new: tip }] }),
            );
          const root = `refs/gitmatrix/progress/${tip}`;
          git(["update-ref", root, tip]);
          f.refs.get("work_0")!.set(root, tip);
          await retainProgress(
            f.env,
            {
              id: "repo0",
              source_id: "work_0",
              artifacts_name: "work_0",
              artifacts_remote: "https://work_0",
            },
            id,
            tip,
          );
        };
        if (mode === "legacy allocation") {
          f.sqlite
            .prepare(`UPDATE timeline_work_sources SET state='creating',
          fork_commit=?,fork_tree=?,initial_commit=?,initial_tree=?,initial_ref='refs/heads/timeline/test'
          WHERE source_id='work_0'`)
            .run(base, baseTree, merge, workTree);
          const tracker = f.env.TRACKER.getByName("owner");
          Object.assign(tracker, {
            reserveWorkSource: async () => ({
              ok: true,
              value: f.sqlite
                .prepare("SELECT * FROM timeline_work_sources WHERE source_id='work_0'")
                .get() as WorkSourceRow,
            }),
            transitionWorkSource: async (sourceId: string, version: number, state: string) => ({
              ok: true,
              value: f.sqlite
                .prepare(
                  "UPDATE timeline_work_sources SET state=?,version=? WHERE source_id=? RETURNING *",
                )
                .get(state, version + 1, sourceId) as WorkSourceRow,
            }),
          });
          const get = f.env.ARTIFACTS.get.bind(f.env.ARTIFACTS);
          Object.assign(f.env.ARTIFACTS, {
            get: async (name: string) =>
              Object.assign(await get(name), {
                info: async () => ({ remote: `https://${name}` }),
                listTokens: async () => ({ tokens: [] }),
              }),
          });
          await initializeWorkSource(
            f.env,
            f.sqlite.prepare("SELECT * FROM repos WHERE id='repo0'").get() as unknown as RepoRow,
            {
              timelineId: "timeline",
              timelineSlug: "test",
              base: repo.logicalBase!,
              initialHead: {
                ...source,
                sourceId: "canonical",
                kind: "canonical",
                ref: "refs/heads/timeline/test",
              },
            },
          );
          expect(
            f.sqlite
              .prepare("SELECT source_id FROM source_revision_origins WHERE commit_oid=?")
              .get(base),
          ).toEqual({ source_id: "canonical" });
        } else {
          f.sqlite
            .prepare(
              "INSERT INTO source_revision_origins(repo_id,commit_oid,source_id) VALUES('repo0',?,'canonical')",
            )
            .run(base);
          if (mode === "separate tips") {
            await retain("left-push", left);
            await retain("right-push", right);
          }
          await retain("merge-push", merge);
        }
        const read = async (hash: string) => f.graphs.get("work_0")!.get(hash)?.parents ?? null;
        const validate = () => validateMergeEdges(f.env, source, merge, base, [], read);
        await expect(validate()).resolves.toBeUndefined();
        const membership = f.sqlite
          .prepare(
            "SELECT operation_id,created_at FROM source_progress_members WHERE repo_id='repo0' AND source_id='work_0' AND commit_oid=?",
          )
          .get(right) as { operation_id: string; created_at: string };
        f.sqlite
          .prepare(
            "DELETE FROM source_progress_members WHERE repo_id='repo0' AND source_id='work_0' AND commit_oid=?",
          )
          .run(right);
        await expect(validate()).rejects.toThrow("blocked_dependency");
        f.sqlite
          .prepare(`INSERT INTO source_progress_members
        (repo_id,source_id,commit_oid,operation_id,created_at) VALUES(?,?,?,?,?)`)
          .run("repo0", "work_0", right, membership.operation_id, membership.created_at);
        f.sqlite
          .prepare("DELETE FROM source_revision_origins WHERE repo_id='repo0' AND commit_oid=?")
          .run(right);
        await expect(validate()).rejects.toThrow("blocked_dependency");
        f.sqlite
          .prepare(
            "INSERT INTO source_revision_origins(repo_id,commit_oid,source_id) VALUES('repo0',?,'work_0')",
          )
          .run(right);
        if (mode !== "legacy allocation") {
          f.sqlite.exec("UPDATE source_operations SET state='ambiguous'");
          await expect(validate()).rejects.toThrow("blocked_dependency");
          f.sqlite.exec("UPDATE source_operations SET state='accepted',repo_id='another-repo'");
          await expect(validate()).rejects.toThrow("blocked_dependency");
          f.sqlite.exec("UPDATE source_operations SET repo_id='repo0'");
        }
        const foreign = commit(workTree, [base], "Foreign baseline");
        const localTip = commit(workTree, [foreign], "Local work on foreign baseline");
        const importedMerge = commit(workTree, [left, localTip], "Imported baseline merge");
        for (const [hash, parents] of [
          [foreign, [base]],
          [localTip, [foreign]],
          [importedMerge, [left, localTip]],
        ] as const)
          f.graphs.get("work_0")!.set(hash, {
            hash,
            parents: [...parents],
            treeHash: workTree,
            message: "foreign baseline",
          });
        f.sqlite
          .prepare(
            "INSERT INTO source_revision_origins(repo_id,commit_oid,source_id) VALUES('repo0',?,'foreign')",
          )
          .run(foreign);
        await retain("import-push", localTip);
        await expect(
          validateMergeEdges(f.env, source, importedMerge, base, [], read),
        ).rejects.toThrow("blocked_dependency");
        // Even a linear import keeps its foreign attribution after physical expiry.
        await expect(validateMergeEdges(f.env, source, localTip, base, [], read)).rejects.toThrow(
          "blocked_dependency",
        );
        expect(
          f.sqlite
            .prepare("SELECT source_id FROM source_revision_origins WHERE commit_oid=?")
            .get(foreign),
        ).toEqual({ source_id: "foreign" });
        f.sqlite.exec(`
        INSERT INTO timeline_work_sources
          (source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,
           allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
           initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
        VALUES('descendant','repo0','child','child','owner','descendant','https://descendant','ready',
          'child-allocation','work_0','${right}','${workTree}','refs/heads/work',
          'work_0','${right}','${workTree}','refs/heads/work',
          '2026-10-05T00:00:01.000Z','2026-10-05T00:00:01.000Z',1);
        INSERT INTO source_progress_members(repo_id,source_id,commit_oid,operation_id,created_at)
        VALUES('repo0','descendant','${right}','child-allocation','2026-10-05T00:00:01.000Z');`);
        f.sqlite.exec(`INSERT INTO timeline_work_sources
        (source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,
         allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
         initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
        VALUES('foreign','repo0','foreign','foreign','owner','foreign','https://foreign','purged',
          'foreign-allocation','canonical','${base}','${baseTree}','refs/heads/main',
          'canonical','${base}','${baseTree}','refs/heads/main','now','now',1);`);
        f.refs.get("work_0")!.set("refs/heads/work", localTip);
        await expect(
          measure(f.env, { id: "owner", slug: "owner", displayName: "Owner", isSiteAdmin: false }, {
            id: "timeline",
            repos: [repo],
          } as unknown as Timeline),
        ).rejects.toThrow("Source expired");
        f.refs.get("work_0")!.set("refs/heads/work", merge);
        await expect(validate()).resolves.toBeUndefined();
        const [checkpoint] = await measure(
          f.env,
          { id: "owner", slug: "owner", displayName: "Owner", isSiteAdmin: false },
          { id: "timeline", repos: [repo] } as unknown as Timeline,
        );
        expect(checkpoint!.dependencies).toEqual([]);
        expect(checkpoint!.logicalBase).toEqual(repo.logicalBase);
        const write = f.deps.writeRefs.bind(f.deps);
        f.deps.writeRefs = async (target, changes) => {
          const results = await write(target, changes);
          for (const change of changes)
            if (change.ref === "refs/heads/main" && results.find((r) => r.ref === change.ref)?.ok)
              git(["update-ref", change.ref, change.new!, change.old!]);
          return results;
        };
        expect((await f.run()).state).toBe("landed");
        expect(git(["rev-list", "refs/heads/main"]).split("\n")).toEqual([compact, base]);
        expect(git(["rev-parse", "refs/heads/main^{tree}"])).toBe(workTree);
        for (const member of [left, right, merge])
          expect(
            await admittedReceipts(f.env, { ...source, commit: member }, new Set([base, compact])),
          ).toMatchObject([
            { source_id: source.sourceId, canonical_commit: compact, status: "complete" },
          ]);
      } finally {
        f.sqlite.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  test("measurement selects imported P1 after completed admission but preserves a pure P0 child", async () => {
    const f = fixture(1);
    const parent = f.current.repos[0]!;
    const p0 = parent.source!;
    const p1 = { ...p0, commit: oid(80), tree: oid(180) };
    const graph = f.graphs.get(p0.sourceId)!;
    graph.set(p1.commit, {
      parents: [p0.commit],
      treeHash: p1.tree,
      hash: p1.commit,
      message: "P1",
    });
    parent.source = p1;
    parent.commit = p1.commit;
    await recordIntent(f.env, f.current, parent, oid(102));
    f.sqlite.exec(`INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
      VALUES('work_child','repo0','child','child','owner','work_child','https://work_child','ready','child-allocation','${p0.sourceId}','${p0.commit}','${p0.tree}','refs/heads/work','${p0.sourceId}','${p0.commit}','${p0.tree}','refs/heads/work','now','now',1);
      INSERT INTO source_progress_members(repo_id,source_id,commit_oid,operation_id,created_at)
      VALUES('repo0','${p0.sourceId}','${p1.commit}','parent-push','now');
      INSERT INTO source_revision_origins(repo_id,commit_oid,source_id)
      VALUES('repo0','${p1.commit}','${p0.sourceId}')`);
    const child = {
      ...parent,
      source: { ...p0, sourceId: "work_child", timelineId: "child" },
      logicalBase: p0,
      dependencies: [],
    };
    const timeline = { id: "child", repos: [child] } as unknown as Timeline;
    const childGraph = new Map(graph);
    childGraph.set(oid(81), {
      parents: [p0.commit],
      treeHash: oid(181),
      hash: oid(81),
      message: "child",
    });
    childGraph.set(oid(82), {
      parents: [oid(81), p1.commit],
      treeHash: oid(182),
      hash: oid(82),
      message: "import",
    });
    f.graphs.set("work_child", childGraph);
    f.refs.set("work_child", new Map([["refs/heads/work", oid(82)]]));
    vi.mocked(lsRefs).mockImplementation(async (_env, name) =>
      [...f.refs.get(name)!].map(([name, oid]) => ({ name, oid })),
    );
    const actor = { id: "owner", slug: "owner", displayName: "Owner", isSiteAdmin: false };
    const [unintegrated] = await measure(f.env, actor, timeline);
    expect(unintegrated!.logicalBase).toEqual(p0);
    expect(unintegrated!.dependencies?.map((dependency) => dependency.source.commit)).toEqual([
      p1.commit,
    ]);
    await expect(
      validateDependencies(f.env, { ...parent, ...unintegrated! }, new Set([parent.base!])),
    ).rejects.toThrow("blocked_dependency");
    f.sqlite.exec("UPDATE source_integration_receipts SET status='complete'");
    f.refs.get(parent.id)!.set("refs/heads/main", parent.merge!);
    // Completing the parent cannot repair a previously reviewed checkpoint.
    await expect(
      validateDependencies(
        f.env,
        { ...parent, ...unintegrated! },
        new Set([parent.base!, parent.merge!]),
      ),
    ).rejects.toThrow();
    const [measured] = await measure(f.env, actor, timeline);
    expect(measured!.logicalBase).toEqual(p1);
    expect(measured!.commit).toBe(unintegrated!.commit);
    expect(unintegrated!.logicalBase).toEqual(p0);
    expect(measured!.dependencies?.map((dependency) => dependency.source.commit)).toEqual([
      p1.commit,
    ]);
    await expect(
      validateDependencies(
        f.env,
        { ...parent, ...measured! },
        new Set([parent.base!, parent.merge!]),
      ),
    ).resolves.toBeUndefined();
    f.refs.get("work_child")!.set("refs/heads/work", oid(81));
    expect((await measure(f.env, actor, timeline))[0]!.logicalBase).toEqual(p0);
    f.refs.get("work_child")!.set("refs/heads/work", oid(82));
    f.sqlite.exec(`INSERT INTO source_integration_receipts
      SELECT 'duplicate','duplicate',checkpoint_id,repo_id,source_id,source_commit,source_tree,logical_base_json,dependencies_json,canonical_base,canonical_commit,canonical_tree,noop,status,created_at,completed_at FROM source_integration_receipts;
      INSERT INTO source_integration_members SELECT 'duplicate',repo_id,source_id,commit_oid FROM source_integration_members WHERE receipt_id='landing:repo0'`);
    const [ambiguous] = await measure(f.env, actor, timeline);
    expect(ambiguous!.logicalBase).toEqual(p0);
    await expect(
      validateDependencies(
        f.env,
        { ...parent, ...ambiguous! },
        new Set([parent.base!, parent.merge!]),
      ),
    ).rejects.toThrow("blocked_dependency");
    f.sqlite.exec(
      "DELETE FROM source_integration_members WHERE receipt_id='duplicate'; DELETE FROM source_integration_receipts WHERE id='duplicate'",
    );
    f.sqlite.exec("UPDATE source_integration_receipts SET status='intent'");
    f.refs.get("work_child")!.set("refs/heads/work", oid(82));
    const [unproved] = await measure(f.env, actor, timeline);
    expect(unproved!.logicalBase).toEqual(p0);
    expect(unproved!.dependencies).toEqual(unintegrated!.dependencies);
    await expect(
      validateDependencies(
        f.env,
        { ...parent, ...unproved! },
        new Set([parent.base!, parent.merge!]),
      ),
    ).rejects.toThrow("blocked_dependency");
  });
  test("unrecorded and incomparable merge inputs block instead of replaying foreign work", async () => {
    const f = fixture(1),
      repo = f.current.repos[0]!;
    const graph: Record<string, string[]> = {
      base: [],
      local: ["base"],
      foreign: ["base"],
      merge: ["local", "foreign"],
    };
    const read = async (oid: string) => graph[oid] ?? null;
    await expect(
      validateMergeEdges(f.env, repo.source!, "merge", "base", [], read),
    ).rejects.toThrow("blocked_dependency");
    await expect(
      validateMergeEdges(f.env, repo.source!, "merge", "base", ["foreign"], read),
    ).resolves.toBeUndefined();
    await recordIntent(f.env, f.current, repo, oid(102));
    f.sqlite.exec("UPDATE source_integration_receipts SET status='complete'");
    const dependency = { source: repo.source!, base: repo.logicalBase! };
    const imported = { ...repo, logicalBase: repo.source!, dependencies: [dependency] };
    await expect(
      validateDependencies(f.env, imported, new Set([repo.base!, repo.merge!])),
    ).resolves.toBeUndefined();
    f.sqlite
      .exec(`INSERT INTO source_integration_receipts SELECT 'second','second',checkpoint_id,repo_id,source_id,source_commit,source_tree,logical_base_json,dependencies_json,canonical_base,canonical_commit,canonical_tree,noop,status,created_at,completed_at FROM source_integration_receipts;
      INSERT INTO source_integration_members SELECT 'second',repo_id,source_id,commit_oid FROM source_integration_members WHERE receipt_id='landing:repo0';`);
    await expect(
      validateDependencies(f.env, imported, new Set([repo.base!, repo.merge!])),
    ).rejects.toThrow("blocked_dependency");
  });
  test("full graph closure traverses both parents and blocks unavailable evidence", async () => {
    const parents: Record<string, string[]> = {
      tip: ["left", "right"],
      left: ["base"],
      right: ["foreign"],
      foreign: ["base"],
      base: [],
    };
    expect(await revisionClosure("tip", async (oid) => parents[oid] ?? null)).toEqual(
      new Set(Object.keys(parents)),
    );
    delete parents.foreign;
    await expect(revisionClosure("tip", async (oid) => parents[oid] ?? null)).rejects.toThrow(
      "unavailable",
    );
  });
  test("P0 membership in later P1 admits exact P0, not the compact canonical tree", async () => {
    const f = fixture(1),
      parent = f.current.repos[0]!;
    const p0 = parent.commit,
      p1 = oid(80);
    f.graphs
      .get(parent.source!.sourceId)!
      .set(p1, { parents: [p0], treeHash: oid(180), hash: p1, message: "P1" });
    parent.commit = p1;
    parent.source = { ...parent.source!, commit: p1, tree: oid(180) };
    await recordIntent(f.env, f.current, parent, oid(102));
    const exact = { ...parent.source, commit: p0, tree: oid(102) };
    const child = {
      ...parent,
      source: { ...parent.source, sourceId: "work_child" },
      logicalBase: exact,
      dependencies: [],
    };
    const canonical = new Set([parent.base!, parent.merge!]);
    await expect(validateDependencies(f.env, child, canonical)).rejects.toThrow(
      "blocked_dependency",
    );
    f.sqlite.exec("UPDATE source_integration_receipts SET status='complete'");
    await expect(validateDependencies(f.env, child, canonical)).resolves.toBeUndefined();
    expect(child.logicalBase.commit).toBe(p0);
    expect((await admittedReceipts(f.env, exact, canonical))[0]!.source_commit).toBe(p1);
    await expect(validateDependencies(f.env, child, new Set([parent.base!]))).rejects.toThrow(
      "blocked_dependency",
    );
    await expect(
      validateDependencies(
        f.env,
        { ...child, logicalBase: { ...exact, commit: oid(999) } },
        canonical,
      ),
    ).rejects.toThrow("blocked_dependency");
  });
});
