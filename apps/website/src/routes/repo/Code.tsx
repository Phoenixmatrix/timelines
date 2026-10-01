import { FileIcon, FolderSimpleIcon, LinkSimpleIcon, CubeIcon } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import type { RepoDetail, TreeEntry, TreeResponse } from "../../../shared/api.ts";
import { Monogram } from "../../components/Monogram.tsx";
import { CopyField } from "../../components/ui.tsx";
import { firstLine, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { blobUrl, treeUrl } from "../../lib/refs.ts";
import { repoData, routeData } from "../../lib/repoData.ts";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { useViewer } from "../../lib/session.ts";
import { RefBar } from "./RefPicker.tsx";
import { useRepo } from "./RepoLayout.tsx";

export async function codeLoader({ params }: LoaderFunctionArgs) {
  const owner = params.owner ?? "";
  const name = params.repo ?? "";
  // The tree and the repo detail load in parallel; the server splits the
  // branch from the path, so neither waits for the other.
  const [repo, tree] = await Promise.all([
    routeData(repoData.detail(owner, name)),
    repoData.tree(owner, name, params["*"] ?? "").catch((error: unknown) => error),
  ]);
  if (!repo.head || repo.state !== "ready") return { tree: null };
  if (tree instanceof Error || !tree) return { tree: await routeData(Promise.reject(tree)) };
  return { tree: tree as TreeResponse };
}

const ICONS = {
  tree: FolderSimpleIcon,
  blob: FileIcon,
  exec: FileIcon,
  symlink: LinkSimpleIcon,
  gitlink: CubeIcon,
} as const;

function EntryRow({
  repo,
  refName,
  entry,
}: {
  repo: RepoDetail;
  refName: string;
  entry: TreeEntry;
}) {
  const Icon = ICONS[entry.type];
  const to =
    entry.type === "tree"
      ? treeUrl(repo.owner.slug, repo.name, refName, entry.path)
      : blobUrl(repo.owner.slug, repo.name, refName, entry.path);
  const label = (
    <>
      <Icon
        className={`size-4 shrink-0 ${entry.type === "tree" ? "text-ink-muted" : "text-ink-faint"}`}
        weight={entry.type === "tree" ? "fill" : "regular"}
        aria-hidden
      />
      <span className="truncate">{entry.name}</span>
    </>
  );
  return (
    <li>
      {entry.type === "gitlink" ? (
        <span className="flex h-10 items-center gap-3 px-4 text-ink-muted" title="Submodule">
          {label}
        </span>
      ) : (
        <PrefetchLink
          to={to}
          className="flex h-10 items-center gap-3 px-4 text-ink no-underline transition-colors hover:bg-raised"
        >
          {label}
        </PrefetchLink>
      )}
    </li>
  );
}

function EmptyRepo({ repo }: { repo: RepoDetail }) {
  const viewer = useViewer();
  const canPush = repo.viewerRole === "write" || repo.viewerRole === "admin";
  if (!canPush) {
    return (
      <div className="mk-empty">
        Nothing here yet.
        <br />
        <span className="text-body-sm text-ink-faint">
          Someone with write access needs to push first.
        </span>
      </div>
    );
  }
  return (
    <section className="mk-card">
      <h2 className="mk-card-title">Push your first commit</h2>
      <p className="mk-card-desc max-w-[56ch]">
        This repository is empty. From an existing project, add it as a remote and push. Git asks
        for a password: use a{" "}
        <Link to="/settings/tokens" className="gm-link">
          personal access token
        </Link>
        {viewer ? <> with the username {viewer.slug}</> : null}.
      </p>
      <div className="mk-card-body">
        <CopyField value={`git remote add origin ${repo.cloneUrl}`} label="Command" />
        <CopyField value={`git push -u origin ${repo.defaultBranch}`} label="Command" />
      </div>
    </section>
  );
}

export function Code() {
  const { tree } = useLoaderData<typeof codeLoader>();
  const repo = useRepo();
  const navigate = useNavigate();
  if (!tree) return <EmptyRepo repo={repo} />;

  const { commit } = tree;
  return (
    <div className="flex flex-col gap-4">
      <RefBar
        repo={repo}
        refName={tree.ref}
        path={tree.path}
        view="tree"
        onSwitch={(ref) => navigate(treeUrl(repo.owner.slug, repo.name, ref, tree.path))}
      />

      <section className="overflow-hidden rounded-pane bg-pane">
        <div className="flex items-center gap-3 border-b border-line-soft px-4 py-3">
          <Monogram name={commit.authorName} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate">
              <span className="font-semibold">
                <bdi>{commit.authorName}</bdi>
              </span>{" "}
              <span className="text-ink-muted" dir="auto">
                {firstLine(commit.message)}
              </span>
            </div>
          </div>
          <span className="mk-mono text-mono text-ink-faint">{shortOid(commit.oid)}</span>
          <span
            className="hidden text-body-sm text-ink-faint sm:inline"
            title={fullDate(commit.authoredAt)}
          >
            {timeAgo(commit.authoredAt)}
          </span>
        </div>
        <ul className="m-0 list-none divide-y divide-line-soft p-0">
          {tree.path && (
            <li>
              <PrefetchLink
                to={treeUrl(
                  repo.owner.slug,
                  repo.name,
                  tree.ref,
                  tree.path.split("/").slice(0, -1).join("/"),
                )}
                className="flex h-10 items-center gap-3 px-4 text-ink-muted no-underline hover:bg-raised"
                aria-label="Parent folder"
              >
                <FolderSimpleIcon className="size-4" aria-hidden />
                ..
              </PrefetchLink>
            </li>
          )}
          {tree.entries.map((entry) => (
            <EntryRow key={entry.path} repo={repo} refName={tree.ref} entry={entry} />
          ))}
        </ul>
      </section>

      {tree.readme && (
        <section className="rounded-pane bg-pane">
          <h2 className="m-0 border-b border-line-soft px-5 py-3 text-body font-semibold">
            {tree.readme.name}
          </h2>
          <div className="px-5 py-5">
            {/\.(md|markdown)$/i.test(tree.readme.name) ? (
              <div className="gm-prose" dir="auto">
                {/* react-markdown never renders raw HTML, so READMEs can't inject markup. */}
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{tree.readme.text}</ReactMarkdown>
              </div>
            ) : (
              <pre className="m-0 font-mono text-body-sm whitespace-pre-wrap">
                {tree.readme.text}
              </pre>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
