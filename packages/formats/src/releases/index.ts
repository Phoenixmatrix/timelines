/**
 * Software releases (GitHub-Releases style): name rules for projects, tags
 * and assets, "latest" selection, and SHA256SUMS rendering.
 */

export const PROJECT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/;
export const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

/** Path words the download routes use; a tag cannot take them. */
const RESERVED_TAGS = new Set(["latest"]);

export function validProjectName(name: string): boolean {
  return PROJECT_PATTERN.test(name) && !name.includes("..");
}

export function validTag(tag: string): boolean {
  return TAG_PATTERN.test(tag) && !RESERVED_TAGS.has(tag.toLowerCase());
}

/** Returns why `name` is not a safe asset filename, or null when it is. */
export function assetNameError(name: string): string | null {
  if (!name) return "Asset names cannot be empty";
  if (name.length > 255) return "Asset names are at most 255 characters";
  if (name === "." || name === "..") return "Invalid asset name";
  if (/[/\\]/.test(name)) return "Asset names cannot contain slashes";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "Asset names cannot contain control characters";
  if (name.trim() !== name) return "Asset names cannot start or end with whitespace";
  return null;
}

export function validAssetName(name: string): boolean {
  return assetNameError(name) === null;
}

interface ParsedVersion {
  core: number[];
  pre: string[];
}

function parseTagVersion(tag: string): ParsedVersion | null {
  const m = /^[vV]?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(tag);
  if (!m) return null;
  return { core: m[1]!.split(".").map(Number), pre: m[2] ? m[2].split(".") : [] };
}

/**
 * Orders tags by semantic version where both parse (`v1.10.0` > `v1.9.2`,
 * `1.0.0` > `1.0.0-rc.1`), else lexically.
 */
export function compareTags(a: string, b: string): number {
  const x = parseTagVersion(a);
  const y = parseTagVersion(b);
  if (!x || !y) {
    if (x || y) return x ? 1 : -1;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  if (x.pre.length === 0 || y.pre.length === 0) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    const d = pn && qn ? Number(p) - Number(q) : pn ? -1 : qn ? 1 : p < q ? -1 : p > q ? 1 : 0;
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export interface ReleaseLike {
  tag: string;
  draft: boolean;
  prerelease: boolean;
  publishedAt: string | null;
}

/**
 * The "latest" release: the newest published, non-draft, non-prerelease
 * release by publication time, with semver order breaking ties.
 */
export function selectLatest<T extends ReleaseLike>(releases: T[]): T | null {
  let best: T | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease || !release.publishedAt) continue;
    if (
      !best ||
      release.publishedAt > best.publishedAt! ||
      (release.publishedAt === best.publishedAt && compareTags(release.tag, best.tag) > 0)
    ) {
      best = release;
    }
  }
  return best;
}

/** `sha256sum`-compatible listing: `<hex>  <name>` per line, sorted by name. */
export function renderSha256Sums(assets: { name: string; sha256: string }[]): string {
  return [...assets]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((a) => `${a.sha256}  ${a.name}\n`)
    .join("");
}
