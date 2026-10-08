// Creating a timeline's work source through transient Artifacts failures (CORE-302).

import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { RepoRow } from "../db.ts";
import { isTransientArtifactsError } from "../artifacts.ts";
import { TrackerError } from "../tracker/store.ts";
import { ensureWorkSource, SOURCE_RETRY_DELAYS_MS, type WorkSourceInput } from "./sources.ts";

const rpc = vi.hoisted(() => ({ initializeWorkSource: vi.fn() }));
vi.mock("../tracker/stub.ts", () => ({ trackerObject: () => rpc }));

const repo = { id: "repo", owner_id: "owner" } as RepoRow;
const input = { timelineId: "tl", timelineSlug: "search" } as WorkSourceInput;
const initialized = { ok: true, value: { source: { sourceId: "work_1" } } };
const internal = Object.assign(new Error("An internal error occurred."), {
  name: "ArtifactsError",
  code: "INTERNAL_ERROR",
});
const dropped = new Error(
  "Peer closed WebSocket: 1006 WebSocket disconnected without sending Close frame.",
);
// What the fork's own retry sees through the Tracker RPC: a message, no code (CORE-315).
const forking = new Error(
  'ArtifactsError: Repository "w-da0f379bf5db4b8d88e87718d34a0a87" is currently being forked from "artifacts:ns/r-b26f220bed22454f916e". The fork is still in progress and the repository is not yet available. Retry after 5 seconds.',
);

// A function beforeEach returns is its teardown: don't return the mock.
beforeEach(() => {
  rpc.initializeWorkSource.mockReset();
});

describe("ensureWorkSource", () => {
  test("retries transient provider failures: initialization resumes from its reservation", async () => {
    rpc.initializeWorkSource
      .mockRejectedValueOnce(internal)
      .mockRejectedValueOnce(dropped)
      .mockResolvedValueOnce(initialized);
    const waits: number[] = [];
    const source = await ensureWorkSource({} as Env, repo, input, async (ms) => {
      waits.push(ms);
    });
    expect(source).toEqual(initialized.value);
    expect(waits).toEqual(SOURCE_RETRY_DELAYS_MS.slice(0, 2));
    expect(rpc.initializeWorkSource).toHaveBeenCalledTimes(3);
    for (const call of rpc.initializeWorkSource.mock.calls) expect(call).toEqual([repo, input]);
  });

  test("a fork still in progress after a dropped connection is waited for, as long as it asks", async () => {
    rpc.initializeWorkSource
      .mockRejectedValueOnce(dropped)
      .mockRejectedValueOnce(forking)
      .mockRejectedValueOnce(forking)
      .mockResolvedValueOnce(initialized);
    const waits: number[] = [];
    const source = await ensureWorkSource({} as Env, repo, input, async (ms) => {
      waits.push(ms);
    });
    expect(source).toEqual(initialized.value);
    expect(waits).toEqual([...SOURCE_RETRY_DELAYS_MS]);
    expect(waits.at(-1)).toBeGreaterThanOrEqual(5_000);
  });

  test("a failure that persists is a retryable 503, not a 500", async () => {
    rpc.initializeWorkSource.mockRejectedValue(internal);
    const error = await ensureWorkSource({} as Env, repo, input, async () => {}).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TrackerError);
    expect(error).toMatchObject({ status: 503, code: "source_unavailable" });
    expect(rpc.initializeWorkSource).toHaveBeenCalledTimes(SOURCE_RETRY_DELAYS_MS.length + 1);
  });

  test("refusals and unknown failures are not retried", async () => {
    rpc.initializeWorkSource.mockResolvedValueOnce({
      ok: false,
      status: 409,
      code: "source_not_ready",
      error: "Fenced.",
      details: {},
    });
    await expect(ensureWorkSource({} as Env, repo, input, async () => {})).rejects.toMatchObject({
      status: 409,
      code: "source_not_ready",
    });
    rpc.initializeWorkSource.mockRejectedValueOnce(new Error("ls-refs failed with HTTP 403"));
    await expect(ensureWorkSource({} as Env, repo, input, async () => {})).rejects.toThrow(
      "HTTP 403",
    );
    expect(rpc.initializeWorkSource).toHaveBeenCalledTimes(2);
  });
});

test("transient Artifacts errors: provider failures and dropped remote connections only", () => {
  expect(isTransientArtifactsError(internal)).toBe(true);
  expect(isTransientArtifactsError({ code: "UPSTREAM_UNAVAILABLE" })).toBe(true);
  expect(isTransientArtifactsError(dropped)).toBe(true);
  // A remote binding's error keeps only its message.
  expect(isTransientArtifactsError(new Error("ArtifactsError: An internal error occurred."))).toBe(
    true,
  );
  expect(isTransientArtifactsError(forking)).toBe(true);
  expect(isTransientArtifactsError({ code: "NOT_FOUND" })).toBe(false);
  expect(isTransientArtifactsError({ code: "INVALID_INPUT" })).toBe(false);
  expect(isTransientArtifactsError(new Error("Repository was deleted."))).toBe(false);
  expect(isTransientArtifactsError("INTERNAL_ERROR")).toBe(false);
});
