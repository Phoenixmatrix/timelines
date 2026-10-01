import { GitBranchIcon, TagIcon } from "@phosphor-icons/react";
import { Link } from "react-router";
import type { RepoDetail } from "../../../shared/api.ts";
import { SelectField } from "../../components/ui.tsx";
import { encodePath, repoPath } from "../../lib/refs.ts";

/** Branch or tag switcher plus a breadcrumb for the current path. */
export function RefBar({
  repo,
  refName,
  path,
  view,
  onSwitch,
}: {
  repo: RepoDetail;
  refName: string;
  path: string;
  view: "tree" | "blob" | "commits";
  onSwitch: (ref: string) => void;
}) {
  const options = [
    ...repo.branches.map((ref) => ({ value: ref.shortName, label: ref.shortName })),
    ...repo.tags.map((ref) => ({ value: ref.shortName, label: `${ref.shortName} (tag)` })),
  ];
  if (!options.some((option) => option.value === refName)) {
    options.unshift({ value: refName, label: refName.slice(0, 12) });
  }
  const isTag = repo.tags.some((ref) => ref.shortName === refName);
  const segments = path ? path.split("/") : [];

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2">
        {isTag ? (
          <TagIcon className="size-4 text-ink-faint" aria-hidden />
        ) : (
          <GitBranchIcon className="size-4 text-ink-faint" aria-hidden />
        )}
        <SelectField
          value={refName}
          options={options}
          onChange={onSwitch}
          ariaLabel="Branch or tag"
          className="h-10 w-auto min-w-36 max-w-64"
        />
      </div>
      {view !== "commits" && (
        <nav aria-label="Path" className="flex min-w-0 flex-wrap items-center gap-1 text-body">
          <Link
            to={repoPath(repo.owner.slug, repo.name, "tree", encodePath(refName))}
            className="font-semibold text-ink-muted no-underline hover:text-ink"
          >
            {repo.name}
          </Link>
          {segments.map((segment, index) => {
            const last = index === segments.length - 1;
            const to = repoPath(
              repo.owner.slug,
              repo.name,
              "tree",
              encodePath(refName),
              encodePath(segments.slice(0, index + 1).join("/")),
            );
            return (
              <span key={to} className="flex items-center gap-1">
                <span className="text-ink-faint">/</span>
                {last ? (
                  <span className="font-semibold" aria-current="page">
                    {segment}
                  </span>
                ) : (
                  <Link to={to} className="text-ink-muted no-underline hover:text-ink">
                    {segment}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
      )}
    </div>
  );
}
