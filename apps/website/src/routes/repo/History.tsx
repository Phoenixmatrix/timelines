import { useEffect, useState } from "react";
import { Link } from "react-router";
import type {
  CommitSummary,
  HistoryPage,
  RepoDetail,
  SourceLineage,
  TreeEntry,
} from "../../../shared/api.ts";
import { CommitLink } from "../../components/CommitLink.tsx";
import { coAuthors } from "../../lib/commitAttribution.ts";
import { firstLine, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { commitsUrl, treeUrl } from "../../lib/refs.ts";
import { repoData } from "../../lib/repoData.ts";
import { api } from "../../lib/api.ts";
import { LinkedText } from "../../refs/RefLink.tsx";

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
  entries?: readonly TreeEntry[],
  initial?: HistoryPage,
) {
  const seeded = initial !== undefined;
  const [history, setHistory] = useState<HistoryPage | null>(initial ?? null);
  const [cursor, setCursor] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState(false);
  const withEntries = entries !== undefined;
  // Resolve the whole directory with shared, bounded history pages, not one
  // walk per row. Stop as soon as every visible entry has its newest change:
  // usually after the first, which the server extends until then (cover).
  const next = history?.next;
  const seeking = !!next && entries?.some((entry) => !Object.hasOwn(history!.entries, entry.path));
  useEffect(() => {
    if (seeking && !loading && !error && next) setCursor(next);
  }, [seeking, loading, error, next]);
  useEffect(() => {
    if (!head || (seeded && !cursor)) return;
    let current = true;
    setLoading(true);
    setError(false);
    repoData
      .history(
        repo.space.slug,
        repo.name,
        `${head}${path ? `/${path}` : ""}`,
        withEntries,
        cursor,
        repo.source?.sourceId,
      )
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
  }, [
    repo.space.slug,
    repo.name,
    repo.source?.sourceId,
    head,
    path,
    withEntries,
    cursor,
    attempt,
    seeded,
  ]);
  return {
    history,
    loading: loading || (!!seeking && !error),
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
      {/* Refs in the title link to what they name; the rest opens the commit panel (CORE-22). */}
      <span className="block truncate font-semibold" title={firstLine(commit.message)}>
        <LinkedText
          text={firstLine(commit.message)}
          plain={(text) =>
            // The commit panel reads canonical history; a work source's commit opens in its own source.
            repo.source && repo.source.sourceId !== "canonical" ? (
              <Link
                className="text-ink no-underline hover:underline"
                to={treeUrl(repo.space.slug, repo.name, commit.oid, "", repo.source.sourceId)}
              >
                {text}
              </Link>
            ) : (
              <CommitLink
                className="text-ink no-underline hover:underline"
                space={repo.space.slug}
                name={repo.name}
                sha={commit.oid}
              >
                {text}
              </CommitLink>
            )
          }
        />
      </span>
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
          to={commitsUrl(repo.space.slug, repo.name, head, path, repo.source?.sourceId)}
        >
          {history ? countLabel(history.commits.length, !!history.next) : "File history"}
        </Link>
      </div>
      <HistoryProgress state={state} />
    </section>
  );
}

/** A receipt is evidence of exact source membership, not a claim of Git ancestry. */
export function SourceHistory({ repo, head }: { repo: RepoDetail; head: string | null }) {
  const source = repo.source;
  const path =
    source?.kind === "timeline-work" && head
      ? `/repos/${encodeURIComponent(repo.space.slug)}/${encodeURIComponent(repo.name)}/sources/${encodeURIComponent(source.sourceId)}/lineage?commit=${encodeURIComponent(head)}`
      : null;
  const [state, setState] = useState<{
    path: string;
    receipt?: SourceLineage;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    api<SourceLineage>(path).then(
      (receipt) => live && setState({ path, receipt }),
      (error: unknown) =>
        live && setState({ path, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  if (!path || !source) return null;
  const current = state?.path === path ? state : null;
  const receipt = current?.receipt;
  return (
    <section aria-label="Source history" className="border-b border-line-soft pb-3 text-body-sm">
      <p className="m-0 font-semibold">Timeline progress history</p>
      <p className="m-0 mt-1 break-all text-ink-muted">
        <code className="mk-mono">{source.sourceId}</code>
        {" · "}Progress is stored separately from canonical history.
      </p>
      <div className="mt-1 text-ink-muted" aria-live="polite">
        {current?.error ? (
          <span role="alert">{current.error}</span>
        ) : !receipt ? (
          "Loading integration receipt…"
        ) : receipt.integration ? (
          <>
            Integrated result{" "}
            <Link
              to={treeUrl(
                repo.space.slug,
                repo.name,
                receipt.integration.canonical.commit,
                "",
                "canonical",
              )}
            >
              <code className="mk-mono">{receipt.integration.canonical.commit.slice(0, 7)}</code>
            </Link>
            {". The source snapshot is admitted by receipt, not as a canonical ancestor."}
          </>
        ) : receipt.status === "expired" ? (
          "This source has expired; its progress objects are no longer retained."
        ) : receipt.status === "ambiguous" ? (
          "No unique integration receipt. Sync requires an explicit source anchor."
        ) : receipt.status === "pending" ? (
          "Not integrated into canonical history."
        ) : (
          "No integration receipt records this exact commit."
        )}
      </div>
    </section>
  );
}
