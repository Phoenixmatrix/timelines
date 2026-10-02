import { useEffect, useState } from "react";
import { useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import type { CiCommitStatuses, HistoryPage, RepoDetail } from "../../../shared/api.ts";
import { CiStatusIcon, ciLabel } from "../../components/CiStatus.tsx";
import { Monogram } from "../../components/Monogram.tsx";
import { repoData, routeData } from "../../lib/repoData.ts";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { shortOid } from "../../lib/format.ts";
import { api } from "../../lib/api.ts";
import { commitsUrl, repoPath, treeUrl } from "../../lib/refs.ts";
import { CommitInfo, HistoryProgress, countLabel, useHistory } from "./History.tsx";
import { RefBar } from "./RefPicker.tsx";
import { useRepo } from "./RepoLayout.tsx";

export async function commitsLoader({ params }: LoaderFunctionArgs) {
  return routeData(repoData.history(params.owner ?? "", params.repo ?? "", params["*"] ?? ""));
}

/** CI results for the listed commits, loaded after the page shows so it never waits on them. */
function useCiStatuses(owner: string, name: string, oids: string[]): CiCommitStatuses {
  const [statuses, setStatuses] = useState<CiCommitStatuses>({});
  const key = oids.join(",");
  useEffect(() => {
    let current = true;
    api<CiCommitStatuses>(`/repos/${owner}/${name}/ci/status?commits=${key}`)
      .then((next) => current && setStatuses((previous) => ({ ...previous, ...next })))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [owner, name, key]);
  return statuses;
}

export function Commits() {
  const initial = useLoaderData<typeof commitsLoader>();
  const repo = useRepo();
  return (
    <History
      key={`${repo.id}:${initial.ref}:${initial.head}:${initial.path}`}
      repo={repo}
      initial={initial}
    />
  );
}

function History({ repo, initial }: { repo: RepoDetail; initial: HistoryPage }) {
  const navigate = useNavigate();
  const state = useHistory(repo, initial.head, initial.path, false, initial);
  const history = state.history!;
  const ci = useCiStatuses(
    repo.owner.slug,
    repo.name,
    history.commits.slice(-100).map((commit) => commit.oid),
  );
  return (
    <div className="flex flex-col gap-4">
      <RefBar
        repo={repo}
        refName={initial.ref}
        path={initial.path}
        view="commits"
        onSwitch={(next) => navigate(commitsUrl(repo.owner.slug, repo.name, next, initial.path))}
      />
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
                to={repoPath(repo.owner.slug, repo.name, "ci", String(ci[commit.oid]!.number))}
                title={`CI run #${ci[commit.oid]!.number}: ${ciLabel(ci[commit.oid]!.status)}`}
                className="flex"
              >
                <CiStatusIcon status={ci[commit.oid]!.status} />
              </PrefetchLink>
            )}
            <PrefetchLink
              to={treeUrl(repo.owner.slug, repo.name, commit.oid)}
              className="mk-chip mk-chip--tag mk-mono hidden h-6 no-underline sm:inline-flex"
              title="Browse files at this commit"
            >
              {shortOid(commit.oid)}
            </PrefetchLink>
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
