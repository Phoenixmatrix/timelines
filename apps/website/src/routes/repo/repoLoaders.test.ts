// A repository page reads its detail once, and an expired work source still
// fails its code pages instead of showing an empty repository (CORE-444).

import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { LoaderFunctionArgs } from "react-router";
import { forgetAllRepoData } from "../../lib/repoData.ts";
import { codeLoader } from "./Code.tsx";
import { commitsLoader } from "./Commits.tsx";
import { repoLoader } from "./RepoLayout.tsx";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
let reads: string[] = [];
let expired = false;
/** Paths whose answer waits until the test releases it. */
let held = new Map<string, Promise<void>>();

function detail() {
  return {
    id: "r_demo",
    name: "demo",
    space: { slug: "orbit" },
    defaultBranch: "main",
    state: "ready",
    ...(expired
      ? {
          source: {
            sourceId: "w-1",
            repoId: "r_demo",
            kind: "timeline-work",
            ref: "refs/heads/work",
          },
          sourceState: "expired",
          head: null,
          branches: [],
          tags: [],
        }
      : {
          sourceState: "ready",
          head: HEAD,
          branches: ["main", "timeline/feature"].map((shortName) => ({
            name: `refs/heads/${shortName}`,
            shortName,
            kind: "branch",
            oid: HEAD,
          })),
          tags: [],
        }),
  };
}

beforeEach(() => {
  forgetAllRepoData();
  reads = [];
  expired = false;
  held = new Map();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      reads.push(input);
      const path = new URL(input, "https://gitmatrix.test").pathname;
      await held.get(path);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (path === "/api/repos/orbit/demo") return json(detail());
      // Every Git read of an expired source fails, as the server's would.
      if (expired)
        return json({ error: "This code source has expired.", code: "source_expired" }, 410);
      if (path === "/api/repos/orbit/demo/tree")
        return json({ ref: "main", path: "", oid: HEAD, entries: [] });
      if (path === "/api/repos/orbit/demo/history")
        return json({ ref: "timeline/feature", head: HEAD, path: "", commits: [] });
      return json({});
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

const args = (url: string, wildcard = ""): LoaderFunctionArgs =>
  ({
    request: new Request(`https://gitmatrix.test${url}`),
    params: { space: "orbit", repo: "demo", "*": wildcard },
    context: undefined,
  }) as unknown as LoaderFunctionArgs;

const detailReads = () =>
  reads.filter(
    (input) => new URL(input, "https://gitmatrix.test").pathname === "/api/repos/orbit/demo",
  );

test("the layout and the code page share one detail request", async () => {
  const [layout, code] = await Promise.all([
    repoLoader(args("/orbit/demo")),
    codeLoader(args("/orbit/demo")),
  ]);
  expect(layout.head).toBe(HEAD);
  expect(code.tree).toMatchObject({ oid: HEAD });
  expect(detailReads()).toEqual(["/api/repos/orbit/demo?metadata=1"]);
});

test("the layout and the history page share one detail request in a timeline's scope", async () => {
  const [, history] = await Promise.all([
    repoLoader(args("/orbit/demo/commits?source=canonical&tl=feature")),
    commitsLoader(args("/orbit/demo/commits?source=canonical&tl=feature")),
  ]);
  expect(history).toMatchObject({ ref: "timeline/feature" });
  expect(detailReads()).toEqual(["/api/repos/orbit/demo?metadata=1&source=canonical"]);
});

test("the About rail's reads start beside the tree, and none of them holds up the page", async () => {
  const hold = (path: string) => {
    let release!: () => void;
    held.set(path, new Promise<void>((resolve) => (release = resolve)));
    return release;
  };
  const releaseTree = hold("/api/repos/orbit/demo/tree");
  const releaseSummary = hold("/api/repos/orbit/demo/tracker/summary");
  try {
    const loading = codeLoader(args("/orbit/demo?tl=main"));
    let loaded = false;
    void loading.then(() => (loaded = true));
    // With the tree still on its way, every rail read has already been asked for.
    await vi.waitFor(() => {
      const paths = reads.map((input) => new URL(input, "https://gitmatrix.test"));
      expect(paths.map((url) => url.pathname)).toEqual(
        expect.arrayContaining([
          "/api/repos/orbit/demo/tree",
          "/api/repos/orbit/demo/knowledge/graph/node",
          "/api/repos/orbit/demo/ci",
          "/api/repos/orbit/demo/tracker/summary",
        ]),
      );
      const summary = paths.find((url) => url.pathname.endsWith("/tracker/summary"));
      expect(summary?.searchParams.get("timeline")).toBe("main");
    });
    expect(loaded).toBe(false);
    // The page renders on the detail and the tree; the Tracker's count streams in later.
    releaseTree();
    const code = await loading;
    expect(code.tree).toMatchObject({ oid: HEAD });
    expect(code.rail).not.toBeNull();
    await expect(code.rail!.ci).resolves.toEqual({});
    let counted = false;
    void code.rail!.issues.then(() => (counted = true));
    await Promise.resolve();
    expect(counted).toBe(false);
    releaseSummary();
    await expect(code.rail!.issues).resolves.toEqual({});
  } finally {
    releaseTree();
    releaseSummary();
  }
});

for (const url of ["/orbit/demo?source=w-1", "/orbit/demo?source=w-1&tl=feature"])
  test(`an expired work source fails the code page with its expiry (${url})`, async () => {
    expired = true;
    // The layout keeps the repository's identity…
    expect(await repoLoader(args(url))).toMatchObject({ sourceState: "expired", head: null });
    // …while its code is gone, not empty.
    await expect(codeLoader(args(url))).rejects.toMatchObject({
      data: { message: "This code source has expired." },
      init: { status: 410 },
    });
    expect(detailReads()).toHaveLength(1);
    // A timeline's scope asks for no tree it already knows is gone.
    if (url.includes("tl=")) expect(reads.some((input) => input.includes("/tree"))).toBe(false);
  });

test("an expired work source fails history in a timeline's scope with its expiry", async () => {
  expired = true;
  await expect(
    commitsLoader(args("/orbit/demo/commits?source=w-1&tl=feature")),
  ).rejects.toMatchObject({
    data: { message: "This code source has expired." },
    init: { status: 410 },
  });
});
