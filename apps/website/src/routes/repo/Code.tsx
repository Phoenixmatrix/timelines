import { FileIcon, FolderSimpleIcon, LinkSimpleIcon, CubeIcon } from "@phosphor-icons/react";
import { Suspense } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Await, Link, useLoaderData, useNavigate, type LoaderFunctionArgs } from "react-router";
import type { CommitSummary, RepoDetail, TreeEntry, TreeResponse } from "../../../shared/api.ts";
import { CopyField, link } from "../../components/ui.tsx";
import { firstLine, fullDate, timeAgo } from "../../lib/format.ts";
import { blobUrl, commitsUrl, treeUrl } from "../../lib/refs.ts";
import { repoData, routeData } from "../../lib/repoData.ts";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { railClass } from "../../components/Rail.tsx";
import { useViewer } from "../../lib/session.ts";
import { Attribution, CommitInfo, HistoryProgress, countLabel, useHistory } from "./History.tsx";
import { About } from "./About.tsx";
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
  if (!repo.head || repo.state !== "ready") return { tree: null, about: null };
  if (tree instanceof Error || !tree) {
    return { tree: await routeData(Promise.reject(tree)), about: null };
  }
  // The About rail is extra: it streams in beside the files and never holds
  // them up. Both reads are cached, so moving between folders reuses them.
  const about = Promise.all([
    repoData.graphNode(owner, name, "repo").catch(() => null),
    repoData.ciRuns(owner, name).catch(() => null),
  ]).then(([knowledge, ci]) => ({ knowledge, ci }));
  return { tree: tree as TreeResponse, about };
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
  change,
}: {
  repo: RepoDetail;
  refName: string;
  entry: TreeEntry;
  change?: { latest: CommitSummary; count: number };
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
    <li className="grid gap-x-4 px-4 py-2 sm:grid-cols-[minmax(10rem,1fr)_minmax(0,2fr)]">
      {entry.type === "gitlink" ? (
        <span className="flex min-h-8 min-w-0 items-center gap-3 text-ink-muted" title="Submodule">
          {label}
        </span>
      ) : (
        <PrefetchLink
          to={to}
          className="flex min-h-8 min-w-0 items-center gap-3 text-ink no-underline transition-colors hover:underline"
        >
          {label}
        </PrefetchLink>
      )}
      <div className="min-h-11 min-w-0 pl-7 sm:pl-0">
        {change ? (
          <>
            <div className="flex min-w-0 items-center gap-3">
              <Link
                to={treeUrl(repo.owner.slug, repo.name, change.latest.oid)}
                className="min-w-0 flex-1 truncate text-body-sm text-ink-muted no-underline hover:underline"
                title={firstLine(change.latest.message)}
              >
                {firstLine(change.latest.message)}
              </Link>
              <Link
                to={commitsUrl(repo.owner.slug, repo.name, refName, entry.path)}
                className="shrink-0 text-micro text-ink-faint no-underline hover:underline"
                title={fullDate(change.latest.authoredAt)}
              >
                {timeAgo(change.latest.authoredAt)}
              </Link>
            </div>
            <div className="truncate" title={change.latest.message}>
              <Attribution commit={change.latest} />
            </div>
          </>
        ) : (
          <Link
            to={commitsUrl(repo.owner.slug, repo.name, refName, entry.path)}
            className="text-body-sm text-ink-faint no-underline hover:underline"
          >
            View history
          </Link>
        )}
      </div>
    </li>
  );
}

function FileList({ repo, tree }: { repo: RepoDetail; tree: TreeResponse }) {
  const state = useHistory(repo, tree.commit.oid, tree.path, true);
  const history = state.history;
  const latest = history?.commits[0] ?? (!tree.path ? tree.commit : null);
  return (
    <section className="overflow-hidden rounded-pane bg-pane" aria-label="Repository files">
      <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
        {latest ? (
          <CommitInfo repo={repo} commit={latest} />
        ) : (
          <span className="mr-auto text-body-sm text-ink-faint">Folder history</span>
        )}
        <Link
          className="mk-btn mk-btn--sm no-underline"
          to={commitsUrl(repo.owner.slug, repo.name, tree.commit.oid, tree.path)}
        >
          {history ? countLabel(history.commits.length, !!history.next) : "History"}
        </Link>
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
          <EntryRow
            key={entry.path}
            repo={repo}
            refName={tree.ref}
            entry={entry}
            change={
              history && Object.hasOwn(history.entries, entry.path)
                ? history.entries[entry.path]
                : undefined
            }
          />
        ))}
      </ul>
      {(state.loading || state.error || history?.next) && (
        <div className="border-t border-line-soft px-4 py-3">
          <HistoryProgress state={state} />
        </div>
      )}
    </section>
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
      <p className="mk-card-desc max-w-[48ch]">
        This repository is empty. From an existing project, add it as a remote and push. Git asks
        for a password: use a{" "}
        <Link to="/settings/tokens" className={link}>
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
  const { tree, about } = useLoaderData<typeof codeLoader>();
  const repo = useRepo();
  const navigate = useNavigate();
  if (!tree) return <EmptyRepo repo={repo} />;

  return (
    <div className="grid gap-x-8 gap-y-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <RefBar
          repo={repo}
          refName={tree.ref}
          path={tree.path}
          view="tree"
          onSwitch={(ref) => navigate(treeUrl(repo.owner.slug, repo.name, ref, tree.path))}
        />

        <FileList
          key={`${repo.id}:${tree.ref}:${tree.commit.oid}:${tree.path}`}
          repo={repo}
          tree={tree}
        />

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
      <aside aria-label="About this repository" className={`hidden xl:block ${railClass}`}>
        <Suspense fallback={null}>
          <Await resolve={about} errorElement={null}>
            {(data: Awaited<NonNullable<typeof about>>) => <About repo={repo} {...data} />}
          </Await>
        </Suspense>
      </aside>
    </div>
  );
}
