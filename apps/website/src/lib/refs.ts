/** Encode each segment of a path for use in a URL, keeping the slashes. */
export function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function repoPath(owner: string, name: string, ...rest: string[]): string {
  const tail = rest.filter(Boolean).join("/");
  return `/${owner}/${name}${tail ? `/${tail}` : ""}`;
}

export function treeUrl(
  owner: string,
  name: string,
  ref: string,
  path = "",
  sourceId?: string,
): string {
  return sourceUrl(repoPath(owner, name, "tree", encodePath(ref), encodePath(path)), sourceId);
}

export function blobUrl(
  owner: string,
  name: string,
  ref: string,
  path: string,
  sourceId?: string,
): string {
  return sourceUrl(repoPath(owner, name, "blob", encodePath(ref), encodePath(path)), sourceId);
}

export function commitsUrl(
  owner: string,
  name: string,
  ref: string,
  path = "",
  sourceId?: string,
): string {
  return sourceUrl(repoPath(owner, name, "commits", encodePath(ref), encodePath(path)), sourceId);
}

/** Preserve source identity without changing path, timeline scope, or line anchors. */
export function sourceUrl(path: string, sourceId?: string | null): string {
  if (!sourceId) return path;
  const url = new URL(path, "https://gitmatrix.invalid");
  url.searchParams.set("source", sourceId);
  return `${url.pathname}${url.search}${url.hash}`;
}
