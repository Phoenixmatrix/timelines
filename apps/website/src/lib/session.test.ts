import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ShouldRevalidateFunctionArgs } from "react-router";
import type { SessionResponse, Viewer } from "../../shared/api.ts";
import { forgetAllRepoData, repoData } from "./repoData.ts";
import {
  accessChanged,
  accessEpoch,
  loadSession,
  onAccessChange,
  rootShouldRevalidate,
  sessionScope,
  syncAccess,
} from "./session.ts";
import { trackerShouldRevalidate } from "../routes/tracker/loaders.ts";

const origin = "https://gitmatrix.test";

function args(
  from: string,
  to: string,
  extra: Partial<ShouldRevalidateFunctionArgs> = {},
): ShouldRevalidateFunctionArgs {
  const currentUrl = new URL(from, origin);
  const nextUrl = new URL(to, origin);
  const params = (url: URL) => {
    const tracker = /^\/tracker\/([^/]+)/.exec(url.pathname);
    return tracker ? { space: decodeURIComponent(tracker[1]!) } : {};
  };
  return {
    currentUrl,
    nextUrl,
    currentParams: params(currentUrl),
    nextParams: params(nextUrl),
    defaultShouldRevalidate: true,
    ...extra,
  } as ShouldRevalidateFunctionArgs;
}

test("a page's session scope is its Space or Organization", () => {
  expect(sessionScope(new URL("/tracker/orbit/issues/a", origin))).toBe("space:orbit");
  expect(sessionScope(new URL("/orbit/demo/blob/main/README.md", origin))).toBe("space:orbit");
  expect(sessionScope(new URL("/orbit", origin))).toBe("space:orbit");
  expect(sessionScope(new URL("/orbit/-/repositories/new", origin))).toBe("space:orbit");
  expect(sessionScope(new URL("/settings/agents?space=orbit", origin))).toBe("space:orbit");
  expect(sessionScope(new URL("/organizations/acme", origin))).toBe("organization:acme");
  expect(sessionScope(new URL("/", origin))).toBe("");
  expect(sessionScope(new URL("/settings/tokens", origin))).toBe("");
});

test("the root reads the session again only across scopes, after submissions and on revalidation", () => {
  const root = (from: string, to: string, extra?: Partial<ShouldRevalidateFunctionArgs>) =>
    rootShouldRevalidate(args(from, to, extra));
  // Within one Space: the tracker, its issues, filters and timelines, its repositories.
  expect(root("/tracker/orbit", "/tracker/orbit/issues/a")).toBe(false);
  expect(root("/tracker/orbit/issues/a", "/tracker/orbit?q=is:open")).toBe(false);
  expect(root("/tracker/orbit", "/tracker/orbit?tl=work")).toBe(false);
  expect(root("/orbit/demo", "/orbit/demo/blob/main/README.md")).toBe(false);
  expect(root("/orbit", "/tracker/orbit")).toBe(false);
  // Another Space or Organization, or into and out of one.
  expect(root("/tracker/orbit", "/tracker/nova")).toBe(true);
  expect(root("/orbit/demo", "/nova/demo")).toBe(true);
  expect(root("/organizations/acme", "/acme-general")).toBe(true);
  expect(root("/", "/orbit")).toBe(true);
  expect(root("/orbit", "/settings/tokens")).toBe(true);
  // Submissions (unless they failed) and explicit revalidation.
  expect(root("/orbit", "/orbit", { formMethod: "POST" })).toBe(true);
  expect(
    root("/tracker/orbit", "/tracker/orbit/issues/a", {
      formMethod: "POST",
      defaultShouldRevalidate: false,
    }),
  ).toBe(false);
  expect(root("/tracker/orbit?q=x", "/tracker/orbit?q=x")).toBe(true);
});

test("the tracker reads its view on entering a Space or timeline, not for issues, keys or filters", () => {
  const tracker = (from: string, to: string, extra?: Partial<ShouldRevalidateFunctionArgs>) =>
    trackerShouldRevalidate(args(from, to, extra));
  expect(tracker("/tracker/orbit", "/tracker/orbit/issues/a")).toBe(false);
  expect(tracker("/tracker/orbit/issues/a", "/tracker/orbit/issues/b")).toBe(false);
  expect(tracker("/tracker/orbit/issues/a", "/tracker/orbit")).toBe(false);
  expect(tracker("/tracker/orbit", "/tracker/orbit?q=is:ready&sort=priority")).toBe(false);
  expect(tracker("/tracker/orbit", "/tracker/orbit/teams")).toBe(false);
  expect(tracker("/tracker/orbit?tl=work", "/tracker/orbit/issues/a?tl=work")).toBe(false);
  expect(tracker("/tracker/orbit", "/tracker/nova")).toBe(true);
  expect(tracker("/tracker/orbit", "/tracker/orbit?tl=work")).toBe(true);
  expect(tracker("/tracker/orbit?tl=work", "/tracker/orbit")).toBe(true);
  expect(tracker("/tracker/orbit", "/tracker/orbit", { formMethod: "POST" })).toBe(true);
  expect(tracker("/tracker/orbit", "/tracker/orbit")).toBe(true);
  // Filters the loader checks are still checked: refused, never broadened.
  expect(tracker("/tracker/orbit", "/tracker/orbit?project=p_1")).toBe(true);
  expect(tracker("/tracker/orbit", "/tracker/orbit?team=t_1")).toBe(true);
  expect(tracker("/tracker/orbit", "/tracker/orbit?q=workspace:old")).toBe(true);
  expect(tracker("/tracker/orbit", "/tracker/orbit?ws=old")).toBe(true);
});

// ---- access changes -----------------------------------------------------------

function viewer(id: string, overrides: Partial<Viewer> = {}): Viewer {
  return {
    kind: "user",
    id,
    slug: id,
    displayName: id,
    avatarUrl: null,
    isSiteAdmin: false,
    email: null,
    organizations: [],
    spaces: [],
    personalOrganizationId: null,
    defaultSpaceId: null,
    savedDefault: { organizationId: null, spaceId: null },
    agent: null,
    ...overrides,
  } as Viewer;
}

describe("a session read that differs", () => {
  let sessions: SessionResponse[] = [];
  let reads: string[] = [];
  /** Resolves the session read in flight, when one is held back. */
  let release: (() => void) | null = null;
  let hold = false;

  beforeEach(() => {
    forgetAllRepoData();
    accessChanged();
    sessions = [];
    reads = [];
    hold = false;
    release = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        reads.push(input);
        if (input === "/api/session") {
          const body = sessions.shift();
          if (hold) await new Promise<void>((resolve) => (release = resolve));
          return Response.json(body);
        }
        return Response.json({ read: reads.length });
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const navigation = () => new Request("https://gitmatrix.test/orbit/demo");
  const treeReads = () => reads.filter((read) => read.startsWith("/api/repos/"));

  test("empties every cache and reads the root again; the same one changes nothing", async () => {
    const revalidate = vi.fn();
    const stop = syncAccess({ revalidate }, "gitmatrix:access:node-test");
    sessions = [
      { viewer: viewer("acc_a") },
      { viewer: viewer("acc_a") },
      { viewer: viewer("acc_b") },
    ] as SessionResponse[];
    await loadSession(navigation());
    await repoData.tree("orbit", "demo", "main");
    await loadSession(navigation());
    await repoData.tree("orbit", "demo", "main");
    expect(treeReads()).toHaveLength(1);
    expect(revalidate).not.toHaveBeenCalled();

    await loadSession(navigation());
    expect(revalidate).toHaveBeenCalledTimes(1);
    await repoData.tree("orbit", "demo", "main");
    expect(treeReads()).toHaveLength(2);
    stop();
  });

  test("a changed default Space is a change too (Preferences, CORE-413)", async () => {
    const forgot = vi.fn();
    const stop = onAccessChange(forgot);
    sessions = [
      { viewer: viewer("acc_a", { defaultSpaceId: "spc_1" }) },
      {
        viewer: viewer("acc_a", {
          defaultSpaceId: "spc_2",
          savedDefault: { organizationId: "org_1", spaceId: "spc_2" },
        }),
      },
    ] as SessionResponse[];
    await loadSession(navigation());
    expect(forgot).not.toHaveBeenCalled();
    await loadSession(navigation());
    expect(forgot).toHaveBeenCalledTimes(1);
    stop();
  });

  test("a cached read waits for the session read in flight, so another identity never gets it", async () => {
    sessions = [{ viewer: viewer("acc_a") }, { viewer: viewer("acc_b") }] as SessionResponse[];
    await loadSession(navigation());
    const first = await repoData.tree("orbit", "demo", "main");
    // A navigation into another Space: its loaders run alongside the root's session read.
    hold = true;
    const session = loadSession(navigation());
    const tree = repoData.tree("orbit", "demo", "main");
    await vi.waitFor(() => expect(release).not.toBeNull());
    release!();
    await session;
    expect(await tree).not.toEqual(first);
    expect(treeReads()).toHaveLength(2);
  });

  test("an access epoch is per identity: what was read before a change isn't served after it", async () => {
    const epoch = accessEpoch();
    await repoData.tree("orbit", "demo", "main");
    accessChanged();
    expect(accessEpoch()).toBe(epoch + 1);
    await repoData.tree("orbit", "demo", "main");
    expect(treeReads()).toHaveLength(2);
  });
});

describe("returning to the tab", () => {
  let reads: string[] = [];

  beforeEach(() => {
    forgetAllRepoData();
    accessChanged();
    reads = [];
    vi.useFakeTimers();
    const page = new EventTarget();
    vi.stubGlobal("window", page);
    vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("a session re-read that stalls never holds cache hits, and gives up after 10 s", async () => {
    let stall = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        reads.push(input);
        if (input === "/api/session" && stall)
          return new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)),
          );
        return Response.json(input === "/api/session" ? { viewer: viewer("acc_a") } : {});
      }),
    );
    const revalidate = vi.fn();
    const stop = syncAccess({ revalidate }, "gitmatrix:access:node-recheck");
    await loadSession(new Request("https://gitmatrix.test/orbit"));
    await repoData.tree("orbit", "demo", "main");

    stall = true;
    vi.advanceTimersByTime(20_000);
    window.dispatchEvent(new Event("focus"));
    expect(reads.filter((read) => read === "/api/session")).toHaveLength(2);
    // A hit (fresh again: the clock moved) answers while the re-read hangs.
    await repoData.tree("orbit", "demo", "main");
    await repoData.tree("orbit", "demo", "main");
    expect(reads.filter((read) => read.startsWith("/api/repos/"))).toHaveLength(2);

    // It gives up, and the next return to the tab reads again.
    await vi.advanceTimersByTimeAsync(10_000);
    stall = false;
    vi.advanceTimersByTime(20_000);
    window.dispatchEvent(new Event("focus"));
    expect(reads.filter((read) => read === "/api/session")).toHaveLength(3);
    stop();
  });
});
