import { data } from "react-router";
import type {
  BlobResponse,
  CiRunList,
  CommitsResponse,
  GraphNodeDetail,
  HistoryPage,
  RepoDetail,
  TreeResponse,
} from "../../shared/api.ts";
import { api, ApiError } from "./api.ts";

// Every repository read goes through this cache, so a link that was hovered
// (and prefetched) opens instantly, and going back to a page doesn't refetch.
// Data addressed by a commit id never changes; anything addressed by a branch
// name is reused for a short while.

const FRESH_MS = 15_000;
const COMMIT_ID = /(?:^|[?&])(?:at|ref)=[0-9a-f]{40}(?:%2F|\/|&|$)/;

const cache = new Map<string, { at: number; promise: Promise<unknown> }>();

function cached<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit && (COMMIT_ID.test(path) || Date.now() - hit.at < FRESH_MS)) {
    return hit.promise as Promise<T>;
  }
  // Not tied to any one navigation's abort signal: a prefetch and the
  // navigation that follows it share this request.
  const promise = api<T>(path);
  cache.set(path, { at: Date.now(), promise });
  promise.catch(() => cache.delete(path));
  return promise;
}

const base = (owner: string, name: string) =>
  `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

export const repoData = {
  detail: (owner: string, name: string) => cached<RepoDetail>(base(owner, name)),
  /** `at` is the URL tail after /tree/: "<ref>/<path>", split by the server. */
  tree: (owner: string, name: string, at: string) =>
    cached<TreeResponse>(`${base(owner, name)}/tree?at=${encodeURIComponent(at)}`),
  blob: (owner: string, name: string, at: string) =>
    cached<BlobResponse>(`${base(owner, name)}/blob?at=${encodeURIComponent(at)}`),
  commits: (owner: string, name: string, at: string, page: number) =>
    cached<CommitsResponse>(
      `${base(owner, name)}/commits?at=${encodeURIComponent(at)}&page=${page}`,
    ),
  history: (owner: string, name: string, at: string, entries = false, cursor = "") =>
    cached<HistoryPage>(
      `${base(owner, name)}/history?at=${encodeURIComponent(at)}&entries=${entries}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  /** One knowledge-graph node with its neighbors ("repo", "file:<path>", ...). */
  graphNode: (owner: string, name: string, id: string) =>
    cached<GraphNodeDetail>(
      `${base(owner, name)}/knowledge/graph/node?id=${encodeURIComponent(id)}`,
    ),
  /** The latest CI runs, newest first (for side rails; the CI page polls its own). */
  ciRuns: (owner: string, name: string) => cached<CiRunList>(`${base(owner, name)}/ci`),
};

/** Drop everything cached for a repository (after changing it). */
export function forgetRepoData(owner: string, name: string) {
  const prefix = base(owner, name);
  for (const key of cache.keys()) {
    if (key === prefix || key.startsWith(`${prefix}/`)) cache.delete(key);
  }
}

/** Drop everything cached for every repository (a new session, or a test's new world). */
export function forgetAllRepoData() {
  cache.clear();
}

/** In loaders: turn API failures into route errors for the error boundary. */
export async function routeData<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof ApiError) throw data({ message: error.message }, { status: error.status });
    throw error;
  }
}

const APP_ROUTES = new Set(["signin", "new", "settings", "api"]);

/** Warm the cache for an in-app URL before it is clicked. */
export function prefetchRoute(to: string) {
  const url = new URL(to, window.location.origin);
  const [owner, name, view, ...rest] = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  if (!owner || !name || APP_ROUTES.has(owner)) return;
  const tail = rest.join("/");
  const ignore = () => {};
  repoData.detail(owner, name).catch(ignore);
  if (view === undefined) repoData.tree(owner, name, "").catch(ignore);
  else if (view === "tree") repoData.tree(owner, name, tail).catch(ignore);
  else if (view === "blob") repoData.blob(owner, name, tail).catch(ignore);
  else if (view === "commits") {
    repoData.history(owner, name, tail).catch(ignore);
  }
}
