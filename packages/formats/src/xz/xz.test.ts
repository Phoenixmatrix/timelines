import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { crc32, isXz, xzDecompress } from "./index.ts";

const dir = new URL("./fixtures/", import.meta.url);
const expected = JSON.parse(readFileSync(new URL("expected.json", dir), "utf8")) as Record<
  string,
  string
>;

describe("xz", () => {
  for (const [name, sha256] of Object.entries(expected)) {
    it(`decodes ${name}`, () => {
      const input = new Uint8Array(readFileSync(new URL(name, dir)));
      expect(isXz(input)).toBe(true);
      const out = xzDecompress(input);
      expect(createHash("sha256").update(out).digest("hex")).toBe(sha256);
    });
  }

  it("computes CRC32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("rejects corrupt input", () => {
    const input = new Uint8Array(readFileSync(new URL("bin-9e.xz", dir)));
    const broken = input.slice();
    broken[200] = broken[200]! ^ 0xff;
    expect(() => xzDecompress(broken)).toThrow(/xz:/);
    expect(() => xzDecompress(new Uint8Array([1, 2, 3]))).toThrow(/not an xz stream/);
  });

  it("caps output size", () => {
    const input = new Uint8Array(readFileSync(new URL("text.xz", dir)));
    expect(() => xzDecompress(input, { maxOutput: 1000 })).toThrow(/exceeds/);
  });
});
