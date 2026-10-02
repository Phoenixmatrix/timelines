import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { CommitSummary, HistoryPage, RepoDetail } from "../../../shared/api.ts";
import { coAuthors } from "../../lib/commitAttribution.ts";
import { firstLine, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { commitsUrl, treeUrl } from "../../lib/refs.ts";
import { repoData } from "../../lib/repoData.ts";

export function mergeHistory(previous: HistoryPage | null, page: HistoryPage): HistoryPage {
  if (!previous) return page;
  const entries = { ...previous.entries };
  for (const [path, entry] of Object.entries(page.entries)) {
    const old = Object.hasOwn(entries, path) ? entries[path] : undefined;
    Object.defineProperty(entries, path, {
      value: { latest: old?.latest ?? entry.latest, count: (old?.count ?? 0) + entry.count },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return {
    ...page,
    scanned: previous.scanned + page.scanned,
    commits: [...previous.commits, ...page.commits],
    entries,
  };
}

/** Mount under a head/path key: history never mixes snapshots when a branch moves. */
export function useHistory(
  repo: RepoDetail,
  head: string | null,
  path: string,
  entries = false,
  initial?: HistoryPage,
) {
  const seeded = initial !== undefined;
  const [history, setHistory] = useState<HistoryPage | null>(initial ?? null);
  const [cursor, setCursor] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!head || (seeded && !cursor)) return;
    let current = true;
    setLoading(true);
    setError(false);
    repoData
      .history(repo.owner.slug, repo.name, `${head}${path ? `/${path}` : ""}`, entries, cursor)
      .then(
        (page) => {
          if (current) {
            setHistory((previous) => mergeHistory(previous, page));
            setLoading(false);
          }
        },
        () => {
          if (current) {
            setError(true);
            setLoading(false);
          }
        },
      );
    return () => {
      current = false;
    };
  }, [repo.owner.slug, repo.name, head, path, entries, cursor, attempt, seeded]);
  return {
    history,
    loading,
    error,
    more: () => setCursor(history?.next ?? ""),
    retry: () => setAttempt((n) => n + 1),
  };
}
export type HistoryState = ReturnType<typeof useHistory>;
export function countLabel(count: number, incomplete: boolean) {
  return `${count}${incomplete ? "+" : ""} ${count === 1 && !incomplete ? "commit" : "commits"}`;
}
export function Attribution({ commit }: { commit: CommitSummary }) {
  const others = coAuthors(commit.message).filter(
    (person) => person.email.toLowerCase() !== commit.authorEmail.toLowerCase(),
  );
  return (
    <span className="text-body-sm break-words text-ink-faint">
      <bdi title={commit.authorEmail}>{commit.authorName}</bdi>
      {others.length > 0 && (
        <>
          {" "}
          · Co-authored by{" "}
          {others.map((person, index) => (
            <span key={person.email}>
              {index > 0 && ", "}
              <bdi title={person.email}>{person.name}</bdi>
            </span>
          ))}
        </>
      )}
    </span>
  );
}
export function CommitInfo({ commit, repo }: { commit: CommitSummary; repo: RepoDetail }) {
  return (
    <div className="min-w-0 flex-1">
      <Link
        className="block truncate font-semibold text-ink no-underline hover:underline"
        to={treeUrl(repo.owner.slug, repo.name, commit.oid)}
        title={firstLine(commit.message)}
      >
        {firstLine(commit.message)}
      </Link>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Attribution commit={commit} />
        <time
          className="text-body-sm text-ink-faint"
          dateTime={new Date(commit.authoredAt * 1000).toISOString()}
          title={fullDate(commit.authoredAt)}
        >
          {timeAgo(commit.authoredAt)}
        </time>
        <span className="mk-mono text-micro text-ink-faint">{shortOid(commit.oid)}</span>
      </div>
    </div>
  );
}
export function HistoryProgress({ state }: { state: HistoryState }) {
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-body-sm text-ink-faint"
      aria-live="polite"
    >
      {state.error ? (
        <>
          <span>Could not load history.</span>
          <button className="mk-btn mk-btn--sm" onClick={state.retry}>
            Retry history
          </button>
        </>
      ) : state.loading ? (
        <span>Loading history…</span>
      ) : state.history?.next ? (
        <>
          <span>Counts cover the latest {state.history.scanned} commits.</span>
          <button className="mk-btn mk-btn--sm" onClick={state.more}>
            Load older history
          </button>
        </>
      ) : null}
    </div>
  );
}
export function FileHistory({
  repo,
  head,
  path,
}: {
  repo: RepoDetail;
  head: string;
  path: string;
}) {
  const state = useHistory(repo, head, path);
  const history = state.history;
  return (
    <section aria-label="File history" className="rounded-pane bg-pane px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        {history?.commits[0] ? (
          <CommitInfo commit={history.commits[0]} repo={repo} />
        ) : (
          <span className="mr-auto text-body-sm text-ink-faint">
            {history ? "No changes in the history loaded so far." : "Last change"}
          </span>
        )}
        <Link
          className="mk-btn mk-btn--sm no-underline"
          to={commitsUrl(repo.owner.slug, repo.name, head, path)}
        >
          {history ? countLabel(history.commits.length, !!history.next) : "File history"}
        </Link>
      </div>
      <HistoryProgress state={state} />
    </section>
  );
}
