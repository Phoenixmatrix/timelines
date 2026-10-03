import { RocketLaunchIcon } from "@phosphor-icons/react";
import { Link, useLoaderData, useRevalidator, type LoaderFunctionArgs } from "react-router";
import {
  releaseLabel,
  timelineLabel,
  type ReleaseCategory,
  type ReleaseNoteEntry,
  type ReleaseNotesIndex,
  type ReleaseNotesRelease,
} from "../../../shared/release-notes.ts";
import { RailSection, railClass } from "../../components/Rail.tsx";
import { api, ApiError, load } from "../../lib/api.ts";
import { shortOid, timeAgo } from "../../lib/format.ts";
import { commitsUrl, repoPath } from "../../lib/refs.ts";
import { useRepo } from "./RepoLayout.tsx";
import { useEffect } from "react";

export async function releasesLoader({ request, params }: LoaderFunctionArgs) {
  const base = `/repos/${params.owner}/${params.repo}/release-notes`;
  const index = await load<ReleaseNotesIndex>(base, request);
  // Without an explicit selection, open the newest daily update with visible notes.
  const name =
    params["*"] ||
    index.releases.find((release) => release.kind === "daily" && release.entries > 0)?.name ||
    index.releases.find((release) => release.kind === "daily")?.name ||
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
        {entry.timeline && (
          <span>
            landed with{" "}
            <Link
              className="mk-mono text-ink-muted"
              to={commitsUrl(owner, name, entry.timeline.landing)}
            >
              {timelineLabel(entry.timeline)}
            </Link>
          </span>
        )}
        {entry.commits.slice(0, 3).map((oid) => (
          <Link key={oid} className="mk-mono text-ink-faint" to={commitsUrl(owner, name, oid)}>
            {shortOid(oid)}
          </Link>
        ))}
        {entry.commits.length > 3 && <span>+{entry.commits.length - 3} more</span>}
        <span title={new Date(entry.lastCommitAt).toUTCString()}>
          last commit {timeAgo(entry.lastCommitAt)}
        </span>
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
  return (
    <nav aria-label="Releases">
      {(["daily", "tag"] as const).map((kind) => (
        <section key={kind} className="mb-5">
          <h2 className="mx-2.5 mt-0 mb-2 text-body-sm font-semibold">
            {kind === "daily" ? "Daily updates" : "Tags"}
          </h2>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {index.releases
              .filter((release) => release.kind === kind)
              .map((release) => (
                <li key={release.name}>
                  <Link
                    to={repoPath(owner, name, "releases", encodeURIComponent(release.name))}
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
  const revalidator = useRevalidator();
  useEffect(() => {
    if (index.status.state !== "generating") return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [index.status.state, revalidator]);

  if (index.releases.length === 0) {
    return (
      <div className="mk-empty flex max-w-[44rem] flex-col items-center gap-3 py-12">
        <RocketLaunchIcon size={28} className="text-ink-faint" aria-hidden />
        <div>
          No daily updates are available yet. Daily notes group default-branch commits by UTC Git
          commit date, not deployment date.
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
      [release?.release.introModel, ...(release?.entries.map((e) => e.model) ?? [])].flatMap(
        (model) => (model ? [model.replace("@cf/", "")] : []),
      ),
    ),
  ];

  return (
    <div className="grid gap-x-8 gap-y-8 md:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,46rem)_minmax(15rem,19rem)] xl:gap-x-12">
      <aside className="max-h-64 overflow-y-auto md:row-span-2 md:sticky md:top-6 md:max-h-[calc(100dvh-3rem)] md:self-start">
        <Sidebar index={index} owner={owner} name={repo.name} selected={name} />
      </aside>
      <article className="min-w-0 md:col-start-2">
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
            {release.release.intro && (
              <p className="mt-0 mb-8 text-body text-ink">{release.release.intro}</p>
            )}
            {groups.length === 0 && (
              <div className="mk-empty">
                {release.release.kind === "daily"
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
          {release.release.kind === "tag" && (
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
          )}
          <RailSection title="Code update history">
            <p className="m-0 text-body-sm text-ink-muted">
              Daily updates group default-branch first-parent commits by UTC Git commit date. Tags
              are optional named snapshots. Neither records a deployment.
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
