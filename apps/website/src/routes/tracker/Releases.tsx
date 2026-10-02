import { MagnifyingGlassIcon, RocketLaunchIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Form, Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import {
  UNRELEASED,
  type ReleaseCategory,
  type ReleaseFeed,
  type ReleaseFeedEntry,
  type ReleaseFeedFacet,
} from "../../../shared/release-notes.ts";
import type { TrackerOwner } from "../../../shared/tracker.ts";
import { SelectField } from "../../components/ui.tsx";
import { api, load } from "../../lib/api.ts";
import { fullDate, timeAgo } from "../../lib/format.ts";
import { repoPath } from "../../lib/refs.ts";

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

function Entry({ entry }: { entry: ReleaseFeedEntry }) {
  return (
    <li className="flex flex-col gap-1 border-t border-line-soft py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="mk-chip mk-chip--tag">{CATEGORY_LABELS[entry.category]}</span>
        <span className="text-body font-semibold text-ink">{entry.title}</span>
      </div>
      {entry.summary && <p className="m-0 text-body-sm text-ink-muted">{entry.summary}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-faint">
        {entry.issue && (
          <>
            <span className="mk-mono">{entry.issue.team.key}</span>
            <Link
              className="mk-mono text-ink-muted"
              to={`/tracker/${encodeURIComponent(entry.issue.trackerOwner)}/issues/${encodeURIComponent(entry.issue.id)}`}
            >
              {entry.issue.key}
            </Link>
          </>
        )}
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
            {repo.releases.map((r) => (r === UNRELEASED ? "unreleased" : r)).join(", ")}
          </span>
        ))}
        <span title={fullDate(entry.shippedAt)}>shipped {timeAgo(entry.shippedAt)}</span>
      </div>
    </li>
  );
}

export function TrackerReleases() {
  const { feed, q, trackers } = useLoaderData<typeof trackerReleasesLoader>();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  const owner = feed.owner.slug;
  const onQuery = (next: string) =>
    navigate(
      `/tracker/${encodeURIComponent(owner)}/releases${next ? `?q=${encodeURIComponent(next)}` : ""}`,
    );

  const weeks = new Map<string, ReleaseFeedEntry[]>();
  for (const entry of feed.entries) {
    const week = weekOf(entry.shippedAt);
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
        <Link
          className="mk-btn mk-btn--ghost mk-btn--sm ml-auto no-underline"
          to={`/tracker/${encodeURIComponent(owner)}`}
        >
          Issues
        </Link>
      </header>
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
        Filter by team, repo, ws, type, label, release, since and until; prefix with - to exclude.
      </p>
      <div className="flex max-w-[52rem] flex-col gap-2">
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
      </div>
      {feed.entries.length === 0 ? (
        <div className="mk-empty flex max-w-[44rem] flex-col items-center gap-3 py-12">
          <RocketLaunchIcon size={28} className="text-ink-faint" aria-hidden />
          <div>
            {q
              ? "Nothing shipped matches this filter."
              : `Nothing shipped yet in ${feed.owner.displayName}'s repositories or by its teams.`}
          </div>
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
                })}
              </h2>
              <ul className="m-0 list-none p-0">
                {entries.map((entry) => (
                  <Entry key={entry.id} entry={entry} />
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
  );
}
