import {
  CubeIcon,
  FileIcon,
  FolderSimpleIcon,
  LinkSimpleIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";
import { Suspense, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import {
  Await,
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  type LoaderFunctionArgs,
} from "react-router";
import type {
  CommitSummary,
  RepoDetail,
  RepoIssueSummary,
  TreeEntry,
  TreeResponse,
} from "../../../shared/api.ts";
import { CopyField, link } from "../../components/ui.tsx";
import { coAuthors } from "../../lib/commitAttribution.ts";
import { firstLine, fullDate, timeAgo } from "../../lib/format.ts";
import { blobUrl, commitsUrl, treeUrl } from "../../lib/refs.ts";
import { CommitLink } from "../../components/CommitLink.tsx";
import { repoData, requestSource, routeData } from "../../lib/repoData.ts";
import { bookmarkIn, scopeOf } from "../../lib/timelineScope.ts";
import { api, ApiError } from "../../lib/api.ts";
import { PrefetchLink } from "../../components/PrefetchLink.tsx";
import { railClass } from "../../components/Rail.tsx";
import { useViewer } from "../../lib/session.ts";
import { LinkedText } from "../../refs/RefLink.tsx";
import { useRefMarkdown } from "../../refs/remark.tsx";
import { CommitInfo, HistoryProgress, countLabel, useHistory } from "./History.tsx";
import { About } from "./About.tsx";
import { RefBar } from "./RefPicker.tsx";
import { useRepo } from "./RepoLayout.tsx";

export async function codeLoader({ request, params }: LoaderFunctionArgs) {
  const owner = params.owner ?? "";
  const name = params.repo ?? "";
  const at = params["*"] ?? "";
  const source = await requestSource(owner, name, request);
  // In a timeline's scope (?tl=) the repository opens on the timeline's
  // bookmark when it has one; a path that names a branch keeps it.
  const scope = at ? null : scopeOf(new URL(request.url).search);
  // Otherwise the tree and the repo detail load in parallel; the server splits
  // the branch from the path, so neither waits for the other.
  const [repo, tree] = await Promise.all([
    routeData(repoData.detail(owner, name, source)),
    (scope
      ? repoData.detail(owner, name, source).then((detail) => {
          const bookmark = bookmarkIn(detail, scope);
          if (!bookmark && source)
            throw new ApiError(
              410,
              "This timeline's historical Git ref is unavailable. Open a recorded commit or select main explicitly.",
            );
          return bookmark ?? "";
        })
      : Promise.resolve(at)
    )
      .then((path) => repoData.tree(owner, name, path, source))
      .catch((error: unknown) => error),
  ]);
  if (!repo.head || repo.state !== "ready") return { tree: null, about: null };
  if (tree instanceof Error || !tree) {
    return { tree: await routeData(Promise.reject(tree)), about: null };
  }
  // The About rail is extra: it streams in beside the files and never holds
  // them up. Knowledge and CI reads are cached; readiness is read live.
  const about = Promise.all([
    source && source !== "canonical"
      ? Promise.resolve(null)
      : repoData.graphNode(owner, name, "repo").catch(() => null),
    repoData.ciRuns(owner, name, source).catch(() => null),
    api<RepoIssueSummary>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tracker/summary?${new URLSearchParams({ timeline: scopeOf(new URL(request.url).search) ?? "main" })}`,
      { signal: request.signal },
    ).catch(() => null),
  ]).then(([knowledge, ci, issues]) => ({ knowledge, ci, issues }));
  return { tree: tree as TreeResponse, about };
}

const ICONS = {
  tree: FolderSimpleIcon,
  blob: FileIcon,
  exec: FileIcon,
  symlink: LinkSimpleIcon,
  gitlink: CubeIcon,
} as const;

/**
 * One line per entry, GitHub-style: name, last commit message, and time in a
 * fixed column so every row lines up. The authors view adds who made that
 * commit; phones keep the name and time.
 */
const ROW = {
  compact: "grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_6.5rem]",
  authors:
    "grid-cols-[minmax(0,1fr)_minmax(0,7rem)_auto] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_minmax(0,1.25fr)_6.5rem]",
} as const;

/** A bare URL in a README, as react-markdown would link it. */
function readmeUrl(href: string, children: ReactNode) {
  return <a href={href}>{children}</a>;
}

/** A Markdown README; refs in it link when they resolve (CORE-22). */
function Readme({ text }: { text: string }) {
  const refs = useRefMarkdown(readmeUrl);
  return (
    <ReactMarkdown remarkPlugins={refs.remarkPlugins} components={refs.components}>
      {text}
    </ReactMarkdown>
  );
}

function EntryRow({
  repo,
  refName,
  entry,
  change,
  authors,
  loading,
}: {
  repo: RepoDetail;
  refName: string;
  entry: TreeEntry;
  change?: { latest: CommitSummary; count: number };
  authors: boolean;
  loading: boolean;
}) {
  const Icon = ICONS[entry.type];
  const to =
    entry.type === "tree"
      ? treeUrl(repo.owner.slug, repo.name, refName, entry.path, repo.source?.sourceId)
      : blobUrl(repo.owner.slug, repo.name, refName, entry.path, repo.source?.sourceId);
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
  const history = commitsUrl(
    repo.owner.slug,
    repo.name,
    refName,
    entry.path,
    repo.source?.sourceId,
  );
  const subject = change ? firstLine(change.latest.message) : "";
  return (
    <li
      className={`grid min-h-10 items-center gap-x-4 px-4 hover:bg-raised max-sm:min-h-11 ${authors ? ROW.authors : ROW.compact}`}
    >
      {entry.type === "gitlink" ? (
        <span className="flex min-w-0 items-center gap-3 text-ink-muted" title="Submodule">
          {label}
        </span>
      ) : (
        <PrefetchLink
          to={to}
          className="flex min-w-0 items-center gap-3 text-ink no-underline hover:underline"
        >
          {label}
        </PrefetchLink>
      )}
      <span className="min-w-0 truncate text-body-sm max-sm:hidden">
        {change ? (
          <LinkedText
            text={subject}
            plain={(text) =>
              // The commit panel reads canonical history; a work source's commit opens in its own source.
              repo.source && repo.source.sourceId !== "canonical" ? (
                <Link
                  to={treeUrl(
                    repo.owner.slug,
                    repo.name,
                    change.latest.oid,
                    "",
                    repo.source.sourceId,
                  )}
                  className="text-ink-muted no-underline hover:text-ink hover:underline"
                  title={`${subject} · ${change.latest.authorName}`}
                >
                  {text}
                </Link>
              ) : (
                <CommitLink
                  owner={repo.owner.slug}
                  name={repo.name}
                  sha={change.latest.oid}
                  className="text-ink-muted no-underline hover:text-ink hover:underline"
                  title={`${subject} · ${change.latest.authorName}`}
                >
                  {text}
                </CommitLink>
              )
            }
          />
        ) : (
          <span className="text-ink-faint">
            {loading ? "Finding last change…" : "Last change unavailable"}
          </span>
        )}
      </span>
      {authors && (
        <span className="min-w-0 truncate text-body-sm text-ink-faint">
          {change && <AuthorCell commit={change.latest} />}
        </span>
      )}
      <span className="text-right text-body-sm whitespace-nowrap text-ink-faint tabular-nums">
        {change && (
          <Link
            to={history}
            className="text-ink-faint no-underline hover:text-ink hover:underline"
            title={`${fullDate(change.latest.authoredAt)} · history of ${entry.name}`}
          >
            <time dateTime={new Date(change.latest.authoredAt * 1000).toISOString()}>
              {timeAgo(change.latest.authoredAt)}
            </time>
          </Link>
        )}
      </span>
    </li>
  );
}

/** The author, then "+2" for co-authors; every name is in the tooltip. */
function AuthorCell({ commit }: { commit: CommitSummary }) {
  const others = coAuthors(commit.message).filter(
    (person) => person.email.toLowerCase() !== commit.authorEmail.toLowerCase(),
  );
  const everyone = [commit.authorName, ...others.map((person) => person.name)].join(", ");
  return (
    <span title={others.length ? everyone : commit.authorEmail}>
      <bdi>{commit.authorName}</bdi>
      {others.length > 0 && <span> +{others.length}</span>}
    </span>
  );
}

const AUTHORS_KEY = "gitmatrix:files:authors";

/** The authors view is a per-browser preference; it works without storage. */
function useAuthorsView() {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(AUTHORS_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setOn(!on);
    try {
      if (on) localStorage.removeItem(AUTHORS_KEY);
      else localStorage.setItem(AUTHORS_KEY, "1");
    } catch {
      // The view still switches for this page.
    }
  };
  return [on, toggle] as const;
}

function FileList({ repo, tree }: { repo: RepoDetail; tree: TreeResponse }) {
  const state = useHistory(repo, tree.commit.oid, tree.path, tree.entries);
  const history = state.history;
  const latest = history?.commits[0] ?? (!tree.path ? tree.commit : null);
  const [authors, toggleAuthors] = useAuthorsView();
  return (
    <section className="overflow-hidden rounded-pane bg-pane" aria-label="Repository files">
      <div className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
        {latest ? (
          <CommitInfo repo={repo} commit={latest} />
        ) : (
          <span className="mr-auto text-body-sm text-ink-faint">Folder history</span>
        )}
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm aria-pressed:bg-signal-wash aria-pressed:text-ink max-sm:h-11 max-sm:w-11 max-sm:px-0"
          aria-pressed={authors}
          onClick={toggleAuthors}
          title={authors ? "Hide who last changed each file" : "Show who last changed each file"}
        >
          <UsersThreeIcon aria-hidden />
          <span className="max-sm:sr-only">Authors</span>
        </button>
        <Link
          className="mk-btn mk-btn--sm no-underline"
          to={commitsUrl(
            repo.owner.slug,
            repo.name,
            tree.commit.oid,
            tree.path,
            repo.source?.sourceId,
          )}
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
                repo.source?.sourceId,
              )}
              className="flex min-h-10 items-center gap-3 px-4 text-ink-muted no-underline hover:bg-raised max-sm:min-h-11"
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
            authors={authors}
            loading={state.loading}
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
  const { search } = useLocation();
  if (!tree) return <EmptyRepo repo={repo} />;

  return (
    <div className="grid gap-x-8 gap-y-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="flex min-w-0 flex-col gap-4">
        <RefBar
          repo={repo}
          refName={tree.ref}
          path={tree.path}
          view="tree"
          commit={tree.commit.oid}
          onSwitch={(ref) =>
            navigate(treeUrl(repo.owner.slug, repo.name, ref, tree.path, repo.source?.sourceId))
          }
        />

        <FileList
          key={`${repo.id}:${repo.source?.sourceId}:${tree.ref}:${tree.commit.oid}:${tree.path}`}
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
                  <Readme text={tree.readme.text} />
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
        {/* Never reuse a resolved private count while a different repository or scope loads. */}
        <Suspense
          key={`${repo.id}:${repo.source?.sourceId ?? "canonical"}:${scopeOf(search) ?? "main"}`}
          fallback={null}
        >
          <Await resolve={about} errorElement={null}>
            {(data: Awaited<NonNullable<typeof about>>) => <About repo={repo} {...data} />}
          </Await>
        </Suspense>
      </aside>
    </div>
  );
}
