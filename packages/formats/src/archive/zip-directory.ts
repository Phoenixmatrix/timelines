import { inflateSync } from "fflate";

/**
 * Random-access zip reading for archives too large to hold in memory (wheels,
 * Go module zips): the caller supplies `read(offset, length)` (an R2 range
 * request in the registry) and only the central directory plus the entries
 * actually needed are fetched. Supports zip64.
 */

export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

export interface ZipDirEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** True for names ending in `/`. */
  directory: boolean;
}

export class ZipFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipFormatError";
  }
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u64(dv: DataView, at: number): number {
  const value = dv.getBigUint64(at, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipFormatError("zip64 value too large");
  return Number(value);
}

export interface CentralDirectoryLocation {
  offset: number;
  size: number;
  entries: number;
}

/**
 * Finds the central directory from the archive's tail. `tail` holds the last
 * bytes of the archive (at least 22, ideally 22 + 65535 + 20) and starts at
 * `tailOffset`. Returns the zip64 end record's offset when one must be read.
 */
export function locateCentralDirectory(
  tail: Uint8Array,
  tailOffset: number,
): CentralDirectoryLocation | { zip64EndOffset: number } {
  const dv = view(tail);
  for (let at = tail.length - EOCD_MIN; at >= 0; at--) {
    if (dv.getUint32(at, true) !== EOCD_SIG) continue;
    const commentLength = dv.getUint16(at + 20, true);
    if (at + EOCD_MIN + commentLength !== tail.length) continue;
    const entries = dv.getUint16(at + 10, true);
    const size = dv.getUint32(at + 12, true);
    const offset = dv.getUint32(at + 16, true);
    if (entries === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      const locator = at - 20;
      if (locator < 0 || dv.getUint32(locator, true) !== ZIP64_LOCATOR_SIG) {
        throw new ZipFormatError("zip64 end locator missing");
      }
      return { zip64EndOffset: u64(dv, locator + 8) };
    }
    if (offset + size > tailOffset + at) throw new ZipFormatError("central directory out of range");
    return { offset, size, entries };
  }
  throw new ZipFormatError("not a zip archive (no end of central directory)");
}

/** Parses a zip64 end-of-central-directory record (56 bytes). */
export function parseZip64End(bytes: Uint8Array): CentralDirectoryLocation {
  const dv = view(bytes);
  if (bytes.length < 56 || dv.getUint32(0, true) !== ZIP64_EOCD_SIG) {
    throw new ZipFormatError("bad zip64 end record");
  }
  return { entries: u64(dv, 32), size: u64(dv, 40), offset: u64(dv, 48) };
}

const decoder = new TextDecoder();

/** Parses the central directory records. */
export function parseCentralDirectory(bytes: Uint8Array, expectedEntries?: number): ZipDirEntry[] {
  const dv = view(bytes);
  const entries: ZipDirEntry[] = [];
  let at = 0;
  while (at + 46 <= bytes.length) {
    if (dv.getUint32(at, true) !== CD_SIG) break;
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const crc32 = dv.getUint32(at + 16, true);
    let compressedSize = dv.getUint32(at + 20, true);
    let uncompressedSize = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true);
    const extraLength = dv.getUint16(at + 30, true);
    const commentLength = dv.getUint16(at + 32, true);
    let localHeaderOffset = dv.getUint32(at + 42, true);
    const end = at + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new ZipFormatError("truncated central directory");
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    // zip64 extended information: only the fields whose 32-bit value is saturated.
    let extra = at + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const id = dv.getUint16(extra, true);
      const size = dv.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        if (uncompressedSize === 0xffffffff) {
          uncompressedSize = u64(dv, field);
          field += 8;
        }
        if (compressedSize === 0xffffffff) {
          compressedSize = u64(dv, field);
          field += 8;
        }
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = u64(dv, field);
      }
      extra += 4 + size;
    }
    entries.push({
      name,
      method,
      flags,
      crc32,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      directory: name.endsWith("/"),
    });
    at = end;
  }
  if (expectedEntries !== undefined && entries.length !== expectedEntries) {
    throw new ZipFormatError(
      `central directory has ${entries.length} entries, expected ${expectedEntries}`,
    );
  }
  return entries;
}

export interface ZipDirectoryOptions {
  /** Refuse central directories larger than this (default 32 MiB). */
  maxDirectoryBytes?: number;
}

/** Reads an archive's central directory through `read`. */
export async function readZipDirectory(
  read: RangeReader,
  size: number,
  options: ZipDirectoryOptions = {},
): Promise<ZipDirEntry[]> {
  if (size < EOCD_MIN) throw new ZipFormatError("not a zip archive (too small)");
  const tailLength = Math.min(size, EOCD_MIN + MAX_COMMENT + 20);
  const tailOffset = size - tailLength;
  const tail = await read(tailOffset, tailLength);
  let location = locateCentralDirectory(tail, tailOffset);
  if ("zip64EndOffset" in location) {
    if (location.zip64EndOffset + 56 > size) throw new ZipFormatError("zip64 end out of range");
    location = parseZip64End(await read(location.zip64EndOffset, 56));
  }
  const max = options.maxDirectoryBytes ?? 32 * 1024 * 1024;
  if (location.size > max) throw new ZipFormatError("central directory too large");
  if (location.offset + location.size > size) {
    throw new ZipFormatError("central directory out of range");
  }
  const directory =
    location.size > 0 ? await read(location.offset, location.size) : new Uint8Array();
  return parseCentralDirectory(directory, location.entries);
}

/** Reads and decompresses one entry (stored or deflated) through `read`. */
export async function readZipEntry(
  read: RangeReader,
  entry: ZipDirEntry,
  options: { maxBytes?: number } = {},
): Promise<Uint8Array> {
  if (options.maxBytes !== undefined && entry.uncompressedSize > options.maxBytes) {
    throw new ZipFormatError(`${entry.name} is larger than ${options.maxBytes} bytes`);
  }
  if (entry.flags & 0x1) throw new ZipFormatError(`${entry.name} is encrypted`);
  const header = await read(entry.localHeaderOffset, 30);
  const dv = view(header);
  if (header.length < 30 || dv.getUint32(0, true) !== LOCAL_SIG) {
    throw new ZipFormatError(`bad local header for ${entry.name}`);
  }
  const dataOffset = entry.localHeaderOffset + 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
  const compressed =
    entry.compressedSize > 0 ? await read(dataOffset, entry.compressedSize) : new Uint8Array();
  if (compressed.length !== entry.compressedSize) {
    throw new ZipFormatError(`truncated data for ${entry.name}`);
  }
  let data: Uint8Array;
  if (entry.method === 0) data = compressed;
  else if (entry.method === 8) {
    try {
      data = inflateSync(compressed, { out: new Uint8Array(entry.uncompressedSize) });
    } catch {
      throw new ZipFormatError(`corrupt deflate data in ${entry.name}`);
    }
  } else throw new ZipFormatError(`unsupported compression method ${entry.method}`);
  if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc32) {
    throw new ZipFormatError(`checksum mismatch in ${entry.name}`);
  }
  return data;
}

let CRC_TABLE: Uint32Array | null = null;

export function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A RangeReader over an in-memory archive (tests, small files). */
export function bytesReader(bytes: Uint8Array): RangeReader {
  return async (offset, length) => bytes.subarray(offset, offset + length);
}
