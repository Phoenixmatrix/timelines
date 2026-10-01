import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { invalidateMembers } from "../../core/virtual.ts";
import { makeHarness, type Harness } from "../../testing/harness.ts";
import { metadataText, sha256, uploadBody, wheel } from "./testing.ts";

const JSON_ACCEPT = "application/vnd.pypi.simple.v1+json";
// PATCH replaces the member list, so tests resend it.
const MEMBERS = [{ key: "pypi-remote" }, { key: "local" }];

describe("pypi remote and virtual repositories", () => {
  let h: Harness;
  let admin: string;
  const hits: string[] = [];
  const upstreamWheel = wheel("demo", "1.0");
  const upstreamMeta = metadataText("demo", "1.0");
  const wheelUrl = "https://files.example.com/packages/ab/cd/demo-1.0-py3-none-any.whl";
  let servedWheel: Uint8Array = upstreamWheel;
  let upstreamFormat: "json" | "html" = "json";

  const upstreamPage = () => {
    if (upstreamFormat === "html") {
      return new Response(
        `<html><body><a href="${wheelUrl}#sha256=${sha256(upstreamWheel)}" data-requires-python="&gt;=3.8" data-core-metadata="sha256=${sha256(upstreamMeta)}">demo-1.0-py3-none-any.whl</a></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    }
    return Response.json(
      {
        meta: { "api-version": "1.1" },
        name: "demo",
        versions: ["1.0"],
        files: [
          {
            filename: "demo-1.0-py3-none-any.whl",
            url: wheelUrl,
            hashes: { sha256: sha256(upstreamWheel) },
            "requires-python": ">=3.8",
            "core-metadata": { sha256: sha256(upstreamMeta) },
            yanked: false,
            size: upstreamWheel.length,
            "upload-time": "2024-01-01T00:00:00.000000Z",
          },
        ],
      },
      { headers: { "content-type": "application/vnd.pypi.simple.v1+json" } },
    );
  };

  beforeEach(async () => {
    invalidateMembers();
    hits.length = 0;
    servedWheel = upstreamWheel;
    upstreamFormat = "json";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      hits.push(`${url.host}${url.pathname}`);
      if (url.host === "pypi.example.com" && url.pathname === "/simple/demo/") {
        expect(new Headers(init?.headers).get("accept")).toContain(
          "application/vnd.pypi.simple.v1+json",
        );
        return upstreamPage();
      }
      if (url.toString() === wheelUrl) return new Response(servedWheel);
      if (url.toString() === `${wheelUrl}.metadata`) return new Response(upstreamMeta);
      return new Response("not found", { status: 404 });
    });
    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({ key: "local", format: "pypi", kind: "local", visibility: "public" });
    await h.createRepo({
      key: "pypi-remote",
      format: "pypi",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://pypi.example.com" },
    });
    await h.createRepo({
      key: "all",
      format: "pypi",
      kind: "virtual",
      visibility: "public",
      config: { defaultDeployRepo: "local" },
      members: MEMBERS,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const upload = (
    path: string,
    name: string,
    version: string,
    filename: string,
    data: Uint8Array,
  ) => {
    const { body, contentType } = uploadBody({ name, version, filename, data });
    return h.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${admin}`, "content-type": contentType },
      body,
    });
  };

  it("rewrites upstream file links to this registry and caches files", async () => {
    const res = await h.request("/pypi/pypi-remote/simple/demo/");
    expect(res.status).toBe(200);
    const html = await res.text();
    const local = `https://pkg.test/pypi/pypi-remote/remote-files/demo/${sha256(upstreamWheel)}/demo-1.0-py3-none-any.whl`;
    expect(html).toContain(`href="${local}#sha256=${sha256(upstreamWheel)}"`);
    expect(html).toContain(`data-core-metadata="sha256=${sha256(upstreamMeta)}"`);
    expect(html).not.toContain("files.example.com");

    const json = (await (
      await h.request("/pypi/pypi-remote/simple/demo/", { headers: { accept: JSON_ACCEPT } })
    ).json()) as { files: { url: string; size: number }[]; versions: string[] };
    expect(json.files[0]).toMatchObject({ url: local, size: upstreamWheel.length });
    expect(json.versions).toEqual(["1.0"]);

    const path = new URL(local).pathname;
    const first = await h.request(path);
    expect(first.status).toBe(200);
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(upstreamWheel);
    const second = await h.request(path);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(upstreamWheel);
    expect(hits.filter((x) => x.startsWith("files.example.com"))).toHaveLength(1);
    // The page is cached too.
    expect(hits.filter((x) => x === "pypi.example.com/simple/demo/")).toHaveLength(1);

    const meta = await h.request(`${path}.metadata`);
    expect(await meta.text()).toBe(upstreamMeta);

    const index = await h.request("/pypi/pypi-remote/simple/", {
      headers: { accept: JSON_ACCEPT },
    });
    expect(await index.json()).toMatchObject({ projects: [{ name: "demo" }] });
  });

  it("parses HTML-only upstreams", async () => {
    upstreamFormat = "html";
    const doc = (await (
      await h.request("/pypi/pypi-remote/simple/demo/", { headers: { accept: JSON_ACCEPT } })
    ).json()) as { meta: Record<string, string>; files: Record<string, unknown>[] };
    expect(doc.meta["api-version"]).toBe("1.0");
    expect(doc.files[0]).toMatchObject({
      filename: "demo-1.0-py3-none-any.whl",
      "requires-python": ">=3.8",
    });
  });

  it("only fetches URLs that appear in upstream metadata", async () => {
    const sha = sha256(upstreamWheel);
    expect(
      (await h.request(`/pypi/pypi-remote/remote-files/demo/${sha}/evil-1.0.tar.gz`)).status,
    ).toBe(404);
    expect(
      (
        await h.request(
          `/pypi/pypi-remote/remote-files/demo/${"0".repeat(64)}/demo-1.0-py3-none-any.whl`,
        )
      ).status,
    ).toBe(404);
    expect((await h.request("/pypi/pypi-remote/remote-files/demo/xyz/a.whl")).status).toBe(404);
    expect(hits.some((x) => x.startsWith("files.example.com"))).toBe(false);
  });

  it("verifies upstream files against the published sha256", async () => {
    servedWheel = new TextEncoder().encode("tampered");
    const res = await h.request(
      `/pypi/pypi-remote/remote-files/demo/${sha256(upstreamWheel)}/demo-1.0-py3-none-any.whl`,
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("serves upstream projects through the virtual repository with its own URLs", async () => {
    const html = await (await h.request("/pypi/all/simple/demo/")).text();
    const url = `https://pkg.test/pypi/all/remote-files/demo/${sha256(upstreamWheel)}/demo-1.0-py3-none-any.whl`;
    expect(html).toContain(url);
    const file = await h.request(new URL(url).pathname);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(upstreamWheel);
  });

  it("prefers local projects and deploys uploads to the default repository", async () => {
    const local = wheel("demo", "2.0");
    const res = await upload("/pypi/all/", "demo", "2.0", "demo-2.0-py3-none-any.whl", local);
    expect(res.status).toBe(200);
    const doc = (await (
      await h.request("/pypi/all/simple/demo/", { headers: { accept: JSON_ACCEPT } })
    ).json()) as { files: { filename: string; url: string }[] };
    expect(doc.files.map((f) => f.filename)).toEqual(["demo-2.0-py3-none-any.whl"]);
    expect(doc.files[0]!.url).toBe(
      "https://pkg.test/pypi/all/packages/demo/2.0/demo-2.0-py3-none-any.whl",
    );
    const file = await h.request("/pypi/all/packages/demo/2.0/demo-2.0-py3-none-any.whl");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(local);
    expect(hits).toEqual([]);
    expect((await h.request("/pypi/local/simple/demo/")).status).toBe(200);
  });

  it("merges files across members with mergeVersions", async () => {
    await h.request("/api/v1/repositories/all", {
      method: "PATCH",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({
        config: { defaultDeployRepo: "local", mergeVersions: true },
        members: MEMBERS,
      }),
    });
    invalidateMembers();
    await upload(
      "/pypi/local/",
      "demo",
      "2.0",
      "demo-2.0.tar.gz",
      new TextEncoder().encode("sdist"),
    );
    const doc = (await (
      await h.request("/pypi/all/simple/demo/", { headers: { accept: JSON_ACCEPT } })
    ).json()) as { files: { filename: string }[]; versions: string[] };
    expect(doc.files.map((f) => f.filename).sort()).toEqual([
      "demo-1.0-py3-none-any.whl",
      "demo-2.0.tar.gz",
    ]);
    expect(doc.versions).toEqual(["1.0", "2.0"]);
  });

  it("keeps pinned namespaces away from remotes", async () => {
    await h.request("/api/v1/repositories/all", {
      method: "PATCH",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({
        config: { defaultDeployRepo: "local", pinnedNamespaces: ["demo"] },
        members: MEMBERS,
      }),
    });
    invalidateMembers();
    expect((await h.request("/pypi/all/simple/demo/")).status).toBe(404);
    expect(hits).toEqual([]);
    // Other names still reach the remote.
    expect((await h.request("/pypi/all/simple/other/")).status).toBe(404);
    expect(hits).toEqual(["pypi.example.com/simple/other/"]);
  });
});
