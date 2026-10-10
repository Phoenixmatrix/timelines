// Which provider failures are transient, and reads that retry through them (CORE-331).

import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  forgetUpstreamTokens,
  isTransientArtifactsError,
  lsRefs,
  upstreamToken,
  UpstreamStatusError,
} from "./artifacts.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("isTransientArtifactsError", () => {
  test("network failures on the way are transient", () => {
    for (const message of [
      "rust/cxx/kj-rs-io/ffi.rs:186: failed: getaddrinfo(): DNS lookup failed. host = gitmatrix.fward.workers.dev",
      "getaddrinfo EAI_AGAIN example.com: Temporary failure in name resolution",
      "read ECONNRESET",
      "connect ECONNREFUSED 127.0.0.1:443",
      "fetch failed",
      "Network connection lost.",
    ])
      expect(isTransientArtifactsError(new Error(message)), message).toBe(true);
    expect(isTransientArtifactsError(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(
      true,
    );
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(isTransientArtifactsError(timeout)).toBe(true);
  });

  test("a git endpoint's status says whether the provider or the request failed", () => {
    for (const status of [500, 502, 503, 504])
      expect(isTransientArtifactsError(new UpstreamStatusError("ls-refs", status))).toBe(true);
    // Rate limiting included: asking again at once only adds to it.
    for (const status of [400, 401, 403, 404, 429])
      expect(isTransientArtifactsError(new UpstreamStatusError("ls-refs", status))).toBe(false);
    expect(new UpstreamStatusError("ls-refs", 500).message).toBe("ls-refs failed with HTTP 500");
    // A request refused for what it asked, worded like a network failure, is not.
    expect(isTransientArtifactsError(new Error("fetch failed with HTTP 404"))).toBe(false);
  });
});

describe("lsRefs", () => {
  const env = {
    ARTIFACTS: {
      get: async () => ({
        createToken: async () => ({
          plaintext: "token",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        [Symbol.dispose]() {},
      }),
    },
  } as unknown as Env;

  test("retries the provider's transient refusals, then reads the refs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    forgetUpstreamTokens("r-retry");
    const statuses = [503, 500];
    const fetch = vi.fn(async () => {
      const status = statuses.shift();
      return status ? new Response("", { status }) : new Response("0000");
    });
    vi.stubGlobal("fetch", fetch);
    expect(await lsRefs(env, "r-retry", "https://artifacts.example/r-retry")).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(3);
    // Each try is bounded.
    for (const [, init] of fetch.mock.calls as unknown as [string, RequestInit][])
      expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test("a refusal for the request itself is not retried", async () => {
    forgetUpstreamTokens("r-denied");
    const fetch = vi.fn(async () => new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    await expect(lsRefs(env, "r-denied", "https://artifacts.example/r-denied")).rejects.toThrow(
      "ls-refs failed with HTTP 403",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("upstreamToken", () => {
  test("a binding call that hangs fails in time instead of hanging the request", async () => {
    vi.useFakeTimers();
    try {
      const env = {
        ARTIFACTS: { get: () => new Promise(() => {}) },
      } as unknown as Env;
      forgetUpstreamTokens("r-hung");
      const token = upstreamToken(env, "r-hung", "read");
      const settled = expect(token).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
