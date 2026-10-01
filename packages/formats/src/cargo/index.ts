/**
 * Cargo alternative-registry protocol: crate name rules, sparse index paths
 * and lines, the `cargo publish` body framing, and `dl` template expansion.
 * See https://doc.rust-lang.org/cargo/reference/registry-index.html and
 * https://doc.rust-lang.org/cargo/reference/registry-web-api.html.
 */

/** A client error with the message cargo will print (`{"errors":[{"detail"}]}`). */
export class CargoProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CargoProtocolError";
  }
}

// ---------------------------------------------------------------------------
// Names and versions

export const MAX_NAME_LENGTH = 64;

/** Names crates.io refuses: Windows device files and the standard library crates. */
const RESERVED_NAMES = new Set([
  "nul",
  "con",
  "prn",
  "aux",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
  "std",
  "core",
  "alloc",
  "proc-macro",
  "proc_macro",
  "test",
]);

/** Returns why `name` is not a valid crate name, or null when it is. */
export function crateNameError(name: string): string | null {
  if (!name) return "crate name cannot be empty";
  if (name.length > MAX_NAME_LENGTH)
    return `crate name is longer than ${MAX_NAME_LENGTH} characters`;
  if (!/^[A-Za-z]/.test(name)) return "crate names must start with an ASCII letter";
  if (!/^[A-Za-z0-9_-]+$/.test(name))
    return "crate names may only contain ASCII letters, digits, `-` and `_`";
  if (RESERVED_NAMES.has(name.toLowerCase())) return `\`${name}\` is a reserved crate name`;
  return null;
}

export function validCrateName(name: string): boolean {
  return crateNameError(name) === null;
}

/** Uniqueness key: case-insensitive, with `-` and `_` equivalent. */
export function normalizeCrateName(name: string): string {
  return name.toLowerCase().replace(/_/g, "-");
}

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  build: string;
}

export function parseSemver(version: string): SemVer | null {
  const m = SEMVER.exec(version);
  if (!m) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  return {
    major: nums[0]!,
    minor: nums[1]!,
    patch: nums[2]!,
    prerelease: m[4] ? m[4].split(".") : [],
    build: m[5] ?? "",
  };
}

export function validVersion(version: string): boolean {
  return version.length <= 128 && parseSemver(version) !== null;
}

/** The version without build metadata; crates.io treats `1.0.0+a` and `1.0.0+b` as one. */
export function versionIdentity(version: string): string {
  const plus = version.indexOf("+");
  return plus === -1 ? version : version.slice(0, plus);
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer 2.0 precedence; invalid versions sort before valid ones. */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return x ? 1 : y ? -1 : a.localeCompare(b);
  const core = x.major - y.major || x.minor - y.minor || x.patch - y.patch;
  if (core !== 0) return Math.sign(core);
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    if (x.prerelease.length === y.prerelease.length) return 0;
    return x.prerelease.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(x.prerelease.length, y.prerelease.length); i++) {
    const p = x.prerelease[i];
    const q = y.prerelease[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const c = compareIdentifiers(p, q);
    if (c !== 0) return Math.sign(c);
  }
  return 0;
}

/** Highest version, preferring releases over pre-releases. */
export function maxVersion(versions: string[]): string | null {
  const sorted = [...versions].sort(compareVersions);
  const stable = sorted.filter((v) => parseSemver(v)?.prerelease.length === 0);
  return stable.at(-1) ?? sorted.at(-1) ?? null;
}

// ---------------------------------------------------------------------------
// Sparse index layout

/** Index directory for a name: `1`, `2`, `3/a` or `ab/cd` (case preserved). */
export function cratePrefix(name: string): string {
  if (name.length <= 2) return String(name.length);
  if (name.length === 3) return `3/${name[0]}`;
  return `${name.slice(0, 2)}/${name.slice(2, 4)}`;
}

/** Path of a crate's index file, relative to the index root (always lowercase). */
export function indexPath(name: string): string {
  const lower = name.toLowerCase();
  return `${cratePrefix(lower)}/${lower}`;
}

/**
 * The crate name an index path addresses, or null if the path is not a
 * well-formed index file path (`config.json` is not an index file).
 */
export function nameFromIndexPath(path: string): string | null {
  const parts = path.split("/");
  const name = parts.at(-1);
  if (!name || name !== name.toLowerCase() || !validCrateName(name)) return null;
  return indexPath(name) === path ? name : null;
}

// ---------------------------------------------------------------------------
// Publish metadata and index lines

export type DependencyKind = "normal" | "dev" | "build";

export interface PublishDependency {
  name: string;
  version_req: string;
  features: string[];
  optional: boolean;
  default_features: boolean;
  target: string | null;
  kind: DependencyKind;
  registry: string | null;
  explicit_name_in_toml: string | null;
}

export interface PublishMetadata {
  name: string;
  vers: string;
  deps: PublishDependency[];
  features: Record<string, string[]>;
  authors: string[];
  description: string | null;
  documentation: string | null;
  homepage: string | null;
  readme: string | null;
  readme_file: string | null;
  keywords: string[];
  categories: string[];
  license: string | null;
  license_file: string | null;
  repository: string | null;
  links: string | null;
  rust_version: string | null;
}

export interface IndexDependency {
  name: string;
  req: string;
  features: string[];
  optional: boolean;
  default_features: boolean;
  target: string | null;
  kind: DependencyKind;
  registry?: string;
  package?: string;
}

export interface IndexLine {
  name: string;
  vers: string;
  deps: IndexDependency[];
  cksum: string;
  features: Record<string, string[]>;
  yanked: boolean;
  links: string | null;
  v?: number;
  features2?: Record<string, string[]>;
  rust_version?: string;
}

function str(value: unknown, field: string, max = 1024): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CargoProtocolError(`\`${field}\` must be a string`);
  if (value.length > max) throw new CargoProtocolError(`\`${field}\` is too long`);
  return value;
}

function strings(value: unknown, field: string, maxItems = 1000): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new CargoProtocolError(`\`${field}\` must be a list of strings`);
  }
  if (value.length > maxItems) throw new CargoProtocolError(`\`${field}\` has too many entries`);
  return value as string[];
}

function bool(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") throw new CargoProtocolError(`\`${field}\` must be a boolean`);
  return value;
}

function featureMap(value: unknown, field: string): Record<string, string[]> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new CargoProtocolError(`\`${field}\` must be a map of feature lists`);
  }
  const out: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_+.-]*$/.test(name) || name.length > 100) {
      throw new CargoProtocolError(`invalid feature name \`${name}\``);
    }
    out[name] = strings(list, `${field}.${name}`);
  }
  return out;
}

/** Validates the JSON part of a `cargo publish` request. */
export function parsePublishMetadata(raw: unknown): PublishMetadata {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CargoProtocolError("publish metadata must be a JSON object");
  }
  const r = raw as Record<string, unknown>;
  const name = str(r.name, "name", 200) ?? "";
  const nameError = crateNameError(name);
  if (nameError) throw new CargoProtocolError(`invalid crate name \`${name}\`: ${nameError}`);
  const vers = str(r.vers, "vers", 200) ?? "";
  if (!validVersion(vers)) throw new CargoProtocolError(`invalid semver version \`${vers}\``);

  if (r.deps !== undefined && r.deps !== null && !Array.isArray(r.deps)) {
    throw new CargoProtocolError("`deps` must be a list");
  }
  const deps = ((r.deps as unknown[] | undefined) ?? []).map((d, i): PublishDependency => {
    if (!d || typeof d !== "object") throw new CargoProtocolError(`deps[${i}] must be an object`);
    const dep = d as Record<string, unknown>;
    const depName = str(dep.name, `deps[${i}].name`, 200) ?? "";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(depName)) {
      throw new CargoProtocolError(`invalid dependency name \`${depName}\``);
    }
    const alias = str(dep.explicit_name_in_toml, `deps[${i}].explicit_name_in_toml`, 200);
    if (alias !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(alias)) {
      throw new CargoProtocolError(`invalid dependency rename \`${alias}\``);
    }
    const kind = str(dep.kind, `deps[${i}].kind`) ?? "normal";
    if (kind !== "normal" && kind !== "dev" && kind !== "build") {
      throw new CargoProtocolError(`invalid dependency kind \`${kind}\``);
    }
    return {
      name: depName,
      version_req: str(dep.version_req, `deps[${i}].version_req`) ?? "*",
      features: strings(dep.features, `deps[${i}].features`),
      optional: bool(dep.optional, false, `deps[${i}].optional`),
      default_features: bool(dep.default_features, true, `deps[${i}].default_features`),
      target: str(dep.target, `deps[${i}].target`),
      kind,
      registry: str(dep.registry, `deps[${i}].registry`),
      explicit_name_in_toml: alias,
    };
  });
  if (deps.length > 2000) throw new CargoProtocolError("too many dependencies");

  const links = str(r.links, "links", 200);
  return {
    name,
    vers,
    deps,
    features: featureMap(r.features, "features"),
    authors: strings(r.authors, "authors"),
    description: str(r.description, "description", 10_000),
    documentation: str(r.documentation, "documentation"),
    homepage: str(r.homepage, "homepage"),
    readme: str(r.readme, "readme", 512 * 1024),
    readme_file: str(r.readme_file, "readme_file"),
    keywords: strings(r.keywords, "keywords", 50),
    categories: strings(r.categories, "categories", 50),
    license: str(r.license, "license"),
    license_file: str(r.license_file, "license_file"),
    repository: str(r.repository, "repository"),
    links,
    rust_version: str(r.rust_version, "rust_version", 50),
  };
}

function usesNewFeatureSyntax(values: string[]): boolean {
  return values.some((v) => v.startsWith("dep:") || v.includes("?/"));
}

function stripIndexScheme(url: string): string {
  return url.replace(/^sparse\+/, "").replace(/\/+$/, "");
}

export interface IndexLineOptions {
  yanked?: boolean;
  /** Index URLs of the registry being published to: deps naming it are local. */
  ownIndexUrls?: string[];
}

/** The sparse index line for a published version. */
export function buildIndexLine(
  meta: PublishMetadata,
  cksum: string,
  options: IndexLineOptions = {},
): IndexLine {
  const own = new Set((options.ownIndexUrls ?? []).map(stripIndexScheme));
  const deps = meta.deps.map((dep): IndexDependency => {
    const out: IndexDependency = {
      name: dep.explicit_name_in_toml ?? dep.name,
      req: dep.version_req,
      features: dep.features,
      optional: dep.optional,
      default_features: dep.default_features,
      target: dep.target,
      kind: dep.kind,
    };
    if (dep.registry && !own.has(stripIndexScheme(dep.registry))) out.registry = dep.registry;
    if (dep.explicit_name_in_toml) out.package = dep.name;
    return out;
  });
  deps.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const features: Record<string, string[]> = {};
  const features2: Record<string, string[]> = {};
  for (const [name, values] of Object.entries(meta.features)) {
    if (usesNewFeatureSyntax(values)) features2[name] = values;
    else features[name] = values;
  }
  const line: IndexLine = {
    name: meta.name,
    vers: meta.vers,
    deps,
    cksum,
    features,
    yanked: options.yanked ?? false,
    links: meta.links,
  };
  if (Object.keys(features2).length > 0) {
    line.features2 = features2;
    line.v = 2;
  }
  if (meta.rust_version) line.rust_version = meta.rust_version;
  return line;
}

/** Newline-delimited JSON, one version per line, with a trailing newline. */
export function renderIndexFile(lines: IndexLine[]): string {
  return lines.map((line) => `${JSON.stringify(line)}\n`).join("");
}

/** Parses an index file, skipping lines that are not version objects. */
export function parseIndexFile(text: string): IndexLine[] {
  const out: IndexLine[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    try {
      const line = JSON.parse(trimmed) as IndexLine;
      if (line && typeof line.name === "string" && typeof line.vers === "string") out.push(line);
    } catch {
      // Cargo itself skips lines it cannot parse.
    }
  }
  return out;
}

/** Merges index files; the first file listing a version wins. */
export function mergeIndexFiles(texts: string[]): string {
  const seen = new Set<string>();
  const lines: IndexLine[] = [];
  for (const text of texts) {
    for (const line of parseIndexFile(text)) {
      const key = versionIdentity(line.vers);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
    }
  }
  return renderIndexFile(lines);
}

// ---------------------------------------------------------------------------
// config.json and the `dl` template

export interface IndexConfig {
  dl: string;
  api?: string;
  "auth-required"?: boolean;
}

const DL_MARKERS = ["{crate}", "{version}", "{prefix}", "{lowerprefix}", "{sha256-checksum}"];

/** A download URL from an index's `dl` template, as cargo computes it. */
export function expandDlTemplate(
  dl: string,
  crate: { name: string; version: string; cksum?: string },
): string {
  const template = DL_MARKERS.some((m) => dl.includes(m))
    ? dl
    : `${dl.replace(/\/+$/, "")}/{crate}/{version}/download`;
  return template
    .replaceAll("{crate}", crate.name)
    .replaceAll("{version}", crate.version)
    .replaceAll("{prefix}", cratePrefix(crate.name))
    .replaceAll("{lowerprefix}", cratePrefix(crate.name.toLowerCase()))
    .replaceAll("{sha256-checksum}", crate.cksum ?? "");
}

// ---------------------------------------------------------------------------
// Publish body framing: u32le json length, json, u32le crate length, crate

export interface PublishBody {
  metadata: unknown;
  crateLength: number;
  /** Exactly `crateLength` bytes; errors if the request is short or has trailing data. */
  crate: ReadableStream<Uint8Array>;
}

class ByteReader {
  private buffered: Uint8Array[] = [];
  private bufferedBytes = 0;

  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  /** Reads exactly `n` bytes into one array, or throws if the stream ends. */
  async exact(n: number, what: string): Promise<Uint8Array> {
    while (this.bufferedBytes < n) {
      const { done, value } = await this.reader.read();
      if (done) throw new CargoProtocolError(`publish request ended inside the ${what}`);
      if (value.length === 0) continue;
      this.buffered.push(value);
      this.bufferedBytes += value.length;
    }
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const head = this.buffered[0]!;
      const take = Math.min(head.length, n - at);
      out.set(head.subarray(0, take), at);
      at += take;
      if (take === head.length) this.buffered.shift();
      else this.buffered[0] = head.subarray(take);
    }
    this.bufferedBytes -= n;
    return out;
  }

  /** Streams exactly `n` further bytes without buffering them. */
  stream(n: number): ReadableStream<Uint8Array> {
    let remaining = n;
    const next = async (): Promise<Uint8Array | null> => {
      const head = this.buffered.shift();
      if (head) {
        this.bufferedBytes -= head.length;
        return head;
      }
      const { done, value } = await this.reader.read();
      return done ? null : value;
    };
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (remaining === 0) {
          for (;;) {
            const extra = await next();
            if (extra === null) break;
            if (extra.length > 0) {
              await this.reader.cancel().catch(() => undefined);
              throw new CargoProtocolError("publish request has data after the crate");
            }
          }
          controller.close();
          return;
        }
        let chunk: Uint8Array | null;
        do {
          chunk = await next();
          if (chunk === null) {
            throw new CargoProtocolError("publish request ended inside the crate");
          }
        } while (chunk.length === 0);
        if (chunk.length <= remaining) {
          remaining -= chunk.length;
          controller.enqueue(chunk);
          return;
        }
        controller.enqueue(chunk.subarray(0, remaining));
        this.buffered.unshift(chunk.subarray(remaining));
        this.bufferedBytes += chunk.length - remaining;
        remaining = 0;
      },
      cancel: async (reason) => {
        await this.reader.cancel(reason).catch(() => undefined);
      },
    });
  }
}

function u32le(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
}

/**
 * Splits a `PUT /api/v1/crates/new` body. Only the JSON part is buffered
 * (capped by `maxJsonBytes`); the crate is handed back as a stream.
 */
export async function readPublishBody(
  body: ReadableStream<Uint8Array>,
  options: { maxJsonBytes?: number; maxCrateBytes?: number } = {},
): Promise<PublishBody> {
  const maxJson = options.maxJsonBytes ?? 1024 * 1024;
  const reader = new ByteReader(body.getReader());
  const jsonLength = u32le(await reader.exact(4, "metadata length"));
  if (jsonLength > maxJson) {
    throw new CargoProtocolError(`publish metadata is larger than ${maxJson} bytes`);
  }
  const jsonBytes = await reader.exact(jsonLength, "metadata");
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(jsonBytes),
    );
  } catch {
    throw new CargoProtocolError("publish metadata is not valid JSON");
  }
  const crateLength = u32le(await reader.exact(4, "crate length"));
  if (options.maxCrateBytes !== undefined && crateLength > options.maxCrateBytes) {
    throw new CargoProtocolError(`crate is larger than ${options.maxCrateBytes} bytes`);
  }
  return { metadata, crateLength, crate: reader.stream(crateLength) };
}

/** Builds a publish body (for tests and tooling). */
export function encodePublishBody(metadata: unknown, crate: Uint8Array): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(metadata));
  const out = new Uint8Array(8 + json.length + crate.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, json.length, true);
  out.set(json, 4);
  view.setUint32(4 + json.length, crate.length, true);
  out.set(crate, 8 + json.length);
  return out;
}
