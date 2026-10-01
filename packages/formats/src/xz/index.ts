/**
 * A small, dependency-free `.xz` (LZMA2) decoder for the in-memory members a
 * format needs to peek into (a .deb's `control.tar.xz` is a few KB). It
 * handles concatenated streams, multiple blocks, every LZMA2 chunk type and
 * the CRC32 check; CRC64 and SHA-256 block checks are skipped (the payload is
 * covered by the upload's own digests). Only the LZMA2 filter is supported,
 * which is what dpkg-deb, rpm and tar produce. Ported from the logic of
 * xz-embedded and the LZMA SDK's reference decoder.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const MAGIC = [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00];
const CHECK_SIZES: Record<number, number> = { 0: 0, 1: 4, 4: 8, 10: 32 };
const FILTER_LZMA2 = 0x21;

export function isXz(bytes: Uint8Array): boolean {
  return MAGIC.every((b, i) => bytes[i] === b);
}

class XzError extends Error {
  constructor(message: string) {
    super(`xz: ${message}`);
    this.name = "XzError";
  }
}

function u32le(bytes: Uint8Array, at: number): number {
  return (
    (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
  );
}

/** Growable output buffer that doubles as the LZMA dictionary. */
class Output {
  buf: Uint8Array;
  pos = 0;
  private readonly max: number;
  constructor(initial: number, max: number) {
    this.max = max;
    this.buf = new Uint8Array(Math.max(1024, initial));
  }
  ensure(extra: number): void {
    const need = this.pos + extra;
    if (need <= this.buf.length) return;
    if (need > this.max) throw new XzError(`output exceeds ${this.max} bytes`);
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(Math.min(size, this.max));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }
}

class RangeDecoder {
  range = 0;
  code = 0;
  pos = 0;
  end = 0;
  private readonly input: Uint8Array;
  constructor(input: Uint8Array) {
    this.input = input;
  }

  init(start: number, end: number): void {
    if (end - start < 5 || this.input[start] !== 0) throw new XzError("corrupt range coder init");
    this.range = 0xffffffff;
    this.code = u32be(this.input, start + 1);
    this.pos = start + 5;
    this.end = end;
  }

  private next(): number {
    if (this.pos >= this.end) throw new XzError("truncated LZMA chunk");
    return this.input[this.pos++]!;
  }

  private normalize(): void {
    if (this.range < 0x1000000) {
      this.range = (this.range << 8) >>> 0;
      this.code = ((this.code << 8) | this.next()) >>> 0;
    }
  }

  bit(probs: Uint16Array, i: number): number {
    const prob = probs[i]!;
    const bound = (this.range >>> 11) * prob;
    let bit: number;
    if (this.code < bound) {
      this.range = bound;
      probs[i] = prob + ((2048 - prob) >>> 5);
      bit = 0;
    } else {
      this.range = (this.range - bound) >>> 0;
      this.code = (this.code - bound) >>> 0;
      probs[i] = prob - (prob >>> 5);
      bit = 1;
    }
    this.normalize();
    return bit;
  }

  tree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    for (let i = 0; i < numBits; i++) m = (m << 1) + this.bit(probs, base + m);
    return m - (1 << numBits);
  }

  reverseTree(probs: Uint16Array, base: number, numBits: number): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < numBits; i++) {
      const bit = this.bit(probs, base + m);
      m = (m << 1) + bit;
      symbol |= bit << i;
    }
    return symbol;
  }

  direct(numBits: number): number {
    let result = 0;
    for (let i = 0; i < numBits; i++) {
      this.range >>>= 1;
      let bit = 0;
      if (this.code >= this.range) {
        this.code = (this.code - this.range) >>> 0;
        bit = 1;
      }
      result = result * 2 + bit;
      this.normalize();
    }
    return result;
  }
}

function u32be(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

// Probability array layout (one Uint16Array, offsets below).
const STATES = 12;
const POS_STATES_MAX = 16;
const IS_MATCH = 0;
const IS_REP = IS_MATCH + STATES * POS_STATES_MAX;
const IS_REP_G0 = IS_REP + STATES;
const IS_REP_G1 = IS_REP_G0 + STATES;
const IS_REP_G2 = IS_REP_G1 + STATES;
const IS_REP0_LONG = IS_REP_G2 + STATES;
const POS_SLOT = IS_REP0_LONG + STATES * POS_STATES_MAX;
const SPEC_POS = POS_SLOT + 4 * 64;
const ALIGN = SPEC_POS + 115;
const LEN_CODER = ALIGN + 16;
// choice, choice2, low[16][8], mid[16][8], high[256]
const LEN_SIZE = 2 + POS_STATES_MAX * 8 * 2 + 256;
const REP_LEN_CODER = LEN_CODER + LEN_SIZE;
const LITERAL = REP_LEN_CODER + LEN_SIZE;
const PROBS_SIZE = LITERAL + 0x300 * 16;

class Lzma2Decoder {
  private readonly probs = new Uint16Array(PROBS_SIZE);
  private readonly rc: RangeDecoder;
  private lc = 0;
  private lp = 0;
  private pb = 0;
  private state = 0;
  private rep0 = 0;
  private rep1 = 0;
  private rep2 = 0;
  private rep3 = 0;
  /** Output position where the dictionary was last reset. */
  private dictStart = 0;
  private pendingLen = 0;
  private needDictReset = true;
  private needProps = true;

  private readonly input: Uint8Array;
  private readonly out: Output;
  constructor(input: Uint8Array, out: Output) {
    this.input = input;
    this.out = out;
    this.rc = new RangeDecoder(input);
  }

  private resetState(): void {
    this.probs.fill(1024);
    this.state = 0;
    this.rep0 = this.rep1 = this.rep2 = this.rep3 = 0;
    this.pendingLen = 0;
  }

  private setProps(byte: number): void {
    if (byte > 224) throw new XzError("invalid LZMA properties");
    this.lc = byte % 9;
    const rest = Math.floor(byte / 9);
    this.lp = rest % 5;
    this.pb = Math.floor(rest / 5);
    if (this.lc + this.lp > 4) throw new XzError("invalid LZMA2 lc/lp");
  }

  /** Decodes LZMA2 chunks starting at `at`; returns the offset after the end marker. */
  decode(at: number, end: number): number {
    const input = this.input;
    for (;;) {
      if (at >= end) throw new XzError("truncated LZMA2 data");
      const control = input[at++]!;
      if (control === 0x00) return at;
      if (control === 0x01 || control === 0x02) {
        if (control === 0x01) {
          this.dictStart = this.out.pos;
          this.needDictReset = false;
        } else if (this.needDictReset) throw new XzError("missing dictionary reset");
        const size = ((input[at]! << 8) | input[at + 1]!) + 1;
        at += 2;
        if (at + size > end) throw new XzError("truncated uncompressed chunk");
        this.out.ensure(size);
        this.out.buf.set(input.subarray(at, at + size), this.out.pos);
        this.out.pos += size;
        at += size;
        continue;
      }
      if (control < 0x80) throw new XzError(`invalid LZMA2 control byte ${control}`);
      const unpacked = ((control & 0x1f) << 16) + ((input[at]! << 8) | input[at + 1]!) + 1;
      const packed = ((input[at + 2]! << 8) | input[at + 3]!) + 1;
      at += 4;
      const reset = (control >>> 5) & 3;
      if (reset === 3) {
        this.dictStart = this.out.pos;
        this.needDictReset = false;
      } else if (this.needDictReset) throw new XzError("missing dictionary reset");
      if (reset >= 2) {
        this.setProps(input[at++]!);
        this.needProps = false;
      } else if (this.needProps) throw new XzError("missing LZMA properties");
      if (reset >= 1) this.resetState();
      if (at + packed > end) throw new XzError("truncated LZMA chunk");
      this.rc.init(at, at + packed);
      this.out.ensure(unpacked);
      this.decodeChunk(this.out.pos + unpacked);
      at += packed;
    }
  }

  private copyMatch(len: number, limit: number): void {
    const out = this.out;
    const buf = out.buf;
    const n = Math.min(len, limit - out.pos);
    let src = out.pos - this.rep0 - 1;
    for (let i = 0; i < n; i++) buf[out.pos++] = buf[src++]!;
    this.pendingLen = len - n;
  }

  private decodeLen(base: number, posState: number): number {
    const rc = this.rc;
    const probs = this.probs;
    if (rc.bit(probs, base) === 0) return rc.tree(probs, base + 2 + posState * 8, 3);
    if (rc.bit(probs, base + 1) === 0)
      return 8 + rc.tree(probs, base + 2 + POS_STATES_MAX * 8 + posState * 8, 3);
    return 16 + rc.tree(probs, base + 2 + POS_STATES_MAX * 16, 8);
  }

  private decodeChunk(limit: number): void {
    const rc = this.rc;
    const probs = this.probs;
    const out = this.out;
    const pbMask = (1 << this.pb) - 1;
    const lpMask = (1 << this.lp) - 1;
    const lc = this.lc;
    if (this.pendingLen > 0) this.copyMatch(this.pendingLen, limit);

    while (out.pos < limit) {
      const buf = out.buf;
      const pos = out.pos - this.dictStart;
      const posState = pos & pbMask;
      const state = this.state;
      if (rc.bit(probs, IS_MATCH + (state << 4) + posState) === 0) {
        const prev = pos > 0 ? buf[out.pos - 1]! : 0;
        const base = LITERAL + 0x300 * (((pos & lpMask) << lc) + (prev >>> (8 - lc)));
        let symbol = 1;
        if (state >= 7) {
          if (this.rep0 >= pos) throw new XzError("match distance beyond dictionary");
          let matchByte = buf[out.pos - this.rep0 - 1]!;
          while (symbol < 0x100) {
            const matchBit = (matchByte >>> 7) & 1;
            matchByte <<= 1;
            const bit = rc.bit(probs, base + ((1 + matchBit) << 8) + symbol);
            symbol = (symbol << 1) | bit;
            if (matchBit !== bit) break;
          }
        }
        while (symbol < 0x100) symbol = (symbol << 1) | rc.bit(probs, base + symbol);
        buf[out.pos++] = symbol & 0xff;
        this.state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6;
        continue;
      }

      let len: number;
      if (rc.bit(probs, IS_REP + state) === 0) {
        this.rep3 = this.rep2;
        this.rep2 = this.rep1;
        this.rep1 = this.rep0;
        len = this.decodeLen(LEN_CODER, posState);
        this.state = state < 7 ? 7 : 10;
        this.rep0 = this.decodeDistance(len);
        if (this.rep0 === 0xffffffff) throw new XzError("unexpected end marker in LZMA2");
      } else {
        if (pos === 0) throw new XzError("rep match at dictionary start");
        if (rc.bit(probs, IS_REP_G0 + state) === 0) {
          if (rc.bit(probs, IS_REP0_LONG + (state << 4) + posState) === 0) {
            this.state = state < 7 ? 9 : 11;
            buf[out.pos] = buf[out.pos - this.rep0 - 1]!;
            out.pos++;
            continue;
          }
        } else {
          let dist: number;
          if (rc.bit(probs, IS_REP_G1 + state) === 0) {
            dist = this.rep1;
          } else {
            if (rc.bit(probs, IS_REP_G2 + state) === 0) {
              dist = this.rep2;
            } else {
              dist = this.rep3;
              this.rep3 = this.rep2;
            }
            this.rep2 = this.rep1;
          }
          this.rep1 = this.rep0;
          this.rep0 = dist;
        }
        len = this.decodeLen(REP_LEN_CODER, posState);
        this.state = state < 7 ? 8 : 11;
      }
      if (this.rep0 >= pos) throw new XzError("match distance beyond dictionary");
      this.copyMatch(len + 2, limit);
    }
  }

  private decodeDistance(len: number): number {
    const rc = this.rc;
    const lenState = len < 3 ? len : 3;
    const slot = rc.tree(this.probs, POS_SLOT + lenState * 64, 6);
    if (slot < 4) return slot;
    const directBits = (slot >>> 1) - 1;
    let dist = (2 | (slot & 1)) * 2 ** directBits;
    if (slot < 14) {
      dist += rc.reverseTree(this.probs, SPEC_POS + dist - slot - 1, directBits);
    } else {
      dist += rc.direct(directBits - 4) * 16;
      dist += rc.reverseTree(this.probs, ALIGN - 1, 4);
    }
    return dist >>> 0;
  }
}

function readVarint(bytes: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  let shift = 1;
  for (let i = 0; i < 9; i++) {
    if (at >= bytes.length) throw new XzError("truncated varint");
    const byte = bytes[at++]!;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) {
      if (byte === 0 && i > 0) throw new XzError("non-minimal varint");
      return [value, at];
    }
    shift *= 128;
  }
  throw new XzError("varint too long");
}

export interface XzOptions {
  /** Refuse to produce more than this many bytes (default 256 MiB). */
  maxOutput?: number;
}

/** Decompresses a complete `.xz` file (one or more concatenated streams). */
export function xzDecompress(input: Uint8Array, options: XzOptions = {}): Uint8Array {
  const out = new Output(input.length * 4, options.maxOutput ?? 256 * 1024 * 1024);
  let at = 0;
  let streams = 0;
  while (at < input.length) {
    // Stream padding: zero bytes in multiples of four between streams.
    if (streams > 0 && input[at] === 0) {
      at++;
      continue;
    }
    at = decodeStream(input, at, out);
    streams++;
  }
  if (streams === 0) throw new XzError("empty input");
  return out.result();
}

function decodeStream(input: Uint8Array, start: number, out: Output): number {
  if (input.length - start < 24 || !MAGIC.every((b, i) => input[start + i] === b)) {
    throw new XzError("not an xz stream");
  }
  if (crc32(input, start + 6, start + 8) !== u32le(input, start + 8)) {
    throw new XzError("stream header CRC mismatch");
  }
  if (input[start + 6] !== 0) throw new XzError("unsupported stream flags");
  const checkType = input[start + 7]! & 0x0f;
  const checkSize = CHECK_SIZES[checkType];
  if (checkSize === undefined) throw new XzError(`unsupported check type ${checkType}`);
  let at = start + 12;
  let blocks = 0;

  for (;;) {
    if (at >= input.length) throw new XzError("truncated stream");
    const sizeByte = input[at]!;
    if (sizeByte === 0) break; // index indicator
    const headerSize = (sizeByte + 1) * 4;
    const headerEnd = at + headerSize;
    if (headerEnd > input.length) throw new XzError("truncated block header");
    if (crc32(input, at, headerEnd - 4) !== u32le(input, headerEnd - 4)) {
      throw new XzError("block header CRC mismatch");
    }
    const flags = input[at + 1]!;
    if (flags & 0x3c) throw new XzError("unsupported block flags");
    const filters = (flags & 3) + 1;
    let p = at + 2;
    let compressedSize = -1;
    if (flags & 0x40) [compressedSize, p] = readVarint(input, p);
    if (flags & 0x80) [, p] = readVarint(input, p);
    let sawLzma2 = false;
    for (let i = 0; i < filters; i++) {
      let id: number;
      let propSize: number;
      [id, p] = readVarint(input, p);
      [propSize, p] = readVarint(input, p);
      if (id !== FILTER_LZMA2 || i !== filters - 1 || propSize !== 1) {
        throw new XzError(`unsupported filter 0x${id.toString(16)}`);
      }
      if (input[p]! > 40) throw new XzError("invalid LZMA2 dictionary size");
      p += propSize;
      sawLzma2 = true;
    }
    if (!sawLzma2) throw new XzError("block has no LZMA2 filter");

    const dataStart = headerEnd;
    const blockOutStart = out.pos;
    const decoder = new Lzma2Decoder(input, out);
    const dataEnd = decoder.decode(dataStart, input.length);
    if (compressedSize >= 0 && dataEnd - dataStart !== compressedSize) {
      throw new XzError("compressed size mismatch");
    }
    at = dataEnd;
    while ((at - start) % 4 !== 0) {
      if (input[at++] !== 0) throw new XzError("non-zero block padding");
    }
    if (checkType === 1 && crc32(out.buf, blockOutStart, out.pos) !== u32le(input, at)) {
      throw new XzError("CRC32 check failed");
    }
    at += checkSize;
    blocks++;
  }

  // Index: indicator, record count, records, padding, CRC32.
  const indexStart = at;
  let p = at + 1;
  let records: number;
  [records, p] = readVarint(input, p);
  if (records !== blocks) throw new XzError("index record count mismatch");
  for (let i = 0; i < records; i++) {
    [, p] = readVarint(input, p);
    [, p] = readVarint(input, p);
  }
  while ((p - indexStart) % 4 !== 0) {
    if (input[p++] !== 0) throw new XzError("non-zero index padding");
  }
  if (crc32(input, indexStart, p) !== u32le(input, p)) throw new XzError("index CRC mismatch");
  p += 4;
  // Stream footer: CRC32, backward size, flags, "YZ".
  if (p + 12 > input.length || input[p + 10] !== 0x59 || input[p + 11] !== 0x5a) {
    throw new XzError("missing stream footer");
  }
  return p + 12;
}
