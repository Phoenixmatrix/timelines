// Where a ref is being read, from the address: the page's repository, space
// or tracker (shared/refs.ts RefContext), and where a resolved target opens.

import { useMemo } from "react";
import { useLocation } from "react-router";
import type { RefContext, RefTarget } from "../../shared/refs.ts";

/** First path segments that are app places, not Space slugs (src/appRoutes.tsx). */
const PLACES: Record<string, true> = {
  "-": true,
  "agent-work": true,
  accounts: true,
  organizations: true,
  instance: true,
  api: true,
  highlights: true,
  "cli-auth": true,
  device: true,
  "needs-you": true,
  new: true,
  packages: true,
  "release-notes": true,
  settings: true,
  signin: true,
  timelines: true,
  tracker: true,
};

function segments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
}

/** The ref context a page's address implies. */
export function refContextFromPath(pathname: string): RefContext {
  const [first, second] = segments(pathname);
  if (!first) return {};
  if (first === "tracker") return second ? { tracker: second } : {};
  if (PLACES[first]) return {};
  if (!second || second === "-") return { space: first };
  return { space: first, repo: second };
}

/** The current page's ref context, or `override` where a component knows better. */
export function useRefContext(override?: RefContext): RefContext {
  const { pathname } = useLocation();
  const space = override?.space;
  const repo = override?.repo;
  const tracker = override?.tracker;
  return useMemo(
    () => (override ? { space, repo, tracker } : refContextFromPath(pathname)),
    // `override` is fully described by its fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathname, space, repo, tracker, !!override],
  );
}

/**
 * Where a target opens from the current page. A commit inside its own
 * repository opens the commit panel over the current page (`?commit=`, the
 * other parameters kept); from anywhere else, over the repository's home.
 */
export function refHref(target: RefTarget, location: { pathname: string; search: string }): string {
  if (target.kind !== "commit") return target.path;
  const [space, repo] = segments(location.pathname);
  if (space !== target.space || repo !== target.repo) return target.path;
  const params = new URLSearchParams(location.search);
  params.set("commit", target.sha);
  return `${location.pathname}?${params.toString()}`;
}
