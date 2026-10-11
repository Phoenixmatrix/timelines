import { RocketLaunchIcon } from "@phosphor-icons/react";
import {
  Link,
  useLoaderData,
  useLocation,
  useRevalidator,
  type LoaderFunctionArgs,
} from "react-router";
import {
  releaseLabel,
  type ReleaseCategory,
  type ReleaseNoteEntry,
  type ReleaseNotesIndex,
  type ReleaseNotesRelease,
} from "../../../shared/release-notes.ts";
import { CommitLink } from "../../components/CommitLink.tsx";
import { RailSection, railClass } from "../../components/Rail.tsx";
import { TimelineSwitcher } from "../../components/TimelineScope.tsx";
import {
  RELEASE_NOTE_DETAILS_ID,
  ReleaseNoteDetails,
} from "../../components/ReleaseNoteDetails.tsx";
import { LinkedText } from "../../refs/RefLink.tsx";
import { api, ApiError, load } from "../../lib/api.ts";
import { shortOid, timeAgo } from "../../lib/format.ts";
import { repoPath } from "../../lib/refs.ts";
import { useViewer } from "../../lib/session.ts";
import { scopeOf } from "../../lib/timelineScope.ts";
import { useRepo } from "./RepoLayout.tsx";
import { useEffect, useState } from "react";

export async function releasesLoader({ request, params }: LoaderFunctionArgs) {
  const base = `/repos/${params.owner}/${params.repo}/release-notes`;
  const scope = scopeOf(new URL(request.url).searchParams);
  const query = new URLSearchParams();
  if (scope) query.set("timeline", scope);
  const index = await load<ReleaseNotesIndex>(`${base}?${query}`, request);
  // Without an explicit selection, open the newest daily update with visible notes.
  const name =
    params["*"] ||
    index.releases.find((release) => release.kind === "daily" && release.entries > 0)?.name ||
    index.releases.find((release) => release.kind === "daily")?.name ||
    index.releases.find((release) => release.entries > 0)?.name ||
    index.releases[0]?.name ||
    "";
  query.set("name", name);
  const release = name
    ? await api<ReleaseNotesRelease>(`${base}/release?${query}`, {
        signal: request.signal,
      }).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      })
    : null;
  return { index, release, name };
}

const HEADINGS: Record<ReleaseCategory, string> = {
  feature: "New",
  fix: "Fixed",
  improvement: "Improved",
  internal: "Internal",
};

function Entry({
  entry,
  expanded,
  onSelect,
}: {
  entry: ReleaseNoteEntry;
  expanded: boolean;
  onSelect: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <li className="flex flex-col gap-1 border-t border-line-soft py-3 first:border-t-0 first:pt-0">
      <div className="text-body font-semibold text-ink">
        <LinkedText text={entry.title} />
      </div>
      {entry.summary && (
        <p className="m-0 text-body-sm text-ink-muted">
          <LinkedText text={entry.summary} />
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-faint">
        <button
          type="button"
          className="cursor-pointer bg-transparent p-0 text-left text-ink-faint underline decoration-dotted underline-offset-4 hover:text-ink"
          title="Show commits and linked issue"
          aria-label={`Show release note details for ${entry.title}; last commit ${timeAgo(entry.lastCommitAt)}`}
          aria-expanded={expanded}
          aria-controls={RELEASE_NOTE_DETAILS_ID}
          onClick={(event) => onSelect(event.currentTarget)}
        >
          last commit {timeAgo(entry.lastCommitAt)}
        </button>
      </div>
    </li>
  );
}

function Sidebar({
  index,
  owner,
  name,
  selected,
}: {
  index: ReleaseNotesIndex;
  owner: string;
  name: string;
  selected: string;
}) {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.delete("source");
  return (
    <nav aria-label="Releases">
      {(["daily", "tag"] as const).map((kind) => (
        <section key={kind} className="mb-5">
          <h2 className="mx-2.5 mt-0 mb-2 text-body-sm font-semibold">
            {kind === "daily" ? "Daily updates" : "Tagged releases"}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {index.releases
              .filter((release) => release.kind === kind)
              .map((release) => (
                <li key={release.name}>
                  <Link
                    to={`${repoPath(owner, name, "releases", encodeURIComponent(release.name))}?${search}`}
                    aria-current={selected === release.name ? "page" : undefined}
                    className="flex items-baseline gap-2 rounded-plate px-2.5 py-1.5 text-body-sm text-ink-muted no-underline hover:bg-pane hover:text-ink aria-[current=page]:bg-raised aria-[current=page]:font-semibold aria-[current=page]:text-ink"
                  >
                    <span className="min-w-0 flex-1 truncate">{releaseLabel(release.name)}</span>
                    <span className="font-mono text-micro text-ink-faint tabular-nums">
                      {release.entries}
                    </span>
                  </Link>
                </li>
              ))}
          </ul>
          {!index.releases.some((release) => release.kind === kind) && (
            <p className="mx-2.5 my-0 text-micro text-ink-faint">
              {kind === "daily" ? "No daily updates yet." : "No tag snapshots."}
            </p>
          )}
        </section>
      ))}
    </nav>
  );
}

function StatusLine({ status }: { status: ReleaseNotesIndex["status"] }) {
  const text =
    status.state === "generating"
      ? "Updating now."
      : status.state === "failed"
        ? "The last notes update failed."
        : status.state === "disabled"
          ? "AI writing is off in this environment."
          : status.generatedAt
            ? `Updated ${timeAgo(status.generatedAt)}.`
            : "";
  return text ? <span>{text}</span> : null;
}

export function Releases() {
  const { index, release, name } = useLoaderData<typeof releasesLoader>();
  const repo = useRepo();
  const owner = repo.owner.slug;
  // Highlights need the organization's tracker, which only its members (or the owner) can read.
  const viewer = useViewer();
  const canReadHighlights = Boolean(
    viewer?.canCreateIn.some((account) => account.id === repo.owner.id),
  );
  const location = useLocation();
  const scope = scopeOf(location.search);
  const [selected, setSelected] = useState<{
    id: string;
    trigger: HTMLButtonElement;
    pathname: string;
    search: string;
  } | null>(null);
  const selectedEntry =
    selected?.pathname === location.pathname && selected.search === location.search
      ? release?.entries.find((entry) => entry.id === selected.id)
      : undefined;
  useEffect(() => {
    if (selected && !selectedEntry) setSelected(null);
  }, [selected, selectedEntry]);
  const selectEntry = (id: string, trigger: HTMLButtonElement) => {
    setSelected(
      selectedEntry?.id === id
        ? null
        : { id, trigger, pathname: location.pathname, search: location.search },
    );
  };
  const revalidator = useRevalidator();
  useEffect(() => {
    if (index.status.state !== "generating") return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [index.status.state, revalidator]);

  if (index.releases.length === 0 && !release) {
    return (
      <div className="mk-empty flex max-w-[44rem] flex-col items-center gap-3 py-12">
        <TimelineSwitcher variant="filter" />
        <RocketLaunchIcon size={28} className="text-ink-faint" aria-hidden />
        {canReadHighlights && (
          <Link
            to={`/tracker/${encodeURIComponent(owner)}/highlights`}
            className="mk-btn mk-btn--sm"
          >
            View organization highlights
          </Link>
        )}
        <div>
          {scope
            ? "No landed notes you can see match this timeline. Choose another timeline or main to see all notes."
            : "No daily updates are available yet. Daily notes group default-branch commits by UTC Git commit date, not deployment date."}
          <br />
          <span className="text-body-sm text-ink-faint">
            {index.status.state === "disabled" ||
            index.status.state === "generating" ||
            index.status.state === "failed" ? (
              <StatusLine status={index.status} />
            ) : (
              "Notes appear here after default-branch commits are processed."
            )}
          </span>
        </div>
      </div>
    );
  }

  const groups = (["feature", "fix", "improvement", "internal"] as const)
    .map((category) => ({
      category,
      entries: release?.entries.filter((entry) => entry.category === category) ?? [],
    }))
    .filter((group) => group.entries.length);
  const models = [
    ...new Set(
      [
        !scope && release?.release.introModel,
        ...(release?.entries.map((e) => e.model) ?? []),
      ].flatMap((model) => (model ? [model.replace("@cf/", "")] : [])),
    ),
  ];

  return (
    <div className="grid gap-x-8 gap-y-8 md:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,46rem)_minmax(15rem,19rem)] xl:gap-x-12">
      <aside className="max-h-64 overflow-y-auto md:row-span-2 md:sticky md:top-[calc(var(--scope-banner)+1.5rem)] md:max-h-[calc(100dvh-3rem-var(--scope-banner))] md:self-start">
        {canReadHighlights && (
          <Link
            to={`/tracker/${encodeURIComponent(owner)}/highlights`}
            className="mk-btn mk-btn--sm mb-4"
          >
            View organization highlights
          </Link>
        )}
        <Sidebar index={index} owner={owner} name={repo.name} selected={name} />
      </aside>
      <article className="min-w-0 md:col-start-2">
        <div className="mb-4">
          <TimelineSwitcher variant="filter" />
        </div>
        {!release ? (
          <div className="mk-empty max-w-[44rem]">
            {name
              ? `There are no notes for ${releaseLabel(name)}.`
              : "No daily updates are available yet."}{" "}
            Pick an update or tag from the list. <StatusLine status={index.status} />
          </div>
        ) : (
          <>
            <header className="mb-6 flex flex-col gap-1">
              <h2 className="m-0 text-headline">
                {release.release.kind === "daily" ? "Daily update" : "Tag"}{" "}
                {releaseLabel(release.release.name)}
              </h2>
              <p className="m-0 text-body-sm text-ink-faint">
                {release.release.kind === "daily"
                  ? "Default-branch commits grouped by UTC Git commit date"
                  : release.release.fromTag
                    ? `Changes since ${release.release.fromTag}`
                    : "Everything up to this tag"}
                {` · Last commit ${new Date(release.release.lastCommitAt).toUTCString()}`}
                {release.release.truncated && " · showing the newest 1,000 commits"}
              </p>
            </header>
            {!scope && release.release.intro && (
              <p className="mt-0 mb-8 text-body text-ink">{release.release.intro}</p>
            )}
            {groups.length === 0 && (
              <div className="mk-empty">
                {scope
                  ? "No landed notes you can see from this timeline in this release. Choose another timeline or main to see all notes."
                  : release.release.kind === "daily"
                    ? "No notes you can see for this UTC day."
                    : "No notes you can see for this tag."}{" "}
                <StatusLine status={index.status} />
              </div>
            )}
            {groups.map((group) =>
              group.category === "internal" ? (
                <details key={group.category} className="mb-8">
                  <summary className="mb-3 cursor-pointer text-title text-ink-muted">
                    {HEADINGS.internal}{" "}
                    <span className="font-mono text-micro tabular-nums">
                      {group.entries.length}
                    </span>
                  </summary>
                  <ul className="m-0 list-none p-0">
                    {group.entries.map((entry) => (
                      <Entry
                        key={entry.id}
                        entry={entry}
                        expanded={selectedEntry?.id === entry.id}
                        onSelect={(trigger) => selectEntry(entry.id, trigger)}
                      />
                    ))}
                  </ul>
                </details>
              ) : (
                <section key={group.category} className="mb-8">
                  <h3 className="mt-0 mb-3 text-title">{HEADINGS[group.category]}</h3>
                  <ul className="m-0 list-none p-0">
                    {group.entries.map((entry) => (
                      <Entry
                        key={entry.id}
                        entry={entry}
                        expanded={selectedEntry?.id === entry.id}
                        onSelect={(trigger) => selectEntry(entry.id, trigger)}
                      />
                    ))}
                  </ul>
                </section>
              ),
            )}
          </>
        )}
      </article>
      {release && (
        <aside
          aria-label="About these notes"
          className={`md:col-start-2 xl:col-start-3 xl:row-start-1 ${railClass}`}
        >
          {release.release.kind === "tag" && (
            <RailSection title="Range">
              <p className="m-0 text-body-sm text-ink-muted">
                <CommitLink
                  className="mk-mono"
                  owner={owner}
                  name={repo.name}
                  sha={release.release.toOid}
                >
                  {shortOid(release.release.toOid)}
                </CommitLink>
                {release.release.fromOid ? (
                  <>
                    {" "}
                    back to{" "}
                    <span className="mk-mono">
                      {release.release.fromTag ?? shortOid(release.release.fromOid)}
                    </span>
                  </>
                ) : (
                  " back to the first commit"
                )}
              </p>
            </RailSection>
          )}
          <RailSection title="Code update history">
            <p className="m-0 text-body-sm text-ink-muted">
              Daily updates group default-branch first-parent commits by UTC Git commit date. Tagged
              releases are optional named snapshots, one per Git tag. Neither records a deployment.
            </p>
          </RailSection>
          <p className="m-0 border-t border-line-soft pt-3 text-micro text-ink-faint">
            Written from commits, tracker issues and code changes
            {models.length ? ` by ${models.join(" and ")}` : ""}.{" "}
            <StatusLine status={index.status} /> Notes update as work lands.
          </p>
        </aside>
      )}
      <ReleaseNoteDetails
        selection={
          selectedEntry && selected
            ? { entry: selectedEntry, repo: { owner, name: repo.name }, trigger: selected.trigger }
            : null
        }
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
