import { RocketLaunchIcon } from "@phosphor-icons/react";
import { Link, NavLink, useLoaderData, type LoaderFunctionArgs } from "react-router";
import {
  UNRELEASED,
  type ReleaseCategory,
  type ReleaseNoteEntry,
  type ReleaseNotesIndex,
  type ReleaseNotesRelease,
} from "../../../shared/release-notes.ts";
import { RailSection, railClass } from "../../components/Rail.tsx";
import { api, ApiError, load } from "../../lib/api.ts";
import { fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { commitsUrl, repoPath } from "../../lib/refs.ts";
import { useRepo } from "./RepoLayout.tsx";

export async function releasesLoader({ request, params }: LoaderFunctionArgs) {
  const base = `/repos/${params.owner}/${params.repo}/release-notes`;
  const index = await load<ReleaseNotesIndex>(base, request);
  // Without a name, open the newest release that has something to read.
  const name =
    params["*"] ||
    index.releases.find((release) => release.entries > 0)?.name ||
    index.releases[0]?.name ||
    "";
  const release = name
    ? await api<ReleaseNotesRelease>(`${base}/release?name=${encodeURIComponent(name)}`, {
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

const releaseTitle = (name: string) => (name === UNRELEASED ? "Unreleased" : name);

function Entry({ entry, owner, name }: { entry: ReleaseNoteEntry; owner: string; name: string }) {
  return (
    <li className="flex flex-col gap-1 border-t border-line-soft py-3 first:border-t-0 first:pt-0">
      <div className="text-body font-semibold text-ink">{entry.title}</div>
      {entry.summary && <p className="m-0 text-body-sm text-ink-muted">{entry.summary}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro text-ink-faint">
        {entry.issue && (
          <Link
            className="mk-mono text-ink-muted"
            to={`/tracker/${encodeURIComponent(entry.issue.trackerOwner)}/issues/${encodeURIComponent(entry.issue.id)}`}
          >
            {entry.issue.key}
          </Link>
        )}
        {entry.commits.slice(0, 3).map((oid) => (
          <Link key={oid} className="mk-mono text-ink-faint" to={commitsUrl(owner, name, oid)}>
            {shortOid(oid)}
          </Link>
        ))}
        {entry.commits.length > 3 && <span>+{entry.commits.length - 3} more</span>}
        <span title={fullDate(entry.shippedAt)}>shipped {timeAgo(entry.shippedAt)}</span>
      </div>
    </li>
  );
}

function Sidebar({
  index,
  owner,
  name,
}: {
  index: ReleaseNotesIndex;
  owner: string;
  name: string;
}) {
  return (
    <nav aria-label="Releases">
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {index.releases.map((release) => (
          <li key={release.name}>
            <NavLink
              to={repoPath(owner, name, "releases", encodeURIComponent(release.name))}
              end
              className="flex items-baseline gap-2 rounded-plate px-2.5 py-1.5 text-body-sm text-ink-muted no-underline hover:bg-pane hover:text-ink aria-[current=page]:bg-raised aria-[current=page]:font-semibold aria-[current=page]:text-ink"
            >
              <span className="min-w-0 flex-1 truncate">{releaseTitle(release.name)}</span>
              <span className="font-mono text-micro text-ink-faint tabular-nums">
                {release.entries}
              </span>
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function StatusLine({ status }: { status: ReleaseNotesIndex["status"] }) {
  const text =
    status.state === "generating"
      ? "Updating now."
      : status.state === "failed"
        ? "The last update failed; it will be retried."
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

  if (index.releases.length === 0) {
    return (
      <div className="mk-empty flex max-w-[44rem] flex-col items-center gap-3 py-12">
        <RocketLaunchIcon size={28} className="text-ink-faint" aria-hidden />
        <div>
          Release notes are written from this repository's commits and the tracker issues they cite.
          <br />
          <span className="text-body-sm text-ink-faint">
            {index.status.state === "disabled"
              ? "AI writing is off in this environment."
              : index.status.state === "generating"
                ? "The first notes are on their way."
                : "Push a commit to start them."}
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
      [release?.release.introModel, ...(release?.entries.map((e) => e.model) ?? [])].flatMap(
        (model) => (model ? [model.replace("@cf/", "")] : []),
      ),
    ),
  ];

  return (
    <div className="grid gap-x-8 gap-y-8 md:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,46rem)_minmax(15rem,19rem)] xl:gap-x-12">
      <aside className="md:row-span-2 md:sticky md:top-6 md:max-h-[calc(100dvh-3rem)] md:self-start md:overflow-y-auto">
        <Sidebar index={index} owner={owner} name={repo.name} />
      </aside>
      <article className="min-w-0 md:col-start-2">
        {!release ? (
          <div className="mk-empty max-w-[44rem]">
            There are no notes for {releaseTitle(name)}. Pick a release from the list.
          </div>
        ) : (
          <>
            <header className="mb-6 flex flex-col gap-1">
              <h2 className="m-0 text-headline">{releaseTitle(release.release.name)}</h2>
              <p className="m-0 text-body-sm text-ink-faint">
                {release.release.fromTag
                  ? `Changes since ${release.release.fromTag}`
                  : "Everything up to this release"}
                {release.release.name !== UNRELEASED &&
                  ` · ${fullDate(release.release.releasedAt)}`}
                {release.release.truncated && " · showing the newest 1,000 commits"}
              </p>
            </header>
            {release.release.intro && (
              <p className="mt-0 mb-8 text-body text-ink">{release.release.intro}</p>
            )}
            {groups.length === 0 && (
              <div className="mk-empty">
                {release.release.name === UNRELEASED
                  ? "Nothing has landed since the last release."
                  : "No notes you can see in this release."}
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
                      <Entry key={entry.id} entry={entry} owner={owner} name={repo.name} />
                    ))}
                  </ul>
                </details>
              ) : (
                <section key={group.category} className="mb-8">
                  <h3 className="mt-0 mb-3 text-title">{HEADINGS[group.category]}</h3>
                  <ul className="m-0 list-none p-0">
                    {group.entries.map((entry) => (
                      <Entry key={entry.id} entry={entry} owner={owner} name={repo.name} />
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
          <RailSection title="Range">
            <p className="m-0 text-body-sm text-ink-muted">
              <Link className="mk-mono" to={commitsUrl(owner, repo.name, release.release.toOid)}>
                {shortOid(release.release.toOid)}
              </Link>
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
          <p className="m-0 border-t border-line-soft pt-3 text-micro text-ink-faint">
            Written from commits, tracker issues and code changes
            {models.length ? ` by ${models.join(" and ")}` : ""}.{" "}
            <StatusLine status={index.status} /> Notes update as work lands.
          </p>
        </aside>
      )}
    </div>
  );
}
