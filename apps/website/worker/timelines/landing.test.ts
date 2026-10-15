import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Landing, LandingRepo, Timeline } from "../../shared/timelines.ts";
import type { SourceSnapshot } from "../../shared/code-source.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { issueToken } from "../api/tokens.ts";
import { accessFor } from "../tracker/access.ts";
import { findSpaceById } from "../spaces/access.ts";
import { initializeWorkSource, type WorkSourceRow } from "./sources.ts";
import { retainProgress } from "../git/source-push.ts";
import type { RepoRow } from "../db.ts";
import { greenness, progress, sweepSpaces, type LandingDeps } from "./landing.ts";
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
vi.mock("../artifacts.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof Artifacts>()),
  lsRefs: vi.fn(),
}));
vi.mock("../tracker/stub.ts", () => ({
  trackerObject: (env: Env, owner: string) => env.TRACKER.getByName(owner),
}));
const oid = (value: number) => value.toString(16).padStart(40, "0");
async function fixture(count = 2) {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite } = fresh;
  onTestFinished(fresh.close);
  sqlite.exec(
    "INSERT INTO accounts(id,kind,slug,display_name) VALUES('owner','user','owner','Owner')",
  );
  await seedSpaceFixture(fresh.env.DB, {
    organization: { id: "org", slug: "organization", displayName: "Organization", kind: "company" },
    space: { id: "space", slug: "owner", displayName: "Space" },
    members: [
      {
        accountId: "owner",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "owner",
  });
  const token = await issueToken(fresh.env.DB, "owner", "fixture", "write");
  const actor = {
    id: "owner",
    slug: "owner",
    displayName: "Owner",
    isSiteAdmin: false,
    credential: { kind: "token", id: token.id } as const,
  };
  const space = await findSpaceById(fresh.env.DB, "space");
  if (!space) throw new Error("Missing fixture Space");
  const access = await accessFor(fresh.env, space, "owner", null, true, actor.credential);
  const authority = {
    spaceId: "space",
    migrationEpoch: access.migrationEpoch,
    personId: "owner",
    agentId: null,
    credential: actor.credential,
  };
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
    sqlite.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES('${id}','space','${id}','private','${id}','https://${id}');
      INSERT INTO timeline_work_sources(source_id,repo_id,timeline_id,timeline_slug,space_id,authority,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
      VALUES('${sourceId}','${id}','timeline','test','space','${JSON.stringify(authority)}','${sourceId}','https://${sourceId}','ready','allocation${n}','canonical','${base}','${oid(101)}','refs/heads/main','canonical','${base}','${oid(101)}','refs/heads/main','now','now',1);`);
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
      space: "owner",
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
    authority,
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
    landingForSettlement: async () => ({ ok: true, value: current }),
    completeLandingForSettlement: async (_scope: unknown, next: Landing) => {
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
    ...fresh.env,
    TRACKER: { getByName: () => tracker },
    ARTIFACTS: {
      get: async (name: string) => ({
        readCommit: async (commit: string) => graphs.get(name)?.get(commit) ?? null,
        [Symbol.dispose]() {},
      }),
    },
  } as unknown as Env;
  const writes: string[] = [],
    starts: string[] = [],
    messages = new Map<string, string>();
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
    startMerge: async (repo, merge) => {
      starts.push(repo.id);
      messages.set(repo.id, merge.message);
    },
    startGates: async () => ({ skipped: "no pipeline" }),
    runOutcome: async () => null,
    mainMoved() {},
    refsDeleted: async () => {},
    // Most tests change the world between looks; retries in place are tested below.
    stepRetryMs: [],
  };
  return {
    access,
    actor,
    authority,
    sqlite,
    env,
    deps,
    tracker,
    refs,
    graphs,
    writes,
    starts,
    messages,
    get current() {
      return current;
    },
    run: () => progress(env, deps, "space", current),
  };
}

describe("explicit canonical checkpoint bases", () => {
  async function syncedSource() {
    const f = await fixture(1);
    const repo = f.current.repos[0]!;
    const base = { ...repo.logicalBase! };
    const main = {
      hash: oid(80),
      parents: [base.commit],
      treeHash: oid(180),
      message: "canonical change",
    };
    const source = { ...repo.source!, commit: oid(82), tree: oid(182) };
    const graph = f.graphs.get("work_0")!;
    graph.set(main.hash, main);
    graph.set(source.commit, {
      hash: source.commit,
      parents: [repo.commit, main.hash],
      treeHash: source.tree,
      message: "resolved main synchronization",
    });
    f.graphs.get(repo.id)!.set(main.hash, main);
    f.refs.get(repo.id)!.set("refs/heads/main", main.hash);
    f.refs.get("work_0")!.set("refs/heads/work", source.commit);
    const timeline = { id: "timeline", repos: [repo] } as unknown as Timeline;
    vi.mocked(lsRefs).mockImplementation(async (_env, name) =>
      [...f.refs.get(name)!].map(([name, oid]) => ({ name, oid })),
    );
    return { f, repo, base, main, source, graph, timeline };
  }

  test("only explicit renewal changes B; source and allocation snapshots remain intact", async () => {
    const { f, repo, base, main, source, timeline } = await syncedSource();
    try {
      const [ordinary] = await measure(f.env, f.actor, timeline);
      const [renewed] = await measure(f.env, f.actor, timeline, true);
      expect(ordinary!.logicalBase).toEqual(base);
      expect(renewed!.logicalBase).toEqual({
        ...base,
        commit: main.hash,
        tree: main.treeHash,
      });
      expect(renewed!.base).toBe(main.hash);
      expect(renewed!.source).toEqual(source);
      expect(renewed!.dependencies).toEqual([]);
      expect(repo.logicalBase).toEqual(base);
      expect(
        f.sqlite.prepare("SELECT fork_commit, fork_tree FROM timeline_work_sources").get(),
      ).toEqual({ fork_commit: base.commit, fork_tree: base.tree });
      const [laterOrdinary] = await measure(f.env, f.actor, timeline);
      expect(laterOrdinary!.logicalBase).toEqual(base);
      expect(ordinary!.logicalBase).toEqual(base);
    } finally {
      f.sqlite.close();
    }
  });

  test("the original base itself counts as current main in work ancestry", async () => {
    const f = await fixture(1);
    try {
      const repo = f.current.repos[0]!;
      const timeline = { id: "timeline", repos: [repo] } as unknown as Timeline;
      vi.mocked(lsRefs).mockImplementation(async (_env, name) =>
        [...f.refs.get(name)!].map(([name, oid]) => ({ name, oid })),
      );
      const [renewed] = await measure(f.env, f.actor, timeline, true);
      expect(renewed!.logicalBase).toEqual(repo.logicalBase);
      expect(renewed!.source).toEqual(repo.source);
    } finally {
      f.sqlite.close();
    }
  });

  test.each([
    "unmerged main with equal content",
    "missing main ref",
    "unavailable main snapshot",
    "prior base outside canonical history",
    "foreign logical base",
    "declared dependency",
    "inferred dependency",
  ] as const)("renewal fails closed for %s", async (mode) => {
    const { f, repo, base, main, source, graph, timeline } = await syncedSource();
    try {
      const canonical = f.graphs.get(repo.id)!;
      if (mode === "unmerged main with equal content") {
        canonical.set(oid(83), {
          hash: oid(83),
          parents: [main.hash],
          treeHash: source.tree,
          message: "new main not imported into work",
        });
        f.refs.get(repo.id)!.set("refs/heads/main", oid(83));
      } else if (mode === "missing main ref") {
        f.refs.get(repo.id)!.delete("refs/heads/main");
      } else if (mode === "unavailable main snapshot") {
        canonical.delete(main.hash);
      } else if (mode === "prior base outside canonical history") {
        const replaced = { hash: oid(84), parents: [], treeHash: oid(184), message: "new root" };
        canonical.set(replaced.hash, replaced);
        graph.set(replaced.hash, replaced);
        graph.get(source.commit)!.parents = [repo.commit, replaced.hash];
        f.refs.get(repo.id)!.set("refs/heads/main", replaced.hash);
      } else if (mode === "foreign logical base") {
        repo.logicalBase = {
          ...base,
          kind: "timeline-work",
          sourceId: "foreign",
          timelineId: "parent",
          ref: "refs/heads/work",
        };
      } else {
        const foreign = { ...source, sourceId: "foreign", timelineId: "parent", commit: oid(90) };
        f.sqlite.exec(`INSERT INTO timeline_work_sources
          (source_id,repo_id,timeline_id,timeline_slug,space_id,authority,artifacts_name,artifacts_remote,state,
           allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
           initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
          VALUES('foreign','repo0','parent','parent','space','${JSON.stringify(f.authority)}','foreign','https://foreign','ready',
            'foreign-allocation','canonical','${base.commit}','${base.tree}','refs/heads/main',
            'canonical','${base.commit}','${base.tree}','refs/heads/main','now','now',1);`);
        if (mode === "declared dependency") {
          repo.dependencies = [{ source: foreign, base }];
        } else {
          graph.set(foreign.commit, {
            hash: foreign.commit,
            parents: [base.commit],
            treeHash: foreign.tree,
            message: "foreign work",
          });
          graph.get(repo.commit)!.parents = [foreign.commit];
          f.sqlite.exec(`INSERT INTO source_revision_origins(repo_id,commit_oid,source_id)
            VALUES('repo0','${foreign.commit}','foreign')`);
        }
      }
      const measured = measure(f.env, f.actor, timeline, true);
      if (mode === "unavailable main snapshot")
        await expect(measured).rejects.toThrow("blocked_dependency");
      else await expect(measured).rejects.toMatchObject({ code: "blocked_dependency" });
      expect(
        f.sqlite.prepare("SELECT COUNT(*) AS count FROM source_integration_receipts").get(),
      ).toEqual({ count: 0 });
    } finally {
      f.sqlite.close();
    }
  });
});

describe("compact landing state", () => {
  test("a failing gate blocks every repository", async () => {
    const f = await fixture();
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
    const f = await fixture();
    const b = f.current.repos[1]!;
    // The compact commit carries the keys B's work source mentions (CORE-296).
    f.sqlite.exec(`INSERT INTO commit_issue_mentions
        (repo_id, commit_oid, issue_key, resolution, source_id) VALUES
        ('${b.id}', '${b.commit}', 'CORE-9', 'linked', '${b.source!.sourceId}'),
        ('${b.id}', '${b.commit}', 'APP-2', 'ambiguous', '${b.source!.sourceId}'),
        ('${b.id}', '${b.base}', 'OLD-1', 'linked', 'canonical')`);
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
    expect(f.messages.get(b.id)).toMatch(/\nIssues: APP-2 CORE-9$/);
    expect(f.current.repos[1]!.base).toBe(oid(99));
  });
  test("concurrent progress waits for the admitted CAS instead of failing a live publication", async () => {
    const f = await fixture(1);
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
  test.each(["conflict", "interrupted"] as const)(
    "receipt barrier waits for durable Tracker progress after a %s save",
    async (failure) => {
      const f = await fixture();
      try {
        Object.assign(f.env, { DEV_MODE: "true", AGENT_ID: "landing-recovery-test" });
        f.current.slug = "source-landing-12345678-retry-partial";
        for (const [index, repo] of f.current.repos.entries()) {
          repo.space = "orbit";
          repo.name = `queue-${String(index).padStart(8, "0")}`;
        }
        f.sqlite.exec(`CREATE TABLE dev_landing_barriers
          (timeline_id TEXT PRIMARY KEY, point TEXT, repo_id TEXT, hit INTEGER DEFAULT 0, released INTEGER DEFAULT 0);
          INSERT INTO dev_landing_barriers(timeline_id,point,repo_id)
          VALUES('timeline','after-receipt','repo0')`);
        const save = f.tracker.saveLanding;
        let failed = false;
        f.tracker.saveLanding = async (next, version) => {
          if (!failed && next.repos[0]!.state === "advanced") {
            failed = true;
            if (failure === "interrupted") throw new Error("Tracker save interrupted");
            // Another progress invocation won an optimistic save without yet
            // recording the already-published repository as advanced.
            f.current.version++;
          }
          return save(next, version);
        };
        await f.run();
        const paused = await f.run();
        expect(failed).toBe(true);
        expect(paused.state).toBe("advancing");
        expect(paused.repos.map((repo) => repo.state)).toEqual(["advanced", "tested"]);
        expect(f.writes).toEqual(["repo0"]);
        expect(f.sqlite.prepare("SELECT hit FROM dev_landing_barriers").get()).toEqual({ hit: 1 });
        expect(f.sqlite.prepare("SELECT status FROM source_integration_receipts").get()).toEqual({
          status: "integrated",
        });
        f.sqlite.exec("UPDATE dev_landing_barriers SET released=1");
        expect((await f.run()).state).toBe("landed");
        expect(f.writes).toEqual(["repo0", "repo1"]);
        expect(
          f.sqlite
            .prepare("SELECT repo_id,status FROM source_integration_receipts ORDER BY repo_id")
            .all(),
        ).toEqual([
          { repo_id: "repo0", status: "complete" },
          { repo_id: "repo1", status: "complete" },
        ]);
      } finally {
        f.sqlite.close();
      }
    },
  );
  test("a tombstone before provider submission releases the known-unsubmitted admission", async () => {
    const f = await fixture(1);
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
    const f = await fixture(1),
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
      const f = await fixture(1),
        write = f.deps.writeRefs.bind(f.deps),
        refs = f.deps.refs.bind(f.deps);
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
        // Rewrite after reconciliation observes main, before the receipt's
        // fresh ref check. Immutable ancestry may already be cached.
        let observations = 0;
        f.deps.refs = async (repo) => {
          const observed = new Map(await refs(repo));
          if (repo.artifacts_name === "repo0" && ++observations === 2) rewrite();
          return observed;
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
      const f = await fixture();
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
          (id,space_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
          VALUES('landing:landing:repo0','space','timeline','repo0','work_0','landing','accepted','{}','now','now')`);
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
  test("a canonical ref transport failure preserves prepared work for the next progress request", async () => {
    const f = await fixture();
    for (const [index, repo] of f.current.repos.entries())
      repo.gateRun = { id: `gate${index}`, number: 2 };
    const prepared = structuredClone(f.current.repos);
    const refs = f.deps.refs.bind(f.deps);
    let interrupted = false;
    f.deps.refs = async (repo) => {
      if (repo.artifacts_name === "repo1" && f.writes.includes("repo0") && !interrupted) {
        interrupted = true;
        throw new Error("Peer closed WebSocket: 1006");
      }
      return refs(repo);
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
    const f = await fixture();
    for (const [index, repo] of f.current.repos.entries())
      repo.gateRun = { id: `gate${index}`, number: 2 };
    f.deps.stepRetryMs = [0, 0];
    const refs = f.deps.refs.bind(f.deps);
    let interrupted = false;
    f.deps.refs = async (repo) => {
      if (repo.artifacts_name === "repo1" && f.writes.includes("repo0") && !interrupted) {
        interrupted = true;
        throw new Error("Peer closed WebSocket: 1006");
      }
      return refs(repo);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await f.run()).state).toBe("landed");
    expect(interrupted).toBe(true);
    expect(f.writes).toEqual(["repo0", "repo1"]);
    warn.mockRestore();
  });
  test("a step that keeps failing is left to the next look after its retries", async () => {
    const f = await fixture();
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
    const f = await fixture();
    f.graphs.get("work_1")!.delete(f.current.repos[1]!.commit);
    expect((await f.run()).state).toBe("blocked_dependency");
    expect(f.current.repos[1]!.state).toBe("blocked_dependency");
    expect(f.writes).toEqual([]);
    for (const repo of f.current.repos)
      expect(f.refs.get(repo.id)!.get("refs/heads/main")).toBe(repo.base);
  });
  test("unknown force-rewritten CAS outcome blocks without recomputing or replaying", async () => {
    const f = await fixture(1),
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
    const f = await fixture(1);
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
    const f = await fixture(1);
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
    const f = await fixture(),
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
    const f = await fixture();
    try {
      Object.assign(f.env, { DEV_MODE: "true", AGENT_ID: "landing-barrier-test" });
      f.current.slug = "source-landing-12345678-unknown-rewrite";
      for (const [index, repo] of f.current.repos.entries()) {
        repo.space = "orbit";
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
    const f = await fixture(1),
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
  test.each([
    "proven marker",
    "pending projection",
    "intent only",
    "different marker",
    "different proven head",
    "different operation",
    "different source",
    "foreign origin",
  ])("%s: checkpoint admission requires exact recovery-fence provenance", async (mode) => {
    const f = await fixture(1);
    try {
      const repo = f.current.repos[0]!;
      const source = repo.source!;
      const fence = oid(4);
      const merge = oid(5);
      const graph = f.graphs.get(source.sourceId)!;
      graph.set(fence, {
        hash: fence,
        parents: [repo.base!],
        treeHash: repo.logicalBase!.tree,
        message: "Recovery fence",
      });
      graph.set(merge, {
        hash: merge,
        parents: [source.commit, fence],
        treeHash: source.tree,
        message: "Merge the recovery fence",
      });
      f.refs.get(source.sourceId)!.set(source.ref, merge);
      vi.mocked(lsRefs).mockImplementation(async (_env, name) =>
        [...f.refs.get(name)!].map(([name, oid]) => ({ name, oid })),
      );
      const recovery: { commit: string; head: string; outcome?: string } = {
        commit: mode === "different marker" ? source.commit : fence,
        head: mode === "different proven head" ? source.commit : fence,
        outcome: "rejected",
      };
      if (mode === "intent only") delete recovery.outcome;
      f.sqlite
        .prepare(`INSERT INTO source_operations
          (id,space_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
          VALUES('recovery','space','timeline','repo0',?,'push',?,?,'now','now')`)
        .run(
          mode === "different source" ? "foreign" : source.sourceId,
          mode === "pending projection" ? "ambiguous" : "rejected",
          JSON.stringify({
            commands: [{ ref: source.ref, old: repo.base, new: source.commit }],
            // D1's terminal row is the projection proof; the Tracker's later
            // acknowledgement flag need not have been copied back into it.
            projectionPending: true,
            recovery: { ...recovery, projected: false },
          }),
        );
      f.sqlite
        .prepare(`INSERT INTO source_progress_members
          (repo_id,source_id,commit_oid,operation_id,created_at) VALUES('repo0',?,?,?,'now')`)
        .run(source.sourceId, fence, mode === "different operation" ? "other" : "recovery");
      f.sqlite
        .prepare(
          "INSERT INTO source_revision_origins(repo_id,commit_oid,source_id) VALUES('repo0',?,?)",
        )
        .run(fence, mode === "foreign origin" ? "foreign" : source.sourceId);
      const timeline: Timeline = {
        id: "timeline",
        slug: "test",
        name: "Recovery",
        policy: "auto",
        experimental: false,
        parentId: null,
        forkPoint: { commits: { repo0: repo.base! }, trackerCursor: 0 },
        repos: [{ ...repo, bookmark: "timeline/test" }],
        status: "active",
        accountableId: "owner",
        startedBy: "owner",
        agentIds: [],
        version: 1,
        createdAt: "now",
        updatedAt: "now",
        pushedAt: null,
      };
      if (mode === "proven marker") {
        const [measured] = await measure(f.env, f.actor, timeline);
        expect(measured!.source).toMatchObject({
          sourceId: source.sourceId,
          commit: merge,
          tree: source.tree,
        });
        expect(measured!.logicalBase).toEqual(repo.logicalBase);
        expect(measured!.dependencies).toEqual([]);
      } else {
        await expect(measure(f.env, f.actor, timeline)).rejects.toThrow("blocked_dependency");
      }
    } finally {
      f.sqlite.close();
    }
  });

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
      const f = await fixture(1);
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
          (id,space_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
          VALUES(?,'space','timeline','repo0','work_0','push','accepted',?,'now','now')`)
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
          const tracker = f.env.TRACKER.getByName("space");
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
            f.access,
            f.sqlite.prepare("SELECT * FROM repos WHERE id='repo0'").get() as unknown as RepoRow,
            {
              authority: f.authority,
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
        const canonical = await revisionClosure(base, read);
        const validate = () => validateMergeEdges(f.env, source, merge, base, [], read, canonical);
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
          validateMergeEdges(f.env, source, importedMerge, base, [], read, canonical),
        ).rejects.toThrow("blocked_dependency");
        // Even a linear import keeps its foreign attribution after physical expiry.
        await expect(
          validateMergeEdges(f.env, source, localTip, base, [], read, canonical),
        ).rejects.toThrow("blocked_dependency");
        expect(
          f.sqlite
            .prepare("SELECT source_id FROM source_revision_origins WHERE commit_oid=?")
            .get(foreign),
        ).toEqual({ source_id: "foreign" });
        f.sqlite.exec(`
        INSERT INTO timeline_work_sources
          (source_id,repo_id,timeline_id,timeline_slug,space_id,authority,artifacts_name,artifacts_remote,state,
           allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
           initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
        VALUES('descendant','repo0','child','child','space','${JSON.stringify(f.authority)}','descendant','https://descendant','ready',
          'child-allocation','work_0','${right}','${workTree}','refs/heads/work',
          'work_0','${right}','${workTree}','refs/heads/work',
          '2026-10-05T00:00:01.000Z','2026-10-05T00:00:01.000Z',1);
        INSERT INTO source_progress_members(repo_id,source_id,commit_oid,operation_id,created_at)
        VALUES('repo0','descendant','${right}','child-allocation','2026-10-05T00:00:01.000Z');`);
        f.sqlite.exec(`INSERT INTO timeline_work_sources
        (source_id,repo_id,timeline_id,timeline_slug,space_id,authority,artifacts_name,artifacts_remote,state,
         allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
         initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
        VALUES('foreign','repo0','foreign','foreign','space','${JSON.stringify(f.authority)}','foreign','https://foreign','purged',
          'foreign-allocation','canonical','${base}','${baseTree}','refs/heads/main',
          'canonical','${base}','${baseTree}','refs/heads/main','now','now',1);`);
        f.refs.get("work_0")!.set("refs/heads/work", localTip);
        await expect(
          measure(f.env, f.actor, {
            id: "timeline",
            repos: [repo],
          } as unknown as Timeline),
        ).rejects.toThrow("Source expired");
        f.refs.get("work_0")!.set("refs/heads/work", merge);
        await expect(validate()).resolves.toBeUndefined();
        const [checkpoint] = await measure(f.env, f.actor, {
          id: "timeline",
          repos: [repo],
        } as unknown as Timeline);
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
  test.each([
    "linear",
    "merge",
    "foreign",
    "equal tree",
    "declared",
    "canonical removed",
    "foreign side",
    "unacknowledged side",
  ] as const)("canonical ancestry does not imply foreign source ownership: %s", async (mode) => {
    const f = await fixture(1);
    try {
      const repo = f.current.repos[0]!;
      const base = repo.logicalBase!;
      const imported = {
        ...repo.source!,
        sourceId: "foreign",
        timelineId: "foreign",
        commit: oid(80),
      };
      const queued = oid(81);
      const main = oid(82);
      const local = oid(83);
      const side = oid(84);
      const graph = f.graphs.get("work_0")!;
      const canonicalGraph = f.graphs.get(repo.id)!;
      const append = (hash: string, parents: string[]) => ({
        hash,
        parents,
        treeHash: imported.tree,
        message: "snapshot",
      });
      graph.set(queued, append(queued, [base.commit]));
      graph.set(imported.commit, append(imported.commit, [base.commit, queued]));
      graph.set(local, append(local, [base.commit]));
      graph.set(
        repo.commit,
        append(repo.commit, mode === "linear" ? [imported.commit] : [local, imported.commit]),
      );
      canonicalGraph.set(main, append(main, [base.commit]));
      if (mode === "foreign") canonicalGraph.get(main)!.treeHash = oid(180);
      if (mode !== "foreign" && mode !== "equal tree") {
        canonicalGraph.set(queued, graph.get(queued)!);
        canonicalGraph.set(imported.commit, graph.get(imported.commit)!);
        canonicalGraph.set(main, append(main, [imported.commit]));
      }
      // In the equal-tree case, matching content is deliberately not matching
      // canonical history and must still require an exact source integration.
      f.refs.get(repo.id)!.set("refs/heads/main", main);
      canonicalGraph.set(repo.merge!, append(repo.merge!, [main]));
      f.sqlite.exec(`INSERT INTO timeline_work_sources
        (source_id,repo_id,timeline_id,timeline_slug,space_id,authority,artifacts_name,artifacts_remote,state,
         allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
         initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
        VALUES('foreign','repo0','foreign','foreign','space','${JSON.stringify(f.authority)}','foreign','https://foreign','ready',
          'foreign-allocation','canonical','${base.commit}','${base.tree}','refs/heads/main',
          'canonical','${base.commit}','${base.tree}','refs/heads/main','now','now',1);
        INSERT INTO source_revision_origins(repo_id,commit_oid,source_id)
        VALUES('repo0','${imported.commit}','foreign'),('repo0','${queued}','foreign')`);
      if (mode === "foreign side" || mode === "unacknowledged side") {
        graph.set(side, append(side, [base.commit]));
        graph.set(local, append(local, [base.commit, side]));
        if (mode === "foreign side")
          f.sqlite
            .prepare(`INSERT INTO source_revision_origins(repo_id,commit_oid,source_id)
            VALUES('repo0',?,'foreign')`)
            .run(side);
      }
      if (mode === "declared") repo.dependencies = [{ source: imported, base }];
      vi.mocked(lsRefs).mockImplementation(async (_env, name) =>
        [...f.refs.get(name)!].map(([name, oid]) => ({ name, oid })),
      );
      const checkpoint = measure(f.env, f.actor, {
        id: "timeline",
        repos: [repo],
      } as unknown as Timeline);
      if (mode === "unacknowledged side") {
        await expect(checkpoint).rejects.toThrow("blocked_dependency");
      } else {
        const [measured] = await checkpoint;
        expect(measured!.logicalBase).toEqual(base);
        expect(measured!.dependencies?.map((dependency) => dependency.source.commit)).toEqual(
          mode === "foreign" || mode === "equal tree" || mode === "declared"
            ? [imported.commit]
            : mode === "foreign side"
              ? [side]
              : [],
        );
        Object.assign(repo, measured);
      }
      if (mode === "canonical removed") f.refs.get(repo.id)!.set("refs/heads/main", base.commit);
      const result = await f.run();
      if (mode === "linear" || mode === "merge") {
        expect(result.state).toBe("landed");
        expect(f.writes).toEqual([repo.id]);
        expect(
          f.sqlite
            .prepare("SELECT source_id FROM source_revision_origins WHERE commit_oid=?")
            .get(imported.commit),
        ).toEqual({ source_id: "foreign" });
        expect(
          f.sqlite.prepare("SELECT source_id,status FROM source_integration_receipts").all(),
        ).toEqual([{ source_id: "work_0", status: "complete" }]);
      } else {
        expect(result.state).toBe("blocked_dependency");
        expect(f.writes).toEqual([]);
        expect(
          f.sqlite.prepare("SELECT count(*) AS count FROM source_integration_receipts").get(),
        ).toEqual({ count: 0 });
      }
    } finally {
      f.sqlite.close();
    }
  });
  test.each(["canonical missing", "canonical error", "source missing", "source error"] as const)(
    "canonical admission still requires complete available ancestry: %s",
    async (mode) => {
      const f = await fixture(1);
      try {
        const repo = f.current.repos[0]!;
        const ancestor = oid(80);
        const commit = {
          hash: ancestor,
          parents: [repo.base!],
          treeHash: oid(102),
          message: "canonical",
        };
        f.graphs.get(repo.id)!.set(ancestor, commit);
        f.graphs.get("work_0")!.set(ancestor, commit);
        f.graphs.get("work_0")!.get(repo.commit)!.parents = [ancestor];
        f.refs.get(repo.id)!.set("refs/heads/main", ancestor);
        const target = mode.startsWith("canonical") ? repo.id : "work_0";
        if (mode.endsWith("missing")) f.graphs.get(target)!.delete(ancestor);
        else {
          const get = f.env.ARTIFACTS.get.bind(f.env.ARTIFACTS);
          Object.assign(f.env.ARTIFACTS, {
            get: async (name: string) => {
              const artifacts = await get(name);
              const read = artifacts.readCommit.bind(artifacts);
              return Object.assign(artifacts, {
                readCommit: async (hash: string) => {
                  if (name === target && hash === ancestor)
                    throw new Error("Artifacts INTERNAL_ERROR");
                  return read(hash);
                },
              });
            },
          });
          const parents = f.deps.parents.bind(f.deps);
          f.deps.parents = async (row, hash) => {
            if (row.artifacts_name === target && hash === ancestor)
              throw new Error("Artifacts INTERNAL_ERROR");
            return parents(row, hash);
          };
        }
        vi.mocked(lsRefs).mockImplementation(async (_env, name) =>
          [...f.refs.get(name)!].map(([name, oid]) => ({ name, oid })),
        );
        await expect(
          measure(f.env, f.actor, {
            id: "timeline",
            repos: [repo],
          } as unknown as Timeline),
        ).rejects.toThrow(mode.endsWith("error") ? "Artifacts INTERNAL_ERROR" : /unavailable/);
        expect((await f.run()).state).toBe(
          mode.endsWith("error") ? "advancing" : "blocked_dependency",
        );
        expect(f.writes).toEqual([]);
      } finally {
        f.sqlite.close();
      }
    },
  );
  test("measurement selects imported P1 after completed admission but preserves a pure P0 child", async () => {
    const f = await fixture(1);
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
      (source_id,repo_id,timeline_id,timeline_slug,space_id,authority,artifacts_name,artifacts_remote,state,allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
      VALUES('work_child','repo0','child','child','space','${JSON.stringify(f.authority)}','work_child','https://work_child','ready','child-allocation','${p0.sourceId}','${p0.commit}','${p0.tree}','refs/heads/work','${p0.sourceId}','${p0.commit}','${p0.tree}','refs/heads/work','now','now',1);
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
    const [unintegrated] = await measure(f.env, f.actor, timeline);
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
    const [measured] = await measure(f.env, f.actor, timeline);
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
    expect((await measure(f.env, f.actor, timeline))[0]!.logicalBase).toEqual(p0);
    f.refs.get("work_child")!.set("refs/heads/work", oid(82));
    f.sqlite.exec(`INSERT INTO source_integration_receipts
      SELECT 'duplicate','duplicate',checkpoint_id,repo_id,source_id,source_commit,source_tree,logical_base_json,dependencies_json,canonical_base,canonical_commit,canonical_tree,noop,status,created_at,completed_at FROM source_integration_receipts;
      INSERT INTO source_integration_members SELECT 'duplicate',repo_id,source_id,commit_oid FROM source_integration_members WHERE receipt_id='landing:repo0'`);
    const [ambiguous] = await measure(f.env, f.actor, timeline);
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
    const [unproved] = await measure(f.env, f.actor, timeline);
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
    const f = await fixture(1),
      repo = f.current.repos[0]!;
    const graph: Record<string, string[]> = {
      base: [],
      local: ["base"],
      foreign: ["base"],
      merge: ["local", "foreign"],
    };
    const read = async (oid: string) => graph[oid] ?? null;
    const canonical = await revisionClosure("base", read);
    await expect(
      validateMergeEdges(f.env, repo.source!, "merge", "base", [], read, canonical),
    ).rejects.toThrow("blocked_dependency");
    await expect(
      validateMergeEdges(f.env, repo.source!, "merge", "base", ["foreign"], read, canonical),
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
  test.each(["valid", "missing"] as const)(
    "448 revisions and 58 overlapping merges preserve exact checkpoint and landing proof: %s",
    async (mode) => {
      const f = await fixture(1);
      try {
        const repo = f.current.repos[0]!;
        const graph = f.graphs.get("work_0")!;
        graph.delete(repo.commit);
        let tip = repo.base!;
        let serial = 1_000;
        const branches: string[] = [];
        const append = (parents: string[]) => {
          const hash = oid(serial++);
          graph.set(hash, { hash, parents, treeHash: repo.source!.tree, message: "owned work" });
          return hash;
        };
        for (let merge = 0; merge < 58; merge++) {
          const fork = tip;
          for (let n = 0; n < 5; n++) tip = append([tip]);
          const side = append([fork]);
          branches.push(side);
          tip = append([tip, side]);
        }
        for (let n = 0; n < 41; n++) tip = append([tip]);
        repo.commit = tip;
        repo.source = { ...repo.source!, commit: tip };
        f.refs.get("work_0")!.set("refs/heads/work", tip);
        f.sqlite.exec(`INSERT INTO source_operations
          (id,space_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
          VALUES('large-push','space','timeline','repo0','work_0','push','accepted','{}','now','now')`);
        for (const hash of graph.keys()) {
          if (hash === repo.base) continue;
          f.sqlite
            .prepare(`INSERT INTO source_revision_origins(repo_id,commit_oid,source_id)
            VALUES('repo0',?,'work_0')`)
            .run(hash);
          f.sqlite
            .prepare(`INSERT INTO source_progress_members
            (repo_id,source_id,commit_oid,operation_id,created_at)
            VALUES('repo0','work_0',?,'large-push','now')`)
            .run(hash);
        }
        expect(graph.size).toBe(448);
        expect([...graph.values()].filter((commit) => commit.parents.length === 2)).toHaveLength(
          58,
        );
        // An old side branch must still be checked, not just recent merge tips.
        const uncertain = branches[0]!;
        if (mode === "missing") graph.delete(uncertain);
        const reads = new Map<string, number>();
        const get = f.env.ARTIFACTS.get.bind(f.env.ARTIFACTS);
        Object.assign(f.env.ARTIFACTS, {
          get: async (name: string) => {
            const artifacts = await get(name);
            const read = artifacts.readCommit.bind(artifacts);
            return Object.assign(artifacts, {
              readCommit: async (hash: string) => {
                if (name === "work_0") reads.set(hash, (reads.get(hash) ?? 0) + 1);
                return read(hash);
              },
            });
          },
        });
        vi.mocked(lsRefs).mockImplementation(async (_env, name) =>
          [...f.refs.get(name)!].map(([name, oid]) => ({ name, oid })),
        );
        const checkpoint = measure(f.env, f.actor, {
          id: "timeline",
          repos: [repo],
        } as unknown as Timeline);
        if (mode === "valid") {
          const [measured] = await checkpoint;
          expect(measured).toMatchObject({
            commit: tip,
            source: repo.source,
            logicalBase: repo.logicalBase,
            dependencies: [],
          });
          expect(reads.size).toBe(448);
          expect([...reads.values()].every((count) => count === 1)).toBe(true);
          // A successful earlier proof cannot supply a later request's missing evidence.
          const previous = graph.get(uncertain)!;
          graph.delete(uncertain);
          await expect(
            measure(f.env, f.actor, { id: "timeline", repos: [repo] } as unknown as Timeline),
          ).rejects.toThrow(/unavailable|blocked_dependency/);
          graph.set(uncertain, previous);
          reads.clear();
          expect((await f.run()).state).toBe("landed");
          expect(f.writes).toEqual(["repo0"]);
          expect(reads.size).toBe(448);
          expect([...reads.values()].every((count) => count === 1)).toBe(true);
          expect(
            f.sqlite.prepare("SELECT count(*) AS count FROM source_integration_members").get(),
          ).toEqual({ count: 448 });
          const inputs = f.sqlite
            .prepare("SELECT commits_json FROM source_integration_inputs")
            .get() as { commits_json: string };
          expect(
            new Set(JSON.parse(inputs.commits_json).map((commit: { hash: string }) => commit.hash)),
          ).toEqual(new Set([...graph.keys()].filter((hash) => hash !== repo.base)));
          expect(
            await admittedReceipts(
              f.env,
              { ...repo.source!, commit: uncertain },
              new Set([repo.base!, repo.merge!]),
            ),
          ).toMatchObject([{ status: "complete" }]);
        } else {
          await expect(checkpoint).rejects.toThrow(/unavailable|blocked_dependency/);
          const result = await f.run();
          expect(result.state).toBe("blocked_dependency");
          expect(f.writes).toEqual([]);
          expect(
            f.sqlite.prepare("SELECT count(*) AS count FROM source_integration_receipts").get(),
          ).toEqual({ count: 0 });
        }
      } finally {
        f.sqlite.close();
      }
    },
  );

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
    const f = await fixture(1),
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

test.each(["credential", "Space grant"] as const)(
  "landing cannot publish after initiating %s revocation",
  async (kind) => {
    const f = await fixture(1);
    const base = f.current.repos[0]!.base;
    if (kind === "credential")
      f.sqlite.prepare("DELETE FROM access_tokens WHERE id=?").run(f.actor.credential.id);
    else f.sqlite.exec("DELETE FROM space_grants WHERE space_id='space' AND account_id='owner'");
    const result = await f.run();
    expect(result.state).toBe("advancing");
    expect(f.writes).toEqual([]);
    expect(f.refs.get("repo0")!.get("refs/heads/main")).toBe(base);
    expect(f.sqlite.prepare("SELECT id FROM source_operations WHERE kind='landing'").all()).toEqual(
      [],
    );
  },
);

describe("greenness", () => {
  async function runs() {
    const fresh = await createFreshSpaceTestEnvironment();
    const { sqlite } = fresh;
    onTestFinished(fresh.close);
    await seedSpaceFixture(fresh.env.DB, {
      organization: { id: "org", slug: "org", displayName: "Org", kind: "company" },
      space: { id: "space", slug: "org", displayName: "Org" },
      members: [],
      actorId: "nobody",
    });
    sqlite.exec(`INSERT INTO repos(id,space_id,name,visibility,artifacts_name,artifacts_remote) VALUES
        ('app','space','app','private','r-app','https://app'),
        ('lib','space','lib','private','r-lib','https://lib');`);
    let number = 0;
    const run = (
      repoId: string,
      status: string,
      step = 0,
      commit = oid(9),
      preview: "create" | "teardown" | null = null,
    ) =>
      sqlite
        .prepare(
          "INSERT INTO ci_runs(id,repo_id,number,commit_oid,ref,trigger,status,step,source_id,preview_action) VALUES(?,?,?,?,'work',?,?,?,?,?)",
        )
        .run(
          `run-${++number}`,
          repoId,
          number,
          commit,
          preview ? "manual" : "push",
          status,
          step,
          "canonical",
          preview,
        );
    const repo = (id: string) => ({
      id,
      space: "org",
      name: id,
      commit: oid(9),
      source: { sourceId: "canonical" },
    });
    const state = {
      checkpoint: { number: 3, repos: [repo("app"), repo("lib")] },
    } as unknown as Parameters<typeof greenness>[2];
    const check = (requireRun?: boolean) =>
      greenness(fresh.env.DB, { slug: "search" }, state, requireRun ? { requireRun } : {});
    return { run, check };
  }

  test("a repository without a run is green for auto landing, not for approving on a person's behalf", async () => {
    const f = await runs();
    f.run("app", "succeeded");
    expect(await f.check()).toEqual({ ok: true, why: null });
    expect(await f.check(true)).toMatchObject({
      ok: false,
      why: expect.stringMatching(/org\/lib/),
    });
    // A light step run, or a run of another commit, isn't the checkpoint's CI.
    f.run("lib", "succeeded", 1);
    f.run("lib", "succeeded", 0, oid(8));
    expect((await f.check(true)).ok).toBe(false);
    f.run("lib", "succeeded");
    expect(await f.check(true)).toEqual({ ok: true, why: null });
  });

  test("the newest run decides: pending or red is not green either way", async () => {
    const f = await runs();
    f.run("app", "succeeded");
    f.run("lib", "succeeded");
    f.run("lib", "running");
    expect(await f.check(true)).toMatchObject({ ok: false, why: expect.stringMatching(/running/) });
    expect((await f.check()).ok).toBe(false);
    f.run("lib", "failed");
    expect(await f.check(true)).toMatchObject({ ok: false, why: expect.stringMatching(/failed/) });
  });

  test("a preview's deploy is never the checkpoint's CI, for auto landing or approving", async () => {
    const f = await runs();
    f.run("app", "failed");
    f.run("lib", "succeeded");
    // The checkpoint's preview deployed after its push run failed.
    f.run("app", "succeeded", 0, oid(9), "create");
    f.run("app", "succeeded", 0, oid(9), "teardown");
    expect(await f.check()).toMatchObject({ ok: false, why: expect.stringMatching(/failed/) });
    expect(await f.check(true)).toMatchObject({ ok: false, why: expect.stringMatching(/failed/) });
    // Only previews: no run at all, as far as green goes.
    const g = await runs();
    g.run("app", "succeeded", 0, oid(9), "create");
    g.run("lib", "succeeded");
    expect(await g.check(true)).toMatchObject({
      ok: false,
      why: expect.stringMatching(/org\/app/),
    });
  });
});

describe("the Spaces the approved-landings sweep looks in (CORE-392)", () => {
  test("450 Spaces, a window of 200: every one within 3 consecutive hours, from any hour", async () => {
    const sqlite = migratedDatabase();
    const insert = sqlite.prepare(
      // The legacy store before reconstruction: the sweep reads only the Space column.
      `INSERT INTO timeline_work_sources (source_id, repo_id, timeline_id, timeline_slug, owner_id,
         space_id, artifacts_name, artifacts_remote, state, allocation_operation_id, fork_source_id,
         fork_commit, fork_tree, fork_ref, initial_source_id, initial_commit, initial_tree,
         initial_ref, created_at, updated_at)
       VALUES (?, 'repo', ?, 'search', ?, ?, ?, NULL, ?, ?, 'canonical', ?, ?, 'refs/heads/main',
         'canonical', ?, ?, 'refs/heads/main', '2026-10-12T00:00:00Z', '2026-10-12T00:00:00Z')`,
    );
    const spaces = Array.from({ length: 450 }, (_, i) => `space_${String(i).padStart(3, "0")}`);
    // Work sources name real Spaces (a foreign key), here all in one company.
    sqlite.exec("BEGIN");
    sqlite
      .prepare(
        "INSERT INTO organizations (id, slug, display_name, kind, default_space_id) VALUES ('org_sweep', 'sweep', 'Sweep', 'company', 'space_000')",
      )
      .run();
    const addSpace = sqlite.prepare(
      "INSERT INTO spaces (id, organization_id, slug, display_name) VALUES (?, 'org_sweep', ?, 'General')",
    );
    for (const id of [...spaces, "space_gone"]) addSpace.run(id, id.replace("_", "-"));
    sqlite.exec("COMMIT");
    for (const [i, space] of spaces.entries()) {
      insert.run(
        `src_${i}`,
        `tl_${i}`,
        space,
        space,
        `a_${i}`,
        "ready",
        `op_${i}`,
        oid(1),
        oid(1),
        oid(1),
        oid(1),
      );
      // A second live source of the same Space, and an archived one elsewhere: neither counts twice.
      if (i % 50 === 0)
        insert.run(
          `src_${i}b`,
          `tl_${i}b`,
          space,
          space,
          `a_${i}b`,
          "ready",
          `op_${i}b`,
          oid(1),
          oid(1),
          oid(1),
          oid(1),
        );
    }
    insert.run(
      "src_gone",
      "tl_gone",
      "space_gone",
      "space_gone",
      "a_gone",
      "archived",
      "op_gone",
      oid(1),
      oid(1),
      oid(1),
      oid(1),
    );
    const d = d1(sqlite);
    for (const first of [0, 1, 7, 1000]) {
      const seen = new Set<string>();
      for (let hour = first; hour < first + 3; hour++) {
        const window = await sweepSpaces(d, 200, hour);
        expect(window.length).toBe(200);
        expect(new Set(window).size).toBe(200);
        for (const space of window) seen.add(space);
      }
      expect(seen.size).toBe(450);
      expect(seen.has("space_gone")).toBe(false);
    }
    // Fewer Spaces than the window: all of them, every hour.
    expect((await sweepSpaces(d, 1000, 5)).length).toBe(450);
  });
});
