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

// Share concurrent reads only. Even immutable Git content must reauthorize on
// the next navigation after a Space grant or collaborator access is revoked.
const cache = new Map<string, Promise<unknown>>();

function cached<T>(path: string): Promise<T> {
  const hit = cache.get(path);
  if (hit) return hit as Promise<T>;
  const promise = api<T>(path);
  cache.set(path, promise);
  const release = () => {
    if (cache.get(path) === promise) cache.delete(path);
  };
  void promise.then(release, release);
  return promise;
}

const base = (space: string, name: string) =>
  `/repos/${encodeURIComponent(space)}/${encodeURIComponent(name)}`;

export const repoData = {
  detail: (space: string, name: string, source?: string | null, metadataOnly = false) =>
    cached<RepoDetail>(
      sourceUrl(`${base(space, name)}${metadataOnly ? "?metadata=1" : ""}`, source),
    ),
  /** `at` is the URL tail after /tree/: "<ref>/<path>", split by the server. */
  tree: (space: string, name: string, at: string, source?: string | null) =>
    cached<TreeResponse>(
      sourceUrl(`${base(space, name)}/tree?at=${encodeURIComponent(at)}`, source),
    ),
  blob: (space: string, name: string, at: string, source?: string | null) =>
    cached<BlobResponse>(
      sourceUrl(`${base(space, name)}/blob?at=${encodeURIComponent(at)}`, source),
    ),
  commits: (space: string, name: string, at: string, page: number, source?: string | null) =>
    cached<CommitsResponse>(
      sourceUrl(`${base(space, name)}/commits?at=${encodeURIComponent(at)}&page=${page}`, source),
    ),
  history: (
    space: string,
    name: string,
    at: string,
    entries = false,
    cursor = "",
    source?: string | null,
  ) =>
    cached<HistoryPage>(
      sourceUrl(
        `${base(space, name)}/history?at=${encodeURIComponent(at)}&entries=${entries}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        source,
      ),
    ),
  /** One knowledge-graph node with its neighbors ("repo", "file:<path>", ...). */
  graphNode: (space: string, name: string, id: string) =>
    cached<GraphNodeDetail>(
      `${base(space, name)}/knowledge/graph/node?id=${encodeURIComponent(id)}`,
    ),
  /** The latest CI runs, newest first (for side rails; the CI page polls its own). */
  ciRuns: (space: string, name: string, source?: string | null) =>
    cached<CiRunList>(sourceUrl(`${base(space, name)}/ci`, source)),
};

/** Resolve timeline scope before object reads; an unmigrated active source must not show main. */
export async function requestSource(
  space: string,
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
      `/tracker/${encodeURIComponent(space)}/timelines/${encodeURIComponent(slug)}`,
    ),
  );
  let entry = detail.timeline.repos.find((repo) => repo.space === space && repo.name === name);
  if (!entry) {
    // Timeline labels are historical; canonical identity survives a rename.
    const canonical = await routeData(repoData.detail(space, name, "canonical"));
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
export function forgetRepoData(space: string, name: string) {
  const prefix = base(space, name);
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

const APP_ROUTES: Record<string, true> = {
  accounts: true,
  organizations: true,
  instance: true,
  signin: true,
  new: true,
  settings: true,
  api: true,
  tracker: true,
  timelines: true,
  "release-notes": true,
  highlights: true,
  "needs-you": true,
  packages: true,
  "cli-auth": true,
  "-": true,
};

/** Warm the cache for an in-app URL before it is clicked. */
export function prefetchRoute(to: string) {
  const url = new URL(to, window.location.origin);
  const [space, name, view, ...rest] = url.pathname
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent);
  if (!space || !name || name === "-" || APP_ROUTES[space]) return;
  const tail = rest.join("/");
  const ignore = () => {};
  const source = url.searchParams.get("source");
  repoData.detail(space, name, source).catch(ignore);
  if (view === undefined) repoData.tree(space, name, "", source).catch(ignore);
  else if (view === "tree") repoData.tree(space, name, tail, source).catch(ignore);
  else if (view === "blob") repoData.blob(space, name, tail, source).catch(ignore);
  else if (view === "commits") {
    repoData.history(space, name, tail, false, "", source).catch(ignore);
  }
}
