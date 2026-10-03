import { describe, expect, it } from "vite-plus/test";

import {
  artifactPath,
  compareMavenVersions,
  escapeXml,
  lastUpdatedStamp,
  mergeMetadata,
  parseChecksum,
  parseMavenPath,
  parseMetadataXml,
  parsePom,
  pluginPrefix,
  snapshotTimestamp,
  sortMavenVersions,
  versioningFor,
  writeMetadataXml,
} from "./index.ts";

describe("maven paths", () => {
  it("parses release artifacts with classifiers and multi-dot extensions", () => {
    const jar = parseMavenPath("com/acme/lib/1.0/lib-1.0.jar");
    expect(jar.checksum).toBeNull();
    expect(jar.target).toMatchObject({
      kind: "artifact",
      coords: {
        groupId: "com.acme",
        artifactId: "lib",
        baseVersion: "1.0",
        version: "1.0",
        classifier: null,
        extension: "jar",
        snapshot: false,
      },
    });
    const sources = parseMavenPath("com/acme/lib/1.0/lib-1.0-sources.jar.sha1");
    expect(sources.checksum).toBe("sha1");
    expect(sources.target).toMatchObject({ coords: { classifier: "sources", extension: "jar" } });
    const tgz = parseMavenPath("com/acme/lib/1.0/lib-1.0-linux-x86_64.tar.gz");
    expect(tgz.target).toMatchObject({
      coords: { classifier: "linux-x86_64", extension: "tar.gz" },
    });
    const plain = parseMavenPath("com/acme/lib/1.0/lib-1.0.tar.gz");
    expect(plain.target).toMatchObject({ coords: { classifier: null, extension: "tar.gz" } });
    const asc = parseMavenPath("com/acme/lib/1.0/lib-1.0.pom.asc");
    expect(asc.target).toMatchObject({ coords: { classifier: null, extension: "pom.asc" } });
    const jdk = parseMavenPath("com/acme/lib/1.0/lib-1.0-jdk1.8.jar");
    expect(jdk.target).toMatchObject({ coords: { classifier: "jdk1.8", extension: "jar" } });
  });

  it("parses timestamped and non-unique SNAPSHOT files", () => {
    const ts = parseMavenPath("org/x/app/2.1-SNAPSHOT/app-2.1-20260101.120000-3-tests.jar");
    expect(ts.target).toMatchObject({
      kind: "artifact",
      coords: {
        baseVersion: "2.1-SNAPSHOT",
        version: "2.1-20260101.120000-3",
        timestamp: "20260101.120000",
        buildNumber: 3,
        classifier: "tests",
        extension: "jar",
        snapshot: true,
      },
    });
    const nonUnique = parseMavenPath("org/x/app/2.1-SNAPSHOT/app-2.1-SNAPSHOT.pom");
    expect(nonUnique.target).toMatchObject({
      coords: { version: "2.1-SNAPSHOT", timestamp: null, extension: "pom" },
    });
  });

  it("recognizes metadata and rejects paths that do not match the layout", () => {
    expect(parseMavenPath("com/acme/lib/maven-metadata.xml.sha256")).toEqual({
      target: { kind: "metadata", path: "com/acme/lib/maven-metadata.xml", dir: "com/acme/lib" },
      checksum: "sha256",
    });
    expect(parseMavenPath("com/acme/lib/1.0/other-1.0.jar").target.kind).toBe("other");
    expect(parseMavenPath("lib/1.0/lib-1.0.jar").target.kind).toBe("other");
    expect(parseMavenPath("com/acme/lib/1.0/lib-1.1.jar").target.kind).toBe("other");
  });

  it("builds artifact paths", () => {
    expect(
      artifactPath({
        groupId: "com.acme",
        artifactId: "lib",
        baseVersion: "1.0-SNAPSHOT",
        version: "1.0-20260101.120000-1",
        classifier: "sources",
        extension: "jar",
      }),
    ).toBe("com/acme/lib/1.0-SNAPSHOT/lib-1.0-20260101.120000-1-sources.jar");
  });
});

describe("maven version ordering", () => {
  it("follows ComparableVersion", () => {
    const ordered = [
      "1.0-alpha-1",
      "1.0-alpha2",
      "1.0-beta-1",
      "1.0-M1",
      "1.0-rc1",
      "1.0-SNAPSHOT",
      "1.0",
      "1.0-sp1",
      "1.0.1",
      "1.1",
      "1.9",
      "1.10",
      "2.0",
    ];
    const shuffled = [...ordered].reverse();
    expect(sortMavenVersions(shuffled)).toEqual(ordered);
  });

  it("treats equivalent spellings as equal", () => {
    expect(compareMavenVersions("1.0", "1.0.0")).toBe(0);
    expect(compareMavenVersions("1.0", "1-ga")).toBe(0);
    expect(compareMavenVersions("1.0-final", "1.0")).toBe(0);
    expect(compareMavenVersions("1.0-cr1", "1.0-rc1")).toBe(0);
    expect(compareMavenVersions("1.0-foo", "1.0")).toBeGreaterThan(0);
    expect(compareMavenVersions("1.0.0.X1", "1.0.0-X2")).toBeLessThan(0);
  });
});

describe("checksum sidecars", () => {
  const sha1 = "a9993e364706816aba3e25717850c26c9cd0d89d";
  it("accepts the common formats", () => {
    expect(parseChecksum(sha1, "sha1")).toBe(sha1);
    expect(parseChecksum(`${sha1.toUpperCase()}  lib-1.0.jar\n`, "sha1")).toBe(sha1);
    expect(parseChecksum(`${sha1} *lib-1.0.jar`, "sha1")).toBe(sha1);
    expect(parseChecksum(`SHA1 (lib-1.0.jar) = ${sha1}`, "sha1")).toBe(sha1);
  });
  it("rejects wrong lengths and garbage", () => {
    expect(parseChecksum(sha1, "md5")).toBeNull();
    expect(parseChecksum("not a checksum", "sha1")).toBeNull();
  });
});

describe("maven-metadata.xml", () => {
  it("writes and reads artifact metadata", () => {
    const xml = writeMetadataXml({
      groupId: "com.acme",
      artifactId: "a&b",
      versioning: {
        latest: "2.0-SNAPSHOT",
        release: "1.0",
        versions: ["1.0", "2.0-SNAPSHOT"],
        lastUpdated: "20260101120000",
      },
    });
    expect(xml).toContain("<artifactId>a&amp;b</artifactId>");
    const parsed = parseMetadataXml(xml);
    expect(parsed.artifactId).toBe("a&b");
    expect(parsed.versioning?.versions).toEqual(["1.0", "2.0-SNAPSHOT"]);
    expect(parsed.versioning?.release).toBe("1.0");
  });

  it("writes SNAPSHOT metadata", () => {
    const xml = writeMetadataXml({
      groupId: "g",
      artifactId: "a",
      version: "1.0-SNAPSHOT",
      versioning: {
        snapshot: { timestamp: "20260101.120000", buildNumber: 2 },
        lastUpdated: "20260101120000",
        snapshotVersions: [
          { classifier: null, extension: "jar", value: "1.0-20260101.120000-2", updated: "x" },
        ],
      },
    });
    expect(xml).toContain('<metadata modelVersion="1.1.0">');
    const parsed = parseMetadataXml(xml);
    expect(parsed.version).toBe("1.0-SNAPSHOT");
    expect(parsed.versioning?.snapshot).toEqual({
      timestamp: "20260101.120000",
      buildNumber: 2,
      localCopy: undefined,
    });
    expect(parsed.versioning?.snapshotVersions?.[0]?.value).toBe("1.0-20260101.120000-2");
  });

  it("merges versions and plugins", () => {
    const merged = mergeMetadata([
      {
        groupId: "g",
        artifactId: "a",
        versioning: { versions: ["1.0", "1.2"], lastUpdated: "20250101000000" },
      },
      {
        groupId: "g",
        artifactId: "a",
        versioning: { versions: ["1.1", "2.0-SNAPSHOT"], lastUpdated: "20260101000000" },
        plugins: [{ prefix: "x", artifactId: "x-maven-plugin" }],
      },
    ]);
    expect(merged?.versioning).toEqual({
      latest: "2.0-SNAPSHOT",
      release: "1.2",
      versions: ["1.0", "1.1", "1.2", "2.0-SNAPSHOT"],
      lastUpdated: "20260101000000",
    });
    expect(merged?.plugins).toEqual([{ prefix: "x", artifactId: "x-maven-plugin" }]);
  });

  it("lists versions kept from latest without making them latest or release", () => {
    const docs = [
      { versioning: { versions: ["1.0", "1.2"], lastUpdated: "20250101000000" } },
      { versioning: { versions: ["1.1", "2.0-SNAPSHOT"], lastUpdated: "20260101000000" } },
    ];
    expect(mergeMetadata(docs, new Set(["1.2", "2.0-SNAPSHOT"]))?.versioning).toEqual({
      latest: "1.1",
      release: "1.1",
      versions: ["1.0", "1.1", "1.2", "2.0-SNAPSHOT"],
      lastUpdated: "20260101000000",
    });
    expect(versioningFor(["1.0"], "20260101000000", new Set(["1.0"]))).toEqual({
      latest: undefined,
      release: undefined,
      versions: ["1.0"],
      lastUpdated: "20260101000000",
    });
  });

  it("escapes XML", () => {
    expect(escapeXml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;",
    );
  });

  it("formats timestamps", () => {
    expect(lastUpdatedStamp("2026-01-02T03:04:05.678Z")).toBe("20260102030405");
    expect(snapshotTimestamp("2026-01-02T03:04:05.678Z")).toBe("20260102.030405");
  });
});

describe("pom", () => {
  it("reads packaging and goal prefix", () => {
    const pom = `<project>
      <parent><artifactId>p</artifactId><name>Parent</name></parent>
      <artifactId>x-maven-plugin</artifactId>
      <name>X plugin</name>
      <packaging>maven-plugin</packaging>
      <build><plugins><plugin><artifactId>maven-plugin-plugin</artifactId>
        <configuration><goalPrefix>ex</goalPrefix></configuration></plugin></plugins></build>
    </project>`;
    expect(parsePom(pom)).toEqual({
      packaging: "maven-plugin",
      goalPrefix: "ex",
      name: "X plugin",
    });
    expect(parsePom("<project><artifactId>a</artifactId></project>").packaging).toBe("jar");
  });

  it("derives plugin prefixes", () => {
    expect(pluginPrefix("x-maven-plugin")).toBe("x");
    expect(pluginPrefix("maven-surefire-plugin")).toBe("surefire");
    expect(pluginPrefix("maven-plugin-plugin")).toBe("plugin");
  });
});
