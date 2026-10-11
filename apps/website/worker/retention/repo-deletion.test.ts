// Repository deletion (CORE-199): hidden at once, then purged everywhere it
// left something (D1, Durable Objects, Vectorize, AI Search, Artifacts,
// previews, the registry), resumable from a crash at any step, and the
// one-off sweep of what earlier deletions orphaned. The real providers and
// the Workflow: the E2E scenarios repository-deletion-* and `agent test-ai`.

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { AppEnv } from "../auth.ts";
import type { Actor } from "../db.ts";
import { findRepo } from "../db.ts";
import { d1, migratedDatabase, migratedRegistryDatabase } from "../testing/d1.ts";
import { fakeDurableState } from "../testing/durable-state.ts";
import { KnowledgeCoordinator } from "../knowledge/coordinator.ts";
import { vectorId } from "../knowledge/indexes.ts";
import { forgetRecorded } from "../durable/registry.ts";
import { repos } from "../api/repos.ts";
import { runner } from "../ci/api.ts";
import { SimulatedCrash } from "./runs.ts";
import {
  deletionStatus,
  launchPurge,
  requestDeletion,
  resumeDeletions,
  runPurge,
  type PurgeStep,
} from "./repo-deletion.ts";
import { KEPT_TABLES, REPO_TABLES, repoInventory, type RepoInventory } from "./repo-inventory.ts";
import { plantOrphans, resetOrphanSweep, sweepRepoOrphans } from "./repo-orphans.ts";
import type { DatabaseSync } from "node:sqlite";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Teardown runs go through CI's startRun: recorded here as queued runs.
const startRun = vi.hoisted(() => vi.fn());
vi.mock(import("../ci/trigger.ts"), async (original) => ({ ...(await original()), startRun }));
// Teardowns look up the timeline's bookmark; these repositories have none.
vi.mock(import("../artifacts.ts"), async (original) => ({
  ...(await original()),
  listRefs: async () => ({ headBranch: "main", head: null, branches: [], tags: [] }),
}));

const ann: Actor = { id: "ann", slug: "ann", displayName: "Ann", isSiteAdmin: false };
const DAY = 24 * 60 * 60_000;

afterEach(() => vi.restoreAllMocks());
beforeEach(() => forgetRecorded());

// ---- fake providers ---------------------------------------------------------

function fakeVectorize(dimensions = 4) {
  const vectors = new Map<string, Record<string, unknown>>();
  return {
    vectors,
    describe: async () => ({ dimensions, vectorCount: vectors.size }),
    upsert: async (records: { id: string; metadata?: Record<string, unknown> }[]) => {
      for (const r of records) vectors.set(r.id, r.metadata ?? {});
      return { mutationId: "m" };
    },
    deleteByIds: async (ids: string[]) => {
      for (const id of ids) vectors.delete(id);
      return { mutationId: "m" };
    },
    query: async (vector: number[], options: { topK: number; filter?: { repo?: string } }) => {
      expect(vector).toHaveLength(dimensions);
      const matches = [...vectors]
        .filter(([, metadata]) => metadata.repo === options.filter?.repo)
        .slice(0, options.topK)
        .map(([id]) => ({ id, score: 1 }));
      return { matches, count: matches.length };
    },
  };
}

interface Item {
  id: string;
  key: string;
  metadata: Record<string, unknown>;
}

function fakeSearch() {
  const items = new Map<string, Item>();
  let n = 0;
  const api = {
    upload: async (
      key: string,
      _body: string,
      options?: { metadata?: Record<string, unknown> },
    ) => {
      const item = { id: `item-${++n}`, key, metadata: options?.metadata ?? {} };
      items.set(item.id, item);
      return item;
    },
    delete: async (id: string) => {
      if (!items.delete(id)) throw new Error("AiSearchNotFoundError: item not found");
    },
    list: async (params: {
      metadata_filter?: string;
      search?: string;
      page?: number;
      per_page?: number;
    }) => {
      let all = [...items.values()];
      if (params.metadata_filter) {
        const filter = JSON.parse(params.metadata_filter) as Record<string, unknown>;
        all = all.filter((item) =>
          Object.entries(filter).every(([key, value]) => item.metadata[key] === value),
        );
      }
      if (params.search) all = all.filter((item) => item.key.includes(params.search!));
      const per = params.per_page ?? 20;
      const page = params.page ?? 1;
      return { result: all.slice((page - 1) * per, page * per) };
    },
  };
  return { items, binding: { get: () => ({ items: api }) } };
}

function fakeArtifacts() {
  const repos = new Map<string, { createdAt: string }>();
  const missing = () => Object.assign(new Error("not found"), { code: "NOT_FOUND" });
  return {
    repos,
    create: async (name: string) => {
      repos.set(name, { createdAt: new Date().toISOString() });
      return { id: name, name, defaultBranch: "main", remote: `https://artifacts/${name}` };
    },
    get: async (name: string) => {
      if (!repos.has(name)) throw missing();
      return { createToken: async () => ({ plaintext: "t" }), [Symbol.dispose]() {} };
    },
    delete: async (name: string) => repos.delete(name),
    list: async (options: { limit?: number; cursor?: string }) => {
      const all = [...repos].map(([name, repo]) => ({ name, ...repo }));
      const start = Number(options.cursor ?? 0);
      const limit = options.limit ?? 50;
      const page = all.slice(start, start + limit);
      return {
        repos: page,
        total: all.length,
        ...(start + limit < all.length ? { cursor: String(start + limit) } : {}),
      };
    },
  };
}

function fakeWorkflow() {
  const instances = new Map<string, { status: string; params: unknown }>();
  return {
    instances,
    create: async ({ id, params }: { id: string; params: unknown }) => {
      instances.set(id, { status: "running", params });
      return { id };
    },
    get: async (id: string) => {
      const instance = instances.get(id);
      if (!instance) throw new Error(`instance.not_found ${id}`);
      return {
        id,
        status: async () => ({ status: instance.status }),
        terminate: async () => {
          instance.status = "terminated";
        },
      };
    },
  };
}

/** The coordinators, real objects over fake state, behind a namespace. */
function coordinators(envRef: () => Env) {
  const instances = new Map<string, { object: KnowledgeCoordinator; ctx: DurableObjectState }>();
  const get = (name: string) => {
    let instance = instances.get(name);
    if (!instance) {
      const { ctx } = fakeDurableState({ name });
      instance = { object: new KnowledgeCoordinator(ctx, envRef()), ctx };
      instances.set(name, instance);
    }
    return instance;
  };
  return { instances, get, namespace: { getByName: (name: string) => get(name).object } };
}

// ---- the world --------------------------------------------------------------

const NODES = ["repo", "file:a.ts", "sym:a.ts#run"];

async function setup() {
  const sqlite = migratedDatabase();
  const registry = migratedRegistryDatabase();
  registry.exec("PRAGMA foreign_keys = OFF");
  const vectors = fakeVectorize();
  const search = fakeSearch();
  const artifacts = fakeArtifacts();
  const purges = fakeWorkflow();
  const builds = fakeWorkflow();
  const ciRuns = fakeWorkflow();
  let env!: Env;
  const knowledge = coordinators(() => env);
  env = {
    DB: d1(sqlite),
    REGISTRY_DB: d1(registry),
    VECTORS: vectors,
    SEARCH: search.binding,
    ARTIFACTS: artifacts,
    REPO_PURGE: purges,
    KNOWLEDGE_BUILD: builds,
    CI_RUN: ciRuns,
    KNOWLEDGE_COORDINATOR: knowledge.namespace,
  } as unknown as Env;

  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('ben', 'user', 'ben', 'Ben'), ('orbit', 'org', 'orbit', 'Orbit');
    INSERT INTO org_members (org_id, user_id, role) VALUES ('orbit', 'ann', 'owner');
  `);
  let runs = 0;
  startRun.mockReset();
  startRun.mockImplementation(async (_env, repo: { id: string }, options) => {
    runs++;
    sqlite.exec(`
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status, preview_action, timeline_slug)
        VALUES ('teardown-${runs}', '${repo.id}', ${100 + runs}, '${options.commit}', '${options.branch}',
                'manual', 'queued', 'teardown', '${options.preview.timeline}');
    `);
    return { runId: `teardown-${runs}`, number: 100 + runs };
  });

  /** A repository holding something in every store. */
  async function repository(id: string, name: string) {
    await artifacts.create(`art-${id}`);
    sqlite.exec(`
      INSERT INTO repos (id, owner_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('${id}', 'orbit', '${name}', 'private', 'art-${id}', 'https://artifacts/art-${id}');
      INSERT INTO repo_collaborators (repo_id, user_id, role) VALUES ('${id}', 'ben', 'read');
      INSERT INTO ref_updates (repo_id, ref) VALUES ('${id}', 'refs/heads/main');
      INSERT INTO kg_builds (id, repo_id, to_commit, status) VALUES
        ('${id}-b1', '${id}', 'c1', 'succeeded'), ('${id}-b2', '${id}', 'c2', 'running');
      INSERT INTO kg_edges (repo_id, src, dst, kind) VALUES ('${id}', 'repo', 'file:a.ts', 'contains');
      INSERT INTO ci_runs (id, repo_id, number, commit_oid, ref, trigger, status) VALUES
        ('${id}-run1', '${id}', 1, 'c1', 'main', 'push', 'succeeded'),
        ('${id}-run2', '${id}', 2, 'c2', 'gitmatrix/landing/queue-c2', 'manual', 'queued');
      UPDATE ci_runs SET queue_id = 'c2' WHERE id = '${id}-run2';
      INSERT INTO merge_queue (repo_id, id, status, merge_run_id, data, created_at, updated_at) VALUES
        ('${id}', 'c2', 'merging', '${id}-run2', '{"effectsPending":false,"remediationPending":false}', 'now', 'now'),
        ('${id}', 'old', 'failed', NULL, '{"remediationPending":true,"history":[{"status":"failed"}]}', 'now', 'now');
      INSERT INTO ci_jobs (id, run_id, repo_id, name, spec, status, runner) VALUES
        ('${id}-job1', '${id}-run1', '${id}', 'test', '{}', 'succeeded', 'sandbox');
      INSERT INTO ci_steps (job_id, position, name, status) VALUES ('${id}-job1', 0, 'run', 'succeeded');
      INSERT INTO ci_logs (job_id, seq, step, text) VALUES ('${id}-job1', 0, 0, 'ok'), ('${id}-job1', 1, 0, 'done');
      -- Two live previews of one timeline, one of another, and an expired one.
      INSERT INTO deployments (repo_id, environment, timeline_slug, commit_oid, status) VALUES
        ('${id}', 'timeline/t1', 't1', 'c1', 'active'),
        ('${id}', 'timeline/t1', 't1', 'c2', 'sleeping'),
        ('${id}', 'timeline/t2', 't2', 'c2', 'active'),
        ('${id}', 'timeline/t0', 't0', 'c0', 'expired');
      INSERT INTO atlas_spend (id, account_id, day, scope, run_id, repo_id, purpose, model, status,
                               input_tokens, output_tokens, cost_micro_usd, reserved_input_tokens,
                               reserved_output_tokens, reserved_micro_usd, created_at) VALUES
        ('${id}-s1', 'orbit', '2020-01-01', 'build', '${id}-b1', '${id}', 'p', 'm', 'settled', 1, 1, 5, 1, 1, 5, '2020-01-01'),
        ('${id}-s2', 'orbit', '${new Date().toISOString().slice(0, 10)}', 'build', '${id}-b2', '${id}', 'p', 'm', 'reserved', 1, 1, 7, 1, 1, 7, '2020-01-01');
    `);
    for (const node of NODES) {
      sqlite.exec(`
        INSERT INTO kg_nodes (repo_id, id, kind, name, summary, content_hash, changed_in)
          VALUES ('${id}', '${node}', 'file', '${node}', 'about ${node}', 'h', 'c1');
      `);
      await vectors.upsert([{ id: await vectorId(id, node), metadata: { repo: id, node } }]);
    }
    // A vector the graph no longer names (a crashed build's).
    await vectors.upsert([{ id: `${id}-stray`, metadata: { repo: id } }]);
    for (const key of ["file:a.ts", "page:overview"]) {
      const item = await search.binding.get().items.upload(`${id}/${key}.md`, "body", {
        metadata: { repo: id },
      });
      sqlite.exec(`
        INSERT INTO kg_search_items (repo_id, key, item_id, version) VALUES ('${id}', '${key}', '${item.id}', 'v');
      `);
    }
    // An item kg_search_items lost track of.
    await search.binding.get().items.upload(`${id}/file:lost.ts.md`, "body", {
      metadata: { repo: id },
    });
    // Its coordinator, with state and an alarm, registered.
    await knowledge.get(id).object.notify(id);
    sqlite.exec(`
      INSERT INTO do_instances (class, name, repo_id) VALUES ('KnowledgeCoordinator', '${id}', '${id}');
    `);
    await builds.create({ id: `${id}-b2`, params: {} });
    await ciRuns.create({ id: `${id}-run2`, params: {} });
    registry.exec(`
      INSERT INTO package_sources (package_id, git_repo_id, granted_at) VALUES ('pkg-${id}', '${id}', 'now');
      INSERT INTO publishes (id, feed_id, format, package_id, version, action, git_repo_id, commit_oid, ref,
                             actor, actor_label, via, at)
        VALUES ('pub-${id}', 'feed', 'npm', 'pkg-${id}', '1.0.0', 'publish', '${id}', 'c1', 'main',
                'job:x', 'CI', 'job', 'now');
    `);
  }
  await repository("r_doomed", "doomed");
  await repository("r_keep", "keep");

  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", ann);
    await next();
  });
  app.route("/api/repos", repos);
  const waits: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} };
  const call = (path: string, init: RequestInit = {}) =>
    app.request(`/api/repos${path}`, init, env, ctx as unknown as ExecutionContext);

  /** Teardown runs end the way CI would end them. */
  const finishTeardowns = () =>
    sqlite.exec(
      "UPDATE ci_runs SET status = 'succeeded' WHERE preview_action = 'teardown' AND status = 'queued'",
    );

  return {
    sqlite,
    registry,
    env,
    vectors,
    search,
    artifacts,
    purges,
    builds,
    ciRuns,
    knowledge,
    call,
    waits,
    finishTeardowns,
  };
}

type World = Awaited<ReturnType<typeof setup>>;

test("renaming preserves registry grants/provenance and never invokes deletion providers", async () => {
  const t = await setup();
  const grants = t.registry.prepare("SELECT * FROM package_sources").all();
  const publishes = t.registry.prepare("SELECT * FROM publishes").all();
  const physical = [...t.artifacts.repos];
  const vectors = [...t.vectors.vectors];
  const search = [...t.search.items];
  const providers = [t.purges.instances.size, t.builds.instances.size, t.ciRuns.instances.size];
  const response = await t.call("/orbit/doomed", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "retained" }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ id: "r_doomed", name: "retained" });
  expect(t.registry.prepare("SELECT * FROM package_sources").all()).toEqual(grants);
  expect(t.registry.prepare("SELECT * FROM publishes").all()).toEqual(publishes);
  expect([...t.artifacts.repos]).toEqual(physical);
  expect([...t.vectors.vectors]).toEqual(vectors);
  expect([...t.search.items]).toEqual(search);
  expect([t.purges.instances.size, t.builds.instances.size, t.ciRuns.instances.size]).toEqual(
    providers,
  );
  expect(t.sqlite.prepare("SELECT * FROM repo_deletions").all()).toEqual([]);
});

/**
 * A Workflow step that just runs; `crash` makes the n-th `do` step die before
 * or after its work. `names` lists every step and sleep, `done` the steps.
 */
function steps(
  world: World,
  crash?: { at: number; when: "before" | "after" },
): { step: PurgeStep; names: string[]; done: () => number } {
  const names: string[] = [];
  let count = 0;
  const step: PurgeStep = {
    async do(name, _config, work) {
      names.push(name);
      const n = ++count;
      if (crash?.when === "before" && crash.at === n) throw new SimulatedCrash(name);
      const result = await work();
      if (crash?.when === "after" && crash.at === n) throw new SimulatedCrash(name);
      return result;
    },
    async sleep(name) {
      names.push(name);
      world.finishTeardowns();
    },
  };
  return { step, names, done: () => count };
}

const purge = (world: World, step = steps(world).step) =>
  runPurge(world.env, "r_doomed", step, { waitUntil: () => {} });

/** What an inventory says is left, in a comparable shape. */
function left(inventory: RepoInventory) {
  return {
    repo: inventory.repo,
    d1: inventory.d1,
    registry: inventory.registry,
    durable: inventory.durable.map((d) => ({
      class: d.class,
      purged: Boolean(d.purgedAt),
      storage: d.storage && {
        tables: d.storage.tables,
        keys: d.storage.keys,
        alarm: d.storage.alarm,
      },
    })),
    artifacts: inventory.artifacts.exists,
    vectors: inventory.vectors,
    searchItems: inventory.searchItems,
    previews: inventory.previews,
  };
}

const NOTHING_LEFT = {
  repo: null,
  d1: {},
  registry: { packageSources: 0, publishes: 0 },
  durable: [
    {
      class: "KnowledgeCoordinator",
      purged: true,
      storage: { tables: [], keys: 0, alarm: null },
    },
  ],
  artifacts: false,
  vectors: 0,
  searchItems: 0,
  previews: { live: 0, teardownsOpen: 0 },
};

// ---- tests ------------------------------------------------------------------

describe("repository deletion", () => {
  test("drains an unstarted queued gate on a failed run without replacing its failure", async () => {
    const w = await setup();
    w.sqlite.exec(`
      UPDATE ci_runs SET status='failed',config_error='WorkflowError(instance.already_exists)',
        finished_at='2026-10-11T04:04:56Z' WHERE id='r_doomed-run1';
      UPDATE ci_jobs SET status='queued' WHERE id='r_doomed-job1';
      UPDATE ci_steps SET status='pending' WHERE job_id='r_doomed-job1';
    `);
    await requestDeletion(w.env, cleanRow, "ann");
    const delegate = steps(w).step;
    const step: PurgeStep = {
      ...delegate,
      async do(name, config, work) {
        const result = await delegate.do(name, config, work);
        if (name === "stop:ci-acknowledged") {
          expect(
            w.sqlite
              .prepare(
                "SELECT status,config_error,finished_at FROM ci_runs WHERE id='r_doomed-run1'",
              )
              .get(),
          ).toEqual({
            status: "failed",
            config_error: "WorkflowError(instance.already_exists)",
            finished_at: "2026-10-11T04:04:56Z",
          });
          expect(
            w.sqlite
              .prepare(
                "SELECT status,source_completion_pending FROM ci_jobs WHERE id='r_doomed-job1'",
              )
              .get(),
          ).toEqual({ status: "cancelled", source_completion_pending: 0 });
        }
        return result;
      },
    };
    expect(await purge(w, step)).toBe("done");
    expect(w.artifacts.repos.has("art-r_doomed")).toBe(false);
  });

  test.each(["running", "claim", "started", "source"] as const)(
    "a failed parent does not acknowledge a gate with %s evidence",
    async (evidence) => {
      const w = await setup();
      w.sqlite.exec(`
        UPDATE ci_runs SET status='failed',config_error='Original failure' WHERE id='r_doomed-run1';
        UPDATE ci_jobs SET status='queued' WHERE id='r_doomed-job1';
        UPDATE ci_steps SET status='running' WHERE job_id='r_doomed-job1';
      `);
      const change = {
        running: "status='running'",
        claim: "claimed_by='runner'",
        started: "started_at='2026-10-11T04:04:56Z'",
        source: "source_completion_pending=1",
      }[evidence];
      w.sqlite.exec(`UPDATE ci_jobs SET ${change} WHERE id='r_doomed-job1'`);
      await requestDeletion(w.env, cleanRow, "ann");
      await expect(purge(w)).rejects.toThrow(/CI consumer acknowledgment/);
      expect(w.artifacts.repos.has("art-r_doomed")).toBe(true);
      expect(
        w.sqlite.prepare("SELECT status FROM ci_steps WHERE job_id='r_doomed-job1'").get(),
      ).toEqual({ status: "running" });
    },
  );

  test.each([false, true])(
    "waits for CI acknowledgment after tombstone (historical ambiguity: %s)",
    async (historical) => {
      const w = await setup();
      w.sqlite
        .prepare("UPDATE ci_runs SET status=? WHERE id='r_doomed-run1'")
        .run(historical ? "cancelled" : "running");
      w.sqlite
        .prepare(`UPDATE ci_jobs SET status=?,source_completion_pending=?,
      runner='local',spec='{"secrets":[]}' WHERE id='r_doomed-job1'`)
        .run(historical ? "cancelled" : "running", historical ? 1 : 0);
      await requestDeletion(w.env, cleanRow, "ann");
      await expect(purge(w)).rejects.toThrow(/CI consumer acknowledgment/);
      expect(w.artifacts.repos.has("art-r_doomed")).toBe(true);
      expect((await deletionStatus(w.env, "r_doomed"))?.phase).toBe("stop");
      // Reports use the owner's control-plane credential and remain available
      // after the repository disappears from normal readers.
      const app = new Hono<AppEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", ann);
        await next();
      });
      app.route("/runner", runner);
      const heartbeat = await app.request(
        "/runner/jobs/r_doomed-job1",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ logs: [{ step: -1, text: "stopping" }] }),
        },
        w.env,
      );
      expect(heartbeat.status).toBe(200);
      expect(await heartbeat.json()).toEqual({ cancelled: true });
      await expect(purge(w)).rejects.toThrow(/CI consumer acknowledgment/);
      const finished = await app.request(
        "/runner/jobs/r_doomed-job1",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ done: { status: "cancelled" } }),
        },
        w.env,
      );
      expect(finished.status).toBe(200);
      expect(await purge(w)).toBe("done");
      expect(w.artifacts.repos.has("art-r_doomed")).toBe(false);
    },
  );

  test("hides the repository at once, then purges everything it owned, everywhere", async () => {
    const w = await setup();
    const keepBefore = left(await repoInventory(w.env, "r_keep"));
    const before = await repoInventory(w.env, "r_doomed");
    expect(before.d1).toMatchObject({
      repos: 1,
      kg_nodes: 3,
      kg_search_items: 2,
      ci_logs: 2,
      deployments: 4,
      atlas_spend: 2,
      merge_queue: 2,
    });
    expect(before).toMatchObject({
      vectors: 4,
      searchItems: 3,
      artifacts: { exists: true },
      previews: { live: 3, teardownsOpen: 0 },
      registry: { packageSources: 1, publishes: 1 },
    });
    expect(before.durable[0]!.storage!.keys).toBeGreaterThan(0);

    expect((await w.call("/orbit/doomed", { method: "DELETE" })).status).toBe(204);
    // Missing to readers at once, its name still taken, a purge started.
    expect((await w.call("/orbit/doomed")).status).toBe(404);
    expect(await findRepo(w.env.DB, ann, "orbit", "doomed")).toBeNull();
    expect((await findRepo(w.env.DB, ann, "orbit", "doomed", { deleting: true }))?.id).toBe(
      "r_doomed",
    );
    expect((await w.call("/orbit/doomed", { method: "DELETE" })).status).toBe(404);
    const taken = await w.call("", {
      method: "POST",
      body: JSON.stringify({ owner: "orbit", name: "doomed" }),
    });
    expect(taken.status).toBe(409);
    expect(await taken.text()).toMatch(/being deleted/);
    expect([...w.purges.instances.keys()]).toEqual(["purge-r_doomed-1"]);
    expect(await deletionStatus(w.env, "r_doomed")).toMatchObject({
      fullName: "orbit/doomed",
      phase: "stop",
      attempts: 1,
      workflowId: "purge-r_doomed-1",
      finishedAt: null,
    });

    const { step, names } = steps(w);
    expect(await purge(w, step)).toBe("done");
    expect(names).toContain("previews:wait:0");

    expect(left(await repoInventory(w.env, "r_doomed"))).toEqual(NOTHING_LEFT);
    // Nothing of the other repository was touched.
    expect(left(await repoInventory(w.env, "r_keep"))).toEqual(keepBefore);
    expect(w.builds.instances.get("r_doomed-b2")?.status).toBe("terminated");
    expect(w.builds.instances.get("r_keep-b2")?.status).toBe("running");
    expect(w.ciRuns.instances.get("r_doomed-run2")?.status).toBe("terminated");
    expect(w.ciRuns.instances.get("r_keep-run2")?.status).toBe("running");

    // Each timeline's previews were torn down by one run at its newest commit.
    expect(
      startRun.mock.calls.map(([, repo, options]) => [
        (repo as { id: string }).id,
        options.preview.action,
        options.preview.timeline,
        options.commit,
      ]),
    ).toEqual([
      ["r_doomed", "teardown", "t1", "c2"],
      ["r_doomed", "teardown", "t2", "c2"],
    ]);
    // Today's spend still counts against the account's ceiling, detached.
    expect(
      w.sqlite.prepare("SELECT id, repo_id FROM atlas_spend WHERE id LIKE 'r_doomed%'").all(),
    ).toEqual([{ id: "r_doomed-s2", repo_id: null }]);
    // The publish stays in its package's history, without the repository.
    expect(
      w.registry
        .prepare("SELECT git_repo_id, commit_oid, ref FROM publishes WHERE id = 'pub-r_doomed'")
        .get(),
    ).toEqual({ git_repo_id: null, commit_oid: null, ref: null });

    const status = await deletionStatus(w.env, "r_doomed");
    expect(status).toMatchObject({ phase: "done", finishedAt: expect.any(String) });
    expect(status!.progress).toMatchObject({
      stop: { coordinator: true, terminated: 1, cancelled: 1 },
      vectors: { deleted: 3, done: true, swept: 1, remaining: 0 },
      search: { deleted: 2, swept: 1, remaining: 0 },
      links: { spendDeleted: 1, spendDetached: 1, sources: 1, publishes: 1 },
      artifacts: { deleted: true },
      rows: { repos: 1, ci_logs: 2, kg_nodes: 3, merge_queue: 2 },
    });

    // The name is free again.
    const reused = await w.call("", {
      method: "POST",
      body: JSON.stringify({ owner: "orbit", name: "doomed" }),
    });
    expect(reused.status).toBe(201);
  });

  test("a crash at any step resumes to the same end, from the recorded phase", async () => {
    const clean = await setup();
    await requestDeletion(clean.env, cleanRow, "ann");
    const run = steps(clean);
    await purge(clean, run.step);
    const total = run.done();
    expect(total).toBeGreaterThan(20);
    const expected = left(await repoInventory(clean.env, "r_doomed"));
    expect(expected).toEqual(NOTHING_LEFT);

    for (const when of ["before", "after"] as const)
      for (let at = 1; at <= total; at++) {
        const w = await setup();
        await requestDeletion(w.env, cleanRow, "ann");
        await expect(purge(w, steps(w, { at, when }).step)).rejects.toBeInstanceOf(SimulatedCrash);
        // A new instance (no replayed steps) picks up where the record says.
        expect(await purge(w)).toBe("done");
        expect(left(await repoInventory(w.env, "r_doomed")), `${when} step ${at}`).toEqual(
          expected,
        );
        expect(left(await repoInventory(w.env, "r_keep")).repo).toEqual({
          name: "keep",
          deletedAt: null,
        });
        // One teardown run per timeline, however the crash fell.
        expect(startRun.mock.calls.length, `${when} step ${at}`).toBe(2);
      }
  }, 120_000);

  test("waits for teardown runs, and gives up on them after the limit", async () => {
    const w = await setup();
    await requestDeletion(w.env, cleanRow, "ann");
    let sleeps = 0;
    const step: PurgeStep = {
      do: (_name, _config, work) => work(),
      async sleep(name) {
        if (!name.startsWith("previews:wait")) return;
        sleeps++;
        // The runs never end; the clock moves past the limit after a few waits.
        if (sleeps === 3)
          w.sqlite.exec(
            `UPDATE repo_deletions SET progress = json_set(progress, '$.previews.startedAt', '${new Date(Date.now() - 3 * 60 * 60_000).toISOString()}')`,
          );
      },
    };
    expect(await runPurge(w.env, "r_doomed", step, { waitUntil: () => {} })).toBe("done");
    expect(sleeps).toBe(3);
    expect((await deletionStatus(w.env, "r_doomed"))!.progress.previews?.timedOut).toBe(2);
    expect(left(await repoInventory(w.env, "r_doomed"))).toEqual(NOTHING_LEFT);
  });

  test("a step being retried shows its attempt and last provider error until it succeeds", async () => {
    const w = await setup();
    await requestDeletion(w.env, cleanRow, "ann");
    const remove = w.env.ARTIFACTS.delete.bind(w.env.ARTIFACTS);
    let failures = 2;
    w.env.ARTIFACTS.delete = async (name: string) => {
      if (failures-- > 0)
        throw Object.assign(new Error("An internal error occurred."), { code: "INTERNAL_ERROR" });
      return remove(name);
    };
    const seen: unknown[] = [];
    // Workflows retries a failed step, telling the work its attempt.
    const step: PurgeStep = {
      async do(name, _config, work) {
        for (let attempt = 1; ; attempt++) {
          try {
            return await work({ attempt });
          } catch (error) {
            if (attempt === 6) throw error;
            if (name === "artifacts:delete")
              seen.push((await deletionStatus(w.env, "r_doomed"))!.progress.retry);
          }
        }
      },
      sleep: async () => w.finishTeardowns(),
    };
    expect(await runPurge(w.env, "r_doomed", step, { waitUntil: () => {} })).toBe("done");
    expect(seen).toEqual([
      expect.objectContaining({
        step: "artifacts:delete",
        attempt: 1,
        error: "An internal error occurred.",
      }),
      expect.objectContaining({
        step: "artifacts:delete",
        attempt: 2,
        error: "An internal error occurred.",
      }),
    ]);
    const status = (await deletionStatus(w.env, "r_doomed"))!;
    expect(status.progress.retry).toBeUndefined();
    expect(status.progress.artifacts).toEqual({ deleted: true });
    expect(left(await repoInventory(w.env, "r_doomed"))).toEqual(NOTHING_LEFT);
  });

  test("the cron restarts a purge whose Workflow died, never one still alive", async () => {
    const w = await setup();
    await requestDeletion(w.env, cleanRow, "ann");
    await launchPurge(w.env, "r_doomed", () => {});
    const now = Date.now() + 60 * 60_000;
    // Alive (sleeping between checks): left alone.
    w.purges.instances.get("purge-r_doomed-1")!.status = "waiting";
    expect(await resumeDeletions(w.env, { now, waitUntil: () => {} })).toEqual([]);
    // Recently active: left alone whatever its instance says.
    w.purges.instances.get("purge-r_doomed-1")!.status = "errored";
    expect(await resumeDeletions(w.env, { waitUntil: () => {} })).toEqual([]);
    expect(await resumeDeletions(w.env, { now, waitUntil: () => {} })).toEqual(["r_doomed"]);
    expect([...w.purges.instances.keys()]).toEqual(["purge-r_doomed-1", "purge-r_doomed-2"]);
    expect(await deletionStatus(w.env, "r_doomed")).toMatchObject({
      attempts: 2,
      workflowId: "purge-r_doomed-2",
    });
    // A finished deletion is never restarted.
    await purge(w);
    expect(await resumeDeletions(w.env, { now, waitUntil: () => {} })).toEqual([]);
  });

  test("a scoped recovery leaves another unfinished repository deletion untouched", async () => {
    const w = await setup();
    await requestDeletion(w.env, cleanRow, "ann");
    await requestDeletion(
      w.env,
      { ...cleanRow, id: "r_keep", name: "keep", artifacts_name: "art-r_keep" },
      "ann",
    );
    const now = Date.now() + 60 * 60_000;
    expect(await resumeDeletions(w.env, { repoId: "r_doomed", now, waitUntil: () => {} })).toEqual([
      "r_doomed",
    ]);
    expect((await deletionStatus(w.env, "r_doomed"))?.attempts).toBe(1);
    expect(await deletionStatus(w.env, "r_keep")).toMatchObject({
      attempts: 0,
      workflowId: null,
      phase: "stop",
    });
    expect(await resumeDeletions(w.env, { now, waitUntil: () => {} })).toEqual(["r_keep"]);
  });

  test("without a Workflow (a preview), the purge runs in the background", async () => {
    const w = await setup();
    Reflect.deleteProperty(w.env, "REPO_PURGE");
    w.finishTeardowns();
    w.sqlite.exec("DELETE FROM deployments WHERE repo_id = 'r_doomed'");
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      expect((await w.call("/orbit/doomed", { method: "DELETE" })).status).toBe(204);
      let settled = false;
      const all = Promise.all(w.waits).finally(() => (settled = true));
      while (!settled) await vi.advanceTimersByTimeAsync(1000);
      await all;
    } finally {
      vi.useRealTimers();
    }
    expect(await deletionStatus(w.env, "r_doomed")).toMatchObject({ phase: "done" });
    expect(left(await repoInventory(w.env, "r_doomed")).d1).toEqual({});
  });

  test("every table with a repo_id is inventoried", () => {
    const sqlite: DatabaseSync = migratedDatabase();
    const tables = (
      sqlite
        .prepare(
          `SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) p
            WHERE m.type = 'table' AND p.name = 'repo_id' ORDER BY m.name`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect([...REPO_TABLES, ...KEPT_TABLES].sort()).toEqual(tables);
  });
});

const cleanRow = {
  id: "r_doomed",
  owner_id: "orbit",
  owner_slug: "orbit",
  name: "doomed",
  artifacts_name: "art-r_doomed",
};

describe("the orphan sweep", () => {
  test("finds what deleted repositories left, purges it, and leaves live ones alone", async () => {
    const w = await setup();
    const planted = await plantOrphans(w.env);
    // A coordinator, spend and a registry grant of another long-gone repository.
    const { ctx } = fakeDurableState({ name: "repo_gone" });
    await new KnowledgeCoordinator(ctx, w.env).notify("repo_gone");
    w.knowledge.instances.set("repo_gone", {
      object: new KnowledgeCoordinator(ctx, w.env),
      ctx,
    });
    w.sqlite.exec(`
      INSERT INTO do_instances (class, name) VALUES ('KnowledgeCoordinator', 'repo_gone');
    `);
    w.registry.exec(`
      INSERT INTO package_sources (package_id, git_repo_id, granted_at) VALUES ('pkg-x', 'repo_gone', 'now');
    `);
    // Old orphaned Artifacts repositories go; a young one is left (it may be mid-creation).
    w.artifacts.repos.set(planted.artifactsName, {
      createdAt: new Date(Date.now() - 2 * DAY).toISOString(),
    });
    await w.artifacts.create("r-young");
    // A crashed allocation older than the orphan grace is still an owned name.
    w.sqlite.exec(`INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,owner_id,artifacts_name,state,allocation_operation_id,
       fork_source_id,fork_commit,fork_tree,fork_ref,initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at)
      VALUES ('work_reserved','r_keep','reserved-timeline','reserved','orbit','old-reserved','reserved','allocation-reserved',
        'canonical','head','tree','refs/heads/main','canonical','head','tree','refs/heads/main','2020-01-01','2020-01-01');`);
    w.artifacts.repos.set("old-reserved", {
      createdAt: new Date(Date.now() - 3 * DAY).toISOString(),
    });
    // A repository being deleted isn't an orphan.
    await requestDeletion(w.env, cleanRow, "ann");

    let state = await sweepRepoOrphans(w.env, {
      waitUntil: () => {},
      limits: { pages: 1, perPage: 2 },
    });
    for (let i = 0; state.stage !== "done" && i < 20; i++)
      state = await sweepRepoOrphans(w.env, {
        waitUntil: () => {},
        limits: { pages: 1, perPage: 2 },
      });
    expect(state).toMatchObject({
      stage: "done",
      orphans: 2,
      artifacts: 1,
      deletedArtifacts: [planted.artifactsName],
    });
    expect(state.vectors).toEqual({ indexed: 9, expected: 6 });
    expect(w.artifacts.repos.has(planted.artifactsName)).toBe(false);
    expect(w.artifacts.repos.has("r-young")).toBe(true);
    expect(w.artifacts.repos.has("art-r_keep")).toBe(true);
    expect(w.artifacts.repos.has("art-r_doomed")).toBe(true);
    expect(w.artifacts.repos.has("old-reserved")).toBe(true);
    const orphans = w.sqlite
      .prepare(
        "SELECT repo_id, source, phase FROM repo_deletions WHERE source = 'orphan-sweep' ORDER BY repo_id",
      )
      .all();
    expect(orphans).toEqual([
      { repo_id: "repo_gone", source: "orphan-sweep", phase: "stop" },
      { repo_id: planted.repoId, source: "orphan-sweep", phase: "stop" },
    ]);
    // Their purges were started; each runs the phases that need no row.
    expect([...w.purges.instances.keys()].sort()).toEqual([
      "purge-repo_gone-1",
      `purge-${planted.repoId}-1`,
    ]);
    for (const id of [planted.repoId, "repo_gone"]) {
      const { step, names } = steps(w);
      expect(await runPurge(w.env, id, step, { waitUntil: () => {} })).toBe("done");
      expect(names).not.toContain("previews:claim");
      expect(names).not.toContain("artifacts:delete");
      expect(left(await repoInventory(w.env, id))).toMatchObject({
        repo: null,
        d1: {},
        registry: { packageSources: 0, publishes: 0 },
        vectors: 0,
        searchItems: 0,
      });
    }
    await expect(
      w.knowledge.instances.get("repo_gone")!.ctx.storage.getAlarm(),
    ).resolves.toBeNull();
    // The live repository kept everything.
    expect(left(await repoInventory(w.env, "r_keep"))).toMatchObject({
      vectors: 4,
      searchItems: 3,
      artifacts: true,
    });
    // Done means done: the next cron call does nothing.
    expect(await sweepRepoOrphans(w.env, { waitUntil: () => {} })).toMatchObject({ stage: "done" });
    await resetOrphanSweep(w.env);
    expect(
      (await sweepRepoOrphans(w.env, { waitUntil: () => {}, limits: { minAgeMs: 0 } })).orphans,
    ).toBe(0);
  });
});
