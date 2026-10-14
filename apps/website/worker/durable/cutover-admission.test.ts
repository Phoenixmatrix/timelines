import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { installCutoverTestControl } from "../testing/space-cutover.ts";
import {
  ADMISSION_CACHE_TTL_MS,
  cachedAdmission,
  forgetCachedAdmission,
  peekCachedAdmission,
  verifiedAdmission,
  withSteadyAdmission,
  wrapCutoverBackground,
  wrapCutoverFetch,
} from "./cutover-admission.ts";
import type { Context } from "hono";
import type { AppEnv } from "../auth.ts";
import { requestAdmission } from "../api/content-contract.ts";
import { Timing } from "../timing.ts";
import { createFreshSpaceTestEnvironment } from "../testing/spaces.ts";

vi.mock("cloudflare:workers", async () => import("../testing/runtime.ts"));

const disposers: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const close of disposers.splice(0)) close();
});

async function fixture() {
  const installation = await createFreshSpaceTestEnvironment();
  disposers.push(installation.close);
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(work: Promise<unknown>) {
      pending.push(work);
      void work.catch(() => undefined);
    },
  } as ExecutionContext;
  return { ...installation, ctx, pending };
}

/** A mutation: these lifetimes are what tickets protect, with or without cached admission. */
const request = () => new Request("https://isolated.test/api/content", { method: "POST" });

describe("independent content admission lifetime", () => {
  test("stream EOF and transitive after-response writes must both finish before release", async () => {
    const t = await fixture();
    const flush = Promise.withResolvers<void>();
    const finalWrite = Promise.withResolvers<void>();
    const queued = Promise.withResolvers<void>();
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const writes: string[] = [];
    const response = await wrapCutoverFetch(request(), t.env, t.ctx, async (_, __, ctx) => {
      ctx.waitUntil(
        flush.promise.then(() => {
          writes.push("first");
          ctx.waitUntil(
            finalWrite.promise.then(() => {
              writes.push("final");
            }),
          );
          queued.resolve();
        }),
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode("data"));
          },
        }),
      );
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data");
    stream.close();
    expect((await reader.read()).done).toBe(true);
    flush.resolve();
    await queued.promise;
    expect(writes).toEqual(["first"]);
    expect(t.control.activeTickets().map((entry) => entry.consumer)).toEqual(["http-git-registry"]);
    finalWrite.resolve();
    await Promise.all(t.pending);
    expect(writes).toEqual(["first", "final"]);
    expect(t.control.activeTickets()).toEqual([]);
  });

  test("cancelling a response waits for the producer cancellation acknowledgement", async () => {
    const t = await fixture();
    const cancellation = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let cancelled = false;
    const response = await wrapCutoverFetch(
      request(),
      t.env,
      t.ctx,
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async cancel() {
              entered.resolve();
              await cancellation.promise;
              cancelled = true;
            },
          }),
        ),
    );
    expect(response.status).toBe(200);
    const cancel = response.body!.cancel("client disconnected");
    await entered.promise;
    expect(cancelled).toBe(false);
    expect(t.control.activeTickets().map((entry) => entry.consumer)).toEqual(["http-git-registry"]);
    cancellation.resolve();
    await cancel;
    await Promise.all(t.pending);
    expect(cancelled).toBe(true);
    expect(t.control.activeTickets()).toEqual([]);
  });

  test("an HTTP fence rejects the mutation without acquiring a ticket", async () => {
    const env = {} as Env;
    const t = installCutoverTestControl(env);
    disposers.push(t.close);
    await t.fence();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const records: string[] = [];
    const response = await wrapCutoverFetch(request(), env, {} as ExecutionContext, async () => {
      records.push("forbidden");
      return new Response("written");
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(records).toEqual([]);
    expect(t.control.activeTickets()).toEqual([]);
  });

  test("background failure still waits for recursively registered writes before release", async () => {
    const t = await fixture();
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const registered = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const failure = new Error("scheduled work failed");
    const records: string[] = [];
    const execution = wrapCutoverBackground(t.env, "scheduled", t.ctx, async (ctx) => {
      ctx.waitUntil(
        first.promise.then(() => {
          ctx.waitUntil(
            second.promise.then(() => {
              records.push("late write");
            }),
          );
          registered.resolve();
        }),
      );
      entered.resolve();
      throw failure;
    });
    const outcome = execution.then(
      () => null,
      (error: unknown) => error,
    );
    await Promise.race([entered.promise, execution]);
    first.resolve();
    await registered.promise;
    expect(t.control.activeTickets().map((entry) => entry.consumer)).toEqual(["scheduled"]);
    expect(records).toEqual([]);
    second.resolve();
    expect(await outcome).toBe(failure);
    await Promise.all(t.pending);
    expect(records).toEqual(["late write"]);
    expect(t.control.activeTickets()).toEqual([]);
  });
});

describe("steady admission (CORE-439)", () => {
  const at = (method: string, path: string) =>
    new Request(`https://isolated.test${path}`, { method });

  test("a read under cached open admission takes no ticket", async () => {
    const t = await fixture();
    expect(peekCachedAdmission(t.env)).toEqual({ allowed: true, epoch: 0 });
    const acquire = vi.spyOn(t.control, "acquire");
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const held: string[][] = [];
      const response = await wrapCutoverFetch(at(method, "/api/spaces"), t.env, t.ctx, async () => {
        held.push(t.control.activeTickets().map((entry) => entry.consumer));
        return new Response("read");
      });
      expect(response.status).toBe(200);
      expect(held).toEqual([[]]);
    }
    expect(acquire).not.toHaveBeenCalled();
  });

  test.each([
    ["a mutation", "POST", "/api/spaces"],
    ["Git ref advertisement", "GET", "/space/repo.git/info/refs"],
    ["a Git repository path", "GET", "/space/repo.git"],
  ])("%s still holds a ticket while it runs", async (_kind, method, path) => {
    const t = await fixture();
    const held: string[][] = [];
    await wrapCutoverFetch(at(method, path), t.env, t.ctx, async () => {
      held.push(t.control.activeTickets().map((entry) => entry.consumer));
      return new Response(null, { status: 204 });
    });
    await Promise.all(t.pending);
    expect(held).toEqual([["http-git-registry"]]);
    expect(t.control.activeTickets()).toEqual([]);
  });

  test("a read in an isolate without a cached open admission takes a ticket", async () => {
    const t = await fixture();
    forgetCachedAdmission(t.env);
    const held: string[][] = [];
    await wrapCutoverFetch(at("GET", "/api/spaces"), t.env, t.ctx, async () => {
      held.push(t.control.activeTickets().map((entry) => entry.consumer));
      return new Response(null, { status: 204 });
    });
    expect(held).toEqual([["http-git-registry"]]);
  });

  test("withSteadyAdmission runs without a ticket once admission is open, and takes one before", async () => {
    const t = await fixture();
    const acquire = vi.spyOn(t.control, "acquire");
    expect(
      await withSteadyAdmission(t.env, "tracker", async () => t.control.activeTickets()),
    ).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
    const env = {} as Env;
    const legacy = installCutoverTestControl(env);
    disposers.push(legacy.close);
    const work = vi.fn(async () => "ran");
    await expect(withSteadyAdmission(env, "tracker", work)).rejects.toThrow("space_cutover_fenced");
    expect(work).not.toHaveBeenCalled();
  });

  test("withSteadyAdmission takes a ticket, and primes nothing, when verification fails", async () => {
    const t = await fixture();
    forgetCachedAdmission(t.env);
    vi.spyOn(t.control, "verifyFreshInstallation").mockRejectedValueOnce(
      new Error("fresh_install_authority_mismatch"),
    );
    expect(
      await withSteadyAdmission(t.env, "tracker", async () =>
        t.control.activeTickets().map((entry) => entry.consumer),
      ),
    ).toEqual(["tracker"]);
    expect(peekCachedAdmission(t.env)).toBeNull();
    expect(t.control.activeTickets()).toEqual([]);
  });
});

describe("cachedAdmission (CORE-439)", () => {
  async function cold() {
    const t = await fixture();
    forgetCachedAdmission(t.env);
    return {
      ...t,
      admission: vi.spyOn(t.control, "admission"),
      state: vi.spyOn(t.control, "installationState"),
      verify: vi.spyOn(t.control, "verifyFreshInstallation"),
    };
  }

  test("a verified read primes the isolate, then answers without a round trip, counting both", async () => {
    const t = await cold();
    const timing = new Timing();
    expect(await verifiedAdmission(t.env, timing)).toBe(true);
    expect(t.state).toHaveBeenCalledTimes(1);
    expect(t.verify).toHaveBeenCalledTimes(1);
    expect(await verifiedAdmission(t.env, timing)).toBe(true);
    expect(await cachedAdmission(t.env, timing)).toEqual({ allowed: true, epoch: 0 });
    expect(t.state).toHaveBeenCalledTimes(1);
    expect(t.admission).not.toHaveBeenCalled();
    expect(timing.header()).toContain('admission-cache-miss;desc="admission-cache-miss x1"');
    expect(timing.header()).toContain('admission-cache-hit;desc="admission-cache-hit x2"');
  });

  test("a plain read answers its caller and primes nothing", async () => {
    const t = await cold();
    expect(await cachedAdmission(t.env)).toEqual({ allowed: true, epoch: 0 });
    expect(t.admission).toHaveBeenCalledWith(4);
    expect(peekCachedAdmission(t.env)).toBeNull();
    expect(await cachedAdmission(t.env)).toEqual({ allowed: true, epoch: 0 });
    expect(t.admission).toHaveBeenCalledTimes(2);
  });

  test("a read that never settles blocks only the caller that started it", async () => {
    const t = await cold();
    t.admission.mockImplementationOnce(() => new Promise(() => {}) as never);
    t.state.mockImplementationOnce(() => new Promise(() => {}) as never);
    let stuck = 0;
    void cachedAdmission(t.env).then(() => stuck++);
    void verifiedAdmission(t.env).then(() => stuck++);
    expect(peekCachedAdmission(t.env)).toBeNull();
    // Each later caller makes, and settles, its own read.
    expect(await cachedAdmission(t.env)).toEqual({ allowed: true, epoch: 0 });
    expect(await verifiedAdmission(t.env)).toBe(true);
    expect(t.admission).toHaveBeenCalledTimes(2);
    expect(t.state).toHaveBeenCalledTimes(2);
    expect(stuck).toBe(0);
  });

  test("only a settled verified positive is reused across callers", async () => {
    const t = await cold();
    const state = Promise.withResolvers<ReturnType<typeof t.control.installationState>>();
    t.state.mockImplementationOnce(() => state.promise as never);
    const first = verifiedAdmission(t.env);
    // While the first read is in flight, a second caller reads for itself.
    expect(peekCachedAdmission(t.env)).toBeNull();
    expect(await cachedAdmission(t.env)).toEqual({ allowed: true, epoch: 0 });
    expect(t.admission).toHaveBeenCalledTimes(1);
    state.resolve(t.control.installationState());
    expect(await first).toBe(true);
    expect(peekCachedAdmission(t.env)).toEqual({ allowed: true, epoch: 0 });
    expect(await cachedAdmission(t.env)).toEqual({ allowed: true, epoch: 0 });
    expect(t.admission).toHaveBeenCalledTimes(1);
  });

  test("a denial is read again every time", async () => {
    const env = {} as Env;
    const legacy = installCutoverTestControl(env);
    disposers.push(legacy.close);
    const admission = vi.spyOn(legacy.control, "admission");
    const state = vi.spyOn(legacy.control, "installationState");
    expect(await cachedAdmission(env)).toEqual({ allowed: false, epoch: 0 });
    expect(await cachedAdmission(env)).toEqual({ allowed: false, epoch: 0 });
    expect(await verifiedAdmission(env)).toBe(false);
    expect(await verifiedAdmission(env)).toBe(false);
    expect(admission).toHaveBeenCalledTimes(2);
    expect(state).toHaveBeenCalledTimes(2);
    expect(peekCachedAdmission(env)).toBeNull();
  });

  test("a failed read or verification is not kept", async () => {
    const t = await cold();
    t.admission.mockImplementationOnce(() => {
      throw new Error("control unavailable");
    });
    await expect(cachedAdmission(t.env)).rejects.toThrow("control unavailable");
    t.state.mockImplementationOnce(() => {
      throw new Error("control unavailable");
    });
    expect(await verifiedAdmission(t.env)).toBe(false);
    t.verify.mockRejectedValueOnce(new Error("fresh_install_authority_mismatch"));
    expect(await verifiedAdmission(t.env)).toBe(false);
    expect(peekCachedAdmission(t.env)).toBeNull();
    expect(await verifiedAdmission(t.env)).toBe(true);
    expect(t.state).toHaveBeenCalledTimes(3);
  });

  test("environments share nothing", async () => {
    const a = await cold();
    const b = await cold();
    await verifiedAdmission(a.env);
    await verifiedAdmission(b.env);
    expect(a.state).toHaveBeenCalledTimes(1);
    expect(b.state).toHaveBeenCalledTimes(1);
    forgetCachedAdmission(a.env);
    expect(peekCachedAdmission(a.env)).toBeNull();
    expect(peekCachedAdmission(b.env)).not.toBeNull();
  });

  test("an open read expires after its TTL, counted from before it was sent", async () => {
    const t = await cold();
    const now = vi.spyOn(Date, "now").mockReturnValue(5_000_000);
    await verifiedAdmission(t.env);
    now.mockReturnValue(5_000_000 + ADMISSION_CACHE_TTL_MS - 1);
    expect(peekCachedAdmission(t.env)).not.toBeNull();
    await verifiedAdmission(t.env);
    expect(t.state).toHaveBeenCalledTimes(1);
    now.mockReturnValue(5_000_000 + ADMISSION_CACHE_TTL_MS);
    expect(peekCachedAdmission(t.env)).toBeNull();
    await verifiedAdmission(t.env);
    expect(t.state).toHaveBeenCalledTimes(2);
  });
});

describe("requestAdmission (CORE-439)", () => {
  /** The slice of a Hono context requestAdmission uses, one per request. */
  function requestContext(env: Env) {
    const values = new Map<string, unknown>();
    return {
      env,
      get: (key: string) => values.get(key),
      set: (key: string, value: unknown) => void values.set(key, value),
    } as unknown as Context<AppEnv>;
  }

  test("one request shares its own read; another request makes its own", async () => {
    const t = await fixture();
    forgetCachedAdmission(t.env);
    const read = Promise.withResolvers<{ allowed: boolean; epoch: number }>();
    const admission = vi
      .spyOn(t.control, "admission")
      .mockImplementationOnce(() => read.promise as never);
    const one = requestContext(t.env);
    const first = requestAdmission(one);
    const again = requestAdmission(one);
    expect(again).toBe(first);
    // The first request's read is still in flight: the second doesn't wait on it.
    expect(await requestAdmission(requestContext(t.env))).toEqual({ allowed: true, epoch: 0 });
    expect(admission).toHaveBeenCalledTimes(2);
    read.resolve({ allowed: true, epoch: 0 });
    expect(await first).toEqual({ allowed: true, epoch: 0 });
    expect(peekCachedAdmission(t.env)).toBeNull();
  });
});
