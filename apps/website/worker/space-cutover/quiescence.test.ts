import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { FakeD1 } from "@gitmatrix/testing";
import { CUTOVER_CONSUMERS } from "./control.ts";
import {
  DEPLOYMENT_EVIDENCE_TTL_MS,
  DOCUMENTED_LEGACY_WALL_MS,
  QUIESCENCE_MARGIN_MS,
} from "./quiescence.ts";
import {
  CENSUS_PER_PAGE,
  confirmListing,
  listWorkflowInstances,
} from "../../shared/space-cutover-census.ts";
import { inspectCutoverDrain } from "../durable/cutover-drain.ts";
import { cleanRefPass, installCutoverTestControl } from "../testing/space-cutover.ts";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: DurableObjectState;
    env: Env;
    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkflowEntrypoint: class {},
}));

const PREPARED = Date.parse("2026-10-12T12:00:00.000Z");
const BOUND = DOCUMENTED_LEGACY_WALL_MS + QUIESCENCE_MARGIN_MS;
const WORKFLOW_CONSUMERS = ["ci-sandbox", "ci-workflow", "repo-purge", "knowledge-build"];

/** A real Workflow binding's instance surface, over provider-held status. */
function workflowBinding(
  statuses: Map<string, string>,
  { stubborn = false, failing = new Set<string>() } = {},
) {
  const terminated: string[] = [];
  return {
    terminated,
    async get(id: string) {
      if (!statuses.has(id)) throw new Error("instance.not_found");
      if (failing.has(id)) throw new Error("provider unavailable");
      return {
        id,
        async status() {
          return { status: statuses.get(id)! };
        },
        async terminate() {
          terminated.push(id);
          if (!stubborn) statuses.set(id, "terminated");
        },
      };
    },
  };
}

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(PREPARED);
  const db = new FakeD1();
  const registry = new FakeD1();
  const ddl =
    "CREATE TABLE _space_cutover_fence(id INTEGER PRIMARY KEY,run_id TEXT,migration_epoch INTEGER,manifest_digest TEXT,authority_token TEXT NOT NULL DEFAULT '',fenced INTEGER NOT NULL DEFAULT 0,bypass INTEGER NOT NULL DEFAULT 0);INSERT INTO _space_cutover_fence(id) VALUES(1);CREATE TABLE business(id TEXT PRIMARY KEY);";
  db.applySql(ddl);
  registry.applySql(ddl);
  // D1's own record of in-flight Workflow work, which a census must cover.
  db.applySql(
    "CREATE TABLE ci_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL);CREATE TABLE kg_builds(id TEXT PRIMARY KEY,status TEXT NOT NULL);CREATE TABLE repo_deletions(repo_id TEXT PRIMARY KEY,workflow_id TEXT,finished_at TEXT);",
  );
  const env = { DB: db, REGISTRY_DB: registry } as unknown as Env;
  const journal = installCutoverTestControl(env);
  const statuses = new Map<string, string>();
  const ciRun = workflowBinding(statuses);
  Reflect.set(env, "CI_RUN", ciRun);
  Reflect.set(env, "KNOWLEDGE_BUILD", workflowBinding(statuses));
  Reflect.set(env, "REPO_PURGE", workflowBinding(statuses));
  return { env, db, statuses, ciRun, ...journal };
}
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const PREPARATION_DEPLOYMENT = {
  id: "deployment-preparation",
  createdOn: "2026-10-12T11:30:00.000Z",
  versions: [{ versionId: "cutover-test-version", percentage: 100 }],
};
const census = (
  ciRun: { id: string; status: string; createdOn?: string | null }[] = [],
  deployments: unknown[] = [PREPARATION_DEPLOYMENT],
) => ({
  account: ACCOUNT,
  worker: "gitmatrix",
  workflows: {
    "ci-run": {
      name: "ci-run",
      instances: ciRun.map((entry) => ({ createdOn: "2026-10-12T11:00:00Z", ...entry })),
    },
    "knowledge-build": { name: "knowledge-build", instances: [] },
    "repo-purge": { name: "repo-purge", instances: [] },
  },
  deployments,
});
const codes = (findings: { consumer: string; code?: string }[]) =>
  Object.fromEntries(findings.map((finding) => [finding.consumer, finding.code ?? "ok"]));

afterEach(() => {
  vi.useRealTimers();
});

describe("consumer quiescence from documented execution bounds", () => {
  test("nothing drains before the documented bound, however quiet the journal looks", async () => {
    const f = await fixture();
    const run = await f.fence();
    await f.control.fenceDatabases(run.runId);
    cleanRefPass(f.control, run.runId, "fenced");
    vi.setSystemTime(PREPARED + BOUND - 1);
    const early = codes(f.control.inspectQuiescence(run.runId));
    for (const consumer of CUTOVER_CONSUMERS)
      expect(early[consumer]).toBe("legacy_execution_bound_pending");
    expect(f.control.status()?.consumers).toEqual({});
    // The census, too, must follow the bound: earlier legacy work could still create instances.
    await expect(f.control.recordWorkflowCensus(run.runId, census(), "test-human")).rejects.toThrow(
      "documented legacy execution bound",
    );
    expect(() => f.control.beginMigration(run.runId)).toThrow("drain");
    f.close();
  });

  test("an admitted ticket, a newer release or a missing fence keeps a consumer blocked", async () => {
    const f = await fixture();
    const ticket = f.control.acquire("queue", 3);
    const run = await f.fence();
    vi.setSystemTime(PREPARED + BOUND);
    expect(codes(f.control.inspectQuiescence(run.runId)).queue).toBe("storage_fence_required");
    await f.control.fenceDatabases(run.runId);
    cleanRefPass(f.control, run.runId, "fenced");
    // Without the provider's deployment history, no bound is proven for anyone.
    expect(codes(f.control.inspectQuiescence(run.runId)).scheduled).toBe(
      "deployment_history_required",
    );
    await f.control.recordWorkflowCensus(run.runId, census(), "test-human");
    const findings = codes(f.control.inspectQuiescence(run.runId));
    expect(findings.queue).toBe("execution_still_admitted");
    expect(findings.scheduled).toBe("ok");
    f.control.release(ticket.ticket);

    // A different release restarts the clock: its own legacy work is unbounded here.
    const preparation = f.env.CI_VERSION;
    Reflect.set(f.env, "CI_VERSION", { ...preparation, id: "newer-version" });
    vi.setSystemTime(PREPARED + BOUND + 60_000);
    expect(codes(f.control.inspectQuiescence(run.runId)).queue).toBe(
      "preparation_version_not_serving",
    );
    // Even the earlier acknowledgement is void.
    expect(f.control.status()?.consumers).toEqual({});
    expect(f.control.status()?.workflowCensus).toBeUndefined();
    // A→B→A: the preparation release serves again, but B's own work started
    // until now, so the bound restarts when A is seen again.
    Reflect.set(f.env, "CI_VERSION", preparation);
    vi.setSystemTime(PREPARED + BOUND + 120_000);
    expect(codes(f.control.inspectQuiescence(run.runId)).scheduled).toBe(
      "legacy_execution_bound_pending",
    );
    expect(f.control.status()?.boundResetAt).toBe(
      new Date(PREPARED + BOUND + 120_000).toISOString(),
    );
    expect(() => f.control.beginMigration(run.runId)).toThrow("drain");
    vi.setSystemTime(PREPARED + BOUND + 120_000 + BOUND);
    await f.control.recordWorkflowCensus(run.runId, census(), "test-human");
    expect(codes(f.control.inspectQuiescence(run.runId)).scheduled).toBe("ok");
    expect(f.control.status()?.consumers.scheduled?.evidence?.boundStart).toBe(
      new Date(PREPARED + BOUND + 120_000).toISOString(),
    );
    f.close();
  });

  test("the provider's deployment history must show the preparation release alone since the bound began", async () => {
    const f = await fixture();
    const run = await f.fence();
    await f.control.fenceDatabases(run.runId);
    cleanRefPass(f.control, run.runId, "fenced");
    vi.setSystemTime(PREPARED + BOUND);
    // A gradual deployment routes some traffic to another release: unbounded.
    await expect(
      f.control.recordWorkflowCensus(
        run.runId,
        census(
          [],
          [
            {
              id: "gradual",
              createdOn: "2026-10-12T12:05:00.000Z",
              versions: [
                { versionId: "cutover-test-version", percentage: 90 },
                { versionId: "other-version", percentage: 10 },
              ],
            },
            PREPARATION_DEPLOYMENT,
          ],
        ),
        "test-human",
      ),
    ).rejects.toThrow("does not route all traffic");
    // Another release served after preparation, then the preparation release
    // returned: the bound restarts at that return, even unseen by this object.
    const back = PREPARED + 10 * 60_000;
    await expect(
      f.control.recordWorkflowCensus(
        run.runId,
        census(
          [],
          [
            { ...PREPARATION_DEPLOYMENT, id: "back", createdOn: new Date(back).toISOString() },
            {
              id: "rollback",
              createdOn: "2026-10-12T12:05:00.000Z",
              versions: [{ versionId: "other-version", percentage: 100 }],
            },
            PREPARATION_DEPLOYMENT,
          ],
        ),
        "test-human",
      ),
    ).rejects.toThrow("legacy bound restarts");
    expect(f.control.status()?.boundResetAt).toBe(new Date(back).toISOString());
    expect(codes(f.control.inspectQuiescence(run.runId)).queue).toBe(
      "legacy_execution_bound_pending",
    );
    vi.setSystemTime(back + BOUND);
    await f.control.recordWorkflowCensus(
      run.runId,
      census(
        [],
        [
          { ...PREPARATION_DEPLOYMENT, id: "back", createdOn: new Date(back).toISOString() },
          {
            id: "rollback",
            createdOn: "2026-10-12T12:05:00.000Z",
            versions: [{ versionId: "other-version", percentage: 100 }],
          },
          PREPARATION_DEPLOYMENT,
        ],
      ),
      "test-human",
    );
    expect(f.control.status()?.deploymentEvidence).toMatchObject({
      account: ACCOUNT,
      worker: "gitmatrix",
      latestDeploymentId: "back",
      soleSince: new Date(back).toISOString(),
    });
    const drain = await inspectCutoverDrain(f.env, run.runId);
    expect(drain.ready).toBe(true);
    // Migration needs a recent history: a gradual deployment since would be invisible here.
    vi.setSystemTime(back + BOUND + DEPLOYMENT_EVIDENCE_TTL_MS + 1);
    expect(() => f.control.beginMigration(run.runId)).toThrow("deployment history again");
    f.close();
  });

  test("Git consumers also need the clean fenced ref pass", async () => {
    const f = await fixture();
    const run = await f.fence();
    await f.control.fenceDatabases(run.runId);
    vi.setSystemTime(PREPARED + BOUND);
    await f.control.recordWorkflowCensus(run.runId, census(), "test-human");
    expect(codes(f.control.inspectQuiescence(run.runId))["http-git-registry"]).toBe(
      "artifacts_ref_reconciliation_incomplete",
    );
    cleanRefPass(f.control, run.runId, "fenced");
    expect(codes(f.control.inspectQuiescence(run.runId))["http-git-registry"]).toBe("ok");
    expect(f.control.status()?.consumers["http-git-registry"]?.evidence).toMatchObject({
      boundStart: new Date(PREPARED).toISOString(),
      boundMs: DOCUMENTED_LEGACY_WALL_MS,
      marginMs: QUIESCENCE_MARGIN_MS,
      versionId: run.preparationVersionId,
      deployments: { latestDeploymentId: PREPARATION_DEPLOYMENT.id },
      refPassClean: true,
    });
    f.close();
  });

  test("Workflows drain only after the provider's census is settled, terminating legacy instances", async () => {
    const f = await fixture();
    const run = await f.fence();
    await f.control.fenceDatabases(run.runId);
    cleanRefPass(f.control, run.runId, "fenced");
    vi.setSystemTime(PREPARED + BOUND);

    // The census records the deployment history every consumer needs, and the
    // Workflow lists theirs do.
    let drain = await inspectCutoverDrain(f.env, run.runId);
    for (const consumer of [...WORKFLOW_CONSUMERS, "queue"])
      expect(drain.blockers).toContainEqual(
        expect.objectContaining({ consumer, code: "deployment_history_required" }),
      );
    expect(drain.ready).toBe(false);
    expect(() => f.control.beginMigration(run.runId)).toThrow("drain");

    // An older release's CI run is still going, and one finished after the
    // listing. A run this release created after preparation is fenced by its
    // own admission: never terminated as legacy.
    f.statuses.set("legacy-run", "running");
    f.statuses.set("finished-run", "complete");
    f.statuses.set("current-run", "queued");
    await f.control.recordWorkflowCensus(
      run.runId,
      census([
        { id: "legacy-run", status: "running" },
        { id: "finished-run", status: "running" },
        {
          id: "current-run",
          status: "queued",
          createdOn: new Date(PREPARED + 1_000).toISOString(),
        },
      ]),
      "test-human",
    );
    drain = await inspectCutoverDrain(f.env, run.runId);
    expect(f.ciRun.terminated).toEqual(["legacy-run"]);
    expect(f.statuses.get("current-run")).toBe("queued");
    expect(drain.ready).toBe(true);
    expect(drain.blockers).toEqual([]);
    const after = f.control.status()!;
    expect(after.workflowCensus?.["ci-run"]).toMatchObject({
      terminated: ["legacy-run"],
      remaining: [],
    });
    expect(after.consumers["ci-workflow"]?.evidence?.workflows?.["ci-run"]).toMatchObject({
      terminated: ["legacy-run"],
    });
    f.control.beginMigration(run.runId);
    expect(f.control.status()?.phase).toBe("migrating");
    f.close();
  });

  test("an instance that does not reach a terminal state keeps its consumers blocked", async () => {
    const f = await fixture();
    Reflect.set(f.env, "CI_RUN", workflowBinding(f.statuses, { stubborn: true }));
    const run = await f.fence();
    await f.control.fenceDatabases(run.runId);
    cleanRefPass(f.control, run.runId, "fenced");
    vi.setSystemTime(PREPARED + BOUND);
    f.statuses.set("legacy-run", "running");
    await f.control.recordWorkflowCensus(
      run.runId,
      census([{ id: "legacy-run", status: "running" }]),
      "test-human",
    );
    const drain = await inspectCutoverDrain(f.env, run.runId);
    expect(drain.blockers).toContainEqual(
      expect.objectContaining({ consumer: "ci-workflow", code: "legacy_workflow_still_running" }),
    );
    // Consumers without Workflows still drained on their documented bound.
    expect(f.control.status()?.consumers.scheduled?.drained).toBe(true);
    expect(f.control.status()?.consumers["ci-workflow"]).toBeUndefined();
    expect(() => f.control.beginMigration(run.runId)).toThrow("drain");
    f.close();
  });

  test("a malformed census is rejected whole, never trimmed", async () => {
    const f = await fixture();
    const run = await f.fence();
    await f.control.fenceDatabases(run.runId);
    vi.setSystemTime(PREPARED + BOUND);
    const good = census();
    const reject = (value: unknown, message: string) =>
      expect(f.control.recordWorkflowCensus(run.runId, value, "test-human")).rejects.toThrow(
        message,
      );
    await reject(
      { ...good, workflows: { "ci-run": good.workflows["ci-run"] } },
      "every knowledge-build instance",
    );
    await reject(
      {
        ...good,
        workflows: {
          ...good.workflows,
          "ci-run": { name: "ci-run", instances: [{ id: 7, status: "running" }] },
        },
      },
      "Malformed",
    );
    // An unnamed account could be any account: its empty list proves nothing.
    await reject({ ...good, account: undefined }, "name its Cloudflare account");
    // Another workflow's list is not this one's.
    await reject(
      { ...good, workflows: { ...good.workflows, "ci-run": { name: "other", instances: [] } } },
      "every ci-run instance",
    );
    await reject({ ...good, deployments: [] }, "deployment history");
    await reject(
      census([
        { id: "same", status: "running" },
        { id: "same", status: "running" },
      ]),
      "twice",
    );
    expect(f.control.status()?.workflowCensus).toBeUndefined();
    f.close();
  });

  test("D1's in-flight work must all be listed: an instance the provider holds but the census omits blocks", async () => {
    const f = await fixture();
    const run = await f.fence();
    // Work in flight before the storage fence closed.
    f.db.applySql(
      "INSERT INTO ci_runs VALUES('listed-run','running'),('unlisted-run','queued'),('orphan-run','queued'),('done-run','succeeded');",
    );
    await f.control.fenceDatabases(run.runId);
    cleanRefPass(f.control, run.runId, "fenced");
    vi.setSystemTime(PREPARED + BOUND);
    f.statuses.set("listed-run", "running");
    f.statuses.set("unlisted-run", "running");
    // A census from the wrong account, or one that skipped a page, misses unlisted-run.
    await f.control.recordWorkflowCensus(
      run.runId,
      census([{ id: "listed-run", status: "running" }]),
      "test-human",
    );
    expect(f.control.status()?.workflowCensus?.["ci-run"]).toMatchObject({
      unlisted: ["unlisted-run"],
      // No instance exists at all: nothing executes it, so nothing to drain.
      orphaned: ["orphan-run"],
    });
    const drain = await inspectCutoverDrain(f.env, run.runId);
    expect(drain.blockers).toContainEqual(
      expect.objectContaining({ consumer: "ci-workflow", code: "workflow_census_incomplete" }),
    );
    expect(f.control.status()?.consumers["ci-workflow"]).toBeUndefined();
    // A complete census settles both runs.
    await f.control.recordWorkflowCensus(
      run.runId,
      census([
        { id: "listed-run", status: "running" },
        { id: "unlisted-run", status: "running" },
      ]),
      "test-human",
    );
    expect((await inspectCutoverDrain(f.env, run.runId)).ready).toBe(true);
    expect(
      f.control.status()?.consumers["ci-workflow"]?.evidence?.workflows?.["ci-run"],
    ).toMatchObject({ terminated: ["listed-run", "unlisted-run"], orphaned: ["orphan-run"] });
    f.close();
  });

  test("each termination is journaled as it happens, so a later failure loses no evidence", async () => {
    const f = await fixture();
    const failing = new Set<string>();
    Reflect.set(f.env, "CI_RUN", workflowBinding(f.statuses, { failing }));
    const run = await f.fence();
    await f.control.fenceDatabases(run.runId);
    cleanRefPass(f.control, run.runId, "fenced");
    vi.setSystemTime(PREPARED + BOUND);
    f.statuses.set("a-run", "running");
    f.statuses.set("b-run", "running");
    await f.control.recordWorkflowCensus(
      run.runId,
      census([
        { id: "a-run", status: "running" },
        { id: "b-run", status: "running" },
      ]),
      "test-human",
    );
    failing.add("b-run");
    await expect(f.control.settleLegacyWorkflows(run.runId)).rejects.toThrow("unavailable");
    expect(f.control.status()?.workflowCensus?.["ci-run"]).toMatchObject({
      terminated: ["a-run"],
      settledAt: null,
    });
    failing.clear();
    await f.control.settleLegacyWorkflows(run.runId);
    expect(f.control.status()?.workflowCensus?.["ci-run"]).toMatchObject({
      terminated: ["a-run", "b-run"],
      remaining: [],
    });
    f.close();
  });
});

describe("census export from the provider's lists", () => {
  const page = (from: number, count: number, status = "running") =>
    Array.from({ length: count }, (_, index) => ({
      id: `i-${from + index}`,
      status,
      created_on: "2026-10-12T11:00:00Z",
    }));
  // The same instances as the census tool parses them.
  const listed = (from: number, count: number, status = "running") =>
    page(from, count, status).map(({ id, status, created_on }) => ({
      id,
      status,
      createdOn: created_on,
    }));

  test("numbered pages continue past a full page, so more than one page is listed whole", () => {
    const calls: { cursor: string | null; page: number }[] = [];
    const rows = listWorkflowInstances("ci-run", ({ cursor, page: number }) => {
      calls.push({ cursor, page: number });
      return JSON.stringify(
        number === 1 ? page(0, CENSUS_PER_PAGE) : number === 2 ? page(100, 30) : [],
      );
    });
    expect(rows).toHaveLength(130);
    expect(calls.map((call) => call.page)).toEqual([1, 2]);
    expect(rows[129]).toEqual({
      id: "i-129",
      status: "running",
      createdOn: "2026-10-12T11:00:00Z",
    });
  });

  test("a cursor continues an enveloped result; a full page without one is refused", () => {
    const rows = listWorkflowInstances("ci-run", ({ cursor }) =>
      JSON.stringify(
        cursor === null
          ? { result: page(0, CENSUS_PER_PAGE), result_info: { cursor: "next" } }
          : { result: page(100, 1), result_info: { cursor: null } },
      ),
    );
    expect(rows).toHaveLength(101);
    expect(() =>
      listWorkflowInstances("ci-run", () =>
        JSON.stringify({ result: page(0, CENSUS_PER_PAGE), result_info: {} }),
      ),
    ).toThrow("no continuation");
  });

  test("pages that repeat instances, or listings that disagree, are refused", () => {
    expect(() =>
      listWorkflowInstances("ci-run", () => JSON.stringify(page(0, CENSUS_PER_PAGE))),
    ).toThrow("repeated an instance");
    const first = listed(0, 3);
    expect(() => confirmListing("ci-run", first, [...first, ...listed(3, 1)])).toThrow("changed");
    expect(() => confirmListing("ci-run", first, first.slice(1))).toThrow("changed");
    // Retention may drop a finished instance between listings.
    const finished = [...listed(0, 2), ...listed(2, 1, "complete")];
    expect(() => confirmListing("ci-run", finished, finished.slice(0, 2))).not.toThrow();
  });
});
