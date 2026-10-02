import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { RouterContextProvider, type LoaderFunctionArgs } from "react-router";
import { trackerIndexLoader, trackerLoader } from "./loaders.ts";

const owners = [
  { id: "ann", slug: "ann", displayName: "Ann", canAdmin: true },
  { id: "org", slug: "orbit", displayName: "Orbit", canAdmin: false },
];
function args(path: string, owner = "orbit") {
  return {
    request: new Request(`https://example.com${path}`),
    url: new URL(`https://example.com${path}`),
    pattern: "/tracker/:owner",
    params: { owner },
    context: new RouterContextProvider(),
  } satisfies LoaderFunctionArgs;
}
function reply(body: unknown, status = 200) {
  const fetch = vi.fn().mockResolvedValue(Response.json(body, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
afterEach(() => vi.unstubAllGlobals());

describe("tracker navigation", () => {
  test("loads a direct tracker with one cancellable request and no session or repository preflight", async () => {
    const view = { snapshot: { owner: owners[1], issues: [] }, trackers: owners };
    const fetch = reply(view);
    const input = args("/tracker/orbit");
    expect(await trackerLoader(input)).toEqual(view);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/api/tracker/orbit/view",
      expect.objectContaining({ signal: input.request.signal }),
    );
  });
  test("uses the authenticated viewer's saved owner and preserves explicit URL state", async () => {
    const fetch = reply({ viewerId: "ann", trackers: owners });
    const getItem = vi
      .fn()
      .mockReturnValue(
        JSON.stringify({ ownerId: "org", view: "board", query: "is:open", teamId: "" }),
      );
    vi.stubGlobal("localStorage", { getItem });
    const result = await trackerIndexLoader(args("/tracker?view=graph&q=")).catch((e) => e);
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe("/tracker/orbit?view=graph&q=");
    expect(getItem).toHaveBeenCalledWith("gitmatrix:tracker-defaults:ann");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe("/api/tracker");
  });
  test("falls back to an accessible owner when a saved membership has been removed", async () => {
    reply({ viewerId: "ann", trackers: owners });
    vi.stubGlobal("localStorage", {
      getItem: () =>
        JSON.stringify({ ownerId: "removed", view: "list", query: "is:open", teamId: "" }),
    });
    const result = await trackerIndexLoader(args("/tracker")).catch((e) => e);
    expect(result.headers.get("location")).toBe("/tracker/ann");
  });
  test("handles an empty owner list", async () => {
    reply({ viewerId: "ann", trackers: [] });
    expect(await trackerIndexLoader(args("/tracker"))).toEqual({ trackers: [] });
  });
  for (const loader of [trackerIndexLoader, trackerLoader]) {
    test(`${loader.name} redirects an expired session with a return URL`, async () => {
      reply({ error: "Sign in" }, 401);
      const result = await loader(args("/tracker/orbit?view=board")).catch((e) => e);
      expect(result.status).toBe(302);
      expect(result.headers.get("location")).toBe("/signin?next=%2Ftracker%2Forbit%3Fview%3Dboard");
    });
  }
  test("preserves forbidden and missing tracker errors instead of redirecting to sign in", async () => {
    for (const status of [403, 404]) {
      reply({ error: "Unavailable" }, status);
      await expect(trackerLoader(args("/tracker/orbit"))).rejects.toMatchObject({
        data: { message: "Unavailable" },
        init: { status },
      });
    }
  });
});
