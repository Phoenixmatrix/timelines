import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { CompareDiff } from "../../shared/diff.ts";
import { COMPARE_COMMITS } from "../../shared/diff.ts";
import { commitsSince } from "../compare.ts";
import { forgetObjectMemory } from "../objects.ts";
import type { RepoRefs } from "../artifacts.ts";
import { issueToken } from "./tokens.ts";
import { tokenCredential, type AppEnv } from "../auth.ts";
import { createFreshSpaceTestEnvironment, seedSpaceFixture } from "../testing/spaces.ts";
import { fakeHistory } from "../testing/history.ts";
import { Timing } from "../timing.ts";
import { repos } from "./repos.ts";

// Branch tips by Artifacts name: the git endpoint the reader would list refs from.
const tips = new Map<string, Record<string, string>>();
vi.mock("cloudflare:workers", () => import("../testing/runtime.ts"));
vi.mock("../artifacts.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../artifacts.ts")>()),
  listRefs: async (_env: Env, name: string): Promise<RepoRefs> => ({
    headBranch: "main",
    head: null,
    tags: [],
    branches: Object.entries(tips.get(name) ?? {}).map(([shortName, oid]) => ({
      name: `refs/heads/${shortName}`,
      shortName,
      kind: "branch" as const,
      oid,
    })),
  }),
}));

beforeEach(() => {
  vi.stubGlobal("caches", { default: { match: async () => undefined, put: async () => {} } });
  vi.stubGlobal("fetch", async () => {
    throw new Error("no network in tests");
  });
});
const closers: { close(): void }[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const closer of closers.splice(0)) closer.close();
});

async function setup(visibility = "private") {
  const fresh = await createFreshSpaceTestEnvironment();
  closers.push(fresh);
  const { sqlite } = fresh;
  const id = crypto.randomUUID();
  const mainName = `cmp-${id}`;
  const workName = `cmp-work-${id}`;
  sqlite.exec(`
    INSERT INTO accounts (id, kind, slug, display_name) VALUES
      ('ann', 'user', 'ann', 'Ann'), ('bob', 'user', 'bob', 'Bob');
  `);
  // Ann reads orbit's repositories through her explicit Space grant; Bob has none.
  await seedSpaceFixture(fresh.env.DB, {
    organization: { id: "org_orbit", slug: "orbit-org", displayName: "Orbit", kind: "company" },
    space: { id: "orbit", slug: "orbit", displayName: "General" },
    members: [
      {
        accountId: "ann",
        role: "owner",
        grant: { role: "admin", repositoryRole: "write", packageRole: "write" },
      },
    ],
    actorId: "ann",
  });
  sqlite.exec(`
    INSERT INTO repos (id, space_id, name, visibility, artifacts_name, artifacts_remote)
      VALUES ('app', 'orbit', 'app', '${visibility}', '${mainName}', 'https://app');
  `);
  // Canonical and the timeline's work source are separate repositories.
  const canonical = fakeHistory();
  const work = fakeHistory();
  // Remote reads per repository (CORE-400).
  const reads = {
    canonical: { readCommit: 0, readTree: 0, readBlob: 0 },
    work: { readCommit: 0, readTree: 0, readBlob: 0 },
  };
  const env = fresh.env;
  Reflect.set(env, "ARTIFACTS", {
    get: async (name: string) => {
      const side = name === workName ? "work" : "canonical";
      const repo = (await (side === "work" ? work : canonical).artifacts.get()) as Record<
        string,
        unknown
      >;
      for (const method of ["readCommit", "readTree", "readBlob"] as const) {
        const original = repo[method] as (oid: string) => Promise<unknown>;
        repo[method] = (oid: string) => {
          reads[side][method]++;
          return original(oid);
        };
      }
      return repo;
    },
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const credential = await tokenCredential(c);
    c.set("actor", credential.kind === "token" ? credential.actor : null);
    c.set("timing", new Timing());
    return next();
  });
  app.route("/api/repos", repos);
  const tokens = {
    ann: (await issueToken(env.DB, "ann", "t", "read")).secret,
    bob: (await issueToken(env.DB, "bob", "t", "read")).secret,
  };
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (work: Promise<unknown>) => pending.push(work),
    passThroughOnException: () => {},
    props: {},
  };
  const compare = async (query: string, who: keyof typeof tokens = "ann") => {
    const response = await app.request(
      `/api/repos/orbit/app/compare?${query}`,
      { headers: { authorization: `Bearer ${tokens[who]}` } },
      env,
      ctx as unknown as ExecutionContext,
    );
    while (pending.length) await Promise.all(pending.splice(0));
    return { status: response.status, response, body: (await response.json()) as CompareDiff };
  };
  const branches = (main: Record<string, string>, branch?: Record<string, string>) => {
    tips.set(mainName, main);
    if (branch) tips.set(workName, branch);
  };
  /** Records the same commit in both repositories, as a fork shares history. */
  const both = (spec: Parameters<typeof canonical.commit>[0]) => {
    work.commit(spec);
    return canonical.commit(spec);
  };
  const workSource = (forkCommit: string) =>
    sqlite.exec(`INSERT INTO timeline_work_sources
      (source_id,repo_id,timeline_id,timeline_slug,space_id,artifacts_name,artifacts_remote,state,
       allocation_operation_id,fork_source_id,fork_commit,fork_tree,fork_ref,
       initial_source_id,initial_commit,initial_tree,initial_ref,created_at,updated_at,initial_token_revoked)
      VALUES('work','app','timeline','test','orbit','${workName}','https://work','ready',
       'allocation','canonical','${forkCommit}','${"a".repeat(40)}','refs/heads/main',
       'canonical','${forkCommit}','${"a".repeat(40)}','refs/heads/main','now','now',1)`);
  return { canonical, work, compare, branches, both, workSource, reads };
}

describe("GET /compare", () => {
  test("a branch against main shows only the branch's commits and files", async () => {
    const { canonical, compare, branches } = await setup();
    const root = canonical.commit({ files: { "a.txt": "a\n", "b.txt": "b\n" }, message: "Start" });
    const one = canonical.commit({
      parents: [root],
      files: { "a.txt": "a\nA\n", "b.txt": "b\n" },
      message: "Change a\n\nlonger body",
    });
    const two = canonical.commit({
      parents: [one],
      files: { "a.txt": "a\nA\n", "b.txt": "b\n", "c.txt": "c\n" },
      message: "Add c",
    });
    branches({ main: root, feature: two });
    const { status, body } = await compare("base=main&head=feature");
    expect(status).toBe(200);
    expect([body.base, body.head, body.from, body.mergeBase]).toEqual([root, two, root, root]);
    expect([body.historyTruncated, body.commitsTruncated, body.truncated]).toEqual([
      false,
      false,
      false,
    ]);
    expect(body.commits.map((c) => [c.oid, c.summary, c.authorName])).toEqual([
      [two, "Add c", "Ann Lee"],
      [one, "Change a", "Ann Lee"],
    ]);
    expect(body.files.map((f) => [f.path, f.status])).toEqual([
      ["a.txt", "modified"],
      ["c.txt", "added"],
    ]);
  });

  test("base defaults to the default branch; oids work for both", async () => {
    const { canonical, compare, branches } = await setup();
    const root = canonical.commit({ files: { a: "a\n" } });
    const next = canonical.commit({ parents: [root], files: { a: "b\n" } });
    branches({ main: root, feature: next });
    const byName = (await compare("head=feature")).body;
    const byOid = await compare(`base=${root}&head=${next}`);
    expect(byOid.body).toEqual(byName);
    expect(byOid.response.headers.get("cache-control")).toContain("immutable");
    const named = await compare("base=main&head=feature");
    expect(named.response.headers.get("cache-control") ?? "").not.toContain("immutable");
  });

  test("main merged into the branch moves the merge base: main's changes are not the branch's", async () => {
    const { canonical, compare, branches } = await setup();
    const root = canonical.commit({ files: { a: "a\n", m: "m\n" } });
    const feature = canonical.commit({
      parents: [root],
      files: { a: "a\nfeature\n", m: "m\n" },
      message: "Feature work",
    });
    const mainNext = canonical.commit({
      parents: [root],
      files: { a: "a\n", m: "m\nmain\n" },
      message: "Main work",
    });
    const merge = canonical.commit({
      parents: [feature, mainNext],
      files: { a: "a\nfeature\n", m: "m\nmain\n" },
      message: "Merge main",
    });
    const after = canonical.commit({
      parents: [merge],
      files: { a: "a\nfeature\n", m: "m\nmain\n", n: "n\n" },
      message: "More feature",
    });
    branches({ main: mainNext, feature: after });
    const { body } = await compare("base=main&head=feature");
    expect(body.mergeBase).toBe(mainNext);
    expect(body.from).toBe(mainNext);
    expect(body.files.map((f) => f.path)).toEqual(["a", "n"]);
    // The merge's second parent is main's, so it is not listed.
    expect(body.commits.map((c) => c.oid)).toEqual([after, merge, feature]);
    expect(body.commits.map((c) => c.merge)).toEqual([false, true, false]);
  });

  test("main's work merged in after the base is listed as the merge, not commit by commit (CORE-382)", async () => {
    const { work, compare, branches, both, workSource } = await setup();
    const root = both({ files: { a: "a\n", m: "m\n" }, message: "Fork point" });
    const first = work.commit({
      parents: [root],
      files: { a: "a\none\n", m: "m\n" },
      message: "Checkpoint 1",
    });
    const mainWork = work.commit({
      parents: [root],
      files: { a: "a\n", m: "m\nmain\n" },
      message: "Main work",
    });
    const merge = work.commit({
      parents: [first, mainWork],
      files: { a: "a\none\n", m: "m\nmain\n" },
      message: "Merge main",
    });
    const second = work.commit({
      parents: [merge],
      files: { a: "a\none\ntwo\n", m: "m\nmain\n" },
      message: "Checkpoint 2",
    });
    branches({ main: root }, { work: second });
    workSource(root);
    const { body } = await compare(`source=work&head=${second}&base=${first}`);
    expect(body.commits.map((c) => [c.summary, c.merge])).toEqual([
      ["Checkpoint 2", false],
      ["Merge main", true],
    ]);
  });

  test("a missing tree is a 404, not a server error (CORE-382)", async () => {
    const { canonical, compare, branches } = await setup();
    const root = canonical.commit({ files: { a: "a\n" } });
    const next = canonical.commit({ parents: [root], files: { a: "b\n" } });
    canonical.commits.set(next, { ...canonical.commits.get(next)!, treeHash: "b".repeat(40) });
    branches({ main: root, feature: next });
    const { status, body } = await compare("base=main&head=feature");
    expect(status).toBe(404);
    expect((body as unknown as { error: string }).error).toBe(
      "Part of this history isn't available.",
    );
  });

  test("a timeline work source compares against a main commit that exists only in canonical", async () => {
    const { canonical, work, compare, branches, both, workSource } = await setup();
    const root = both({ files: { a: "a\n", m: "m\n" }, message: "Fork point" });
    const step = work.commit({
      parents: [root],
      files: { a: "a\nwork\n", m: "m\n" },
      message: "Timeline step",
    });
    // Main moved on after the fork; the work source never saw this commit.
    const mainNext = canonical.commit({
      parents: [root],
      files: { a: "a\n", m: "m\nmain\n" },
      message: "Main moves",
    });
    branches({ main: mainNext }, { work: step });
    workSource(root);
    const { status, body } = await compare("source=work&head=work&base=main");
    expect(status).toBe(200);
    expect([body.base, body.head, body.from, body.mergeBase]).toEqual([mainNext, step, root, root]);
    expect(body.files.map((f) => [f.path, f.status])).toEqual([["a", "modified"]]);
    expect(body.commits.map((c) => c.summary)).toEqual(["Timeline step"]);
    // Unnamed head and base by oid reach the same result.
    expect((await compare(`source=work&head=${step}&base=${mainNext}`)).body.files).toEqual(
      body.files,
    );
  });

  test("a base may be the timeline's own commit, such as an earlier checkpoint (CORE-382)", async () => {
    const { work, compare, branches, both, workSource } = await setup();
    const root = both({ files: { a: "a\n" }, message: "Fork point" });
    const first = work.commit({
      parents: [root],
      files: { a: "a\none\n" },
      message: "Checkpoint 1",
    });
    const second = work.commit({
      parents: [first],
      files: { a: "a\none\n", b: "b\n" },
      message: "Checkpoint 2",
    });
    branches({ main: root }, { work: second });
    workSource(root);
    const { status, body } = await compare(`source=work&head=${second}&base=${first}`);
    expect(status).toBe(200);
    expect([body.from, body.mergeBase]).toEqual([first, first]);
    expect(body.files.map((f) => [f.path, f.status])).toEqual([["b", "added"]]);
    expect(body.commits.map((c) => c.summary)).toEqual(["Checkpoint 2"]);
  });

  test("unrelated histories compare against base itself", async () => {
    const { canonical, compare, branches } = await setup();
    const main = canonical.commit({ files: { a: "a\n" }, message: "Main root" });
    const other = canonical.commit({ files: { b: "b\n" }, message: "Other root" });
    branches({ main, other });
    const { status, body } = await compare("base=main&head=other");
    expect(status).toBe(200);
    expect([body.from, body.mergeBase, body.historyTruncated]).toEqual([main, null, false]);
    expect(body.files.map((f) => [f.path, f.status])).toEqual([
      ["a", "deleted"],
      ["b", "added"],
    ]);
    expect(body.commits.map((c) => c.oid)).toEqual([other]);
  });

  test("the commit list is bounded", async () => {
    const { canonical, compare, branches } = await setup();
    const root = canonical.commit({ files: { n: "0\n" }, message: "Root" });
    let tip = root;
    for (let n = 1; n <= COMPARE_COMMITS + 5; n++)
      tip = canonical.commit({ parents: [tip], files: { n: `${n}\n` }, message: `Step ${n}` });
    branches({ main: root, feature: tip });
    const { body } = await compare("base=main&head=feature");
    expect(body.commits).toHaveLength(COMPARE_COMMITS);
    expect(body.commitsTruncated).toBe(true);
    expect(body.commits[0]!.oid).toBe(tip);
    expect(body.files.map((f) => f.path)).toEqual(["n"]);
  });

  test("private repositories look missing to outsiders", async () => {
    const { canonical, compare, branches } = await setup();
    const root = canonical.commit({ files: { a: "a\n" } });
    branches({ main: root });
    expect((await compare(`head=${root}`, "bob")).status).toBe(404);
    expect((await compare(`head=${root}`)).status).toBe(200);
  });

  test("malformed parameters are 400; unknown refs are 404", async () => {
    const { canonical, compare, branches } = await setup();
    const root = canonical.commit({ files: { a: "a\n" } });
    branches({ main: root });
    for (const query of [
      "",
      "head=",
      "head=a..b",
      "head=has space",
      "head=-x",
      `head=${root}&base=a..b`,
      `head=main/&base=main`,
    ])
      expect([query, (await compare(query)).status]).toEqual([query, 400]);
    expect((await compare("head=nope")).status).toBe(404);
    expect((await compare(`head=main&base=nope`)).status).toBe(404);
    expect((await compare(`head=${"f".repeat(40)}`)).status).toBe(404);
    expect((await compare(`head=main&base=${"f".repeat(40)}`)).status).toBe(404);
  });
});

describe("remote reads across a work source and canonical (CORE-400)", () => {
  /** A Cache API that remembers, as production's does. */
  const stubCache = () => {
    const stored = new Map<string, Response>();
    vi.stubGlobal("caches", {
      default: {
        match: async (key: string) => stored.get(key)?.clone(),
        put: async (key: string, value: Response) => void stored.set(key, value.clone()),
      },
    });
  };
  const total = (r: { readCommit: number; readTree: number; readBlob: number }) =>
    r.readCommit + r.readTree + r.readBlob;

  test("a warm cache makes no remote reads, main's own commits included", async () => {
    stubCache();
    const { canonical, work, compare, branches, both, workSource, reads } = await setup();
    const root = both({ files: { a: "a\n", m: "m\n" }, message: "Fork point" });
    const step = work.commit({ parents: [root], files: { a: "a\nwork\n", m: "m\n" } });
    let main = root;
    for (let n = 1; n <= 6; n++)
      main = canonical.commit({ parents: [main], files: { a: "a\n", m: `m${n}\n` } });
    branches({ main }, { work: step });
    workSource(root);
    const cold = await compare("source=work&head=work&base=main");
    expect(cold.status).toBe(200);
    expect(cold.body.files.map((f) => [f.path, f.status])).toEqual([["a", "modified"]]);
    expect(cold.body.commits.map((c) => c.oid)).toEqual([step]);
    const after = structuredClone(reads);
    const warm = await compare("source=work&head=work&base=main");
    expect(warm.body).toEqual(cold.body);
    expect(reads).toEqual(after);
  });

  test("a fresh isolate reads commits and trees from the Cache API, not the remote", async () => {
    stubCache();
    const { canonical, work, compare, branches, both, workSource, reads } = await setup();
    const root = both({ files: { a: "a\n", m: "m\n" }, message: "Fork point" });
    const step = work.commit({ parents: [root], files: { a: "a\nwork\n", m: "m\n" } });
    let main = root;
    for (let n = 1; n <= 6; n++)
      main = canonical.commit({ parents: [main], files: { a: "a\n", m: `m${n}\n` } });
    branches({ main }, { work: step });
    workSource(root);
    const cold = await compare("source=work&head=work&base=main");
    const after = structuredClone(reads);
    // Memory gone: only the peeked Cache API copies can keep the remote quiet.
    forgetObjectMemory();
    const warm = await compare("source=work&head=work&base=main");
    expect(warm.body).toEqual(cold.body);
    for (const side of ["work", "canonical"] as const) {
      expect(reads[side].readCommit).toBe(after[side].readCommit);
      expect(reads[side].readTree).toBe(after[side].readTree);
    }
  });

  test("main moved far past the fork costs the work source a constant number of misses", async () => {
    stubCache();
    const { canonical, work, compare, branches, both, workSource, reads } = await setup();
    const root = both({ files: { a: "a\n", m: "m\n" }, message: "Fork point" });
    const step = work.commit({ parents: [root], files: { a: "a\nwork\n", m: "m\n" } });
    let main = root;
    for (let n = 1; n <= 12; n++)
      main = canonical.commit({
        parents: [main],
        files: { a: "a\n", m: "m\n", [`f${n}`]: `${n}\n` },
      });
    branches({ main }, { work: step });
    workSource(root);
    const { status, body } = await compare("source=work&head=work&base=main");
    expect(status).toBe(200);
    expect([body.base, body.head, body.from, body.mergeBase]).toEqual([main, step, root, root]);
    // Without the preference this was one miss per main commit, tree and blob.
    expect(total(reads.work)).toBeLessThanOrEqual(2 + 6);
    expect(reads.work.readCommit).toBeLessThanOrEqual(2);
    expect(reads.canonical.readCommit).toBeGreaterThanOrEqual(12);
  });

  test("an object only the work source has is still found", async () => {
    stubCache();
    const { canonical, work, compare, branches, both, workSource } = await setup();
    const root = both({ files: { a: "a\n" }, message: "Fork point" });
    const first = work.commit({ parents: [root], files: { a: "a\n", w: "w\n" } });
    const second = work.commit({ parents: [first], files: { a: "a\n", w: "w\n2\n" } });
    const main = canonical.commit({ parents: [root], files: { a: "a\nmain\n" } });
    branches({ main }, { work: second });
    workSource(root);
    // Base given as a work commit id: not assumed canonical.
    const { status, body } = await compare(`source=work&head=${second}&base=${first}`);
    expect(status).toBe(200);
    expect(body.files.map((f) => [f.path, f.status])).toEqual([["w", "modified"]]);
    expect((await compare("source=work&head=work&base=main")).body.mergeBase).toBe(root);
  });
});

describe("commitsSince", () => {
  test("committer dates running backwards don't list what the excluded side reaches (CORE-382)", async () => {
    const { canonical } = await setup();
    // `shared` is newer than the commits built on it, so it is read before the
    // excluded side has painted it.
    const root = canonical.commit({ files: { a: "0\n" }, at: 100 });
    const shared = canonical.commit({ parents: [root], files: { a: "1\n" }, at: 300 });
    const excluded = canonical.commit({ parents: [shared], files: { a: "2\n" }, at: 200 });
    const head = canonical.commit({ parents: [shared], files: { a: "3\n" }, at: 400 });
    const reader = { commit: async (oid: string) => canonical.commits.get(oid) ?? null };
    const { commits, truncated } = await commitsSince(reader, head, excluded);
    expect(commits.map((c) => c.oid)).toEqual([head]);
    expect(truncated).toBe(false);
  });
});
