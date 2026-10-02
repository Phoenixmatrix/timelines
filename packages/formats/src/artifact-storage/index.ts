import { deflateRawSync, inflateRawSync } from "node:zlib";

export const FRAME_SIZE = 4 * 1024 * 1024;
// Eight header bytes plus one literal's five-byte overhead. Every copy saves
// at least seven bytes, enough to pay for another intervening literal header.
export const MAX_DELTA_SIZE = FRAME_SIZE + 13;
export type FrameCodec = "raw" | "deflate";

const WINDOW = 16;
const BUCKETS = 1 << 16;
const CANDIDATES = 4;
const MAGIC = 0x014c4441; // ADL, version 1 (little endian).
let rollingPower = 1;
for (let i = 1; i < WINDOW; i++) rollingPower = Math.imul(rollingPower, 31);

function checkLength(length: number, maximum: number): void {
  if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
    throw new RangeError("Artifact frame length exceeds its bound");
  }
}

export function compressFrame(bytes: Uint8Array): { codec: FrameCodec; data: Uint8Array } {
  checkLength(bytes.byteLength, MAX_DELTA_SIZE);
  if (bytes.byteLength > 1) {
    try {
      // info uses the portable bounded zlib path. Workers' buffer-only fast path
      // reports output overflow as an uncoded "Memory limit exceeded" RangeError.
      const result: unknown = deflateRawSync(bytes, {
        maxOutputLength: bytes.byteLength - 1,
        info: true,
      });
      const data: unknown =
        typeof result === "object" && result !== null ? Reflect.get(result, "buffer") : null;
      if (!(data instanceof Uint8Array)) throw new Error("Invalid deflate result");
      return { codec: "deflate", data };
    } catch (error) {
      // Incompressible input is a normal outcome; do not allocate an oversized
      // compressed result merely to discard it.
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ERR_BUFFER_TOO_LARGE"
      ) {
        throw error;
      }
    }
  }
  return { codec: "raw", data: bytes };
}

export function decompressFrame(
  codec: FrameCodec,
  bytes: Uint8Array,
  expectedLength: number,
): Uint8Array {
  checkLength(expectedLength, MAX_DELTA_SIZE);
  checkLength(bytes.byteLength, MAX_DELTA_SIZE);
  if (codec === "raw") {
    if (bytes.byteLength !== expectedLength) throw new Error("Raw frame length mismatch");
    return bytes;
  }
  if (codec !== "deflate") throw new Error("Unknown artifact frame codec");
  const result: unknown = inflateRawSync(bytes, {
    maxOutputLength: Math.max(1, expectedLength),
    info: true,
  });
  if (typeof result !== "object" || result === null) throw new Error("Invalid inflate result");
  const buffer: unknown = Reflect.get(result, "buffer");
  const engine: unknown = Reflect.get(result, "engine");
  if (!(buffer instanceof Uint8Array) || typeof engine !== "object" || engine === null) {
    throw new Error("Invalid inflate result");
  }
  if (buffer.byteLength !== expectedLength) throw new Error("Inflated frame length mismatch");
  if (Reflect.get(engine, "bytesWritten") !== bytes.byteLength)
    throw new Error("Trailing compressed data");
  return buffer;
}

function hashWindow(bytes: Uint8Array, offset: number): number {
  let hash = 0;
  for (let i = 0; i < WINDOW; i++) hash = (Math.imul(hash, 31) + bytes[offset + i]!) | 0;
  return hash;
}

function bucket(hash: number): number {
  return (hash ^ (hash >>> 16)) & (BUCKETS - 1);
}

/**
 * Index aligned 16-byte base blocks, then roll over every target position.
 * The index is at most 1.25 MiB (typed arrays), with four candidates per scan
 * position. Only the first matching window is extended, so extended bytes
 * are consumed rather than repeatedly rescanned by competing candidates.
 */
export function makeDelta(base: Uint8Array, target: Uint8Array): Uint8Array {
  checkLength(base.byteLength, FRAME_SIZE);
  checkLength(target.byteLength, FRAME_SIZE);
  const output = new Uint8Array(target.byteLength + 13);
  const view = new DataView(output.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, target.byteLength, true);
  let written = 8;
  let literalStart = 0;
  const literal = (end: number): void => {
    if (end === literalStart) return;
    output[written++] = 0;
    view.setUint32(written, end - literalStart, true);
    written += 4;
    output.set(target.subarray(literalStart, end), written);
    written += end - literalStart;
  };

  if (base.byteLength >= WINDOW && target.byteLength >= WINDOW) {
    const blocks = Math.floor(base.byteLength / WINDOW);
    const heads = new Int32Array(BUCKETS).fill(-1);
    const next = new Int32Array(blocks);
    // Earliest offsets win on repeated content, preserving long common runs.
    for (let block = blocks - 1; block >= 0; block--) {
      const slot = bucket(hashWindow(base, block * WINDOW));
      next[block] = heads[slot]!;
      heads[slot] = block;
    }
    let position = 0;
    let hash = hashWindow(target, position);
    while (position + WINDOW <= target.byteLength) {
      let match = -1;
      let candidate = heads[bucket(hash)]!;
      for (let attempt = 0; candidate !== -1 && attempt < CANDIDATES; attempt++) {
        const offset = candidate * WINDOW;
        let same = 0;
        while (same < WINDOW && base[offset + same] === target[position + same]) same++;
        if (same === WINDOW) {
          match = offset;
          break;
        }
        candidate = next[candidate]!;
      }
      if (match !== -1) {
        let length = WINDOW;
        const limit = Math.min(base.byteLength - match, target.byteLength - position);
        while (length < limit && base[match + length] === target[position + length]) length++;
        literal(position);
        output[written++] = 1;
        view.setUint32(written, match, true);
        view.setUint32(written + 4, length, true);
        written += 8;
        position += length;
        literalStart = position;
        if (position + WINDOW <= target.byteLength) hash = hashWindow(target, position);
      } else {
        if (position + WINDOW < target.byteLength) {
          hash =
            (Math.imul(hash - Math.imul(target[position]!, rollingPower), 31) +
              target[position + WINDOW]!) |
            0;
        }
        position++;
      }
    }
  }
  literal(target.byteLength);
  return output.subarray(0, written);
}

/** Decode one delta against plain base bytes, never another encoded delta. */
export function applyDelta(
  base: Uint8Array,
  delta: Uint8Array,
  expectedLength: number,
): Uint8Array {
  checkLength(base.byteLength, FRAME_SIZE);
  checkLength(expectedLength, FRAME_SIZE);
  checkLength(delta.byteLength, MAX_DELTA_SIZE);
  const view = new DataView(delta.buffer, delta.byteOffset, delta.byteLength);
  if (delta.byteLength < 8 || view.getUint32(0, true) !== MAGIC) {
    throw new Error("Invalid artifact delta header");
  }
  if (view.getUint32(4, true) !== expectedLength) throw new Error("Delta frame length mismatch");
  // Validate the entire instruction stream before allocating reconstructed bytes.
  const walk = (output?: Uint8Array): void => {
    let read = 8;
    let written = 0;
    let previous = -1;
    let copyEnd = -1;
    while (written < expectedLength) {
      if (read >= delta.byteLength) throw new Error("Truncated artifact delta");
      const operation = delta[read++]!;
      if (operation === 0) {
        if (previous === 0 || read + 4 > delta.byteLength) throw new Error("Invalid delta literal");
        const length = view.getUint32(read, true);
        read += 4;
        if (length === 0 || length > expectedLength - written || length > delta.byteLength - read) {
          throw new Error("Invalid delta literal length");
        }
        if (output) output.set(delta.subarray(read, read + length), written);
        read += length;
        written += length;
      } else if (operation === 1) {
        if (read + 8 > delta.byteLength) throw new Error("Truncated delta copy");
        const offset = view.getUint32(read, true);
        const length = view.getUint32(read + 4, true);
        read += 8;
        if (
          length < WINDOW ||
          length > expectedLength - written ||
          offset > base.byteLength ||
          length > base.byteLength - offset ||
          (previous === 1 && offset === copyEnd)
        ) {
          throw new Error("Invalid delta copy");
        }
        if (output) output.set(base.subarray(offset, offset + length), written);
        written += length;
        copyEnd = offset + length;
      } else {
        throw new Error("Unknown delta operation");
      }
      previous = operation;
    }
    if (read !== delta.byteLength) throw new Error("Trailing delta data");
  };
  walk();
  const output = new Uint8Array(expectedLength);
  walk(output);
  return output;
}
