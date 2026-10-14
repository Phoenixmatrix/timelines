/**
 * Incremental SHA-1 / SHA-256 whose state can be exported and resumed later.
 * WebCrypto and node:crypto hashes are one-shot or cannot be serialized; an OCI
 * blob upload spans many HTTP requests (chunked PATCHes), so its running digest
 * has to survive in a Durable Object between them.
 */
export type HashAlgo = "sha1" | "sha256";

export interface HasherState {
  algo: HashAlgo;
  h: number[];
  block: string;
  totalLen: number;
}

export interface Hasher {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
  exportState(): HasherState;
}

export function createHasher(algo: HashAlgo): Hasher {
  return algo === "sha1" ? new Sha1() : new Sha256();
}

export function resumeHasher(state: HasherState): Hasher {
  const hasher = createHasher(state.algo) as BlockHasher;
  hasher.importState(state);
  return hasher;
}

abstract class BlockHasher implements Hasher {
  protected block = new Uint8Array(64);
  protected blockLen = 0;
  protected totalLen = 0;
  protected finished = false;
  protected abstract h: Int32Array;
  protected abstract readonly algo: HashAlgo;

  update(data: Uint8Array): void {
    if (this.finished) throw new Error("hasher already finalized");
    let i = 0;
    this.totalLen += data.length;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen === 64) {
        this.compress(this.block, 0);
        this.blockLen = 0;
      }
    }
    while (i + 64 <= data.length) {
      this.compress(data, i);
      i += 64;
    }
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.blockLen = data.length - i;
    }
  }

  digest(): Uint8Array {
    if (this.finished) throw new Error("hasher already finalized");
    this.finished = true;
    const bits = this.totalLen * 8;
    this.block[this.blockLen++] = 0x80;
    if (this.blockLen > 56) {
      this.block.fill(0, this.blockLen);
      this.compress(this.block, 0);
      this.blockLen = 0;
    }
    this.block.fill(0, this.blockLen);
    const dv = new DataView(this.block.buffer);
    dv.setUint32(56, Math.floor(bits / 0x100000000));
    dv.setUint32(60, bits >>> 0);
    this.compress(this.block, 0);
    const out = new Uint8Array(this.h.length * 4);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < this.h.length; i++) odv.setInt32(i * 4, this.h[i]!);
    return out;
  }

  exportState(): HasherState {
    if (this.finished) throw new Error("hasher already finalized");
    return {
      algo: this.algo,
      h: Array.from(this.h),
      block: toHex(this.block.subarray(0, this.blockLen)),
      totalLen: this.totalLen,
    };
  }

  importState(state: HasherState): void {
    if (state.algo !== this.algo) throw new Error("hasher state algorithm mismatch");
    this.h = new Int32Array(state.h);
    const block = fromHex(state.block);
    this.block = new Uint8Array(64);
    this.block.set(block);
    this.blockLen = block.length;
    this.totalLen = state.totalLen;
  }

  protected abstract compress(buf: Uint8Array, off: number): void;
}

function word(buf: Uint8Array, at: number): number {
  return (buf[at]! << 24) | (buf[at + 1]! << 16) | (buf[at + 2]! << 8) | buf[at + 3]!;
}

class Sha1 extends BlockHasher {
  protected readonly algo = "sha1" as const;
  protected h = new Int32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  private readonly w = new Int32Array(80);

  protected compress(buf: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = word(buf, off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!;
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = this.h[0]!;
    let b = this.h[1]!;
    let c = this.h[2]!;
    let d = this.h[3]!;
    let e = this.h[4]!;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]!) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    const h = this.h;
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d) | 0;
    h[4] = (h[4]! + e) | 0;
  }
}

const K256 = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

class Sha256 extends BlockHasher {
  protected readonly algo = "sha256" as const;
  protected h = new Int32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  private readonly w = new Int32Array(64);

  protected compress(buf: Uint8Array, off: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) w[i] = word(buf, off + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let a = this.h[0]!;
    let b = this.h[1]!;
    let c = this.h[2]!;
    let d = this.h[3]!;
    let e = this.h[4]!;
    let f = this.h[5]!;
    let g = this.h[6]!;
    let h = this.h[7]!;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i]! + w[i]!) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    const hh = this.h;
    hh[0] = (hh[0]! + a) | 0;
    hh[1] = (hh[1]! + b) | 0;
    hh[2] = (hh[2]! + c) | 0;
    hh[3] = (hh[3]! + d) | 0;
    hh[4] = (hh[4]! + e) | 0;
    hh[5] = (hh[5]! + f) | 0;
    hh[6] = (hh[6]! + g) | 0;
    hh[7] = (hh[7]! + h) | 0;
  }
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

type DigestName = "SHA-1" | "SHA-256" | "SHA-512";

export async function digestHex(name: DigestName, data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return toHex(new Uint8Array(await crypto.subtle.digest(name, bytes as BufferSource)));
}

/** `sha256:<64 hex>` as used by OCI and the blob catalog. */
export function isSha256Digest(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}
