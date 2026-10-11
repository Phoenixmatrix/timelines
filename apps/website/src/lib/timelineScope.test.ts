import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createMemoryRouter } from "react-router";
import {
  bookmarkIn,
  carryScope,
  scopeLinks,
  scopeOf,
  scopeOwner,
  scopeRedirect,
  switchScope,
  timelineScopeMiddleware,
  withScope,
} from "./timelineScope.ts";

afterEach(() => vi.unstubAllGlobals());

describe("the timeline scope", () => {
  test("?tl= names a timeline; nothing, main or a malformed slug is main", () => {
    expect(scopeOf("?tl=search-v2&q=x")).toBe("search-v2");
    expect(scopeOf("?q=x")).toBeNull();
    expect(scopeOf("?tl=main")).toBeNull();
    expect(scopeOf("?tl=Not%20a%20slug")).toBeNull();
    expect(scopeOf(new URLSearchParams({ tl: "ranking" }))).toBe("ranking");
  });

  test("links carry the current scope unless they name one", () => {
    expect(carryScope("/orbit/engine/ci", "search")).toBe("/orbit/engine/ci?tl=search");
    expect(carryScope("/tracker/orbit?q=is%3Aopen#top", "search")).toBe(
      "/tracker/orbit?q=is%3Aopen&tl=search#top",
    );
    expect(carryScope("/tracker/orbit?tl=main", "search")).toBe("/tracker/orbit?tl=main");
    expect(carryScope("/tracker/orbit?tl=other", "search")).toBe("/tracker/orbit?tl=other");
    expect(carryScope("/orbit/engine", null)).toBe("/orbit/engine");
    // Downloads and other hosts aren't pages.
    expect(carryScope("/api/repos/orbit/engine/archive", "search")).toBe(
      "/api/repos/orbit/engine/archive",
    );
    expect(carryScope("https://example.com/", "search")).toBe("https://example.com/");
  });

  test("leaving a timeline names main, so it isn't carried back", () => {
    expect(withScope("/tracker/orbit?tl=search&q=x", null)).toBe("/tracker/orbit?tl=main&q=x");
    expect(withScope("/orbit/engine#readme", "search")).toBe("/orbit/engine?tl=search#readme");
  });

  test("pushes keep the scope; back, forward and reloads keep what the URL says", () => {
    const target = { pathname: "/orbit/engine/ci", search: "" };
    expect(scopeRedirect(target, { search: "?tl=search" })).toEqual({
      to: "/orbit/engine/ci?tl=search",
      replace: false,
    });
    expect(scopeRedirect(target, null)).toBeNull();
    expect(scopeRedirect(target, { search: "?tl=main" })).toBeNull();
    expect(scopeRedirect({ ...target, search: "?tl=main" }, { search: "?tl=search" })).toBeNull();
  });

  test("the Knowledge tab's old ?timeline= becomes ?tl=", () => {
    expect(
      scopeRedirect(
        { pathname: "/orbit/engine/knowledge", search: "?node=repo&timeline=search" },
        null,
      ),
    ).toEqual({ to: "/orbit/engine/knowledge?node=repo&tl=search", replace: true });
    expect(
      scopeRedirect(
        { pathname: "/orbit/engine/knowledge", search: "?timeline=search&tl=ranking" },
        null,
      ),
    ).toEqual({ to: "/orbit/engine/knowledge?tl=ranking", replace: true });
    // Elsewhere `timeline` means nothing to the scope.
    expect(scopeRedirect({ pathname: "/orbit/engine", search: "?timeline=x" }, null)).toBeNull();
  });

  test("the account a page is about", () => {
    expect(scopeOwner("/tracker/orbit/timelines")).toBe("orbit");
    expect(scopeOwner("/tracker")).toBeNull();
    expect(scopeOwner("/orbit/engine/tree/main/src")).toBe("orbit");
    expect(scopeOwner("/orbit/-/packages/npm/web")).toBe("orbit");
    expect(scopeOwner("/orbit")).toBe("orbit");
    expect(scopeOwner("/settings/preferences", "?tracker=orbit")).toBe("orbit");
    for (const page of ["ai", "retention", "usage", "tokens", "preferences"])
      expect(scopeOwner(`/settings/${page}`, "?owner=orbit")).toBe("orbit");
    expect(scopeOwner("/settings/preferences", "?owner=orbit&tracker=marco")).toBe("orbit");
    expect(scopeOwner("/settings/ai", "?tracker=orbit")).toBeNull();
    for (const page of ["/", "/highlights", "/needs-you", "/packages", "/settings/tokens", "/new"])
      expect(scopeOwner(page)).toBeNull();
  });

  test("switching follows code refs to the new timeline's bookmark, or main's", () => {
    const repo = { defaultBranch: "main", branches: ["main", "timeline/search", "topic"] };
    const at = (pathname: string, search = "") => ({ pathname, search });
    expect(switchScope(at("/orbit/engine/tree/main/src/app.ts"), "search", repo)).toBe(
      "/orbit/engine/tree/timeline/search/src/app.ts?tl=search",
    );
    expect(
      switchScope(at("/orbit/engine/blob/timeline/search/a.ts", "?tl=search"), null, repo),
    ).toBe("/orbit/engine/blob/main/a.ts?tl=main");
    // A repository the new timeline doesn't touch shows main.
    expect(
      switchScope(at("/orbit/engine/commits/timeline/search", "?tl=search"), "ranking", repo),
    ).toBe("/orbit/engine/commits/main?tl=ranking");
    // Other branches are kept: the path asked for them.
    expect(switchScope(at("/orbit/engine/tree/topic/src"), "search", repo)).toBe(
      "/orbit/engine/tree/topic/src?tl=search",
    );
    expect(switchScope(at("/tracker/orbit", "?q=x&tl=search"), "ranking")).toBe(
      "/tracker/orbit?q=x&tl=ranking",
    );
  });

  test("switching work sources preserves the file path but replaces source identity; leaving clears it", () => {
    const source = {
      sourceId: "work_parent",
      repoId: "repo",
      kind: "timeline-work" as const,
      timelineId: "parent",
      ref: "refs/heads/work",
    };
    const targetSource = { ...source, sourceId: "work_child", timelineId: "child" };
    const location = {
      pathname: "/orbit/engine/blob/work/src/a.ts",
      search: "?tl=parent&source=work_parent",
      hash: "#L4",
    };
    expect(
      switchScope(location, "child", {
        defaultBranch: "main",
        branches: ["work"],
        source,
        targetSource,
      }),
    ).toBe("/orbit/engine/blob/work/src/a.ts?tl=child&source=work_child#L4");
    expect(switchScope(location, null, { defaultBranch: "main", branches: ["work"], source })).toBe(
      "/orbit/engine/blob/main/src/a.ts?tl=main#L4",
    );
  });

  test("a repository opens on the bookmark only when the timeline touches it", () => {
    const repo = { branches: [{ shortName: "main" }, { shortName: "timeline/search" }] };
    expect(bookmarkIn(repo, "search")).toBe("timeline/search");
    expect(bookmarkIn(repo, "ranking")).toBeNull();
    expect(bookmarkIn(repo, null)).toBeNull();
  });
});

describe("the router carries the scope", () => {
  const page = { loader: () => null, Component: () => null };
  const routes = [
    {
      path: "/",
      middleware: [timelineScopeMiddleware],
      loader: () => null,
      children: [
        { path: "tracker/:owner", ...page },
        { path: ":owner/:repo/*", ...page },
      ],
    },
  ];
  /** A memory router whose "address bar" is the stubbed window.location. */
  function app(at: string) {
    const location = new URL(`https://gm.test${at}`);
    vi.stubGlobal("window", { location });
    const router = createMemoryRouter(routes, { initialEntries: [at] });
    scopeLinks(router);
    const settle = () => {
      const url = new URL(`https://gm.test${router.createHref(router.state.location)}`);
      location.href = url.href;
    };
    return { router, settle };
  }

  test("navigating from a scoped page keeps the scope; leaving names main", async () => {
    const { router, settle } = app("/tracker/orbit?tl=search");
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    settle();
    await router.navigate("/orbit/engine/ci");
    expect(router.state.location.pathname).toBe("/orbit/engine/ci");
    expect(router.state.location.search).toBe("?tl=search");
    settle();
    await router.navigate("/orbit/engine?tl=main");
    expect(router.state.location.search).toBe("?tl=main");
    settle();
    await router.navigate("/tracker/orbit");
    expect(router.state.location.search).toBe("");
  });

  test("hrefs carry the scope of the page they're on", async () => {
    const { router } = app("/tracker/orbit?tl=search");
    await vi.waitFor(() => expect(router.state.initialized).toBe(true));
    const href = (to: string) => router.createHref(new URL(`https://gm.test${to}`));
    expect(href("/orbit/engine/ci")).toBe("/orbit/engine/ci?tl=search");
    expect(href("/orbit/engine?tl=main")).toBe("/orbit/engine?tl=main");
  });
});
