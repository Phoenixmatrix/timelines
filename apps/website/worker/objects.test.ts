import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { RepoReader, splitRefPath } from "./objects.ts";
import { Timing } from "./timing.ts";
import { fakeRemotes } from "./testing/remote.ts";

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

test("work HEAD hides inherited refs without changing the shared physical ref cache", async () => {
  const remote = fakeRemotes();
  const main = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const progress = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  remote.add(
    "https://artifacts.test/work-head",
    {
      "refs/heads/main": main,
      "refs/heads/work": progress,
      "refs/tags/inherited": main,
    },
    "refs/heads/main",
    "work-head",
  );
  vi.stubGlobal("fetch", remote.fetch);
  const env = { ARTIFACTS: remote.artifacts } as unknown as Env;
  const raw = new RepoReader(
    env,
    "work-head",
    "https://artifacts.test/work-head",
    new Timing(),
    () => {},
  );
  const work = new RepoReader(
    env,
    "work-head",
    "https://artifacts.test/work-head",
    new Timing(),
    () => {},
    "refs/heads/work",
  );
  try {
    expect(await raw.resolve("HEAD")).toBe(main);
    expect(await work.resolve("HEAD")).toBe(progress);
    expect(await work.resolve("main")).toBeNull();
    expect(await work.resolve("inherited")).toBeNull();
    expect(await work.refs()).toMatchObject({ headBranch: "work", head: progress, tags: [] });
    expect((await work.refs()).branches.map((branch) => branch.name)).toEqual(["refs/heads/work"]);
    expect(await raw.resolve("HEAD")).toBe(main);
    expect(await raw.resolve("inherited")).toBe(main);
  } finally {
    await Promise.all([raw.close(), work.close()]);
  }
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

test("a missing blob can arrive later without becoming an empty file", async () => {
  const responses = new Map<string, Response>();
  vi.stubGlobal("caches", {
    default: {
      match: async (key: string) => responses.get(key)?.clone(),
      put: async (key: string, value: Response) => {
        responses.set(key, value.clone());
      },
    },
  });
  let blob: Blob | null = null;
  const get = vi.fn().mockImplementation(async () => ({
    readBlob: async () => blob,
    [Symbol.dispose]() {},
  }));
  const env = { ARTIFACTS: { get } } as unknown as Env;
  const read = async () => {
    const reader = new RepoReader(env, "late-work-object", "", new Timing(), () => {});
    try {
      return await reader.blob("2222222222222222222222222222222222222222");
    } finally {
      await reader.close();
    }
  };
  expect(await read()).toBeNull();
  expect(await read()).toBeNull();
  blob = new Blob(["retained source content"]);
  const arrived = await read();
  expect(new TextDecoder().decode(arrived!.bytes)).toBe("retained source content");
});

test("legacy empty cache entries cannot stand in for source content or hide empty blobs", async () => {
  vi.stubGlobal("caches", {
    default: { match: async () => new Response(""), put: async () => {} },
  });
  const get = vi.fn().mockImplementation(async () => ({
    readBlob: async (oid: string) => new Blob([oid.startsWith("3") ? "canonical base" : ""]),
    [Symbol.dispose]() {},
  }));
  const reader = new RepoReader(
    { ARTIFACTS: { get } } as unknown as Env,
    "legacy-blob-cache",
    "",
    new Timing(),
    () => {},
  );
  try {
    const content = await reader.blob("3333333333333333333333333333333333333333");
    expect(new TextDecoder().decode(content!.bytes)).toBe("canonical base");
    expect(await reader.blob("4444444444444444444444444444444444444444")).toEqual({
      size: 0,
      bytes: new Uint8Array(),
    });
  } finally {
    await reader.close();
  }
});
