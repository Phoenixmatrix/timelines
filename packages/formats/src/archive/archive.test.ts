import { describe, expect, it } from "vite-plus/test";

import {
  findTarEntry,
  gzipSync,
  readAr,
  readTar,
  readTarGz,
  readZip,
  strFromU8,
  writeTar,
  zipSync,
} from "./index.ts";

describe("archives", () => {
  it("round-trips tar and tar.gz", () => {
    const tar = writeTar([
      { name: "package/package.json", data: '{"name":"x"}' },
      { name: "package/README.md", data: "# x" },
    ]);
    const entries = readTar(tar);
    expect(entries.map((e) => e.name)).toEqual(["package/package.json", "package/README.md"]);
    const gz = readTarGz(gzipSync(tar));
    expect(strFromU8(findTarEntry(gz, (p) => p.endsWith("package.json"))!.data)).toBe(
      '{"name":"x"}',
    );
  });

  it("reads zip members", () => {
    const zip = zipSync({
      "a/METADATA": new TextEncoder().encode("Name: a"),
      "a/other": new Uint8Array(3),
    });
    const files = readZip(zip, (n) => n.endsWith("METADATA"));
    expect(Object.keys(files)).toEqual(["a/METADATA"]);
  });

  it("reads ar archives with odd-sized members", () => {
    const enc = new TextEncoder();
    const member = (name: string, data: string) => {
      const header = `${name.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(data.length).padEnd(10)}\`\n`;
      return header + data + (data.length % 2 ? "\n" : "");
    };
    const ar = enc.encode(
      `!<arch>\n${member("debian-binary", "2.0\n")}${member("control.tar.gz", "abc")}`,
    );
    const members = readAr(ar);
    expect(members.map((m) => [m.name, m.size])).toEqual([
      ["debian-binary", 4],
      ["control.tar.gz", 3],
    ]);
  });
});
