import { createHasher } from "../hash/index.ts";
import { deflate, TYPE_NUM, type ObjType } from "./object.ts";

/** Pack object header: type and size as a little-endian base-128 varint. */
function encodeHeader(typeNum: number, size: number): Uint8Array {
  const bytes: number[] = [];
  let c = (typeNum << 4) | (size & 15);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(c | 0x80);
    c = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(c);
  return new Uint8Array(bytes);
}

/**
 * Writes an undeltified version-2 pack. `header(count)` first, then exactly
 * `count` objects, then `finish()` for the SHA-1 trailer. Output is buffered
 * in chunks; call `take()` to drain it as you go.
 */
export class PackWriter {
  private readonly hasher = createHasher("sha1");
  private chunks: Uint8Array[] = [];
  private written = 0;
  private expected = -1;

  private emit(bytes: Uint8Array): void {
    this.hasher.update(bytes);
    this.chunks.push(bytes);
  }

  header(count: number): void {
    const h = new Uint8Array(12);
    h.set([0x50, 0x41, 0x43, 0x4b], 0); // "PACK"
    const dv = new DataView(h.buffer);
    dv.setUint32(4, 2);
    dv.setUint32(8, count);
    this.expected = count;
    this.emit(h);
  }

  /** Adds an object from its raw content. */
  add(type: ObjType, data: Uint8Array): void {
    this.addDeflated(type, data.length, deflate(data));
  }

  /** Adds an object whose content is already zlib-deflated (as stored). */
  addDeflated(type: ObjType, size: number, zdata: Uint8Array): void {
    if (this.expected < 0) throw new Error("pack header not written");
    this.emit(encodeHeader(TYPE_NUM[type], size));
    this.emit(zdata);
    this.written++;
  }

  take(): Uint8Array[] {
    const out = this.chunks;
    this.chunks = [];
    return out;
  }

  finish(): Uint8Array[] {
    if (this.written !== this.expected) {
      throw new Error(`pack header says ${this.expected} objects, wrote ${this.written}`);
    }
    this.chunks.push(this.hasher.digest());
    return this.take();
  }
}
