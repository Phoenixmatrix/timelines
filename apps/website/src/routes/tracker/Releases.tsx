import { MagnifyingGlassIcon, RocketLaunchIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import {
  Form,
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
  type LoaderFunctionArgs,
} from "react-router";
import {
  landedTimelineSlug,
  releaseKind,
  releaseLabel,
  type ReleaseCategory,
  type ReleaseFeed,
  type ReleaseFeedEntry,
  type ReleaseFeedFacet,
} from "../../../shared/release-notes.ts";
import type { TrackerOwner } from "../../../shared/tracker.ts";
import {
  RELEASE_NOTE_DETAILS_ID,
  ReleaseNoteDetails,
  type ReleaseNoteDetailsSelection,
} from "../../components/ReleaseNoteDetails.tsx";
import { SelectField } from "../../components/ui.tsx";
import { api, load } from "../../lib/api.ts";
import { timeAgo } from "../../lib/format.ts";
import { repoPath } from "../../lib/refs.ts";
import { scopeOf } from "../../lib/timelineScope.ts";
import { useRefContext } from "../../refs/context.ts";
import { LinkedText } from "../../refs/RefLink.tsx";

export async function trackerReleasesLoader({ request, params }: LoaderFunctionArgs) {
  const q = new URL(request.url).searchParams.get("q") ?? "";
  const [feed, trackers] = await Promise.all([
    load<ReleaseFeed>(
      `/tracker/${encodeURIComponent(params.owner!)}/release-notes?q=${encodeURIComponent(q)}`,
      request,
    ),
    api<{ trackers: TrackerOwner[] }>("/tracker", { signal: request.signal }),
  ]);
  return { feed, q, trackers: trackers.trackers };
}

const CATEGORY_LABELS: Record<ReleaseCategory, string> = {
  feature: "New",
  fix: "Fixed",
  improvement: "Improved",
  internal: "Internal",
};

/** Monday of the entry's week, UTC, as the group it belongs to. */
function weekOf(iso: string): string {
  const day = new Date(iso);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString();
}

/** Add `key:value` to the query, or take it out when it's there. */
function toggle(q: string, key: string, value: string): string {
  const token = `${key}:${/\s/.test(value) ? `"${value}"` : value}`;
  const tokens: string[] = q.match(/(-?[A-Za-z]+:)?"[^"]*"|\S+/g) ?? [];
  const at = tokens.findIndex((t) => t.toLowerCase() === token.toLowerCase());
  if (at === -1) tokens.push(token);
  else tokens.splice(at, 1);
  return tokens.join(" ");
}

function Facets({
  title,
  facets,
  q,
  queryKey,
  onQuery,
  min = 2,
  label = (facet) => facet.label,
}: {
  title: string;
  facets: ReleaseFeedFacet[];
  q: string;
  queryKey: string;
  onQuery: (q: string) => void;
  /** Fewer choices than this aren't worth a row, unless one is in use. */
  min?: number;
  label?: (facet: ReleaseFeedFacet) => string;
}) {
  if (facets.length < min && !new RegExp(`(^|\\s)${queryKey}:`, "i").test(q)) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-micro text-ink-faint">{title}</span>
      {facets.slice(0, 12).map((facet) => {
        const token = `${queryKey}:${facet.value}`;
        const pressed = q.toLowerCase().split(/\s+/).includes(token.toLowerCase());
        return (
          <button
            key={facet.value}
            type="button"
            className="mk-chip"
            aria-pressed={pressed}
            onClick={() => onQuery(toggle(q, queryKey, facet.value))}
          >
            {label(facet)}
            <span className="font-mono text-micro tabular-nums opacity-70">{facet.count}</span>
          </button>
        );
      })}
    </div>
  );
}

function Entry({
  entry,
  scope,
  expanded,
  onSelect,
}: {
  entry: ReleaseFeedEntry;
  scope: string | null;
  expanded: boolean;
  onSelect: (id: string, trigger: HTMLButtonElement) => void;
}) {
  // Refs resolve in this tracker first, then in the entry's repository (CORE-22).
  const { tracker } = useRefContext();
  const context = { tracker, owner: entry.repo.owner, repo: entry.repo.name };
  return (
    <li className="flex flex-col gap-1 border-t border-line-soft py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="mk-chip mk-chip--tag">{CATEGORY_LABELS[entry.category]}</span>
        {scope && landedTimelineSlug(entry.timeline) === scope && (
          <span className="mk-chip mk-chip--tag">This timeline</span>
        )}
        <span className="text-body font-semibold text-ink">
          <LinkedText text={entry.title} context={context} />
        </span>
      </div>
      {entry.summary && (
        <p className="m-0 text-body-sm text-ink-muted">
          <LinkedText text={entry.summary} context={context} />
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-faint">
        {entry.repos.map((repo) => (
          <span key={`${repo.owner}/${repo.name}`}>
            <Link
              className="text-ink-muted"
              to={repoPath(
                repo.owner,
                repo.name,
                "releases",
                encodeURIComponent(repo.releases[0]!),
              )}
            >
              {repo.owner}/{repo.name}
            </Link>{" "}
            {repo.releases
              .map(
                (name) =>
                  `${releaseKind(name) === "daily" ? "Daily update" : "Tag"} ${releaseLabel(name)}`,
              )
              .join(", ")}
          </span>
        ))}
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm text-micro text-ink-faint"
          title={new Date(entry.lastCommitAt).toUTCString()}
          aria-label={`${expanded ? "Hide" : "Show"} release note details for ${entry.title}; last commit ${timeAgo(entry.lastCommitAt)}`}
          aria-expanded={expanded}
          aria-controls={RELEASE_NOTE_DETAILS_ID}
          onClick={(event) => onSelect(entry.id, event.currentTarget)}
        >
          last commit {timeAgo(entry.lastCommitAt)}
        </button>
      </div>
    </li>
  );
}

export function TrackerReleases() {
  const { feed, q, trackers } = useLoaderData<typeof trackerReleasesLoader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const owner = feed.owner.slug;
  // In a timeline's scope (?tl=) what it landed is marked; the Timelines facet narrows to it.
  const location = useLocation();
  const scope = scopeOf(location.search);
  const [selected, setSelected] = useState<{
    id: string;
    trigger: HTMLButtonElement;
    pathname: string;
    search: string;
    owner: string;
    q: string;
  } | null>(null);
  const selectedEntry =
    selected &&
    selected.pathname === location.pathname &&
    selected.search === location.search &&
    selected.owner === owner &&
    selected.q === q
      ? feed.entries.find((entry) => entry.id === selected.id)
      : undefined;
  const selection: ReleaseNoteDetailsSelection | null =
    selected && selectedEntry
      ? {
          entry: selectedEntry,
          // Commits are the entry's own repository's, whichever groups list it.
          repo: selectedEntry.repo,
          trigger: selected.trigger,
        }
      : null;
  const closeDetails = useCallback(() => setSelected(null), []);
  useEffect(() => {
    if (selected && !selectedEntry) setSelected(null);
  }, [selected, selectedEntry]);
  const onQuery = (next: string) =>
    navigate(
      `/tracker/${encodeURIComponent(owner)}/releases${next ? `?q=${encodeURIComponent(next)}` : ""}`,
    );

  const weeks = new Map<string, ReleaseFeedEntry[]>();
  for (const entry of feed.entries) {
    const week = weekOf(entry.lastCommitAt);
    weeks.set(week, [...(weeks.get(week) ?? []), entry]);
  }

  return (
    <div className="flex min-h-dvh flex-col gap-4 px-4 py-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="m-0 text-title-lg">Release notes</h1>
        <SelectField
          ariaLabel="Tracker owner"
          value={owner}
          className="w-44"
          options={trackers.map((tracker) => ({ value: tracker.slug, label: tracker.displayName }))}
          onChange={(value) => navigate(`/tracker/${encodeURIComponent(value)}/releases`)}
        />
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm ml-auto"
          disabled={revalidator.state !== "idle"}
          onClick={() => void revalidator.revalidate()}
        >
          Refresh notes
        </button>
      </header>
      <p className="m-0 max-w-[52rem] text-body-sm text-ink-muted">
        Daily updates group default-branch first-parent commits by UTC Git commit date. Named tags
        are optional snapshots, not deployment records.
      </p>
      <Form method="get" className="relative flex max-w-[52rem] items-center" role="search">
        <MagnifyingGlassIcon
          className="pointer-events-none absolute left-3 size-4 text-ink-faint"
          aria-hidden
        />
        <input
          name="q"
          className="mk-input mk-input--code h-10 min-w-0 flex-1 pl-9 sm:text-body-sm"
          aria-label="Filter release notes"
          aria-invalid={feed.query.unknown.length ? "true" : undefined}
          aria-describedby="release-query-help"
          placeholder="team:core repo:engine type:fix since:30d search words"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      </Form>
      <p id="release-query-help" className="m-0 -mt-2 text-micro text-ink-faint">
        {feed.query.unknown.length ? `Not understood: ${feed.query.unknown.join(" ")}. ` : ""}
        Daily updates are shown by default. Use kind:tag for named snapshots or
        release:day:YYYY-MM-DD for a UTC day. Filter by team, repo, ws, type, label, release, kind,
        timeline, since and until; prefix with - to exclude. These are code updates, not
        deployments.
      </p>
      <div className="flex max-w-[52rem] flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-1 text-micro text-ink-faint">History</span>
          {(["daily", "tag"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className="mk-chip"
              aria-pressed={
                feed.query.filters.some(
                  (filter) => filter.key === "kind" && !filter.negated && filter.value === kind,
                ) ||
                (kind === "daily" &&
                  !feed.query.filters.some(
                    (filter) =>
                      filter.key === "kind" || (filter.key === "release" && !filter.negated),
                  ))
              }
              onClick={() => {
                const tokens = q.match(/(-?[A-Za-z]+:)?"[^"]*"|\S+/g) ?? [];
                return onQuery(
                  [...tokens.filter((token) => !/^-?kind:/i.test(token)), `kind:${kind}`].join(" "),
                );
              }}
            >
              {kind === "daily" ? "Daily updates" : "Tags"}
            </button>
          ))}
        </div>
        <Facets
          title="Teams"
          facets={feed.facets.teams}
          q={q}
          queryKey="team"
          onQuery={onQuery}
          min={1}
        />
        <Facets
          title="Type"
          facets={feed.facets.categories}
          q={q}
          queryKey="type"
          onQuery={onQuery}
          label={(facet) => CATEGORY_LABELS[facet.value as ReleaseCategory] ?? facet.label}
        />
        <Facets title="Repos" facets={feed.facets.repos} q={q} queryKey="repo" onQuery={onQuery} />
        <Facets
          title="Workspaces"
          facets={feed.facets.workspaces}
          q={q}
          queryKey="ws"
          onQuery={onQuery}
        />
        <Facets
          title="Labels"
          facets={feed.facets.labels}
          q={q}
          queryKey="label"
          onQuery={onQuery}
        />
        <Facets
          title="Timelines"
          facets={feed.facets.timelines ?? []}
          q={q}
          queryKey="timeline"
          onQuery={onQuery}
          min={scope ? 1 : 2}
        />
      </div>
      {feed.entries.length === 0 ? (
        <div className="mk-empty flex max-w-[44rem] flex-col items-center gap-3 py-12">
          <RocketLaunchIcon size={28} className="text-ink-faint" aria-hidden />
          <div>
            {q
              ? "No code updates match this filter."
              : `No daily notes are available for ${feed.owner.displayName}'s repositories or teams yet.`}
          </div>
          <p className="m-0 text-body-sm text-ink-faint">
            Refresh to check for newly processed notes.
          </p>
        </div>
      ) : (
        <div className="flex max-w-[52rem] flex-col gap-8 pb-8">
          {[...weeks].map(([week, entries]) => (
            <section key={week}>
              <h2 className="mt-0 mb-3 text-title">
                Week of{" "}
                {new Date(week).toLocaleDateString("en", {
                  month: "short",
                  day: "numeric",
                  year: "numeric",
                  timeZone: "UTC",
                })}{" "}
                UTC
              </h2>
              <ul className="m-0 list-none p-0">
                {entries.map((entry) => (
                  <Entry
                    key={entry.id}
                    entry={entry}
                    scope={scope}
                    expanded={selectedEntry?.id === entry.id}
                    onSelect={(id, trigger) =>
                      setSelected(
                        selectedEntry?.id === id
                          ? null
                          : {
                              id,
                              trigger,
                              pathname: location.pathname,
                              search: location.search,
                              owner,
                              q,
                            },
                      )
                    }
                  />
                ))}
              </ul>
            </section>
          ))}
          {feed.truncated && (
            <p className="m-0 text-body-sm text-ink-faint">
              Showing the newest {feed.entries.length}. Narrow the filter to see older work.
            </p>
          )}
        </div>
      )}
      <ReleaseNoteDetails selection={selection} onClose={closeDetails} />
    </div>
  );
}
