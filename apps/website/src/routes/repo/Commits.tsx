import { useEffect, useState } from "react";
import { data, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import type { CiCommitStatuses, HistoryPage, RepoDetail } from "../../../shared/api.ts";
import { CiStatusIcon, ciLabel } from "../../components/CiStatus.tsx";
import { CommitLink } from "../../components/CommitLink.tsx";
import { DeploymentMark, useCommitDeployments } from "../../components/Deployments.tsx";
import { Monogram } from "../../components/Monogram.tsx";
import { repoData, requestSource, requireLiveSource, routeData } from "../../lib/repoData.ts";
import { bookmarkIn, scopeOf } from "../../lib/timelineScope.ts";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { shortOid } from "../../lib/format.ts";
import { api } from "../../lib/api.ts";
import { commitsUrl, repoPath, sourceUrl, treeUrl } from "../../lib/refs.ts";
import { CommitInfo, HistoryProgress, SourceHistory, countLabel, useHistory } from "./History.tsx";
import { RefBar } from "./RefPicker.tsx";
import { useRepo } from "./RepoLayout.tsx";

export async function commitsLoader({ request, params }: LoaderFunctionArgs) {
  const space = params.space ?? "";
  const name = params.repo ?? "";
  let at = params["*"] ?? "";
  const source = await requestSource(space, name, request);
  // In a timeline's scope, history without a named branch is the bookmark's.
  const scope = at ? null : scopeOf(new URL(request.url).search);
  if (scope) {
    const detail = requireLiveSource(await routeData(repoData.detail(space, name, source, true)));
    const bookmark = bookmarkIn(detail, scope);
    if (!bookmark && source)
      throw data(
        {
          message:
            "This timeline's historical Git ref is unavailable. Open a recorded commit or select main explicitly.",
        },
        { status: 410 },
      );
    at = bookmark ?? "";
  }
  return routeData(repoData.history(space, name, at, false, "", source));
}

/** CI results for the listed commits, loaded after the page shows so it never waits on them. */
function useCiStatuses(
  space: string,
  name: string,
  oids: string[],
  source?: string,
): CiCommitStatuses {
  const [statuses, setStatuses] = useState<CiCommitStatuses>({});
  const key = oids.join(",");
  useEffect(() => {
    let current = true;
    api<CiCommitStatuses>(sourceUrl(`/repos/${space}/${name}/ci/status?commits=${key}`, source))
      .then((next) => current && setStatuses((previous) => ({ ...previous, ...next })))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [space, name, key, source]);
  return statuses;
}

export function Commits() {
  const initial = useLoaderData<typeof commitsLoader>();
  const repo = useRepo();
  return (
    <History
      key={`${repo.id}:${repo.source?.sourceId}:${initial.ref}:${initial.head}:${initial.path}`}
      repo={repo}
      initial={initial}
    />
  );
}

function History({ repo, initial }: { repo: RepoDetail; initial: HistoryPage }) {
  const navigate = useNavigate();
  const state = useHistory(repo, initial.head, initial.path, undefined, initial);
  const history = state.history!;
  const ci = useCiStatuses(
    repo.space.slug,
    repo.name,
    history.commits.slice(-100).map((commit) => commit.oid),
    repo.source?.sourceId,
  );
  const deployed = useCommitDeployments(
    repo.space.slug,
    repo.name,
    history.commits.slice(-80).map((commit) => commit.oid),
    repo.source?.sourceId,
  );
  return (
    <div className="flex flex-col gap-4">
      <RefBar
        repo={repo}
        refName={initial.ref}
        path={initial.path}
        view="commits"
        onSwitch={(next) =>
          navigate(
            commitsUrl(repo.space.slug, repo.name, next, initial.path, repo.source?.sourceId),
          )
        }
      />
      <SourceHistory repo={repo} head={initial.head} />
      <div>
        <h2 className="m-0 text-title break-words">
          {initial.path ? `History of ${initial.path}` : "Repository history"}
        </h2>
        <p className="mt-1 mb-0 text-body-sm text-ink-faint">
          {countLabel(history.commits.length, !!history.next)} · Follows the first parent of merges
          {initial.path ? "; tracks this path without following renames" : ""}.
        </p>
      </div>
      <ol className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
        {history.commits.map((commit) => (
          <li key={commit.oid} className="flex items-center gap-3 px-4 py-3">
            <Monogram name={commit.authorName} size="sm" />
            <CommitInfo repo={repo} commit={commit} />
            {ci[commit.oid] && (
              <PrefetchLink
                to={repoPath(repo.space.slug, repo.name, "ci", String(ci[commit.oid]!.number))}
                title={`CI run #${ci[commit.oid]!.number}: ${ciLabel(ci[commit.oid]!.status)}`}
                className="flex"
              >
                <CiStatusIcon status={ci[commit.oid]!.status} />
              </PrefetchLink>
            )}
            {deployed[commit.oid] && <DeploymentMark deployment={deployed[commit.oid]!} />}
            {/* The commit panel reads canonical history; a work source's commit opens in its own source. */}
            {repo.source && repo.source.sourceId !== "canonical" ? (
              <PrefetchLink
                to={treeUrl(repo.space.slug, repo.name, commit.oid, "", repo.source.sourceId)}
                className="mk-chip mk-chip--tag mk-mono hidden h-6 no-underline sm:inline-flex"
                title="Browse files at this commit"
              >
                {shortOid(commit.oid)}
              </PrefetchLink>
            ) : (
              <CommitLink
                space={repo.space.slug}
                name={repo.name}
                sha={commit.oid}
                className="mk-chip mk-chip--tag mk-mono hidden h-6 no-underline sm:inline-flex"
                title={`Open commit ${shortOid(commit.oid)}`}
              >
                {shortOid(commit.oid)}
              </CommitLink>
            )}
          </li>
        ))}
      </ol>
      {history.commits.length === 0 && (
        <p className="mk-empty">
          {history.next
            ? "No changes to this path in the history loaded so far."
            : initial.path
              ? "No commits changed this path."
              : "No commits yet."}
        </p>
      )}
      <HistoryProgress state={state} />
    </div>
  );
}
