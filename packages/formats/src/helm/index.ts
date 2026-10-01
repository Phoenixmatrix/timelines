import semver from "semver";
import { isScalar, parse, parseDocument, stringify } from "yaml";

import { findTarEntry, isGzip, readTarGz, tarPath } from "../archive/index.ts";

/**
 * Classic Helm chart repositories: Chart.yaml validation, index.yaml
 * building/merging, ChartMuseum upload parsing. Pure functions.
 */

export class ChartError extends Error {
  override readonly name = "ChartError";
}

/** The Chart.yaml fields a repository index carries. */
const CHART_FIELDS = [
  "apiVersion",
  "name",
  "version",
  "kubeVersion",
  "description",
  "type",
  "keywords",
  "home",
  "sources",
  "dependencies",
  "maintainers",
  "icon",
  "appVersion",
  "deprecated",
  "annotations",
] as const;

export interface ChartMetadata {
  apiVersion: string;
  name: string;
  version: string;
  kubeVersion?: string;
  description?: string;
  type?: string;
  keywords?: string[];
  home?: string;
  sources?: string[];
  dependencies?: unknown[];
  maintainers?: unknown[];
  icon?: string;
  appVersion?: string;
  deprecated?: boolean;
  annotations?: Record<string, string>;
}

export interface ChartVersion extends ChartMetadata {
  urls: string[];
  digest?: string;
  created?: string;
  [key: string]: unknown;
}

export interface HelmIndex {
  apiVersion: string;
  entries: Record<string, ChartVersion[]>;
  generated?: string;
}

const CHART_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

export function validChartName(name: string): boolean {
  return name.length <= 250 && CHART_NAME.test(name) && !name.includes("..");
}

/** Helm requires SemVer 2 chart versions (a leading `v` is tolerated). */
export function validChartVersion(version: string): boolean {
  return version.length <= 128 && semver.valid(version) !== null;
}

/** Validates a parsed Chart.yaml and keeps the fields an index entry carries. */
export function validateChart(doc: unknown): ChartMetadata {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    throw new ChartError("Chart.yaml is not a mapping");
  }
  const raw = doc as Record<string, unknown>;
  const apiVersion = raw.apiVersion === undefined ? "v1" : raw.apiVersion;
  if (apiVersion !== "v1" && apiVersion !== "v2") {
    throw new ChartError(`Unsupported chart apiVersion ${JSON.stringify(apiVersion)}`);
  }
  const name = typeof raw.name === "string" ? raw.name : "";
  if (!validChartName(name)) throw new ChartError(`Invalid chart name "${name}"`);
  const version =
    typeof raw.version === "string" || typeof raw.version === "number" ? String(raw.version) : "";
  if (!validChartVersion(version)) {
    throw new ChartError(`Chart version "${version}" is not valid SemVer 2`);
  }
  if (raw.type !== undefined && raw.type !== "application" && raw.type !== "library") {
    throw new ChartError(`Invalid chart type ${JSON.stringify(raw.type)}`);
  }
  const out: Record<string, unknown> = {};
  for (const field of CHART_FIELDS) {
    if (raw[field] !== undefined && raw[field] !== null) out[field] = raw[field];
  }
  out.apiVersion = apiVersion;
  out.name = name;
  out.version = version;
  if (typeof out.appVersion === "number") out.appVersion = String(out.appVersion);
  return out as unknown as ChartMetadata;
}

export function parseChartYaml(text: string): ChartMetadata {
  let doc: unknown;
  try {
    const parsed = parseDocument(text);
    if (parsed.errors.length > 0) throw parsed.errors[0];
    doc = parsed.toJS({ maxAliasCount: 50 });
    // Keep numeric-looking versions as written (`appVersion: 1.0` is "1.0").
    if (doc && typeof doc === "object") {
      for (const key of ["version", "appVersion"]) {
        const node = parsed.get(key, true);
        if (isScalar(node) && typeof node.value === "number" && typeof node.source === "string") {
          (doc as Record<string, unknown>)[key] = node.source;
        }
      }
    }
  } catch (error) {
    throw new ChartError(`Chart.yaml is not valid YAML: ${(error as Error).message}`);
  }
  return validateChart(doc);
}

/** Uncompressed size recorded in a gzip trailer (mod 2^32). */
function gzipSize(bytes: Uint8Array): number {
  const n = bytes.length;
  return (
    (bytes[n - 4]! | (bytes[n - 3]! << 8) | (bytes[n - 2]! << 16) | (bytes[n - 1]! << 24)) >>> 0
  );
}

/**
 * Reads `<chart>/Chart.yaml` from a packaged chart. The gzip trailer caps how
 * much fflate will inflate, so a chart that claims to be small cannot expand
 * past `maxUncompressed`.
 */
export function readChartArchive(
  tgz: Uint8Array,
  options: { maxUncompressed?: number } = {},
): ChartMetadata {
  const max = options.maxUncompressed ?? 64 * 1024 * 1024;
  if (!isGzip(tgz) || tgz.length < 18) throw new ChartError("A chart must be a gzipped tarball");
  if (gzipSize(tgz) > max) throw new ChartError(`Chart expands past ${max} bytes`);
  let entries;
  try {
    entries = readTarGz(tgz, { maxEntries: 10_000 });
  } catch (error) {
    throw new ChartError(`Chart archive is corrupt: ${(error as Error).message}`);
  }
  const chart = findTarEntry(entries, (path) => {
    const parts = path.split("/");
    return parts.length === 2 && parts[1] === "Chart.yaml";
  });
  if (!chart) throw new ChartError("No <chart>/Chart.yaml in the archive");
  if (chart.data.length !== chart.size) throw new ChartError("Chart archive is truncated");
  const meta = parseChartYaml(new TextDecoder().decode(chart.data));
  if (tarPath(chart.name).split("/")[0]!.startsWith(".")) throw new ChartError("Bad chart path");
  return meta;
}

export function chartFilename(name: string, version: string): string {
  return `${name}-${version}.tgz`;
}

/** `my-chart-1.2.3-rc.1.tgz` -> name and version (leftmost valid split). */
export function parseChartFilename(filename: string): { name: string; version: string } | null {
  if (!filename.endsWith(".tgz")) return null;
  const stem = filename.slice(0, -4);
  for (let i = stem.indexOf("-"); i !== -1; i = stem.indexOf("-", i + 1)) {
    const name = stem.slice(0, i);
    const version = stem.slice(i + 1);
    if (validChartName(name) && validChartVersion(version)) return { name, version };
  }
  return null;
}

/** Newest first; versions semver cannot parse sort last, by string. */
export function compareChartVersions(a: string, b: string): number {
  const va = semver.valid(a);
  const vb = semver.valid(b);
  if (va && vb) return semver.rcompare(va, vb) || (a < b ? -1 : a > b ? 1 : 0);
  if (va) return -1;
  if (vb) return 1;
  return a < b ? 1 : a > b ? -1 : 0;
}

function sortEntries(entries: Record<string, ChartVersion[]>): Record<string, ChartVersion[]> {
  const out: Record<string, ChartVersion[]> = {};
  for (const name of Object.keys(entries).sort()) {
    out[name] = [...entries[name]!].sort((a, b) =>
      compareChartVersions(String(a.version), String(b.version)),
    );
  }
  return out;
}

export function buildIndex(charts: ChartVersion[], generated: string): HelmIndex {
  const entries: Record<string, ChartVersion[]> = {};
  for (const chart of charts) (entries[chart.name] ??= []).push(chart);
  return { apiVersion: "v1", entries: sortEntries(entries), generated };
}

export function serializeIndex(index: HelmIndex): string {
  return stringify(
    { apiVersion: index.apiVersion, entries: index.entries, generated: index.generated },
    { lineWidth: 0 },
  );
}

/** Reads an index.yaml, dropping malformed entries rather than failing. */
export function parseIndex(text: string): HelmIndex {
  let doc: unknown;
  try {
    doc = parse(text, { maxAliasCount: 1000 });
  } catch (error) {
    throw new ChartError(`index.yaml is not valid YAML: ${(error as Error).message}`);
  }
  if (!doc || typeof doc !== "object") throw new ChartError("index.yaml is not a mapping");
  const raw = doc as Record<string, unknown>;
  const entries: Record<string, ChartVersion[]> = {};
  const rawEntries = raw.entries && typeof raw.entries === "object" ? raw.entries : {};
  for (const [name, list] of Object.entries(rawEntries as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const versions = list.filter(
      (v): v is ChartVersion =>
        !!v &&
        typeof v === "object" &&
        Array.isArray((v as ChartVersion).urls) &&
        (v as ChartVersion).version !== undefined,
    );
    for (const v of versions) {
      v.version = String(v.version);
      v.name ??= name;
    }
    if (versions.length > 0) entries[name] = versions;
  }
  return {
    apiVersion: typeof raw.apiVersion === "string" ? raw.apiVersion : "v1",
    entries,
    generated: typeof raw.generated === "string" ? raw.generated : undefined,
  };
}

/**
 * Merges indexes in priority order. A chart name belongs to the first index
 * that has it; with `mergeVersions`, later indexes add versions it lacks.
 */
export function mergeIndexes(
  indexes: HelmIndex[],
  options: { mergeVersions?: boolean; generated?: string } = {},
): HelmIndex {
  const entries: Record<string, ChartVersion[]> = {};
  let generated = options.generated ?? "";
  for (const index of indexes) {
    if (!options.generated && (index.generated ?? "") > generated) generated = index.generated!;
    for (const [name, versions] of Object.entries(index.entries)) {
      const current = entries[name];
      if (!current) {
        entries[name] = [...versions];
        continue;
      }
      if (!options.mergeVersions) continue;
      const seen = new Set(current.map((v) => v.version));
      for (const v of versions) if (!seen.has(v.version)) current.push(v);
    }
  }
  return { apiVersion: "v1", entries: sortEntries(entries), generated: generated || undefined };
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export interface MultipartPart {
  name: string;
  filename: string | null;
  contentType: string | null;
  data: Uint8Array;
}

export function multipartBoundary(contentType: string | null | undefined): string | null {
  if (!contentType || !/^multipart\/form-data/i.test(contentType)) return null;
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match ? (match[1] ?? match[2]!) : null;
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from: number): number {
  const first = needle[0]!;
  outer: for (let i = haystack.indexOf(first, from); i !== -1; i = haystack.indexOf(first, i + 1)) {
    if (i + needle.length > haystack.length) return -1;
    for (let j = 1; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

/** Parses a (size-capped) multipart/form-data body. */
export function parseMultipart(body: Uint8Array, boundary: string): MultipartPart[] {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const delimiter = encoder.encode(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let at = indexOf(body, delimiter, 0);
  if (at === -1) throw new ChartError("Malformed multipart body");
  for (;;) {
    at += delimiter.length;
    if (body[at] === 0x2d && body[at + 1] === 0x2d) break; // closing "--"
    if (body[at] === 0x0d && body[at + 1] === 0x0a) at += 2;
    const headerEnd = indexOf(body, encoder.encode("\r\n\r\n"), at);
    if (headerEnd === -1) throw new ChartError("Malformed multipart body");
    const headers = decoder.decode(body.subarray(at, headerEnd)).split("\r\n");
    const next = indexOf(body, encoder.encode(`\r\n--${boundary}`), headerEnd + 4);
    if (next === -1) throw new ChartError("Malformed multipart body");
    let name = "";
    let filename: string | null = null;
    let contentType: string | null = null;
    for (const line of headers) {
      const colon = line.indexOf(":");
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === "content-disposition") {
        name = /\bname="([^"]*)"/i.exec(value)?.[1] ?? "";
        filename = /\bfilename="([^"]*)"/i.exec(value)?.[1] ?? null;
      } else if (key === "content-type") contentType = value;
    }
    parts.push({ name, filename, contentType, data: body.subarray(headerEnd + 4, next) });
    at = next + 2;
  }
  return parts;
}

/** Chart name and version from a `.prov` file's signed Chart.yaml block. */
export function parseProvenance(text: string): { name: string; version: string } | null {
  const begin = text.indexOf("-----BEGIN PGP SIGNED MESSAGE-----");
  if (begin === -1) return null;
  const bodyStart = text.indexOf("\n\n", begin);
  if (bodyStart === -1) return null;
  const rest = text.slice(bodyStart + 2).replace(/\r\n/g, "\n");
  const end = rest.search(/^\.\.\.$/m);
  const chartYaml = end === -1 ? rest.split("\n---")[0]! : rest.slice(0, end);
  try {
    const meta = validateChart(parse(chartYaml));
    return { name: meta.name, version: meta.version };
  } catch {
    return null;
  }
}
