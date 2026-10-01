import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  compareVersions,
  controlFromMember,
  debFilename,
  debIdentity,
  field,
  formatStanza,
  locateControlMember,
  packagesStanza,
  parseDeb822,
  poolPath,
  readDebControl,
  releaseFile,
  rfc2822,
} from "./index.ts";

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));

describe("deb control extraction", () => {
  for (const compression of ["gzip", "xz", "zstd"]) {
    it(`reads control.tar with ${compression}`, () => {
      const control = readDebControl(fixture(`arttest_1.0-1_amd64-${compression}.deb`));
      const [stanza] = parseDeb822(control);
      expect(debIdentity(stanza!)).toEqual({
        package: "arttest",
        version: "1.0-1",
        architecture: "amd64",
        source: "arttest",
      });
      expect(field(stanza!, "description")).toBe(
        // The fixture .debs were built for artifatrix, where these libraries come from.
        "artifatrix test package (" +
          compression +
          ")\n A tiny package used by the artifatrix tests.\n .\n It contains a single README.",
      );
    });
  }

  it("reads real Debian (xz) and Ubuntu (zstd) packages", () => {
    const debian = parseDeb822(readDebControl(fixture("hello_2.10-3_amd64.deb")))[0]!;
    expect(field(debian, "Version")).toBe("2.10-3");
    expect(field(debian, "Breaks")).toBe("hello-debhelper (<< 2.9)");
    const ubuntu = parseDeb822(readDebControl(fixture("hello_2.10-3build1_amd64.deb")))[0]!;
    expect(field(ubuntu, "Version")).toBe("2.10-3build1");
  });

  it("locates the control member from a prefix", () => {
    const deb = fixture("hello_2.10-3_amd64.deb");
    expect(locateControlMember(deb.subarray(0, 70))).toBeNull();
    const location = locateControlMember(deb.subarray(0, 200))!;
    expect(location.name).toBe("control.tar.xz");
    const control = controlFromMember(
      location.name,
      deb.subarray(location.offset, location.offset + location.size),
    );
    expect(control).toContain("Package: hello");
    expect(() => locateControlMember(new TextEncoder().encode("PK\u0003\u0004 nope"))).toThrow();
  });

  it("round-trips stanzas and orders file fields before Description", () => {
    const control = readDebControl(fixture("hello_2.10-3_amd64.deb"));
    const [stanza] = parseDeb822(control);
    expect(formatStanza(stanza!)).toBe(control.endsWith("\n") ? control : `${control}\n`);
    const entry = packagesStanza(stanza!, {
      filename: "pool/main/h/hello/hello_2.10-3_amd64.deb",
      size: 53080,
      md5: "m",
      sha1: "s1",
      sha256: "s256",
    });
    expect(entry).toMatch(
      /Homepage: [^\n]+\nFilename: pool\/main\/h\/hello\/[^\n]+\nSize: 53080\n/,
    );
    expect(entry).toMatch(/SHA256: s256\nDescription: example package/);
  });
});

describe("dpkg version ordering", () => {
  const cases: [string, string, number][] = [
    ["1.0", "1.0", 0],
    ["1.0", "1.1", -1],
    ["1.0~rc1", "1.0", -1],
    ["1.0", "1.0+b1", -1],
    ["1:0.1", "2.0", 1],
    ["1.0-1", "1.0-2", -1],
    ["1.0-10", "1.0-9", 1],
    ["1.0a", "1.0", 1],
    ["1.0", "1.0-0", 0],
    ["2.10-3build1", "2.10-3", 1],
    ["1.2.3~~", "1.2.3~", -1],
  ];
  for (const [a, b, want] of cases) {
    it(`${a} vs ${b}`, () => {
      expect(compareVersions(a, b)).toBe(want);
      expect(compareVersions(b, a)).toBe(-want || 0);
    });
  }
});

describe("naming and Release", () => {
  it("builds pool paths and file names", () => {
    expect(poolPath("main", "hello", "hello_1_amd64.deb")).toBe(
      "pool/main/h/hello/hello_1_amd64.deb",
    );
    expect(poolPath("main", "libfoo", "x.deb")).toBe("pool/main/libf/libfoo/x.deb");
    expect(debFilename({ package: "a", version: "2:1.0-1", architecture: "all" })).toBe(
      "a_1.0-1_all.deb",
    );
  });

  it("formats RFC 2822 dates in UTC", () => {
    expect(rfc2822(new Date("2026-09-20T10:04:05Z"))).toBe("Sun, 20 Sep 2026 10:04:05 UTC");
  });

  it("writes a Release file", () => {
    const text = releaseFile({
      origin: "gitmatrix",
      label: "deb",
      suite: "stable",
      codename: "stable",
      date: new Date("2026-09-20T10:00:00Z"),
      architectures: ["amd64", "arm64"],
      components: ["main"],
      acquireByHash: true,
      files: [{ path: "main/binary-amd64/Packages", size: 10, md5: "a", sha1: "b", sha256: "c" }],
    });
    expect(text).toContain("Acquire-By-Hash: yes\n");
    expect(text).toContain(`SHA256:\n c ${" ".repeat(14)}10 main/binary-amd64/Packages\n`);
    expect(parseDeb822(text)).toHaveLength(1);
  });
});
