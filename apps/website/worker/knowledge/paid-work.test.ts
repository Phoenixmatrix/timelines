// Paid inference that is attributed, metered and stoppable (CORE-285):
// a Workflow step's model calls record for the repository's Space even though
// the runtime calls step callbacks outside the context `run` set up; every
// attempt, failed or not, is metered the way the AI Gateway logs it; a build
// the watchdog stopped, a failed step and a timed-out attempt stop spending.

import { afterEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import type { DatabaseSync } from "node:sqlite";
import type { WorkflowStep } from "cloudflare:workers";
import { d1 } from "../testing/d1.ts";
import { fakeRemotes } from "../testing/remote.ts";
import { aiWork } from "../usage/ai.ts";
import { buildStopped } from "./build.ts";
import { KnowledgeCoordinator } from "./coordinator.ts";
import { parseModelFailureDiagnostic } from "./model-failure.ts";
import { chatJson, chatText, decide, MODELS } from "./models.ts";
import { paidSteps, timeoutMs } from "./paid-steps.ts";
import { paidWork, PaidWorkStopped } from "./paid-work.ts";
import { pool } from "./util.ts";
import { seedSpaceFixture, createFreshSpaceTestEnvironment } from "../testing/spaces.ts";
import { issueToken } from "../api/tokens.ts";
import { captureWorkAuthority } from "../ci/admission.ts";

vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {
    constructor(message: string, name = "NonRetryableError") {
      super(message);
      this.name = name;
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const QUESTION = { same: { type: "noul" as const, instructions: "Same?" } };
const ANSWER = { answers: { same: { type: "noul", noul: 0.9 } }, usage: { prompt_tokens: 40 } };

interface Call {
  model: string;
  options: AiOptions;
}

/** A database with one repository, and a Workers AI fake that logs each call like the gateway. */
async function setup(answer: (call: Call) => Promise<unknown> = async () => ANSWER) {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite } = fresh;
  onTestFinished(fresh.close);
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('person', 'user', 'person', 'Person');
  `);
  await seedSpaceFixture(d1(sqlite), {
    organization: { id: "org", slug: "orbit", displayName: "Orbit", kind: "company" },
    space: { id: "acc_o", slug: "orbit", displayName: "General" },
    actorId: "person",
    members: [
      {
        accountId: "person",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'acc_o', 'app', 'private', 'n', 'https://app');
    INSERT INTO kg_builds (id, repo_id, to_commit, status) VALUES ('b1', 'repo', 'c', 'running');
  `);
  const calls: Call[] = [];
  const env = {
    ...fresh.env,
    AI_GATEWAY: "gw",
    AI: {
      run: async (model: string, _inputs: unknown, options: AiOptions) => {
        const call = { model, options };
        calls.push(call);
        return answer(call);
      },
    },
  } as unknown as Env;
  return { sqlite, env, calls };
}

const usage = (sqlite: DatabaseSync) =>
  sqlite
    .prepare(
      "SELECT scope_kind, scope_id, feature, model, calls, failed_calls, input_tokens FROM ai_usage ORDER BY scope_kind, scope_id, feature, model",
    )
    .all();

/**
 * A Workflow step as the runtime runs it: each callback is called later, from
 * outside whatever AsyncLocalStorage context `step.do` was called in.
 */
function detachedSteps() {
  const queue: (() => Promise<void>)[] = [];
  // Like the runtime's RPC stub, where any property is a remote call: a
  // wrapper must call `step.do(...)`, never `step.do.bind` or `.call`.
  const remote = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(object, property) {
        if (property === "bind" || property === "call" || property === "apply")
          throw new Error(`RPC stub: ${String(property)} is a remote call`);
        return Reflect.get(object, property) as unknown;
      },
    });
  const step = {
    do: remote(
      (_name: string, a: unknown, b?: unknown) =>
        new Promise((resolve, reject) => {
          const callback = (typeof a === "function" ? a : b) as (ctx: unknown) => Promise<unknown>;
          queue.push(() => callback({ attempt: 1 }).then(resolve, reject));
        }),
    ),
    sleep: remote(async () => undefined),
  } as unknown as WorkflowStep;
  /** Run the queued callbacks, outside any context, until none are left. */
  const drain = async () => {
    while (queue.length) await queue.shift()!();
  };
  return { step, drain };
}

/** An AI fake answer that hangs until its call is aborted. */
const hangs = (call: Call) =>
  new Promise((_, reject) => {
    const signal = call.options.signal!;
    signal.addEventListener("abort", () => reject(new Error("aborted by caller")));
  });

describe("attribution across Workflow steps", () => {
  test("a step's model calls record for the repository Space, not as unattributed", async () => {
    const { sqlite, env, calls } = await setup();
    const work = { feature: "knowledge", repo: "repo" };
    // Without re-entering the context in each step: the production bug.
    const bare = detachedSteps();
    const lost = aiWork(work, () =>
      bare.step.do("align", { timeout: "15 minutes" }, () => decide(env, {}, QUESTION)),
    );
    await bare.drain();
    await lost;
    // With paidSteps, as KnowledgeBuild.run uses.
    const wrapped = detachedSteps();
    const kept = aiWork(work, () =>
      paidSteps(wrapped.step, work).do("align", { timeout: "15 minutes" }, async () => {
        await decide(env, {}, QUESTION);
        return decide(env, {}, QUESTION);
      }),
    );
    await wrapped.drain();
    await kept;
    expect(usage(sqlite)).toEqual([
      {
        scope_kind: "instance",
        scope_id: "",
        feature: "unattributed",
        model: MODELS.classify,
        calls: 1,
        failed_calls: 0,
        input_tokens: 40,
      },
      {
        scope_kind: "space",
        scope_id: "acc_o",
        feature: "knowledge",
        model: MODELS.classify,
        calls: 2,
        failed_calls: 0,
        input_tokens: 80,
      },
    ]);
    // The gateway log of each call names the same scope and feature, so the
    // two records reconcile; a deadline-bearing signal goes with every call.
    expect(calls.map((c) => c.options.gateway?.metadata)).toEqual([
      {
        component: "knowledge",
        scopeKind: "instance",
        scopeId: "",
        feature: "unattributed",
        attempt: expect.any(String),
      },
      {
        component: "knowledge",
        scopeKind: "space",
        scopeId: "acc_o",
        feature: "knowledge",
        attempt: expect.any(String),
      },
      {
        component: "knowledge",
        scopeKind: "space",
        scopeId: "acc_o",
        feature: "knowledge",
        attempt: expect.any(String),
      },
    ]);
    expect(calls.every((c) => c.options.signal instanceof AbortSignal)).toBe(true);
    expect(calls.every((c) => c.options.extraHeaders)).toBe(true);
  });

  test("the step callback overload without a config is wrapped too", async () => {
    const { sqlite, env } = await setup();
    const work = { feature: "wiki", spaceId: "acc_o" };
    const { step, drain } = detachedSteps();
    const done = paidSteps(step, work).do("pages", () => decide(env, {}, QUESTION));
    await drain();
    await done;
    expect(usage(sqlite)).toEqual([
      expect.objectContaining({ scope_kind: "space", scope_id: "acc_o", calls: 1 }),
    ]);
  });
});

describe("metered attempts", () => {
  test("rate-limited attempts are bounded and each is metered as failed", async () => {
    vi.useFakeTimers();
    let n = 0;
    const { sqlite, env, calls } = await setup(async () => {
      if (++n <= 2) throw new Error("3021: Rate limit reached");
      return {
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      };
    });
    const result = aiWork({ feature: "knowledge", spaceId: "acc_o" }, () =>
      chatJson(env, "fast", "s", "u"),
    );
    await vi.runAllTimersAsync();
    await expect(result).resolves.toMatchObject({ value: { ok: true } });
    expect(calls).toHaveLength(3);
    expect(usage(sqlite)).toEqual([
      expect.objectContaining({
        scope_kind: "space",
        scope_id: "acc_o",
        calls: 1,
        failed_calls: 2,
      }),
    ]);

    // Past the retry bound the error surfaces; every attempt was metered.
    n = -100;
    const exhausted = aiWork({ feature: "knowledge", spaceId: "acc_o" }, () =>
      chatJson(env, "fast", "s", "u", { attempts: 1, rateLimitRetries: 1 }),
    );
    const settled = expect(exhausted).rejects.toThrow(/Rate limit/);
    await vi.runAllTimersAsync();
    await settled;
    expect(calls).toHaveLength(5);
    expect(usage(sqlite)).toEqual([
      expect.objectContaining({
        scope_kind: "space",
        scope_id: "acc_o",
        calls: 1,
        failed_calls: 4,
      }),
    ]);
  });
});

describe("safe failed-attempt evidence", () => {
  test("a successful retry retains one sanitized event correlated to the failed gateway attempt", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "https://private.example/token?key=credential\nprivate prompt";
    const error = new Error(`3021: Rate limit reached ${secret}`, { cause: { secret } });
    error.stack = secret;
    let attempts = 0;
    const { sqlite, env, calls } = await setup(async () => {
      if (++attempts === 1) throw error;
      return ANSWER;
    });
    try {
      const result = aiWork({ feature: "knowledge", spaceId: "acc_o" }, () =>
        decide(env, {}, QUESTION),
      );
      await vi.runAllTimersAsync();
      await result;
      expect(warn).toHaveBeenCalledTimes(1);
      const line = warn.mock.calls[0]![0] as string;
      expect(line.startsWith('{"event":"ai.model.failed",')).toBe(true);
      expect(line).not.toContain("private");
      expect(line).not.toContain("credential");
      expect(line).not.toContain("\\n");
      const diagnostic = parseModelFailureDiagnostic(JSON.parse(line));
      expect(diagnostic).toMatchObject({
        provider: "workers-ai",
        model: MODELS.classify,
        scopeKind: "space",
        scopeId: "acc_o",
        feature: "knowledge",
        dispatched: true,
        kind: "rate_limit",
        code: 3021,
        name: "Error",
        attempt: calls[0]!.options.gateway!.metadata!.attempt,
      });
      expect(calls[1]!.options.gateway!.metadata!.attempt).not.toBe(diagnostic!.attempt);
      expect(usage(sqlite)).toEqual([
        expect.objectContaining({ calls: 1, failed_calls: 1, input_tokens: 40 }),
      ]);
    } finally {
      sqlite.close();
    }
  });

  test.each(["deadline", "expired", "stopped"] as const)(
    "distinguishes %s without relying on provider abort text",
    async (kind) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let sent!: () => void;
      const dispatched = new Promise<void>((resolve) => {
        sent = resolve;
      });
      const { sqlite, env } = await setup((call) => {
        sent();
        return hangs(call);
      });
      try {
        const outcome = aiWork({ feature: "knowledge", spaceId: "acc_o" }, () =>
          paidWork({}, async (guard) => {
            const call = chatText(env, "reason", "s", "u");
            const caught = call.catch((error: unknown) => error);
            await dispatched;
            if (kind !== "deadline") guard.stop(kind, "private cancellation reason");
            return caught;
          }),
        );
        await vi.runAllTimersAsync();
        const error = await outcome;
        if (kind === "deadline") expect(String(error)).toMatch(/timed out/);
        else expect(error).toBeInstanceOf(PaidWorkStopped);
        expect(warn).toHaveBeenCalledTimes(1);
        const line = warn.mock.calls[0]![0] as string;
        expect(parseModelFailureDiagnostic(JSON.parse(line))).toMatchObject({
          kind:
            kind === "deadline" ? "deadline" : kind === "expired" ? "work_expired" : "work_stopped",
          dispatched: true,
        });
        expect(line).not.toContain("private");
        expect(usage(sqlite)).toEqual([expect.objectContaining({ calls: 0, failed_calls: 1 })]);
      } finally {
        sqlite.close();
      }
    },
  );

  test("diagnostic logging failure cannot mask the original rejection or skip metering", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const original = new Error("provider rejected secret content");
    const { sqlite, env } = await setup(async () => {
      throw original;
    });
    try {
      await expect(
        aiWork({ feature: "knowledge", spaceId: "acc_o" }, () => chatText(env, "fast", "s", "u")),
      ).rejects.toBe(original);
      expect(usage(sqlite)).toEqual([expect.objectContaining({ calls: 0, failed_calls: 1 })]);
    } finally {
      sqlite.close();
    }
  });
});

describe("call deadlines", () => {
  test("a writing call on the fast model gets the writing deadline, then is aborted and metered", async () => {
    vi.useFakeTimers();
    const { sqlite, env, calls } = await setup(hangs);
    const page = aiWork({ feature: "knowledge", spaceId: "acc_o" }, () =>
      chatText(env, "reason", "s", "u", { model: MODELS.fast }),
    );
    const settled = page.catch((error: unknown) => error);
    // Past the fast tier's 90 s, a long page is still being written.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls[0]!.options.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(String(await settled)).toMatch(/timed out after 180s/);
    expect(calls[0]!.options.signal!.aborted).toBe(true);
    expect(usage(sqlite)).toEqual([expect.objectContaining({ calls: 0, failed_calls: 1 })]);
  });
});

describe("a stopped build stops paying", () => {
  test.each(["repos", "site_ai_log_bodies"])(
    "stopping during %s preparation neither dispatches nor meters a model attempt",
    async (table) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { sqlite, env, calls } = await setup(async (call) => {
        call.options.signal?.throwIfAborted();
        return ANSWER;
      });
      let stopped = false;
      try {
        const outcome = aiWork({ feature: "knowledge", repo: "repo" }, () =>
          paidWork({}, async (guard) => {
            const prepare = env.DB.prepare.bind(env.DB);
            env.DB.prepare = (query) => {
              if (!stopped && query.includes(`"${table}"`)) {
                stopped = true;
                guard.stop("stopped", "Stopped during request preparation");
              }
              return prepare(query);
            };
            return decide(env, {}, QUESTION);
          }),
        );
        await expect(outcome).rejects.toBeInstanceOf(PaidWorkStopped);
        expect(stopped).toBe(true);
        expect(calls).toHaveLength(0);
        expect(usage(sqlite)).toEqual([]);
        if (table === "site_ai_log_bodies") {
          expect(warn).toHaveBeenCalledTimes(1);
          expect(
            parseModelFailureDiagnostic(JSON.parse(warn.mock.calls[0]![0] as string)),
          ).toMatchObject({
            dispatched: false,
            kind: "work_stopped",
            scopeKind: "space",
            scopeId: "acc_o",
            feature: "knowledge",
          });
        } else {
          // Attribution precedes the existing attempt boundary.
          expect(warn).not.toHaveBeenCalled();
        }
      } finally {
        sqlite.close();
      }
    },
  );

  test("once the watchdog marks a build failed, its calls are refused and those in flight aborted", async () => {
    let hang = true;
    let sent!: () => void;
    const firstSent = new Promise<void>((resolve) => (sent = resolve));
    const { sqlite, env, calls } = await setup((call) => {
      sent();
      return hang ? hangs(call) : Promise.resolve(ANSWER);
    });
    const work = { feature: "knowledge", repo: "repo" };
    const { step, drain } = detachedSteps();
    const live = () => buildStopped(env.DB, "repo", "b1");
    const steps = paidSteps(step, work, live, 0);
    const outcome = steps.do("align-0", { timeout: "15 minutes" }, () =>
      pool([1, 2, 3, 4, 5, 6], 2, async (i) => {
        if (i === 1) return decide(env, {}, QUESTION); // hangs until aborted
        if (i === 2) {
          await firstSent;
          hang = false;
          // The watchdog gives up on the build meanwhile.
          sqlite.exec("UPDATE kg_builds SET status = 'failed' WHERE id = 'b1'");
        }
        return decide(env, {}, QUESTION);
      }),
    );
    const caught = outcome.catch((error: unknown) => error);
    await drain();
    const error = (await caught) as Error;
    // Not retried by the runtime: the build is over.
    expect(error.name).toBe("NonRetryableError");
    expect(error.message).toMatch(/build is failed/);
    // One call was in flight (aborted, metered as failed); item 2's call was
    // refused before it was sent, and nothing after it started.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.signal!.aborted).toBe(true);
    expect(usage(sqlite)).toEqual([
      expect.objectContaining({
        scope_kind: "space",
        scope_id: "acc_o",
        calls: 0,
        failed_calls: 1,
      }),
    ]);
  });

  test("a step that skips refused calls still fails once its build was stopped", async () => {
    const { sqlite, env, calls } = await setup();
    sqlite.exec("UPDATE kg_builds SET status = 'failed' WHERE id = 'b1'");
    const { step, drain } = detachedSteps();
    const steps = paidSteps(step, { feature: "knowledge", repo: "repo" }, () =>
      buildStopped(env.DB, "repo", "b1"),
    );
    // Like analyzeFiles or the wiki: a failed item is counted, not thrown.
    const outcome = steps.do("analyze-0", { timeout: "15 minutes" }, async () => {
      const failed = await decide(env, {}, QUESTION).then(
        () => 0,
        () => 1,
      );
      return { failed };
    });
    const caught = outcome.catch((error: unknown) => error);
    await drain();
    expect(((await caught) as Error).name).toBe("NonRetryableError");
    expect(calls).toHaveLength(0);
  });

  test("a delayed publication is refused even without a model call after authorization loss", async () => {
    const { step, drain } = detachedSteps();
    const publish = vi.fn(async () => "published");
    const steps = paidSteps(
      step,
      { feature: "knowledge", spaceId: "space" },
      async () => "Grant revoked",
      0,
    );
    const outcome = steps.do("publish", publish).catch((error: unknown) => error);
    await drain();
    expect(((await outcome) as Error).name).toBe("NonRetryableError");
    expect(publish).not.toHaveBeenCalled();
    // Failure bookkeeping deliberately uses the original, non-business step.
    const recorded = step.do("fail", async () => "recorded");
    await drain();
    await expect(recorded).resolves.toBe("recorded");
  });

  test("an ended-source refusal retains its durable identity without publishing", async () => {
    const { step, drain } = detachedSteps();
    const publish = vi.fn(async () => "published");
    const steps = paidSteps(
      step,
      { feature: "knowledge", spaceId: "space" },
      async () => ({ code: "TimelineEnded", message: "Source archived" }),
      0,
    );
    const outcome = steps.do("publish", publish).catch((error: unknown) => error);
    await drain();
    expect(await outcome).toBeInstanceOf(Error);
    expect(((await outcome) as Error).name).toBe("TimelineEnded");
    expect(publish).not.toHaveBeenCalled();
    const cleanup = step.do("cleanup", async () => "released");
    await drain();
    await expect(cleanup).resolves.toBe("released");
  });

  test("an unavailable authorization lookup fails closed", async () => {
    const { step, drain } = detachedSteps();
    const publish = vi.fn(async () => "published");
    const steps = paidSteps(
      step,
      { feature: "knowledge", spaceId: "space" },
      async () => {
        throw new Error("D1 unavailable");
      },
      0,
    );
    const outcome = steps.do("publish", publish).catch((error: unknown) => error);
    await drain();
    expect(((await outcome) as Error).name).toBe("NonRetryableError");
    expect(publish).not.toHaveBeenCalled();
  });

  test("a provider result cannot publish after the initiating credential is revoked", async () => {
    let revoked = false;
    const publish = vi.fn();
    await expect(
      paidWork(
        { every: 0, live: async () => (revoked ? "Credential revoked" : null) },
        async (guard) => {
          await guard.check();
          revoked = true;
          await guard.check();
          publish();
        },
      ),
    ).rejects.toThrow("Credential revoked");
    expect(publish).not.toHaveBeenCalled();
  });

  test("a running build, or one not yet recorded, may spend; a deleted repository's may not", async () => {
    const { sqlite, env } = await setup();
    expect(await buildStopped(env.DB, "repo", "b1")).toBeNull();
    expect(await buildStopped(env.DB, "repo", "not-started")).toBeNull();
    sqlite.exec("UPDATE kg_builds SET status = 'succeeded' WHERE id = 'b1'");
    expect(await buildStopped(env.DB, "repo", "b1")).toMatch(/succeeded/);
    sqlite.exec("UPDATE repos SET deleted_at = '2026-10-05T00:00:00Z' WHERE id = 'repo'");
    expect(await buildStopped(env.DB, "repo", "not-started")).toMatch(/deleted/);
  });

  test("a timed-out step attempt aborts its calls and starts no more, but may be retried", async () => {
    vi.useFakeTimers();
    let sent!: () => void;
    const firstSent = new Promise<void>((resolve) => (sent = resolve));
    const { sqlite, env, calls } = await setup((call) => {
      sent();
      return hangs(call);
    });
    const outcome = aiWork({ feature: "knowledge", spaceId: "acc_o" }, () =>
      paidWork({ deadline: Date.now() + 30_000 }, async () => {
        const first = await decide(env, {}, QUESTION).catch((error: unknown) => error);
        const second = await decide(env, {}, QUESTION).catch((error: unknown) => error);
        return [first, second];
      }),
    );
    await firstSent;
    await vi.advanceTimersByTimeAsync(30_000);
    const [first, second] = (await outcome) as PaidWorkStopped[];
    expect(first).toBeInstanceOf(PaidWorkStopped);
    expect(first!.kind).toBe("expired");
    expect(second!.kind).toBe("expired");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.options.signal!.aborted).toBe(true);
    expect(usage(sqlite)).toEqual([expect.objectContaining({ calls: 0, failed_calls: 1 })]);

    // Through paidSteps an expired attempt's error is an ordinary (retryable) one.
    const { step, drain } = detachedSteps();
    const expired = paidSteps(step, { feature: "knowledge", spaceId: "acc_o" }).do(
      "slow",
      { timeout: "20 seconds" },
      () => decide(env, {}, QUESTION),
    );
    const caught = expired.catch((error: unknown) => error);
    const drained = drain();
    await vi.advanceTimersByTimeAsync(20_000);
    await drained;
    expect(((await caught) as Error).name).toBe("PaidWorkStopped");
    expect(calls).toHaveLength(2);
  });

  test("step timeouts parse as Workflows writes them", () => {
    expect(timeoutMs("15 minutes")).toBe(900_000);
    expect(timeoutMs("20 seconds")).toBe(20_000);
    expect(timeoutMs("1 hour")).toBe(3_600_000);
    expect(timeoutMs(2_500)).toBe(2_500);
    expect(timeoutMs(undefined)).toBe(600_000);
  });
});

describe("pool", () => {
  test("a failure starts nothing more and waits for work in flight before rejecting", async () => {
    const started: number[] = [];
    let inFlight = 0;
    let settledInFlight = false;
    const result = pool([1, 2, 3, 4, 5, 6, 7, 8], 3, async (i) => {
      started.push(i);
      inFlight++;
      try {
        if (i === 1) throw new Error("provider down");
        await new Promise((resolve) => setTimeout(resolve, 20));
        return i;
      } finally {
        inFlight--;
        if (i !== 1 && inFlight === 0) settledInFlight = true;
      }
    });
    await expect(result).rejects.toThrow("provider down");
    expect(settledInFlight).toBe(true);
    expect(started).toEqual([1, 2, 3]);
  });
});

// ---- the coordinator's watchdog -----------------------------------------------

const oid = (n: number) => n.toString(16).padStart(40, "0");

function objectState() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    storage: {
      get: async (key: string) => structuredClone(values.get(key)),
      put: async (key: string, value: unknown) => void values.set(key, structuredClone(value)),
      getAlarm: async () => alarm,
      setAlarm: async (at: number) => void (alarm = at),
      deleteAlarm: async () => void (alarm = null),
    },
    blockConcurrencyWhile: <T>(fn: () => Promise<T>) => fn(),
  } as unknown as DurableObjectState;
}

let artifactsNames = 0;

/** A coordinator whose first build of main is running; `status` is what Workflows says of it. */
async function runningBuild(status: () => Promise<{ status: string }>) {
  const fresh = await createFreshSpaceTestEnvironment();
  const { sqlite } = fresh;
  onTestFinished(fresh.close);
  const artifacts = `kg-paid-${++artifactsNames}`;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES ('ann', 'user', 'ann', 'Ann');
  `);
  await seedSpaceFixture(d1(sqlite), {
    organization: {
      id: "org-ann",
      slug: "ann",
      displayName: "Ann",
      kind: "personal",
      personalAccountId: "ann",
    },
    space: { id: "ann", slug: "ann", displayName: "General" },
    actorId: "ann",
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
  });
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('repo', 'ann', 'app', 'private', '${artifacts}', 'https://app');
    INSERT INTO kg_state (repo_id, indexed_commit) VALUES ('repo', '${oid(1)}');
  `);
  const git = fakeRemotes();
  git.add("https://app", { "refs/heads/main": oid(2) }, "refs/heads/main", artifacts);
  vi.stubGlobal("fetch", git.fetch);
  const created: string[] = [];
  const terminated: string[] = [];
  const env = {
    ...fresh.env,
    ARTIFACTS: git.artifacts,
    AI: {},
    TIMELINE_QUIET_SECONDS: "0",
    // Main's pushes build at once here; batching has its own tests (CORE-286).
    KNOWLEDGE_QUIET_SECONDS: "0",
    KNOWLEDGE_MAX_WAIT_SECONDS: "0",
    KNOWLEDGE_BUILD: {
      create: async ({ id }: { id: string }) => {
        created.push(id);
        sqlite
          .prepare(
            "INSERT INTO kg_builds (id, repo_id, to_commit, status, progress_at) VALUES (?, 'repo', ?, 'running', ?)",
          )
          .run(id, oid(2), new Date().toISOString());
      },
      get: async (id: string) => ({
        status,
        terminate: async () => void terminated.push(id),
      }),
    },
  } as unknown as Env;
  const coordinator = new KnowledgeCoordinator(objectState(), env);
  const token = await issueToken(env.DB, "ann", "push", "write");
  const authorization = await captureWorkAuthority(env, "repo", {
    id: "ann",
    credential: { kind: "token", id: token.id },
  });
  await coordinator.notify("repo", { authorization });
  await coordinator.alarm();
  expect(created).toHaveLength(1);
  const builds = () => sqlite.prepare("SELECT id, status FROM kg_builds ORDER BY rowid").all();
  return { coordinator, created, terminated, builds };
}

describe("the watchdog stops what it gives up on", () => {
  test("a build whose status can't be read is terminated before its retry starts", async () => {
    let readable = true;
    const t = await runningBuild(async () => {
      if (readable) return { status: "running" };
      throw new Error("Workflows unavailable");
    });
    // Healthy and progressing: left alone.
    await t.coordinator.alarm();
    expect(t.terminated).toEqual([]);
    readable = false;
    await t.coordinator.alarm();
    const [first, retry] = t.created;
    expect(t.terminated).toEqual([first]);
    expect(retry).toBeDefined();
    expect(t.builds()).toEqual([
      { id: first, status: "failed" },
      { id: retry, status: "running" },
    ]);
  });

  test("a build that already errored is not terminated again", async () => {
    let state = "running";
    const t = await runningBuild(async () => ({ status: state }));
    state = "errored";
    await t.coordinator.alarm();
    expect(t.terminated).toEqual([]);
    expect(t.created).toHaveLength(2);
  });
});
