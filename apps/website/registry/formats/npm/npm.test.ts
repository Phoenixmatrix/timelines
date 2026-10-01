import { beforeEach, describe, expect, it } from "vite-plus/test";

import { basic, makeHarness, type Harness } from "../../testing/harness.ts";
import { digests, makeTarball, publishBody } from "./testing.ts";

const CORGI = "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*";

interface Doc {
  _rev: string;
  name: string;
  readme?: string;
  modified?: string;
  description?: string;
  "dist-tags": Record<string, string>;
  time?: Record<string, string>;
  versions: Record<
    string,
    {
      name: string;
      version: string;
      deprecated?: string;
      description?: string;
      _npmUser?: { name: string };
      dist: {
        tarball: string;
        shasum: string;
        integrity: string;
        fileCount?: number;
        unpackedSize?: number;
      };
    }
  >;
}

describe("npm local repositories", () => {
  let h: Harness;
  let writer: string;
  let deleter: string;

  const auth = (token = writer) => ({ authorization: `Bearer ${token}` });
  const put = (path: string, body: string, token = writer) =>
    h.request(path, {
      method: "PUT",
      headers: { ...auth(token), "content-type": "application/json" },
      body,
    });
  const doc = async (path: string, headers: Record<string, string> = {}) => {
    const res = await h.request(path, { headers: { ...auth(), ...headers } });
    expect(res.status).toBe(200);
    return (await res.json()) as Doc;
  };

  beforeEach(async () => {
    h = await makeHarness();
    expect(
      (await h.createRepo({ key: "js", format: "npm", kind: "local", visibility: "private" }))
        .status,
    ).toBe(201);
    writer = h.token("bob");
    // Deleting published versions takes an owner admin in gitmatrix.
    deleter = h.token("dana");
    h.grant("dana", "admin");
    await h.request("/api/v1/repositories/js/permissions", {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await h.adminToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ principal: "user:bob", role: "write" }),
    });
  });

  it("publishes, serves the packument and downloads the tarball", async () => {
    const tgz = makeTarball("left-pad", "1.0.0");
    const res = await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0", { tgz }));
    expect(res.status).toBe(201);

    const full = await h.request("/npm/js/left-pad", { headers: auth() });
    expect(full.headers.get("content-type")).toContain("application/json");
    expect(full.headers.get("etag")).toBeTruthy();
    expect(full.headers.get("cache-control")).toContain("must-revalidate");
    const body = (await full.json()) as Doc;
    const v = body.versions["1.0.0"]!;
    expect(body["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect(body._rev).toMatch(/^1-[0-9a-f]{32}$/);
    expect(body.readme).toBe("# left-pad");
    expect(body.description).toBe("the left-pad package");
    expect(body.time!["1.0.0"]).toBeTruthy();
    expect(v.dist.tarball).toBe("https://pkg.test/npm/js/left-pad/-/left-pad-1.0.0.tgz");
    expect(v.dist.integrity).toBe(digests(tgz).integrity);
    expect(v.dist.shasum).toBe(digests(tgz).shasum);
    expect(v.dist.fileCount).toBe(2);
    expect(v.dist.unpackedSize).toBeGreaterThan(0);
    expect(v._npmUser?.name).toBe("bob");
    expect((v as Record<string, unknown>).readme).toBeUndefined();

    const again = await h.request("/npm/js/left-pad", {
      headers: { ...auth(), "if-none-match": full.headers.get("etag")! },
    });
    expect(again.status).toBe(304);

    const download = await h.request(new URL(v.dist.tarball).pathname, { headers: auth() });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(tgz);

    const latest = await h.request("/npm/js/left-pad/latest", { headers: auth() });
    expect(((await latest.json()) as { version: string }).version).toBe("1.0.0");
    expect((await h.request("/npm/js/left-pad/2.0.0", { headers: auth() })).status).toBe(404);
  });

  it("handles scoped packages, with yarn's key order", async () => {
    const tgz = makeTarball("@acme/widget", "2.0.0");
    const res = await put(
      "/npm/js/@acme%2fwidget",
      publishBody("@acme/widget", "2.0.0", { tgz, attachmentsFirst: true }),
    );
    expect(res.status).toBe(201);
    for (const path of [
      "/npm/js/@acme%2fwidget",
      "/npm/js/@acme%2Fwidget",
      "/npm/js/@acme/widget",
    ]) {
      const body = await doc(path);
      expect(body.versions["2.0.0"]!.dist.tarball).toBe(
        "https://pkg.test/npm/js/@acme/widget/-/widget-2.0.0.tgz",
      );
    }
    const download = await h.request("/npm/js/@acme/widget/-/widget-2.0.0.tgz", {
      headers: auth(),
    });
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(tgz);
  });

  it("serves the abbreviated document", async () => {
    await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"));
    const res = await h.request("/npm/js/left-pad", { headers: { ...auth(), accept: CORGI } });
    expect(res.headers.get("content-type")).toContain("application/vnd.npm.install-v1+json");
    expect(res.headers.get("vary")).toContain("Accept");
    const body = (await res.json()) as Doc;
    expect(body.modified).toBeTruthy();
    expect(body.readme).toBeUndefined();
    expect(body._rev).toBeUndefined();
    expect(Object.keys(body.versions["1.0.0"]!).sort()).toEqual([
      "dependencies",
      "dist",
      "name",
      "version",
    ]);
  });

  it("refuses to publish over an existing version", async () => {
    expect((await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"))).status).toBe(201);
    const again = await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"));
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: string }).error).toContain(
      "cannot publish over the previously published versions: 1.0.0",
    );
  });

  it("rejects a tarball that does not match its integrity", async () => {
    const other = digests(makeTarball("left-pad", "9.9.9", "different"));
    const res = await put(
      "/npm/js/left-pad",
      publishBody("left-pad", "1.0.0", { integrity: other.integrity }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("sha512");
    expect((await h.request("/npm/js/left-pad", { headers: auth() })).status).toBe(404);
    expect(h.bucket.objects.size).toBe(0);
  });

  it("validates names, versions and permissions", async () => {
    expect((await put("/npm/js/Left-Pad", publishBody("Left-Pad", "1.0.0"))).status).toBe(400);
    expect((await put("/npm/js/left-pad", publishBody("left-pad", "v1"))).status).toBe(400);
    expect((await put("/npm/js/other", publishBody("left-pad", "1.0.0"))).status).toBe(400);
    expect((await put("/npm/js/left-pad", "{not json")).status).toBe(400);
    const reader = h.token("carol");
    expect((await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"), reader)).status).toBe(
      403,
    );
  });

  it("challenges anonymous readers of private repositories", async () => {
    const res = await h.request("/npm/js/left-pad");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('Basic realm="gitmatrix"');
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
    // npm sends Basic with the token as password when `_auth` is configured.
    await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"));
    expect(
      (await h.request("/npm/js/left-pad", { headers: { authorization: basic(writer) } })).status,
    ).toBe(200);
  });

  it("manages dist-tags", async () => {
    await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"));
    await put("/npm/js/left-pad", publishBody("left-pad", "2.0.0-rc.1", { tag: "next" }));
    const tags = async () =>
      (await (
        await h.request("/npm/js/-/package/left-pad/dist-tags", { headers: auth() })
      ).json()) as Record<string, string>;
    expect(await tags()).toEqual({ latest: "1.0.0", next: "2.0.0-rc.1" });

    const add = await put(
      "/npm/js/-/package/left-pad/dist-tags/beta",
      JSON.stringify("2.0.0-rc.1"),
    );
    expect(add.status).toBe(200);
    expect(await tags()).toEqual({ latest: "1.0.0", next: "2.0.0-rc.1", beta: "2.0.0-rc.1" });

    expect(
      (await put("/npm/js/-/package/left-pad/dist-tags/beta", JSON.stringify("7.0.0"))).status,
    ).toBe(404);
    expect(
      (await put("/npm/js/-/package/left-pad/dist-tags/1.x", JSON.stringify("1.0.0"))).status,
    ).toBe(400);

    const rm = await h.request("/npm/js/-/package/left-pad/dist-tags/beta", {
      method: "DELETE",
      headers: auth(),
    });
    expect(rm.status).toBe(200);
    expect(await tags()).toEqual({ latest: "1.0.0", next: "2.0.0-rc.1" });
    const rmLatest = await h.request("/npm/js/-/package/left-pad/dist-tags/latest", {
      method: "DELETE",
      headers: auth(),
    });
    expect(rmLatest.status).toBe(400);
  });

  it("deprecates like npm deprecate (full document PUT)", async () => {
    await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"));
    await put("/npm/js/left-pad", publishBody("left-pad", "1.1.0"));
    const current = await doc("/npm/js/left-pad?write=true");
    current.versions["1.0.0"]!.deprecated = "use 1.1.0";
    expect((await put("/npm/js/left-pad", JSON.stringify(current))).status).toBe(200);

    const after = await doc("/npm/js/left-pad");
    expect(after.versions["1.0.0"]!.deprecated).toBe("use 1.1.0");
    expect(after.versions["1.1.0"]!.deprecated).toBeUndefined();
    const short = await doc("/npm/js/left-pad", { accept: CORGI });
    expect(short.versions["1.0.0"]!.deprecated).toBe("use 1.1.0");

    after.versions["1.0.0"]!.deprecated = "";
    expect((await put(`/npm/js/left-pad/-rev/${after._rev}`, JSON.stringify(after))).status).toBe(
      200,
    );
    expect((await doc("/npm/js/left-pad")).versions["1.0.0"]!.deprecated).toBeUndefined();
  });

  it("unpublishes one version the way npm does", async () => {
    await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"));
    await put("/npm/js/left-pad", publishBody("left-pad", "1.1.0"));
    const current = await doc("/npm/js/left-pad?write=true");
    const tarball = current.versions["1.1.0"]!.dist.tarball;
    delete current.versions["1.1.0"];
    current["dist-tags"].latest = "1.0.0";

    // Writers without delete permission cannot drop versions.
    expect(
      (await put(`/npm/js/left-pad/-rev/${current._rev}`, JSON.stringify(current))).status,
    ).toBe(403);
    // A stale revision conflicts.
    expect(
      (await put("/npm/js/left-pad/-rev/1-stale", JSON.stringify(current), deleter)).status,
    ).toBe(409);
    expect(
      (await put(`/npm/js/left-pad/-rev/${current._rev}`, JSON.stringify(current), deleter)).status,
    ).toBe(200);

    const { _rev } = await doc("/npm/js/left-pad?write=true");
    // npm resolves the tarball URL's path against the registry URL again.
    const del = await h.request(`/npm/js${new URL(tarball).pathname}/-rev/${_rev}`, {
      method: "DELETE",
      headers: auth(deleter),
    });
    expect(del.status).toBe(200);

    const after = await doc("/npm/js/left-pad");
    expect(Object.keys(after.versions)).toEqual(["1.0.0"]);
    expect(after["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect((await h.request(new URL(tarball).pathname, { headers: auth() })).status).toBe(404);
    // Unpublished versions can never be reused.
    expect((await put("/npm/js/left-pad", publishBody("left-pad", "1.1.0"))).status).toBe(403);
  });

  it("unpublishes a whole package", async () => {
    await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"));
    const { _rev } = await doc("/npm/js/left-pad?write=true");
    const denied = await h.request(`/npm/js/left-pad/-rev/${_rev}`, {
      method: "DELETE",
      headers: auth(),
    });
    expect(denied.status).toBe(403);
    const res = await h.request(`/npm/js/left-pad/-rev/${_rev}`, {
      method: "DELETE",
      headers: auth(deleter),
    });
    expect(res.status).toBe(200);
    expect((await h.request("/npm/js/left-pad", { headers: auth() })).status).toBe(404);
    expect(
      (await h.request("/npm/js/left-pad/-/left-pad-1.0.0.tgz", { headers: auth() })).status,
    ).toBe(404);
  });

  it("searches local packages", async () => {
    await put("/npm/js/left-pad", publishBody("left-pad", "1.0.0"));
    await put("/npm/js/@acme%2fwidget", publishBody("@acme/widget", "2.0.0"));
    const res = await h.request("/npm/js/-/v1/search?text=pad&size=5", { headers: auth() });
    const body = (await res.json()) as {
      total: number;
      objects: { package: { name: string; version: string; scope: string } }[];
    };
    expect(body.total).toBe(1);
    expect(body.objects[0]!.package).toMatchObject({
      name: "left-pad",
      version: "1.0.0",
      scope: "unscoped",
    });
    const all = (await (
      await h.request("/npm/js/-/v1/search?text=demo", { headers: auth() })
    ).json()) as {
      total: number;
    };
    expect(all.total).toBe(2);
  });

  it("answers ping, whoami and local audits", async () => {
    expect((await h.request("/npm/js/-/ping")).status).toBe(200);
    const who = await h.request("/npm/js/-/whoami", { headers: auth() });
    expect(await who.json()).toEqual({ username: "bob" });
    const anon = await h.request("/npm/js/-/whoami");
    expect(anon.status).toBe(401);
    expect(anon.headers.get("www-authenticate")).toContain("Basic");
    const audit = await h.request("/npm/js/-/npm/v1/security/advisories/bulk", {
      method: "POST",
      headers: { ...auth(), "content-type": "application/json" },
      body: JSON.stringify({ "left-pad": ["1.0.0"] }),
    });
    expect(await audit.json()).toEqual({});
    expect((await h.request("/npm/js/-/v1/tokens", { headers: auth() })).status).toBe(404);
  });
});
