import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vite-plus/test";

import {
  applyDelta,
  compressFrame,
  decompressFrame,
  FRAME_SIZE,
  makeDelta,
  MAX_DELTA_SIZE,
} from "./index.ts";

function noise(length: number, seed = 0x12345678): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    bytes[i] = seed & 255;
  }
  return bytes;
}

function expectBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(
    Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(
      Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
    ),
  ).toBe(true);
}

// Deliberately construct hostile instruction streams rather than requiring
// the encoder to emit an invalid operation. Integers are unsigned little endian.
function malformed(size: number, operations: number[]): Uint8Array {
  const header = makeDelta(new Uint8Array(), new Uint8Array()).slice();
  new DataView(header.buffer).setUint32(4, size, true);
  return new Uint8Array([...header, ...operations]);
}

function u32(value: number): number[] {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return Array.from(bytes);
}

describe("artifact frame deltas", () => {
  it("reconstructs inserted, deleted and shifted byte runs with substantial savings", () => {
    const base = noise(240_000);
    const insertion = noise(71, 11);
    const target = new Uint8Array(base.length - 53 + insertion.length);
    target.set(base.subarray(0, 53_009));
    target.set(insertion, 53_009);
    target.set(base.subarray(53_009, 173_101), 53_009 + insertion.length);
    target.set(base.subarray(173_154), 173_101 + insertion.length);
    const delta = makeDelta(base, target);
    expect(delta.byteLength).toBeLessThan(target.byteLength / 100);
    expectBytes(applyDelta(base, delta, target.length), target);
    expectBytes(makeDelta(base, target), delta);
  });

  it("handles empty inputs, short literals, identical bytes and unrelated content", () => {
    const cases: [Uint8Array, Uint8Array][] = [
      [new Uint8Array(), new Uint8Array()],
      [noise(31), new Uint8Array()],
      [new Uint8Array(), noise(19)],
      [noise(7), noise(11, 33)],
      [noise(80_000), noise(80_000)],
      [noise(80_000), noise(91_001, 33)],
      [new Uint8Array(90_000).fill(7), new Uint8Array(100_000).fill(7)],
    ];
    for (const [base, target] of cases) {
      const delta = makeDelta(base, target);
      expectBytes(applyDelta(base, delta, target.length), target);
      const compressed = compressFrame(delta);
      expectBytes(decompressFrame(compressed.codec, compressed.data, delta.length), delta);
    }
  });

  it("bounds and reconstructs maximum frames, including shifted incompressible data", () => {
    const base = noise(FRAME_SIZE);
    const target = new Uint8Array(FRAME_SIZE);
    target.set(noise(37, 81));
    target.set(base.subarray(0, FRAME_SIZE - 37), 37);
    const delta = makeDelta(base, target);
    expect(delta.length).toBeLessThan(200);
    expectBytes(applyDelta(base, delta, FRAME_SIZE), target);
    const literal = makeDelta(new Uint8Array(), base);
    expect(literal.length).toBeLessThanOrEqual(MAX_DELTA_SIZE);
    expectBytes(applyDelta(new Uint8Array(), literal, FRAME_SIZE), base);
    const compressed = compressFrame(base);
    expect(compressed.codec).toBe("raw");
    expectBytes(decompressFrame(compressed.codec, compressed.data, FRAME_SIZE), base);
  });

  it("rejects truncated headers, unknown versions and mismatched output sizes", () => {
    const base = noise(64);
    const delta = makeDelta(base, base);
    for (let end = 0; end < delta.length; end++) {
      expect(() => applyDelta(base, delta.subarray(0, end), base.length)).toThrow();
    }
    const version = delta.slice();
    version[3] = 2;
    expect(() => applyDelta(base, version, base.length)).toThrow();
    expect(() => applyDelta(base, delta, base.length - 1)).toThrow();
    expect(() => applyDelta(base, new Uint8Array([...delta, 0]), base.length)).toThrow();
  });

  it("rejects overflowing, noncanonical and out-of-bounds instructions", () => {
    const cases: [number, number[]][] = [
      [1, [2]],
      [1, [0, ...u32(0)]],
      [1, [0, ...u32(0xffffffff), 7]],
      [2, [0, ...u32(2), 7]],
      [2, [0, ...u32(1), 7, 0, ...u32(1), 8]],
      [16, [1, ...u32(0), ...u32(0)]],
      [16, [1, ...u32(0xffffffff), ...u32(16)]],
      [16, [1, ...u32(60), ...u32(16)]],
      [16, [1, ...u32(0), ...u32(17)]],
      [32, [1, ...u32(0), ...u32(16), 1, ...u32(16), ...u32(16)]],
      [0, [0, ...u32(0)]],
    ];
    for (const [size, operations] of cases) {
      expect(() => applyDelta(noise(64), malformed(size, operations), size)).toThrow();
    }
  });

  it("rejects invalid allocation sizes before reconstruction", () => {
    const empty = new Uint8Array();
    const delta = makeDelta(empty, empty);
    for (const length of [-1, 0.5, NaN, Infinity, FRAME_SIZE + 1]) {
      expect(() => applyDelta(empty, delta, length)).toThrow();
    }
    expect(() => makeDelta(new Uint8Array(FRAME_SIZE + 1), empty)).toThrow();
    expect(() => makeDelta(empty, new Uint8Array(FRAME_SIZE + 1))).toThrow();
    expect(() => applyDelta(empty, new Uint8Array(MAX_DELTA_SIZE + 1), 0)).toThrow();
  });
});

describe("artifact frame compression", () => {
  it("compresses only when smaller and preserves original bytes", () => {
    for (const bytes of [
      new Uint8Array(),
      new Uint8Array([42]),
      noise(4096),
      new Uint8Array(40_000),
    ]) {
      const compressed = compressFrame(bytes);
      expectBytes(decompressFrame(compressed.codec, compressed.data, bytes.length), bytes);
      if (compressed.codec === "deflate") expect(compressed.data.length).toBeLessThan(bytes.length);
      else expectBytes(compressed.data, bytes);
    }
    expect(compressFrame(new Uint8Array(40_000)).codec).toBe("deflate");
    expectBytes(decompressFrame("deflate", deflateRawSync(new Uint8Array()), 0), new Uint8Array());
  });

  it("rejects truncated, trailing, oversized and wrong-length compressed data", () => {
    const compressed = deflateRawSync(new Uint8Array(100_000));
    expect(() => decompressFrame("deflate", compressed, 10)).toThrow();
    expect(() => decompressFrame("deflate", compressed, 100_001)).toThrow();
    expect(() =>
      decompressFrame("deflate", compressed.subarray(0, compressed.length - 1), 100_000),
    ).toThrow();
    expect(() => decompressFrame("deflate", new Uint8Array([...compressed, 0]), 100_000)).toThrow();
    expect(() => decompressFrame("raw", new Uint8Array(1), 0)).toThrow();
    for (const length of [-1, 0.5, NaN, Infinity, MAX_DELTA_SIZE + 1]) {
      expect(() => decompressFrame("deflate", compressed, length)).toThrow();
    }
    expect(() => compressFrame(new Uint8Array(MAX_DELTA_SIZE + 1))).toThrow();
    expect(() => decompressFrame("raw", new Uint8Array(MAX_DELTA_SIZE + 1), 0)).toThrow();
  });
});
