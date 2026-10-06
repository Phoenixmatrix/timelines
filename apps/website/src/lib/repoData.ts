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
import { sourceUrl } from "./refs.ts";
import type { TimelineDetail } from "../../shared/timelines.ts";
import { scopeOf } from "./timelineScope.ts";

// Every repository read goes through this cache, so a link that was hovered
// (and prefetched) opens instantly, and going back to a page doesn't refetch.
// Data addressed by a commit id never changes; anything addressed by a branch
// name is reused for a short while.

const FRESH_MS = 15_000;
const COMMIT_ID = /(?:^|[?&])(?:at|ref)=[0-9a-f]{40}(?:%2F|\/|&|$)/;

const cache = new Map<string, { at: number; promise: Promise<unknown> }>();

function cached<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (
    hit &&
    ((!path.includes("source=") && COMMIT_ID.test(path)) || Date.now() - hit.at < FRESH_MS)
  ) {
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
  detail: (owner: string, name: string, source?: string | null, metadataOnly = false) =>
    cached<RepoDetail>(
      sourceUrl(`${base(owner, name)}${metadataOnly ? "?metadata=1" : ""}`, source),
    ),
  /** `at` is the URL tail after /tree/: "<ref>/<path>", split by the server. */
  tree: (owner: string, name: string, at: string, source?: string | null) =>
    cached<TreeResponse>(
      sourceUrl(`${base(owner, name)}/tree?at=${encodeURIComponent(at)}`, source),
    ),
  blob: (owner: string, name: string, at: string, source?: string | null) =>
    cached<BlobResponse>(
      sourceUrl(`${base(owner, name)}/blob?at=${encodeURIComponent(at)}`, source),
    ),
  commits: (owner: string, name: string, at: string, page: number, source?: string | null) =>
    cached<CommitsResponse>(
      sourceUrl(`${base(owner, name)}/commits?at=${encodeURIComponent(at)}&page=${page}`, source),
    ),
  history: (
    owner: string,
    name: string,
    at: string,
    entries = false,
    cursor = "",
    source?: string | null,
  ) =>
    cached<HistoryPage>(
      sourceUrl(
        `${base(owner, name)}/history?at=${encodeURIComponent(at)}&entries=${entries}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        source,
      ),
    ),
  /** One knowledge-graph node with its neighbors ("repo", "file:<path>", ...). */
  graphNode: (owner: string, name: string, id: string) =>
    cached<GraphNodeDetail>(
      `${base(owner, name)}/knowledge/graph/node?id=${encodeURIComponent(id)}`,
    ),
  /** The latest CI runs, newest first (for side rails; the CI page polls its own). */
  ciRuns: (owner: string, name: string, source?: string | null) =>
    cached<CiRunList>(sourceUrl(`${base(owner, name)}/ci`, source)),
};

/** Resolve timeline scope before object reads; an unmigrated active source must not show main. */
export async function requestSource(
  owner: string,
  name: string,
  request: Request,
): Promise<string | null> {
  const url = new URL(request.url);
  const explicit = url.searchParams.get("source");
  if (explicit) return explicit;
  const slug = scopeOf(url.search);
  if (!slug) return null;
  const detail = await routeData(
    cached<TimelineDetail>(
      `/tracker/${encodeURIComponent(owner)}/timelines/${encodeURIComponent(slug)}`,
    ),
  );
  let entry = detail.timeline.repos.find((repo) => repo.owner === owner && repo.name === name);
  if (!entry) {
    // Timeline labels are historical; canonical identity survives a rename.
    const canonical = await routeData(repoData.detail(owner, name, "canonical"));
    entry = detail.timeline.repos.find((repo) => repo.id === canonical.id);
  }
  if (!entry) return null;
  if (entry.source) return entry.source.sourceId;
  if (detail.timeline.status === "landed" || detail.timeline.status === "abandoned")
    return "canonical";
  throw data(
    { message: "This timeline requires source migration before its code can be browsed." },
    { status: 409 },
  );
}

/** Drop everything cached for a repository (after changing it). */
export function forgetRepoData(owner: string, name: string) {
  const prefix = base(owner, name);
  for (const key of cache.keys()) {
    if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}?`))
      cache.delete(key);
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
  const source = url.searchParams.get("source");
  repoData.detail(owner, name, source).catch(ignore);
  if (view === undefined) repoData.tree(owner, name, "", source).catch(ignore);
  else if (view === "tree") repoData.tree(owner, name, tail, source).catch(ignore);
  else if (view === "blob") repoData.blob(owner, name, tail, source).catch(ignore);
  else if (view === "commits") {
    repoData.history(owner, name, tail, false, "", source).catch(ignore);
  }
}
