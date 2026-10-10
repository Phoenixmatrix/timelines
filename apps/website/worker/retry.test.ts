// Retrying repeatable work through transient failures (CORE-331).

import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { READ_RETRY_DELAYS_MS, retrying, withTimeout } from "./retry.ts";

const transient = (error: unknown) => error instanceof Error && error.message === "flaky";

afterEach(() => vi.restoreAllMocks());

describe("retrying", () => {
  test("a transient failure is retried until the work succeeds", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const waits: number[] = [];
    let calls = 0;
    const value = await retrying(
      async () => {
        if (++calls < 3) throw new Error("flaky");
        return "done";
      },
      { retryable: transient, label: "Test", wait: async (ms) => waits.push(ms) },
    );
    expect(value).toBe("done");
    expect(calls).toBe(3);
    // Each wait is its delay give or take a quarter, so callers spread out.
    expect(waits).toHaveLength(2);
    for (const [index, ms] of waits.entries()) {
      expect(ms).toBeGreaterThanOrEqual(READ_RETRY_DELAYS_MS[index]! * 0.75);
      expect(ms).toBeLessThanOrEqual(READ_RETRY_DELAYS_MS[index]! * 1.25);
    }
    expect(console.warn).toHaveBeenCalledWith(
      "Test: retrying after a transient failure",
      expect.objectContaining({ attempt: 1, error: "Error: flaky" }),
    );
  });

  test("after its retries the last failure is thrown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const attempt = retrying(
      async () => {
        calls++;
        throw new Error("flaky");
      },
      { retryable: transient, label: "Test", delays: [0, 0], wait: async () => {} },
    );
    await expect(attempt).rejects.toThrow("flaky");
    expect(calls).toBe(3);
  });

  test("a failure past the deadline isn't retried: slow endpoints aren't asked again", async () => {
    let clock = 0;
    let calls = 0;
    const attempt = retrying(
      async () => {
        calls++;
        clock += 15_000; // A try that ran into its time limit.
        throw new Error("flaky");
      },
      { retryable: transient, label: "Test", wait: async () => {}, now: () => clock },
    );
    await expect(attempt).rejects.toThrow("flaky");
    expect(calls).toBe(1);
  });

  test("other failures are thrown at once", async () => {
    let calls = 0;
    const attempt = retrying(
      async () => {
        calls++;
        throw new Error("Repository was deleted.");
      },
      { retryable: transient, label: "Test", wait: async () => {} },
    );
    await expect(attempt).rejects.toThrow("Repository was deleted.");
    expect(calls).toBe(1);
  });
});

describe("withTimeout", () => {
  test("a call that doesn't answer in time fails with a TimeoutError", async () => {
    const hung = new Promise<never>(() => {});
    await expect(withTimeout(hung, 10)).rejects.toMatchObject({ name: "TimeoutError" });
    expect(await withTimeout(Promise.resolve("quick"), 1_000)).toBe("quick");
  });
});
