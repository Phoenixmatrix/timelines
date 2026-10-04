import type { RepoDetail } from "../../shared/api.ts";
import { commitsUrl, repoPath, sourceUrl } from "./refs.ts";

/** One of a repository's sections: a tab in its header and a destination in search. */
export interface RepoSection {
  id: string;
  label: string;
  to: string;
  /** Path prefixes that belong to it ("" means exactly `to`), to mark the current tab. */
  sections: string[];
  /** Other words people look for it by. */
  keywords: string[];
}

/** The sections this viewer can open, in tab order. */
export function repoSections(repo: RepoDetail): RepoSection[] {
  const base = repoPath(repo.owner.slug, repo.name);
  const section = (id: string, label: string, keywords: string[] = []): RepoSection => ({
    id,
    label,
    to: sourceUrl(`${base}/${id}`, repo.source?.sourceId),
    sections: [`${base}/${id}`],
    keywords,
  });
  return [
    {
      id: "code",
      label: "Code",
      to: sourceUrl(base, repo.source?.sourceId),
      sections: ["", `${base}/tree/`, `${base}/blob/`],
      keywords: ["files", "tree", "readme"],
    },
    ...(repo.head
      ? [
          {
            id: "commits",
            label: "Commits",
            to: commitsUrl(
              repo.owner.slug,
              repo.name,
              repo.source?.kind === "timeline-work"
                ? repo.source.ref.replace(/^refs\/heads\//, "")
                : repo.defaultBranch,
              "",
              repo.source?.sourceId,
            ),
            sections: [`${base}/commits/`],
            keywords: ["history", "log"],
          },
        ]
      : []),
    section("changes", "Changes", ["semantic", "diff"]),
    section("ci", "CI", ["runs", "builds", "pipeline"]),
    section("packages", "Packages"),
    section("tracker", "Issues", ["tracker", "tickets"]),
    section("releases", "Releases", ["release notes", "changelog"]),
    section("wiki", "Wiki", ["docs"]),
    section("knowledge", "Knowledge", ["graph", "map"]),
    ...(repo.viewerRole === "admin" ? [section("settings", "Settings", ["collaborators"])] : []),
  ];
}
