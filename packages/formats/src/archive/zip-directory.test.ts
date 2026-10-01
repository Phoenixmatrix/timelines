import { describe, expect, it } from "vite-plus/test";

import { strFromU8, strToU8, zipSync } from "./index.ts";
import { bytesReader, readZipDirectory, readZipEntry, ZipFormatError } from "./zip-directory.ts";

describe("random-access zip", () => {
  it("reads the directory and single entries through a range reader", async () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 7);
    const zip = zipSync(
      { "pkg-1.0.dist-info/METADATA": strToU8("Name: pkg\n"), "pkg/data.bin": big },
      { level: 6 },
    );
    const read = async (offset: number, length: number) => zip.subarray(offset, offset + length);
    const entries = await readZipDirectory(read, zip.length);
    expect(entries.map((e) => e.name)).toEqual(["pkg-1.0.dist-info/METADATA", "pkg/data.bin"]);
    expect(strFromU8(await readZipEntry(read, entries[0]!))).toBe("Name: pkg\n");
    expect(await readZipEntry(read, entries[1]!)).toEqual(big);
    await expect(readZipEntry(read, entries[1]!, { maxBytes: 10 })).rejects.toThrow(/larger/);
  });

  it("detects corrupted entries", async () => {
    const zip = zipSync({ "a.txt": strToU8("hello hello hello") }, { level: 0 });
    const entries = await readZipDirectory(bytesReader(zip), zip.length);
    const corrupt = zip.slice();
    corrupt[30 + "a.txt".length] = corrupt[30 + "a.txt".length]! ^ 0xff;
    await expect(readZipEntry(bytesReader(corrupt), entries[0]!)).rejects.toThrow(/checksum/);
  });

  it("rejects non-zips", async () => {
    await expect(readZipDirectory(bytesReader(new Uint8Array(100)), 100)).rejects.toThrow(
      ZipFormatError,
    );
  });
});
