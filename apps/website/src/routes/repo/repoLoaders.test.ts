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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      reads.push(input);
      const path = new URL(input, "https://gitmatrix.test").pathname;
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
