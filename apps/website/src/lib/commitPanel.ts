// The commit side panel's address (CORE-22): any repository page with
// `?commit=<sha>` opens the panel for that commit over the page, and closing
// it leaves the page as it was. Outside a repository, `/<owner>/<repo>?commit=`
// opens the repository with the panel. Other features link SHAs this way.

import { useCallback } from "react";
import {
  useLocation,
  type Location,
  type RouteObject,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

/** The search parameter that opens the panel. */
export const COMMIT_PARAM = "commit";

/** A full or abbreviated commit hash, as people and tools write it. */
export const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

export function isShaLike(text: string): boolean {
  return SHA_PATTERN.test(text.trim());
}

/** The repository page with the panel open: the link for SHAs outside the repository's pages. */
export function commitPanelUrl(owner: string, name: string, sha: string): string {
  return `/${owner}/${name}?${COMMIT_PARAM}=${encodeURIComponent(sha.toLowerCase())}`;
}

/** The address `location` is at, with the panel open on `sha` (or closed, for null). */
export function withCommit(location: Pick<Location, "pathname" | "search">, sha: string | null) {
  const params = new URLSearchParams(location.search);
  if (sha) params.set(COMMIT_PARAM, sha.toLowerCase());
  else params.delete(COMMIT_PARAM);
  const search = params.toString();
  return `${location.pathname}${search ? `?${search}` : ""}`;
}

/** Whether `pathname` is one of `owner/name`'s pages, so the panel opens over it. */
export function inRepo(pathname: string, owner: string, name: string): boolean {
  const base = `/${owner}/${name}`.toLowerCase();
  const path = pathname.toLowerCase();
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Router state a panel link carries: how many panel entries sit above the page
 * it was opened from, so closing goes Back to that page instead of piling up
 * history. Shared links and reloads carry none, and close by dropping the
 * parameter.
 */
export interface CommitPanelState {
  commitPanelDepth: number;
}

export function panelDepth(state: unknown): number {
  const depth = (state as Partial<CommitPanelState> | null)?.commitPanelDepth;
  return typeof depth === "number" && depth > 0 ? depth : 0;
}

/** Where a SHA link goes, and the router state it carries. */
export interface CommitHref {
  to: string;
  state: CommitPanelState | undefined;
}

/** The link for a commit of `owner/name` from the current page. */
export function commitHref(
  location: Pick<Location, "pathname" | "search" | "state">,
  owner: string,
  name: string,
  sha: string,
): CommitHref {
  if (!inRepo(location.pathname, owner, name))
    return { to: commitPanelUrl(owner, name, sha), state: undefined };
  return {
    to: withCommit(location, sha),
    state: { commitPanelDepth: panelDepth(location.state) + 1 },
  };
}

/** `commitHref` for the current page. */
export function useCommitHref() {
  const location = useLocation();
  return useCallback(
    (owner: string, name: string, sha: string) => commitHref(location, owner, name, sha),
    [location],
  );
}

/** The two addresses differ only in whether, or on which commit, the panel is open. */
export function onlyPanelChanged(current: URL, next: URL): boolean {
  if (current.pathname !== next.pathname) return false;
  const strip = (url: URL) => {
    const params = new URLSearchParams(url.search);
    params.delete(COMMIT_PARAM);
    params.sort();
    return params.toString();
  };
  return current.search !== next.search && strip(current) === strip(next);
}

/**
 * Opening, changing or closing the panel never reloads the page under it:
 * each route below the repository keeps its own revalidation rules otherwise.
 */
export function keepPageUnderPanel(route: RouteObject): RouteObject {
  const own = route.shouldRevalidate;
  return {
    ...route,
    shouldRevalidate: (args: ShouldRevalidateFunctionArgs) =>
      !args.formMethod && onlyPanelChanged(args.currentUrl, args.nextUrl)
        ? false
        : own
          ? own(args)
          : args.defaultShouldRevalidate,
  };
}
