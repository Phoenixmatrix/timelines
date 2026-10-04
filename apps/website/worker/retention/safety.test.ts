// The retention safety suite (CORE-211): the PRD's gates (CORE-195) across
// every category, on one richly seeded deployment (worker/retention/
// testing/rich.ts: both D1 databases, the registry's R2 bucket, the
// account's Tracker Durable Object, assistant chats).
//
// - Gate 1: with nothing enabled, a full cron cycle of every retention job
//   deletes nothing.
// - Gate 2, per category with a cleanup: its dry run deletes nothing and
//   selects exactly what its run removes; the run is bounded (batches of at
//   most the limit, calls of at most a few batches, resumed), idempotent,
//   audited, keeps everything its "never" list and thresholds protect, and
//   changes nothing outside its own data.
// - Gate 3: the account's Tracker, holding real data, purges to nothing
//   (every class's contract: worker/durable/purge.test.ts and conformance).
// - Authorization: every retention, usage and price route for an outsider, a
//   member, an administrator's agent, an administrator and a site
//   administrator; refused writes store nothing.
// Provider-dependent parts (Vectorize, AI Search, Artifacts, the Assistant
// in workerd, repository deletion end to end) run in the E2E scenarios and
// `vp run agent test-ai` (README "Retention safety").

import { Hono } from "hono";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { issueToken } from "../api/tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { DURABLE_CLASSES } from "../durable/classes.ts";
import { purgeInstance } from "../durable/registry.ts";
import { isEmpty, storageReport } from "../durable/contract.ts";
import { sweepDurableInstances } from "../durable/sweep.ts";
import { d1, migratedDatabase } from "../testing/d1.ts";
import { pricesApi } from "../usage/prices-api.ts";
import { accountUsageApi, siteUsageApi } from "../usage/report-api.ts";
import { collectUsage } from "../usage/collect.ts";
import { accountRetentionApi, accountRunsApi, siteRetentionApi } from "./api.ts";
import { category, defaultValues } from "./categories.ts";
import { resumeDeletions } from "./repo-deletion.ts";
import { advanceRun, createRun, getRun, retentionCron } from "./runs.ts";
import type { RetentionTarget } from "./policies.ts";
import { FIXTURES, NOW, richSeed, type Rich, type Store } from "./testing/rich.ts";

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

// The Assistant is an Agents SDK agent (workerd only): a stand-in with its
// purge contract, over the seeded chat objects.
vi.mock("agents", async () => {
  const { chatObjects } = await import("./testing/rich.ts");
  return {
    getAgentByName: async (_namespace: unknown, name: string) => ({
      async purgeIfIdle(reason: string) {
        const chat = chatObjects.get(name) ?? { messages: 0, busy: false };
        if (chat.busy) return null;
        chatObjects.set(name, { messages: 0, busy: false });
        const at = new Date().toISOString();
        return { reason, purgedAt: at, bytes: 0, tables: [], keys: 0, alarm: null };
      },
      async storageReport() {
        const chat = chatObjects.get(name);
        return { bytes: (chat?.messages ?? 0) * 100, tables: [], keys: 0, alarm: null };
      },
    }),
  };
});

afterEach(() => vi.unstubAllGlobals());

// ---- snapshots ------------------------------------------------------------------------

/** Every table's rows as sorted JSON strings. */
function tables(sqlite: Rich["sqlite"], prefix: string, skip: string[] = []) {
  const names = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return Object.fromEntries(
    names
      .filter(({ name }) => !skip.includes(name))
      .map(({ name }) => [
        `${prefix}:${name}`,
        (sqlite.prepare(`SELECT * FROM "${name}"`).all() as object[])
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
  );
}

/** Everything a cleanup could touch, by store. Cleanup's own audit tables aside. */
async function snapshot(t: Rich): Promise<Record<string, string[]>> {
  const tracker = Object.values(tables(t.tracker.db, "t")).flat().sort();
  return {
    ...tables(t.sqlite, "db", ["cleanup_runs", "cleanup_run_categories", "sqlite_sequence"]),
    ...tables(t.registry, "registry"),
    tracker,
    r2: (await t.bucket.list({})).objects.map((o) => `${o.key} ${o.size}`).sort(),
    chats: [...(await import("./testing/rich.ts")).chatObjects]
      .map(([name, chat]) => `${name} ${chat.messages}`)
      .sort(),
  };
}

/**
 * Bookkeeping that every use of a Durable Object or a cursor updates: its
 * rows may change (last use, size, owner) but none may disappear.
 */
const BOOKKEEPING: Record<string, (row: Record<string, unknown>) => string> = {
  "db:do_instances": (row) => `${String(row.class)} ${String(row.name)}`,
  "db:job_cursors": (row) => String(row.name),
};

function keyed(store: string, rows: string[]) {
  const key = BOOKKEEPING[store]!;
  return rows.map((row) => key(JSON.parse(row) as Record<string, unknown>)).sort();
}

/** Stores that differ, except `allowed`; bookkeeping only by its keys. */
function changed(
  before: Record<string, string[]>,
  after: Record<string, string[]>,
  allowed: readonly string[] = [],
  { onlyLosses = false } = {},
) {
  const out: string[] = [];
  for (const store of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (allowed.includes(store)) continue;
    const was = before[store] ?? [];
    const is = after[store] ?? [];
    if (store in BOOKKEEPING) {
      const now = new Set(keyed(store, is));
      const lost = keyed(store, was).filter((k) => !now.has(k));
      if (lost.length) out.push(`${store} lost ${lost.join(", ")}`);
      continue;
    }
    const now = new Set(is);
    const lost = was.filter((row) => !now.has(row));
    if (lost.length) out.push(`${store} lost or changed ${lost.length}: ${lost[0]}`);
    if (!onlyLosses && is.length !== was.length)
      out.push(`${store} has ${is.length} rows, had ${was.length}`);
  }
  return out;
}

// ---- runs -----------------------------------------------------------------------------

const LIMIT = 1;
const BATCHES_PER_CALL = 3;

async function runOne(t: Rich, id: string, target: RetentionTarget, dryRun: boolean) {
  const thresholds = defaultValues(category(id)!);
  const runId = await createRun(t.env.DB, {
    target,
    trigger: "manual",
    actorId: "acc_marco",
    dryRun,
    categories: [{ id, thresholds }],
    now: NOW,
  });
  const seen: unknown[] = [];
  let largest = 0;
  let calls = 0;
  let state;
  do {
    state = await advanceRun(t.env, runId, {
      now: NOW,
      limit: LIMIT,
      maxBatches: BATCHES_PER_CALL,
      afterBatch: (_category, items) => {
        seen.push(...items);
        largest = Math.max(largest, items.length);
      },
    });
    calls++;
  } while (state === "more");
  expect(state).toBe("done");
  const run = (await getRun(t.env.DB, target, runId))!;
  expect(run, JSON.stringify(run)).toMatchObject({ status: "succeeded" });
  return { runId, thresholds, seen, largest, calls, run };
}

// ---- the suite ------------------------------------------------------------------------

describe("gate 1: nothing enabled, a full cron cycle deletes nothing", () => {
  test("every hourly retention job over 26 hours, on the rich deployment", async () => {
    const t = richSeed();
    await t.ready;
    // Stored policies that enable nothing: thresholds changed, categories
    // turned off explicitly, site-wide defaults without enabling.
    t.sqlite.exec(`
      INSERT INTO retention_policies (account_id, category, enabled, thresholds) VALUES
        ('acc_orbit', 'ci-logs', 0, '{"days": 1}'),
        ('acc_orbit', 'push-log', NULL, '{"days": 1}'),
        ('acc_marco', 'assistant-chats', 0, '{"days": 1, "maxPerUser": 1}');
      INSERT INTO retention_site_policies (category, enabled, thresholds) VALUES
        ('timeline-work-sources', 0, '{}'),
        ('auth-hygiene', 0, '{"days": 1}'),
        ('closed-issues', NULL, '{"days": 1}'),
        ('usage-history', NULL, '{"days": 32, "months": 1}');
    `);
    // No provider is reachable from here: a call to one fails like an outage.
    vi.stubGlobal("fetch", async () => {
      throw new Error("no network in the safety suite");
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = await snapshot(t);
    const waits: Promise<unknown>[] = [];
    try {
      for (let hour = 0; hour <= 26; hour++) {
        const at = new Date(NOW.getTime() + hour * 3_600_000);
        expect(await retentionCron(t.env, { now: at, advance: { now: at } })).toEqual({
          scheduled: [],
          restarted: [],
        });
        await sweepDurableInstances(t.env, at.getTime());
        await resumeDeletions(t.env, { waitUntil: (w) => void waits.push(w), now: at.getTime() });
        await collectUsage(t.env, at);
      }
      await Promise.allSettled(waits);
    } finally {
      quiet.mockRestore();
      warn.mockRestore();
    }
    const after = await snapshot(t);
    // Rows may be added (usage figures, registry bookkeeping), none removed or changed.
    expect(changed(before, after, [], { onlyLosses: true })).toEqual([]);
    for (const store of ["tracker", "r2", "chats"])
      expect(after[store], store).toEqual(before[store]);
    expect(t.sqlite.prepare("SELECT count(*) AS n FROM cleanup_runs").get()).toEqual({ n: 0 });
    expect(t.sent).toEqual([]);
  });
});

describe("gate 2: each category's dry run is its run, bounded, idempotent, audited", () => {
  test.each(Object.keys(FIXTURES))("%s", async (id) => {
    const fixture = FIXTURES[id]!;
    const t = richSeed();
    await t.ready;
    const before = await snapshot(t);
    const kept = await fixture.kept(t);
    expect(kept.length, "the fixture has data the category must keep").toBeGreaterThan(0);

    // The dry run lists records and deletes nothing.
    const dry = await runOne(t, id, fixture.target, true);
    expect(dry.run.items, "the fixture has data past the thresholds").toBeGreaterThan(0);
    expect(dry.seen.length).toBeGreaterThanOrEqual(2);
    expect(changed(before, await snapshot(t))).toEqual([]);

    // The run removes exactly that, in bounded batches and calls.
    const real = await runOne(t, id, fixture.target, false);
    expect(real.seen).toEqual(dry.seen);
    if (fixture.inUse) {
      // Listed, then left: in use when the run reached it (see Fixture.inUse).
      expect(real.run.items).toBe(dry.run.items - fixture.inUse);
      expect(real.run.bytes).toBeLessThan(dry.run.bytes);
    } else
      expect({ items: real.run.items, bytes: real.run.bytes }).toEqual({
        items: dry.run.items,
        bytes: dry.run.bytes,
      });
    expect(real.largest).toBeLessThanOrEqual(LIMIT);
    expect(real.run.categories[0]!.batches).toBeGreaterThanOrEqual(2);
    expect(real.calls).toBeGreaterThanOrEqual(
      Math.ceil(real.run.categories[0]!.batches / BATCHES_PER_CALL),
    );
    const after = await snapshot(t);
    // Only its own data changed, and what it must keep is still there.
    expect(changed(before, after, fixture.touches)).toEqual([]);
    expect(
      fixture.touches.filter(
        (store: Store) => JSON.stringify(before[store]) !== JSON.stringify(after[store]),
      ).length,
      "the run removed something",
    ).toBeGreaterThan(0);
    expect(await fixture.kept(t)).toEqual(kept);

    // Audited: who, when, what thresholds, what it did.
    const audit = t.sqlite
      .prepare(
        `SELECT r.trigger, r.actor_id, r.dry_run, r.status, r.as_of, r.items, r.bytes,
                c.category, c.thresholds, c.status AS category_status, c.items AS category_items
         FROM cleanup_runs r JOIN cleanup_run_categories c ON c.run_id = r.id WHERE r.id = ?`,
      )
      .all(real.runId);
    expect(audit).toEqual([
      {
        trigger: "manual",
        actor_id: "acc_marco",
        dry_run: 0,
        status: "succeeded",
        as_of: NOW.toISOString(),
        items: real.run.items,
        bytes: real.run.bytes,
        category: id,
        thresholds: JSON.stringify(real.thresholds),
        category_status: "succeeded",
        category_items: real.run.items,
      },
    ]);

    // Idempotent: again, nothing (what's in use is listed again, and left again).
    const again = await runOne(t, id, fixture.target, false);
    expect({ seen: again.seen.length, items: again.run.items, bytes: again.run.bytes }).toEqual({
      seen: fixture.inUse ?? 0,
      items: 0,
      bytes: 0,
    });
    expect(changed(after, await snapshot(t))).toEqual([]);
  });
});

describe("gate 3: Durable Objects", () => {
  test("the account's Tracker, holding issues and activity, purges to nothing, and is recorded", async () => {
    const t = richSeed();
    expect(isEmpty(await storageReport(t.tracker.ctx.storage))).toBe(false);
    const report = await purgeInstance(t.env, "Tracker", "acc_orbit", "safety suite");
    expect(report).toMatchObject({ reason: "safety suite", tables: [], keys: 0, alarm: null });
    expect(isEmpty(await storageReport(t.tracker.ctx.storage))).toBe(true);
    expect(t.tracker.alarm()).toBeNull();
    expect(
      t.sqlite
        .prepare(
          "SELECT purge_reason FROM do_instances WHERE class = 'Tracker' AND name = 'acc_orbit'",
        )
        .get(),
    ).toEqual({ purge_reason: "safety suite" });
    // Every class has the contract (conformance.test.ts) and a purge test
    // (purge.test.ts; the Assistant in workerd: E2E durable-objects-register-and-purge).
    expect(Object.keys(DURABLE_CLASSES)).toContain("Tracker");
  });
});

// ---- authorization ------------------------------------------------------------------

async function authorizationSetup() {
  const sqlite = migratedDatabase();
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  sqlite.exec(
    readFileSync(fileURLToPath(new URL("../../seed/0001_dev.sql", import.meta.url).href), "utf8"),
  );
  sqlite.exec(
    "INSERT INTO agents (id, name, accountable_id) VALUES ('agt_marco', 'builder', 'acc_marco')",
  );
  const env = { DB: d1(sqlite) } as unknown as Env;
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    return next();
  });
  app.route("/api/accounts/:slug/settings/retention", accountRetentionApi);
  app.route("/api/accounts/:slug/retention/runs", accountRunsApi);
  app.route("/api/admin/retention", siteRetentionApi);
  app.route("/api/admin/prices", pricesApi);
  app.route("/api/accounts/:slug/usage", accountUsageApi);
  app.route("/api/admin/usage", siteUsageApi);
  const token = async (user: string, agent?: string) =>
    (await issueToken(env.DB, user, `t-${Math.random()}`, "write", undefined, agent)).secret;
  const tokens = {
    outsider: await token("acc_sam"),
    member: await token("acc_jun"),
    agent: await token("acc_marco", "agt_marco"),
    owner: await token("acc_marco"),
    siteAdmin: await token("acc_priya"),
  };
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (work: Promise<unknown>) => void pending.push(work),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const call = async (
    who: keyof typeof tokens | null,
    method: string,
    path: string,
    body?: unknown,
  ) => {
    const response = await app.request(
      path,
      {
        method,
        headers: {
          ...(who ? { authorization: `Bearer ${tokens[who]}` } : {}),
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env,
      ctx,
    );
    await Promise.all(pending.splice(0));
    return response.status;
  };
  /** Rows a refused write must not add. */
  const stored = () =>
    [
      "retention_policies",
      "retention_site_policies",
      "retention_policy_changes",
      "cleanup_runs",
      "cloudflare_prices",
      "cloudflare_price_changes",
    ].map(
      (table) => (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n,
    );
  return { call, stored };
}

const PERSONAS = ["outsider", "member", "agent", "owner", "siteAdmin"] as const;
type Persona = (typeof PERSONAS)[number];
const ORG = "/api/accounts/orbit";

/** Each route: the status per persona; a write's success may store, a refusal never. */
const ROUTES: {
  method: string;
  path: string | ((runs: { account: number; site: number }) => string);
  body?: unknown;
  expect: Record<Persona, number>;
  write?: boolean;
}[] = [
  // CORE-210: an account's retention is its administrators' (members 403).
  {
    method: "GET",
    path: `${ORG}/settings/retention`,
    expect: { outsider: 404, member: 403, agent: 200, owner: 200, siteAdmin: 200 },
  },
  {
    method: "PATCH",
    path: `${ORG}/settings/retention`,
    body: { categories: { "ci-logs": { enabled: true } } },
    expect: { outsider: 404, member: 403, agent: 403, owner: 200, siteAdmin: 200 },
    write: true,
  },
  {
    method: "POST",
    path: `${ORG}/retention/runs`,
    body: { dryRun: true, categories: ["preview-records"] },
    expect: { outsider: 404, member: 403, agent: 403, owner: 202, siteAdmin: 202 },
    write: true,
  },
  {
    method: "GET",
    path: `${ORG}/retention/runs`,
    expect: { outsider: 404, member: 403, agent: 200, owner: 200, siteAdmin: 200 },
  },
  {
    method: "GET",
    path: (runs) => `${ORG}/retention/runs/${runs.account}`,
    expect: { outsider: 404, member: 403, agent: 200, owner: 200, siteAdmin: 200 },
  },
  {
    method: "GET",
    path: "/api/admin/retention",
    expect: { outsider: 403, member: 403, agent: 403, owner: 403, siteAdmin: 200 },
  },
  {
    method: "PATCH",
    path: "/api/admin/retention",
    body: { categories: { "auth-hygiene": { enabled: true } } },
    expect: { outsider: 403, member: 403, agent: 403, owner: 403, siteAdmin: 200 },
    write: true,
  },
  {
    method: "POST",
    path: "/api/admin/retention/runs",
    body: { dryRun: true, categories: ["auth-hygiene"] },
    expect: { outsider: 403, member: 403, agent: 403, owner: 403, siteAdmin: 202 },
    write: true,
  },
  {
    method: "GET",
    path: "/api/admin/retention/runs",
    expect: { outsider: 403, member: 403, agent: 403, owner: 403, siteAdmin: 200 },
  },
  {
    method: "GET",
    path: (runs) => `/api/admin/retention/runs/${runs.site}`,
    expect: { outsider: 403, member: 403, agent: 403, owner: 403, siteAdmin: 200 },
  },
  {
    method: "GET",
    path: `${ORG}/usage`,
    expect: { outsider: 404, member: 403, agent: 200, owner: 200, siteAdmin: 200 },
  },
  {
    method: "GET",
    path: "/api/admin/usage",
    expect: { outsider: 403, member: 403, agent: 403, owner: 403, siteAdmin: 200 },
  },
  // Cloudflare's public prices: anyone signed in; managing them: site administrators.
  {
    method: "GET",
    path: "/api/admin/prices",
    expect: { outsider: 200, member: 200, agent: 200, owner: 200, siteAdmin: 200 },
  },
  {
    method: "GET",
    path: "/api/admin/prices/changes",
    expect: { outsider: 403, member: 403, agent: 403, owner: 403, siteAdmin: 200 },
  },
  {
    method: "POST",
    path: "/api/admin/prices/edits",
    body: { product: "d1", metric: "storage", unitPriceUsd: 99, note: "no" },
    expect: { outsider: 403, member: 403, agent: 403, owner: 403, siteAdmin: 0 },
    write: true,
  },
  {
    method: "POST",
    path: "/api/admin/prices/changes/1/apply",
    expect: { outsider: 403, member: 403, agent: 403, owner: 403, siteAdmin: 0 },
    write: true,
  },
];

describe("authorization", () => {
  test("every retention, usage and price route, for every kind of caller", async () => {
    const t = await authorizationSetup();
    // A run of each level to read back.
    expect(
      await t.call("owner", "POST", `${ORG}/retention/runs`, {
        dryRun: true,
        categories: ["preview-records"],
      }),
    ).toBe(202);
    expect(
      await t.call("siteAdmin", "POST", "/api/admin/retention/runs", {
        dryRun: true,
        categories: ["auth-hygiene"],
      }),
    ).toBe(202);
    const runs = { account: 1, site: 2 };
    const failures: string[] = [];
    for (const route of ROUTES) {
      const path = typeof route.path === "function" ? route.path(runs) : route.path;
      // Signed out: never.
      const anonymous = await t.call(null, route.method, path, route.body);
      if (anonymous !== 401) failures.push(`anonymous ${route.method} ${path}: ${anonymous}`);
      for (const persona of PERSONAS) {
        const wanted = route.expect[persona];
        // 0: allowed, but not exercised here (a site-wide price change).
        if (wanted === 0) continue;
        const before = t.stored();
        const status = await t.call(persona, route.method, path, route.body);
        if (status !== wanted)
          failures.push(`${persona} ${route.method} ${path}: ${status}, expected ${wanted}`);
        if (route.write && status >= 400 && JSON.stringify(t.stored()) !== JSON.stringify(before))
          failures.push(`${persona} ${route.method} ${path}: refused, but stored something`);
      }
    }
    expect(failures).toEqual([]);
  });
});
