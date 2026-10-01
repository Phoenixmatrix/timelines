import { describe, expect, it } from "vite-plus/test";

import { bytesReader, readZipDirectory, readZipEntry, strToU8, zipSync } from "../archive/index.ts";
import {
  checkModulePath,
  checkModuleZip,
  checkVersionForPath,
  compareSemver,
  escapeModulePath,
  escapeVersion,
  goModModulePath,
  isCanonicalVersion,
  isPseudoVersion,
  latestVersion,
  parseProxyPath,
  sortVersions,
  unescapeModulePath,
  unescapeVersion,
} from "./index.ts";

describe("case escaping", () => {
  it("round-trips module paths", () => {
    expect(escapeModulePath("github.com/Azure/azure-sdk")).toBe("github.com/!azure/azure-sdk");
    expect(unescapeModulePath("github.com/!azure/azure-sdk")).toBe("github.com/Azure/azure-sdk");
    expect(unescapeModulePath("github.com/Azure/x")).toBeNull();
    expect(unescapeModulePath("github.com/!/x")).toBeNull();
    expect(unescapeModulePath("github.com/x!")).toBeNull();
    expect(escapeVersion("v1.0.0-RC1")).toBe("v1.0.0-!r!c1");
    expect(unescapeVersion("v1.0.0-!r!c1")).toBe("v1.0.0-RC1");
  });
});

describe("module paths", () => {
  it("validates like golang.org/x/mod", () => {
    expect(checkModulePath("acme.dev/tools/cli")).toBeNull();
    expect(checkModulePath("acme.dev/tools/v2")).toBeNull();
    expect(checkModulePath("gopkg.in/yaml.v3")).toBeNull();
    expect(checkModulePath("acme/tools")).toContain("missing dot");
    expect(checkModulePath("-acme.dev/x")).toContain("leading dash");
    expect(checkModulePath("Acme.dev/x")).toContain("invalid char");
    expect(checkModulePath("acme.dev/../x")).not.toBeNull();
    expect(checkModulePath("acme.dev/.hidden")).toContain("leading dot");
    expect(checkModulePath("acme.dev/x/v1")).toContain("major");
    expect(checkModulePath("acme.dev/x/v02")).toContain("major");
    expect(checkModulePath("acme.dev//x")).not.toBeNull();
    expect(checkModulePath("acme.dev/con")).toContain("Windows");
  });
});

describe("versions", () => {
  it("checks canonical versions", () => {
    expect(isCanonicalVersion("v1.2.3")).toBe(true);
    expect(isCanonicalVersion("v1.2.3-pre.1")).toBe(true);
    expect(isCanonicalVersion("v2.0.0+incompatible")).toBe(true);
    expect(isCanonicalVersion("v1.2")).toBe(false);
    expect(isCanonicalVersion("1.2.3")).toBe(false);
    expect(isCanonicalVersion("v1.2.3+build")).toBe(false);
    expect(isCanonicalVersion("v01.2.3")).toBe(false);
  });

  it("detects pseudo-versions", () => {
    expect(isPseudoVersion("v0.0.0-20191109021931-daa7c04131f5")).toBe(true);
    expect(isPseudoVersion("v1.2.4-0.20191109021931-daa7c04131f5")).toBe(true);
    expect(isPseudoVersion("v1.2.3-pre.0.20191109021931-daa7c04131f5")).toBe(true);
    expect(isPseudoVersion("v1.2.3-pre")).toBe(false);
  });

  it("orders by semver precedence", () => {
    expect(
      sortVersions([
        "v1.10.0",
        "v1.2.0",
        "v1.2.0-rc.1",
        "v1.2.0-beta.11",
        "v1.2.0-beta.2",
        "v0.0.0-20191109021931-daa7c04131f5",
        "v2.0.0+incompatible",
      ]),
    ).toEqual([
      "v0.0.0-20191109021931-daa7c04131f5",
      "v1.2.0-beta.2",
      "v1.2.0-beta.11",
      "v1.2.0-rc.1",
      "v1.2.0",
      "v1.10.0",
      "v2.0.0+incompatible",
    ]);
    expect(compareSemver("v1.0.0", "v1.0.0")).toBe(0);
  });

  it("picks @latest: release, then prerelease, then pseudo", () => {
    expect(latestVersion(["v1.0.0", "v1.1.0-rc.1"])).toBe("v1.0.0");
    expect(latestVersion(["v1.1.0-rc.1", "v0.0.0-20191109021931-daa7c04131f5"])).toBe(
      "v1.1.0-rc.1",
    );
    expect(latestVersion(["v0.0.0-20191109021931-daa7c04131f5"])).toBe(
      "v0.0.0-20191109021931-daa7c04131f5",
    );
    expect(latestVersion([])).toBeNull();
  });

  it("enforces major version suffixes", () => {
    expect(checkVersionForPath("acme.dev/x", "v1.0.0")).toBeNull();
    expect(checkVersionForPath("acme.dev/x", "v2.0.0")).toContain("should be v0 or v1");
    expect(checkVersionForPath("acme.dev/x", "v2.0.0+incompatible")).toBeNull();
    expect(checkVersionForPath("acme.dev/x", "v1.0.0+incompatible")).not.toBeNull();
    expect(checkVersionForPath("acme.dev/x/v2", "v2.1.0")).toBeNull();
    expect(checkVersionForPath("acme.dev/x/v2", "v3.0.0")).toContain("should be v2");
    expect(checkVersionForPath("gopkg.in/yaml.v3", "v3.0.1")).toBeNull();
  });
});

describe("proxy paths", () => {
  it("parses every endpoint", () => {
    expect(parseProxyPath("github.com/!azure/x/@v/list")).toEqual({
      kind: "list",
      module: "github.com/Azure/x",
    });
    expect(parseProxyPath("acme.dev/x/@latest")).toEqual({ kind: "latest", module: "acme.dev/x" });
    expect(parseProxyPath("acme.dev/x/@v/v1.0.0-!r!c1.info")).toEqual({
      kind: "info",
      module: "acme.dev/x",
      version: "v1.0.0-RC1",
    });
    expect(parseProxyPath("acme.dev/x/@v/v2.0.0+incompatible.zip")).toMatchObject({
      kind: "zip",
      version: "v2.0.0+incompatible",
    });
    expect(parseProxyPath("acme.dev/x/@v/v1.0.0.tar")).toBeNull();
    expect(parseProxyPath("acme.dev/x")).toBeNull();
  });
});

describe("module zips", () => {
  const zip = (files: Record<string, string>) =>
    zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

  it("accepts a well-formed zip and finds go.mod through ranged reads", async () => {
    const bytes = zip({
      "acme.dev/x@v1.0.0/go.mod": "module acme.dev/x\n\ngo 1.22\n",
      "acme.dev/x@v1.0.0/x.go": "package x\n",
      "acme.dev/x@v1.0.0/.gitignore": "bin/\n",
    });
    const read = bytesReader(bytes);
    const entries = await readZipDirectory(read, bytes.length);
    const check = checkModuleZip(entries, "acme.dev/x", "v1.0.0", bytes.length);
    expect(check.errors).toEqual([]);
    const goMod = new TextDecoder().decode(
      await readZipEntry(
        read,
        entries.find((e) => e.name === check.goMod!.name)!,
      ),
    );
    expect(goModModulePath(goMod)).toBe("acme.dev/x");
  });

  it("rejects files outside the prefix, directories and case collisions", () => {
    const check = checkModuleZip(
      [
        { name: "acme.dev/x@v1.0.0/a.go", uncompressedSize: 1 },
        { name: "acme.dev/x@v1.0.0/A.go", uncompressedSize: 1 },
        { name: "acme.dev/x@v1.0.0/dir/", uncompressedSize: 0, directory: true },
        { name: "other/a.go", uncompressedSize: 1 },
        { name: "acme.dev/x@v1.0.0/../evil", uncompressedSize: 1 },
      ],
      "acme.dev/x",
      "v1.0.0",
    );
    expect(check.errors).toHaveLength(4);
    expect(check.goMod).toBeNull();
  });

  it("parses module directives", () => {
    expect(goModModulePath('// comment\nmodule "acme.dev/q" // trailing\n')).toBe("acme.dev/q");
    expect(goModModulePath("go 1.22\n")).toBeNull();
  });
});
