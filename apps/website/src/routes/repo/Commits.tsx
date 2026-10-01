import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import type { CommitsResponse } from "../../../shared/api.ts";
import { Monogram } from "../../components/Monogram.tsx";
import { load, loadRepo } from "../../lib/api.ts";
import { firstLine, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { commitsUrl, splitRefAndPath, treeUrl } from "../../lib/refs.ts";
import { RefBar } from "./RefPicker.tsx";
import { useRepo } from "./RepoLayout.tsx";

export async function commitsLoader({ request, params }: LoaderFunctionArgs) {
  const owner = params.owner ?? "";
  const name = params.repo ?? "";
  const repo = await loadRepo(owner, name, request);
  const ref = params["*"] ? splitRefAndPath(params["*"], repo).ref : repo.defaultBranch;
  const page = new URL(request.url).searchParams.get("page") ?? "1";
  const query = new URLSearchParams({ ref, page });
  const result = await load<CommitsResponse>(`/repos/${owner}/${name}/commits?${query}`, request);
  return { ...result, page: Number(page) };
}

export function Commits() {
  const { ref, commits, hasMore, page } = useLoaderData<typeof commitsLoader>();
  const repo = useRepo();
  const navigate = useNavigate();
  const base = commitsUrl(repo.owner.slug, repo.name, ref);

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
            <Link
              to={treeUrl(repo.owner.slug, repo.name, commit.oid)}
              className="mk-chip mk-chip--tag mk-mono h-6 no-underline"
              title="Browse files at this commit"
            >
              {shortOid(commit.oid)}
            </Link>
          </li>
        ))}
      </ol>
      {(page > 1 || hasMore) && (
        <div className="flex justify-center gap-2">
          {page > 1 && (
            <Link to={`${base}?page=${page - 1}`} className="mk-btn mk-btn--sm no-underline">
              Newer
            </Link>
          )}
          {hasMore && (
            <Link to={`${base}?page=${page + 1}`} className="mk-btn mk-btn--sm no-underline">
              Older
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
