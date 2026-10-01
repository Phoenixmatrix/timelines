import { createHash } from "node:crypto";
import { describe, expect, it } from "vite-plus/test";

import { gzipSync, writeTar } from "../archive/index.ts";
import {
  abbreviatePackument,
  buildPackument,
  distTagError,
  escapeName,
  highestVersion,
  integrityFromHex,
  isValidVersion,
  mergePackuments,
  namePath,
  packageNameError,
  parseIntegrity,
  parseNpmPath,
  PublishBodyError,
  PublishBodyScanner,
  resolveSpec,
  sanitizeManifest,
  searchObject,
  searchResponse,
  searchScore,
  tarballFilename,
  TarballStats,
  versionForFile,
  versionFromFilename,
  type Packument,
  type ScanEvent,
} from "./index.ts";

describe("package names", () => {
  it("accepts valid names", () => {
    for (const name of ["left-pad", "@scope/pkg", "a", "some.pkg", "x_y", "@a/b.c"]) {
      expect(packageNameError(name), name).toBeNull();
    }
  });

  it("rejects invalid names", () => {
    for (const name of [
      "",
      ".hidden",
      "_private",
      " space",
      "Upper",
      "node_modules",
      "favicon.ico",
      "a".repeat(215),
      "bad~name",
      "hello world",
      "@scope/",
      "@scope",
      "@scope/_x",
      "@sc ope/x",
      "a/b",
    ]) {
      expect(packageNameError(name), name).not.toBeNull();
    }
    expect(packageNameError(42)).not.toBeNull();
  });

  it("escapes names for URLs", () => {
    expect(escapeName("@scope/pkg")).toBe("@scope%2fpkg");
    expect(escapeName("pkg")).toBe("pkg");
    expect(namePath("@scope/pkg")).toBe("@scope/pkg");
  });
});

describe("versions and tags", () => {
  it("validates strict semver", () => {
    expect(isValidVersion("1.0.0")).toBe(true);
    expect(isValidVersion("1.0.0-beta.1")).toBe(true);
    // npm strips build metadata before publishing.
    expect(isValidVersion("1.0.0+build")).toBe(false);
    expect(isValidVersion("v1.0.0")).toBe(false);
    expect(isValidVersion("1.0")).toBe(false);
  });

  it("refuses tags that look like ranges", () => {
    expect(distTagError("beta")).toBeNull();
    expect(distTagError("1.x")).not.toBeNull();
    expect(distTagError("")).not.toBeNull();
    expect(distTagError("a/b")).not.toBeNull();
  });

  it("prefers stable versions for latest", () => {
    expect(highestVersion(["1.0.0", "2.0.0-rc.1", "1.5.0"])).toBe("1.5.0");
    expect(highestVersion(["2.0.0-rc.1"])).toBe("2.0.0-rc.1");
    expect(highestVersion([])).toBeNull();
  });
});

describe("integrity", () => {
  it("round-trips sha512 SRI strings", () => {
    const hex = createHash("sha512").update("x").digest("hex");
    const sri = integrityFromHex("sha512", hex);
    expect(sri).toBe(`sha512-${createHash("sha512").update("x").digest("base64")}`);
    expect(
      parseIntegrity(`${sri} sha1-${createHash("sha1").update("x").digest("base64")}`),
    ).toEqual({
      sha512: hex,
      sha1: createHash("sha1").update("x").digest("hex"),
    });
    expect(parseIntegrity("garbage")).toEqual({});
    expect(parseIntegrity(undefined)).toEqual({});
  });
});

describe("tarball names", () => {
  it("drops the scope", () => {
    expect(tarballFilename("@scope/pkg", "1.0.0")).toBe("pkg-1.0.0.tgz");
    expect(versionFromFilename("@scope/pkg", "pkg-1.0.0-beta.1.tgz")).toBe("1.0.0-beta.1");
    expect(versionFromFilename("pkg", "other-1.0.0.tgz")).toBeNull();
    expect(versionFromFilename("pkg", "pkg-latest.tgz")).toBeNull();
  });
});

describe("paths", () => {
  it("classifies package routes", () => {
    expect(parseNpmPath("left-pad")).toEqual({ kind: "packument", name: "left-pad" });
    expect(parseNpmPath("@scope%2fpkg")).toEqual({ kind: "packument", name: "@scope/pkg" });
    expect(parseNpmPath("@scope%2Fpkg")).toEqual({ kind: "packument", name: "@scope/pkg" });
    expect(parseNpmPath("@scope/pkg")).toEqual({ kind: "packument", name: "@scope/pkg" });
    expect(parseNpmPath("@scope/pkg/1.0.0")).toEqual({
      kind: "version",
      name: "@scope/pkg",
      spec: "1.0.0",
    });
    expect(parseNpmPath("@scope/pkg/-/pkg-1.0.0.tgz")).toEqual({
      kind: "tarball",
      name: "@scope/pkg",
      file: "pkg-1.0.0.tgz",
    });
    expect(parseNpmPath("pkg/-rev/3-abc")).toEqual({ kind: "rev", name: "pkg", rev: "3-abc" });
    expect(parseNpmPath("pkg/-/pkg-1.0.0.tgz/-rev/3-abc")).toEqual({
      kind: "tarball",
      name: "pkg",
      file: "pkg-1.0.0.tgz",
      rev: "3-abc",
    });
    expect(parseNpmPath("npm/repo/@s/pkg/-/pkg-1.0.0.tgz/-rev/3-abc")).toEqual({
      kind: "tarball",
      name: "@s/pkg",
      file: "pkg-1.0.0.tgz",
      rev: "3-abc",
    });
    expect(parseNpmPath("npm/1.0.0")).toEqual({ kind: "version", name: "npm", spec: "1.0.0" });
    expect(parseNpmPath("a/b/c")).toEqual({ kind: "unknown" });
    expect(parseNpmPath("%E0%A4%A")).toEqual({ kind: "unknown" });
  });

  it("classifies endpoints", () => {
    expect(parseNpmPath("-/ping")).toEqual({ kind: "ping" });
    expect(parseNpmPath("-/whoami")).toEqual({ kind: "whoami" });
    expect(parseNpmPath("-/v1/search")).toEqual({ kind: "search" });
    expect(parseNpmPath("-/v1/login")).toEqual({ kind: "webLogin" });
    expect(parseNpmPath("-/v1/done/abc.def")).toEqual({ kind: "webLoginDone", id: "abc.def" });
    expect(parseNpmPath("-/user/org.couchdb.user:bob")).toEqual({ kind: "couchUser", user: "bob" });
    expect(parseNpmPath("-/package/@s%2fp/dist-tags")).toEqual({ kind: "distTags", name: "@s/p" });
    expect(parseNpmPath("-/package/p/dist-tags/beta")).toEqual({
      kind: "distTags",
      name: "p",
      tag: "beta",
    });
    expect(parseNpmPath("-/npm/v1/security/advisories/bulk")).toEqual({ kind: "auditBulk" });
    expect(parseNpmPath("-/npm/v1/security/audits/quick")).toEqual({ kind: "auditQuick" });
    expect(parseNpmPath("-/v1/tokens")).toEqual({ kind: "unknown" });
  });
});

const stored = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  createdAt: `2026-01-0${version[0]}T00:00:00.000Z`,
  manifest: {
    name: "pkg",
    version,
    description: `v${version}`,
    scripts: { postinstall: "node x" },
    dependencies: { a: "^1" },
    dist: { tarball: `pkg-${version}.tgz`, shasum: "aa", integrity: "sha512-bb" },
    ...extra,
  },
});

describe("packuments", () => {
  const doc = buildPackument({
    name: "pkg",
    rev: "2-abc",
    distTags: { latest: "1.0.0" },
    versions: [stored("2.0.0-beta.1"), stored("1.0.0", { deprecated: "old" })],
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-02T00:00:00.000Z",
    readme: "# pkg",
    tarballUrl: (file) => `https://r.test/npm/x/pkg/-/${file}`,
  });

  it("builds the full document", () => {
    expect(doc._id).toBe("pkg");
    expect(doc._rev).toBe("2-abc");
    expect(Object.keys(doc.versions)).toEqual(["1.0.0", "2.0.0-beta.1"]);
    expect(doc.versions["1.0.0"]!.dist.tarball).toBe("https://r.test/npm/x/pkg/-/pkg-1.0.0.tgz");
    expect(doc.versions["1.0.0"]!._id).toBe("pkg@1.0.0");
    expect(doc.time!["1.0.0"]).toBe("2026-01-01T00:00:00.000Z");
    expect(doc.readme).toBe("# pkg");
    expect(doc.description).toBe("v1.0.0");
  });

  it("abbreviates", () => {
    const short = abbreviatePackument(doc);
    expect(short.modified).toBe("2026-01-02T00:00:00.000Z");
    expect(short.readme).toBeUndefined();
    expect(short.versions["1.0.0"]).toEqual({
      name: "pkg",
      version: "1.0.0",
      deprecated: "old",
      dependencies: { a: "^1" },
      dist: doc.versions["1.0.0"]!.dist,
      hasInstallScript: true,
    });
  });

  it("resolves specs and files", () => {
    expect(resolveSpec(doc, "latest")).toBe("1.0.0");
    expect(resolveSpec(doc, "2.0.0-beta.1")).toBe("2.0.0-beta.1");
    expect(resolveSpec(doc, "^1")).toBe("1.0.0");
    expect(resolveSpec(doc, "nope")).toBeNull();
    expect(versionForFile(doc, "pkg-2.0.0-beta.1.tgz")?.version).toBe("2.0.0-beta.1");
    expect(versionForFile(doc, "pkg-9.0.0.tgz")).toBeNull();
  });

  it("merges first-wins", () => {
    const other: Packument = {
      name: "pkg",
      "dist-tags": { latest: "3.0.0" },
      versions: {
        "1.0.0": { name: "pkg", version: "1.0.0", dist: { tarball: "https://o/1" } },
        "3.0.0": { name: "pkg", version: "3.0.0", dist: { tarball: "https://o/3" } },
      },
      time: { "3.0.0": "2026-02-01T00:00:00.000Z" },
    };
    const merged = mergePackuments([doc, other]);
    expect(merged["dist-tags"]).toEqual({ latest: "1.0.0" });
    expect(merged.versions["1.0.0"]!.dist.tarball).toContain("r.test");
    expect(merged.versions["3.0.0"]!.dist.tarball).toBe("https://o/3");
    expect(merged.time!["3.0.0"]).toBe("2026-02-01T00:00:00.000Z");
  });

  it("sanitizes manifests", () => {
    expect(
      sanitizeManifest({
        name: "p",
        version: "1.0.0",
        readme: "x",
        _npmUser: "evil",
        _nodeVersion: "22",
        _secret: 1,
        dist: { tarball: "x" },
        scripts: { install: "x" },
      }),
    ).toEqual({
      name: "p",
      version: "1.0.0",
      _nodeVersion: "22",
      scripts: { install: "x" },
      hasInstallScript: true,
    });
  });
});

describe("search", () => {
  it("scores and shapes results", () => {
    const entry = { name: "@s/left-pad", description: "pads strings", keywords: ["pad"] };
    expect(searchScore(entry, ["left-pad"])).toBe(10);
    expect(searchScore(entry, ["pad"])).toBe(5);
    expect(searchScore(entry, ["strings"])).toBe(1);
    expect(searchScore(entry, ["nope"])).toBe(0);
    const response = searchResponse(
      [searchObject({ ...entry, version: "1.0.0", date: "2026-01-01T00:00:00.000Z" }, 10)],
      1,
    );
    expect(response.total).toBe(1);
    expect(response.objects[0]!.package.scope).toBe("s");
    expect(response.objects[0]!.score.final).toBe(10);
  });
});

function scan(body: string, chunkSize: number, max = 1 << 20) {
  const scanner = new PublishBodyScanner({ maxMetadataBytes: max });
  const bytes = new TextEncoder().encode(body);
  const events: ScanEvent[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    events.push(...scanner.push(bytes.subarray(i, i + chunkSize)));
  }
  return { events, meta: scanner.finish() as Record<string, unknown> };
}

function collect(events: ScanEvent[]) {
  const out: { name: string; data: number[] }[] = [];
  for (const event of events) {
    if (event.type === "attachment") out.push({ name: event.name, data: [] });
    if (event.type === "data") out.at(-1)!.data.push(...event.bytes);
  }
  return out.map((a) => ({ name: a.name, data: Buffer.from(a.data).toString() }));
}

describe("publish body scanner", () => {
  const payload = "hello, tarball! é";
  const b64 = Buffer.from(payload).toString("base64");

  for (const chunk of [1, 3, 7, 64, 100_000]) {
    it(`streams attachments out of the JSON (chunk ${chunk})`, () => {
      const body = JSON.stringify({
        _id: "p",
        name: "p",
        readme: 'quote " and \\ "data": "x"',
        _attachments: {
          "p-1.0.0.tgz": { content_type: "application/octet-stream", data: b64, length: 20 },
        },
        versions: { "1.0.0": { name: "p", data: "not-an-attachment" } },
      });
      const { events, meta } = scan(body, chunk);
      expect(collect(events)).toEqual([{ name: "p-1.0.0.tgz", data: payload }]);
      expect(events.at(-1)).toEqual({ type: "end" });
      expect(
        (meta._attachments as Record<string, { data: string; length: number }>)["p-1.0.0.tgz"],
      ).toEqual({
        content_type: "application/octet-stream",
        data: "",
        length: 20,
      });
      expect(meta.readme).toBe('quote " and \\ "data": "x"');
      expect((meta.versions as Record<string, { data: string }>)["1.0.0"]!.data).toBe(
        "not-an-attachment",
      );
    });
  }

  it("decodes every padding length", () => {
    for (const text of ["a", "ab", "abc", "abcd"]) {
      const unpadded = Buffer.from(text).toString("base64").replace(/=+$/, "");
      for (const data of [Buffer.from(text).toString("base64"), unpadded]) {
        const { events } = scan(JSON.stringify({ _attachments: { f: { data } } }), 2);
        expect(collect(events)[0]!.data).toBe(text);
      }
    }
  });

  it("rejects malformed bodies", () => {
    expect(() => scan("[]", 10)).toThrow(PublishBodyError);
    expect(() => scan('{"a": ', 10)).toThrow(PublishBodyError);
    expect(() => scan(JSON.stringify({ _attachments: { f: { data: "a\\/b" } } }), 10)).toThrow(
      PublishBodyError,
    );
    expect(() => scan(JSON.stringify({ _attachments: { f: { data: "!!!!" } } }), 10)).toThrow(
      PublishBodyError,
    );
    let error: unknown;
    try {
      scan(JSON.stringify({ readme: "x".repeat(200) }), 10, 100);
    } catch (e) {
      error = e;
    }
    expect((error as PublishBodyError).tooLarge).toBe(true);
  });
});

describe("tarball stats", () => {
  it("counts files and unpacked bytes while streaming", () => {
    const tgz = gzipSync(
      writeTar([
        { name: "package/package.json", data: '{"name":"p"}' },
        { name: "package/index.js", data: "x".repeat(1500) },
      ]),
    );
    const stats = new TarballStats();
    for (let i = 0; i < tgz.length; i += 17) stats.push(tgz.subarray(i, i + 17));
    stats.finish();
    expect(stats.result()).toEqual({ fileCount: 2, unpackedSize: 12 + 1500 });
  });

  it("flags non-tarballs", () => {
    const stats = new TarballStats();
    stats.push(new TextEncoder().encode("not gzip at all"));
    stats.finish();
    expect(stats.result()).toBeNull();
    expect(stats.error).toBe("corrupt");
  });
});
