import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { invalidateMembers } from "../../core/virtual.ts";
import { basic, makeHarness, type Harness } from "../../testing/harness.ts";

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");

const upstreamMetadata = `<?xml version="1.0" encoding="UTF-8"?>
<metadata>
  <groupId>org.example</groupId>
  <artifactId>util</artifactId>
  <versioning>
    <latest>3.0</latest>
    <release>3.0</release>
    <versions><version>2.0</version><version>3.0</version></versions>
    <lastUpdated>20250101000000</lastUpdated>
  </versioning>
</metadata>`;

describe("maven remote and virtual repositories", () => {
  let h: Harness;
  let admin: string;
  const hits: string[] = [];
  let files: Record<string, string>;

  beforeEach(async () => {
    invalidateMembers();
    hits.length = 0;
    files = {
      "/maven2/org/example/util/3.0/util-3.0.jar": "upstream-jar",
      "/maven2/org/example/util/3.0/util-3.0.jar.sha1": `${sha1("upstream-jar")}  util-3.0.jar`,
      "/maven2/org/example/util/2.0/util-2.0.jar": "tampered",
      "/maven2/org/example/util/2.0/util-2.0.jar.sha1": sha1("original"),
      "/maven2/org/example/util/maven-metadata.xml": upstreamMetadata,
      "/maven2/com/acme/lib/maven-metadata.xml": upstreamMetadata
        .replace("org.example", "com.acme")
        .replace("util", "lib"),
      "/maven2/com/acme/lib/9.9/lib-9.9.jar": "evil",
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      hits.push(url.pathname);
      const body = files[url.pathname];
      return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
    });
    h = await makeHarness();
    admin = await h.adminToken();
    await h.createRepo({ key: "local", format: "maven", kind: "local", visibility: "public" });
    await h.createRepo({
      key: "central",
      format: "maven",
      kind: "remote",
      visibility: "public",
      config: { upstream: "https://repo.example.com/maven2" },
    });
    await h.createRepo({
      key: "all",
      format: "maven",
      kind: "virtual",
      visibility: "public",
      config: { defaultDeployRepo: "local" },
      members: [{ key: "central" }, { key: "local" }],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("proxies and caches artifacts verified against the upstream sha1", async () => {
    const first = await h.request("/maven/central/org/example/util/3.0/util-3.0.jar");
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("upstream-jar");
    const again = await h.request("/maven/central/org/example/util/3.0/util-3.0.jar");
    expect(await again.text()).toBe("upstream-jar");
    expect(hits.filter((p) => p.endsWith(".jar"))).toHaveLength(1);
    const sidecar = await h.request("/maven/central/org/example/util/3.0/util-3.0.jar.sha1");
    expect(await sidecar.text()).toBe(sha1("upstream-jar"));
  });

  it("refuses upstream artifacts whose sha1 does not match", async () => {
    const res = await h.request("/maven/central/org/example/util/2.0/util-2.0.jar");
    expect(res.status).toBe(502);
  });

  it("serves upstream metadata with a TTL", async () => {
    const res = await h.request("/maven/central/org/example/util/maven-metadata.xml");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<version>3.0</version>");
    await h.request("/maven/central/org/example/util/maven-metadata.xml");
    expect(hits.filter((p) => p.endsWith("maven-metadata.xml"))).toHaveLength(1);
  });

  it("unions metadata across members and deploys to the default repository", async () => {
    const put = await h.request(
      "/maven/all/org/example/util/4.0-SNAPSHOT/util-4.0-20260101.000000-1.jar",
      {
        method: "PUT",
        headers: { authorization: basic(admin) },
        body: "snap",
      },
    );
    expect(put.status).toBe(201);
    await h.request("/maven/all/org/example/util/1.0/util-1.0.jar", {
      method: "PUT",
      headers: { authorization: basic(admin) },
      body: "old",
    });
    const res = await h.request("/maven/all/org/example/util/maven-metadata.xml");
    const xml = await res.text();
    expect(xml).toMatch(
      /<versions>\s*<version>1.0<\/version>\s*<version>2.0<\/version>\s*<version>3.0<\/version>\s*<version>4.0-SNAPSHOT<\/version>/,
    );
    expect(xml).toContain("<latest>4.0-SNAPSHOT</latest>");
    expect(xml).toContain("<release>3.0</release>");
    const checksum = await h.request("/maven/all/org/example/util/maven-metadata.xml.sha1");
    expect(await checksum.text()).toBe(sha1(xml));

    // Artifacts resolve locals first, then remotes.
    expect(await (await h.request("/maven/all/org/example/util/1.0/util-1.0.jar")).text()).toBe(
      "old",
    );
    expect(await (await h.request("/maven/all/org/example/util/3.0/util-3.0.jar")).text()).toBe(
      "upstream-jar",
    );
    const snapshot = await h.request("/maven/all/org/example/util/4.0-SNAPSHOT/maven-metadata.xml");
    expect(await snapshot.text()).toContain("<buildNumber>1</buildNumber>");
  });

  it("never resolves pinned groups from remote members", async () => {
    await h.request("/api/v1/repositories/all", {
      method: "PATCH",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body: JSON.stringify({
        config: { defaultDeployRepo: "local", pinnedNamespaces: ["com.acme.*"] },
        members: [{ key: "central" }, { key: "local" }],
      }),
    });
    invalidateMembers();
    await h.request("/maven/local/com/acme/lib/1.0/lib-1.0.jar", {
      method: "PUT",
      headers: { authorization: basic(admin) },
      body: "ours",
    });
    hits.length = 0;
    const xml = await (await h.request("/maven/all/com/acme/lib/maven-metadata.xml")).text();
    expect(xml).toContain("<version>1.0</version>");
    expect(xml).not.toContain("3.0");
    expect((await h.request("/maven/all/com/acme/lib/9.9/lib-9.9.jar")).status).toBe(404);
    expect(hits).toEqual([]);
    // Other groups still reach the remote.
    const other = await h.request("/maven/all/org/example/util/maven-metadata.xml");
    expect(await other.text()).toContain("<version>3.0</version>");
  });
});
