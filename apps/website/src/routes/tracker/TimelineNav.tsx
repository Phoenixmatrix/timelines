import { Link } from "react-router";

/** A timeline's pages: what it is, what it changes, and how it got there (CORE-382). */
export type TimelinePage = "overview" | "changes" | "story";

/** Where each of a timeline's pages lives; `query` carries filters such as `?repo=`. */
export function timelinePageUrl(
  owner: string,
  slug: string,
  page: TimelinePage,
  query?: Record<string, string | null | undefined>,
): string {
  const base = `/tracker/${encodeURIComponent(owner)}/timelines`;
  const params = new URLSearchParams();
  if (page === "overview") params.set("tl", slug);
  for (const [key, value] of Object.entries(query ?? {})) if (value) params.set(key, value);
  const search = params.size ? `?${params}` : "";
  return page === "overview"
    ? `${base}${search}`
    : `${base}/${encodeURIComponent(slug)}/${page}${search}`;
}

const LABELS: Record<TimelinePage, string> = {
  overview: "Overview",
  changes: "Changes",
  story: "Story",
};

/**
 * The tab row shared by a timeline's pages, like a repository's: the same
 * three places from each, so Story and Changes are never dead ends.
 */
export function TimelineNav({
  owner,
  slug,
  current,
  query,
}: {
  owner: string;
  slug: string;
  current: TimelinePage;
  /** Carried to Changes and Story, e.g. the selected repository. */
  query?: Record<string, string | null | undefined>;
}) {
  return (
    <nav
      aria-label="Timeline"
      className="mb-3 flex gap-5 overflow-x-auto border-b border-line-soft"
    >
      {(["overview", "changes", "story"] as const).map((page) => (
        <Link
          key={page}
          to={timelinePageUrl(owner, slug, page, page === "overview" ? undefined : query)}
          aria-current={page === current ? "page" : undefined}
          className="-mb-px flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-1 font-semibold text-ink-muted no-underline transition-colors hover:text-ink aria-[current=page]:border-signal-line aria-[current=page]:text-ink lg:min-h-9"
        >
          {LABELS[page]}
        </Link>
      ))}
    </nav>
  );
}

/** What a comparison against an earlier timeline commit counts when main was merged in between (CORE-382). */
export const MERGED_IN = "Includes what merging main brought in between.";
