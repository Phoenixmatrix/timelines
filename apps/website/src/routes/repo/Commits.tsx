import { useEffect, useState } from "react";
import { useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import type { CiCommitStatuses } from "../../../shared/api.ts";
import { CiStatusIcon, ciLabel } from "../../components/CiStatus.tsx";
import { Monogram } from "../../components/Monogram.tsx";
import { repoData, routeData } from "../../lib/repoData.ts";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { firstLine, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { api } from "../../lib/api.ts";
import { commitsUrl, repoPath, treeUrl } from "../../lib/refs.ts";
import { RefBar } from "./RefPicker.tsx";
import { useRepo } from "./RepoLayout.tsx";

export async function commitsLoader({ request, params }: LoaderFunctionArgs) {
  const page = Number(new URL(request.url).searchParams.get("page") ?? "1") || 1;
  const result = await routeData(
    repoData.commits(params.owner ?? "", params.repo ?? "", params["*"] ?? "", page),
  );
  return { ...result, page };
}

/** CI results for the listed commits, loaded after the page shows so it never waits on them. */
function useCiStatuses(owner: string, name: string, oids: string[]): CiCommitStatuses {
  const [statuses, setStatuses] = useState<CiCommitStatuses>({});
  const key = oids.join(",");
  useEffect(() => {
    let current = true;
    api<CiCommitStatuses>(`/repos/${owner}/${name}/ci/status?commits=${key}`)
      .then((next) => current && setStatuses(next))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [owner, name, key]);
  return statuses;
}

export function Commits() {
  const { ref, commits, hasMore, page } = useLoaderData<typeof commitsLoader>();
  const repo = useRepo();
  const navigate = useNavigate();
  const base = commitsUrl(repo.owner.slug, repo.name, ref);
  const ci = useCiStatuses(
    repo.owner.slug,
    repo.name,
    commits.map((c) => c.oid),
  );

  return (
    <div className="flex flex-col gap-4">
      <RefBar
        repo={repo}
        refName={ref}
        path=""
        view="commits"
        onSwitch={(next) => navigate(commitsUrl(repo.owner.slug, repo.name, next))}
      />
      <ol className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
        {commits.map((commit) => (
          <li key={commit.oid} className="flex items-center gap-3 px-4 py-3">
            <Monogram name={commit.authorName} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold" dir="auto">
                {firstLine(commit.message)}
              </div>
              <div className="text-body-sm text-ink-faint">
                <bdi>{commit.authorName}</bdi> committed{" "}
                <span title={fullDate(commit.authoredAt)}>{timeAgo(commit.authoredAt)}</span>
              </div>
            </div>
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
              className="mk-chip mk-chip--tag mk-mono h-6 no-underline"
              title="Browse files at this commit"
            >
              {shortOid(commit.oid)}
            </PrefetchLink>
          </li>
        ))}
      </ol>
      {(page > 1 || hasMore) && (
        <div className="flex justify-center gap-2">
          {page > 1 && (
            <PrefetchLink
              to={`${base}?page=${page - 1}`}
              className="mk-btn mk-btn--sm no-underline"
            >
              Newer
            </PrefetchLink>
          )}
          {hasMore && (
            <PrefetchLink
              to={`${base}?page=${page + 1}`}
              className="mk-btn mk-btn--sm no-underline"
            >
              Older
            </PrefetchLink>
          )}
        </div>
      )}
    </div>
  );
}
