import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeHarness, type Harness } from "../../testing/harness.ts";
import { digests, makeTarball, publishBody } from "./testing.ts";

const CORGI = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";
const UPSTREAM = "https://registry.npmjs.org";

const leftPad = makeTarball("left-pad", "1.3.0");
const typesNode = makeTarball("@types/node", "22.0.0");

function upstreamDoc(name: string, version: string, tgz: Uint8Array, file: string) {
  return {
    _id: name,
    name,
    "dist-tags": { latest: version },
    time: { modified: "2026-01-01T00:00:00.000Z", [version]: "2026-01-01T00:00:00.000Z" },
    readme: "upstream readme",
    versions: {
      [version]: {
        name,
        version,
        description: "from upstream",
        dist: { ...digests(tgz), tarball: `${UPSTREAM}/${name}/-/${file}` },
      },
    },
  };
}

interface Doc {
  "dist-tags": Record<string, string>;
  readme?: string;
  versions: Record<string, { dist: { tarball: string } }>;
}

describe("npm remote and virtual repositories", () => {
  let h: Harness;
  let admin: string;
  let hits: { path: string; accept: string | null; method: string; body?: string }[];
  let corrupt: boolean;

  beforeEach(async () => {
    hits = [];
    corrupt = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const headers = new Headers(init?.headers);
      hits.push({
        path: url.pathname,
        accept: headers.get("accept"),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.host !== "registry.npmjs.org") return new Response("nope", { status: 404 });
      switch (url.pathname) {
        case "/left-pad":
          return Response.json(upstreamDoc("left-pad", "1.3.0", leftPad, "left-pad-1.3.0.tgz"));
        case "/@types%2fnode":
          return Response.json(upstreamDoc("@types/node", "22.0.0", typesNode, "node-22.0.0.tgz"));
        case "/left-pad/-/left-pad-1.3.0.tgz":
          return new Response(corrupt ? new Uint8Array([1, 2, 3]) : leftPad);
        case "/@types/node/-/node-22.0.0.tgz":
          return new Response(typesNode);
        case "/-/v1/search":
          return Response.json({
            objects: [
              { package: { name: "left-pad", version: "1.3.0" }, searchScore: 1 },
              { package: { name: "@corp/secret", version: "6.6.6" }, searchScore: 1 },
            ],
            total: 2,
          });
        case "/-/npm/v1/security/advisories/bulk":
          return Response.json({ "left-pad": [{ id: 1, severity: "low" }] });
      }
      return new Response("{}", { status: 404 });
    });
    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({ key: "js-local", format: "npm", kind: "local", visibility: "public" });
    await h.createRepo({
      key: "npmjs",
      format: "npm",
      kind: "remote",
      visibility: "public",
      config: { upstream: UPSTREAM },
    });
    await h.createRepo({
      key: "js",
      format: "npm",
      kind: "virtual",
      visibility: "public",
      config: { defaultDeployRepo: "js-local", pinnedNamespaces: ["@corp/*"] },
      members: [{ key: "npmjs" }, { key: "js-local" }],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  const publish = (path: string, name: string, version: string) =>
    h.request(path, {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: publishBody(name, version),
    });
  const get = async (path: string, accept?: string) => {
    const res = await h.request(path, accept ? { headers: { accept } } : undefined);
    expect(res.status).toBe(200);
    return (await res.json()) as Doc;
  };

  it("proxies packuments with tarballs rewritten to this registry, and caches them", async () => {
    const doc = await get("/npm/npmjs/left-pad");
    expect(doc.versions["1.3.0"]!.dist.tarball).toBe(
      "https://pkg.test/npm/npmjs/left-pad/-/left-pad-1.3.0.tgz",
    );
    expect(doc.readme).toBe("upstream readme");
    await get("/npm/npmjs/left-pad");
    expect(hits.filter((x) => x.path === "/left-pad")).toHaveLength(1);
    expect(hits[0]!.accept).toBe("application/json");

    // The abbreviated form is fetched (and cached) separately.
    const short = await get("/npm/npmjs/left-pad", CORGI);
    expect(short.readme).toBeUndefined();
    expect(short.versions["1.3.0"]!.dist.tarball).toContain("/npm/npmjs/");
    await get("/npm/npmjs/left-pad", CORGI);
    const packumentHits = hits.filter((x) => x.path === "/left-pad");
    expect(packumentHits).toHaveLength(2);
    expect(packumentHits[1]!.accept).toContain("application/vnd.npm.install-v1+json");
  });

  it("downloads verified tarballs once", async () => {
    for (let i = 0; i < 2; i++) {
      const res = await h.request("/npm/npmjs/left-pad/-/left-pad-1.3.0.tgz");
      expect(res.status).toBe(200);
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(leftPad);
    }
    expect(hits.filter((x) => x.path.endsWith(".tgz"))).toHaveLength(1);
    expect((await h.request("/npm/npmjs/left-pad/-/left-pad-9.9.9.tgz")).status).toBe(404);
  });

  it("refuses upstream tarballs that do not match the packument", async () => {
    corrupt = true;
    const res = await h.request("/npm/npmjs/left-pad/-/left-pad-1.3.0.tgz");
    expect(res.status).toBe(400);
    corrupt = false;
    expect((await h.request("/npm/npmjs/left-pad/-/left-pad-1.3.0.tgz")).status).toBe(200);
  });

  it("encodes scoped names for the upstream", async () => {
    const doc = await get("/npm/npmjs/@types%2fnode");
    expect(hits[0]!.path).toBe("/@types%2fnode");
    expect(doc.versions["22.0.0"]!.dist.tarball).toBe(
      "https://pkg.test/npm/npmjs/@types/node/-/node-22.0.0.tgz",
    );
    const res = await h.request("/npm/npmjs/@types/node/-/node-22.0.0.tgz");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(typesNode);
    expect(hits.at(-1)!.path).toBe("/@types/node/-/node-22.0.0.tgz");
  });

  it("refuses writes to remote repositories", async () => {
    expect((await publish("/npm/npmjs/left-pad", "left-pad", "1.0.0")).status).toBe(405);
  });

  it("resolves through a virtual repository with tarballs rewritten to it", async () => {
    const doc = await get("/npm/js/left-pad");
    const url = doc.versions["1.3.0"]!.dist.tarball;
    expect(url).toBe("https://pkg.test/npm/js/left-pad/-/left-pad-1.3.0.tgz");
    const res = await h.request(new URL(url).pathname);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(leftPad);
  });

  it("deploys through the virtual repository and prefers local packages", async () => {
    expect((await publish("/npm/js/left-pad", "left-pad", "9.0.0")).status).toBe(201);
    // Landed in the deploy target.
    expect(Object.keys((await get("/npm/js-local/left-pad")).versions)).toEqual(["9.0.0"]);

    const doc = await get("/npm/js/left-pad");
    expect(Object.keys(doc.versions)).toEqual(["9.0.0"]);
    const url = doc.versions["9.0.0"]!.dist.tarball;
    expect(url).toBe("https://pkg.test/npm/js/left-pad/-/left-pad-9.0.0.tgz");
    expect((await h.request(new URL(url).pathname)).status).toBe(200);
    // The upstream's version is not reachable through the virtual repository.
    expect((await h.request("/npm/js/left-pad/-/left-pad-1.3.0.tgz")).status).toBe(404);
    expect(hits).toEqual([]);

    // Editing through the virtual repository sees the deploy target's revision.
    const edit = (await (await h.request("/npm/js/left-pad?write=true")).json()) as Doc & {
      _rev: string;
    };
    expect(edit._rev).toMatch(/^1-/);
    const tag = await h.request("/npm/js/-/package/left-pad/dist-tags/stable", {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify("9.0.0"),
    });
    expect(tag.status).toBe(200);
    expect(await get("/npm/js/-/package/left-pad/dist-tags")).toEqual({
      latest: "9.0.0",
      stable: "9.0.0",
    });
  });

  it("merges versions across members when configured", async () => {
    await h.request("/api/v1/repositories/js", {
      method: "PATCH",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      // Members are repeated: a config-only PATCH currently resets them.
      body: JSON.stringify({
        config: { defaultDeployRepo: "js-local", mergeVersions: true },
        members: [{ key: "npmjs" }, { key: "js-local" }],
      }),
    });

    expect((await publish("/npm/js/left-pad", "left-pad", "9.0.0")).status).toBe(201);
    const doc = await get("/npm/js/left-pad");
    expect(Object.keys(doc.versions).sort()).toEqual(["1.3.0", "9.0.0"]);
    expect(doc["dist-tags"].latest).toBe("9.0.0");
    expect(doc.versions["1.3.0"]!.dist.tarball).toContain("/npm/js/");
    expect((await h.request("/npm/js/left-pad/-/left-pad-1.3.0.tgz")).status).toBe(200);
    expect((await h.request("/npm/js/left-pad/-/left-pad-9.0.0.tgz")).status).toBe(200);
  });

  it("never sends pinned names upstream", async () => {
    expect((await h.request("/npm/js/@corp%2fsecret")).status).toBe(404);
    expect((await h.request("/npm/js/@corp/secret/-/secret-6.6.6.tgz")).status).toBe(404);
    expect(hits).toEqual([]);
  });

  it("proxies search, keeping pinned names out of virtual results", async () => {
    await publish("/npm/js/@corp%2finternal", "@corp/internal", "1.0.0");
    const remote = (await (await h.request("/npm/npmjs/-/v1/search?text=pad")).json()) as {
      objects: { package: { name: string } }[];
    };
    expect(remote.objects.map((o) => o.package.name)).toEqual(["left-pad", "@corp/secret"]);

    const virtual = (await (await h.request("/npm/js/-/v1/search?text=demo")).json()) as {
      objects: { package: { name: string } }[];
    };
    expect(virtual.objects.map((o) => o.package.name)).toEqual(["@corp/internal", "left-pad"]);
  });

  it("proxies audits upstream without leaking private names", async () => {
    await publish("/npm/js/private-thing", "private-thing", "1.0.0");
    const remote = await h.request("/npm/npmjs/-/npm/v1/security/advisories/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "left-pad": ["1.3.0"] }),
    });
    expect(await remote.json()).toEqual({ "left-pad": [{ id: 1, severity: "low" }] });

    const virtual = await h.request("/npm/js/-/npm/v1/security/advisories/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        "left-pad": ["1.3.0"],
        "private-thing": ["1.0.0"],
        "@corp/x": ["1.0.0"],
      }),
    });
    expect(virtual.status).toBe(200);
    const sent = hits.filter((x) => x.method === "POST").at(-1)!;
    expect(JSON.parse(sent.body!)).toEqual({ "left-pad": ["1.3.0"] });
  });
});
