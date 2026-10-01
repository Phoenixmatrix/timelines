import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { invalidateMembers } from "../../core/virtual.ts";
import { makeHarness, type Harness } from "../../testing/harness.ts";

describe("generic remote and virtual repositories", () => {
  let h: Harness;
  let admin: string;
  const upstreamHits: string[] = [];

  beforeEach(async () => {
    invalidateMembers();
    upstreamHits.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      upstreamHits.push(url.pathname);
      if (url.pathname === "/dist/tool.tgz") return new Response("from-upstream", { status: 200 });
      return new Response("nope", { status: 404 });
    });
    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({ key: "local", format: "generic", kind: "local", visibility: "public" });
    await h.createRepo({
      key: "upstream",
      format: "generic",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://files.example.com" },
    });
    await h.createRepo({
      key: "all",
      format: "generic",
      kind: "virtual",
      visibility: "public",
      config: { defaultDeployRepo: "local" },
      members: [{ key: "upstream" }, { key: "local" }],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("caches upstream artifacts after the first fetch", async () => {
    const first = await h.request("/generic/upstream/dist/tool.tgz");
    expect(await first.text()).toBe("from-upstream");
    const second = await h.request("/generic/upstream/dist/tool.tgz");
    expect(await second.text()).toBe("from-upstream");
    expect(upstreamHits).toEqual(["/dist/tool.tgz"]);
  });

  it("caches upstream misses briefly", async () => {
    expect((await h.request("/generic/upstream/missing")).status).toBe(404);
    expect((await h.request("/generic/upstream/missing")).status).toBe(404);
    expect(upstreamHits).toEqual(["/missing"]);
  });

  it("prefers local members and deploys through the virtual repository", async () => {
    const put = await h.request("/generic/all/dist/tool.tgz", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}` },
      body: "local-copy",
    });
    expect(put.status).toBe(201);
    // The remote is listed first, but a local copy always wins.
    expect(await (await h.request("/generic/all/dist/tool.tgz")).text()).toBe("local-copy");
    expect(upstreamHits).toEqual([]);
  });

  it("falls through to remote members", async () => {
    expect(await (await h.request("/generic/all/dist/tool.tgz")).text()).toBe("from-upstream");
  });

  it("never sends pinned names upstream", async () => {
    await h.request("/api/v1/repositories/all", {
      method: "PATCH",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({
        config: { defaultDeployRepo: "local", pinnedNamespaces: ["dist/**"] },
      }),
    });
    invalidateMembers();
    expect((await h.request("/generic/all/dist/tool.tgz")).status).toBe(404);
    expect(upstreamHits).toEqual([]);
  });

  it("rejects upstreams that point at private hosts", async () => {
    const res = await h.createRepo({
      key: "evil",
      format: "generic",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://169.254.169.254" },
    });
    expect(res.status).toBe(201);
    expect((await h.request("/generic/evil/latest/meta-data")).status).toBe(502);
    expect(upstreamHits).toEqual([]);
  });
});
