import { PrefetchLink } from "./PrefetchLink.tsx";
import type { RepoSummary } from "../../shared/api.ts";
import { timeAgo } from "../lib/format.ts";
import { Monogram } from "./Monogram.tsx";
import { RoleChip, VisibilityChip } from "./ui.tsx";

export function RepoList({
  repos,
  showSpace = true,
  empty,
}: {
  repos: RepoSummary[];
  showSpace?: boolean;
  empty: React.ReactNode;
}) {
  if (repos.length === 0) return <div className="mk-empty">{empty}</div>;
  return (
    <ul className="m-0 list-none divide-y divide-line-soft overflow-hidden rounded-pane bg-pane p-0">
      {repos.map((repo) => (
        <li key={repo.id} className="mk-enter-up">
          <PrefetchLink
            to={`/${repo.space.slug}/${repo.name}`}
            className="flex items-start gap-3 px-4 py-3.5 text-ink no-underline transition-colors hover:bg-raised"
          >
            <Monogram name={repo.space.displayName} shape="place" size="sm" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold">
                  {showSpace && (
                    <span className="font-normal text-ink-muted">{repo.space.slug} / </span>
                  )}
                  <bdi>{repo.name}</bdi>
                </span>
                <VisibilityChip visibility={repo.visibility} />
                <RoleChip role={repo.viewerRole} />
              </span>
              {repo.description && (
                <span className="mt-0.5 block truncate text-body-sm text-ink-muted" dir="auto">
                  {repo.description}
                </span>
              )}
            </span>
            <span className="hidden shrink-0 pt-0.5 text-micro text-ink-faint sm:block">
              {repo.pushedAt
                ? `Pushed ${timeAgo(repo.pushedAt)}`
                : `Created ${timeAgo(repo.createdAt)}`}
            </span>
          </PrefetchLink>
        </li>
      ))}
    </ul>
  );
}
