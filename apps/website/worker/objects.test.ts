import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { RepoReader, splitRefPath } from "./objects.ts";
import { Timing } from "./timing.ts";

afterEach(() => vi.unstubAllGlobals());

describe("splitRefPath", () => {
  const names = ["main", "jun/feature"];
  const oid = "d4ab1d76ba279828d6bee91662507022755f3a7f";

  test("finds a plain branch and path", () => {
    expect(splitRefPath("main/src/index.js", names)).toEqual({ ref: "main", path: "src/index.js" });
  });

  test("prefers the longest branch name that matches", () => {
    expect(splitRefPath("jun/feature/src", names)).toEqual({ ref: "jun/feature", path: "src" });
    expect(splitRefPath("jun/feature", names)).toEqual({ ref: "jun/feature", path: "" });
  });

  test("falls back to the first segment for commit ids and unknown refs", () => {
    expect(splitRefPath(`${oid}/readme.md`, names)).toEqual({ ref: oid, path: "readme.md" });
  });

  test("does not match a branch that is only a string prefix", () => {
    expect(splitRefPath("mainline/x", names)).toEqual({ ref: "mainline", path: "x" });
  });

  test("an empty tail means the default branch", () => {
    expect(splitRefPath("", names)).toEqual({ ref: "", path: "" });
  });
});

test("a failed request does not poison another reader's concurrent commit load", async () => {
  vi.stubGlobal("caches", {
    default: {
      match: async () => undefined,
      put: async () => undefined,
    },
  });
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<ArtifactsCommitMetadata | null>();
  const oid = "1111111111111111111111111111111111111111";
  const commit = { hash: oid } as ArtifactsCommitMetadata;
  const get = vi
    .fn()
    .mockResolvedValueOnce({
      readCommit: () => {
        started.resolve();
        return pending.promise;
      },
      [Symbol.dispose]() {},
    })
    .mockResolvedValueOnce({
      readCommit: async () => commit,
      [Symbol.dispose]() {},
    });
  const artifacts: Pick<Env["ARTIFACTS"], "get"> = { get };
  const env = { ARTIFACTS: artifacts } as Env;
  const first = new RepoReader(env, "request-isolation", "", new Timing(), () => {}).commit(oid);
  await started.promise;
  const second = new RepoReader(env, "request-isolation", "", new Timing(), () => {}).commit(oid);
  const results = Promise.allSettled([first, second]);
  const closed = new Error("Originating request closed");
  pending.reject(closed);
  expect(await results).toEqual([
    { status: "rejected", reason: closed },
    { status: "fulfilled", value: commit },
  ]);
});
