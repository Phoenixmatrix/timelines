/**
 * Maven repository layout, version ordering and metadata. Pure functions: the
 * registry's maven module does the IO.
 *
 * Layout: `<groupId as path>/<artifactId>/<version>/<artifactId>-<version>[-<classifier>].<ext>`,
 * where a SNAPSHOT file's `<version>` may be timestamped (`1.0-20260101.120000-3`).
 */

export const CHECKSUM_ALGOS = ["md5", "sha1", "sha256", "sha512"] as const;
export type ChecksumAlgo = (typeof CHECKSUM_ALGOS)[number];

const HEX_LENGTH: Record<ChecksumAlgo, number> = { md5: 32, sha1: 40, sha256: 64, sha512: 128 };

export const METADATA_FILE = "maven-metadata.xml";

const GROUP_PART = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;
const ARTIFACT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const VERSION = /^[A-Za-z0-9_][A-Za-z0-9_.+~-]*$/;
const TIMESTAMPED = /^(\d{8}\.\d{6})-(\d+)$/;

export function validGroupId(groupId: string): boolean {
  return groupId.length <= 200 && groupId.split(".").every((part) => GROUP_PART.test(part));
}

export function validArtifactId(artifactId: string): boolean {
  return artifactId.length <= 200 && ARTIFACT_ID.test(artifactId) && !artifactId.includes("..");
}

export function validVersion(version: string): boolean {
  return version.length <= 128 && VERSION.test(version) && !version.includes("..");
}

export function isSnapshot(version: string): boolean {
  return version.endsWith("-SNAPSHOT") || version === "SNAPSHOT";
}

export function groupPath(groupId: string): string {
  return groupId.replaceAll(".", "/");
}

export interface ArtifactCoordinates {
  groupId: string;
  artifactId: string;
  /** The version directory: `1.0` or `1.0-SNAPSHOT`. */
  baseVersion: string;
  /** The version in the filename: `1.0`, `1.0-SNAPSHOT` or `1.0-20260101.120000-3`. */
  version: string;
  classifier: string | null;
  /** Everything after the version/classifier: `jar`, `tar.gz`, `jar.asc`. */
  extension: string;
  snapshot: boolean;
  /** Timestamped SNAPSHOT builds only. */
  timestamp: string | null;
  buildNumber: number | null;
  filename: string;
}

export type MavenPath =
  | { kind: "artifact"; path: string; coords: ArtifactCoordinates }
  /** `maven-metadata.xml` at `dir` (group, artifact or SNAPSHOT version level). */
  | { kind: "metadata"; path: string; dir: string }
  | { kind: "other"; path: string };

export interface ParsedMavenPath {
  /** The file the request is about, with any checksum suffix removed. */
  target: MavenPath;
  /** Set when the request is for a `.md5`/`.sha1`/`.sha256`/`.sha512` sidecar. */
  checksum: ChecksumAlgo | null;
}

/** Splits `-<classifier>.<ext>` (or `.<ext>`) after the version. */
function splitClassifier(rest: string): { classifier: string | null; extension: string } | null {
  if (rest.startsWith(".")) {
    const extension = rest.slice(1);
    return extension ? { classifier: null, extension } : null;
  }
  if (!rest.startsWith("-")) return null;
  const body = rest.slice(1);
  const parts = body.split(".");
  if (parts.length < 2) return null;
  // `jdk1.8.jar`: extension segments never start with a digit, so fold those
  // back into the classifier.
  let cut = 1;
  while (cut < parts.length - 1 && /^\d/.test(parts[cut]!)) cut++;
  const classifier = parts.slice(0, cut).join(".");
  const extension = parts.slice(cut).join(".");
  if (!classifier || !extension) return null;
  return { classifier, extension };
}

/** Parses a repository path (no leading slash). */
export function parseMavenPath(path: string): ParsedMavenPath {
  let checksum: ChecksumAlgo | null = null;
  let base = path;
  for (const algo of CHECKSUM_ALGOS) {
    if (path.endsWith(`.${algo}`)) {
      checksum = algo;
      base = path.slice(0, -(algo.length + 1));
      break;
    }
  }
  return { target: classify(base), checksum };
}

function classify(path: string): MavenPath {
  const segments = path.split("/");
  const filename = segments[segments.length - 1]!;
  if (filename === METADATA_FILE) {
    return segments.length >= 2
      ? { kind: "metadata", path, dir: segments.slice(0, -1).join("/") }
      : { kind: "other", path };
  }
  const coords = parseArtifactSegments(segments);
  return coords ? { kind: "artifact", path, coords } : { kind: "other", path };
}

function parseArtifactSegments(segments: string[]): ArtifactCoordinates | null {
  if (segments.length < 4) return null;
  const filename = segments[segments.length - 1]!;
  const baseVersion = segments[segments.length - 2]!;
  const artifactId = segments[segments.length - 3]!;
  const groupId = segments.slice(0, -3).join(".");
  if (!validGroupId(groupId) || !validArtifactId(artifactId) || !validVersion(baseVersion)) {
    return null;
  }
  const prefix = `${artifactId}-`;
  if (!filename.startsWith(prefix)) return null;
  const afterArtifact = filename.slice(prefix.length);
  const snapshot = isSnapshot(baseVersion);

  const attempt = (
    version: string,
    timestamp: string | null,
    buildNumber: number | null,
  ): ArtifactCoordinates | null => {
    if (!afterArtifact.startsWith(version)) return null;
    const split = splitClassifier(afterArtifact.slice(version.length));
    if (!split) return null;
    return {
      groupId,
      artifactId,
      baseVersion,
      version,
      ...split,
      snapshot,
      timestamp,
      buildNumber,
      filename,
    };
  };

  if (snapshot) {
    const stem = baseVersion.slice(0, -"SNAPSHOT".length);
    if (afterArtifact.startsWith(stem)) {
      const rest = afterArtifact.slice(stem.length);
      const match = /^(\d{8}\.\d{6})-(\d+)/.exec(rest);
      if (match) {
        const found = attempt(`${stem}${match[0]}`, match[1]!, Number(match[2]));
        if (found) return found;
      }
    }
  }
  return attempt(baseVersion, null, null);
}

/** The path of an artifact file. */
export function artifactPath(
  coords: Pick<ArtifactCoordinates, "groupId" | "artifactId" | "baseVersion"> & {
    version?: string;
    classifier?: string | null;
    extension: string;
  },
): string {
  const version = coords.version ?? coords.baseVersion;
  const classifier = coords.classifier ? `-${coords.classifier}` : "";
  return `${groupPath(coords.groupId)}/${coords.artifactId}/${coords.baseVersion}/${coords.artifactId}-${version}${classifier}.${coords.extension}`;
}

/** `1.0-20260101.120000-3` -> timestamp and build number, or null. */
export function parseSnapshotBuild(
  baseVersion: string,
  version: string,
): { timestamp: string; buildNumber: number } | null {
  if (!isSnapshot(baseVersion)) return null;
  const stem = baseVersion.slice(0, -"SNAPSHOT".length);
  if (!version.startsWith(stem)) return null;
  const match = TIMESTAMPED.exec(version.slice(stem.length));
  return match ? { timestamp: match[1]!, buildNumber: Number(match[2]) } : null;
}

/**
 * The value of a `.md5`/`.sha1`/... sidecar. Accepts `<hex>`, `<hex>  file`,
 * `<hex> *file` and BSD `SHA1 (file) = <hex>`. Returns lowercase hex or null.
 */
export function parseChecksum(text: string, algo: ChecksumAlgo): string | null {
  const length = HEX_LENGTH[algo];
  const trimmed = text.trim();
  const bsd = /\)\s*=\s*([0-9a-fA-F]+)$/.exec(trimmed);
  const candidate = bsd ? bsd[1]! : (trimmed.split(/\s+/)[0] ?? "");
  if (candidate.length !== length || !/^[0-9a-fA-F]+$/.test(candidate)) return null;
  return candidate.toLowerCase();
}

// ---------------------------------------------------------------------------
// ComparableVersion (Maven's version ordering)
// ---------------------------------------------------------------------------

type Item = IntItem | StringItem | ListItem;

const QUALIFIERS = ["alpha", "beta", "milestone", "rc", "snapshot", "", "sp"];
const ALIASES: Record<string, string> = { ga: "", final: "", release: "", cr: "rc" };
const RELEASE_INDEX = String(QUALIFIERS.indexOf(""));

function comparableQualifier(qualifier: string): string {
  const index = QUALIFIERS.indexOf(qualifier);
  return index === -1 ? `${QUALIFIERS.length}-${qualifier}` : String(index);
}

function cmp<T>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

class IntItem {
  readonly type = "int";
  readonly value: bigint;
  constructor(value: bigint) {
    this.value = value;
  }
  isNull(): boolean {
    return this.value === 0n;
  }
  compareTo(item: Item | null): number {
    if (item === null) return this.value === 0n ? 0 : 1;
    if (item.type === "int") return cmp(this.value, item.value);
    return 1;
  }
}

class StringItem {
  readonly type = "string";
  readonly value: string;
  constructor(value: string, followedByDigit: boolean) {
    if (followedByDigit && value.length === 1) {
      value =
        value === "a" ? "alpha" : value === "b" ? "beta" : value === "m" ? "milestone" : value;
    }
    this.value = ALIASES[value] ?? value;
  }
  isNull(): boolean {
    return comparableQualifier(this.value) === RELEASE_INDEX;
  }
  compareTo(item: Item | null): number {
    if (item === null) return cmp(comparableQualifier(this.value), RELEASE_INDEX);
    if (item.type === "int" || item.type === "list") return -1;
    return cmp(comparableQualifier(this.value), comparableQualifier(item.value));
  }
}

class ListItem {
  readonly type = "list";
  readonly items: Item[] = [];
  isNull(): boolean {
    return this.items.length === 0;
  }
  normalize(): void {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const last = this.items[i]!;
      if (last.isNull()) this.items.splice(i, 1);
      else if (last.type !== "list") break;
    }
  }
  compareTo(item: Item | null): number {
    if (item === null) {
      if (this.items.length === 0) return 0;
      return this.items[0]!.compareTo(null);
    }
    if (item.type === "int") return -1;
    if (item.type === "string") return 1;
    const length = Math.max(this.items.length, item.items.length);
    for (let i = 0; i < length; i++) {
      const l = this.items[i] ?? null;
      const r = item.items[i] ?? null;
      const result = l === null ? (r === null ? 0 : -1 * r.compareTo(null)) : l.compareTo(r);
      if (result !== 0) return result;
    }
    return 0;
  }
}

function parseItem(isDigit: boolean, text: string): Item {
  return isDigit ? new IntItem(BigInt(text)) : new StringItem(text, false);
}

function isDigitChar(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function parseComparable(raw: string): ListItem {
  const version = raw.toLowerCase();
  const root = new ListItem();
  let list = root;
  const stack: ListItem[] = [root];
  const push = () => {
    const next = new ListItem();
    list.items.push(next);
    list = next;
    stack.push(next);
  };
  let isDigit = false;
  let start = 0;
  for (let i = 0; i < version.length; i++) {
    const ch = version[i]!;
    if (ch === ".") {
      list.items.push(i === start ? new IntItem(0n) : parseItem(isDigit, version.slice(start, i)));
      start = i + 1;
    } else if (ch === "-") {
      list.items.push(i === start ? new IntItem(0n) : parseItem(isDigit, version.slice(start, i)));
      start = i + 1;
      push();
    } else if (isDigitChar(ch)) {
      if (!isDigit && i > start) {
        // 1.0.0.X1 < 1.0.0-X2: treat .X as -X for any string qualifier X
        if (list.items.length > 0) push();
        list.items.push(new StringItem(version.slice(start, i), true));
        start = i;
        push();
      }
      isDigit = true;
    } else {
      if (isDigit && i > start) {
        list.items.push(parseItem(true, version.slice(start, i)));
        start = i;
        push();
      }
      isDigit = false;
    }
  }
  if (version.length > start) {
    if (!isDigit && list.items.length > 0) push();
    list.items.push(parseItem(isDigit, version.slice(start)));
  }
  while (stack.length > 0) stack.pop()!.normalize();
  return root;
}

/** Maven ComparableVersion ordering: negative if a < b. */
export function compareMavenVersions(a: string, b: string): number {
  return parseComparable(a).compareTo(parseComparable(b));
}

export function sortMavenVersions(versions: Iterable<string>): string[] {
  const parsed = [...new Set(versions)].map((v) => ({ v, item: parseComparable(v) }));
  parsed.sort((x, y) => x.item.compareTo(y.item) || cmp(x.v, y.v));
  return parsed.map((p) => p.v);
}

// ---------------------------------------------------------------------------
// maven-metadata.xml
// ---------------------------------------------------------------------------

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) =>
    ch === "&"
      ? "&amp;"
      : ch === "<"
        ? "&lt;"
        : ch === ">"
          ? "&gt;"
          : ch === '"'
            ? "&quot;"
            : "&apos;",
  );
}

function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return String.fromCodePoint(
          entity.startsWith("#x")
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10),
        );
    }
  });
}

export interface SnapshotVersionEntry {
  classifier: string | null;
  extension: string;
  value: string;
  /** yyyyMMddHHmmss */
  updated: string;
}

export interface PluginEntry {
  name?: string;
  prefix: string;
  artifactId: string;
}

/** Everything a `maven-metadata.xml` can say; group, artifact and SNAPSHOT levels. */
export interface MavenMetadata {
  groupId?: string;
  artifactId?: string;
  version?: string;
  versioning?: {
    latest?: string;
    release?: string;
    versions?: string[];
    snapshot?: { timestamp?: string; buildNumber?: number; localCopy?: boolean };
    snapshotVersions?: SnapshotVersionEntry[];
    /** yyyyMMddHHmmss */
    lastUpdated?: string;
  };
  plugins?: PluginEntry[];
}

/** `yyyyMMddHHmmss` in UTC. */
export function lastUpdatedStamp(date: Date | string): string {
  const iso = (typeof date === "string" ? new Date(date) : date).toISOString();
  return iso.slice(0, 19).replace(/[-:T]/g, "");
}

/** `yyyyMMdd.HHmmss` in UTC (a SNAPSHOT build timestamp). */
export function snapshotTimestamp(date: Date | string): string {
  const stamp = lastUpdatedStamp(date);
  return `${stamp.slice(0, 8)}.${stamp.slice(8)}`;
}

export function writeMetadataXml(meta: MavenMetadata): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const isSnapshotLevel = meta.versioning?.snapshotVersions !== undefined;
  lines.push(isSnapshotLevel ? '<metadata modelVersion="1.1.0">' : "<metadata>");
  const el = (indent: number, name: string, value: string | number | undefined) => {
    if (value !== undefined && value !== "")
      lines.push(`${"  ".repeat(indent)}<${name}>${escapeXml(String(value))}</${name}>`);
  };
  el(1, "groupId", meta.groupId);
  el(1, "artifactId", meta.artifactId);
  el(1, "version", meta.version);
  const v = meta.versioning;
  if (v) {
    lines.push("  <versioning>");
    el(2, "latest", v.latest);
    el(2, "release", v.release);
    if (v.snapshot) {
      lines.push("    <snapshot>");
      el(3, "timestamp", v.snapshot.timestamp);
      el(3, "buildNumber", v.snapshot.buildNumber);
      if (v.snapshot.localCopy) el(3, "localCopy", "true");
      lines.push("    </snapshot>");
    }
    if (v.versions && v.versions.length > 0) {
      lines.push("    <versions>");
      for (const version of v.versions) el(3, "version", version);
      lines.push("    </versions>");
    }
    el(2, "lastUpdated", v.lastUpdated);
    if (v.snapshotVersions && v.snapshotVersions.length > 0) {
      lines.push("    <snapshotVersions>");
      for (const sv of v.snapshotVersions) {
        lines.push("      <snapshotVersion>");
        el(4, "classifier", sv.classifier ?? undefined);
        el(4, "extension", sv.extension);
        el(4, "value", sv.value);
        el(4, "updated", sv.updated);
        lines.push("      </snapshotVersion>");
      }
      lines.push("    </snapshotVersions>");
    }
    lines.push("  </versioning>");
  }
  if (meta.plugins && meta.plugins.length > 0) {
    lines.push("  <plugins>");
    for (const plugin of meta.plugins) {
      lines.push("    <plugin>");
      el(3, "name", plugin.name);
      el(3, "prefix", plugin.prefix);
      el(3, "artifactId", plugin.artifactId);
      lines.push("    </plugin>");
    }
    lines.push("  </plugins>");
  }
  lines.push("</metadata>", "");
  return lines.join("\n");
}

function stripComments(xml: string): string {
  return xml.replace(/<!--[\s\S]*?-->/g, "");
}

function firstTag(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? unescapeXml(match[1]!.trim()) : undefined;
}

function allTags(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  for (const match of xml.matchAll(re)) out.push(match[1]!);
  return out;
}

/** Tolerant reader for upstream `maven-metadata.xml` (only the fields merging needs). */
export function parseMetadataXml(xml: string): MavenMetadata {
  const doc = stripComments(xml);
  const meta: MavenMetadata = {};
  const versioningXml = allTags(doc, "versioning")[0];
  // Top-level fields: look outside <versioning> and <plugins>.
  const outer = doc
    .replace(/<versioning(?:\s[^>]*)?>[\s\S]*?<\/versioning>/g, "")
    .replace(/<plugins(?:\s[^>]*)?>[\s\S]*?<\/plugins>/g, "");
  meta.groupId = firstTag(outer, "groupId");
  meta.artifactId = firstTag(outer, "artifactId");
  meta.version = firstTag(outer, "version");
  if (versioningXml !== undefined) {
    const versionsXml = allTags(versioningXml, "versions")[0];
    const snapshotXml = allTags(versioningXml, "snapshot")[0];
    const svXml = allTags(versioningXml, "snapshotVersions")[0];
    const withoutLists = versioningXml
      .replace(/<versions>[\s\S]*?<\/versions>/g, "")
      .replace(/<snapshotVersions>[\s\S]*?<\/snapshotVersions>/g, "")
      .replace(/<snapshot>[\s\S]*?<\/snapshot>/g, "");
    meta.versioning = {
      latest: firstTag(withoutLists, "latest"),
      release: firstTag(withoutLists, "release"),
      lastUpdated: firstTag(withoutLists, "lastUpdated"),
      versions: versionsXml
        ? allTags(versionsXml, "version")
            .map((v) => unescapeXml(v.trim()))
            .filter(Boolean)
        : [],
    };
    if (snapshotXml !== undefined) {
      const build = firstTag(snapshotXml, "buildNumber");
      meta.versioning.snapshot = {
        timestamp: firstTag(snapshotXml, "timestamp"),
        buildNumber: build ? Number(build) : undefined,
        localCopy: firstTag(snapshotXml, "localCopy") === "true" || undefined,
      };
    }
    if (svXml !== undefined) {
      meta.versioning.snapshotVersions = allTags(svXml, "snapshotVersion").map((sv) => ({
        classifier: firstTag(sv, "classifier") ?? null,
        extension: firstTag(sv, "extension") ?? "",
        value: firstTag(sv, "value") ?? "",
        updated: firstTag(sv, "updated") ?? "",
      }));
    }
  }
  const pluginsXml = allTags(doc, "plugins")[0];
  if (pluginsXml !== undefined) {
    meta.plugins = allTags(pluginsXml, "plugin").flatMap((p) => {
      const prefix = firstTag(p, "prefix");
      const artifactId = firstTag(p, "artifactId");
      return prefix && artifactId ? [{ name: firstTag(p, "name"), prefix, artifactId }] : [];
    });
  }
  return meta;
}

/** Artifact-level versioning from a set of versions. */
export function versioningFor(
  versions: Iterable<string>,
  lastUpdated: string,
): NonNullable<MavenMetadata["versioning"]> {
  const sorted = sortMavenVersions(versions);
  const releases = sorted.filter((v) => !isSnapshot(v));
  return {
    latest: sorted[sorted.length - 1],
    release: releases[releases.length - 1],
    versions: sorted,
    lastUpdated,
  };
}

/**
 * Unions artifact- and group-level metadata from several repositories (a
 * virtual repository): versions merge, latest/release are recomputed, and the
 * first repository to declare a plugin prefix keeps it.
 */
export function mergeMetadata(docs: MavenMetadata[]): MavenMetadata | null {
  if (docs.length === 0) return null;
  const out: MavenMetadata = {};
  const versions = new Set<string>();
  let lastUpdated = "";
  let hasVersioning = false;
  const plugins = new Map<string, PluginEntry>();
  for (const doc of docs) {
    out.groupId ??= doc.groupId;
    out.artifactId ??= doc.artifactId;
    if (doc.versioning) {
      hasVersioning = true;
      for (const v of doc.versioning.versions ?? []) versions.add(v);
      if (doc.versioning.latest) versions.add(doc.versioning.latest);
      if (doc.versioning.release) versions.add(doc.versioning.release);
      if ((doc.versioning.lastUpdated ?? "") > lastUpdated)
        lastUpdated = doc.versioning.lastUpdated!;
    }
    for (const plugin of doc.plugins ?? []) {
      if (!plugins.has(plugin.prefix)) plugins.set(plugin.prefix, plugin);
    }
  }
  if (hasVersioning && versions.size > 0) out.versioning = versioningFor(versions, lastUpdated);
  if (plugins.size > 0) out.plugins = [...plugins.values()];
  return out.versioning || out.plugins ? out : null;
}

// ---------------------------------------------------------------------------
// POM
// ---------------------------------------------------------------------------

export interface PomInfo {
  packaging: string;
  /** The maven-plugin-plugin `goalPrefix`, when set to a plain value. */
  goalPrefix: string | null;
  name: string | null;
}

/** The few POM fields the registry needs; tolerant of anything else. */
export function parsePom(xml: string): PomInfo {
  const doc = stripComments(xml);
  // Only look at <project>'s direct text for packaging/name: drop nested blocks
  // that can also contain <name>.
  const top = doc.replace(
    /<(parent|dependencies|dependencyManagement|build|profiles|reporting|developers|contributors|licenses|organization|scm|issueManagement|ciManagement|distributionManagement|mailingLists|repositories|pluginRepositories|modules|properties)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g,
    "",
  );
  const packaging = firstTag(top, "packaging") ?? "jar";
  const raw = firstTag(doc, "goalPrefix");
  const goalPrefix = raw && /^[A-Za-z0-9_.-]+$/.test(raw) ? raw : null;
  return { packaging, goalPrefix, name: firstTag(top, "name") ?? null };
}

/** maven-plugin-tools' rule: `maven-foo-plugin` and `foo-maven-plugin` are `foo`. */
export function pluginPrefix(artifactId: string): string {
  if (artifactId === "maven-plugin-plugin") return "plugin";
  return artifactId.replace(/-?maven-?/g, "").replace(/-?plugin-?/g, "");
}

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

const CONTENT_TYPES: Record<string, string> = {
  pom: "text/xml",
  xml: "text/xml",
  jar: "application/java-archive",
  war: "application/java-archive",
  ear: "application/java-archive",
  aar: "application/java-archive",
  module: "application/json",
  json: "application/json",
  asc: "text/plain",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
};

export function mavenContentType(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}
