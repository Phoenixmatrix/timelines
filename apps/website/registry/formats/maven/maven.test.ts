import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it } from "vite-plus/test";

import { basic, makeHarness, type Harness } from "../../testing/harness.ts";

const sha1 = (text: string) => createHash("sha1").update(text).digest("hex");
const md5 = (text: string) => createHash("md5").update(text).digest("hex");

const pom = (artifactId: string, version: string, extra = "") =>
  `<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>${artifactId}</artifactId><version>${version}</version>${extra}</project>`;

describe("maven local repositories", () => {
  let h: Harness;
  let auth: string;

  const put = (path: string, body: BodyInit, headers: Record<string, string> = {}) =>
    h.request(`/maven/libs/${path}`, {
      method: "PUT",
      headers: { authorization: auth, ...headers },
      body,
    });
  const get = (path: string, init: RequestInit = {}) =>
    h.request(`/maven/libs/${path}`, { ...init, headers: { authorization: auth } });

  beforeEach(async () => {
    h = await makeHarness();
    expect(
      (await h.createRepo({ key: "libs", format: "maven", kind: "local", visibility: "private" }))
        .status,
    ).toBe(201);
    auth = basic(await h.adminToken(), "admin");
  });

  it("deploys a jar, pom and checksums the way maven does", async () => {
    const base = "com/acme/lib/1.0/lib-1.0";
    expect((await put(`${base}.jar`, "jar-bytes")).status).toBe(201);
    expect((await put(`${base}.jar.sha1`, sha1("jar-bytes"))).status).toBe(201);
    expect((await put(`${base}.jar.md5`, `${md5("jar-bytes")}  lib-1.0.jar`)).status).toBe(201);
    expect((await put(`${base}.pom`, pom("lib", "1.0"))).status).toBe(201);
    expect((await put(`${base}.pom.sha1`, sha1(pom("lib", "1.0")))).status).toBe(201);
    // Client-generated metadata is accepted and ignored.
    expect((await put("com/acme/lib/maven-metadata.xml", "<metadata>junk</metadata>")).status).toBe(
      201,
    );
    expect((await put("com/acme/lib/maven-metadata.xml.sha1", "abc")).status).toBe(201);

    const jar = await get(`${base}.jar`);
    expect(jar.status).toBe(200);
    expect(await jar.text()).toBe("jar-bytes");
    expect(jar.headers.get("content-type")).toBe("application/java-archive");
    expect(await (await get(`${base}.jar.sha1`)).text()).toBe(sha1("jar-bytes"));
    expect(await (await get(`${base}.jar.sha256`)).text()).toBe(
      createHash("sha256").update("jar-bytes").digest("hex"),
    );
    const head = await get(`${base}.jar`, { method: "HEAD" });
    expect(head.headers.get("content-length")).toBe("9");

    const meta = await get("com/acme/lib/maven-metadata.xml");
    expect(meta.status).toBe(200);
    const xml = await meta.text();
    expect(xml).toContain("<groupId>com.acme</groupId>");
    expect(xml).toContain("<release>1.0</release>");
    expect(xml).toContain("<version>1.0</version>");
    expect(xml).toMatch(/<lastUpdated>\d{14}<\/lastUpdated>/);
    expect(await (await get("com/acme/lib/maven-metadata.xml.sha1")).text()).toBe(sha1(xml));
  });

  it("verifies checksums uploaded before their artifact", async () => {
    const path = "com/acme/early/2.0/early-2.0.jar";
    expect((await put(`${path}.sha1`, sha1("good"))).status).toBe(201);
    expect((await get(`${path}.sha1`)).status).toBe(404);
    expect((await put(path, "bad")).status).toBe(400);
    expect((await get(path)).status).toBe(404);

    expect((await put(`${path}.sha1`, sha1("good"))).status).toBe(201);
    expect((await put(path, "good")).status).toBe(201);
    expect(await (await get(`${path}.sha1`)).text()).toBe(sha1("good"));
  });

  it("rejects checksums that do not match the stored artifact", async () => {
    const path = "com/acme/lib/1.0/lib-1.0.jar";
    await put(path, "jar-bytes");
    const res = await put(`${path}.sha1`, sha1("other"));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("sha1 mismatch");
    expect((await put(`${path}.md5`, "zzz")).status).toBe(400);
  });

  it("keeps releases immutable but accepts identical re-uploads", async () => {
    const path = "com/acme/lib/1.0/lib-1.0.jar";
    expect((await put(path, "one")).status).toBe(201);
    expect((await put(path, "one")).status).toBe(201);
    expect((await put(path, "two")).status).toBe(409);
    expect(await (await get(path)).text()).toBe("one");
  });

  it("generates SNAPSHOT metadata from timestamped builds", async () => {
    const dir = "com/acme/app/1.1-SNAPSHOT";
    await put(`${dir}/app-1.1-20260101.120000-1.jar`, "build1");
    await put(`${dir}/app-1.1-20260101.120000-1.pom`, pom("app", "1.1-SNAPSHOT"));
    await put(`${dir}/app-1.1-20260102.130000-2.jar`, "build2");
    await put(`${dir}/app-1.1-20260102.130000-2-sources.jar`, "src2");
    await put(`${dir}/app-1.1-20260102.130000-2.pom`, pom("app", "1.1-SNAPSHOT"));
    await put("com/acme/app/1.0/app-1.0.jar", "release");
    // Builds are mutable.
    expect((await put(`${dir}/app-1.1-20260102.130000-2.jar`, "build2b")).status).toBe(201);

    const xml = await (await get(`${dir}/maven-metadata.xml`)).text();
    expect(xml).toContain('<metadata modelVersion="1.1.0">');
    expect(xml).toContain("<version>1.1-SNAPSHOT</version>");
    expect(xml).toContain("<timestamp>20260102.130000</timestamp>");
    expect(xml).toContain("<buildNumber>2</buildNumber>");
    expect(xml).toMatch(
      /<snapshotVersion>\s*<extension>jar<\/extension>\s*<value>1.1-20260102.130000-2<\/value>/,
    );
    expect(xml).toMatch(
      /<classifier>sources<\/classifier>\s*<extension>jar<\/extension>\s*<value>1.1-20260102.130000-2<\/value>/,
    );
    expect(xml).toMatch(/<extension>pom<\/extension>\s*<value>1.1-20260102.130000-2<\/value>/);

    const artifact = await (await get("com/acme/app/maven-metadata.xml")).text();
    expect(artifact).toContain("<latest>1.1-SNAPSHOT</latest>");
    expect(artifact).toContain("<release>1.0</release>");
    expect(artifact).toMatch(/<version>1.0<\/version>\s*<version>1.1-SNAPSHOT<\/version>/);
    expect(await (await get(`${dir}/app-1.1-20260102.130000-2.jar`)).text()).toBe("build2b");
  });

  it("accepts non-unique SNAPSHOT uploads (sbt)", async () => {
    const dir = "com/acme/sbtlib/0.1-SNAPSHOT";
    expect((await put(`${dir}/sbtlib-0.1-SNAPSHOT.jar`, "a")).status).toBe(201);
    expect((await put(`${dir}/sbtlib-0.1-SNAPSHOT.jar`, "b")).status).toBe(201);
    expect(await (await get(`${dir}/sbtlib-0.1-SNAPSHOT.jar`)).text()).toBe("b");
    const xml = await (await get(`${dir}/maven-metadata.xml`)).text();
    expect(xml).toContain("<value>0.1-SNAPSHOT</value>");
  });

  it("prunes old SNAPSHOT builds with retention.keepLatest", async () => {
    await h.request("/api/v1/repositories/libs", {
      method: "PATCH",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ config: { retention: { keepLatest: 2 } } }),
    });
    const dir = "com/acme/app/1.0-SNAPSHOT";
    for (const n of [1, 2, 3]) await put(`${dir}/app-1.0-20260101.12000${n}-${n}.jar`, `b${n}`);
    expect((await get(`${dir}/app-1.0-20260101.120001-1.jar`)).status).toBe(404);
    expect((await get(`${dir}/app-1.0-20260101.120003-3.jar`)).status).toBe(200);
  });

  it("publishes group-level plugin metadata", async () => {
    await put(
      "com/acme/tools/hello-maven-plugin/1.0/hello-maven-plugin-1.0.pom",
      pom("hello-maven-plugin", "1.0", "<packaging>maven-plugin</packaging><name>Hello</name>"),
    );
    await put(
      "com/acme/tools/custom-plugin/1.0/custom-plugin-1.0.pom",
      pom(
        "custom-plugin",
        "1.0",
        "<packaging>maven-plugin</packaging><build><plugins><plugin><artifactId>maven-plugin-plugin</artifactId><configuration><goalPrefix>cx</goalPrefix></configuration></plugin></plugins></build>",
      ),
    );
    const xml = await (await get("com/acme/tools/maven-metadata.xml")).text();
    expect(xml).toMatch(/<prefix>cx<\/prefix>\s*<artifactId>custom-plugin<\/artifactId>/);
    expect(xml).toMatch(
      /<name>Hello<\/name>\s*<prefix>hello<\/prefix>\s*<artifactId>hello-maven-plugin<\/artifactId>/,
    );
  });

  it("handles many concurrent deploys", async () => {
    const versions = Array.from({ length: 12 }, (_, i) => `1.${i}`);
    const results = await Promise.all(
      versions.flatMap((v) => [
        put(`org/many/m/${v}/m-${v}.jar`, `jar-${v}`),
        put(`org/many/m/${v}/m-${v}.pom`, pom("m", v)),
        put(`org/many/m/${v}/m-${v}-sources.jar`, `src-${v}`),
      ]),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const xml = await (await get("org/many/m/maven-metadata.xml")).text();
    for (const v of versions) expect(xml).toContain(`<version>${v}</version>`);
    expect(xml).toContain("<release>1.11</release>");
  });

  it("lists directories and redirects to the slash form", async () => {
    await put("com/acme/lib/1.0/lib-1.0.jar", "x");
    const redirect = await get("com/acme/lib");
    expect(redirect.status).toBe(301);
    const html = await (await get("com/acme/lib/")).text();
    expect(html).toContain('href="1.0/"');
    expect(html).toContain('href="maven-metadata.xml"');
    expect((await get("com/nothing/")).status).toBe(404);
  });

  it("rejects paths outside the layout and bad coordinates", async () => {
    expect((await put("com/acme/lib/1.0/other-1.0.jar", "x")).status).toBe(400);
    expect((await put("lib-1.0.jar", "x")).status).toBe(400);
  });

  it("deletes files and versions", async () => {
    await put("com/acme/lib/1.0/lib-1.0.jar", "x");
    await put("com/acme/lib/2.0/lib-2.0.jar", "y");
    const res = await h.request("/maven/libs/com/acme/lib/1.0", {
      method: "DELETE",
      headers: { authorization: auth },
    });
    expect(res.status).toBe(204);
    const xml = await (await get("com/acme/lib/maven-metadata.xml")).text();
    expect(xml).not.toContain("<version>1.0</version>");
    expect(xml).toContain("<version>2.0</version>");
  });
});

describe("maven authentication", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
    await h.createRepo({ key: "priv", format: "maven", kind: "local", visibility: "private" });
    await h.createRepo({ key: "pub", format: "maven", kind: "local", visibility: "public" });
  });

  it("challenges anonymous reads of private repositories", async () => {
    const res = await h.request("/maven/priv/com/acme/lib/maven-metadata.xml");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Basic realm="gitmatrix", charset="UTF-8"');
  });

  it("challenges anonymous PUTs without reading the body", async () => {
    for (const key of ["priv", "pub"]) {
      let pulled = false;
      const body = new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled = true;
            throw new Error("body must not be read");
          },
        },
        { highWaterMark: 0 },
      );
      const res = await h.request(`/maven/${key}/com/acme/lib/1.0/lib-1.0.jar`, {
        method: "PUT",
        body,
        duplex: "half",
      } as RequestInit);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Basic");
      expect(pulled).toBe(false);
    }
  });

  it("forbids readers from deploying", async () => {
    const res = await h.request("/maven/pub/com/acme/lib/1.0/lib-1.0.jar", {
      method: "PUT",
      headers: { authorization: basic(h.token("carol")) },
      body: "x",
    });
    expect(res.status).toBe(403);
  });
});
