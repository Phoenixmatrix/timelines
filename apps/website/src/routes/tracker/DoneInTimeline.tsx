// Done in a timeline on an issue (CORE-74): where it was done, that its
// status is locked here until the timeline lands, and the way to the
// timeline's view of it, where it can be reopened.

import { Link, useLocation } from "react-router";
import type { Issue, Snapshot } from "../../../shared/tracker.ts";
import { link as LINK } from "../../components/ui.tsx";
import { DoneInTimelineIcon } from "./ui.tsx";

/** The issue in a timeline's view, and the timeline's own page. */
export function doneInLinks(
  space: string,
  key: string,
  slug: string,
  context?: { search: string; hash: string },
) {
  const base = `/tracker/${encodeURIComponent(space)}`;
  const query = new URLSearchParams(context?.search);
  query.set("tl", slug);
  const suffix = `?${query}${context?.hash ?? ""}`;
  return {
    issue: `${base}/issues/${encodeURIComponent(key)}${suffix}`,
    timeline: `${base}/timelines${suffix}`,
  };
}

/** The status is locked while done in a timeline this view doesn't include. */
export function lockedIn(issue: Pick<Issue, "status" | "doneIn">): Issue["doneIn"] {
  return issue.status === "done_in_timeline" ? (issue.doneIn ?? null) : null;
}

/** Under the disabled status picker: why, and where to reopen it. */
export function LockedStatusHint({ issue, space }: { issue: Issue; space: string }) {
  const location = useLocation();
  const slug = lockedIn(issue)?.slug;
  if (issue.status !== "done_in_timeline") return null;
  return (
    <p className="mk-hint mt-1.5 mb-0">
      Locked while it's done in timeline{" "}
      {slug ? <span className="mk-mono">{slug}</span> : "a timeline"}: it lands with the timeline.{" "}
      {slug && (
        <Link className={LINK} to={doneInLinks(space, issue.key, slug, location).issue}>
          Reopen it there
        </Link>
      )}
    </p>
  );
}

/** The issue's timeline, prominently: done there, and how to get to it. */
export function DoneInTimelineCallout({
  issue,
  snapshot,
}: {
  issue: Issue;
  snapshot: Pick<Snapshot, "space" | "timeline">;
}) {
  const location = useLocation();
  if (!issue.doneIn) return null;
  const { slug } = issue.doneIn;
  const links = doneInLinks(snapshot.space.slug, issue.key, slug, location);
  return (
    <div
      id="tracker-done-in-timeline"
      className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-control bg-raised px-3 py-2 text-body-sm"
    >
      <DoneInTimelineIcon className="size-4" />
      <span className="min-w-0 flex-1">
        Done in timeline{" "}
        <Link className={`${LINK} font-semibold`} to={links.timeline}>
          <span className="mk-mono">{slug}</span>
        </Link>
        <span className="text-ink-muted">
          {issue.status === "done_in_timeline"
            ? ": done on main when it lands. Its status is locked here."
            : ", which hasn't landed yet."}
          {issue.claim?.retainedIn &&
            " Its lease stays with whoever finished it until the timeline lands or is abandoned."}
        </span>
      </span>
      {snapshot.timeline?.id !== issue.doneIn.id && (
        <Link className="mk-btn mk-btn--sm shrink-0 no-underline" to={links.issue}>
          Open in the timeline
        </Link>
      )}
    </div>
  );
}
