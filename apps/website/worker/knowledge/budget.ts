// Atlas paid-synthesis budgets (CORE-162; the CORE-155 PRD's "bounded
// operation"). Every model call the Semantic Code Atlas adds goes through
// here; upstream Knowledge inference (analysis cards, synthesis, concepts,
// wiki), release notes and the assistant never do, so their costs stay
// attributed where they are today (kg_synthesis, build stats `tokens`).
//
// Integration: wrap each Atlas call in `runAtlasCall` (or reserve, call, then
// settle/fail/release yourself). A call is reserved *before* it runs at its
// maximum cost (input estimate + max output tokens, uncached input price) and
// reconciled to the provider's reported usage after:
//
//   const outcome = await runAtlasCall(env.DB, {
//     scope: { kind: "build", repoId, buildId },
//     purpose: "capability_summary",
//     model: MODELS.reason,
//     maxInputTokens: estimateTokens(system, user),
//     maxOutputTokens: 800,
//   }, async () => {
//     const { value, usage } = await chatJson(env, "reason", system, user,
//       { maxTokens: 800, attempts: 1 });
//     return { value, usage };
//   });
//   if (outcome.status !== "done") → keep structure, label summaries
//     unavailable/stale and surface `outcome` (exhausted cap, resetsAt) or
//     "disabled" (no configured price).
//
// Caps: a repository build's Atlas calls, an account grouping pass's calls,
// and a shared daily ceiling per *owning* account (the repository owner, not
// the principal or scope that asked), so no scope or viewer can evade it. The
// first cap a reservation runs into is recorded and stops that run (and, for
// the ceiling, the account until UTC midnight): no automatic paid retries.
// A model without a configured price disables Atlas paid synthesis.
//
// Each reservation is one guarded INSERT … SELECT: D1 runs statements one at
// a time, so the check and the charge are atomic under concurrent callers.
//
// Budgets never authorize inference while browsing: only build-time and
// grouping-pass code may import this module.

import type { Insertable } from "kysely";
import { AI_MODEL_CATALOG } from "../../shared/ai.ts";
import { MODELS } from "./models.ts";
import { modelMetric } from "../usage/pages.ts";
import { seedPrice } from "../usage/seed.ts";
import { db, nowIso, type Database } from "../schema.ts";

export interface RunLimits {
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AtlasLimits {
  build: RunLimits;
  grouping: RunLimits;
  /** Shared by every repository, scope and principal of one owning account. */
  dailyUsdPerAccount: number;
}

/** Per-run caps and the daily ceiling, from the CORE-155 PRD. */
export const ATLAS_LIMITS: Readonly<AtlasLimits> = {
  build: { calls: 20, inputTokens: 100_000, outputTokens: 10_000 },
  grouping: { calls: 10, inputTokens: 50_000, outputTokens: 5_000 },
  dailyUsdPerAccount: 10,
};

export interface ModelPrice {
  /** USD per million input tokens (uncached: reservations stay conservative). */
  input: number;
  /** USD per million output tokens. */
  output: number;
}
export type PriceTable = Readonly<Record<string, ModelPrice>>;

/** A Workers AI model's USD per million input and output tokens, from the price catalog's seed. */
function modelPrice(model: string): ModelPrice {
  const perMillion = (metric: "input" | "output") => {
    const price = seedPrice("workers_ai", modelMetric(model, metric));
    if (price.unit !== "token") throw new Error(`${model} ${metric} isn't priced per token`);
    return price.unitQuantity === 1_000_000
      ? price.unitPriceUsd
      : (price.unitPriceUsd * 1_000_000) / price.unitQuantity;
  };
  return { input: perMillion("input"), output: perMillion("output") };
}

/**
 * Provider prices Atlas may spend at, per model id: Workers AI's published
 * prices from the Cloudflare price catalog's seed (worker/usage/seed.ts, the
 * one place they are written down), for every configurable task model, and
 * legacy Qwen for already running jobs. A model missing here cannot be used
 * for Atlas paid synthesis (reservations return `disabled`).
 */
export const ATLAS_PRICES: PriceTable = {
  ...Object.fromEntries(
    AI_MODEL_CATALOG.task.map((option) => [option.model, modelPrice(option.model)]),
  ),
  [MODELS.reason]: modelPrice(MODELS.reason),
};

export type AtlasScope =
  /** A repository's Knowledge build: the account is the repository's owner. */
  | { kind: "build"; repoId: string; buildId: string }
  /** An account grouping pass across that account's repositories. */
  | { kind: "grouping"; accountId: string; passId: string };

export interface AtlasCallRequest {
  scope: AtlasScope;
  /** What the call is for, recorded for attribution, e.g. `capability_summary`. */
  purpose: string;
  model: string;
  /** An upper bound on the prompt's tokens (see `estimateTokens`). */
  maxInputTokens: number;
  /** The `max_tokens` the call is made with. */
  maxOutputTokens: number;
}

export type AtlasCap = "daily_usd" | "calls" | "input_tokens" | "output_tokens";

/** What a caller keeps between reserving and settling; plain JSON (workflow steps can return it). */
export interface AtlasSpendHandle {
  id: string;
  accountId: string;
  day: string;
  model: string;
  price: ModelPrice;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  reservedUsd: number;
}

export interface AtlasExhausted {
  status: "exhausted";
  cap: AtlasCap;
  accountId: string;
  exhaustedAt: string;
  /** Next UTC midnight for the daily ceiling; null for a run cap (the next run starts fresh). */
  resetsAt: string | null;
}

export interface AtlasDisabled {
  status: "disabled";
  reason: "unpriced";
  model: string;
}

export type AtlasReservation =
  | { status: "reserved"; handle: AtlasSpendHandle }
  | AtlasExhausted
  | AtlasDisabled;

export interface AtlasUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What the provider reported; a count it didn't report stays charged at its reservation. */
export type ReportedUsage = { inputTokens?: number | undefined; outputTokens?: number | undefined };

export interface BudgetOptions {
  /** The clock (tests move it across midnight). */
  now?: Date;
  /** The price table (tests and configured accounts use their own; else ATLAS_PRICES). */
  prices?: PriceTable;
  /** The caps (configured accounts may set their own; else ATLAS_LIMITS). */
  limits?: Readonly<AtlasLimits>;
}

const MICRO = 1_000_000;

/** USD in millionths, rounded up: tokens × USD per million tokens. */
export function costMicroUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  // Round off float noise (0.45 × 1000 = 450.00000000000006) before rounding up.
  const exact = inputTokens * price.input + outputTokens * price.output;
  return Math.ceil(Math.round(exact * 1000) / 1000);
}

/**
 * A conservative token bound for prompt text: half a token per UTF-8 byte
 * (tokenizers average 3-4 bytes per token on code and English), plus a little
 * per message for the chat template.
 */
export function estimateTokens(...texts: string[]): number {
  const encoder = new TextEncoder();
  return texts.reduce((sum, text) => sum + Math.ceil(encoder.encode(text).length / 2) + 16, 0);
}

const utcDay = (now: Date) => now.toISOString().slice(0, 10);

function nextUtcMidnight(now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return next.toISOString();
}

const tokens = (n: number) => {
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`Invalid token count: ${n}`);
  return Math.ceil(n);
};

interface ResolvedScope {
  accountId: string;
  scope: "build" | "grouping";
  runId: string;
  repoId: string | null;
}

async function resolveScope(d1: D1Database, scope: AtlasScope): Promise<ResolvedScope> {
  if (scope.kind === "grouping")
    return { accountId: scope.accountId, scope: "grouping", runId: scope.passId, repoId: null };
  // Budgets follow the repository's owner, never whoever is asking.
  const repo = await db(d1)
    .selectFrom("repos")
    .select("owner_id")
    .where("id", "=", scope.repoId)
    .executeTakeFirst();
  if (!repo) throw new Error(`Atlas budget: unknown repository ${scope.repoId}`);
  return { accountId: repo.owner_id, scope: "build", runId: scope.buildId, repoId: scope.repoId };
}

const runKey = (r: ResolvedScope) => `${r.scope}:${r.accountId}:${r.runId}`;
const dayKey = (accountId: string, day: string) => `day:${accountId}:${day}`;

/**
 * Reserve one Atlas model call before making it. `reserved` carries the handle
 * to settle; `exhausted` names the first cap reached (recorded, so the run, or
 * for the ceiling the account until `resetsAt`, does no more paid work);
 * `disabled` means the model has no configured price.
 */
export async function reserveAtlasCall(
  d1: D1Database,
  request: AtlasCallRequest,
  options: BudgetOptions = {},
): Promise<AtlasReservation> {
  const price = (options.prices ?? ATLAS_PRICES)[request.model];
  if (!price) return { status: "disabled", reason: "unpriced", model: request.model };
  const now = options.now ?? new Date();
  const day = utcDay(now);
  const inputTokens = tokens(request.maxInputTokens);
  const outputTokens = tokens(request.maxOutputTokens);
  const cost = costMicroUsd(price, inputTokens, outputTokens);
  const run = await resolveScope(d1, request.scope);
  const caps = options.limits ?? ATLAS_LIMITS;
  const limits = caps[run.scope];
  const dailyMicroUsd = caps.dailyUsdPerAccount * MICRO;

  for (let attempt = 0; attempt < 5; attempt++) {
    const id = crypto.randomUUID();
    const at = now.toISOString();
    // One statement checks every cap and charges the call, atomically.
    const inserted = await d1
      .prepare(
        `INSERT INTO atlas_spend (id, account_id, day, scope, run_id, repo_id, purpose, model, status,
           input_tokens, output_tokens, cost_micro_usd,
           reserved_input_tokens, reserved_output_tokens, reserved_micro_usd, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'reserved', ?9, ?10, ?11, ?9, ?10, ?11, ?12
         WHERE NOT EXISTS (SELECT 1 FROM atlas_budget_exhaustions WHERE key IN (?13, ?14))
           AND (SELECT COALESCE(SUM(cost_micro_usd), 0) FROM atlas_spend
                 WHERE account_id = ?2 AND day = ?3) + ?11 <= ?15
           AND (SELECT COUNT(*) FROM atlas_spend
                 WHERE scope = ?4 AND run_id = ?5 AND account_id = ?2 AND status <> 'released') < ?16
           AND (SELECT COALESCE(SUM(input_tokens), 0) FROM atlas_spend
                 WHERE scope = ?4 AND run_id = ?5 AND account_id = ?2) + ?9 <= ?17
           AND (SELECT COALESCE(SUM(output_tokens), 0) FROM atlas_spend
                 WHERE scope = ?4 AND run_id = ?5 AND account_id = ?2) + ?10 <= ?18`,
      )
      .bind(
        id,
        run.accountId,
        day,
        run.scope,
        run.runId,
        run.repoId,
        request.purpose,
        request.model,
        inputTokens,
        outputTokens,
        cost,
        at,
        runKey(run),
        dayKey(run.accountId, day),
        dailyMicroUsd,
        limits.calls,
        limits.inputTokens,
        limits.outputTokens,
      )
      .run();
    if (inserted.meta.changes === 1)
      return {
        status: "reserved",
        handle: {
          id,
          accountId: run.accountId,
          day,
          model: request.model,
          price,
          reservedInputTokens: inputTokens,
          reservedOutputTokens: outputTokens,
          reservedUsd: cost / MICRO,
        },
      };
    const exhausted = await recordExhaustion(d1, run, day, now, caps, {
      calls: 1,
      inputTokens,
      outputTokens,
      cost,
    });
    if (exhausted) return exhausted;
    // Nothing is over any more (a concurrent call was released): try again.
  }
  throw new Error("Atlas budget: reservation kept racing; giving up");
}

/**
 * After a refused reservation: find the cap it ran into and record it (the
 * first recorded one wins). Null if no cap is reached any more.
 */
async function recordExhaustion(
  d1: D1Database,
  run: ResolvedScope,
  day: string,
  now: Date,
  caps: Readonly<AtlasLimits>,
  wanted: { calls: number; inputTokens: number; outputTokens: number; cost: number },
): Promise<AtlasExhausted | null> {
  const k = db(d1);
  const recorded = () =>
    k
      .selectFrom("atlas_budget_exhaustions")
      .selectAll()
      .where("key", "in", [runKey(run), dayKey(run.accountId, day)])
      .orderBy("exhausted_at")
      .execute();
  const existing = await recorded();
  const own = existing.find((e) => e.key === runKey(run));
  if (own) return asExhausted(own);
  const ceiling = existing.find((e) => e.key === dayKey(run.accountId, day));
  if (ceiling) {
    // The account's ceiling stopped this run too: say so in the run's record.
    await insertExhaustions(d1, [
      { ...ceiling, key: runKey(run), scope: run.scope, run_id: run.runId },
    ]);
    return asExhausted(ceiling);
  }

  const [runTotals, dayTotals] = await Promise.all([
    k
      .selectFrom("atlas_spend")
      .select((eb) => [
        eb.fn.countAll<number>().as("calls"),
        eb.fn.coalesce(eb.fn.sum<number>("input_tokens"), eb.lit(0)).as("input"),
        eb.fn.coalesce(eb.fn.sum<number>("output_tokens"), eb.lit(0)).as("output"),
      ])
      .where("scope", "=", run.scope)
      .where("run_id", "=", run.runId)
      .where("account_id", "=", run.accountId)
      .where("status", "<>", "released")
      .executeTakeFirstOrThrow(),
    k
      .selectFrom("atlas_spend")
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("cost_micro_usd"), eb.lit(0)).as("cost"))
      .where("account_id", "=", run.accountId)
      .where("day", "=", day)
      .executeTakeFirstOrThrow(),
  ]);
  const limits = caps[run.scope];
  // A run's own caps first: they stop only that run.
  const cap: AtlasCap | null =
    Number(runTotals.calls) + wanted.calls > limits.calls
      ? "calls"
      : Number(runTotals.input) + wanted.inputTokens > limits.inputTokens
        ? "input_tokens"
        : Number(runTotals.output) + wanted.outputTokens > limits.outputTokens
          ? "output_tokens"
          : Number(dayTotals.cost) + wanted.cost > caps.dailyUsdPerAccount * MICRO
            ? "daily_usd"
            : null;
  if (!cap) return null;

  const at = now.toISOString();
  const resetsAt = cap === "daily_usd" ? nextUtcMidnight(now) : null;
  const record = { account_id: run.accountId, day, cap, exhausted_at: at, resets_at: resetsAt };
  await insertExhaustions(d1, [
    { ...record, key: runKey(run), scope: run.scope, run_id: run.runId },
    ...(cap === "daily_usd"
      ? [{ ...record, key: dayKey(run.accountId, day), scope: "day" as const, run_id: null }]
      : []),
  ]);
  const stored = (await recorded()).find((e) => e.key === runKey(run));
  return stored ? asExhausted(stored) : null;
}

/** Record exhaustions; the first record for a key wins. */
async function insertExhaustions(
  d1: D1Database,
  rows: Insertable<Database["atlas_budget_exhaustions"]>[],
) {
  await db(d1)
    .insertInto("atlas_budget_exhaustions")
    .values(rows)
    .onConflict((oc) => oc.column("key").doNothing())
    .execute();
}

function asExhausted(row: {
  cap: AtlasCap;
  account_id: string;
  exhausted_at: string;
  resets_at: string | null;
}): AtlasExhausted {
  return {
    status: "exhausted",
    cap: row.cap,
    accountId: row.account_id,
    exhaustedAt: row.exhausted_at,
    resetsAt: row.resets_at,
  };
}

/** The usage a call is charged for: what was reported, else its reservation. */
export function chargedUsage(handle: AtlasSpendHandle, reported: ReportedUsage): AtlasUsage {
  return {
    inputTokens: tokens(reported.inputTokens ?? handle.reservedInputTokens),
    outputTokens: tokens(reported.outputTokens ?? handle.reservedOutputTokens),
  };
}

/**
 * Reconcile a reserved call to the provider's reported usage (a count it
 * didn't report stays at its reservation). Returns false if it was already
 * settled, failed or released (settling is idempotent).
 */
export async function settleAtlasCall(
  d1: D1Database,
  handle: AtlasSpendHandle,
  usage: ReportedUsage,
): Promise<boolean> {
  const { inputTokens, outputTokens } = chargedUsage(handle, usage);
  const result = await db(d1)
    .updateTable("atlas_spend")
    .set({
      status: "settled",
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_micro_usd: costMicroUsd(handle.price, inputTokens, outputTokens),
      settled_at: nowIso(),
    })
    .where("id", "=", handle.id)
    .where("status", "=", "reserved")
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

/**
 * The call failed after it may have reached the provider: keep it charged at
 * its reservation (it may have been billed). Never retried automatically.
 */
export async function failAtlasCall(d1: D1Database, handle: AtlasSpendHandle): Promise<boolean> {
  const result = await db(d1)
    .updateTable("atlas_spend")
    .set({ status: "failed", settled_at: nowIso() })
    .where("id", "=", handle.id)
    .where("status", "=", "reserved")
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

/** The call was never made: give its reservation back. */
export async function releaseAtlasCall(d1: D1Database, handle: AtlasSpendHandle): Promise<boolean> {
  const result = await db(d1)
    .updateTable("atlas_spend")
    .set({
      status: "released",
      input_tokens: 0,
      output_tokens: 0,
      cost_micro_usd: 0,
      settled_at: nowIso(),
    })
    .where("id", "=", handle.id)
    .where("status", "=", "reserved")
    .executeTakeFirst();
  return Number(result.numUpdatedRows) === 1;
}

export type AtlasCallOutcome<T> =
  | { status: "done"; value: T; usage: AtlasUsage; costUsd: number }
  | AtlasExhausted
  | AtlasDisabled;

/**
 * Reserve, make the call once, and reconcile. A throwing call stays charged at
 * its reservation and the error propagates; it is not retried.
 */
export async function runAtlasCall<T>(
  d1: D1Database,
  request: AtlasCallRequest,
  call: (handle: AtlasSpendHandle) => Promise<{ value: T; usage: ReportedUsage }>,
  options: BudgetOptions = {},
): Promise<AtlasCallOutcome<T>> {
  const reservation = await reserveAtlasCall(d1, request, options);
  if (reservation.status !== "reserved") return reservation;
  const { handle } = reservation;
  let result: { value: T; usage: ReportedUsage };
  try {
    result = await call(handle);
  } catch (error) {
    await failAtlasCall(d1, handle);
    throw error;
  }
  await settleAtlasCall(d1, handle, result.usage);
  const usage = chargedUsage(handle, result.usage);
  return {
    status: "done",
    value: result.value,
    usage,
    costUsd: costMicroUsd(handle.price, usage.inputTokens, usage.outputTokens) / MICRO,
  };
}

/** Atlas spend of one run, for build stats and the user-visible budget state. */
export interface AtlasRunSpend {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  /** The cap that stopped the run's paid work, if one did. */
  exhausted: { cap: AtlasCap; at: string; resetsAt: string | null } | null;
}

/** What a build's (or grouping pass's) Atlas calls spent, kept apart from upstream Knowledge tokens. */
export async function atlasRunSpend(
  d1: D1Database,
  scope: "build" | "grouping",
  runId: string,
): Promise<AtlasRunSpend> {
  const k = db(d1);
  const [totals, exhaustion] = await Promise.all([
    k
      .selectFrom("atlas_spend")
      .select((eb) => [
        eb.fn.countAll<number>().as("calls"),
        eb.fn.coalesce(eb.fn.sum<number>("input_tokens"), eb.lit(0)).as("input"),
        eb.fn.coalesce(eb.fn.sum<number>("output_tokens"), eb.lit(0)).as("output"),
        eb.fn.coalesce(eb.fn.sum<number>("cost_micro_usd"), eb.lit(0)).as("cost"),
      ])
      .where("scope", "=", scope)
      .where("run_id", "=", runId)
      .where("status", "<>", "released")
      .executeTakeFirstOrThrow(),
    k
      .selectFrom("atlas_budget_exhaustions")
      .select(["cap", "exhausted_at", "resets_at"])
      .where("scope", "=", scope)
      .where("run_id", "=", runId)
      .orderBy("exhausted_at")
      .executeTakeFirst(),
  ]);
  return {
    calls: Number(totals.calls),
    inputTokens: Number(totals.input),
    outputTokens: Number(totals.output),
    usd: Number(totals.cost) / MICRO,
    exhausted: exhaustion
      ? { cap: exhaustion.cap, at: exhaustion.exhausted_at, resetsAt: exhaustion.resets_at }
      : null,
  };
}

/** An account's Atlas spend for one UTC day against its ceiling. */
export async function atlasDailySpend(
  d1: D1Database,
  accountId: string,
  options: { now?: Date; limits?: Readonly<AtlasLimits> } = {},
): Promise<{ day: string; usd: number; limitUsd: number; resetsAt: string; exhausted: boolean }> {
  const now = options.now ?? new Date();
  const day = utcDay(now);
  const k = db(d1);
  const [spent, exhaustion] = await Promise.all([
    k
      .selectFrom("atlas_spend")
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("cost_micro_usd"), eb.lit(0)).as("cost"))
      .where("account_id", "=", accountId)
      .where("day", "=", day)
      .executeTakeFirstOrThrow(),
    k
      .selectFrom("atlas_budget_exhaustions")
      .select("key")
      .where("key", "=", dayKey(accountId, day))
      .executeTakeFirst(),
  ]);
  return {
    day,
    usd: Number(spent.cost) / MICRO,
    limitUsd: (options.limits ?? ATLAS_LIMITS).dailyUsdPerAccount,
    resetsAt: nextUtcMidnight(now),
    exhausted: Boolean(exhaustion),
  };
}

/**
 * A runner for one scope's Atlas calls (the `AtlasInfer` that
 * atlas/describe.ts takes): reserve the call at its prompt's estimated size
 * and its output cap, make it once, and reconcile (see `runAtlasCall`).
 */
export function atlasInfer(d1: D1Database, scope: AtlasScope, options: BudgetOptions = {}) {
  return <T>(
    request: { purpose: string; model: string; prompt: string[]; maxOutputTokens: number },
    call: () => Promise<{ value: T; usage: ReportedUsage }>,
  ): Promise<AtlasCallOutcome<T>> =>
    runAtlasCall(
      d1,
      {
        scope,
        purpose: request.purpose,
        model: request.model,
        maxInputTokens: estimateTokens(...request.prompt),
        maxOutputTokens: request.maxOutputTokens,
      },
      () => call(),
      options,
    );
}

// ---- configuration --------------------------------------------------------------
//
// What a build's Atlas calls run with: the model that writes capability prose,
// the prices it may spend at and the caps, for the repository's owning account.
// Deployed, the selected Task model uses ATLAS_PRICES and ATLAS_LIMITS.
// An environment can override them with the ATLAS_CONFIG text binding
// (only development environments declare it, cloudflare.config.ts):
//
//   { "model"?, "prices"?, "limits"?,            the environment's defaults
//     "accounts"?: { "<owner slug>": { … } } }  per owning account, over them
//
// `prices` replaces the table (an empty one leaves every model unpriced, so
// paid synthesis is disabled); `limits` overrides only the caps it names.
// The live provider verification (tools/agent/provider-e2e.ts) runs one
// account with Atlas disabled, one whose model the provider refuses and one
// with a one-call build cap through exactly this, against the real provider.

export interface AtlasConfigEntry {
  model?: string;
  prices?: Record<string, ModelPrice>;
  limits?: {
    build?: Partial<RunLimits>;
    grouping?: Partial<RunLimits>;
    dailyUsdPerAccount?: number;
  };
}

export interface AtlasConfig extends AtlasConfigEntry {
  accounts?: Record<string, AtlasConfigEntry>;
}

export interface AtlasSettings {
  model: string;
  prices: PriceTable;
  limits: Readonly<AtlasLimits>;
  /** Built-in defaults, the environment's configuration, or its entry for the owning account. */
  source: "default" | "configured" | "account";
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const amount = (v: unknown, where: string): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new Error(`ATLAS_CONFIG: ${where} must be a non-negative number`);
  return v;
};

function parseEntry(raw: unknown, where: string): AtlasConfigEntry {
  if (!isRecord(raw)) throw new Error(`ATLAS_CONFIG: ${where} must be an object`);
  const entry: AtlasConfigEntry = {};
  if (raw.model !== undefined) {
    if (typeof raw.model !== "string" || !raw.model)
      throw new Error(`ATLAS_CONFIG: ${where}.model must be a model id`);
    entry.model = raw.model;
  }
  if (raw.prices !== undefined) {
    if (!isRecord(raw.prices)) throw new Error(`ATLAS_CONFIG: ${where}.prices must be an object`);
    entry.prices = {};
    for (const [model, price] of Object.entries(raw.prices)) {
      if (!isRecord(price))
        throw new Error(`ATLAS_CONFIG: ${where}.prices.${model} must be an object`);
      entry.prices[model] = {
        input: amount(price.input, `${where}.prices.${model}.input`),
        output: amount(price.output, `${where}.prices.${model}.output`),
      };
    }
  }
  if (raw.limits !== undefined) {
    if (!isRecord(raw.limits)) throw new Error(`ATLAS_CONFIG: ${where}.limits must be an object`);
    const limits: NonNullable<AtlasConfigEntry["limits"]> = {};
    for (const scope of ["build", "grouping"] as const) {
      const run = raw.limits[scope];
      if (run === undefined) continue;
      if (!isRecord(run))
        throw new Error(`ATLAS_CONFIG: ${where}.limits.${scope} must be an object`);
      limits[scope] = {};
      for (const cap of ["calls", "inputTokens", "outputTokens"] as const)
        if (run[cap] !== undefined)
          limits[scope][cap] = amount(run[cap], `${where}.limits.${scope}.${cap}`);
    }
    if (raw.limits.dailyUsdPerAccount !== undefined)
      limits.dailyUsdPerAccount = amount(
        raw.limits.dailyUsdPerAccount,
        `${where}.limits.dailyUsdPerAccount`,
      );
    entry.limits = limits;
  }
  return entry;
}

/** Parse ATLAS_CONFIG; null when it isn't set. Throws on a malformed one (never silently default). */
export function parseAtlasConfig(raw: unknown): AtlasConfig | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") throw new Error("ATLAS_CONFIG must be JSON text");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("ATLAS_CONFIG is not valid JSON");
  }
  const config: AtlasConfig = parseEntry(json, "config");
  const accounts = (json as Record<string, unknown>).accounts;
  if (accounts !== undefined) {
    if (!isRecord(accounts)) throw new Error("ATLAS_CONFIG: accounts must be an object");
    config.accounts = {};
    for (const [slug, entry] of Object.entries(accounts))
      config.accounts[slug.toLowerCase()] = parseEntry(entry, `accounts.${slug}`);
  }
  return config;
}

function apply(base: AtlasSettings, entry: AtlasConfigEntry): Omit<AtlasSettings, "source"> {
  const run = (scope: "build" | "grouping"): RunLimits => ({
    ...base.limits[scope],
    ...entry.limits?.[scope],
  });
  return {
    model: entry.model ?? base.model,
    prices: entry.prices ?? base.prices,
    limits: {
      build: run("build"),
      grouping: run("grouping"),
      dailyUsdPerAccount: entry.limits?.dailyUsdPerAccount ?? base.limits.dailyUsdPerAccount,
    },
  };
}

/** The settings for one owning account (its slug), under a parsed configuration. */
export function resolveAtlasSettings(
  config: AtlasConfig | null,
  accountSlug: string | null,
  taskModel: string = MODELS.reason,
): AtlasSettings {
  let settings: AtlasSettings = {
    model: taskModel,
    prices: ATLAS_PRICES,
    limits: ATLAS_LIMITS,
    source: "default",
  };
  if (!config) return settings;
  if (config.model !== undefined || config.prices !== undefined || config.limits !== undefined)
    settings = { ...apply(settings, config), source: "configured" };
  const own = accountSlug ? config.accounts?.[accountSlug.toLowerCase()] : undefined;
  return own ? { ...apply(settings, own), source: "account" } : settings;
}

/** What a build of `repoId` runs its Atlas calls with (its owning account's settings). */
export async function atlasSettings(
  env: Env,
  repoId: string,
  taskModel: string = MODELS.reason,
): Promise<AtlasSettings> {
  const config = parseAtlasConfig(Reflect.get(env, "ATLAS_CONFIG"));
  if (!config) return resolveAtlasSettings(null, null, taskModel);
  const owner = config.accounts
    ? await db(env.DB)
        .selectFrom("repos")
        .innerJoin("accounts", "accounts.id", "repos.owner_id")
        .select("accounts.slug")
        .where("repos.id", "=", repoId)
        .executeTakeFirst()
    : undefined;
  return resolveAtlasSettings(config, owner?.slug ?? null, taskModel);
}
