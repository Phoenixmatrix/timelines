import type { DatabaseSync } from "node:sqlite";
import { describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import {
  ATLAS_LIMITS,
  ATLAS_PRICES,
  atlasDailySpend,
  atlasRunSpend,
  atlasSettings,
  costMicroUsd,
  estimateTokens,
  parseAtlasConfig,
  releaseAtlasCall,
  reserveAtlasCall,
  resolveAtlasSettings,
  runAtlasCall,
  settleAtlasCall,
  type AtlasCallRequest,
  type AtlasScope,
  type BudgetOptions,
  type PriceTable,
} from "./budget.ts";
import { MODELS } from "./models.ts";

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

const MODEL = "test/model";
// $1 per 1,000 output tokens, input free: easy dollar arithmetic.
const DOLLAR_PER_K_OUT: PriceTable = { [MODEL]: { input: 0, output: 1000 } };
const CHEAP: PriceTable = { [MODEL]: { input: 0.1, output: 0.1 } };
const NOON = new Date("2026-10-03T12:00:00Z");

/** Two repositories in acme, one in ann's explicit personal Space. */
async function setup() {
  const fresh = await createFreshSpaceTestEnvironment();
  onTestFinished(fresh.close);
  const { sqlite } = fresh;
  sqlite.exec(`
    BEGIN;
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('person-ann', 'user', 'ann', 'Ann');
    INSERT INTO organizations (id, slug, display_name, kind, personal_account_id, default_space_id) VALUES
      ('company', 'company', 'Company', 'company', NULL, 'acme'),
      ('personal', 'personal-ann', 'Ann', 'personal', 'person-ann', 'ann');
    INSERT INTO spaces (id, organization_id, slug, display_name) VALUES
      ('acme', 'company', 'acme', 'Acme'),
      ('sibling', 'company', 'sibling', 'Sibling'),
      ('ann', 'personal', 'ann-notes', 'Notes');
    COMMIT;
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote) VALUES
      ('r1', 'acme', 'engine', 'private', 'a1', ''),
      ('r2', 'acme', 'wheels', 'private', 'a2', ''),
      ('r3', 'ann', 'notes', 'private', 'a3', '');
  `);
  return { sqlite, DB: fresh.env.DB };
}

const build = (repoId: string, buildId: string): AtlasScope => ({ kind: "build", repoId, buildId });
const grouping = (spaceId: string, passId: string): AtlasScope => ({
  kind: "grouping",
  spaceId,
  passId,
});

function call(
  scope: AtlasScope,
  maxInputTokens: number,
  maxOutputTokens: number,
): AtlasCallRequest {
  return { scope, purpose: "capability_summary", model: MODEL, maxInputTokens, maxOutputTokens };
}

const rows = (sqlite: DatabaseSync, sql: string) => sqlite.prepare(sql).all();

describe("per-run caps", () => {
  const options: BudgetOptions = { prices: CHEAP, now: NOON };

  test.each([
    ["build", build("r1", "b1"), ATLAS_LIMITS.build],
    ["grouping", grouping("acme", "p1"), ATLAS_LIMITS.grouping],
  ] as const)("%s: the call cap stops paid work at the first refusal", async (_, scope, limits) => {
    const { DB } = await setup();
    for (let i = 0; i < limits.calls; i++)
      expect((await reserveAtlasCall(DB, call(scope, 10, 10), options)).status).toBe("reserved");
    const refused = await reserveAtlasCall(DB, call(scope, 10, 10), options);
    expect(refused).toEqual({
      status: "exhausted",
      cap: "calls",
      spaceId: "acme",
      exhaustedAt: NOON.toISOString(),
      resetsAt: null,
    });
    const spend = await atlasRunSpend(DB, scope.kind, scope.kind === "build" ? "b1" : "p1", "acme");
    expect(spend).toMatchObject({
      calls: limits.calls,
      exhausted: { cap: "calls", resetsAt: null },
    });
  });

  test.each([
    ["build", build("r1", "b1"), ATLAS_LIMITS.build],
    ["grouping", grouping("acme", "p1"), ATLAS_LIMITS.grouping],
  ] as const)("%s: input and output token caps", async (kind, scope, limits) => {
    const { DB } = await setup();
    // Input: most of the cap, then one more than fits.
    expect(
      (await reserveAtlasCall(DB, call(scope, limits.inputTokens - 10, 1), options)).status,
    ).toBe("reserved");
    expect(await reserveAtlasCall(DB, call(scope, 11, 1), options)).toMatchObject({
      status: "exhausted",
      cap: "input_tokens",
    });
    // First cap reached stops the run: even a call that would fit is refused.
    expect(await reserveAtlasCall(DB, call(scope, 1, 1), options)).toMatchObject({
      status: "exhausted",
      cap: "input_tokens",
    });

    const other = kind === "build" ? build("r1", "b2") : grouping("acme", "p2");
    expect((await reserveAtlasCall(DB, call(other, 1, limits.outputTokens), options)).status).toBe(
      "reserved",
    );
    expect(await reserveAtlasCall(DB, call(other, 1, 1), options)).toMatchObject({
      status: "exhausted",
      cap: "output_tokens",
    });
  });

  test("a run's caps don't stop another run of the same Space", async () => {
    const { DB } = await setup();
    for (let i = 0; i <= ATLAS_LIMITS.build.calls; i++)
      await reserveAtlasCall(DB, call(build("r1", "b1"), 10, 10), options);
    expect((await reserveAtlasCall(DB, call(build("r1", "b2"), 10, 10), options)).status).toBe(
      "reserved",
    );
    expect((await reserveAtlasCall(DB, call(build("r2", "b3"), 10, 10), options)).status).toBe(
      "reserved",
    );
  });

  test("concurrent reservations on one build never exceed its call cap", async () => {
    const { DB, sqlite } = await setup();
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        reserveAtlasCall(DB, call(build("r1", "b1"), 100, 100), options),
      ),
    );
    expect(results.filter((r) => r.status === "reserved")).toHaveLength(ATLAS_LIMITS.build.calls);
    expect(results.filter((r) => r.status === "exhausted" && r.cap === "calls")).toHaveLength(30);
    expect(rows(sqlite, "SELECT id FROM atlas_spend")).toHaveLength(ATLAS_LIMITS.build.calls);
  });
});

describe("daily ceiling per owning Space", () => {
  const options: BudgetOptions = { prices: DOLLAR_PER_K_OUT, now: NOON };

  test("concurrent reservations across repositories and scopes stop at exactly $10", async () => {
    const { DB, sqlite } = await setup();
    // 40 $1 calls at once, from both repositories' builds and grouping passes.
    const scopes = Array.from({ length: 40 }, (_, i) =>
      i % 3 === 0 ? grouping("acme", `p${i}`) : build(i % 2 ? "r1" : "r2", `b${i}`),
    );
    const results = await Promise.all(
      scopes.map((s) => reserveAtlasCall(DB, call(s, 50, 1000), options)),
    );
    expect(results.filter((r) => r.status === "reserved")).toHaveLength(10);
    const refused = results.filter((r) => r.status === "exhausted");
    expect(refused).toHaveLength(30);
    expect(new Set(refused.map((r) => r.status === "exhausted" && r.cap))).toEqual(
      new Set(["daily_usd"]),
    );
    expect(refused[0]).toMatchObject({ spaceId: "acme", resetsAt: "2026-10-04T00:00:00.000Z" });
    expect(rows(sqlite, "SELECT SUM(cost_micro_usd) AS c FROM atlas_spend")).toEqual([
      { c: 10_000_000 },
    ]);
    expect(await atlasDailySpend(DB, "acme", { now: NOON })).toEqual({
      day: "2026-10-03",
      usd: 10,
      limitUsd: 10,
      resetsAt: "2026-10-04T00:00:00.000Z",
      exhausted: true,
    });
  });

  test("the ceiling is the Space's: other Spaces keep theirs, and no scope evades it", async () => {
    const { DB } = await setup();
    for (let i = 0; i < 10; i++)
      await reserveAtlasCall(DB, call(build("r1", `b${i}`), 1, 1000), options);
    // The first refusal records the ceiling; it then stops every scope of acme.
    expect(await reserveAtlasCall(DB, call(build("r1", "b10"), 1, 1000), options)).toMatchObject({
      cap: "daily_usd",
    });
    expect(await reserveAtlasCall(DB, call(grouping("acme", "pass"), 1, 1), options)).toMatchObject(
      {
        status: "exhausted",
        cap: "daily_usd",
        spaceId: "acme",
      },
    );
    expect(await reserveAtlasCall(DB, call(build("r2", "fresh"), 1, 1), options)).toMatchObject({
      cap: "daily_usd",
    });
    // The refused runs show why they stopped.
    expect((await atlasRunSpend(DB, "grouping", "pass", "acme")).exhausted).toMatchObject({
      cap: "daily_usd",
    });
    // Ann's repository is another Space's budget.
    expect((await reserveAtlasCall(DB, call(build("r3", "b1"), 1, 1000), options)).status).toBe(
      "reserved",
    );
  });

  test("day rollover: a new UTC day has a fresh ceiling; a stopped run stays stopped", async () => {
    const { DB } = await setup();
    const lateNight = { ...options, now: new Date("2026-10-03T23:59:00Z") };
    for (let i = 0; i < 10; i++)
      await reserveAtlasCall(DB, call(build("r1", `n${i}`), 1, 950), lateNight);
    expect(
      await reserveAtlasCall(DB, call(build("r1", "night"), 1, 1000), lateNight),
    ).toMatchObject({
      cap: "daily_usd",
      resetsAt: "2026-10-04T00:00:00.000Z",
    });
    const morning = { ...options, now: new Date("2026-10-04T00:01:00Z") };
    expect(
      (await reserveAtlasCall(DB, call(build("r1", "morning"), 1, 1000), morning)).status,
    ).toBe("reserved");
    // No automatic paid retries: the run the ceiling stopped doesn't resume.
    expect(await reserveAtlasCall(DB, call(build("r1", "night"), 1, 1), morning)).toMatchObject({
      status: "exhausted",
      cap: "daily_usd",
    });
    expect(await atlasDailySpend(DB, "acme", morning)).toMatchObject({
      day: "2026-10-04",
      usd: 1,
      exhausted: false,
    });
  });
});

describe("reconciliation", () => {
  test("settling replaces the reservation with actual usage, freeing room under the caps", async () => {
    const { DB, sqlite } = await setup();
    const options = { prices: DOLLAR_PER_K_OUT, now: NOON };
    const first = await reserveAtlasCall(DB, call(build("r1", "b1"), 2000, 9000), options);
    if (first.status !== "reserved") throw new Error("expected a reservation");
    expect(first.handle).toMatchObject({
      spaceId: "acme",
      reservedOutputTokens: 9000,
      reservedUsd: 9,
    });
    // Charged at its maximum until settled.
    expect((await atlasRunSpend(DB, "build", "b1", "acme")).outputTokens).toBe(9000);

    expect(await settleAtlasCall(DB, first.handle, { inputTokens: 1200, outputTokens: 1500 })).toBe(
      true,
    );
    expect(await settleAtlasCall(DB, first.handle, { inputTokens: 1, outputTokens: 1 })).toBe(
      false,
    );
    expect(await atlasRunSpend(DB, "build", "b1", "acme")).toEqual({
      calls: 1,
      inputTokens: 1200,
      outputTokens: 1500,
      usd: 1.5,
      exhausted: null,
    });
    expect((await atlasDailySpend(DB, "acme", { now: NOON })).usd).toBe(1.5);
    expect((await reserveAtlasCall(DB, call(build("r1", "b1"), 100, 8000), options)).status).toBe(
      "reserved",
    );
    expect(rows(sqlite, "SELECT status FROM atlas_spend ORDER BY created_at, status")).toEqual(
      expect.arrayContaining([{ status: "settled" }, { status: "reserved" }]),
    );
  });

  test("a count the provider didn't report stays charged at its reservation", async () => {
    const { DB } = await setup();
    const outcome = await runAtlasCall(
      DB,
      call(build("r1", "b1"), 400, 1000),
      async () => ({ value: 1, usage: { inputTokens: 120, outputTokens: undefined } }),
      { prices: DOLLAR_PER_K_OUT, now: NOON },
    );
    expect(outcome).toMatchObject({ usage: { inputTokens: 120, outputTokens: 1000 }, costUsd: 1 });
    expect(await atlasRunSpend(DB, "build", "b1", "acme")).toMatchObject({
      inputTokens: 120,
      outputTokens: 1000,
    });
  });

  test("a released reservation charges nothing and isn't counted as a call", async () => {
    const { DB } = await setup();
    const r = await reserveAtlasCall(DB, call(build("r1", "b1"), 100, 100), { prices: CHEAP });
    if (r.status !== "reserved") throw new Error("expected a reservation");
    expect(await releaseAtlasCall(DB, r.handle)).toBe(true);
    expect(await atlasRunSpend(DB, "build", "b1", "acme")).toMatchObject({ calls: 0, usd: 0 });
  });

  test("runAtlasCall settles a call, and keeps a failed one charged without retrying it", async () => {
    const { DB, sqlite } = await setup();
    const options = { prices: DOLLAR_PER_K_OUT, now: NOON };
    const done = await runAtlasCall(
      DB,
      call(build("r1", "b1"), 500, 1000),
      async () => ({ value: "Rate limiting", usage: { inputTokens: 300, outputTokens: 250 } }),
      options,
    );
    expect(done).toEqual({
      status: "done",
      value: "Rate limiting",
      usage: { inputTokens: 300, outputTokens: 250 },
      costUsd: 0.25,
    });

    let attempts = 0;
    await expect(
      runAtlasCall(
        DB,
        call(build("r1", "b1"), 500, 1000),
        async () => {
          attempts++;
          throw new Error("provider timed out");
        },
        options,
      ),
    ).rejects.toThrow("provider timed out");
    expect(attempts).toBe(1);
    expect(
      rows(sqlite, "SELECT status, cost_micro_usd AS cost FROM atlas_spend ORDER BY cost"),
    ).toEqual([
      { status: "settled", cost: 250_000 },
      { status: "failed", cost: 1_000_000 },
    ]);
  });
});

describe("pricing", () => {
  test("a model without a configured price disables Atlas paid synthesis", async () => {
    const { DB, sqlite } = await setup();
    let called = false;
    const outcome = await runAtlasCall(
      DB,
      call(build("r1", "b1"), 10, 10),
      async () => {
        called = true;
        return { value: null, usage: { inputTokens: 1, outputTokens: 1 } };
      },
      { prices: {} },
    );
    expect(outcome).toEqual({ status: "disabled", reason: "unpriced", model: MODEL });
    expect(called).toBe(false);
    expect(rows(sqlite, "SELECT * FROM atlas_spend")).toEqual([]);
    expect(rows(sqlite, "SELECT * FROM atlas_budget_exhaustions")).toEqual([]);
  });

  test("costs round up without floating-point overcharging", () => {
    // 1,000 in at $0.45/M + 100 out at $3.20/M = $0.00045 + $0.00032.
    expect(costMicroUsd({ input: 0.45, output: 3.2 }, 1000, 100)).toBe(770);
    expect(costMicroUsd({ input: 0.15, output: 0.5 }, 1, 1)).toBe(1);
    expect(estimateTokens("abcd")).toBe(18);
    expect(estimateTokens("é".repeat(10), "")).toBe(10 + 16 + 16);
  });
});

describe("attribution", () => {
  test("Atlas spend is recorded per scope and purpose, apart from upstream Knowledge tokens", async () => {
    const { DB, sqlite } = await setup();
    // Upstream Knowledge synthesis keeps its own accounting.
    sqlite.exec(
      `INSERT INTO kg_synthesis (key, data, model, tokens) VALUES ('component:x', '{}', 'm', 5000)`,
    );
    const options = { prices: CHEAP, now: NOON };
    await runAtlasCall(
      DB,
      { ...call(build("r1", "b1"), 100, 100), purpose: "capability_naming" },
      async () => ({ value: 1, usage: { inputTokens: 40, outputTokens: 20 } }),
      options,
    );
    await runAtlasCall(
      DB,
      call(grouping("acme", "p1"), 100, 100),
      async () => ({ value: 1, usage: { inputTokens: 70, outputTokens: 30 } }),
      options,
    );
    expect(await atlasRunSpend(DB, "build", "b1", "acme")).toMatchObject({
      calls: 1,
      inputTokens: 40,
      outputTokens: 20,
    });
    expect(await atlasRunSpend(DB, "grouping", "p1", "acme")).toMatchObject({
      calls: 1,
      inputTokens: 70,
    });
    expect(
      rows(
        sqlite,
        "SELECT scope, run_id, repo_id, space_id, purpose FROM atlas_spend ORDER BY scope",
      ),
    ).toEqual([
      {
        scope: "build",
        run_id: "b1",
        repo_id: "r1",
        space_id: "acme",
        purpose: "capability_naming",
      },
      {
        scope: "grouping",
        run_id: "p1",
        repo_id: null,
        space_id: "acme",
        purpose: "capability_summary",
      },
    ]);
  });

  test("an unknown repository is an error, not a free budget", async () => {
    const { DB } = await setup();
    await expect(
      reserveAtlasCall(DB, call(build("nope", "b1"), 1, 1), { prices: CHEAP }),
    ).rejects.toThrow("unknown repository");
  });
});

describe("explicit Space attribution", () => {
  test("same-organization Spaces isolate identical run IDs, caps, and exhaustion reports", async () => {
    const { DB } = await setup();
    const options = {
      prices: CHEAP,
      now: NOON,
      limits: { ...ATLAS_LIMITS, grouping: { ...ATLAS_LIMITS.grouping, calls: 1 } },
    };
    await reserveAtlasCall(DB, call(grouping("acme", "shared-run"), 10, 10), options);
    expect(
      await reserveAtlasCall(DB, call(grouping("acme", "shared-run"), 10, 10), options),
    ).toMatchObject({ status: "exhausted", spaceId: "acme", cap: "calls" });
    expect(await atlasRunSpend(DB, "grouping", "shared-run", "sibling")).toMatchObject({
      calls: 0,
      usd: 0,
      exhausted: null,
    });
    expect(
      await reserveAtlasCall(DB, call(grouping("sibling", "shared-run"), 20, 20), options),
    ).toMatchObject({ status: "reserved", handle: { spaceId: "sibling" } });
    expect(await atlasRunSpend(DB, "grouping", "shared-run", "sibling")).toMatchObject({
      calls: 1,
      inputTokens: 20,
      exhausted: null,
    });
    expect(await atlasRunSpend(DB, "grouping", "shared-run", "acme")).toMatchObject({
      calls: 1,
      inputTokens: 10,
      exhausted: { cap: "calls" },
    });
  });

  test("a person ID or Organization ID is never inferred to be a grouping Space", async () => {
    const { DB } = await setup();
    for (const id of ["person-ann", "company", "missing"])
      await expect(
        reserveAtlasCall(DB, call(grouping(id, "pass"), 1, 1), { prices: CHEAP }),
      ).rejects.toThrow("unknown or archived Space");
  });

  test("settlement and release bind the exact reservation Space", async () => {
    const { DB } = await setup();
    const reservation = await reserveAtlasCall(DB, call(build("r1", "b1"), 10, 10), {
      prices: CHEAP,
    });
    if (reservation.status !== "reserved") throw new Error("expected a reservation");
    const wrongSpace = { ...reservation.handle, spaceId: "sibling" };
    expect(await settleAtlasCall(DB, wrongSpace, { inputTokens: 1, outputTokens: 1 })).toBe(false);
    expect(await releaseAtlasCall(DB, wrongSpace)).toBe(false);
    expect(await settleAtlasCall(DB, reservation.handle, { inputTokens: 1, outputTokens: 1 })).toBe(
      true,
    );
  });

  test("archived grouping Spaces cannot reserve paid work", async () => {
    const { DB, sqlite } = await setup();
    sqlite.exec("UPDATE spaces SET archived_at = '2026-10-03T00:00:00Z' WHERE id = 'sibling'");
    await expect(
      reserveAtlasCall(DB, call(grouping("sibling", "pass"), 1, 1), { prices: CHEAP }),
    ).rejects.toThrow("unknown or archived Space");
  });

  test("provider policy resolves the Space slug rather than the person's slug", async () => {
    const { DB } = await setup();
    const env = {
      DB,
      ATLAS_CONFIG: JSON.stringify({
        spaces: { ann: { prices: {} }, "ann-notes": { model: MODEL } },
      }),
    } as unknown as Env;
    expect(await atlasSettings(env, "r3")).toMatchObject({
      model: MODEL,
      prices: ATLAS_PRICES,
      source: "space",
    });
    await expect(atlasSettings(env, "missing")).rejects.toThrow("unknown repository");
  });
});

describe("configuration", () => {
  const CONFIG = JSON.stringify({
    limits: { dailyUsdPerSpace: 5 },
    spaces: {
      Acme: { model: MODEL, prices: CHEAP, limits: { build: { calls: 1 } } },
      "ann-notes": { prices: {} },
    },
  });

  test("without ATLAS_CONFIG a build runs with the built-in model, prices and caps", async () => {
    const { DB } = await setup();
    expect(await atlasSettings({ DB } as unknown as Env, "r1")).toEqual({
      model: MODELS.reason,
      prices: ATLAS_PRICES,
      limits: ATLAS_LIMITS,
      source: "default",
    });
  });

  test("selected task model sets the budget price and survives cap-only overrides", async () => {
    const { DB } = await setup();
    const model = "@cf/google/gemma-4-26b-a4b-it";
    const settings = await atlasSettings(
      { DB, ATLAS_CONFIG: JSON.stringify({ limits: { build: { calls: 1 } } }) } as unknown as Env,
      "r1",
      model,
    );
    expect(settings.model).toBe(model);
    const request = { ...call(build("r1", "selected-task"), 1000, 100), model: settings.model };
    const reservation = await reserveAtlasCall(DB, request, settings);
    expect(reservation).toMatchObject({
      status: "reserved",
      handle: { model, price: { input: 0.1, output: 0.3 }, reservedUsd: 0.00013 },
    });
    expect(await reserveAtlasCall(DB, request, settings)).toMatchObject({
      status: "exhausted",
      cap: "calls",
    });
  });

  test("development model overrides still take precedence over the selected task", async () => {
    const { DB } = await setup();
    const selected = "@cf/google/gemma-4-26b-a4b-it";
    const config = JSON.stringify({
      model: MODELS.fast,
      spaces: { acme: { model: MODEL, prices: CHEAP } },
    });
    const env = { DB, ATLAS_CONFIG: config } as unknown as Env;
    expect((await atlasSettings(env, "r1", selected)).model).toBe(MODEL);
    expect((await atlasSettings(env, "r3", selected)).model).toBe(MODELS.fast);
    expect((await atlasSettings({ DB } as unknown as Env, "r1", selected)).model).toBe(selected);
  });

  test("the owning Space's entry overrides the environment's, cap by cap", async () => {
    const { DB } = await setup();
    const env = { DB, ATLAS_CONFIG: CONFIG } as unknown as Env;
    const acme = await atlasSettings(env, "r2");
    expect(acme).toEqual({
      model: MODEL,
      prices: CHEAP,
      limits: {
        build: { ...ATLAS_LIMITS.build, calls: 1 },
        grouping: ATLAS_LIMITS.grouping,
        dailyUsdPerSpace: 5,
      },
      source: "space",
    });
    // ann's empty price table leaves the default model unpriced: disabled.
    const ann = await atlasSettings(env, "r3");
    expect(ann).toMatchObject({ model: MODELS.reason, prices: {}, source: "space" });
    expect(
      await reserveAtlasCall(DB, { ...call(build("r3", "b1"), 10, 10), model: ann.model }, ann),
    ).toEqual({ status: "disabled", reason: "unpriced", model: MODELS.reason });
    // A Space without an entry gets the environment's settings.
    expect(resolveAtlasSettings(parseAtlasConfig(CONFIG), "zed")).toMatchObject({
      model: MODELS.reason,
      source: "configured",
      limits: { dailyUsdPerSpace: 5 },
    });
  });

  test("configured caps are enforced like the built-in ones", async () => {
    const { DB } = await setup();
    const acme = await atlasSettings({ DB, ATLAS_CONFIG: CONFIG } as unknown as Env, "r1");
    const first = await reserveAtlasCall(DB, call(build("r1", "b1"), 10, 10), acme);
    expect(first.status).toBe("reserved");
    expect(await reserveAtlasCall(DB, call(build("r1", "b1"), 10, 10), acme)).toMatchObject({
      status: "exhausted",
      cap: "calls",
      resetsAt: null,
    });
    // The next build starts fresh, under the same one-call cap.
    expect((await reserveAtlasCall(DB, call(build("r1", "b2"), 10, 10), acme)).status).toBe(
      "reserved",
    );
    expect((await atlasDailySpend(DB, "acme", acme)).limitUsd).toBe(5);
  });

  test("a malformed configuration is an error, never a silent default", () => {
    expect(parseAtlasConfig(undefined)).toBeNull();
    expect(() => parseAtlasConfig("{")).toThrow("not valid JSON");
    expect(() => parseAtlasConfig('{"limits":{"build":{"calls":-1}}}')).toThrow(
      "limits.build.calls",
    );
    expect(() => parseAtlasConfig('{"spaces":{"a":{"prices":{"m":{"input":"1"}}}}}')).toThrow(
      "spaces.a.prices.m.input",
    );
    expect(() => parseAtlasConfig('{"model":""}')).toThrow("config.model");
    expect(() => parseAtlasConfig('{"accounts":{"ann":{"prices":{}}}}')).toThrow(
      "accounts is obsolete",
    );
    expect(() => parseAtlasConfig('{"limits":{"dailyUsdPerAccount":5}}')).toThrow(
      "dailyUsdPerAccount is obsolete",
    );
  });
});
