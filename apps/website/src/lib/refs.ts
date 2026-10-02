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

export function commitsUrl(owner: string, name: string, ref: string, path = ""): string {
  return repoPath(owner, name, "commits", encodePath(ref), encodePath(path));
}
