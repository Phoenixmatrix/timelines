// Reading references (CORE-22): what the palette treats as a direct jump,
// which issue keys a commit message cites, the commit panel's address, and
// the recent places store.

import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  commitHref,
  commitPanelUrl,
  inRepo,
  onlyPanelChanged,
  panelDepth,
  withCommit,
} from "./commitPanel.ts";
import { resetRefResolutions } from "../refs/resolver.ts";
import { RECENT_LIMIT, addRecent, readRecent, recentKey, rememberPlace } from "./recentPlaces.ts";
import {
  confirmIssueKeys,
  issueKeysIn,
  parseRef,
  resolveCommit,
  resolveJump,
  timelineJump,
  type JumpContext,
} from "./resolveRefs.ts";

describe("parseRef", () => {
  test("names each kind of reference", () => {
    expect(parseRef("CORE-22")).toEqual({ kind: "issue", key: "CORE-22" });
    expect(parseRef(" core-22 ")).toEqual({ kind: "issue", key: "CORE-22" });
    expect(parseRef("3F9A2C1")).toEqual({ kind: "commit", sha: "3f9a2c1" });
    expect(parseRef("a".repeat(40))).toEqual({ kind: "commit", sha: "a".repeat(40) });
    expect(parseRef("#12")).toEqual({ kind: "run", number: 12 });
    expect(parseRef("run 12")).toEqual({ kind: "run", number: 12 });
    expect(parseRef("orbit-kit@1.2.0")).toEqual({
      kind: "package",
      name: "orbit-kit",
      version: "1.2.0",
    });
    expect(parseRef("@orbit/kit@2.0.0-rc.1")).toEqual({
      kind: "package",
      name: "@orbit/kit",
      version: "2.0.0-rc.1",
    });
    expect(parseRef("timeline/fast-search")).toEqual({ kind: "timeline", slug: "fast-search" });
    expect(parseRef("tl:fast-search")).toEqual({ kind: "timeline", slug: "fast-search" });
  });

  test("words, short hex and phrases are searches, not references", () => {
    for (const text of ["", "fix login", "abc123", "deadbe", "CORE-", "#", "@scope/", "a b@c"])
      expect(parseRef(text), text).toBeNull();
  });
});

test("issueKeysIn finds each cited key once, as the autolinker does, not lookalikes", () => {
  expect(
    issueKeysIn("CORE-22: panel\n\nRefs CORE-22, WEB-3 and (OPS-14).\nutf-8 MY-KEY-2"),
  ).toEqual(["CORE-22", "WEB-3", "OPS-14"]);
});

describe("the panel's address", () => {
  const here = { pathname: "/orbit/engine/commits/main", search: "?tl=fast", state: null };

  test("opens over a page of the same repository, and anywhere else through the repository", () => {
    expect(commitPanelUrl("orbit", "engine", "ABC1234")).toBe("/orbit/engine?commit=abc1234");
    expect(withCommit(here, "abc1234")).toBe("/orbit/engine/commits/main?tl=fast&commit=abc1234");
    expect(withCommit({ pathname: "/o/r", search: "?commit=1&x=2" }, null)).toBe("/o/r?x=2");
    expect(inRepo("/orbit/engine", "orbit", "engine")).toBe(true);
    expect(inRepo("/orbit/engine-2", "orbit", "engine")).toBe(false);
    expect(commitHref(here, "orbit", "engine", "abc1234")).toEqual({
      to: "/orbit/engine/commits/main?tl=fast&commit=abc1234",
      state: { commitPanelDepth: 1 },
    });
    // A parent opened from the panel is one more step to go Back through.
    expect(
      commitHref({ ...here, state: { commitPanelDepth: 1 } }, "orbit", "engine", "def5678").state,
    ).toEqual({ commitPanelDepth: 2 });
    expect(
      commitHref(
        { pathname: "/tracker/orbit", search: "", state: null },
        "orbit",
        "engine",
        "abc1234",
      ),
    ).toEqual({
      to: "/orbit/engine?commit=abc1234",
      state: undefined,
    });
    expect(panelDepth({ commitPanelDepth: -2 })).toBe(0);
    expect(panelDepth("nonsense")).toBe(0);
  });

  test("only a change of panel keeps the page from reloading", () => {
    const at = (path: string) => new URL(path, "https://gm.test");
    expect(onlyPanelChanged(at("/o/r/ci?x=1"), at("/o/r/ci?x=1&commit=abc"))).toBe(true);
    expect(onlyPanelChanged(at("/o/r/ci?commit=abc"), at("/o/r/ci?commit=def"))).toBe(true);
    expect(onlyPanelChanged(at("/o/r/ci?commit=abc"), at("/o/r/ci"))).toBe(true);
    expect(onlyPanelChanged(at("/o/r/ci"), at("/o/r/ci"))).toBe(false);
    expect(onlyPanelChanged(at("/o/r/ci?x=1"), at("/o/r/ci?x=2&commit=abc"))).toBe(false);
    expect(onlyPanelChanged(at("/o/r/ci"), at("/o/r/commits?commit=abc"))).toBe(false);
  });
});

describe("recent places", () => {
  const memory = () => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      map,
    } as unknown as Storage & { map: Map<string, string> };
  };
  const place = (n: number) => ({
    kind: "repo" as const,
    title: `orbit/r${n}`,
    detail: "",
    to: `/orbit/r${n}`,
  });

  test("newest first, one per address, at most eight, per viewer", () => {
    const storage = memory();
    for (let n = 0; n < 12; n++) rememberPlace("acc_1", place(n), storage, n);
    rememberPlace("acc_1", place(9), storage, 99);
    const recent = readRecent("acc_1", storage);
    expect(recent).toHaveLength(RECENT_LIMIT);
    expect(recent.map((p) => p.title).slice(0, 3)).toEqual(["orbit/r9", "orbit/r11", "orbit/r10"]);
    expect(readRecent("acc_2", storage)).toEqual([]);
    expect(addRecent([], { ...place(1), at: 1 })).toHaveLength(1);
  });

  test("broken or hostile storage reads as nothing and never throws", () => {
    const storage = memory();
    storage.setItem(recentKey("acc_1"), "{not json");
    expect(readRecent("acc_1", storage)).toEqual([]);
    storage.setItem(
      recentKey("acc_1"),
      JSON.stringify([
        { ...place(1), at: 1, to: "https://evil.example" },
        { ...place(2), at: 2 },
      ]),
    );
    expect(readRecent("acc_1", storage).map((p) => p.to)).toEqual(["/orbit/r2"]);
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(readRecent("acc_1", throwing)).toEqual([]);
    expect(() => rememberPlace("acc_1", place(1), throwing)).not.toThrow();
  });
});

describe("resolveJump through the reference resolver (POST /api/refs/resolve)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetRefResolutions();
  });
  const signal = new AbortController().signal;
  const context: JumpContext = {
    here: { pathname: "/orbit/engine/ci", search: "", state: null },
    repo: { owner: { slug: "orbit" } as never, name: "engine" },
    tracker: "orbit",
    owner: "orbit",
    recentRepos: [],
    timelines: [{ slug: "fast-search", name: "Fast search", owner: "orbit" }],
  };
  const sha = "abc1234".padEnd(40, "0");
  const commit = (repo: string) => ({
    kind: "commit",
    path: `/orbit/${repo}?commit=${sha}`,
    label: "",
    owner: "orbit",
    repo,
    sha,
  });
  const issue = (tracker: string) => ({
    kind: "issue",
    path: `/tracker/${tracker}/issues/i1`,
    label: "Issue",
    tracker,
    id: "i1",
    key: "CORE-22",
    title: "Navigate",
    status: "todo",
  });
  /** Answers each POST with `answer(ref, context)`, and records the contexts asked. */
  const resolver = (answer: (ref: string, context: Record<string, string>) => unknown) => {
    const asked: Record<string, string>[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect(input as string).toBe("/api/refs/resolve");
      const body = JSON.parse(init?.body as string) as {
        refs: string[];
        context: Record<string, string>;
      };
      asked.push(body.context);
      return new Response(
        JSON.stringify({ results: body.refs.map((ref) => answer(ref, body.context)) }),
        { headers: { "content-type": "application/json" } },
      );
    });
    return asked;
  };

  test("an issue key, in the page's context; an ambiguous key offers each", async () => {
    const asked = resolver((ref) => ({
      ref,
      status: "ambiguous",
      candidates: [issue("orbit"), issue("ann")],
    }));
    const jumps = await resolveJump({ kind: "issue", key: "CORE-22" }, context, signal);
    expect(jumps.map((jump) => jump.to)).toEqual([
      "/tracker/orbit/issues/i1",
      "/tracker/ann/issues/i1",
    ]);
    expect(asked).toEqual([{ owner: "orbit", repo: "engine", tracker: "orbit" }]);
  });

  test("a SHA in a repository opens its full hash over the page, one Back step deep", async () => {
    resolver((ref) => ({ ref, status: "resolved", target: commit("engine") }));
    const [jump] = await resolveJump({ kind: "commit", sha: "abc1234" }, context, signal);
    expect(jump).toMatchObject({
      to: `/orbit/engine/ci?commit=${sha}`,
      state: { commitPanelDepth: 1 },
    });
  });

  test("outside a repository, a SHA is looked for in the repositories visited recently", async () => {
    const asked = resolver((ref, where) =>
      where.repo === "website"
        ? { ref, status: "resolved", target: commit("website") }
        : { ref, status: "unresolved" },
    );
    const jumps = await resolveJump(
      { kind: "commit", sha: "abc1234" },
      {
        ...context,
        here: { pathname: "/tracker/orbit", search: "", state: null },
        repo: null,
        recentRepos: [
          { owner: "orbit", name: "engine" },
          { owner: "orbit", name: "website" },
        ],
      },
      signal,
    );
    expect(jumps.map((jump) => jump.to)).toEqual([`/orbit/website?commit=${sha}`]);
    expect(new Set(asked.map((where) => where.repo))).toEqual(new Set(["engine", "website"]));
  });

  test("an unknown hash is no commit; timelines and runs need no resolver", async () => {
    resolver((ref) => ({ ref, status: "unresolved" }));
    expect(await resolveCommit("orbit", "engine", "abc1234", signal)).toBeNull();
    expect(await resolveCommit("orbit", "engine", sha, signal)).toBe(sha);
    expect(await resolveJump({ kind: "commit", sha: "abc1234" }, context, signal)).toEqual([]);
    expect(await resolveJump({ kind: "timeline", slug: "fast-search" }, context, signal)).toEqual([
      timelineJump(context.timelines[0]!),
    ]);
    expect(
      await resolveJump({ kind: "run", number: 4 }, { ...context, repo: null }, signal),
    ).toEqual([]);
  });

  test("message keys: only resolved issues link; ambiguous and unknown stay text", async () => {
    resolver((ref) =>
      ref === "CORE-22"
        ? { ref, status: "resolved", target: issue("orbit") }
        : ref === "WEB-1"
          ? { ref, status: "ambiguous", candidates: [issue("a"), issue("b")] }
          : { ref, status: "unresolved" },
    );
    const found = await confirmIssueKeys(
      ["CORE-22", "WEB-1", "OPS-8"],
      { owner: "orbit", name: "engine" },
      signal,
    );
    expect([...found.keys()]).toEqual(["CORE-22"]);
  });
});
