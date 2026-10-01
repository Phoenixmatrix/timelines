/**
 * `/v2/...` routing. Repository names contain slashes, so routes are matched
 * from the end of the path (the same ambiguity distribution has).
 */
export type Route =
  | { kind: "base" }
  | { kind: "token" }
  | { kind: "catalog" }
  | { kind: "blob"; name: string; digest: string }
  | { kind: "uploads"; name: string; uuid: string | null }
  | { kind: "manifest"; name: string; reference: string }
  | { kind: "tags"; name: string }
  | { kind: "referrers"; name: string; digest: string };

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

const PATTERNS: [RegExp, (m: RegExpExecArray) => Route | null][] = [
  [/^(.+)\/blobs\/uploads\/?$/, (m) => ({ kind: "uploads", name: m[1]!, uuid: null })],
  [/^(.+)\/blobs\/uploads\/([^/]+)$/, (m) => ({ kind: "uploads", name: m[1]!, uuid: m[2]! })],
  [
    /^(.+)\/blobs\/([^/]+)$/,
    (m) => {
      const digest = decode(m[2]!);
      return digest === null ? null : { kind: "blob", name: m[1]!, digest };
    },
  ],
  [
    /^(.+)\/manifests\/([^/]+)$/,
    (m) => {
      const reference = decode(m[2]!);
      return reference === null ? null : { kind: "manifest", name: m[1]!, reference };
    },
  ],
  [/^(.+)\/tags\/list\/?$/, (m) => ({ kind: "tags", name: m[1]! })],
  [
    /^(.+)\/referrers\/([^/]+)$/,
    (m) => {
      const digest = decode(m[2]!);
      return digest === null ? null : { kind: "referrers", name: m[1]!, digest };
    },
  ],
];

/** Parses a request pathname (`/v2/...`). */
export function parseRoute(pathname: string): Route | null {
  if (!pathname.startsWith("/v2")) return null;
  const rest = pathname.slice(3).replace(/^\/+/, "");
  if (rest === "") return { kind: "base" };
  if (rest === "token" || rest === "token/") return { kind: "token" };
  if (rest === "_catalog" || rest === "_catalog/") return { kind: "catalog" };
  for (const [re, build] of PATTERNS) {
    const m = re.exec(rest);
    if (m) return build(m);
  }
  return null;
}
