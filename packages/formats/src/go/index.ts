/**
 * Go module proxy protocol logic (GOPROXY): module path and version case
 * escaping, module path validation (golang.org/x/mod/module rules), semantic
 * versions including pseudo-versions and `+incompatible`, and module zip
 * layout checks (golang.org/x/mod/zip limits).
 */

// ---------------------------------------------------------------------------
// Case escaping: uppercase letters become `!` + lowercase.

function escapeString(value: string): string | null {
  let out = "";
  for (const ch of value) {
    if (ch === "!" || ch.charCodeAt(0) >= 0x80) return null;
    if (ch >= "A" && ch <= "Z") out += `!${ch.toLowerCase()}`;
    else out += ch;
  }
  return out;
}

function unescapeString(value: string): string | null {
  let out = "";
  let bang = false;
  for (const ch of value) {
    if (bang) {
      if (ch < "a" || ch > "z") return null;
      out += ch.toUpperCase();
      bang = false;
    } else if (ch === "!") bang = true;
    else if (ch >= "A" && ch <= "Z") return null;
    else out += ch;
  }
  return bang ? null : out;
}

export function escapeModulePath(path: string): string {
  const escaped = escapeString(path);
  if (escaped === null || checkModulePath(path)) throw new Error(`invalid module path ${path}`);
  return escaped;
}

/** The module path for an escaped path, or null if malformed or invalid. */
export function unescapeModulePath(escaped: string): string | null {
  const path = unescapeString(escaped);
  return path !== null && checkModulePath(path) === null ? path : null;
}

export function escapeVersion(version: string): string {
  const escaped = escapeString(version);
  if (escaped === null) throw new Error(`invalid version ${version}`);
  return escaped;
}

export function unescapeVersion(escaped: string): string | null {
  return unescapeString(escaped);
}

// ---------------------------------------------------------------------------
// Path validation

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

function modulePathChar(ch: string): boolean {
  return /^[A-Za-z0-9\-._~]$/.test(ch);
}

function filePathChar(ch: string): boolean {
  if (ch.charCodeAt(0) >= 0x80) return /\p{L}/u.test(ch);
  return /^[A-Za-z0-9!#$%&()+,\-.=@[\]^_{}~ ]$/.test(ch);
}

function checkElem(elem: string, kind: "module" | "file"): string | null {
  if (elem === "") return "empty path element";
  if (elem === "." || elem === "..") return `invalid path element ${elem}`;
  if (kind === "module" && elem.startsWith(".")) return "leading dot in path element";
  if (elem.endsWith(".")) return "trailing dot in path element";
  for (const ch of elem) {
    if (!(kind === "module" ? modulePathChar(ch) : filePathChar(ch))) {
      return `invalid char ${JSON.stringify(ch)}`;
    }
  }
  const short = elem.split(".")[0]!.toUpperCase();
  if (WINDOWS_RESERVED.has(short)) return `${elem} is a disallowed path element on Windows`;
  const tilde = elem.lastIndexOf("~");
  if (kind === "file" && tilde > 0 && /^[0-9]+$/.test(elem.slice(tilde + 1).split(".")[0]!)) {
    return `${elem} looks like a Windows short name`;
  }
  return null;
}

/**
 * Splits a module path into its prefix and major version suffix (`/v2`, or
 * `.v1` for gopkg.in). `ok` is false for suffixes like `/v1` or `/v02`.
 */
export function splitPathVersion(path: string): { prefix: string; pathMajor: string; ok: boolean } {
  if (path.startsWith("gopkg.in/")) {
    const match = /^(.*)\.(v(?:0|[1-9][0-9]*))(-unstable)?$/.exec(path);
    if (!match) return { prefix: path, pathMajor: "", ok: false };
    return { prefix: match[1]!, pathMajor: `.${match[2]}${match[3] ?? ""}`, ok: true };
  }
  let i = path.length;
  let dot = false;
  while (i > 0 && /[0-9.]/.test(path[i - 1]!)) {
    if (path[i - 1] === ".") dot = true;
    i--;
  }
  if (i <= 1 || i === path.length || path[i - 1] !== "v" || path[i - 2] !== "/") {
    return { prefix: path, pathMajor: "", ok: true };
  }
  const prefix = path.slice(0, i - 2);
  const pathMajor = path.slice(i - 2);
  if (dot || pathMajor.length <= 2 || pathMajor[2] === "0" || pathMajor === "/v1") {
    return { prefix: path, pathMajor: "", ok: false };
  }
  return { prefix, pathMajor, ok: true };
}

/** Why `path` is not a valid module path, or null. */
export function checkModulePath(path: string): string | null {
  if (path === "") return "empty module path";
  if (path.length > 1024) return "module path too long";
  if (path.startsWith("/") || path.endsWith("/")) return "leading or trailing slash";
  if (path.includes("//")) return "double slash";
  const elems = path.split("/");
  const first = elems[0]!;
  if (!first.includes(".")) return "missing dot in first path element";
  if (first.startsWith("-")) return "leading dash in first path element";
  for (const ch of first) {
    if (!/^[a-z0-9.-]$/.test(ch)) return `invalid char ${JSON.stringify(ch)} in first path element`;
  }
  for (const elem of elems) {
    const problem = checkElem(elem, "module");
    if (problem) return problem;
  }
  if (!splitPathVersion(path).ok) return "invalid major version suffix";
  return null;
}

/** Why `path` (relative to the module root) is not a valid file path, or null. */
export function checkFilePath(path: string): string | null {
  if (path === "") return "empty file path";
  if (path.startsWith("/") || path.endsWith("/")) return "leading or trailing slash";
  if (path.includes("\\")) return "backslash in file path";
  for (const elem of path.split("/")) {
    const problem = checkElem(elem, "file");
    if (problem) return `${problem} in ${path}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Semantic versions (golang.org/x/mod/semver)

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string;
  /** False for the `v1` / `v1.2` shorthands. */
  complete: boolean;
}

const NUM = "(0|[1-9][0-9]*)";
const PRE_IDENT = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const SEMVER = new RegExp(
  `^v${NUM}(?:\\.${NUM}(?:\\.${NUM}(?:-(${PRE_IDENT}(?:\\.${PRE_IDENT})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?)?)?$`,
);

export function parseSemver(v: string): Semver | null {
  const match = SEMVER.exec(v);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2] ?? 0),
    patch: Number(match[3] ?? 0),
    prerelease: match[4] ? match[4].split(".") : [],
    build: match[5] ? `+${match[5]}` : "",
    complete: match[3] !== undefined,
  };
}

/** A version the proxy accepts: canonical `vX.Y.Z[-pre]`, with only `+incompatible` as build. */
export function isCanonicalVersion(v: string): boolean {
  const s = parseSemver(v);
  return !!s && s.complete && (s.build === "" || s.build === "+incompatible");
}

function compareIdent(a: string, b: string): number {
  const an = /^[0-9]+$/.test(a);
  const bn = /^[0-9]+$/.test(b);
  if (an && bn) {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semver precedence; invalid versions sort before valid ones (like semver.Compare). */
export function compareSemver(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const key of ["major", "minor", "patch"] as const) {
    if (x[key] !== y[key]) return x[key] < y[key] ? -1 : 1;
  }
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    return x.prerelease.length === y.prerelease.length ? 0 : x.prerelease.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.min(x.prerelease.length, y.prerelease.length); i++) {
    const c = compareIdent(x.prerelease[i]!, y.prerelease[i]!);
    if (c) return c;
  }
  return x.prerelease.length === y.prerelease.length
    ? 0
    : x.prerelease.length < y.prerelease.length
      ? -1
      : 1;
}

const PSEUDO =
  /^v[0-9]+\.(0\.0-|\d+\.\d+-([^+]*\.)?0\.)\d{14}-[A-Za-z0-9]+(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

export function isPseudoVersion(v: string): boolean {
  return (v.match(/-/g) ?? []).length >= 2 && PSEUDO.test(v) && parseSemver(v) !== null;
}

export function isPrereleaseVersion(v: string): boolean {
  return (parseSemver(v)?.prerelease.length ?? 0) > 0;
}

/**
 * Why `version` cannot be a version of `path` (major version suffix rules,
 * `+incompatible`), or null.
 */
export function checkVersionForPath(path: string, version: string): string | null {
  if (!isCanonicalVersion(version)) return `${version} is not a canonical semantic version`;
  const { pathMajor } = splitPathVersion(path);
  const s = parseSemver(version)!;
  const major = `v${s.major}`;
  if (s.build === "+incompatible") {
    if (pathMajor) return "+incompatible is only allowed for modules without a major suffix";
    if (s.major < 2) return `+incompatible is not allowed for ${major}`;
    return null;
  }
  let want = pathMajor.replace(/-unstable$/, "");
  if (want === ".v1" && version.startsWith("v0.0.0-")) return null;
  if (want === "") {
    if (s.major <= 1) return null;
    want = "v0 or v1";
  } else {
    want = want.slice(1);
    if (want === major) return null;
  }
  return `version ${version} is invalid: should be ${want}, not ${major}`;
}

export function sortVersions(versions: Iterable<string>): string[] {
  return [...new Set(versions)].sort(compareSemver);
}

/** What `@latest` picks: the highest release, else prerelease, else pseudo-version. */
export function latestVersion(versions: Iterable<string>): string | null {
  const all = sortVersions(versions).filter((v) => parseSemver(v));
  const releases = all.filter((v) => !isPrereleaseVersion(v));
  const pre = all.filter((v) => isPrereleaseVersion(v) && !isPseudoVersion(v));
  return releases.at(-1) ?? pre.at(-1) ?? all.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// Proxy requests

export type ProxyRequest =
  | { kind: "list"; module: string }
  | { kind: "latest"; module: string }
  | { kind: "info"; module: string; version: string }
  | { kind: "mod"; module: string; version: string }
  | { kind: "zip"; module: string; version: string };

/**
 * Parses the part of a GOPROXY URL after the proxy root
 * (`github.com/!azure/x/@v/v1.0.0.info`), unescaping the module and version.
 */
export function parseProxyPath(rest: string): ProxyRequest | null {
  if (rest.endsWith("/@latest")) {
    const module = unescapeModulePath(rest.slice(0, -"/@latest".length));
    return module ? { kind: "latest", module } : null;
  }
  const at = rest.lastIndexOf("/@v/");
  if (at === -1) return null;
  const module = unescapeModulePath(rest.slice(0, at));
  if (!module) return null;
  const file = rest.slice(at + 4);
  if (file === "list") return { kind: "list", module };
  const match = /^(.+)\.(info|mod|zip)$/.exec(file);
  if (!match) return null;
  const version = unescapeVersion(match[1]!);
  if (!version || version.includes("/")) return null;
  return { kind: match[2] as "info" | "mod" | "zip", module, version };
}

// ---------------------------------------------------------------------------
// Module zips

export const MAX_ZIP_FILE = 500 * 1024 * 1024;
export const MAX_GO_MOD = 16 * 1024 * 1024;
export const MAX_LICENSE = 16 * 1024 * 1024;

export interface ModuleZipEntry {
  name: string;
  uncompressedSize: number;
  directory?: boolean;
}

export interface ModuleZipCheck {
  errors: string[];
  /** The root go.mod entry, when present. */
  goMod: ModuleZipEntry | null;
}

/** Checks a module zip's layout against golang.org/x/mod/zip rules. */
export function checkModuleZip(
  entries: ModuleZipEntry[],
  module: string,
  version: string,
  zipSize?: number,
): ModuleZipCheck {
  const errors: string[] = [];
  const prefix = `${module}@${version}/`;
  if (zipSize !== undefined && zipSize > MAX_ZIP_FILE) {
    errors.push(`module zip is larger than ${MAX_ZIP_FILE} bytes`);
  }
  let total = 0;
  let goMod: ModuleZipEntry | null = null;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) {
      errors.push(`${entry.name}: path does not have prefix ${prefix}`);
      continue;
    }
    const name = entry.name.slice(prefix.length);
    if (entry.directory || entry.name.endsWith("/")) {
      errors.push(`${entry.name}: directory entries are not allowed (build the zip with zip -D)`);
      continue;
    }
    const problem = checkFilePath(name);
    if (problem) {
      errors.push(`${entry.name}: ${problem}`);
      continue;
    }
    const folded = name.toLowerCase();
    if (seen.has(folded)) {
      errors.push(`${entry.name}: multiple entries with the same case-insensitive name`);
      continue;
    }
    seen.add(folded);
    total += entry.uncompressedSize;
    if (name === "go.mod") {
      if (entry.uncompressedSize > MAX_GO_MOD) errors.push("go.mod is larger than 16 MiB");
      goMod = entry;
    }
    if (name === "LICENSE" && entry.uncompressedSize > MAX_LICENSE) {
      errors.push("LICENSE is larger than 16 MiB");
    }
  }
  if (total > MAX_ZIP_FILE) errors.push(`module files total more than ${MAX_ZIP_FILE} bytes`);
  if (entries.length === 0) errors.push("module zip is empty");
  return { errors, goMod };
}

/** The path from a go.mod `module` directive, or null. */
export function goModModulePath(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const match = /^module\s+(?:"((?:[^"\\]|\\.)*)"|`([^`]*)`|(\S+))\s*$/.exec(line);
    if (match) return match[1] ?? match[2] ?? match[3] ?? null;
  }
  return null;
}

/** The go.mod the go command synthesizes for modules that have none. */
export function synthesizeGoMod(module: string): string {
  return `module ${module}\n`;
}

export interface VersionInfo {
  Version: string;
  Time: string;
}

export function versionInfo(version: string, time: string): VersionInfo {
  return { Version: version, Time: time };
}
