/**
 * RPM repository logic: a pure-TS reader for the RPM lead and headers (the
 * payload is never touched) and writers for the createrepo_c metadata that
 * dnf, yum and zypper read (repomd.xml, primary, filelists, other).
 */

// ---------------------------------------------------------------------------
// Header reader

const LEAD_SIZE = 96;
const LEAD_MAGIC = [0xed, 0xab, 0xee, 0xdb];
const HEADER_MAGIC = [0x8e, 0xad, 0xe8, 0x01];
/** Refuse headers larger than this (real ones are KBs to a few MB). */
export const MAX_HEADER_BYTES = 64 * 1024 * 1024;

const TYPE = {
  CHAR: 1,
  INT8: 2,
  INT16: 3,
  INT32: 4,
  INT64: 5,
  STRING: 6,
  BIN: 7,
  ARRAY: 8,
  I18N: 9,
};

export const TAG = {
  NAME: 1000,
  VERSION: 1001,
  RELEASE: 1002,
  EPOCH: 1003,
  SUMMARY: 1004,
  DESCRIPTION: 1005,
  BUILDTIME: 1006,
  BUILDHOST: 1007,
  SIZE: 1009,
  VENDOR: 1011,
  LICENSE: 1014,
  PACKAGER: 1015,
  GROUP: 1016,
  URL: 1020,
  ARCH: 1022,
  OLDFILENAMES: 1027,
  FILEMODES: 1030,
  FILEFLAGS: 1037,
  SOURCERPM: 1044,
  ARCHIVESIZE: 1046,
  PROVIDENAME: 1047,
  REQUIREFLAGS: 1048,
  REQUIRENAME: 1049,
  REQUIREVERSION: 1050,
  CONFLICTFLAGS: 1053,
  CONFLICTNAME: 1054,
  CONFLICTVERSION: 1055,
  CHANGELOGTIME: 1080,
  CHANGELOGNAME: 1081,
  CHANGELOGTEXT: 1082,
  OBSOLETENAME: 1090,
  SOURCEPACKAGE: 1106,
  PROVIDEFLAGS: 1112,
  PROVIDEVERSION: 1113,
  OBSOLETEFLAGS: 1114,
  OBSOLETEVERSION: 1115,
  DIRINDEXES: 1116,
  BASENAMES: 1117,
  DIRNAMES: 1118,
  LONGSIZE: 5009,
  RECOMMENDNAME: 5046,
  RECOMMENDVERSION: 5047,
  RECOMMENDFLAGS: 5048,
  SUGGESTNAME: 5049,
  SUGGESTVERSION: 5050,
  SUGGESTFLAGS: 5051,
  SUPPLEMENTNAME: 5052,
  SUPPLEMENTVERSION: 5053,
  SUPPLEMENTFLAGS: 5054,
  ENHANCENAME: 5055,
  ENHANCEVERSION: 5056,
  ENHANCEFLAGS: 5057,
} as const;

const SIGTAG = { SIZE: 1000, PAYLOADSIZE: 1007, LONGSIZE: 270, LONGARCHIVESIZE: 271 };

type TagValue = string | string[] | number[] | Uint8Array;

class Header {
  readonly tags: Map<number, TagValue>;
  constructor(tags: Map<number, TagValue>) {
    this.tags = tags;
  }
  string(tag: number): string | undefined {
    const v = this.tags.get(tag);
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
    return undefined;
  }
  strings(tag: number): string[] {
    const v = this.tags.get(tag);
    if (typeof v === "string") return [v];
    return Array.isArray(v) && (v.length === 0 || typeof v[0] === "string") ? (v as string[]) : [];
  }
  numbers(tag: number): number[] {
    const v = this.tags.get(tag);
    return Array.isArray(v) && typeof v[0] === "number" ? (v as number[]) : [];
  }
  number(tag: number): number | undefined {
    return this.numbers(tag)[0];
  }
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0
  );
}

function matches(bytes: Uint8Array, at: number, magic: number[]): boolean {
  return magic.every((b, i) => bytes[at + i] === b);
}

const utf8 = new TextDecoder();

function readHeader(bytes: Uint8Array, start: number): { header: Header; end: number } {
  if (!matches(bytes, start, HEADER_MAGIC)) throw new Error("bad RPM header magic");
  const count = u32(bytes, start + 8);
  const storeSize = u32(bytes, start + 12);
  if (count > 1_000_000 || storeSize > MAX_HEADER_BYTES) throw new Error("RPM header too large");
  const indexStart = start + 16;
  const storeStart = indexStart + count * 16;
  const end = storeStart + storeSize;
  if (end > bytes.length) throw new Error("truncated RPM header");
  const store = bytes.subarray(storeStart, end);
  const tags = new Map<number, TagValue>();
  const cstr = (at: number): [string, number] => {
    const stop = store.indexOf(0, at);
    if (stop === -1) throw new Error("unterminated RPM header string");
    return [utf8.decode(store.subarray(at, stop)), stop + 1];
  };
  for (let i = 0; i < count; i++) {
    const e = indexStart + i * 16;
    const tag = u32(bytes, e);
    const type = u32(bytes, e + 4);
    const offset = u32(bytes, e + 8);
    const n = u32(bytes, e + 12);
    if (offset > store.length) throw new Error("RPM header entry out of range");
    switch (type) {
      case TYPE.STRING:
        tags.set(tag, cstr(offset)[0]);
        break;
      case TYPE.ARRAY:
      case TYPE.I18N: {
        const out: string[] = [];
        let at = offset;
        for (let k = 0; k < n; k++) {
          const [s, next] = cstr(at);
          out.push(s);
          at = next;
        }
        tags.set(tag, out);
        break;
      }
      case TYPE.INT32: {
        if (offset + n * 4 > store.length) throw new Error("RPM header entry out of range");
        const out: number[] = [];
        for (let k = 0; k < n; k++) out.push(u32(store, offset + k * 4));
        tags.set(tag, out);
        break;
      }
      case TYPE.INT16: {
        if (offset + n * 2 > store.length) throw new Error("RPM header entry out of range");
        const out: number[] = [];
        for (let k = 0; k < n; k++)
          out.push((store[offset + k * 2]! << 8) | store[offset + k * 2 + 1]!);
        tags.set(tag, out);
        break;
      }
      case TYPE.INT64: {
        if (offset + n * 8 > store.length) throw new Error("RPM header entry out of range");
        const out: number[] = [];
        for (let k = 0; k < n; k++) {
          out.push(u32(store, offset + k * 8) * 2 ** 32 + u32(store, offset + k * 8 + 4));
        }
        tags.set(tag, out);
        break;
      }
      case TYPE.CHAR:
      case TYPE.INT8:
        tags.set(tag, Array.from(store.subarray(offset, offset + n)));
        break;
      case TYPE.BIN:
        tags.set(tag, store.subarray(offset, offset + n));
        break;
      default:
        break;
    }
  }
  return { header: new Header(tags), end };
}

/**
 * How many leading bytes of the file are needed to read both headers. Call
 * with a prefix; if the result exceeds its length, read that many and retry.
 */
export function rpmHeaderSpan(prefix: Uint8Array): number {
  if (prefix.length < LEAD_SIZE + 16) return LEAD_SIZE + 16;
  if (!matches(prefix, 0, LEAD_MAGIC)) throw new Error("not an RPM file");
  if (!matches(prefix, LEAD_SIZE, HEADER_MAGIC)) throw new Error("bad RPM signature header");
  const sigEnd = LEAD_SIZE + 16 + u32(prefix, LEAD_SIZE + 8) * 16 + u32(prefix, LEAD_SIZE + 12);
  const mainStart = sigEnd + ((8 - (sigEnd % 8)) % 8);
  if (mainStart > MAX_HEADER_BYTES) throw new Error("RPM signature header too large");
  if (prefix.length < mainStart + 16) return mainStart + 16;
  if (!matches(prefix, mainStart, HEADER_MAGIC)) throw new Error("bad RPM header magic");
  const end = mainStart + 16 + u32(prefix, mainStart + 8) * 16 + u32(prefix, mainStart + 12);
  if (end > MAX_HEADER_BYTES) throw new Error("RPM header too large");
  return end;
}

// ---------------------------------------------------------------------------
// Parsed package

export type DepFlag = "EQ" | "LT" | "GT" | "LE" | "GE";

export interface Dependency {
  name: string;
  flags?: DepFlag;
  epoch?: string;
  ver?: string;
  rel?: string;
  /** Requires only: needed before install scripts run (`pre="1"`). */
  pre?: boolean;
}

export interface RpmFile {
  path: string;
  type?: "dir" | "ghost";
}

export interface ChangelogEntry {
  author: string;
  date: number;
  text: string;
}

export interface RpmPackage {
  name: string;
  epoch: string;
  version: string;
  release: string;
  arch: string;
  summary: string;
  description: string;
  packager: string;
  url: string;
  license: string;
  vendor: string;
  group: string;
  buildhost: string;
  sourcerpm: string;
  buildTime: number;
  installedSize: number;
  archiveSize: number;
  headerStart: number;
  headerEnd: number;
  provides: Dependency[];
  requires: Dependency[];
  conflicts: Dependency[];
  obsoletes: Dependency[];
  recommends: Dependency[];
  suggests: Dependency[];
  supplements: Dependency[];
  enhances: Dependency[];
  files: RpmFile[];
  /** Newest first, as stored in the header (all entries). */
  changelog: ChangelogEntry[];
}

const SENSE = {
  LESS: 1 << 1,
  GREATER: 1 << 2,
  EQUAL: 1 << 3,
  POSTTRANS: 1 << 5,
  PREREQ: 1 << 6,
  PRETRANS: 1 << 7,
  INTERP: 1 << 8,
  SCRIPT_PRE: 1 << 9,
  SCRIPT_POST: 1 << 10,
  RPMLIB: 1 << 24,
};
const PRE_MASK =
  SENSE.PREREQ | SENSE.SCRIPT_PRE | SENSE.SCRIPT_POST | SENSE.PRETRANS | SENSE.POSTTRANS;

/** Maps RPMSENSE comparison bits to createrepo's flag names. */
export function depFlag(flags: number): DepFlag | undefined {
  switch (flags & (SENSE.LESS | SENSE.GREATER | SENSE.EQUAL)) {
    case SENSE.EQUAL:
      return "EQ";
    case SENSE.LESS:
      return "LT";
    case SENSE.GREATER:
      return "GT";
    case SENSE.LESS | SENSE.EQUAL:
      return "LE";
    case SENSE.GREATER | SENSE.EQUAL:
      return "GE";
    default:
      return undefined;
  }
}

/** Splits `[epoch:]version[-release]` the way createrepo_c does (epoch defaults to 0). */
export function splitEvr(evr: string): { epoch: string; ver: string; rel?: string } {
  let rest = evr;
  let epoch = "0";
  const colon = rest.indexOf(":");
  if (colon !== -1 && /^\d*$/.test(rest.slice(0, colon))) {
    epoch = rest.slice(0, colon) || "0";
    rest = rest.slice(colon + 1);
  }
  const dash = rest.lastIndexOf("-");
  if (dash === -1) return { epoch, ver: rest };
  return { epoch, ver: rest.slice(0, dash), rel: rest.slice(dash + 1) };
}

function deps(
  h: Header,
  nameTag: number,
  flagsTag: number,
  versionTag: number,
  kind: "provides" | "requires" | "other",
): Dependency[] {
  const names = h.strings(nameTag);
  const flags = h.numbers(flagsTag);
  const versions = h.strings(versionTag);
  const seen = new Set<string>();
  const out: Dependency[] = [];
  // createrepo_c keeps only the highest libc.so.6 requirement.
  let libc: Dependency | undefined;
  for (const [i, name] of names.entries()) {
    const f = flags[i] ?? 0;
    const version = versions[i] ?? "";
    if (kind === "requires" && (name.startsWith("rpmlib(") || f & SENSE.RPMLIB)) continue;
    const dep: Dependency = { name };
    const flag = depFlag(f);
    if (flag && version) {
      dep.flags = flag;
      Object.assign(dep, splitEvr(version));
      if (dep.rel === undefined) delete dep.rel;
    }
    if (kind === "requires" && f & PRE_MASK) dep.pre = true;
    if (kind === "requires" && name.startsWith("libc.so.6")) {
      if (!libc || glibcVersionCompare(name, libc.name) > 0) libc = dep;
      continue;
    }
    const key = `${dep.name}\0${dep.flags ?? ""}\0${dep.epoch ?? ""}\0${dep.ver ?? ""}\0${dep.rel ?? ""}\0${dep.pre ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dep);
  }
  if (libc) out.push(libc);
  return out;
}

function glibcVersionCompare(a: string, b: string): number {
  const version = (name: string) => /\(GLIBC_([^)]*)\)/.exec(name)?.[1] ?? "";
  return rpmvercmp(version(a), version(b));
}

/** Parses an RPM's lead and headers. `bytes` must hold at least `rpmHeaderSpan` bytes. */
export function parseRpm(bytes: Uint8Array): RpmPackage {
  if (bytes.length < LEAD_SIZE || !matches(bytes, 0, LEAD_MAGIC))
    throw new Error("not an RPM file");
  const sig = readHeader(bytes, LEAD_SIZE);
  const headerStart = sig.end + ((8 - (sig.end % 8)) % 8);
  const { header: h, end: headerEnd } = readHeader(bytes, headerStart);
  const s = sig.header;

  const name = h.string(TAG.NAME);
  const version = h.string(TAG.VERSION);
  const release = h.string(TAG.RELEASE);
  if (!name || !version || release === undefined)
    throw new Error("RPM header lacks NAME/VERSION/RELEASE");
  const sourcerpm = h.string(TAG.SOURCERPM) ?? "";
  const isSource = !sourcerpm || h.tags.has(TAG.SOURCEPACKAGE);
  const arch = isSource ? "src" : (h.string(TAG.ARCH) ?? "noarch");

  // Files: BASENAMES + DIRNAMES[DIRINDEXES], or OLDFILENAMES on ancient packages.
  const basenames = h.strings(TAG.BASENAMES);
  const dirnames = h.strings(TAG.DIRNAMES);
  const dirindexes = h.numbers(TAG.DIRINDEXES);
  const paths = basenames.length
    ? basenames.map((b, i) => `${dirnames[dirindexes[i] ?? 0] ?? ""}${b}`)
    : h.strings(TAG.OLDFILENAMES);
  const modes = h.numbers(TAG.FILEMODES);
  const fileFlags = h.numbers(TAG.FILEFLAGS);
  const files: RpmFile[] = paths.map((path, i) => {
    const mode = modes[i] ?? 0;
    const ghost = ((fileFlags[i] ?? 0) & (1 << 6)) !== 0;
    if (ghost) return { path, type: "ghost" };
    if ((mode & 0o170000) === 0o040000) return { path, type: "dir" };
    return { path };
  });

  const times = h.numbers(TAG.CHANGELOGTIME);
  const authors = h.strings(TAG.CHANGELOGNAME);
  const texts = h.strings(TAG.CHANGELOGTEXT);
  const changelog = times.map((date, i) => ({
    date,
    author: authors[i] ?? "",
    text: texts[i] ?? "",
  }));

  const epoch = h.number(TAG.EPOCH);
  return {
    name,
    epoch: epoch === undefined ? "0" : String(epoch),
    version,
    release,
    arch,
    summary: h.string(TAG.SUMMARY) ?? "",
    description: h.string(TAG.DESCRIPTION) ?? "",
    packager: h.string(TAG.PACKAGER) ?? "",
    url: h.string(TAG.URL) ?? "",
    license: h.string(TAG.LICENSE) ?? "",
    vendor: h.string(TAG.VENDOR) ?? "",
    group: h.string(TAG.GROUP) ?? "",
    buildhost: h.string(TAG.BUILDHOST) ?? "",
    sourcerpm,
    buildTime: h.number(TAG.BUILDTIME) ?? 0,
    installedSize: h.number(TAG.LONGSIZE) ?? h.number(TAG.SIZE) ?? 0,
    archiveSize:
      s.number(SIGTAG.LONGARCHIVESIZE) ??
      s.number(SIGTAG.PAYLOADSIZE) ??
      h.number(TAG.ARCHIVESIZE) ??
      0,
    headerStart,
    headerEnd,
    provides: deps(h, TAG.PROVIDENAME, TAG.PROVIDEFLAGS, TAG.PROVIDEVERSION, "provides"),
    requires: deps(h, TAG.REQUIRENAME, TAG.REQUIREFLAGS, TAG.REQUIREVERSION, "requires"),
    conflicts: deps(h, TAG.CONFLICTNAME, TAG.CONFLICTFLAGS, TAG.CONFLICTVERSION, "other"),
    obsoletes: deps(h, TAG.OBSOLETENAME, TAG.OBSOLETEFLAGS, TAG.OBSOLETEVERSION, "other"),
    recommends: deps(h, TAG.RECOMMENDNAME, TAG.RECOMMENDFLAGS, TAG.RECOMMENDVERSION, "other"),
    suggests: deps(h, TAG.SUGGESTNAME, TAG.SUGGESTFLAGS, TAG.SUGGESTVERSION, "other"),
    supplements: deps(h, TAG.SUPPLEMENTNAME, TAG.SUPPLEMENTFLAGS, TAG.SUPPLEMENTVERSION, "other"),
    enhances: deps(h, TAG.ENHANCENAME, TAG.ENHANCEFLAGS, TAG.ENHANCEVERSION, "other"),
    files,
    changelog,
  };
}

/** `name-[epoch:]version-release.arch` (epoch omitted when 0). */
export function nevra(
  pkg: Pick<RpmPackage, "name" | "epoch" | "version" | "release" | "arch">,
): string {
  const epoch = pkg.epoch && pkg.epoch !== "0" ? `${pkg.epoch}:` : "";
  return `${pkg.name}-${epoch}${pkg.version}-${pkg.release}.${pkg.arch}`;
}

/** The conventional file name: `name-version-release.arch.rpm`. */
export function rpmFilename(
  pkg: Pick<RpmPackage, "name" | "version" | "release" | "arch">,
): string {
  return `${pkg.name}-${pkg.version}-${pkg.release}.${pkg.arch}.rpm`;
}

export function parseNevra(
  value: string,
): { name: string; epoch: string; version: string; release: string; arch: string } | null {
  const m = /^(.+)-(?:(\d+):)?([^-:]+)-([^-:]+)\.([A-Za-z0-9_]+)$/.exec(
    value.replace(/\.rpm$/, ""),
  );
  if (!m) return null;
  return { name: m[1]!, epoch: m[2] ?? "0", version: m[3]!, release: m[4]!, arch: m[5]! };
}

export const RPM_NAME = /^[A-Za-z0-9_+][A-Za-z0-9._+-]*$/;
export const RPM_VERSION = /^[A-Za-z0-9._+~^]+$/;
export const RPM_ARCH = /^[A-Za-z0-9_]+$/;

// ---------------------------------------------------------------------------
// createrepo_c-compatible XML

/** XML 1.0 forbids most C0 controls and U+FFFE/U+FFFF, even as character references. */
function stripInvalidXml(value: string): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    const allowed =
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0d ||
      (code >= 0x20 && code !== 0xfffe && code !== 0xffff);
    if (allowed) out += ch;
  }
  return out;
}

export function xmlEscape(value: string): string {
  return stripInvalidXml(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const NS_COMMON = "http://linux.duke.edu/metadata/common";
const NS_RPM = "http://linux.duke.edu/metadata/rpm";
const NS_FILELISTS = "http://linux.duke.edu/metadata/filelists";
const NS_OTHER = "http://linux.duke.edu/metadata/other";
const NS_REPO = "http://linux.duke.edu/metadata/repo";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>\n';

/** createrepo_c's rule for which files go in primary.xml. */
export function isPrimaryFile(path: string): boolean {
  return path.startsWith("/etc/") || path.includes("bin/") || path === "/usr/lib/sendmail";
}

export interface RpmFileInfo {
  /** sha256 of the whole .rpm (the pkgid). */
  sha256: string;
  size: number;
  /** Repository-relative location, e.g. `Packages/w/which-2.21-20.el8.x86_64.rpm`. */
  location: string;
  /** Seconds since the epoch (upload time). */
  fileTime: number;
}

function entries(tag: string, list: Dependency[], requires = false): string {
  if (!list.length) return "";
  const lines = list.map((d) => {
    let attrs = `name="${xmlEscape(d.name)}"`;
    if (d.flags) {
      attrs += ` flags="${d.flags}"`;
      if (d.epoch) attrs += ` epoch="${xmlEscape(d.epoch)}"`;
      if (d.ver) attrs += ` ver="${xmlEscape(d.ver)}"`;
      if (d.rel) attrs += ` rel="${xmlEscape(d.rel)}"`;
    }
    if (requires && d.pre) attrs += ` pre="1"`;
    return `      <rpm:entry ${attrs}/>`;
  });
  return `    <rpm:${tag}>\n${lines.join("\n")}\n    </rpm:${tag}>\n`;
}

function fileLine(file: RpmFile, indent: string): string {
  const type = file.type ? ` type="${file.type}"` : "";
  return `${indent}<file${type}>${xmlEscape(file.path)}</file>\n`;
}

function versionTag(pkg: RpmPackage): string {
  return `<version epoch="${xmlEscape(pkg.epoch)}" ver="${xmlEscape(pkg.version)}" rel="${xmlEscape(pkg.release)}"/>`;
}

function textTag(name: string, value: string): string {
  return `<${name}>${xmlEscape(value)}</${name}>`;
}

/** One `<package>` element of primary.xml. */
export function primaryPackage(pkg: RpmPackage, file: RpmFileInfo): string {
  // Requires on files the package itself ships are dropped, like createrepo_c.
  const own = new Set(pkg.files.map((f) => f.path));
  const requires = pkg.requires.filter((d) => !(d.name.startsWith("/") && own.has(d.name)));
  const primaryFiles = pkg.files.filter((f) => isPrimaryFile(f.path));
  return (
    `<package type="rpm">\n` +
    `  <name>${xmlEscape(pkg.name)}</name>\n` +
    `  <arch>${xmlEscape(pkg.arch)}</arch>\n` +
    `  ${versionTag(pkg)}\n` +
    `  <checksum type="sha256" pkgid="YES">${file.sha256}</checksum>\n` +
    `  ${textTag("summary", pkg.summary)}\n` +
    `  ${textTag("description", pkg.description)}\n` +
    `  ${textTag("packager", pkg.packager)}\n` +
    `  ${textTag("url", pkg.url)}\n` +
    `  <time file="${file.fileTime}" build="${pkg.buildTime}"/>\n` +
    `  <size package="${file.size}" installed="${pkg.installedSize}" archive="${pkg.archiveSize}"/>\n` +
    `  <location href="${xmlEscape(file.location)}"/>\n` +
    `  <format>\n` +
    `    ${textTag("rpm:license", pkg.license)}\n` +
    `    ${textTag("rpm:vendor", pkg.vendor)}\n` +
    `    ${textTag("rpm:group", pkg.group)}\n` +
    `    ${textTag("rpm:buildhost", pkg.buildhost)}\n` +
    `    ${textTag("rpm:sourcerpm", pkg.sourcerpm)}\n` +
    `    <rpm:header-range start="${pkg.headerStart}" end="${pkg.headerEnd}"/>\n` +
    entries("provides", pkg.provides) +
    entries("requires", requires, true) +
    entries("conflicts", pkg.conflicts) +
    entries("obsoletes", pkg.obsoletes) +
    entries("suggests", pkg.suggests) +
    entries("enhances", pkg.enhances) +
    entries("recommends", pkg.recommends) +
    entries("supplements", pkg.supplements) +
    primaryFiles.map((f) => fileLine(f, "    ")).join("") +
    `  </format>\n` +
    `</package>\n`
  );
}

function packageAttrs(pkg: RpmPackage, file: RpmFileInfo): string {
  return `pkgid="${file.sha256}" name="${xmlEscape(pkg.name)}" arch="${xmlEscape(pkg.arch)}"`;
}

/** One `<package>` element of filelists.xml. */
export function filelistsPackage(pkg: RpmPackage, file: RpmFileInfo): string {
  return (
    `<package ${packageAttrs(pkg, file)}>\n` +
    `  ${versionTag(pkg)}\n` +
    pkg.files.map((f) => fileLine(f, "  ")).join("") +
    `</package>\n`
  );
}

/** One `<package>` element of other.xml, with the newest `changelogLimit` entries oldest-first. */
export function otherPackage(pkg: RpmPackage, file: RpmFileInfo, changelogLimit = 10): string {
  const recent = pkg.changelog.slice(0, changelogLimit).reverse();
  // Like createrepo_c, equal timestamps are bumped so entries stay distinct.
  let previous = Number.NaN;
  const dated = recent.map((entry) => {
    const date = entry.date === previous ? previous + 1 : entry.date;
    previous = date;
    return { ...entry, date };
  });
  return (
    `<package ${packageAttrs(pkg, file)}>\n` +
    `  ${versionTag(pkg)}\n` +
    dated
      .map(
        (c) =>
          `  <changelog author="${xmlEscape(c.author)}" date="${c.date}">${xmlEscape(c.text)}</changelog>\n`,
      )
      .join("") +
    `</package>\n`
  );
}

export type MetadataKind = "primary" | "filelists" | "other";

/** Opening of a metadata document for `count` packages. */
export function metadataHead(kind: MetadataKind, count: number): string {
  switch (kind) {
    case "primary":
      return `${XML_DECL}<metadata xmlns="${NS_COMMON}" xmlns:rpm="${NS_RPM}" packages="${count}">\n`;
    case "filelists":
      return `${XML_DECL}<filelists xmlns="${NS_FILELISTS}" packages="${count}">\n`;
    case "other":
      return `${XML_DECL}<otherdata xmlns="${NS_OTHER}" packages="${count}">\n`;
  }
}

export function metadataTail(kind: MetadataKind): string {
  return { primary: "</metadata>\n", filelists: "</filelists>\n", other: "</otherdata>\n" }[kind];
}

export interface RepomdEntry {
  type: string;
  /** sha256 of the compressed file. */
  checksum: string;
  /** sha256 of the uncompressed file. */
  openChecksum: string;
  location: string;
  timestamp: number;
  size: number;
  openSize: number;
}

export function repomdXml(revision: number, data: RepomdEntry[]): string {
  const blocks = data.map(
    (d) =>
      `  <data type="${xmlEscape(d.type)}">\n` +
      `    <checksum type="sha256">${d.checksum}</checksum>\n` +
      `    <open-checksum type="sha256">${d.openChecksum}</open-checksum>\n` +
      `    <location href="${xmlEscape(d.location)}"/>\n` +
      `    <timestamp>${d.timestamp}</timestamp>\n` +
      `    <size>${d.size}</size>\n` +
      `    <open-size>${d.openSize}</open-size>\n` +
      `  </data>\n`,
  );
  return (
    `${XML_DECL}<repomd xmlns="${NS_REPO}" xmlns:rpm="${NS_RPM}">\n` +
    `  <revision>${revision}</revision>\n` +
    blocks.join("") +
    `</repomd>\n`
  );
}

/** rpm's version segment comparison (rpmvercmp), for sorting. */
export function rpmvercmp(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  const alnum = (c: string | undefined) => c !== undefined && /[A-Za-z0-9]/.test(c);
  while (i < a.length || j < b.length) {
    while (i < a.length && !alnum(a[i]) && a[i] !== "~" && a[i] !== "^") i++;
    while (j < b.length && !alnum(b[j]) && b[j] !== "~" && b[j] !== "^") j++;
    if (a[i] === "~" || b[j] === "~") {
      if (a[i] !== "~") return 1;
      if (b[j] !== "~") return -1;
      i++;
      j++;
      continue;
    }
    if (a[i] === "^" || b[j] === "^") {
      if (i >= a.length) return -1;
      if (j >= b.length) return 1;
      if (a[i] !== "^") return 1;
      if (b[j] !== "^") return -1;
      i++;
      j++;
      continue;
    }
    if (i >= a.length || j >= b.length) break;
    const numeric = /[0-9]/.test(a[i]!);
    const re = numeric ? /^[0-9]+/ : /^[A-Za-z]+/;
    const sa = re.exec(a.slice(i))?.[0] ?? "";
    const sb = re.exec(b.slice(j))?.[0] ?? "";
    if (!sb) return numeric ? 1 : -1;
    i += sa.length;
    j += sb.length;
    if (numeric) {
      const na = sa.replace(/^0+/, "");
      const nb = sb.replace(/^0+/, "");
      if (na.length !== nb.length) return na.length > nb.length ? 1 : -1;
      if (na !== nb) return na > nb ? 1 : -1;
    } else if (sa !== sb) return sa > sb ? 1 : -1;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}
