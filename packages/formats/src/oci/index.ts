/**
 * OCI Distribution Spec v1.1 / Docker Registry HTTP API v2: names, tags,
 * digests, manifest parsing and validation, auth challenges, pagination and
 * the referrers index. IO-free.
 */

export const MEDIA_TYPES = {
  ociManifest: "application/vnd.oci.image.manifest.v1+json",
  ociIndex: "application/vnd.oci.image.index.v1+json",
  dockerManifest: "application/vnd.docker.distribution.manifest.v2+json",
  dockerManifestList: "application/vnd.docker.distribution.manifest.list.v2+json",
  dockerSchema1: "application/vnd.docker.distribution.manifest.v1+json",
  dockerSchema1Signed: "application/vnd.docker.distribution.manifest.v1+prettyjws",
  ociArtifactManifest: "application/vnd.oci.artifact.manifest.v1+json",
  ociEmpty: "application/vnd.oci.empty.v1+json",
} as const;

/** Every manifest media type this registry stores and serves. */
export const MANIFEST_MEDIA_TYPES: readonly string[] = [
  MEDIA_TYPES.ociManifest,
  MEDIA_TYPES.ociIndex,
  MEDIA_TYPES.dockerManifest,
  MEDIA_TYPES.dockerManifestList,
];

const INDEX_MEDIA_TYPES: readonly string[] = [MEDIA_TYPES.ociIndex, MEDIA_TYPES.dockerManifestList];

/** The `{}` blob OCI 1.1 artifacts use as an empty config. */
export const EMPTY_JSON_DIGEST =
  "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

/** Accept header for fetching any manifest from an upstream registry. */
export const MANIFEST_ACCEPT = [...MANIFEST_MEDIA_TYPES, "*/*;q=0.1"].join(", ");

export const MAX_NAME_LENGTH = 255;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;

const COMPONENT = "[a-z0-9]+(?:(?:\\.|_|__|-+)[a-z0-9]+)*";
const NAME_RE = new RegExp(`^${COMPONENT}(?:/${COMPONENT})*$`);
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/;
const DIGEST_RE = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

export function isValidName(name: string): boolean {
  return name.length <= MAX_NAME_LENGTH && NAME_RE.test(name);
}

export function isValidTag(tag: string): boolean {
  return TAG_RE.test(tag);
}

export type DigestCheck = "ok" | "invalid" | "unsupported";

/** Only sha256 is supported; other well-formed algorithms are "unsupported". */
export function checkDigest(value: string): DigestCheck {
  if (SHA256_RE.test(value)) return "ok";
  if (!DIGEST_RE.test(value)) return "invalid";
  return value.startsWith("sha256:") ? "invalid" : "unsupported";
}

/** Manifest references with a colon are digests; everything else is a tag. */
export function isDigestReference(reference: string): boolean {
  return reference.includes(":");
}

/** Strips parameters (`; charset=utf-8`) and lowercases a media type. */
export function normalizeMediaType(value: string | null | undefined): string {
  return (value ?? "").split(";")[0]!.trim().toLowerCase();
}

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  urls?: string[];
  annotations?: Record<string, string>;
  artifactType?: string;
  platform?: unknown;
}

export interface ParsedManifest {
  mediaType: string;
  kind: "image" | "index";
  config: Descriptor | null;
  layers: Descriptor[];
  manifests: Descriptor[];
  subject: Descriptor | null;
  /** `artifactType`, or for images the config media type (what referrers report). */
  artifactType: string | null;
  annotations: Record<string, string>;
}

export type ManifestErrorCode = "MANIFEST_INVALID" | "UNSUPPORTED" | "DIGEST_INVALID";

export class ManifestError extends Error {
  readonly code: ManifestErrorCode;
  constructor(code: ManifestErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "ManifestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown, where: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.values(value).some((v) => typeof v !== "string")) {
    throw new ManifestError("MANIFEST_INVALID", `${where} must map strings to strings`);
  }
  return value as Record<string, string>;
}

function descriptor(value: unknown, where: string): Descriptor {
  if (!isRecord(value)) throw new ManifestError("MANIFEST_INVALID", `${where} is not an object`);
  const { mediaType, digest, size, urls, annotations, artifactType, platform } = value;
  if (typeof mediaType !== "string" || mediaType === "") {
    throw new ManifestError("MANIFEST_INVALID", `${where}.mediaType is required`);
  }
  if (typeof digest !== "string") {
    throw new ManifestError("MANIFEST_INVALID", `${where}.digest is required`);
  }
  const check = checkDigest(digest);
  if (check === "unsupported") {
    throw new ManifestError("UNSUPPORTED", `${where}.digest uses an unsupported algorithm`);
  }
  if (check === "invalid") throw new ManifestError("DIGEST_INVALID", `${where}.digest is invalid`);
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new ManifestError("MANIFEST_INVALID", `${where}.size must be a non-negative integer`);
  }
  const out: Descriptor = { mediaType, digest, size };
  if (urls !== undefined) {
    if (!Array.isArray(urls) || urls.some((u) => typeof u !== "string")) {
      throw new ManifestError("MANIFEST_INVALID", `${where}.urls must be strings`);
    }
    out.urls = urls as string[];
  }
  if (annotations !== undefined) out.annotations = stringMap(annotations, `${where}.annotations`);
  if (artifactType !== undefined) {
    if (typeof artifactType !== "string") {
      throw new ManifestError("MANIFEST_INVALID", `${where}.artifactType must be a string`);
    }
    out.artifactType = artifactType;
  }
  if (platform !== undefined) out.platform = platform;
  return out;
}

function descriptors(value: unknown, where: string, required: boolean): Descriptor[] {
  if (value === undefined || value === null) {
    if (required) throw new ManifestError("MANIFEST_INVALID", `${where} is required`);
    return [];
  }
  if (!Array.isArray(value)) throw new ManifestError("MANIFEST_INVALID", `${where} must be a list`);
  return value.map((item, i) => descriptor(item, `${where}[${i}]`));
}

/**
 * Parses and validates a pushed manifest. The media type comes from the
 * document's `mediaType` or, when absent (allowed for OCI), the request's
 * Content-Type; when both are present they must agree.
 */
export function parseManifest(
  input: Uint8Array | string,
  contentType?: string | null,
): ParsedManifest {
  const text = typeof input === "string" ? input : new TextDecoder().decode(input);
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new ManifestError("MANIFEST_INVALID", "Manifest is not valid JSON");
  }
  if (!isRecord(doc)) throw new ManifestError("MANIFEST_INVALID", "Manifest must be an object");

  const header = normalizeMediaType(contentType);
  const declared = typeof doc.mediaType === "string" ? doc.mediaType : null;
  if (doc.mediaType !== undefined && declared === null) {
    throw new ManifestError("MANIFEST_INVALID", "mediaType must be a string");
  }
  const schema1 = [MEDIA_TYPES.dockerSchema1, MEDIA_TYPES.dockerSchema1Signed] as string[];
  if (doc.schemaVersion === 1 || schema1.includes(declared ?? header)) {
    throw new ManifestError("MANIFEST_INVALID", "Docker schema 1 manifests are not supported");
  }
  if (doc.schemaVersion !== 2) {
    throw new ManifestError("MANIFEST_INVALID", "schemaVersion must be 2");
  }
  // A generic Content-Type (application/json...) defers to the document.
  if (declared && header !== declared && MANIFEST_MEDIA_TYPES.includes(header)) {
    throw new ManifestError(
      "MANIFEST_INVALID",
      `Content-Type ${header} does not match mediaType ${declared}`,
    );
  }
  const mediaType = declared ?? (MANIFEST_MEDIA_TYPES.includes(header) ? header : null);
  if (!mediaType) {
    if (Array.isArray(doc.manifests)) return parseAs(doc, MEDIA_TYPES.ociIndex);
    if (isRecord(doc.config)) return parseAs(doc, MEDIA_TYPES.ociManifest);
    throw new ManifestError("MANIFEST_INVALID", "Manifest media type is missing");
  }
  if (mediaType === MEDIA_TYPES.ociArtifactManifest) {
    throw new ManifestError(
      "UNSUPPORTED",
      "The draft OCI artifact manifest was dropped from OCI 1.1; push an image manifest with artifactType",
    );
  }
  if (!MANIFEST_MEDIA_TYPES.includes(mediaType)) {
    throw new ManifestError("MANIFEST_INVALID", `Unsupported manifest media type ${mediaType}`);
  }
  return parseAs(doc, mediaType);
}

function parseAs(doc: Record<string, unknown>, mediaType: string): ParsedManifest {
  const annotations = stringMap(doc.annotations, "annotations");
  const subject =
    doc.subject === undefined || doc.subject === null ? null : descriptor(doc.subject, "subject");
  if (subject && mediaType.startsWith("application/vnd.docker.")) {
    throw new ManifestError("MANIFEST_INVALID", "Docker manifests cannot have a subject");
  }
  const artifactType = typeof doc.artifactType === "string" ? doc.artifactType : null;
  if (doc.artifactType !== undefined && artifactType === null) {
    throw new ManifestError("MANIFEST_INVALID", "artifactType must be a string");
  }

  if (INDEX_MEDIA_TYPES.includes(mediaType)) {
    if (doc.config !== undefined || doc.layers !== undefined) {
      throw new ManifestError("MANIFEST_INVALID", "An index cannot have config or layers");
    }
    return {
      mediaType,
      kind: "index",
      config: null,
      layers: [],
      manifests: descriptors(doc.manifests, "manifests", true),
      subject,
      artifactType,
      annotations,
    };
  }

  if (doc.manifests !== undefined) {
    throw new ManifestError("MANIFEST_INVALID", "An image manifest cannot list manifests");
  }
  const config = descriptor(doc.config, "config");
  const layers = descriptors(doc.layers, "layers", mediaType === MEDIA_TYPES.dockerManifest);
  if (artifactType === null && config.mediaType === MEDIA_TYPES.ociEmpty && layers.length > 0) {
    throw new ManifestError(
      "MANIFEST_INVALID",
      "artifactType is required when config is the empty descriptor",
    );
  }
  return {
    mediaType,
    kind: "image",
    config,
    layers,
    manifests: [],
    subject,
    artifactType: artifactType ?? config.mediaType,
    annotations,
  };
}

/** Foreign (non-distributable) layers live elsewhere and are never pushed. */
export function isForeignLayer(d: Descriptor): boolean {
  return (
    (d.urls?.length ?? 0) > 0 &&
    (d.mediaType.includes("foreign") || d.mediaType.includes("nondistributable"))
  );
}

/** Config and layers that must exist in the repository before the manifest is accepted. */
export function requiredBlobs(manifest: ParsedManifest): Descriptor[] {
  const all = manifest.config ? [manifest.config, ...manifest.layers] : manifest.layers;
  return all.filter((d) => !isForeignLayer(d));
}

/** Every digest the manifest points at (blobs and child manifests), deduplicated. */
export function referencedDigests(manifest: ParsedManifest): string[] {
  const all = [...requiredBlobs(manifest), ...manifest.manifests].map((d) => d.digest);
  return [...new Set(all)];
}

// --- Auth ------------------------------------------------------------------

export interface Challenge {
  scheme: string;
  params: Record<string, string>;
}

/**
 * Parses `WWW-Authenticate: Bearer realm="...",service="...",scope="a b"`.
 * Returns the first challenge; quoted values may contain commas.
 */
export function parseChallenge(header: string | null | undefined): Challenge | null {
  if (!header) return null;
  const match = /^\s*([A-Za-z][A-Za-z0-9._~+/-]*)\s*(.*)$/s.exec(header);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase();
  const rest = match[2]!;
  const params: Record<string, string> = {};
  const re = /\s*([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))\s*(?:,|$)/gy;
  let at = 0;
  while (at < rest.length) {
    re.lastIndex = at;
    const m = re.exec(rest);
    if (!m) break;
    const key = m[1]!.toLowerCase();
    if (!(key in params)) params[key] = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]!;
    at = re.lastIndex;
  }
  return { scheme, params };
}

export interface Scope {
  type: string;
  name: string;
  actions: string[];
}

/** `repository:<name>:pull,push`, `registry:catalog:*`. */
export function parseScope(value: string): Scope | null {
  const first = value.indexOf(":");
  const last = value.lastIndexOf(":");
  if (first <= 0 || last === first) return null;
  const type = value.slice(0, first).replace(/\(.*\)$/, "");
  const name = value.slice(first + 1, last);
  const actions = value
    .slice(last + 1)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
  if (!name || actions.length === 0) return null;
  return { type, name, actions };
}

export function formatScope(scope: Scope): string {
  return `${scope.type}:${scope.name}:${scope.actions.join(",")}`;
}

/** Docker Hub's official images live under `library/`. */
export function dockerHubName(upstreamHost: string, image: string): string {
  const hub = ["registry-1.docker.io", "docker.io", "index.docker.io", "registry.hub.docker.com"];
  return hub.includes(upstreamHost.toLowerCase()) && !image.includes("/")
    ? `library/${image}`
    : image;
}

// --- Uploads ---------------------------------------------------------------

/**
 * `Content-Range` on a chunk upload. The spec form is `<start>-<end>`; also
 * accepts the HTTP forms `bytes <start>-<end>/<total|*>` and `bytes=<start>-<end>`.
 */
export function parseContentRange(
  header: string | null | undefined,
): { start: number; end: number } | "invalid" | null {
  if (header === null || header === undefined || header.trim() === "") return null;
  const m = /^(?:bytes[ =])?\s*(\d+)-(\d+)(?:\/(?:\d+|\*))?$/.exec(header.trim());
  if (!m) return "invalid";
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return "invalid";
  return { start, end };
}

/** The `Range` header on upload responses: `0-<last byte>` (`0-0` when empty). */
export function uploadRange(offset: number): string {
  return `0-${Math.max(offset - 1, 0)}`;
}

// --- Pagination ------------------------------------------------------------

export interface PageParams {
  n: number | null;
  last: string | null;
}

export function parsePageParams(n: string | null | undefined, last: string | null | undefined) {
  let size: number | null = null;
  if (n !== null && n !== undefined && n !== "") {
    const parsed = Number(n);
    if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
    size = parsed;
  }
  return { n: size, last: last || null } satisfies PageParams;
}

/**
 * One page of a lexically sorted list: entries after `last`, at most `n`
 * (or `max` when `n` is absent or larger). `next` is set when more remain.
 */
export function paginate(
  sorted: readonly string[],
  params: PageParams,
  max = 1000,
): { page: string[]; next: string | null; limit: number } {
  const limit = Math.min(params.n ?? max, max);
  const after = params.last;
  const rest = after === null ? sorted : sorted.filter((item) => item > after);
  const page = rest.slice(0, limit);
  const next = rest.length > limit && page.length > 0 ? page[page.length - 1]! : null;
  return { page, next, limit };
}

export function nextLink(path: string, limit: number, last: string): string {
  return `<${path}?n=${limit}&last=${encodeURIComponent(last)}>; rel="next"`;
}

// --- Referrers -------------------------------------------------------------

export interface ReferrerDescriptor {
  mediaType: string;
  digest: string;
  size: number;
  artifactType?: string;
  annotations?: Record<string, string>;
}

export function referrersIndex(referrers: readonly ReferrerDescriptor[]) {
  return {
    schemaVersion: 2,
    mediaType: MEDIA_TYPES.ociIndex,
    manifests: referrers.map((r) => ({
      mediaType: r.mediaType,
      digest: r.digest,
      size: r.size,
      ...(r.artifactType ? { artifactType: r.artifactType } : {}),
      ...(r.annotations && Object.keys(r.annotations).length > 0
        ? { annotations: r.annotations }
        : {}),
    })),
  };
}
