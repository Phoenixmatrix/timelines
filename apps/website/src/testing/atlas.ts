// Atlas fixtures for browser-mode tests: a repository in the test's world
// whose Atlas is projected from shared/atlasFixture.ts without a model, the
// way the non-AI E2E does it (POST /api/dev/atlas, worker/atlas/fixture.ts).

import { expect } from "vite-plus/test";
import type { AtlasFixtureVariant } from "../../shared/atlasFixture.ts";
import type { TestServer } from "./server.ts";

/** A random commit id. */
export function commitId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export interface AtlasFixtureRepo {
  owner: string;
  name: string;
  /** /api/repos/:owner/:name */
  api: string;
  /** The Knowledge tab. */
  base: string;
  head: string;
  first: { snapshotId: string; seq: number };
  /** POST /api/dev/atlas for this repository. */
  dev<T = unknown>(body: Record<string, unknown>): Promise<T>;
}

/** A repository with the fixture's files at `main` and its Atlas published. */
export async function atlasFixtureRepo(
  server: TestServer,
  {
    owner = "orbit",
    name = "fixture",
    variant = "base" as AtlasFixtureVariant,
    /** An npm package the registry should say this repository publishes. */
    publishes = undefined as string | undefined,
    visibility = "public" as "public" | "private",
  } = {},
): Promise<AtlasFixtureRepo> {
  await server.repo(owner, name, visibility);
  const head = commitId();
  await server.push(`${owner}/${name}`, "main", head);
  const dev = <T = unknown>(body: Record<string, unknown>) =>
    server.call<T>("POST", "/api/dev/atlas", { repo: `${owner}/${name}`, ...body });
  const first = await dev<{ snapshotId: string; seq: number }>({
    action: "publish",
    commit: head,
    ...(variant === "base" ? {} : { variant }),
    ...(publishes ? { publishes } : {}),
  });
  return {
    owner,
    name,
    api: `/api/repos/${owner}/${name}`,
    base: `/${owner}/${name}/knowledge`,
    head,
    first,
    dev,
  };
}

/** Wait until the page has made no request for `ms`: what a test means by "settled". */
export async function settled(server: TestServer, ms = 300): Promise<void> {
  let count = -1;
  let since = Date.now();
  await expect
    .poll(
      () => {
        if (server.requests.length !== count) {
          count = server.requests.length;
          since = Date.now();
        }
        return Date.now() - since >= ms;
      },
      { timeout: 10_000, interval: 50 },
    )
    .toBe(true);
}

const ATLAS_ROUTE = /\/atlas\/([a-z]+)$/;

/** The Atlas reads since `mark`: route and id. */
export function atlasCalls(server: TestServer, mark: number) {
  return server.since(mark).flatMap((r) => {
    const route = ATLAS_ROUTE.exec(r.url.pathname)?.[1];
    return route ? [{ path: r.url.pathname, route, id: r.url.searchParams.get("id") }] : [];
  });
}

/** Nothing browsing does may reach search, a model-backed index or another repository's graph. */
export function expectNoPaidFanOut(server: TestServer, mark: number, api: string) {
  for (const { url } of server.since(mark)) {
    expect(url.pathname, "knowledge search").not.toContain("/knowledge/search");
    expect(url.pathname, "global search").not.toBe("/api/search");
    expect(url.pathname, "the whole graph").not.toContain("/graph");
    if (url.pathname.includes("/atlas/"))
      expect(url.pathname.startsWith(`${api}/atlas/`)).toBe(true);
  }
}

/** How far the page scrolls sideways: 0 when nothing is wider than the viewport. */
export function sidewaysOverflow(): number {
  return document.documentElement.scrollWidth - document.documentElement.clientWidth;
}
