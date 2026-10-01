import { decompress as zstdDecompress } from "fzstd";

import { gunzip, readAr, readTar, tarPath } from "../archive/index.ts";
import { isXz, xzDecompress } from "../xz/index.ts";

/**
 * Debian repository logic: .deb control extraction, deb822 stanzas, dpkg
 * version ordering, and the Packages / Release writers apt reads.
 */

// ---------------------------------------------------------------------------
// deb822

/** One paragraph, fields in their original order and case. */
export type Stanza = [name: string, value: string][];

const FIELD_NAME = /^[!-9;-~][!-9;-~]*$/;

/**
 * Parses deb822 paragraphs. A multi-line value keeps its continuation lines
 * verbatim (leading space included), so writing it back is lossless.
 */
export function parseDeb822(text: string): Stanza[] {
  const stanzas: Stanza[] = [];
  let current: Stanza = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.trim() === "") {
      if (current.length) stanzas.push(current);
      current = [];
      continue;
    }
    if (raw.startsWith("#")) continue;
    if (raw.startsWith(" ") || raw.startsWith("\t")) {
      const last = current.at(-1);
      if (!last) throw new Error("continuation line without a field");
      last[1] += `\n${raw.trimEnd()}`;
      continue;
    }
    const colon = raw.indexOf(":");
    if (colon <= 0) throw new Error(`malformed control line: ${raw.slice(0, 60)}`);
    const name = raw.slice(0, colon);
    if (!FIELD_NAME.test(name)) throw new Error(`invalid field name: ${name.slice(0, 60)}`);
    current.push([name, raw.slice(colon + 1).trim()]);
  }
  if (current.length) stanzas.push(current);
  return stanzas;
}

export function field(stanza: Stanza, name: string): string | undefined {
  const lower = name.toLowerCase();
  return stanza.find(([n]) => n.toLowerCase() === lower)?.[1];
}

export function formatStanza(stanza: Stanza): string {
  return stanza
    .map(([name, value]) => (value.startsWith("\n") ? `${name}:${value}` : `${name}: ${value}`))
    .join("\n")
    .concat("\n");
}

// ---------------------------------------------------------------------------
// .deb files

export interface ArLocation {
  name: string;
  offset: number;
  size: number;
}

const AR_MAGIC = "!<arch>\n";
const decoder = new TextDecoder();

/**
 * Finds the control member of a .deb from its first bytes, so a caller can
 * range-read just that member. Returns null when `prefix` is too short to see
 * the member's header (read more and retry).
 */
export function locateControlMember(prefix: Uint8Array): ArLocation | null {
  if (prefix.length < 8) return null;
  if (decoder.decode(prefix.subarray(0, 8)) !== AR_MAGIC) throw new Error("not a .deb (ar) file");
  let at = 8;
  let index = 0;
  while (at + 60 <= prefix.length) {
    const header = prefix.subarray(at, at + 60);
    const name = decoder.decode(header.subarray(0, 16)).trim().replace(/\/$/, "");
    const size = Number.parseInt(decoder.decode(header.subarray(48, 58)).trim(), 10);
    if (!Number.isFinite(size) || size < 0) throw new Error("corrupt ar header");
    if (index === 0 && name !== "debian-binary") throw new Error("not a .deb: no debian-binary");
    if (name.startsWith("control.tar")) return { name, offset: at + 60, size };
    if (name.startsWith("data.tar")) throw new Error("not a .deb: data before control");
    at += 60 + size + (size % 2);
    index++;
    if (index > 8) break;
  }
  if (at + 60 > prefix.length) return null;
  throw new Error("not a .deb: no control member");
}

/** Decompresses a `control.tar[.gz|.xz|.zst]` member and returns `./control`. */
export function controlFromMember(name: string, data: Uint8Array): string {
  let tar: Uint8Array;
  if (name === "control.tar") tar = data;
  else if (name === "control.tar.gz") tar = gunzip(data);
  else if (name === "control.tar.xz") {
    if (!isXz(data)) throw new Error("control.tar.xz is not xz data");
    tar = xzDecompress(data, { maxOutput: 64 * 1024 * 1024 });
  } else if (name === "control.tar.zst") tar = zstdDecompress(data);
  else throw new Error(`unsupported control member compression: ${name}`);
  const entry = readTar(tar).find((e) => e.type === "file" && tarPath(e.name) === "control");
  if (!entry) throw new Error("control.tar has no ./control");
  return decoder.decode(entry.data);
}

/** The control paragraph of a whole in-memory .deb (tests, small files). */
export function readDebControl(deb: Uint8Array): string {
  const member = readAr(deb).find((m) => m.name.startsWith("control.tar"));
  if (!member) throw new Error("not a .deb: no control member");
  return controlFromMember(member.name, member.data);
}

// ---------------------------------------------------------------------------
// Names and versions

export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]+$/;
export const VERSION = /^(?:\d+:)?[0-9][A-Za-z0-9.+~:-]*$/;
export const ARCHITECTURE = /^[a-z0-9][a-z0-9-]*$/;
/** Distribution and component names (matches the repository config schema). */
export const DIST_NAME = /^[a-z0-9][a-z0-9._-]*$/;

export interface DebIdentity {
  package: string;
  version: string;
  architecture: string;
  /** Source package name (defaults to the binary package). */
  source: string;
}

/** Validates and extracts the identity fields of a binary control paragraph. */
export function debIdentity(stanza: Stanza): DebIdentity {
  const pkg = field(stanza, "Package");
  const version = field(stanza, "Version");
  const architecture = field(stanza, "Architecture");
  if (!pkg || !PACKAGE_NAME.test(pkg)) throw new Error(`invalid Package: ${pkg ?? "(missing)"}`);
  if (!version || !VERSION.test(version) || version.length > 200) {
    throw new Error(`invalid Version: ${version ?? "(missing)"}`);
  }
  if (!architecture || !ARCHITECTURE.test(architecture)) {
    throw new Error(`invalid Architecture: ${architecture ?? "(missing)"}`);
  }
  const sourceField = field(stanza, "Source")?.split(/\s+/)[0];
  const source = sourceField && PACKAGE_NAME.test(sourceField) ? sourceField : pkg;
  return { package: pkg, version, architecture, source };
}

/** `hello_2.10-3_amd64.deb` (the epoch is never part of a file name). */
export function debFilename(id: Pick<DebIdentity, "package" | "version" | "architecture">): string {
  return `${id.package}_${id.version.replace(/^\d+:/, "")}_${id.architecture}.deb`;
}

/** `pool/main/h/hello/<file>`, or `pool/main/libf/libfoo/<file>` for lib*. */
export function poolPath(component: string, source: string, filename: string): string {
  const prefix = source.startsWith("lib") && source.length > 3 ? source.slice(0, 4) : source[0]!;
  return `pool/${component}/${prefix}/${source}/${filename}`;
}

function order(c: string | undefined): number {
  if (c === undefined) return 0;
  if (c >= "0" && c <= "9") return 0;
  if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) return c.charCodeAt(0);
  if (c === "~") return -1;
  return c.charCodeAt(0) + 256;
}

const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

function verrevcmp(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    let firstDiff = 0;
    while ((i < a.length && !isDigit(a[i])) || (j < b.length && !isDigit(b[j]))) {
      const ac = order(a[i]);
      const bc = order(b[j]);
      if (ac !== bc) return ac - bc;
      i++;
      j++;
    }
    while (a[i] === "0") i++;
    while (b[j] === "0") j++;
    while (isDigit(a[i]) && isDigit(b[j])) {
      if (!firstDiff) firstDiff = a.charCodeAt(i) - b.charCodeAt(j);
      i++;
      j++;
    }
    if (isDigit(a[i])) return 1;
    if (isDigit(b[j])) return -1;
    if (firstDiff) return firstDiff;
  }
  return 0;
}

function splitVersion(v: string): [epoch: number, upstream: string, revision: string] {
  const colon = v.indexOf(":");
  const epoch = colon === -1 ? 0 : Number.parseInt(v.slice(0, colon), 10) || 0;
  const rest = colon === -1 ? v : v.slice(colon + 1);
  const dash = rest.lastIndexOf("-");
  return dash === -1 ? [epoch, rest, ""] : [epoch, rest.slice(0, dash), rest.slice(dash + 1)];
}

/** dpkg's version ordering: negative if a < b, 0 if equal, positive if a > b. */
export function compareVersions(a: string, b: string): number {
  const [ea, ua, ra] = splitVersion(a);
  const [eb, ub, rb] = splitVersion(b);
  if (ea !== eb) return ea - eb;
  return Math.sign(verrevcmp(ua, ub) || verrevcmp(ra, rb));
}

// ---------------------------------------------------------------------------
// Index writers

export interface DebFileInfo {
  filename: string;
  size: number;
  md5: string;
  sha1: string;
  sha256: string;
  sha512?: string;
}

/** A Packages entry: the control paragraph plus where and what the file is. */
export function packagesStanza(control: Stanza, file: DebFileInfo): string {
  const fileFields: Stanza = [
    ["Filename", file.filename],
    ["Size", String(file.size)],
    ["MD5sum", file.md5],
    ["SHA1", file.sha1],
    ["SHA256", file.sha256],
    ...(file.sha512 ? [["SHA512", file.sha512] as [string, string]] : []),
  ];
  const skip = new Set(["filename", "size", "md5sum", "sha1", "sha256", "sha512", "status"]);
  const kept = control.filter(([name]) => !skip.has(name.toLowerCase()));
  const description = kept.findIndex(([name]) => name.toLowerCase() === "description");
  const out =
    description === -1
      ? [...kept, ...fileFields]
      : [...kept.slice(0, description), ...fileFields, ...kept.slice(description)];
  return formatStanza(out);
}

/** Sort key order for Packages: name, then dpkg version, then architecture. */
export function comparePackages(
  a: { package: string; version: string; architecture: string },
  b: { package: string; version: string; architecture: string },
): number {
  if (a.package !== b.package) return a.package < b.package ? -1 : 1;
  const v = compareVersions(a.version, b.version);
  if (v) return v;
  return a.architecture < b.architecture ? -1 : a.architecture > b.architecture ? 1 : 0;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 2822 date in UTC, the way dak writes it: `Sat, 20 Sep 2026 10:00:00 UTC`. */
export function rfc2822(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`;
}

export interface ReleaseIndexFile {
  /** Relative to `dists/<dist>/`. */
  path: string;
  size: number;
  md5: string;
  sha1: string;
  sha256: string;
}

export interface ReleaseInput {
  origin?: string;
  label?: string;
  suite: string;
  codename: string;
  date: Date;
  validUntil?: Date;
  architectures: string[];
  components: string[];
  description?: string;
  acquireByHash?: boolean;
  files: ReleaseIndexFile[];
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/** The top-level `dists/<dist>/Release` document. */
export function releaseFile(input: ReleaseInput): string {
  const lines: string[] = [];
  if (input.origin) lines.push(`Origin: ${oneLine(input.origin)}`);
  if (input.label) lines.push(`Label: ${oneLine(input.label)}`);
  lines.push(`Suite: ${input.suite}`, `Codename: ${input.codename}`);
  lines.push(`Date: ${rfc2822(input.date)}`);
  if (input.validUntil) lines.push(`Valid-Until: ${rfc2822(input.validUntil)}`);
  lines.push(`Architectures: ${input.architectures.join(" ")}`);
  lines.push(`Components: ${input.components.join(" ")}`);
  if (input.description) lines.push(`Description: ${oneLine(input.description)}`);
  if (input.acquireByHash) lines.push("Acquire-By-Hash: yes");
  const files = [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const [heading, key] of [
    ["MD5Sum", "md5"],
    ["SHA1", "sha1"],
    ["SHA256", "sha256"],
  ] as const) {
    lines.push(`${heading}:`);
    for (const file of files) {
      lines.push(` ${file[key]} ${String(file.size).padStart(16)} ${file.path}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** The per-architecture `dists/<dist>/<component>/binary-<arch>/Release`. */
export function componentReleaseFile(input: {
  suite: string;
  codename?: string;
  component: string;
  architecture: string;
  origin?: string;
  label?: string;
  acquireByHash?: boolean;
}): string {
  const lines = [`Archive: ${input.suite}`];
  if (input.codename) lines.push(`Codename: ${input.codename}`);
  lines.push(`Component: ${input.component}`);
  if (input.origin) lines.push(`Origin: ${oneLine(input.origin)}`);
  if (input.label) lines.push(`Label: ${oneLine(input.label)}`);
  if (input.acquireByHash) lines.push("Acquire-By-Hash: yes");
  lines.push(`Architecture: ${input.architecture}`);
  return `${lines.join("\n")}\n`;
}

/** Architectures an `all` package fans out to when nothing more specific exists. */
export const DEFAULT_ARCHITECTURES = ["amd64", "arm64", "armhf", "i386"];
