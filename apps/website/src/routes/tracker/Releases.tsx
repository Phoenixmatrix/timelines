import { FunnelSimpleIcon, MagnifyingGlassIcon, RocketLaunchIcon } from "@phosphor-icons/react";
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
  releaseKind,
  releaseLabel,
  type ReleaseCategory,
  type ReleaseFeed,
  type ReleaseFeedEntry,
  type ReleaseFeedFacet,
} from "../../../shared/release-notes.ts";
import type { TrackerSpace } from "../../../shared/tracker.ts";
import {
  RELEASE_NOTE_DETAILS_ID,
  ReleaseNoteDetails,
  type ReleaseNoteDetailsSelection,
} from "../../components/ReleaseNoteDetails.tsx";
import { ReleaseNotesComposer } from "../../components/ReleaseNotesComposer.tsx";
import { SelectField } from "../../components/ui.tsx";
import { TimelineSwitcher } from "../../components/TimelineScope.tsx";
import { api, load } from "../../lib/api.ts";
import { timeAgo } from "../../lib/format.ts";
import { repoPath } from "../../lib/refs.ts";
import { scopeOf } from "../../lib/timelineScope.ts";
import { useRefContext } from "../../refs/context.ts";
import { LinkedText } from "../../refs/RefLink.tsx";
import { assertCurrentTrackerFilters } from "./loaders.ts";

export async function trackerReleasesLoader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  assertCurrentTrackerFilters(url);
  const search = url.searchParams;
  const q = search.get("q") ?? "";
  const query = new URLSearchParams({ q });
  const scope = scopeOf(search);
  if (scope) query.set("timeline", scope);
  const [feed, trackers] = await Promise.all([
    load<ReleaseFeed>(
      `/tracker/${encodeURIComponent(params.space!)}/release-notes?${query}`,
      request,
    ),
    api<{ trackers: TrackerSpace[] }>("/tracker", { signal: request.signal }),
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

/** `label:` is the old spelling of `tag:` (CORE-271): compare tokens as `tag:`. */
function canonical(token: string): string {
  return token.replace(/^(-?)(labels?|tags):/i, "$1tag:").toLowerCase();
}

/** Add `key:value` to the query, or take it out when it's there (in any spelling). */
function toggle(q: string, key: string, value: string): string {
  const token = `${key}:${/\s/.test(value) ? `"${value}"` : value}`;
  const tokens: string[] = q.match(/(-?[A-Za-z]+:)?"[^"]*"|\S+/g) ?? [];
  const at = tokens.findIndex((t) => canonical(t) === canonical(token));
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
  const tokens = (q.match(/(-?[A-Za-z]+:)?"[^"]*"|\S+/g) ?? []).map(canonical);
  if (facets.length < min && !tokens.some((t) => t.startsWith(`${queryKey}:`))) return null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-micro font-semibold text-ink-faint">{title}</span>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {facets.slice(0, 12).map((facet) => {
          const value = /\s/.test(facet.value) ? `"${facet.value}"` : facet.value;
          const pressed = tokens.includes(canonical(`${queryKey}:${value}`));
          return (
            <button
              key={facet.value}
              type="button"
              className="mk-chip h-auto min-h-11 max-w-full py-1.5 text-left lg:min-h-7"
              aria-pressed={pressed}
              onClick={() => onQuery(toggle(q, queryKey, facet.value))}
            >
              <span className="min-w-0 [overflow-wrap:anywhere]">{label(facet)}</span>
              <span className="shrink-0 font-mono text-micro tabular-nums opacity-70">
                {facet.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Entry({
  entry,
  expanded,
  onSelect,
}: {
  entry: ReleaseFeedEntry;
  expanded: boolean;
  onSelect: (id: string, trigger: HTMLButtonElement) => void;
}) {
  // Refs resolve in this tracker first, then in the entry's repository (CORE-22).
  const { tracker } = useRefContext();
  const context = { tracker, space: entry.repo.space, repo: entry.repo.name };
  return (
    <li className="flex min-w-0 flex-col gap-2 border-t border-line-soft py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="mk-chip mk-chip--tag">{CATEGORY_LABELS[entry.category]}</span>
        <span className="min-w-0 max-w-[72ch] text-body font-semibold text-ink [overflow-wrap:anywhere]">
          <LinkedText text={entry.title} context={context} />
        </span>
      </div>
      {entry.summary && (
        <p className="m-0 max-w-[72ch] text-body-sm leading-relaxed text-ink-muted [overflow-wrap:anywhere]">
          <LinkedText text={entry.summary} context={context} />
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-faint">
        {entry.repos.map((repo) => (
          <span key={`${repo.space}/${repo.name}`} className="min-w-0 [overflow-wrap:anywhere]">
            <Link
              className="text-ink-muted"
              to={repoPath(
                repo.space,
                repo.name,
                "releases",
                encodeURIComponent(repo.releases[0]!),
              )}
            >
              {repo.space}/{repo.name}
            </Link>{" "}
            {repo.releases
              .map(
                (name) =>
                  `${releaseKind(name) === "daily" ? "Daily update" : "Tagged release"} ${releaseLabel(name)}`,
              )
              .join(", ")}
          </span>
        ))}
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm min-h-11 max-w-full whitespace-normal text-left text-micro text-ink-faint lg:min-h-7"
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
  const space = feed.space.slug;
  const location = useLocation();
  const scope = scopeOf(location.search);
  const [selected, setSelected] = useState<{
    id: string;
    trigger: HTMLButtonElement;
    pathname: string;
    search: string;
    space: string;
    q: string;
  } | null>(null);
  const selectedEntry =
    selected &&
    selected.pathname === location.pathname &&
    selected.search === location.search &&
    selected.space === space &&
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
  const onQuery = (next: string) => {
    const search = new URLSearchParams(location.search);
    if (next) search.set("q", next);
    else search.delete("q");
    void navigate({ pathname: location.pathname, search: search.toString() });
  };

  const weeks = new Map<string, ReleaseFeedEntry[]>();
  for (const entry of feed.entries) {
    const week = weekOf(entry.lastCommitAt);
    weeks.set(week, [...(weeks.get(week) ?? []), entry]);
  }

  const narrow = (
    <div className="flex min-w-0 flex-col gap-5">
      <div className="flex min-w-0 flex-col gap-2">
        <span className="text-micro font-semibold text-ink-faint">History</span>
        <div className="flex flex-wrap gap-1.5">
          {(["daily", "tag"] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className="mk-chip min-h-11 lg:min-h-7"
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
              {kind === "daily" ? "Daily updates" : "Tagged releases"}
            </button>
          ))}
        </div>
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
        title="Projects"
        facets={feed.facets.projects}
        q={q}
        queryKey="project"
        onQuery={onQuery}
      />
      <Facets
        title="Tags"
        facets={feed.facets.tags ?? feed.facets.labels}
        q={q}
        queryKey="tag"
        onQuery={onQuery}
      />
    </div>
  );

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-6xl min-w-0 flex-col gap-5 px-4 py-5 sm:px-8 sm:py-7">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="m-0 text-title-lg">Release notes</h1>
        <SelectField
          ariaLabel="Tracker space"
          value={space}
          className="w-44 max-w-full"
          options={trackers.map((tracker) => ({ value: tracker.slug, label: tracker.displayName }))}
          onChange={(value) => navigate(`/tracker/${encodeURIComponent(value)}/releases`)}
        />
        <TimelineSwitcher variant="filter" />
        <Link
          to={`/tracker/${encodeURIComponent(space)}/highlights`}
          className="mk-btn mk-btn--sm min-h-11 sm:min-h-8"
        >
          View highlights
        </Link>
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm min-h-11 sm:ml-auto sm:min-h-8"
          disabled={revalidator.state !== "idle"}
          onClick={() => void revalidator.revalidate()}
        >
          Refresh notes
        </button>
      </header>
      <p className="m-0 max-w-[72ch] text-body-sm leading-relaxed text-ink-muted">
        Daily updates group default-branch first-parent commits by UTC Git commit date. Tagged
        releases are optional snapshots, not deployment records.
      </p>
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_16rem] lg:gap-10">
        <div className="flex min-w-0 flex-col gap-4">
          <Form method="get" className="relative flex min-w-0 items-center" role="search">
            {new URLSearchParams(location.search).has("tl") && (
              <input type="hidden" name="tl" value={scope ?? "main"} />
            )}
            <MagnifyingGlassIcon
              className="pointer-events-none absolute left-3 size-4 text-ink-faint"
              aria-hidden
            />
            <input
              name="q"
              className="mk-input mk-input--code h-11 min-w-0 flex-1 pl-9 sm:text-body-sm"
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
          <p
            id="release-query-help"
            className="m-0 -mt-2 max-w-[72ch] text-micro leading-relaxed text-ink-faint [overflow-wrap:anywhere]"
          >
            {feed.query.unknown.length ? `Not understood: ${feed.query.unknown.join(" ")}. ` : ""}
            Daily updates are shown by default. Use kind:tag for tagged releases or
            release:day:YYYY-MM-DD for a UTC day. Filter by team, repo, project, type, tag (issue
            tags), release, kind, timeline, since and until; prefix with - to exclude. These are
            code updates, not deployments.
          </p>
          {feed.entries.length > 0 && (
            <div className="max-w-[52rem]">
              <ReleaseNotesComposer
                target={{ kind: "tracker", space, q, timeline: scope }}
                label={feed.space.displayName}
              />
            </div>
          )}
          <details className="rounded-pane bg-pane px-3.5 py-1 open:pb-3.5 lg:hidden">
            <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 font-semibold [&::-webkit-details-marker]:hidden">
              <FunnelSimpleIcon weight="bold" aria-hidden />
              Narrow it down
              <span className="text-body-sm font-normal text-ink-faint">
                history, teams, type, repos, projects, tags
              </span>
            </summary>
            <div className="pt-4">{narrow}</div>
          </details>
          {feed.entries.length === 0 ? (
            <div className="mk-empty flex min-w-0 flex-col items-center gap-3 py-12 [overflow-wrap:anywhere]">
              <RocketLaunchIcon size={28} className="text-ink-faint" aria-hidden />
              <div>
                {scope
                  ? "No landed notes you can see match this timeline and these filters. Choose another timeline or main, or adjust your search."
                  : q
                    ? "No code updates match this filter."
                    : `No daily notes are available for ${feed.space.displayName}'s repositories or teams yet.`}
              </div>
              <p className="m-0 text-body-sm text-ink-faint">
                Refresh to check for newly processed notes.
              </p>
            </div>
          ) : (
            <div className="flex min-w-0 flex-col gap-8 pb-8">
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
                                  space,
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
        </div>
        <aside
          className="hidden min-w-0 flex-col gap-5 border-l border-line-soft pl-6 lg:flex lg:self-start"
          aria-label="Narrow it down"
        >
          <div className="flex items-center gap-2">
            <FunnelSimpleIcon weight="bold" aria-hidden className="text-ink-faint" />
            <h2 className="m-0 text-title">Narrow it down</h2>
          </div>
          {narrow}
        </aside>
      </div>
      <ReleaseNoteDetails selection={selection} onClose={closeDetails} />
    </div>
  );
}
