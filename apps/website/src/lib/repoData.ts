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
import { accessEpoch, accessRefused, onAccessChange, sessionSettling } from "./session.ts";

// Every repository read goes through this cache, so a link that was hovered
// (and prefetched) opens instantly, and going back to a page doesn't refetch.
// Data addressed by a commit id never changes; anything addressed by a branch
// name, or read through a work source, is reused for a short while.
//
// What the cache holds is what this browser was allowed to read, so it never
// outlives that by more than FRESH_MS:
//
// - it is keyed by the request (Space, repository, source, ref or commit id,
//   path), and every entry belongs to the access epoch it was read in
//   (lib/session.ts): a sign-in, sign-out or account switch here or in another
//   tab, a session read that differs, or any 401 starts a new epoch and empties
//   it. A hit waits for a navigation's session read in flight, so loaders alongside
//   the read that notices a change don't serve the old identity's entries;
// - a repository's entries are dropped as soon as the repository is refused
//   (refusesRepository);
// - a commit-id read, which is kept for as long as it fits, is served only
//   while a read of its repository succeeded within FRESH_MS; otherwise the
//   repository's (cheap, itself cached) metadata read is made first, and its
//   refusal drops the repository's entries and fails the read. Removing a
//   collaborator or making a repository private doesn't change the session, so
//   this bounded window, not an immediate revocation, is the accepted
//   trade-off: a revoked reader can see commit-addressed data they had already
//   read for up to 15 s, never anything new.

const FRESH_MS = 15_000;
/** Bounds memory: the least recently used entries go first, by count and by size. */
const MAX_ENTRIES = 500;
let maxBytes = 32 * 2 ** 20;
const COMMIT_ID = /(?:^|[?&])(?:at|ref)=[0-9a-f]{40}(?:%2F|\/|&|$)/;
const REPO = /^\/repos\/[^/?]+\/[^/?]+/;

/**
 * Whether a failed read means the repository itself is refused, so nothing
 * cached for it may be served: a 403 from any read, or a 404 from the
 * repository's own detail (how the server answers a repository you can no
 * longer see). A 404 below it is just that thing missing: no knowledge graph
 * node (AI off), a dead link's path, an unknown branch or commit.
 */
function refusesRepository(status: number, path: string, repo: string): boolean {
  return status === 403 || (status === 404 && (path === repo || path.startsWith(`${repo}?`)));
}

interface Entry {
  /** When the request was made. */
  at: number;
  epoch: number;
  promise: Promise<unknown>;
  /** Approximate size once read (its JSON's length); 0 while in flight. */
  bytes: number;
}

const cache = new Map<string, Entry>();
let totalBytes = 0;
/** By repository (`/repos/<space>/<name>`): when a read of it last succeeded (as made). */
const authorizedAt = new Map<string, number>();

/** Immutable reads stay; work sources can be archived or expire, so their reads don't. */
const immutable = (path: string) => !path.includes("source=") && COMMIT_ID.test(path);

function drop(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  totalBytes -= entry.bytes;
  cache.delete(key);
}

/** Expired branch and source reads, and anything from another epoch, go. */
function purge(now: number): void {
  const current = accessEpoch();
  for (const [key, entry] of cache)
    if (entry.epoch !== current || (!immutable(key) && now - entry.at >= FRESH_MS)) drop(key);
}

/** The least recently used go until both bounds hold. */
function evict(): void {
  while (cache.size > MAX_ENTRIES || totalBytes > maxBytes) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    drop(oldest.value);
  }
}

/**
 * `waited`: this lookup already waited for a navigation's session read.
 * `reauthorized`: the repository's metadata read just succeeded for it, so
 * the entry is served without measuring the window again; a metadata read
 * slower than the window would otherwise be asked for forever. authorizedAt
 * stays the time that read was made (the server checked access no earlier),
 * so the window for later reads is never stretched by a slow response.
 */
function cached<T>(path: string, waited = false, reauthorized = false): Promise<T> {
  const now = Date.now();
  purge(now);
  const hit = cache.get(path);
  if (hit) {
    // A session read in flight may say the identity changed: the hit waits
    // for it, then looks again (it is gone if access changed).
    const settling = waited ? null : sessionSettling();
    if (settling) return settling.then(() => cached<T>(path, true));
    const repo = REPO.exec(path)?.[0];
    // The entry's own read authorizes it while it is in flight or recent.
    const authorized = Math.max(hit.at, authorizedAt.get(repo ?? "") ?? -Infinity);
    if (repo && immutable(path) && !reauthorized && now - authorized >= FRESH_MS) {
      // Not authorized lately: ask about the repository first (FRESH_MS above).
      const [space, name] = repo.split("/").slice(2).map(decodeURIComponent);
      return repoData.detail(space!, name!, null, true).then(() => cached<T>(path, true, true));
    }
    // Most recently used last.
    cache.delete(path);
    cache.set(path, hit);
    return hit.promise as Promise<T>;
  }
  // Not tied to any one navigation's abort signal: a prefetch and the
  // navigation that follows it share this request.
  const promise = api<T>(path);
  const entry: Entry = { at: now, epoch: accessEpoch(), promise, bytes: 0 };
  cache.set(path, entry);
  evict();
  const repo = REPO.exec(path)?.[0];
  promise.then(
    (value) => {
      if (entry.epoch !== accessEpoch()) return;
      if (repo && entry.at > (authorizedAt.get(repo) ?? -Infinity))
        authorizedAt.set(repo, entry.at);
      if (cache.get(path) !== entry) return;
      const bytes = sizeOf(value);
      // Larger than the whole budget: returned, never kept (keeping it would
      // evict everything else).
      if (bytes > maxBytes) return drop(path);
      entry.bytes = bytes;
      totalBytes += bytes;
      evict();
    },
    (error: unknown) => {
      if (cache.get(path) === entry) drop(path);
      if (!(error instanceof ApiError) || entry.epoch !== accessEpoch()) return;
      if (error.status === 401) accessRefused();
      else if (repo && refusesRepository(error.status, path, repo)) forgetPrefix(repo);
    },
  );
  return promise;
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

const base = (space: string, name: string) =>
  `/repos/${encodeURIComponent(space)}/${encodeURIComponent(name)}`;

export const repoData = {
  /**
   * Repository pages ask with `metadataOnly` (?metadata=1), as the layout does,
   * so a page load shares one request (CORE-444). It answers an expired work
   * source with its identity instead of failing: see requireLiveSource.
   */
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
    const canonical = await routeData(repoData.detail(space, name, "canonical", true));
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

function forgetPrefix(prefix: string) {
  authorizedAt.delete(prefix);
  for (const key of cache.keys()) {
    if (key === prefix || key.startsWith(`${prefix}/`) || key.startsWith(`${prefix}?`)) drop(key);
  }
}

/** Drop everything cached for a repository (after changing it). */
export function forgetRepoData(space: string, name: string) {
  forgetPrefix(base(space, name));
}

/**
 * After a timeline lands or ends: every timeline detail of `space`, and the
 * branch and source reads of the repositories in `spaces` (the timeline's
 * Space and those of its repositories). Commit-id reads stay true.
 */
export function forgetTimelineReads(space: string, spaces: Iterable<string> = []) {
  const timelines = `/tracker/${encodeURIComponent(space)}/timelines/`;
  const repos = [...new Set([space, ...spaces])].map(
    (slug) => `/repos/${encodeURIComponent(slug)}/`,
  );
  for (const key of cache.keys()) {
    if (key.startsWith(timelines) || (!immutable(key) && repos.some((p) => key.startsWith(p))))
      drop(key);
  }
}

/** Drop everything cached for every repository (a new session, or a test's new world). */
export function forgetAllRepoData() {
  cache.clear();
  totalBytes = 0;
  authorizedAt.clear();
}

/** For tests: bound the cache's size in bytes (the default is 32 MiB). */
export function setRepoDataByteLimit(bytes = 32 * 2 ** 20) {
  maxBytes = bytes;
  evict();
}

onAccessChange(forgetAllRepoData);

/** In loaders: turn API failures into route errors for the error boundary. */
/**
 * A metadata detail for a page that reads the source's Git data: an expired
 * work source fails the page as those reads would, not as an empty repository.
 */
export function requireLiveSource(detail: RepoDetail): RepoDetail {
  if (detail.sourceState === "expired")
    throw data({ message: "This code source has expired." }, { status: 410 });
  return detail;
}

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
  repoData.detail(space, name, source, true).catch(ignore);
  if (view === undefined) repoData.tree(space, name, "", source).catch(ignore);
  else if (view === "tree") repoData.tree(space, name, tail, source).catch(ignore);
  else if (view === "blob") repoData.blob(space, name, tail, source).catch(ignore);
  else if (view === "commits") {
    repoData.history(space, name, tail, false, "", source).catch(ignore);
  }
}
