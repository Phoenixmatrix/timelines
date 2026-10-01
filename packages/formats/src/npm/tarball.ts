import { Gunzip } from "fflate";

/**
 * Counts files and unpacked bytes of a streamed `.tgz` (the `dist.fileCount`
 * and `dist.unpackedSize` the npm registry reports) without keeping it: only
 * tar headers are inspected, file contents are skipped as they stream past.
 */
export class TarballStats {
  fileCount = 0;
  unpackedSize = 0;
  /** Why stats are unavailable: the input is not a gzip tarball, or is too big to walk. */
  error: "corrupt" | "too_large" | null = null;
  private readonly gunzip: Gunzip;
  private readonly header = new Uint8Array(512);
  private headerFilled = 0;
  private skip = 0;
  private ended = false;
  private inflated = 0;
  private finished = false;

  private readonly maxUnpackedBytes: number;

  constructor(maxUnpackedBytes = 1024 * 1024 * 1024) {
    this.maxUnpackedBytes = maxUnpackedBytes;
    this.gunzip = new Gunzip((chunk) => this.consume(chunk));
  }

  push(chunk: Uint8Array): void {
    if (this.error || this.finished) return;
    try {
      this.gunzip.push(chunk, false);
    } catch {
      this.error ??= "corrupt";
    }
  }

  finish(): void {
    if (this.error || this.finished) return;
    this.finished = true;
    try {
      this.gunzip.push(new Uint8Array(), true);
    } catch {
      this.error = "corrupt";
    }
    if (!this.error && this.fileCount === 0 && !this.ended) this.error = "corrupt";
  }

  result(): { fileCount: number; unpackedSize: number } | null {
    return this.error || !this.finished
      ? null
      : { fileCount: this.fileCount, unpackedSize: this.unpackedSize };
  }

  private consume(chunk: Uint8Array): void {
    if (this.error || this.ended) return;
    this.inflated += chunk.length;
    if (this.inflated > this.maxUnpackedBytes) {
      this.error = "too_large";
      return;
    }
    let at = 0;
    while (at < chunk.length && !this.ended) {
      if (this.skip > 0) {
        const take = Math.min(this.skip, chunk.length - at);
        this.skip -= take;
        at += take;
        continue;
      }
      const take = Math.min(512 - this.headerFilled, chunk.length - at);
      this.header.set(chunk.subarray(at, at + take), this.headerFilled);
      this.headerFilled += take;
      at += take;
      if (this.headerFilled === 512) {
        this.headerFilled = 0;
        this.onHeader();
      }
    }
  }

  private onHeader(): void {
    const h = this.header;
    if (h.every((b) => b === 0)) {
      this.ended = true;
      return;
    }
    if (!validChecksum(h)) {
      this.error = "corrupt";
      this.ended = true;
      return;
    }
    const size = octal(h, 124, 12);
    const type = h[156]!;
    // '0', NUL and '7' are regular files; pax/GNU meta entries are skipped.
    if (type === 0x30 || type === 0 || type === 0x37) {
      this.fileCount++;
      this.unpackedSize += size;
    }
    this.skip = Math.ceil(size / 512) * 512;
  }
}

function octal(bytes: Uint8Array, start: number, length: number): number {
  if (bytes[start]! & 0x80) {
    let value = 0;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + bytes[i]!;
    return value;
  }
  let text = "";
  for (let i = start; i < start + length; i++) {
    const b = bytes[i]!;
    if (b === 0) break;
    text += String.fromCharCode(b);
  }
  text = text.trim();
  return text ? Number.parseInt(text, 8) || 0 : 0;
}

function validChecksum(h: Uint8Array): boolean {
  const stored = octal(h, 148, 8);
  // Some old tar writers summed signed bytes.
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < 512; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : h[i]!;
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}
