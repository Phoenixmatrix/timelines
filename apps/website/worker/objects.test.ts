import { afterEach, describe, expect, onTestFinished, test, vi } from "vite-plus/test";
import {
  forgetRefs,
  forgetRefsMemory,
  invalidateRefs,
  RepoReader,
  splitRefPath,
  type RepoReaderOptions,
} from "./objects.ts";
import { UPSTREAM_TIMEOUT_MS } from "./retry.ts";
import { Timing } from "./timing.ts";
import { fakeRemotes } from "./testing/remote.ts";
import { createFreshSpaceTestEnvironment } from "./testing/spaces.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

describe("refs shared through the Cache API under a refs generation (CORE-444)", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);

  /**
   * One canonical repository and a work source in a migrated D1, one Artifacts
   * remote, a Map-backed caches.default shared by every "isolate" (with no
   * delete: nothing may rely on one), and readers whose background work can be
   * awaited. forgetRefsMemory() starts another isolate.
   */
  async function world(name: string) {
    // Only Date: retries and timeouts keep real timers.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    const fresh = await createFreshSpaceTestEnvironment();
    onTestFinished(fresh.close);
    const { sqlite } = fresh;
    sqlite.exec("PRAGMA foreign_keys = OFF");
    sqlite.exec(`
      INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
        VALUES ('repo-${name}', 'space', '${name}', 'private', '${name}', 'https://artifacts.test/${name}');
      INSERT INTO timeline_work_sources (source_id, repo_id, timeline_id, timeline_slug, space_id,
          artifacts_name, artifacts_remote, state, allocation_operation_id, fork_source_id,
          fork_commit, fork_tree, fork_ref, initial_source_id, initial_commit, initial_tree,
          initial_ref, initial_token_revoked, created_at, updated_at)
        VALUES ('work-${name}', 'repo-${name}', 'timeline', 'feature', 'space', 'w-${name}',
          'https://artifacts.test/w-${name}', 'ready', 'allocate', 'canonical', '${A}', 'tree',
          'refs/heads/main', 'canonical', '${A}', 'tree', 'refs/heads/main', 1, '2026-01-01',
          '2026-01-01');
    `);
    const db = fresh.env.DB;
    const remotes = fakeRemotes();
    const url = `https://artifacts.test/${name}`;
    const remote = remotes.add(
      url,
      { "refs/heads/main": A, "refs/heads/work": B, "refs/tags/v1": A },
      "refs/heads/main",
      name,
    );
    const fetch = vi.fn(remotes.fetch);
    vi.stubGlobal("fetch", fetch);
    const store = new Map<string, Response>();
    const cache = {
      match: vi.fn(async (key: string) => store.get(key)?.clone()),
      put: vi.fn(async (key: string, value: Response) => {
        store.set(key, value.clone());
      }),
    };
    vi.stubGlobal("caches", { default: cache });
    const get = vi.fn(remotes.artifacts.get);
    const env = { ARTIFACTS: { ...remotes.artifacts, get }, DB: db } as unknown as Env;
    const generationOf = (table: "repos" | "timeline_work_sources", artifactsName = name) =>
      (
        sqlite
          .prepare(`SELECT refs_generation AS g FROM ${table} WHERE artifacts_name = ?`)
          .get(artifactsName) as { g: number }
      ).g;
    /** What api/repos.ts loads with the row at the start of a request. */
    const shared = (): RepoReaderOptions => ({
      sharedRefs: { generation: generationOf("repos") },
    });
    const background: Promise<unknown>[] = [];
    const read = async (options: RepoReaderOptions = shared(), sourceRef?: string) => {
      const timing = new Timing();
      const reader = new RepoReader(
        env,
        name,
        url,
        timing,
        (work) => background.push(work),
        sourceRef,
        options,
      );
      try {
        return { refs: await reader.refs(), header: timing.header() };
      } finally {
        await reader.close();
      }
    };
    const settle = async () => {
      while (background.length) await Promise.all(background.splice(0));
    };
    const stored = async (generation: number) =>
      (await store
        .get(`https://objects.gitmatrix.internal/${name}/refs/v2/${generation}`)
        ?.clone()
        .json()) as { startedAt: number; refs: { head: string } } | undefined;
    const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
    /** A ref write through another isolate or colo: only D1 moves here. */
    const writeElsewhere = (oid: string) => {
      remote.refs.set("refs/heads/main", oid);
      sqlite
        .prepare("UPDATE repos SET refs_generation = refs_generation + 1 WHERE artifacts_name = ?")
        .run(name);
    };
    /** Hold the next listing's answer, already read from Artifacts, until released. */
    const holdNextListing = () => {
      const release = Promise.withResolvers<void>();
      const answered = Promise.withResolvers<void>();
      const live = fetch.getMockImplementation()!;
      fetch.mockImplementationOnce(async (input, init) => {
        const response = await live(input, init);
        answered.resolve();
        await release.promise;
        return response;
      });
      return { answered: answered.promise, release: () => release.resolve() };
    };
    return {
      sqlite,
      db,
      remote,
      fetch,
      get,
      cache,
      read,
      shared,
      settle,
      stored,
      advance,
      generationOf,
      writeElsewhere,
      holdNextListing,
    };
  }

  afterEach(() => forgetRefsMemory());

  test("a fresh isolate serves refs from the Cache API without asking Artifacts", async () => {
    const w = await world("shared-fresh");
    const listed = await w.read();
    expect(listed.header).toContain("ls-refs");
    await w.settle();
    expect(await w.stored(0)).toMatchObject({ startedAt: Date.now(), refs: { head: A } });

    forgetRefsMemory();
    w.advance(1_000);
    const fetches = w.fetch.mock.calls.length;
    const gets = w.get.mock.calls.length;
    const shared = await w.read();
    expect(shared.refs).toEqual(listed.refs);
    expect(shared.header).toContain('refs-cache;desc="refs-cache x1"');
    expect(shared.header).not.toContain("ls-refs");
    expect(w.fetch).toHaveBeenCalledTimes(fetches);
    expect(w.get).toHaveBeenCalledTimes(gets);
    // …and fills this isolate's memory.
    expect((await w.read()).header).toContain("refs-memory");
  });

  test("a stale cache entry is served once while a background listing rewrites it", async () => {
    const w = await world("shared-stale");
    await w.read();
    await w.settle();
    forgetRefsMemory();
    // Changed in Artifacts without a bump: only age bounds it.
    w.remote.refs.set("refs/heads/main", C);
    w.advance(60_000);
    const stale = await w.read();
    expect(stale.refs.head).toBe(A);
    expect(stale.header).toContain("refs-cache-stale");
    await w.settle();
    expect(await w.stored(0)).toMatchObject({ startedAt: Date.now(), refs: { head: C } });
    expect((await w.read()).refs.head).toBe(C);
    forgetRefsMemory();
    const next = await w.read();
    expect(next.refs.head).toBe(C);
    expect(next.header).toContain("refs-cache;");
  });

  test("an entry older than REFS_STALE_MS is not served", async () => {
    const w = await world("shared-expired");
    await w.read();
    await w.settle();
    forgetRefsMemory();
    w.remote.refs.set("refs/heads/main", C);
    w.advance(10 * 60_000);
    const listed = await w.read();
    expect(listed.refs.head).toBe(C);
    expect(listed.header).toContain("ls-refs");
    expect(listed.header).not.toContain("refs-cache");
  });

  test("a write in another isolate or colo leaves earlier refs unreachable, with no delete", async () => {
    const w = await world("shared-elsewhere");
    await w.read();
    await w.settle();
    w.writeElsewhere(C);
    // This isolate still remembers generation 0, the Cache API still holds it.
    expect(await w.stored(0)).toMatchObject({ refs: { head: A } });
    const here = await w.read();
    expect(here.refs.head).toBe(C);
    expect(here.header).toContain("ls-refs");
    await w.settle();
    forgetRefsMemory();
    const cold = await w.read();
    expect(cold.refs.head).toBe(C);
    expect(cold.header).toContain("refs-cache;");
  });

  test("a listing that started before a write elsewhere is never served after it", async () => {
    const w = await world("shared-race-elsewhere");
    const held = w.holdNextListing();
    const before = w.read();
    await held.answered;
    w.writeElsewhere(C);
    held.release();
    // Its own request read before the write ended: it may get the old refs…
    expect((await before).refs.head).toBe(A);
    await w.settle();
    // …stored under the generation it loaded, which nothing asks for any more.
    expect(await w.stored(0)).toMatchObject({ refs: { head: A } });
    expect(await w.stored(1)).toBeUndefined();
    for (const isolate of ["same", "cold"]) {
      if (isolate === "cold") forgetRefsMemory();
      const after = await w.read();
      expect(after.refs.head, isolate).toBe(C);
      expect(after.header, isolate).not.toMatch(/refs-memory|refs-stale/);
    }
  });

  test("a listing that started before this isolate's push keeps nothing", async () => {
    const w = await world("shared-race-here");
    const held = w.holdNextListing();
    const before = w.read();
    await held.answered;
    w.remote.refs.set("refs/heads/main", C);
    await invalidateRefs(w.db, "shared-race-here");
    expect(w.generationOf("repos")).toBe(1);
    held.release();
    expect((await before).refs.head).toBe(A);
    await w.settle();
    expect(w.cache.put).not.toHaveBeenCalled();
    // Not even a reader without a generation gets it from memory.
    const unshared = await w.read({});
    expect(unshared.refs.head).toBe(C);
    expect(unshared.header).toContain("ls-refs");
  });

  test("a background refresh that started before this isolate's push keeps nothing", async () => {
    const w = await world("shared-refresh-race");
    await w.read({});
    w.advance(6_000);
    const held = w.holdNextListing();
    const stale = await w.read({});
    expect(stale.header).toContain("refs-stale");
    await held.answered;
    w.remote.refs.set("refs/heads/main", C);
    await invalidateRefs(w.db, "shared-refresh-race");
    held.release();
    await w.settle();
    const after = await w.read({});
    expect(after.refs.head).toBe(C);
    expect(after.header).toContain("ls-refs");
  });

  test("invalidateRefs bumps only the row that owns the Artifacts repository", async () => {
    const w = await world("shared-owners");
    await invalidateRefs(w.db, "w-shared-owners");
    expect(w.generationOf("timeline_work_sources", "w-shared-owners")).toBe(1);
    expect(w.generationOf("repos")).toBe(0);
    await invalidateRefs(w.db, "shared-owners");
    await invalidateRefs(w.db, "shared-owners");
    expect(w.generationOf("repos")).toBe(2);
    expect(w.generationOf("timeline_work_sources", "w-shared-owners")).toBe(1);
  });

  test("a failed bump is logged, not thrown", async () => {
    const w = await world("shared-bump-failed");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    w.sqlite.close();
    await expect(invalidateRefs(w.db, "shared-bump-failed")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      "refs generation bump failed",
      "shared-bump-failed",
      expect.anything(),
    );
    error.mockRestore();
  });

  test("a bump D1 never answers gives up after the timeout, logged, not thrown", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => error.mockRestore());
    const statement = { bind: () => statement };
    const batch = vi.fn(() => new Promise<never>(() => {}));
    const d1 = { prepare: () => statement, batch } as unknown as D1Database;
    let settled = false;
    const bump = invalidateRefs(d1, "shared-bump-stalled").then(() => {
      settled = true;
    });
    expect(batch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(UPSTREAM_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await bump;
    expect(settled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      "refs generation bump failed",
      "shared-bump-stalled",
      expect.objectContaining({ name: "TimeoutError" }),
    );
  });

  test("forgetRefs drops this isolate's refs without a bump", async () => {
    const w = await world("shared-forget");
    await w.read({});
    w.remote.refs.set("refs/heads/main", C);
    expect((await w.read({})).refs.head).toBe(A);
    forgetRefs("shared-forget");
    expect(w.generationOf("repos")).toBe(0);
    const after = await w.read({});
    expect(after.refs.head).toBe(C);
    expect(after.header).toContain("ls-refs");
  });

  test("a listing that started before forgetRefs keeps nothing", async () => {
    const w = await world("shared-forget-race");
    const held = w.holdNextListing();
    const before = w.read({});
    await held.answered;
    w.remote.refs.set("refs/heads/main", C);
    forgetRefs("shared-forget-race");
    held.release();
    expect((await before).refs.head).toBe(A);
    await w.settle();
    const after = await w.read({});
    expect(after.refs.head).toBe(C);
    expect(after.header).toContain("ls-refs");
  });

  test("cache hits keep a work source to its own ref", async () => {
    const w = await world("shared-work");
    await w.read();
    await w.settle();
    forgetRefsMemory();
    const work = await w.read(w.shared(), "refs/heads/work");
    expect(work.header).toContain("refs-cache;");
    expect(work.refs).toMatchObject({ headBranch: "work", head: B, tags: [] });
    expect(work.refs.branches.map((branch) => branch.name)).toEqual(["refs/heads/work"]);
  });

  test("readers without a generation never read or write the Cache API", async () => {
    const w = await world("shared-opt-in");
    const own = await w.read({});
    expect(own.refs.head).toBe(A);
    await w.settle();
    expect(w.cache.match).not.toHaveBeenCalled();
    expect(w.cache.put).not.toHaveBeenCalled();
    // A shared reader never takes refs listed without a generation.
    const shared = await w.read();
    expect(shared.header).toContain("ls-refs");
    await w.settle();

    // Another isolate's refs, read into this one's memory by a shared reader…
    forgetRefsMemory();
    expect((await w.read()).header).toContain("refs-cache;");
    const matches = w.cache.match.mock.calls.length;
    const puts = w.cache.put.mock.calls.length;
    // …are not served to a reader without a generation: it lists them itself.
    const unshared = await w.read({});
    expect(unshared.header).toContain("ls-refs");
    expect(unshared.header).not.toContain("refs-memory");
    await w.settle();
    expect(w.cache.match).toHaveBeenCalledTimes(matches);
    expect(w.cache.put).toHaveBeenCalledTimes(puts);
  });
});
