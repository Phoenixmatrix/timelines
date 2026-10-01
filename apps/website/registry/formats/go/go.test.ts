import { strToU8, zipSync } from "@gitmatrix/formats/archive";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { invalidateMembers } from "../../core/virtual.ts";
import { basic, makeHarness, type Harness } from "../../testing/harness.ts";

function moduleZip(module: string, version: string, files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, data]) => [`${module}@${version}/${name}`, strToU8(data)]),
    ),
  );
}

describe("go local repositories", () => {
  let h: Harness;
  let writer: string;

  const put = (path: string, body: Uint8Array, token = writer) =>
    h.request(`/go/gomod/${path}`, {
      method: "PUT",
      headers: { authorization: basic(token) },
      body,
    });
  const get = (path: string) =>
    h.request(`/go/gomod/${path}`, { headers: { authorization: basic(writer) } });

  beforeEach(async () => {
    h = await makeHarness();
    await h.createRepo({ key: "gomod", format: "go", kind: "local", visibility: "private" });
    writer = h.token("bob", ["packages:read", "packages:write", "packages:delete"]);
    await h.request("/api/v1/repositories/gomod/permissions", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await h.adminToken()}`,
        "content-type": "application/json",
      },
      // Deleting published versions takes an owner admin in gitmatrix.
      body: JSON.stringify({ principal: "user:bob", role: "admin" }),
    });
  });

  it("publishes a module zip and serves the GOPROXY endpoints", async () => {
    const zip = moduleZip("acme.dev/tools", "v1.2.0", {
      "go.mod": "module acme.dev/tools\n\ngo 1.22\n",
      "tools.go": "package tools\n",
    });
    const res = await put("acme.dev/tools/@v/v1.2.0.zip", zip);
    expect(res.status).toBe(201);
    await put(
      "acme.dev/tools/@v/v1.3.0-rc.1.zip",
      moduleZip("acme.dev/tools", "v1.3.0-rc.1", { "go.mod": "module acme.dev/tools\n" }),
    );
    await put(
      "acme.dev/tools/@v/v0.0.0-20240101000000-abcdefabcdef.zip",
      moduleZip("acme.dev/tools", "v0.0.0-20240101000000-abcdefabcdef", {
        "go.mod": "module acme.dev/tools\n",
      }),
    );

    const list = await get("acme.dev/tools/@v/list");
    expect(list.headers.get("content-type")).toContain("text/plain");
    expect(await list.text()).toBe("v1.2.0\nv1.3.0-rc.1\n");

    const info = (await (await get("acme.dev/tools/@v/v1.2.0.info")).json()) as {
      Version: string;
      Time: string;
    };
    expect(info.Version).toBe("v1.2.0");
    expect(Number.isNaN(Date.parse(info.Time))).toBe(false);

    expect(await (await get("acme.dev/tools/@v/v1.2.0.mod")).text()).toBe(
      "module acme.dev/tools\n\ngo 1.22\n",
    );
    const zipRes = await get("acme.dev/tools/@v/v1.2.0.zip");
    expect(zipRes.headers.get("content-type")).toBe("application/zip");
    expect(new Uint8Array(await zipRes.arrayBuffer())).toEqual(zip);

    expect(
      ((await (await get("acme.dev/tools/@latest")).json()) as { Version: string }).Version,
    ).toBe("v1.2.0");
    expect((await get("acme.dev/tools/@v/v9.9.9.info")).status).toBe(404);
    expect((await get("acme.dev/other/@v/list")).status).toBe(404);
    expect((await get("sumdb/sum.golang.org/supported")).status).toBe(404);
  });

  it("case-encodes module paths and versions", async () => {
    const zip = moduleZip("github.com/Acme/Tool", "v1.0.0-RC1", {
      "go.mod": "module github.com/Acme/Tool\n",
    });
    expect((await put("github.com/!acme/!tool/@v/v1.0.0-!r!c1.zip", zip)).status).toBe(201);
    expect(await (await get("github.com/!acme/!tool/@v/list")).text()).toBe("v1.0.0-RC1\n");
    expect((await get("github.com/!acme/!tool/@v/v1.0.0-!r!c1.mod")).status).toBe(200);
    // Uppercase in the URL is not a valid escaped path.
    expect((await get("github.com/Acme/Tool/@v/list")).status).toBe(404);
    expect((await get("github.com/acme/tool/@v/list")).status).toBe(404);
  });

  it("synthesizes go.mod for modules without one", async () => {
    const zip = moduleZip("acme.dev/legacy", "v1.0.0", { "main.go": "package main\n" });
    expect((await put("acme.dev/legacy/@v/v1.0.0.zip", zip)).status).toBe(201);
    expect(await (await get("acme.dev/legacy/@v/v1.0.0.mod")).text()).toBe(
      "module acme.dev/legacy\n",
    );
  });

  it("rejects invalid zips, paths and versions", async () => {
    const wrongPrefix = moduleZip("acme.dev/other", "v1.0.0", {
      "go.mod": "module acme.dev/other\n",
    });
    const bad = await put("acme.dev/x/@v/v1.0.0.zip", wrongPrefix);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("prefix");

    const wrongModule = moduleZip("acme.dev/x", "v1.0.0", { "go.mod": "module acme.dev/y\n" });
    expect((await put("acme.dev/x/@v/v1.0.0.zip", wrongModule)).status).toBe(400);

    const withDir = zipSync({
      "acme.dev/x@v1.0.0/sub/": new Uint8Array(),
      "acme.dev/x@v1.0.0/go.mod": strToU8("module acme.dev/x\n"),
    });
    expect((await put("acme.dev/x/@v/v1.0.0.zip", withDir)).status).toBe(400);

    expect((await put("acme.dev/x/@v/v1.0.0.zip", strToU8("not a zip"))).status).toBe(400);
    const ok = moduleZip("acme.dev/x", "v2.0.0", { "go.mod": "module acme.dev/x\n" });
    expect((await put("acme.dev/x/@v/v2.0.0.zip", ok)).status).toBe(400);
    expect((await put("acme/x/@v/v1.0.0.zip", ok)).status).toBe(400);
    expect((await put("acme.dev/x/@v/v1.0.0.mod", strToU8("module acme.dev/x\n"))).status).toBe(
      405,
    );
    expect((await get("acme.dev/x/@v/list")).status).toBe(404);
  });

  it("keeps versions immutable, with idempotent re-uploads", async () => {
    const zip = moduleZip("acme.dev/x", "v1.0.0", { "go.mod": "module acme.dev/x\n" });
    expect((await put("acme.dev/x/@v/v1.0.0.zip", zip)).status).toBe(201);
    expect((await put("acme.dev/x/@v/v1.0.0.zip", zip)).status).toBe(200);
    const other = moduleZip("acme.dev/x", "v1.0.0", {
      "go.mod": "module acme.dev/x\n",
      "x.go": "package x\n",
    });
    expect((await put("acme.dev/x/@v/v1.0.0.zip", other)).status).toBe(409);
  });

  it("challenges anonymous clients and refuses readers", async () => {
    const res = await h.request("/go/gomod/acme.dev/x/@v/list");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("Basic");
    const zip = moduleZip("acme.dev/x", "v1.0.0", { "go.mod": "module acme.dev/x\n" });
    expect((await put("acme.dev/x/@v/v1.0.0.zip", zip, h.token("carol"))).status).toBe(403);
  });

  it("deletes versions through the API", async () => {
    const zip = moduleZip("acme.dev/x", "v1.0.0", { "go.mod": "module acme.dev/x\n" });
    await put("acme.dev/x/@v/v1.0.0.zip", zip);
    const del = await h.request("/api/v1/go/gomod/acme.dev/x/@v/v1.0.0", {
      method: "DELETE",
      headers: { authorization: `Bearer ${writer}` },
    });
    expect(del.status).toBe(204);
    expect((await get("acme.dev/x/@v/v1.0.0.info")).status).toBe(404);
  });
});

describe("go remote and virtual repositories", () => {
  let h: Harness;
  let admin: string;
  const hits: string[] = [];
  const upstreamZip = moduleZip("golang.org/x/text", "v0.14.0", {
    "go.mod": "module golang.org/x/text\n",
  });
  const MEMBERS = [{ key: "proxy" }, { key: "golocal" }];

  beforeEach(async () => {
    invalidateMembers();
    hits.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      hits.push(url.pathname);
      switch (url.pathname) {
        case "/golang.org/x/text/@v/list":
          return new Response("v0.13.0\nv0.14.0\n");
        case "/golang.org/x/text/@latest":
        case "/golang.org/x/text/@v/v0.14.0.info":
          return Response.json({ Version: "v0.14.0", Time: "2023-10-11T00:00:00Z" });
        case "/golang.org/x/text/@v/v0.14.0.mod":
          return new Response("module golang.org/x/text\n");
        case "/golang.org/x/text/@v/v0.14.0.zip":
          return new Response(upstreamZip);
        case "/github.com/!burnt!sushi/toml/@v/list":
          return new Response("v1.3.2\n");
        case "/acme.dev/tools/@v/list":
          return new Response("v9.0.0\n");
        case "/sumdb/sum.golang.org/supported":
          return new Response("");
        case "/sumdb/sum.golang.org/lookup/golang.org/x/text@v0.14.0":
          return new Response("123\ngolang.org/x/text v0.14.0 h1:abc=\n");
        default:
          return new Response("not found", { status: 404 });
      }
    });
    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({ key: "golocal", format: "go", kind: "local", visibility: "public" });
    await h.createRepo({
      key: "proxy",
      format: "go",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://proxy.example.com" },
    });
    await h.createRepo({
      key: "goall",
      format: "go",
      kind: "virtual",
      visibility: "public",
      config: { defaultDeployRepo: "golocal", pinnedNamespaces: ["acme.dev/**"] },
      members: MEMBERS,
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("proxies and caches upstream modules", async () => {
    expect(await (await h.request("/go/proxy/golang.org/x/text/@v/list")).text()).toBe(
      "v0.13.0\nv0.14.0\n",
    );
    expect(await (await h.request("/go/proxy/golang.org/x/text/@v/v0.14.0.mod")).text()).toBe(
      "module golang.org/x/text\n",
    );
    for (let i = 0; i < 2; i++) {
      const zip = await h.request("/go/proxy/golang.org/x/text/@v/v0.14.0.zip");
      expect(new Uint8Array(await zip.arrayBuffer())).toEqual(upstreamZip);
      await h.request("/go/proxy/golang.org/x/text/@v/v0.14.0.info");
    }
    expect(hits.filter((p) => p.endsWith(".zip"))).toHaveLength(1);
    expect(hits.filter((p) => p.endsWith(".info"))).toHaveLength(1);
    expect(
      (
        (await (await h.request("/go/proxy/golang.org/x/text/@latest")).json()) as {
          Version: string;
        }
      ).Version,
    ).toBe("v0.14.0");
    expect(await (await h.request("/go/proxy/github.com/!burnt!sushi/toml/@v/list")).text()).toBe(
      "v1.3.2\n",
    );
    expect((await h.request("/go/proxy/golang.org/x/missing/@v/list")).status).toBe(404);
  });

  it("passes the checksum database through remote repositories", async () => {
    expect((await h.request("/go/proxy/sumdb/sum.golang.org/supported")).status).toBe(200);
    const lookup = await h.request(
      "/go/proxy/sumdb/sum.golang.org/lookup/golang.org/x/text@v0.14.0",
    );
    expect(await lookup.text()).toContain("h1:abc=");
    expect((await h.request("/go/goall/sumdb/sum.golang.org/supported")).status).toBe(200);
    expect((await h.request("/go/golocal/sumdb/sum.golang.org/supported")).status).toBe(404);
  });

  it("resolves locals first, falls through to remotes and keeps pinned modules local", async () => {
    const zip = moduleZip("acme.dev/tools", "v1.0.0", { "go.mod": "module acme.dev/tools\n" });
    const put = await h.request("/go/goall/acme.dev/tools/@v/v1.0.0.zip", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}` },
      body: zip,
    });
    expect(put.status).toBe(201);
    expect(await (await h.request("/go/goall/acme.dev/tools/@v/list")).text()).toBe("v1.0.0\n");
    expect(await (await h.request("/go/goall/golang.org/x/text/@v/list")).text()).toBe(
      "v0.13.0\nv0.14.0\n",
    );
    const zipRes = await h.request("/go/goall/golang.org/x/text/@v/v0.14.0.zip");
    expect(new Uint8Array(await zipRes.arrayBuffer())).toEqual(upstreamZip);
    expect(hits).not.toContain("/acme.dev/tools/@v/list");
    expect((await h.request("/go/goall/acme.dev/unknown/@v/list")).status).toBe(404);
    expect(hits.some((p) => p.startsWith("/acme.dev/"))).toBe(false);
  });

  it("merges version lists with mergeVersions", async () => {
    await h.request("/api/v1/repositories/goall", {
      method: "PATCH",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({
        config: { defaultDeployRepo: "golocal", mergeVersions: true },
        members: MEMBERS,
      }),
    });
    invalidateMembers();
    const zip = moduleZip("golang.org/x/text", "v0.15.0-fork.1", {
      "go.mod": "module golang.org/x/text\n",
    });
    expect(
      (
        await h.request("/go/golocal/golang.org/x/text/@v/v0.15.0-fork.1.zip", {
          method: "PUT",
          headers: { authorization: `Bearer ${admin}` },
          body: zip,
        })
      ).status,
    ).toBe(201);
    expect(await (await h.request("/go/goall/golang.org/x/text/@v/list")).text()).toBe(
      "v0.13.0\nv0.14.0\nv0.15.0-fork.1\n",
    );
  });
});
