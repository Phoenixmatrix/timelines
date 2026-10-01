import type { RepoDetail } from "../../shared/api.ts";

/**
 * Split "/tree/<ref>/<path>" when the ref itself may contain slashes
 * ("jun/feature/src/index.js"): the longest known branch or tag that prefixes
 * the splat wins, then a full commit id, then the first segment.
 */
export function splitRefAndPath(
  splat: string,
  repo: Pick<RepoDetail, "branches" | "tags">,
): { ref: string; path: string } {
  const trimmed = splat.replace(/^\/+|\/+$/g, "");
  const names = [...repo.branches, ...repo.tags]
    .map((ref) => ref.shortName)
    .sort((a, b) => b.length - a.length);
  const known = names.find((name) => trimmed === name || trimmed.startsWith(`${name}/`));
  const ref = known ?? trimmed.split("/")[0] ?? "";
  return { ref, path: trimmed.slice(ref.length).replace(/^\/+/, "") };
}

/** Encode each segment of a path for use in a URL, keeping the slashes. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function repoPath(owner: string, name: string, ...rest: string[]): string {
  const tail = rest.filter(Boolean).join("/");
  return `/${owner}/${name}${tail ? `/${tail}` : ""}`;
}

export function treeUrl(owner: string, name: string, ref: string, path = ""): string {
  return repoPath(owner, name, "tree", encodePath(ref), encodePath(path));
}

export function blobUrl(owner: string, name: string, ref: string, path: string): string {
  return repoPath(owner, name, "blob", encodePath(ref), encodePath(path));
}

export function commitsUrl(owner: string, name: string, ref: string): string {
  return repoPath(owner, name, "commits", encodePath(ref));
}
