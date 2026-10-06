// A timeline's wiki pages at a checkpoint (CORE-84): what the timeline adds
// or changes in components and concepts, written apart from main's wiki. The
// approval card and the Knowledge tab's timeline panel both list them; each
// page opens in the wiki, scoped to the timeline.

import { useEffect } from "react";
import { Link, useRevalidator } from "react-router";
import type { KnowledgePageSet } from "../../shared/api.ts";
import { shortOid } from "../lib/format.ts";
import { repoPath, sourceUrl } from "../lib/refs.ts";
import { withScope } from "../lib/timelineScope.ts";

/** Still being written: queued, or a model is on it. */
export const pagesPending = (set: KnowledgePageSet) =>
  set.state === "queued" || set.state === "writing";

/** Look again every few seconds while pages are being written. */
export function useRefreshWhile(pending: boolean) {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => void revalidator.revalidate(), 5000);
    return () => clearTimeout(timer);
  }, [pending, revalidator]);
}

/** Where a timeline page opens: the wiki, scoped to the timeline, at this set. */
export function timelinePageUrl(owner: string, name: string, set: KnowledgePageSet, slug: string) {
  return withScope(
    sourceUrl(
      `${repoPath(owner, name, "wiki", slug)}?set=${encodeURIComponent(set.key)}`,
      set.sourceId,
    ),
    set.timeline,
  );
}

/** What a set was written for. */
export function setLabel(set: Pick<KnowledgePageSet, "checkpoint" | "commit">): string {
  return set.checkpoint?.number
    ? `checkpoint #${set.checkpoint.number}`
    : `${shortOid(set.commit)}, on demand`;
}

export function PageSetSummary({
  set,
  owner,
  name,
}: {
  set: KnowledgePageSet;
  owner: string;
  name: string;
}) {
  if (pagesPending(set))
    return (
      <p className="m-0 text-body-sm text-ink-muted" role="status">
        {set.state === "queued" ? "Wiki pages are queued…" : "Writing wiki pages…"}
      </p>
    );
  if (set.state === "failed")
    return (
      <p className="m-0 text-body-sm text-ink-muted" title={set.error ?? undefined}>
        The wiki pages could not be written{set.error ? `: ${set.error.slice(0, 160)}` : "."}
      </p>
    );
  if (set.pages.length === 0)
    return (
      <p className="m-0 text-body-sm text-ink-muted">
        {set.state === "ended"
          ? "The timeline ended before its wiki pages were written."
          : "No wiki page changes: the timeline adds or changes no component or concept."}
      </p>
    );
  return (
    <div className="flex flex-col gap-1">
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {set.pages.map((page) => (
          <li key={page.slug} className="flex flex-col gap-0.5 text-body-sm">
            <span className="flex flex-wrap items-baseline gap-x-2">
              {page.outcome === "written" ? (
                <Link to={timelinePageUrl(owner, name, set, page.slug)}>{page.title}</Link>
              ) : (
                <Link
                  to={withScope(repoPath(owner, name, "wiki", page.slug), null)}
                  className="text-ink-muted"
                >
                  {page.title}
                </Link>
              )}
              <span className="mk-chip mk-chip--tag">
                {page.outcome === "kept"
                  ? "Main's page holds"
                  : page.change === "added"
                    ? "New"
                    : "Changed"}
              </span>
            </span>
            {page.excerpt && (
              <span className="line-clamp-2 max-w-[72ch] text-ink-muted">{page.excerpt}</span>
            )}
          </li>
        ))}
      </ul>
      {set.skipped > 0 && (
        <p className="m-0 text-micro text-ink-faint">
          {set.skipped === 1 ? "1 more page was" : `${set.skipped} more pages were`} left out to
          keep the cost bounded.
        </p>
      )}
      {set.state === "ended" && (
        <p className="m-0 text-micro text-ink-faint">
          The timeline ended while these were written; they're kept as they are.
        </p>
      )}
    </div>
  );
}
