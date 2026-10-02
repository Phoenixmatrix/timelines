// What the person is looking at, for the assistant: derived from the route
// and its loader data, never from the DOM.

import { useMatches, useLocation } from "react-router";
import type { PageContext } from "../../shared/assistant.ts";

interface Match {
  params: Record<string, string | undefined>;
  data: unknown;
}

/** The page context for a path, its route params and loader data. */
export function contextFor(pathname: string, hash: string, matches: Match[]): PageContext {
  const params: Record<string, string | undefined> = Object.assign(
    {},
    ...matches.map((m) => m.params),
  );
  const page: PageContext = { path: `${pathname}${hash}` };
  if (typeof document !== "undefined") page.title = document.title;
  const tracker = /^\/tracker\/([^/]+)(?:\/issues\/([^/]+))?/.exec(pathname);
  if (tracker) {
    page.tracker = tracker[1];
    if (tracker[2]) page.issue = decodeURIComponent(tracker[2]);
    return page;
  }
  if (params.owner && params.repo) {
    page.repo = `${params.owner}/${params.repo}`;
    for (const match of matches) {
      const data = match.data as { blob?: { ref: string; path: string } } | null;
      if (data?.blob) {
        page.ref = data.blob.ref;
        page.file = data.blob.path;
      }
    }
    const lines = /^#L(\d+)(?:-L(\d+))?$/.exec(hash);
    if (page.file && lines) page.lines = lines[2] ? `${lines[1]}-${lines[2]}` : lines[1];
    if (params.number && /\/ci\/\d+/.test(pathname)) page.run = Number(params.number);
  }
  return page;
}

export function usePageContext(): PageContext {
  const { pathname, hash } = useLocation();
  const matches = useMatches().map((m) => {
    const match = m as unknown as { params: Match["params"]; loaderData?: unknown; data?: unknown };
    return { params: match.params, data: match.loaderData ?? match.data };
  });
  return contextFor(pathname, hash, matches);
}

/** A short label for the context chip, or null when the page has nothing specific. */
export function contextLabel(page: PageContext): string | null {
  if (page.issue) return page.issue;
  if (page.run) return `Run #${page.run}`;
  if (page.file) return `${page.file.split("/").pop()}${page.lines ? ` · L${page.lines}` : ""}`;
  if (page.repo) return page.repo;
  if (page.tracker) return `${page.tracker}’s tracker`;
  return null;
}
