import { gunzipSync, unzipSync, type Unzipped } from "fflate";

/**
 * Small archive readers shared by the formats: tar (ustar/pax/GNU long names),
 * gzip, zip and ar. Inputs are in-memory byte arrays: callers only use these on
 * bounded data (control tarballs, chart metadata, wheel METADATA), never on
 * whole multi-hundred-MB artifacts.
 */

export interface TarEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  mode: number;
  data: Uint8Array;
  linkname: string;
}

const decoder = new TextDecoder();

function cString(bytes: Uint8Array, start: number, length: number): string {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function octal(bytes: Uint8Array, start: number, length: number): number {
  const first = bytes[start]!;
  if (first & 0x80) {
    // GNU base-256 encoding for large sizes.
    let value = 0;
    for (let i = start + 1; i < start + length; i++) value = value * 256 + bytes[i]!;
    return value;
  }
  const text = cString(bytes, start, length).trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function parsePax(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  let at = 0;
  const text = decoder.decode(data);
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space === -1) break;
    const length = Number.parseInt(text.slice(at, space), 10);
    if (!Number.isFinite(length) || length <= 0) break;
    const record = text.slice(space + 1, at + length - 1);
    const eq = record.indexOf("=");
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    at += length;
  }
  return out;
}

/** Reads every entry of an uncompressed tar archive. */
export function readTar(bytes: Uint8Array, options: { maxEntries?: number } = {}): TarEntry[] {
  const entries: TarEntry[] = [];
  let at = 0;
  let longName: string | null = null;
  let longLink: string | null = null;
  let pax: Record<string, string> = {};
  const max = options.maxEntries ?? 100_000;
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156]!);
    const dataStart = at + 512;
    const data = bytes.subarray(dataStart, dataStart + size);
    at = dataStart + Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      longName = cString(data, 0, data.length);
      continue;
    }
    if (typeflag === "K") {
      longLink = cString(data, 0, data.length);
      continue;
    }
    if (typeflag === "x") {
      pax = parsePax(data);
      continue;
    }
    if (typeflag === "g") continue;

    const prefix = header[257] === 0x75 ? cString(header, 345, 155) : "";
    const baseName = cString(header, 0, 100);
    const name = pax.path ?? longName ?? (prefix ? `${prefix}/${baseName}` : baseName);
    const linkname = pax.linkpath ?? longLink ?? cString(header, 157, 100);
    longName = null;
    longLink = null;
    pax = {};
    const type =
      typeflag === "0" || typeflag === "\0" || typeflag === "7"
        ? "file"
        : typeflag === "5"
          ? "directory"
          : typeflag === "2"
            ? "symlink"
            : "other";
    entries.push({ name, type, size, mode: octal(header, 100, 8), data, linkname });
    if (entries.length >= max) break;
  }
  return entries;
}

/** Strips a leading `./` so `./control` and `control` compare equal. */
export function tarPath(name: string): string {
  return name.replace(/^\.\//, "").replace(/\/+$/, "");
}

export function findTarEntry(
  entries: TarEntry[],
  predicate: (path: string) => boolean,
): TarEntry | undefined {
  return entries.find((e) => e.type === "file" && predicate(tarPath(e.name)));
}

export function gunzip(bytes: Uint8Array): Uint8Array {
  return gunzipSync(bytes);
}

export function isGzip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Reads a `.tar.gz` / `.tgz`. */
export function readTarGz(bytes: Uint8Array, options?: { maxEntries?: number }): TarEntry[] {
  return readTar(isGzip(bytes) ? gunzip(bytes) : bytes, options);
}

/** Zip entries whose names pass `filter` (all by default). */
export function readZip(bytes: Uint8Array, filter?: (name: string) => boolean): Unzipped {
  return unzipSync(bytes, filter ? { filter: (file) => filter(file.name) } : undefined);
}

export interface ArMember {
  name: string;
  size: number;
  data: Uint8Array;
}

/** Reads a Unix `ar` archive (the container of a .deb). */
export function readAr(bytes: Uint8Array): ArMember[] {
  if (decoder.decode(bytes.subarray(0, 8)) !== "!<arch>\n") throw new Error("not an ar archive");
  const members: ArMember[] = [];
  let at = 8;
  while (at + 60 <= bytes.length) {
    const header = bytes.subarray(at, at + 60);
    const rawName = decoder.decode(header.subarray(0, 16)).trim();
    const size = Number.parseInt(decoder.decode(header.subarray(48, 58)).trim(), 10);
    if (!Number.isFinite(size)) throw new Error("corrupt ar header");
    const data = bytes.subarray(at + 60, at + 60 + size);
    members.push({ name: rawName.replace(/\/$/, ""), size, data });
    at += 60 + size + (size % 2);
  }
  return members;
}

/**
 * Builds a tar archive (used by tests and by formats that emit archives).
 * Deterministic: entries carry `mtime` (default 0), so identical input always
 * yields identical bytes.
 */
export function writeTar(
  files: { name: string; data: Uint8Array | string; mode?: number; mtime?: number }[],
): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  for (const file of files) {
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    const header = new Uint8Array(512);
    const put = (value: string, offset: number, length: number) =>
      header.set(encoder.encode(value).subarray(0, length), offset);
    if (encoder.encode(file.name).length > 100) throw new Error(`tar name too long: ${file.name}`);
    put(file.name, 0, 100);
    put(`${(file.mode ?? 0o644).toString(8).padStart(7, "0")}\0`, 100, 8);
    put("0000000\0", 108, 8);
    put("0000000\0", 116, 8);
    put(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
    put(
      `${Math.floor(file.mtime ?? 0)
        .toString(8)
        .padStart(11, "0")}\0`,
      136,
      12,
    );
    put("        ", 148, 8);
    header[156] = 0x30;
    put("ustar\0", 257, 6);
    put("00", 263, 2);
    let sum = 0;
    for (const b of header) sum += b;
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    blocks.push(header, data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) blocks.push(new Uint8Array(pad));
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

export { gzipSync, zipSync, strToU8, strFromU8 } from "fflate";
export * from "./zip-directory.ts";
