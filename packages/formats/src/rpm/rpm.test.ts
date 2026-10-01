import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  depFlag,
  filelistsPackage,
  metadataHead,
  metadataTail,
  nevra,
  otherPackage,
  parseNevra,
  parseRpm,
  primaryPackage,
  repomdXml,
  rpmHeaderSpan,
  rpmvercmp,
  splitEvr,
  xmlEscape,
  type MetadataKind,
} from "./index.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

const FILES = [
  "basesystem-11-20.fc40.noarch.rpm",
  "which-2.21-20.el8.x86_64.rpm",
  "which-2.23-4.fc44.x86_64.rpm",
];

describe("rpm header parsing", () => {
  it("parses a real Fedora package", () => {
    const pkg = parseRpm(fixture("which-2.23-4.fc44.x86_64.rpm"));
    expect(nevra(pkg)).toBe("which-2.23-4.fc44.x86_64");
    expect(pkg.license).toBe("GPL-3.0-only");
    expect(pkg.headerStart).toBe(4504);
    expect(pkg.headerEnd).toBe(10501);
    expect(pkg.requires.map((r) => r.name)).not.toContain("rpmlib(CompressedFileNames)");
    expect(pkg.files).toContainEqual({ path: "/usr/share/doc/which", type: "dir" });
  });

  it("finds the header span from a prefix", () => {
    const bytes = fixture("which-2.21-20.el8.x86_64.rpm");
    let need = rpmHeaderSpan(bytes.subarray(0, 50));
    expect(need).toBe(112);
    need = rpmHeaderSpan(bytes.subarray(0, need));
    need = rpmHeaderSpan(bytes.subarray(0, need));
    expect(need).toBe(17428);
    expect(parseRpm(bytes.subarray(0, need)).name).toBe("which");
    expect(() => rpmHeaderSpan(new Uint8Array(200))).toThrow(/not an RPM/);
  });

  it("maps dependency flags and EVRs", () => {
    expect(depFlag(8)).toBe("EQ");
    expect(depFlag(12)).toBe("GE");
    expect(depFlag(2 | 8)).toBe("LE");
    expect(depFlag(0)).toBeUndefined();
    expect(splitEvr("1:2.0-3.fc40")).toEqual({ epoch: "1", ver: "2.0", rel: "3.fc40" });
    expect(splitEvr("2.0")).toEqual({ epoch: "0", ver: "2.0" });
  });

  it("parses NEVRAs", () => {
    expect(parseNevra("my-pkg-1:2.0-3.el9.x86_64")).toEqual({
      name: "my-pkg",
      epoch: "1",
      version: "2.0",
      release: "3.el9",
      arch: "x86_64",
    });
    expect(parseNevra("which-2.21-20.el8.x86_64.rpm")?.name).toBe("which");
    expect(parseNevra("nope")).toBeNull();
  });

  it("compares versions like rpmvercmp", () => {
    expect(rpmvercmp("1.0", "1.0")).toBe(0);
    expect(rpmvercmp("1.10", "1.9")).toBe(1);
    expect(rpmvercmp("1.0~rc1", "1.0")).toBe(-1);
    expect(rpmvercmp("1.0^git1", "1.0")).toBe(1);
    expect(rpmvercmp("1.0a", "1.0")).toBe(1);
    expect(rpmvercmp("2.34", "2.14")).toBe(1);
  });

  it("escapes XML", () => {
    expect(xmlEscape(`a<b>&"c'\u0001`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
  });
});

describe("createrepo_c compatibility", () => {
  const packages = FILES.map((name) => {
    const bytes = fixture(name);
    return {
      pkg: parseRpm(bytes),
      info: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        size: bytes.length,
        location: name,
        fileTime: 1790224889,
      },
    };
  });

  const render = (kind: MetadataKind) => {
    const body = packages
      .map(({ pkg, info }) =>
        kind === "primary"
          ? primaryPackage(pkg, info)
          : kind === "filelists"
            ? filelistsPackage(pkg, info)
            : otherPackage(pkg, info),
      )
      .join("");
    return metadataHead(kind, packages.length) + body + metadataTail(kind);
  };

  for (const kind of ["primary", "filelists", "other"] as const) {
    it(`matches createrepo_c ${kind}.xml byte for byte`, () => {
      const expected = new TextDecoder().decode(fixture(`createrepo-${kind}.xml`));
      expect(render(kind).trimEnd()).toBe(expected.trimEnd());
    });
  }

  it("writes repomd.xml", () => {
    const xml = repomdXml(1790224898, [
      {
        type: "primary",
        checksum: "a".repeat(64),
        openChecksum: "b".repeat(64),
        location: `repodata/${"a".repeat(64)}-primary.xml.gz`,
        timestamp: 1790224898,
        size: 10,
        openSize: 20,
      },
    ]);
    expect(xml).toContain('<repomd xmlns="http://linux.duke.edu/metadata/repo"');
    expect(xml).toContain("<revision>1790224898</revision>");
    expect(xml).toContain('<open-checksum type="sha256">');
  });
});
