import semver from "semver";

import { fromBase64, fromHex, toBase64, toHex } from "../hash/index.ts";

export { PublishBodyError, PublishBodyScanner, type ScanEvent } from "./publish-body.ts";
export { TarballStats } from "./tarball.ts";

/**
 * npm registry protocol logic: package name rules, packuments (full and
 * abbreviated), integrity strings, tarball file names, request paths and the
 * search response shape. No IO; the registry's npm module does the rest.
 */

// ---------------------------------------------------------------------------
// Names, versions, tags

const BLOCKED_NAMES = new Set(["node_modules", "favicon.ico"]);
export const MAX_NAME_LENGTH = 214;

/**
 * Why `name` cannot be published as a new package (the
 * validate-npm-package-name `validForNewPackages` rules), or null if it can.
 */
export function packageNameError(name: unknown): string | null {
  if (typeof name !== "string") return "name must be a string";
  if (name.length === 0) return "name length must be greater than zero";
  if (name.startsWith(".")) return "name cannot start with a period";
  if (name.startsWith("_")) return "name cannot start with an underscore";
  if (name.trim() !== name) return "name cannot contain leading or trailing spaces";
  if (BLOCKED_NAMES.has(name.toLowerCase())) return `${name} is not a valid package name`;
  if (name.length > MAX_NAME_LENGTH) return "name can no longer contain more than 214 characters";
  if (name.toLowerCase() !== name) return "name can no longer contain capital letters";
  const last = name.split("/").pop()!;
  if (/[~'!()*]/.test(last)) {
    return 'name can no longer contain special characters ("~\'!()*")';
  }
  if (encodeURIComponent(name) !== name) {
    const scoped = /^@([^/]+)\/([^/]+)$/.exec(name);
    if (!scoped) return "name can only contain URL-friendly characters";
    const [, scope, pkg] = scoped as unknown as [string, string, string];
    if (encodeURIComponent(scope) !== scope || encodeURIComponent(pkg) !== pkg) {
      return "name can only contain URL-friendly characters";
    }
    if (pkg.startsWith(".") || pkg.startsWith("_")) {
      return "name cannot start with a period or an underscore";
    }
  } else if (name.startsWith("@")) {
    return "scoped names are @scope/name";
  }
  return null;
}

export function isScoped(name: string): boolean {
  return name.startsWith("@") && name.includes("/");
}

/** `@scope/pkg` -> `pkg`; `pkg` -> `pkg`. */
export function baseName(name: string): string {
  return isScoped(name) ? name.slice(name.indexOf("/") + 1) : name;
}

/** npm-package-arg's `escapedName`: `@scope%2fpkg` (what npm puts in URLs). */
export function escapeName(name: string): string {
  if (!isScoped(name)) return encodeURIComponent(name);
  const slash = name.indexOf("/");
  return `@${encodeURIComponent(name.slice(1, slash))}%2f${encodeURIComponent(name.slice(slash + 1))}`;
}

/** Name as URL path segments with a literal slash: `@scope/pkg` (tarball URLs). */
export function namePath(name: string): string {
  if (!isScoped(name)) return encodeURIComponent(name);
  const slash = name.indexOf("/");
  return `@${encodeURIComponent(name.slice(1, slash))}/${encodeURIComponent(name.slice(slash + 1))}`;
}

/** A strictly valid, already-normalized semver version (no `v` prefix, no `=`). */
export function isValidVersion(version: unknown): boolean {
  return typeof version === "string" && version.length <= 256 && semver.valid(version) === version;
}

/** Tags are URL-safe and must not parse as a semver range (else `pkg@tag` is ambiguous). */
export function distTagError(tag: unknown): string | null {
  if (typeof tag !== "string" || tag.length === 0) return "Tag name is required";
  if (tag.length > 128) return "Tag name is too long";
  if (encodeURIComponent(tag) !== tag) return "Tag names must be URL-safe";
  if (semver.validRange(tag) !== null) return "Tag names cannot be valid semver ranges";
  return null;
}

/** Highest stable version, else the highest prerelease. */
export function highestVersion(versions: Iterable<string>): string | null {
  const valid = [...versions].filter((v) => semver.valid(v) !== null);
  if (valid.length === 0) return null;
  const sorted = semver.rsort(valid);
  return sorted.find((v) => semver.prerelease(v) === null) ?? sorted[0]!;
}

export function sortVersions(versions: Iterable<string>): string[] {
  const list = [...versions];
  const valid = semver.sort(list.filter((v) => semver.valid(v) !== null));
  return [...valid, ...list.filter((v) => semver.valid(v) === null)];
}

export function satisfies(version: string, range: string): boolean {
  return semver.satisfies(version, range, { includePrerelease: true });
}

// ---------------------------------------------------------------------------
// Integrity

export type HashName = "sha512" | "sha384" | "sha256" | "sha1";

/**
 * Parses an SRI string (`sha512-<base64> sha1-<base64>`) into hex digests per
 * algorithm; unknown or malformed entries are ignored.
 */
export function parseIntegrity(sri: unknown): Partial<Record<HashName, string>> {
  const out: Partial<Record<HashName, string>> = {};
  if (typeof sri !== "string") return out;
  for (const part of sri.trim().split(/\s+/)) {
    const match = /^(sha512|sha384|sha256|sha1)-([A-Za-z0-9+/]+={0,2})(\?.*)?$/.exec(part);
    if (!match) continue;
    const algo = match[1] as HashName;
    try {
      out[algo] ??= toHex(fromBase64(match[2]!));
    } catch {
      // Not base64: ignore.
    }
  }
  return out;
}

export function integrityFromHex(algo: HashName, hex: string): string {
  return `${algo}-${toBase64(fromHex(hex))}`;
}

// ---------------------------------------------------------------------------
// Tarball names

/** The registry's canonical tarball file name: `pkg-1.0.0.tgz` (scope dropped). */
export function tarballFilename(name: string, version: string): string {
  return `${baseName(name)}-${version}.tgz`;
}

/** The version encoded in a canonical tarball file name, or null. */
export function versionFromFilename(name: string, file: string): string | null {
  const prefix = `${baseName(name)}-`;
  if (!file.startsWith(prefix) || !file.endsWith(".tgz")) return null;
  const version = file.slice(prefix.length, -".tgz".length);
  return semver.valid(version) === version ? version : null;
}

/** Last path segment of a tarball URL, decoded. */
export function tarballUrlFilename(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    const last = path.slice(path.lastIndexOf("/") + 1);
    return last ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request paths

export type NpmRoute =
  | { kind: "ping" }
  | { kind: "whoami" }
  | { kind: "search" }
  | { kind: "webLogin" }
  | { kind: "webLoginDone"; id: string }
  | { kind: "couchUser"; user: string }
  | { kind: "distTags"; name: string; tag?: string }
  | { kind: "auditBulk" }
  | { kind: "auditQuick" }
  | { kind: "packument"; name: string }
  | { kind: "version"; name: string; spec: string }
  | { kind: "tarball"; name: string; file: string; rev?: string }
  | { kind: "rev"; name: string; rev: string }
  | { kind: "unknown" };

function decodeSegments(raw: string): string[] | null {
  const out: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "") continue;
    try {
      out.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  return out;
}

/** Splits `[name, ...rest]` off decoded segments, joining `@scope` + `pkg`. */
function takeName(segments: string[]): { name: string; rest: string[] } | null {
  const first = segments[0];
  if (!first) return null;
  if (first.startsWith("@")) {
    if (first.includes("/")) {
      // `@scope%2fpkg`, decoded.
      return first.split("/").length === 2 ? { name: first, rest: segments.slice(1) } : null;
    }
    const second = segments[1];
    if (!second || second.includes("/")) return null;
    return { name: `${first}/${second}`, rest: segments.slice(2) };
  }
  if (first.includes("/")) return null;
  return { name: first, rest: segments.slice(1) };
}

function packageRoute(segments: string[]): NpmRoute {
  const taken = takeName(segments);
  if (!taken || taken.rest.some((s) => s.includes("/"))) return { kind: "unknown" };
  const { name, rest } = taken;
  if (rest.length === 0) return { kind: "packument", name };
  if (rest.length === 1 && rest[0] !== "-" && rest[0] !== "-rev") {
    return { kind: "version", name, spec: rest[0]! };
  }
  if (rest[0] === "-rev" && rest.length === 2) return { kind: "rev", name, rev: rest[1]! };
  if (rest[0] === "-" && rest.length === 2) return { kind: "tarball", name, file: rest[1]! };
  if (rest[0] === "-" && rest.length === 4 && rest[2] === "-rev") {
    return { kind: "tarball", name, file: rest[1]!, rev: rest[3]! };
  }
  return { kind: "unknown" };
}

/**
 * Classifies a request path below `/npm/<repo>/` (raw, still percent-encoded).
 */
export function parseNpmPath(raw: string): NpmRoute {
  const segments = decodeSegments(raw);
  if (!segments || segments.length === 0) return { kind: "unknown" };
  if (segments[0] !== "-") {
    const route = packageRoute(segments);
    // `npm unpublish` builds the tarball DELETE from the tarball URL's path,
    // which already carries `npm/<repo>/`; npm-registry-fetch prefixes the
    // registry again.
    if (
      route.kind === "unknown" &&
      segments[0] === "npm" &&
      segments.length > 4 &&
      segments[1] !== "-" &&
      segments[1] !== "-rev"
    ) {
      const inner = packageRoute(segments.slice(2));
      if (inner.kind === "tarball" && inner.rev !== undefined) return inner;
    }
    return route;
  }
  const rest = segments.slice(1);
  const path = rest.join("/");
  if (path === "ping") return { kind: "ping" };
  if (path === "whoami") return { kind: "whoami" };
  if (path === "v1/search") return { kind: "search" };
  if (path === "v1/login") return { kind: "webLogin" };
  if (rest[0] === "v1" && rest[1] === "done" && rest.length === 3) {
    return { kind: "webLoginDone", id: rest[2]! };
  }
  if (rest[0] === "user" && rest.length === 2 && rest[1]!.startsWith("org.couchdb.user:")) {
    return { kind: "couchUser", user: rest[1]!.slice("org.couchdb.user:".length) };
  }
  if (path === "npm/v1/security/advisories/bulk") return { kind: "auditBulk" };
  if (path === "npm/v1/security/audits/quick") return { kind: "auditQuick" };
  if (rest[0] === "package") {
    const taken = takeName(rest.slice(1));
    if (!taken || taken.rest[0] !== "dist-tags") return { kind: "unknown" };
    if (taken.rest.length === 1) return { kind: "distTags", name: taken.name };
    if (taken.rest.length === 2 && !taken.rest[1]!.includes("/")) {
      return { kind: "distTags", name: taken.name, tag: taken.rest[1]! };
    }
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Packuments

export interface Dist {
  tarball: string;
  shasum?: string;
  integrity?: string;
  fileCount?: number;
  unpackedSize?: number;
  [key: string]: unknown;
}

export interface VersionManifest {
  name: string;
  version: string;
  dist: Dist;
  deprecated?: string;
  [key: string]: unknown;
}

export interface Packument {
  _id?: string;
  _rev?: string;
  name: string;
  "dist-tags": Record<string, string>;
  versions: Record<string, VersionManifest>;
  time?: Record<string, string>;
  modified?: string;
  readme?: string;
  [key: string]: unknown;
}

/** Fields the abbreviated ("corgi") document keeps per version. */
export const ABBREVIATED_VERSION_FIELDS = [
  "name",
  "version",
  "deprecated",
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "bundleDependencies",
  "bundledDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "acceptDependencies",
  "bin",
  "directories",
  "dist",
  "engines",
  "cpu",
  "os",
  "libc",
  "_hasShrinkwrap",
  "hasInstallScript",
  "funding",
] as const;

/** Version manifest fields a client may not set: the registry owns them. */
const REGISTRY_OWNED = new Set(["_id", "_rev", "_npmUser", "dist", "readme", "readmeFilename"]);
/** Underscore fields clients send that are worth keeping. */
const KEPT_PRIVATE = new Set([
  "_hasShrinkwrap",
  "_npmVersion",
  "_nodeVersion",
  "_npmOperationalInternal",
]);

/** True if install would run scripts (npm computes this at publish). */
export function hasInstallScript(manifest: Record<string, unknown>): boolean {
  const scripts = manifest.scripts;
  if (!scripts || typeof scripts !== "object") return false;
  const s = scripts as Record<string, unknown>;
  return Boolean(s.preinstall || s.install || s.postinstall);
}

/**
 * The version manifest as stored: client-owned fields only (no readme, no
 * `_` internals, no client-supplied dist), plus `hasInstallScript`.
 */
export function sanitizeManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest)) {
    if (REGISTRY_OWNED.has(key)) continue;
    if (key.startsWith("_") && !KEPT_PRIVATE.has(key)) continue;
    out[key] = value;
  }
  if (hasInstallScript(manifest)) out.hasInstallScript = true;
  return out;
}

/** Package-level fields a full packument copies from the latest version. */
export const PACKAGE_FIELDS = [
  "description",
  "homepage",
  "keywords",
  "repository",
  "author",
  "bugs",
  "license",
  "contributors",
] as const;

export interface StoredVersion {
  version: string;
  /** Sanitized manifest; `dist.tarball` holds only the file name. */
  manifest: Record<string, unknown> & { dist: Dist };
  createdAt: string;
}

export interface PackumentInput {
  name: string;
  rev?: string;
  distTags: Record<string, string>;
  versions: StoredVersion[];
  created: string;
  modified: string;
  readme?: string;
  readmeFilename?: string;
  maintainers?: unknown[];
  /** Absolute tarball URL for a stored file name. */
  tarballUrl: (file: string) => string;
}

/** Builds the full packument (`application/json`). */
export function buildPackument(input: PackumentInput): Packument {
  const versions: Record<string, VersionManifest> = {};
  const time: Record<string, string> = { created: input.created, modified: input.modified };
  for (const v of sortVersions(input.versions.map((s) => s.version))) {
    const stored = input.versions.find((s) => s.version === v)!;
    const manifest = stored.manifest;
    versions[v] = {
      ...manifest,
      name: input.name,
      version: v,
      _id: `${input.name}@${v}`,
      dist: { ...manifest.dist, tarball: input.tarballUrl(manifest.dist.tarball) },
    } as VersionManifest;
    time[v] = stored.createdAt;
  }
  const latest = input.distTags.latest ?? highestVersion(Object.keys(versions));
  const latestManifest = latest ? versions[latest] : undefined;
  const doc: Packument = {
    _id: input.name,
    ...(input.rev ? { _rev: input.rev } : {}),
    name: input.name,
    "dist-tags": input.distTags,
    versions,
    time,
    maintainers: input.maintainers ?? [],
    readme: input.readme ?? "",
    ...(input.readmeFilename ? { readmeFilename: input.readmeFilename } : {}),
  };
  if (latestManifest) {
    for (const field of PACKAGE_FIELDS) {
      if (latestManifest[field] !== undefined) doc[field] = latestManifest[field];
    }
  }
  return doc;
}

/** The abbreviated install document (`application/vnd.npm.install-v1+json`). */
export function abbreviatePackument(doc: Packument): Packument {
  const versions: Record<string, VersionManifest> = {};
  for (const [v, manifest] of Object.entries(doc.versions ?? {})) {
    const out: Record<string, unknown> = {};
    for (const field of ABBREVIATED_VERSION_FIELDS) {
      if (manifest[field] !== undefined) out[field] = manifest[field];
    }
    if (out.hasInstallScript === undefined && hasInstallScript(manifest)) {
      out.hasInstallScript = true;
    }
    versions[v] = out as VersionManifest;
  }
  return {
    name: doc.name,
    modified: doc.time?.modified ?? doc.modified ?? new Date(0).toISOString(),
    "dist-tags": doc["dist-tags"] ?? {},
    versions,
  };
}

/** Rewrites every `dist.tarball` (in place) with `rewrite(manifest)`. */
export function rewriteTarballs(
  doc: Packument,
  rewrite: (manifest: VersionManifest) => string | null,
): Packument {
  for (const manifest of Object.values(doc.versions ?? {})) {
    if (!manifest?.dist) continue;
    const url = rewrite(manifest);
    if (url) manifest.dist = { ...manifest.dist, tarball: url };
  }
  return doc;
}

/** Merges packuments: the first document wins per version; dist-tags come from the first. */
export function mergePackuments(docs: Packument[]): Packument {
  const [first, ...rest] = docs;
  if (!first) throw new Error("nothing to merge");
  const merged: Packument = {
    ...first,
    versions: { ...first.versions },
    time: { ...first.time },
  };
  for (const doc of rest) {
    for (const [v, manifest] of Object.entries(doc.versions ?? {})) {
      if (merged.versions[v]) continue;
      merged.versions[v] = manifest;
      if (doc.time?.[v] && merged.time) merged.time[v] = doc.time[v]!;
    }
  }
  for (const [tag, version] of Object.entries(first["dist-tags"] ?? {})) {
    if (!merged.versions[version]) delete merged["dist-tags"][tag];
  }
  return merged;
}

/** Resolves a dist-tag, exact version or range against a packument. */
export function resolveSpec(doc: Packument, spec: string): string | null {
  const versions = Object.keys(doc.versions ?? {});
  const tagged = doc["dist-tags"]?.[spec];
  if (tagged && doc.versions[tagged]) return tagged;
  if (doc.versions?.[spec]) return spec;
  const clean = semver.valid(spec);
  if (clean && doc.versions[clean]) return clean;
  if (semver.validRange(spec) === null) return null;
  return semver.maxSatisfying(versions, spec);
}

/** Finds the version whose tarball URL ends in `file`. */
export function versionForFile(doc: Packument, file: string): VersionManifest | null {
  const guess = versionFromFilename(doc.name, file);
  const direct = guess ? doc.versions?.[guess] : undefined;
  if (direct?.dist?.tarball && tarballUrlFilename(direct.dist.tarball) === file) return direct;
  for (const manifest of Object.values(doc.versions ?? {})) {
    if (manifest?.dist?.tarball && tarballUrlFilename(manifest.dist.tarball) === file) {
      return manifest;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Search

export interface SearchEntry {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  date: string;
  links?: Record<string, string>;
  publisher?: { username: string; email?: string };
  maintainers?: { username: string; email?: string }[];
}

export interface SearchObject {
  package: SearchEntry & { scope: string };
  score: {
    final: number;
    detail: { quality: number; popularity: number; maintenance: number };
  };
  searchScore: number;
  flags?: Record<string, unknown>;
}

export interface SearchResponse {
  objects: SearchObject[];
  total: number;
  time: string;
}

/** Splits `text` into lowercase terms (npm qualifiers such as `keywords:` are matched loosely). */
export function searchTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[a-z]+:/, ""))
    .filter(Boolean);
}

/** A relevance score for `entry` against `terms`, or 0 if a term does not match. */
export function searchScore(
  entry: Pick<SearchEntry, "name" | "description" | "keywords">,
  terms: string[],
): number {
  if (terms.length === 0) return 1;
  const name = entry.name.toLowerCase();
  const description = (entry.description ?? "").toLowerCase();
  const keywords = (entry.keywords ?? []).map((k) => String(k).toLowerCase());
  let score = 0;
  for (const term of terms) {
    if (name === term || baseName(name) === term) score += 10;
    else if (name.includes(term)) score += 5;
    else if (keywords.includes(term)) score += 3;
    else if (description.includes(term) || keywords.some((k) => k.includes(term))) score += 1;
    else return 0;
  }
  return score;
}

export function searchObject(entry: SearchEntry, score: number): SearchObject {
  const scope = isScoped(entry.name) ? entry.name.slice(1, entry.name.indexOf("/")) : "unscoped";
  return {
    package: { ...entry, scope, links: entry.links ?? {} },
    score: { final: score, detail: { quality: 1, popularity: 1, maintenance: 1 } },
    searchScore: score,
  };
}

export function searchResponse(
  objects: SearchObject[],
  total: number,
  now = new Date(),
): SearchResponse {
  return { objects, total, time: now.toUTCString() };
}
