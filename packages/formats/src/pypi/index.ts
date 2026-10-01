/**
 * PyPI protocol logic: PEP 503 names, PEP 440 versions, wheel/sdist filenames
 * (PEP 427/625), core metadata (RFC 822 style), the Simple Repository API
 * renderers and parsers (PEP 503 HTML, PEP 691 JSON, PEP 592/658/700/714) and
 * a streaming multipart/form-data parser for the legacy upload API.
 */

// ---------------------------------------------------------------------------
// Names (PEP 503 / PEP 508)

const PROJECT_NAME = /^([A-Z0-9]|[A-Z0-9][A-Z0-9._-]*[A-Z0-9])$/i;

export function normalizeName(name: string): string {
  return name.replace(/[-_.]+/g, "-").toLowerCase();
}

export function isValidProjectName(name: string): boolean {
  return name.length <= 200 && PROJECT_NAME.test(name);
}

export function isNormalizedName(name: string): boolean {
  return normalizeName(name) === name;
}

// ---------------------------------------------------------------------------
// Versions (PEP 440)

export interface Pep440Version {
  epoch: number;
  release: number[];
  pre: ["a" | "b" | "rc", number] | null;
  post: number | null;
  dev: number | null;
  local: (string | number)[] | null;
}

const VERSION_PATTERN = new RegExp(
  "^\\s*v?" +
    "(?:(?<epoch>[0-9]+)!)?" +
    "(?<release>[0-9]+(?:\\.[0-9]+)*)" +
    "(?<pre>[-_.]?(?<pre_l>alpha|beta|preview|pre|rc|a|b|c)[-_.]?(?<pre_n>[0-9]+)?)?" +
    "(?<post>(?:-(?<post_n1>[0-9]+))|(?:[-_.]?(?<post_l>post|rev|r)[-_.]?(?<post_n2>[0-9]+)?))?" +
    "(?<dev>[-_.]?(?<dev_l>dev)[-_.]?(?<dev_n>[0-9]+)?)?" +
    "(?:\\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?" +
    "\\s*$",
  "i",
);

const PRE_LETTER: Record<string, "a" | "b" | "rc"> = {
  a: "a",
  alpha: "a",
  b: "b",
  beta: "b",
  c: "rc",
  rc: "rc",
  pre: "rc",
  preview: "rc",
};

export function parseVersion(input: string): Pep440Version | null {
  if (input.length > 128) return null;
  const match = VERSION_PATTERN.exec(input);
  if (!match?.groups) return null;
  const g = match.groups;
  const num = (value: string | undefined) => (value === undefined ? 0 : Number(value));
  return {
    epoch: num(g.epoch),
    release: g.release!.split(".").map(Number),
    pre: g.pre_l ? [PRE_LETTER[g.pre_l.toLowerCase()]!, num(g.pre_n)] : null,
    post: g.post ? num(g.post_n1 ?? g.post_n2) : null,
    dev: g.dev ? num(g.dev_n) : null,
    local: g.local
      ? g.local
          .toLowerCase()
          .split(/[-_.]/)
          .map((part) => (/^[0-9]+$/.test(part) ? Number(part) : part))
      : null,
  };
}

export function formatVersion(v: Pep440Version): string {
  let out = v.epoch ? `${v.epoch}!` : "";
  out += v.release.join(".");
  if (v.pre) out += `${v.pre[0]}${v.pre[1]}`;
  if (v.post !== null) out += `.post${v.post}`;
  if (v.dev !== null) out += `.dev${v.dev}`;
  if (v.local) out += `+${v.local.join(".")}`;
  return out;
}

/** The canonical form (`1.0.0-RC1` -> `1.0.0rc1`), or null if not PEP 440. */
export function normalizeVersion(input: string): string | null {
  const parsed = parseVersion(input);
  return parsed ? formatVersion(parsed) : null;
}

function compareNumbers(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRelease(a: number[], b: number[]): number {
  const trim = (r: number[]) => {
    let end = r.length;
    while (end > 1 && r[end - 1] === 0) end--;
    return r.slice(0, end);
  };
  const x = trim(a);
  const y = trim(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const c = compareNumbers(x[i] ?? 0, y[i] ?? 0);
    if (c) return c;
  }
  return 0;
}

const PRE_RANK = { a: 0, b: 1, rc: 2 } as const;

/** packaging's ordering: dev < pre < final < post, local versions after their public version. */
export function compareParsed(a: Pep440Version, b: Pep440Version): number {
  let c = compareNumbers(a.epoch, b.epoch) || compareRelease(a.release, b.release);
  if (c) return c;
  // Pre-release key: a bare .devN sorts before any pre-release of the same release.
  const preKey = (v: Pep440Version): [number, number] =>
    v.pre
      ? [PRE_RANK[v.pre[0]], v.pre[1]]
      : v.post === null && v.dev !== null
        ? [-Infinity, 0]
        : [Infinity, 0];
  const [pa, pn] = preKey(a);
  const [pb, pm] = preKey(b);
  c = compareNumbers(pa, pb) || compareNumbers(pn, pm);
  if (c) return c;
  c = compareNumbers(a.post ?? -Infinity, b.post ?? -Infinity);
  if (c) return c;
  c = compareNumbers(a.dev ?? Infinity, b.dev ?? Infinity);
  if (c) return c;
  if (!a.local || !b.local) return a.local ? 1 : b.local ? -1 : 0;
  for (let i = 0; i < Math.max(a.local.length, b.local.length); i++) {
    const x = a.local[i];
    const y = b.local[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") c = compareNumbers(x, y);
    else if (typeof x === "number") c = 1;
    else if (typeof y === "number") c = -1;
    else c = x < y ? -1 : x > y ? 1 : 0;
    if (c) return c;
  }
  return 0;
}

/** Orders version strings; unparseable ones sort first, by string. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (x && y) return compareParsed(x, y);
  if (x) return 1;
  if (y) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isPrerelease(version: string): boolean {
  const v = parseVersion(version);
  return !!v && (v.pre !== null || v.dev !== null);
}

// ---------------------------------------------------------------------------
// Filenames (PEP 427 wheels, PEP 625 sdists)

export type DistType = "bdist_wheel" | "sdist";

export interface DistFilename {
  filename: string;
  type: DistType;
  /** The distribution name as written in the filename. */
  name: string;
  version: string;
  buildTag?: string;
  pythonTag?: string;
  abiTag?: string;
  platformTag?: string;
}

const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+!-]*$/;
const SDIST_EXTENSIONS = [".tar.gz", ".zip"];

/** A filename safe to use as a single path segment, with a known extension. */
export function isSafeFilename(filename: string): boolean {
  return (
    filename.length <= 255 &&
    SAFE_FILENAME.test(filename) &&
    !filename.includes("..") &&
    (filename.endsWith(".whl") || SDIST_EXTENSIONS.some((ext) => filename.endsWith(ext)))
  );
}

export function parseWheelFilename(filename: string): DistFilename | null {
  if (!filename.endsWith(".whl") || !isSafeFilename(filename)) return null;
  const parts = filename.slice(0, -4).split("-");
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [name, version] = parts as [string, string];
  const buildTag = parts.length === 6 ? parts[2] : undefined;
  const [pythonTag, abiTag, platformTag] = parts.slice(-3) as [string, string, string];
  if (!isValidProjectName(name) || !parseVersion(version)) return null;
  if (buildTag !== undefined && !/^[0-9]/.test(buildTag)) return null;
  if (!pythonTag || !abiTag || !platformTag) return null;
  return {
    filename,
    type: "bdist_wheel",
    name,
    version,
    buildTag,
    pythonTag,
    abiTag,
    platformTag,
  };
}

/**
 * Parses `<name>-<version>.tar.gz|.zip`. Legacy sdists may have dashes in the
 * name, so with `project` given every split point is tried.
 */
export function parseSdistFilename(filename: string, project?: string): DistFilename | null {
  if (!isSafeFilename(filename)) return null;
  const ext = SDIST_EXTENSIONS.find((e) => filename.endsWith(e));
  if (!ext) return null;
  const stem = filename.slice(0, -ext.length);
  const splits: number[] = [];
  for (let i = stem.length - 1; i > 0; i--) if (stem[i] === "-") splits.push(i);
  for (const at of splits) {
    const name = stem.slice(0, at);
    const version = stem.slice(at + 1);
    if (!isValidProjectName(name) || !parseVersion(version)) continue;
    if (project && normalizeName(name) !== normalizeName(project)) continue;
    return { filename, type: "sdist", name, version };
  }
  return null;
}

export function parseDistFilename(filename: string, project?: string): DistFilename | null {
  return filename.endsWith(".whl")
    ? parseWheelFilename(filename)
    : parseSdistFilename(filename, project);
}

/**
 * Why `filename` cannot be an upload of `project` `version` as `filetype`, or
 * null when it matches.
 */
export function checkDistFilename(
  filename: string,
  project: string,
  version: string,
  filetype: string,
): string | null {
  if (!isSafeFilename(filename)) return `Invalid distribution filename ${filename}`;
  if (filetype !== "bdist_wheel" && filetype !== "sdist") {
    return `Unsupported filetype ${filetype}; only bdist_wheel and sdist are accepted`;
  }
  const parsed = parseDistFilename(filename, project);
  if (!parsed) return `Invalid ${filetype === "sdist" ? "sdist" : "wheel"} filename ${filename}`;
  if (parsed.type !== filetype) return `${filename} is not a ${filetype}`;
  if (normalizeName(parsed.name) !== normalizeName(project)) {
    return `Start filename for ${project} with ${normalizeName(project).replace(/-/g, "_")}`;
  }
  const want = parseVersion(version);
  const got = parseVersion(parsed.version);
  if (!want || !got || compareParsed(want, got) !== 0) {
    return `Version in filename ${filename} does not match ${version}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core metadata (METADATA / PKG-INFO)

export interface CoreMetadata {
  /** Header values by lower-cased field name; repeated fields keep every value. */
  fields: Record<string, string[]>;
  /** The message body (the long description in Metadata-Version >= 2.1). */
  body: string;
}

export function parseCoreMetadata(text: string): CoreMetadata {
  const fields: Record<string, string[]> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  let current: { key: string; value: string } | null = null;
  const flush = () => {
    if (!current) return;
    (fields[current.key] ??= []).push(current.value);
    current = null;
  };
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === "") {
      i++;
      break;
    }
    if (/^[ \t]/.test(line) && current) {
      // Continuation line; old Description fields use "       |" prefixes.
      (current as { value: string }).value += `\n${line.replace(/^( {7}\||[ \t]+)/, "")}`;
      continue;
    }
    flush();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    current = {
      key: line.slice(0, colon).trim().toLowerCase(),
      value: line.slice(colon + 1).trim(),
    };
  }
  flush();
  return { fields, body: lines.slice(i).join("\n") };
}

export function metadataField(meta: CoreMetadata, key: string): string | undefined {
  return meta.fields[key.toLowerCase()]?.[0];
}

// ---------------------------------------------------------------------------
// Simple Repository API

export const SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";
export const SIMPLE_HTML = "application/vnd.pypi.simple.v1+html";
export const TEXT_HTML = "text/html";
export const API_VERSION = "1.1";

export interface SimpleFile {
  filename: string;
  /** Absolute download URL, without a hash fragment. */
  url: string;
  hashes: Record<string, string>;
  requiresPython?: string | null;
  /** false, true (no reason) or the reason. */
  yanked?: boolean | string;
  /** PEP 658: true or the metadata file's hashes when a `.metadata` exists. */
  coreMetadata?: boolean | Record<string, string> | null;
  size?: number;
  uploadTime?: string | null;
}

export interface SimpleProject {
  name: string;
  files: SimpleFile[];
  /** PEP 700; derived from filenames when absent. */
  versions?: string[];
}

export interface Negotiated {
  format: "json" | "html";
  contentType: string;
}

/** PEP 691 content negotiation (with the optional `?format=` override). */
export function negotiateSimple(accept: string | null, format?: string | null): Negotiated {
  const supported: Record<string, Negotiated> = {
    [SIMPLE_JSON]: { format: "json", contentType: SIMPLE_JSON },
    "application/vnd.pypi.simple.latest+json": { format: "json", contentType: SIMPLE_JSON },
    [SIMPLE_HTML]: { format: "html", contentType: SIMPLE_HTML },
    "application/vnd.pypi.simple.latest+html": { format: "html", contentType: SIMPLE_HTML },
    [TEXT_HTML]: { format: "html", contentType: TEXT_HTML },
    "text/*": { format: "html", contentType: TEXT_HTML },
    "*/*": { format: "html", contentType: TEXT_HTML },
  };
  const fallback = supported[TEXT_HTML]!;
  if (format && supported[format]) return supported[format]!;
  if (!accept) return fallback;
  let best: { n: Negotiated; q: number; order: number } | null = null;
  accept.split(",").forEach((item, order) => {
    const [type, ...params] = item.split(";").map((s) => s.trim());
    const n = supported[type?.toLowerCase() ?? ""];
    if (!n) return;
    let q = 1;
    for (const param of params) {
      const [k, v] = param.split("=").map((s) => s.trim());
      if (k === "q" && v !== undefined) q = Number(v);
    }
    if (!Number.isFinite(q) || q <= 0) return;
    if (!best || q > best.q) best = { n, q, order };
  });
  return (best as { n: Negotiated } | null)?.n ?? fallback;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function preferredHash(hashes: Record<string, string>): [string, string] | null {
  for (const algo of ["sha256", "sha384", "sha512", "sha224", "sha1", "md5"]) {
    if (hashes[algo]) return [algo, hashes[algo]];
  }
  const first = Object.entries(hashes)[0];
  return first ?? null;
}

function metadataAttr(meta: SimpleFile["coreMetadata"]): string | null {
  if (!meta) return null;
  if (meta === true) return "true";
  const hash = preferredHash(meta);
  return hash ? `${hash[0]}=${hash[1]}` : "true";
}

function projectVersions(project: SimpleProject): string[] {
  if (project.versions) return [...project.versions].sort(compareVersions);
  const versions = new Set<string>();
  for (const file of project.files) {
    const parsed = parseDistFilename(file.filename, project.name);
    const normalized = parsed && normalizeVersion(parsed.version);
    if (normalized) versions.add(normalized);
  }
  return [...versions].sort(compareVersions);
}

/** PEP 700 timestamps: `yyyy-mm-ddThh:mm:ss.ffffffZ`. */
export function uploadTimeString(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(iso);
  if (!match) return iso;
  return `${match[1]}.${(match[2] ?? "").padEnd(6, "0").slice(0, 6)}Z`;
}

export function renderProjectHtml(project: SimpleProject): string {
  const name = escapeHtml(project.name);
  const links = project.files.map((file) => {
    const hash = preferredHash(file.hashes);
    const href = escapeHtml(hash ? `${file.url}#${hash[0]}=${hash[1]}` : file.url);
    let attrs = `href="${href}"`;
    if (file.requiresPython) attrs += ` data-requires-python="${escapeHtml(file.requiresPython)}"`;
    const meta = metadataAttr(file.coreMetadata);
    if (meta) {
      attrs += ` data-dist-info-metadata="${escapeHtml(meta)}" data-core-metadata="${escapeHtml(meta)}"`;
    }
    if (file.yanked) {
      attrs += ` data-yanked="${typeof file.yanked === "string" ? escapeHtml(file.yanked) : ""}"`;
    }
    return `    <a ${attrs}>${escapeHtml(file.filename)}</a><br />`;
  });
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="pypi:repository-version" content="${API_VERSION}">
    <title>Links for ${name}</title>
  </head>
  <body>
    <h1>Links for ${name}</h1>
${links.join("\n")}
  </body>
</html>
`;
}

export function renderProjectJson(project: SimpleProject): string {
  const complete = project.files.every((f) => typeof f.size === "number");
  const files = project.files.map((file) => {
    const out: Record<string, unknown> = {
      filename: file.filename,
      url: file.url,
      hashes: file.hashes,
    };
    if (file.requiresPython) out["requires-python"] = file.requiresPython;
    if (file.coreMetadata) {
      const value = file.coreMetadata === true ? true : file.coreMetadata;
      out["core-metadata"] = value;
      out["dist-info-metadata"] = value;
    }
    out.yanked = file.yanked ?? false;
    if (typeof file.size === "number") out.size = file.size;
    if (file.uploadTime) out["upload-time"] = uploadTimeString(file.uploadTime);
    return out;
  });
  const body: Record<string, unknown> = {
    meta: { "api-version": complete ? API_VERSION : "1.0" },
    name: normalizeName(project.name),
    files,
  };
  if (complete) body.versions = projectVersions(project);
  return JSON.stringify(body);
}

export function renderIndexHtml(names: string[]): string {
  const links = names.map((n) => {
    const normalized = normalizeName(n);
    return `    <a href="${escapeHtml(encodeURIComponent(normalized))}/">${escapeHtml(n)}</a><br />`;
  });
  return `<!DOCTYPE html>
<html>
  <head>
    <meta name="pypi:repository-version" content="${API_VERSION}">
    <title>Simple index</title>
  </head>
  <body>
${links.join("\n")}
  </body>
</html>
`;
}

export function renderIndexJson(names: string[]): string {
  return JSON.stringify({
    meta: { "api-version": API_VERSION },
    projects: names.map((name) => ({ name })),
  });
}

function unescapeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|#39);/gi, (_, entity: string) => {
    const e = entity.toLowerCase();
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e] ?? "";
  });
}

function splitFragment(url: string): { url: string; hashes: Record<string, string> } {
  const hash = url.indexOf("#");
  if (hash === -1) return { url, hashes: {} };
  const fragment = url.slice(hash + 1);
  const match = /^([a-z0-9]+)=([0-9a-f]+)$/i.exec(fragment);
  return {
    url: url.slice(0, hash),
    hashes: match ? { [match[1]!.toLowerCase()]: match[2]!.toLowerCase() } : {},
  };
}

function metadataValue(value: string | undefined): SimpleFile["coreMetadata"] {
  if (value === undefined) return null;
  const match = /^([a-z0-9]+)=([0-9a-f]+)$/i.exec(value.trim());
  if (match) return { [match[1]!.toLowerCase()]: match[2]!.toLowerCase() };
  return value.trim().toLowerCase() !== "false";
}

/**
 * Parses an upstream PEP 503 project page. URLs are resolved against
 * `pageUrl`; hash fragments become `hashes`.
 */
export function parseProjectHtml(html: string, pageUrl: string, name: string): SimpleProject {
  const files: SimpleFile[] = [];
  const anchor = /<a\s([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  const attribute =
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of html.matchAll(anchor)) {
    const attrs: Record<string, string> = {};
    for (const a of match[1]!.matchAll(attribute)) {
      attrs[a[1]!.toLowerCase()] = unescapeHtml(a[2] ?? a[3] ?? a[4] ?? "");
    }
    if (!attrs.href) continue;
    let absolute: string;
    try {
      absolute = new URL(attrs.href, pageUrl).toString();
    } catch {
      continue;
    }
    const { url, hashes } = splitFragment(absolute);
    const text = unescapeHtml(match[2]!.replace(/<[^>]*>/g, "")).trim();
    const filename = text || decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
    const file: SimpleFile = { filename, url, hashes };
    if (attrs["data-requires-python"]) file.requiresPython = attrs["data-requires-python"];
    if ("data-yanked" in attrs) file.yanked = attrs["data-yanked"] || true;
    const meta = metadataValue(attrs["data-core-metadata"] ?? attrs["data-dist-info-metadata"]);
    if (meta) file.coreMetadata = meta;
    files.push(file);
  }
  return { name, files };
}

function isHashes(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/** Parses an upstream PEP 691 JSON project page; relative URLs resolve against `pageUrl`. */
export function parseProjectJson(text: string, pageUrl: string): SimpleProject {
  const doc = JSON.parse(text) as {
    name?: unknown;
    files?: unknown;
    versions?: unknown;
  };
  if (typeof doc !== "object" || doc === null || !Array.isArray(doc.files)) {
    throw new Error("not a PEP 691 project page");
  }
  const files: SimpleFile[] = [];
  for (const raw of doc.files as Record<string, unknown>[]) {
    if (typeof raw?.filename !== "string" || typeof raw.url !== "string") continue;
    const { url } = splitFragment(new URL(raw.url, pageUrl).toString());
    const hashes = isHashes(raw.hashes)
      ? Object.fromEntries(Object.entries(raw.hashes).map(([k, v]) => [k.toLowerCase(), v]))
      : {};
    const file: SimpleFile = { filename: raw.filename, url, hashes };
    if (typeof raw["requires-python"] === "string") file.requiresPython = raw["requires-python"];
    if (raw.yanked === true || (typeof raw.yanked === "string" && raw.yanked !== "")) {
      file.yanked = raw.yanked;
    } else if (raw.yanked === "") file.yanked = true;
    const meta = raw["core-metadata"] ?? raw["dist-info-metadata"];
    if (meta === true || isHashes(meta)) file.coreMetadata = meta;
    if (typeof raw.size === "number") file.size = raw.size;
    if (typeof raw["upload-time"] === "string") file.uploadTime = raw["upload-time"];
    files.push(file);
  }
  const name = typeof doc.name === "string" ? doc.name : "";
  const versions =
    Array.isArray(doc.versions) && doc.versions.every((v) => typeof v === "string")
      ? (doc.versions as string[])
      : undefined;
  return { name, files, versions };
}

// ---------------------------------------------------------------------------
// Streaming multipart/form-data (RFC 7578)

export function multipartBoundary(contentType: string | null | undefined): string | null {
  if (!contentType || !/^multipart\/form-data\s*;/i.test(contentType.trim())) return null;
  const params = parseHeaderParams(contentType);
  const boundary = params.boundary;
  if (!boundary || boundary.length > 70 || /[\r\n]/.test(boundary)) return null;
  return boundary;
}

/** `type; a=b; c="d"` parameters, lower-cased names. */
export function parseHeaderParams(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /;\s*([^=;\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (const match of value.matchAll(re)) {
    const raw = match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : match[3]!.trim();
    out[match[1]!.toLowerCase()] = raw;
  }
  return out;
}

export class MultipartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultipartError";
  }
}

export interface MultipartPart {
  /** The form field name. */
  name: string;
  filename: string | null;
  contentType: string | null;
  headers: Record<string, string>;
  /** The part's bytes; the parser drains whatever the caller leaves unread. */
  body: ReadableStream<Uint8Array>;
  /** Reads the part as UTF-8 text, failing past `limit` bytes. */
  text(limit: number): Promise<string>;
}

export interface MultipartOptions {
  maxHeaderBytes?: number;
  maxParts?: number;
}

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0]!;
  const last = haystack.length - needle.length;
  for (
    let i = haystack.indexOf(first, from);
    i !== -1 && i <= last;
    i = haystack.indexOf(first, i + 1)
  ) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

const CRLF = new Uint8Array([13, 10]);
const HEADER_END = new Uint8Array([13, 10, 13, 10]);

/**
 * Streams the parts of a multipart/form-data body. Only one part is live at a
 * time and memory stays bounded by the chunk size plus the header cap, so a
 * file part can be piped straight into storage.
 */
export async function* parseMultipart(
  stream: ReadableStream<Uint8Array>,
  boundary: string,
  options: MultipartOptions = {},
): AsyncGenerator<MultipartPart> {
  const encoder = new TextEncoder();
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  const maxHeaderBytes = options.maxHeaderBytes ?? 16 * 1024;
  const maxParts = options.maxParts ?? 1000;
  const reader = stream.getReader();
  // A virtual CRLF lets the first boundary match the same delimiter as the rest.
  let buf: Uint8Array = CRLF;
  let eof = false;

  const more = async (): Promise<boolean> => {
    if (eof) return false;
    const { done, value } = await reader.read();
    if (done) {
      eof = true;
      return false;
    }
    buf = concat(buf, value);
    return true;
  };

  /** Moves past body bytes; emits them to `sink` and stops at the delimiter. */
  const scanBody = async (sink: ((chunk: Uint8Array) => void) | null): Promise<"more" | "end"> => {
    for (;;) {
      const at = indexOfBytes(buf, delimiter);
      if (at !== -1) {
        if (at > 0) sink?.(buf.slice(0, at));
        buf = buf.subarray(at);
        return "end";
      }
      const safe = buf.length - (delimiter.length - 1);
      if (safe > 0) {
        sink?.(buf.slice(0, safe));
        buf = buf.subarray(safe);
        if (sink) return "more";
      }
      if (!(await more())) throw new MultipartError("Unexpected end of multipart body");
    }
  };

  try {
    // Preamble: everything up to the first delimiter.
    while (indexOfBytes(buf, delimiter) === -1) {
      if (buf.length > delimiter.length) buf = buf.subarray(buf.length - delimiter.length);
      if (!(await more())) throw new MultipartError("Multipart boundary not found");
    }
    buf = buf.subarray(indexOfBytes(buf, delimiter));

    for (let count = 0; ; count++) {
      // At a delimiter: `--` closes, otherwise optional whitespace then CRLF.
      while (buf.length < delimiter.length + 2) {
        if (!(await more())) throw new MultipartError("Unexpected end of multipart body");
      }
      buf = buf.subarray(delimiter.length);
      if (buf[0] === 45 && buf[1] === 45) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      for (;;) {
        const crlf = indexOfBytes(buf, CRLF);
        if (crlf !== -1) {
          if (buf.subarray(0, crlf).some((b) => b !== 32 && b !== 9)) {
            throw new MultipartError("Malformed multipart boundary line");
          }
          buf = buf.subarray(crlf + 2);
          break;
        }
        if (buf.length > 256 || !(await more())) {
          throw new MultipartError("Malformed multipart boundary line");
        }
      }
      if (count >= maxParts) throw new MultipartError("Too many multipart parts");

      // Headers.
      let headerText = "";
      for (;;) {
        if (buf.length >= 2 && buf[0] === 13 && buf[1] === 10) {
          buf = buf.subarray(2);
          break;
        }
        const end = indexOfBytes(buf, HEADER_END);
        if (end !== -1) {
          headerText = new TextDecoder().decode(buf.subarray(0, end));
          buf = buf.subarray(end + 4);
          break;
        }
        if (buf.length > maxHeaderBytes) throw new MultipartError("Multipart headers too large");
        if (!(await more())) throw new MultipartError("Unexpected end of multipart headers");
      }
      const headers: Record<string, string> = {};
      for (const line of headerText.split("\r\n")) {
        const colon = line.indexOf(":");
        if (colon > 0)
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const disposition = headers["content-disposition"] ?? "";
      if (!/^form-data\b/i.test(disposition)) {
        throw new MultipartError("Multipart part without form-data disposition");
      }
      const params = parseHeaderParams(disposition);

      let finished = false;
      let failed: unknown = null;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (finished) return controller.close();
          try {
            let emitted = false;
            const result = await scanBody((chunk) => {
              emitted = true;
              controller.enqueue(chunk);
            });
            if (result === "end") {
              finished = true;
              controller.close();
            } else if (!emitted) {
              // Unreachable: "more" always follows an emitted chunk.
              controller.close();
            }
          } catch (error) {
            failed = error;
            controller.error(error);
          }
        },
      });
      const part: MultipartPart = {
        name: params.name ?? "",
        filename: params.filename ?? null,
        contentType: headers["content-type"] ?? null,
        headers,
        body,
        async text(limit: number) {
          const r = body.getReader();
          const chunks: Uint8Array[] = [];
          let size = 0;
          for (;;) {
            const { done, value } = await r.read();
            if (done) break;
            size += value.length;
            if (size > limit) {
              await r.cancel();
              throw new MultipartError(`Form field ${params.name ?? ""} is too large`);
            }
            chunks.push(value);
          }
          return new TextDecoder().decode(chunks.reduce(concat, new Uint8Array()));
        },
      };
      yield part;
      if (failed) throw failed;
      if (!finished) {
        await scanBody(null);
        finished = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
