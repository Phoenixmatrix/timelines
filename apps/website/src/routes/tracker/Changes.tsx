// What a timeline changes (CORE-382): its work compared with main, what one
// checkpoint added, or what was done since one, per repository, with the
// commits behind it and the diff itself. Reached from Story, the timeline's
// panel and checkpoints; its commits link back into Story's steps.

import { useEffect, useMemo, useState } from "react";
import { Link, useLoaderData, useParams } from "react-router";
import type { CommitDiff, CompareDiff } from "../../../shared/diff.ts";
import type {
  CheckpointList,
  CheckpointView,
  TimelineDetail,
  TimelineEvent,
  Timeline,
  TimelineRepo,
} from "../../../shared/timelines.ts";
import { DiffView } from "../../components/DiffView.tsx";
import { link } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { commitPanelUrl } from "../../lib/commitPanel.ts";
import { fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { blobUrl, commitsUrl, sourceUrl } from "../../lib/refs.ts";
import { useLiveSearchParams } from "../../lib/searchParams.ts";
import { MERGED_IN, TimelineNav, timelinePageUrl } from "./TimelineNav.tsx";
import { storyLoader } from "./Story.tsx";

/** The same timeline record Story reads, with its events. */
export const changesLoader = storyLoader;

/** Which comparison is shown: everything, one checkpoint's addition, or what came after one. */
export type Mode =
  | { kind: "all" }
  | { kind: "checkpoint"; number: number }
  | {
      kind: "since";
      number: number;
    };

const positive = (value: string | null): number | null => {
  const n = Number(value);
  return value && Number.isInteger(n) && n > 0 ? n : null;
};

export function modeOf(params: URLSearchParams): Mode {
  const checkpoint = positive(params.get("checkpoint"));
  if (checkpoint) return { kind: "checkpoint", number: checkpoint };
  const since = positive(params.get("since"));
  if (since) return { kind: "since", number: since };
  return { kind: "all" };
}

/** What to compare in one repository: `base` unset means the default branch. */
export interface CompareRequest {
  base?: string;
  head: string;
  /**
   * A landing merge commit on main: show what it brought onto main instead of
   * comparing (CORE-382). For a timeline landed on a canonical bookmark, whose
   * tip main merged, so comparing with main is empty.
   */
  landed?: string;
}

/**
 * The commit or branch holding the timeline's work in a repository. Owned
 * sources keep their work ref after landing and abandoning pins its last
 * commit; for a canonical bookmark, a landing event pins the parent's tip.
 */
export function workHead(timeline: Timeline, events: TimelineEvent[], repo: TimelineRepo): string {
  for (const event of [...events].reverse()) {
    // Another timeline's abandonment pins that timeline's commits (CORE-382).
    if (
      event.kind === "abandon" &&
      event.timelineId === timeline.id &&
      event.lastCommits?.[repo.id]
    )
      return event.lastCommits[repo.id]!;
    if (
      repo.source?.kind !== "timeline-work" &&
      event.kind === "merge" &&
      event.fromId === timeline.id &&
      event.repoId === repo.id
    )
      return event.parent;
  }
  return repo.source?.ref.replace(/^refs\/heads\//, "") ?? repo.bookmark;
}

/**
 * The merge commit that landed a timeline on main in a repository whose work
 * source is canonical history (no timeline-work source), if it landed.
 */
export function landedMerge(
  timeline: Timeline,
  events: TimelineEvent[],
  repo: TimelineRepo,
): string | null {
  if (repo.source?.kind === "timeline-work") return null;
  const landing = events.findLast(
    (event) =>
      event.kind === "merge" &&
      event.fromId === timeline.id &&
      event.intoId === null &&
      event.repoId === repo.id,
  );
  return landing?.kind === "merge" ? landing.commit : null;
}

export function compareUrl(repo: TimelineRepo, request: CompareRequest): string {
  if (request.landed)
    return sourceUrl(
      `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/commits/${request.landed}/diff`,
      repo.source?.sourceId,
    );
  const query = new URLSearchParams({ head: request.head });
  if (request.base) query.set("base", request.base);
  return sourceUrl(
    `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/compare?${query}`,
    repo.source?.sourceId,
  );
}

/** Files, lines added and removed, as one summary of a comparison. */
export function diffStats(diff: CompareDiff) {
  return {
    files: diff.files.length,
    additions: diff.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: diff.files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/** How the request for a repository is made, or why it can't be. */
type Planned = CompareRequest | { waiting: true } | { problem: string };

function plan(
  timeline: Timeline,
  events: TimelineEvent[],
  repo: TimelineRepo,
  mode: Mode,
  checkpoints: CheckpointView[] | null,
): Planned {
  const head = workHead(timeline, events, repo);
  if (mode.kind === "all") {
    const landed = landedMerge(timeline, events, repo);
    return landed ? { head, landed } : { head };
  }
  if (!checkpoints) return { waiting: true };
  const commitAt = (number: number) =>
    checkpoints
      .find((view) => view.checkpoint.number === number)
      ?.checkpoint.repos.find((r) => r.id === repo.id)?.commit;
  const at = commitAt(mode.number);
  if (!checkpoints.some((view) => view.checkpoint.number === mode.number))
    return { problem: `This timeline has no checkpoint #${mode.number}.` };
  if (!at)
    return { problem: `Checkpoint #${mode.number} doesn't include ${repo.owner}/${repo.name}.` };
  if (mode.kind === "since") return { base: at, head };
  return { base: commitAt(mode.number - 1), head: at };
}

type Result =
  | {
      state: "ok";
      diff: CompareDiff;
      /** What a landing brought onto main, not a comparison with it. */
      landed?: boolean;
    }
  | { state: "error"; message: string; status: number | null };

/** A landing merge's diff against main as it was, in the shape of a comparison. */
function landedAsCompare(diff: CommitDiff): CompareDiff {
  const before = diff.parents[0] ?? diff.oid;
  return {
    base: before,
    head: diff.oid,
    from: before,
    mergeBase: before,
    historyTruncated: false,
    commits: [],
    commitsTruncated: false,
    files: diff.files,
    truncated: diff.truncated,
  };
}

/** Each repository's comparison, read in parallel; absent while loading. */
export function useCompares(
  entries: [TimelineRepo, CompareRequest][],
  version: number,
): Record<string, Result> {
  const key = JSON.stringify(entries.map(([repo, request]) => [repo.id, request]));
  const [loaded, setLoaded] = useState<{ key: string; results: Record<string, Result> }>({
    key: "",
    results: {},
  });
  useEffect(() => {
    const abort = new AbortController();
    const mine = `${key}#${version}`;
    setLoaded({ key: mine, results: {} });
    const put = (id: string, result: Result) =>
      setLoaded((prev) =>
        prev.key === mine ? { key: mine, results: { ...prev.results, [id]: result } } : prev,
      );
    for (const [repo, request] of entries)
      (request.landed
        ? api<CommitDiff>(compareUrl(repo, request), { signal: abort.signal }).then(
            (diff): Result => ({ state: "ok", diff: landedAsCompare(diff), landed: true }),
          )
        : api<CompareDiff>(compareUrl(repo, request), { signal: abort.signal }).then(
            (diff): Result => ({ state: "ok", diff }),
          )
      )
        .then((result) => put(repo.id, result))
        .catch((error: unknown) => {
          if (abort.signal.aborted) return;
          put(repo.id, {
            state: "error",
            status: error instanceof ApiError ? error.status : null,
            message: error instanceof Error ? error.message : "Couldn't compare these.",
          });
        });
    return () => abort.abort();
    // `entries` is rebuilt every render; `key` says when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
  return loaded.key === `${key}#${version}` ? loaded.results : {};
}

/** The timeline's checkpoints, for the modes that start from one. */
function useCheckpoints(owner: string, slug: string, version: number) {
  const [state, setState] = useState<{
    list: CheckpointView[] | null;
    error: string | null;
  }>({ list: null, error: null });
  useEffect(() => {
    const abort = new AbortController();
    api<CheckpointList>(
      `/tracker/${encodeURIComponent(owner)}/timelines/${encodeURIComponent(slug)}/checkpoints`,
      { signal: abort.signal },
    )
      .then((loaded) =>
        setState({
          list: [...loaded.checkpoints].sort((a, b) => a.checkpoint.number - b.checkpoint.number),
          error: null,
        }),
      )
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          setState({
            list: null,
            error: error instanceof Error ? error.message : "Couldn't read the checkpoints.",
          });
      });
    return () => abort.abort();
  }, [owner, slug, version]);
  return state;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function Stat({ diff }: { diff: CompareDiff }) {
  const { files, additions, deletions } = diffStats(diff);
  return (
    <>
      {plural(files, "file")}
      {diff.truncated ? "+" : ""} <span className="text-online">+{additions}</span>{" "}
      <span className="text-danger-text">−{deletions}</span>
    </>
  );
}

export function Changes() {
  const detail = useLoaderData() as TimelineDetail;
  const { timeline, events } = detail;
  const owner = useParams().owner ?? "";
  const [params, setParams] = useLiveSearchParams();
  const mode = modeOf(params);
  const repo =
    timeline.repos.find((r) => `${r.owner}/${r.name}` === params.get("repo")) ?? timeline.repos[0];
  const repoKey = repo ? `${repo.owner}/${repo.name}` : "";
  const [version, setVersion] = useState(0);
  const checkpoints = useCheckpoints(owner, timeline.slug, version);

  const planned = useMemo(
    () =>
      timeline.repos.map(
        (r) => [r, plan(timeline, events, r, mode, checkpoints.list)] as [TimelineRepo, Planned],
      ),
    // `mode` is rebuilt every render; its parts say when it changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, events, mode.kind, "number" in mode ? mode.number : 0, checkpoints.list],
  );
  const requests = planned.flatMap(([r, p]) => ("head" in p ? [[r, p] as const] : []));
  const results = useCompares(
    requests.map(([r, p]) => [r, p]),
    version,
  );
  const plannedFor = planned.find(([r]) => r === repo)?.[1];
  const result = repo ? results[repo.id] : undefined;
  const ended = timeline.status === "landed" || timeline.status === "abandoned";

  const shownQuery = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    if (timeline.repos.length > 1 && repoKey) next.set("repo", repoKey);
    for (const [name, value] of Object.entries(changes)) if (value) next.set(name, value);
    const search = next.size ? `?${next}` : "";
    return `${timelinePageUrl(owner, timeline.slug, "changes")}${search}`;
  };
  const setFile = (path: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("file", path);
        return next;
      },
      { replace: true },
    );

  return (
    <main className="mx-auto max-w-[110rem] px-4 py-4">
      <h1 className="m-0 mb-3 text-title-lg [overflow-wrap:anywhere]">{timeline.name}</h1>
      <TimelineNav
        owner={owner}
        slug={timeline.slug}
        current="changes"
        query={{ repo: timeline.repos.length > 1 ? repoKey : null }}
      />
      {!repo ? (
        <p className="m-0 text-body-sm text-ink-faint">This timeline has no repositories.</p>
      ) : (
        <>
          {timeline.repos.length > 1 && (
            <RepoSwitcher
              timeline={timeline}
              selected={repo}
              results={results}
              planned={planned}
              href={(r) => {
                const next = new URLSearchParams(params);
                next.set("repo", `${r.owner}/${r.name}`);
                next.delete("file");
                return `?${next}`;
              }}
            />
          )}
          <ModePanel
            mode={mode}
            repo={repo}
            result={result}
            checkpoints={checkpoints}
            href={shownQuery}
            onRetry={() => setVersion((v) => v + 1)}
          />
          <Body
            detail={detail}
            repo={repo}
            mode={mode}
            planned={plannedFor}
            result={result}
            ended={ended}
            file={params.get("file")}
            onFile={setFile}
            onRetry={() => setVersion((v) => v + 1)}
          />
        </>
      )}
    </main>
  );
}

function RepoSwitcher({
  timeline,
  selected,
  results,
  planned,
  href,
}: {
  timeline: Timeline;
  selected: TimelineRepo;
  results: Record<string, Result>;
  planned: [TimelineRepo, Planned][];
  href: (repo: TimelineRepo) => string;
}) {
  const others = timeline.repos.length - 1;
  return (
    <section aria-label="Repositories" className="mb-3">
      <p className="m-0 mb-2 text-body-sm text-ink-muted">
        Showing{" "}
        <strong className="mk-mono font-semibold text-ink">
          {selected.owner}/{selected.name}
        </strong>{" "}
        · {others} more {others === 1 ? "repository" : "repositories"}
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
        {timeline.repos.map((r) => {
          const result = results[r.id];
          const plan = planned.find(([p]) => p === r)?.[1];
          const current = r === selected;
          return (
            <li key={r.id}>
              <Link
                to={href(r)}
                aria-current={current ? "true" : undefined}
                className={`flex min-h-11 flex-col justify-center rounded-control px-3 py-1.5 text-body-sm no-underline ${current ? "bg-signal-wash text-ink" : "bg-pane text-ink-muted hover:bg-raised hover:text-ink"}`}
              >
                <span className="mk-mono font-semibold">
                  {r.owner}/{r.name}
                </span>
                <span className="text-micro text-ink-faint">
                  {result?.state === "ok" ? (
                    <Stat diff={result.diff} />
                  ) : result?.state === "error" ? (
                    "Unavailable"
                  ) : plan && "problem" in plan ? (
                    "Not in this checkpoint"
                  ) : (
                    "Loading…"
                  )}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Says in words what is being compared, and links to the other comparisons. */
function ModePanel({
  mode,
  repo,
  result,
  checkpoints,
  href,
  onRetry,
}: {
  mode: Mode;
  repo: TimelineRepo;
  result: Result | undefined;
  checkpoints: { list: CheckpointView[] | null; error: string | null };
  href: (changes: Record<string, string | null>) => string;
  onRetry: () => void;
}) {
  const diff = result?.state === "ok" ? result.diff : null;
  const landed = result?.state === "ok" && result.landed === true;
  const met = diff?.mergeBase ? ` (${shortOid(diff.mergeBase)})` : "";
  // A checkpoint compared with the one before it, in this repository.
  const previous =
    mode.kind === "checkpoint"
      ? checkpoints.list
          ?.find((view) => view.checkpoint.number === mode.number - 1)
          ?.checkpoint.repos.find((r) => r.id === repo.id)
      : undefined;
  const heading =
    landed && diff
      ? `What landing brought onto main (merge ${shortOid(diff.head)})`
      : mode.kind === "all"
        ? `Everything this timeline changes, compared with main${diff ? (diff.historyTruncated ? " directly" : ` where it last met it${met}`) : ""}`
        : mode.kind === "checkpoint"
          ? `What checkpoint #${mode.number} added`
          : `Since checkpoint #${mode.number}`;
  const detail =
    mode.kind === "checkpoint"
      ? previous
        ? `Compared with checkpoint #${mode.number - 1}.`
        : "Compared with main."
      : mode.kind === "since"
        ? "Work pushed after that checkpoint, up to the timeline's latest."
        : null;
  const list = checkpoints.list ?? [];
  return (
    <section aria-label="Comparison" className="mb-4 rounded-pane bg-pane p-4">
      <h2 className="m-0 text-title [overflow-wrap:anywhere]">{heading}</h2>
      {detail && <p className="mt-1 mb-0 text-body-sm text-ink-muted">{detail}</p>}
      {diff && !landed && mode.kind !== "all" && (previous || mode.kind === "since")
        ? diff.commits.some((commit) => commit.merge) && (
            <p className="mt-1 mb-0 text-body-sm text-ink-muted" role="note">
              {MERGED_IN}
            </p>
          )
        : null}
      {diff?.historyTruncated && (
        <p className="mt-1 mb-0 text-body-sm text-ink-muted" role="note">
          Where this meets main wasn&rsquo;t found within the search limit, so it is compared with
          main&rsquo;s tip directly and may show main&rsquo;s newer work as changes.
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
        {mode.kind !== "all" && (
          <Link className={`${link} inline-flex min-h-11 items-center lg:min-h-9`} to={href({})}>
            Everything vs main
          </Link>
        )}
        {checkpoints.error ? (
          <span className="text-body-sm">
            <span className="mk-error">{checkpoints.error}</span>{" "}
            <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={onRetry}>
              Retry
            </button>
          </span>
        ) : !checkpoints.list ? (
          <span className="text-body-sm text-ink-faint">Reading the checkpoints…</span>
        ) : list.length === 0 ? null : (
          <details open={mode.kind !== "all"} className="min-w-0 basis-full">
            <summary className="flex min-h-11 cursor-pointer items-center text-body-sm font-semibold text-ink-muted lg:min-h-9">
              Compare by checkpoint ({list.length})
            </summary>
            <ol className="m-0 max-h-60 list-none overflow-y-auto p-0">
              {[...list].reverse().map((view) => {
                const n = view.checkpoint.number;
                const on = (kind: "checkpoint" | "since") =>
                  mode.kind === kind && mode.number === n ? "page" : undefined;
                return (
                  <li
                    key={view.checkpoint.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line-soft py-1 text-body-sm first:border-t-0"
                  >
                    <span className="w-24 font-semibold">
                      #{n}{" "}
                      <time
                        className="text-micro font-normal text-ink-faint"
                        dateTime={view.checkpoint.createdAt}
                        title={fullDate(view.checkpoint.createdAt)}
                      >
                        {timeAgo(view.checkpoint.createdAt)}
                      </time>
                    </span>
                    <Link
                      className={`${link} inline-flex min-h-11 items-center lg:min-h-9`}
                      aria-current={on("checkpoint")}
                      to={href({ checkpoint: String(n) })}
                    >
                      What #{n} added
                    </Link>
                    <Link
                      className={`${link} inline-flex min-h-11 items-center lg:min-h-9`}
                      aria-current={on("since")}
                      to={href({ since: String(n) })}
                    >
                      Since #{n}
                    </Link>
                  </li>
                );
              })}
            </ol>
          </details>
        )}
      </div>
    </section>
  );
}

/** Links that open the work itself when its comparison can't be shown. */
function fallbacks(detail: TimelineDetail, repo: TimelineRepo): { to: string; label: string }[] {
  const { timeline, events } = detail;
  const out: { to: string; label: string }[] = [];
  const landing = events.findLast(
    (event) =>
      event.kind === "merge" &&
      event.fromId === timeline.id &&
      event.intoId === null &&
      event.repoId === repo.id,
  );
  if (landing?.kind === "merge")
    out.push({
      to: commitPanelUrl(repo.owner, repo.name, landing.commit),
      label: `The landing commit on main (${shortOid(landing.commit)})`,
    });
  out.push({
    to: commitsUrl(
      repo.owner,
      repo.name,
      workHead(timeline, events, repo),
      "",
      repo.source?.sourceId,
    ),
    label: "The commits",
  });
  return out;
}

function Body({
  detail,
  repo,
  mode,
  planned,
  result,
  ended,
  file,
  onFile,
  onRetry,
}: {
  detail: TimelineDetail;
  repo: TimelineRepo;
  mode: Mode;
  planned: Planned | undefined;
  result: Result | undefined;
  ended: boolean;
  file: string | null;
  onFile: (path: string) => void;
  onRetry: () => void;
}) {
  const { timeline } = detail;
  const owner = useParams().owner ?? "";
  const sourceId = repo.source?.sourceId;
  const alternatives = (
    <ul className="m-0 mt-2 list-none p-0 text-body-sm">
      {fallbacks(detail, repo).map((item) => (
        <li key={item.to}>
          <Link className={`${link} inline-flex min-h-11 items-center lg:min-h-9`} to={item.to}>
            {item.label}
          </Link>
        </li>
      ))}
    </ul>
  );
  if (planned && "problem" in planned)
    return <p className="m-0 rounded-pane bg-pane p-4 text-body-sm">{planned.problem}</p>;
  if (!result)
    return (
      <p className="m-0 text-body-sm text-ink-faint" role="status">
        Comparing {repo.owner}/{repo.name}…
      </p>
    );
  if (result.state === "error") {
    if (result.status === 413)
      return (
        <div className="rounded-pane bg-pane p-4" role="note">
          <p className="m-0 text-body-sm">
            These changes are too large to show here. Open the commits instead.
          </p>
          {alternatives}
        </div>
      );
    // A landed or abandoned timeline can outlive its work source.
    if (ended && (result.status === 404 || result.status === 410))
      return (
        <div className="rounded-pane bg-pane p-4" role="note">
          <p className="m-0 text-body-sm">
            This timeline is {timeline.status}, and its work in {repo.owner}/{repo.name} is no
            longer there to compare.
          </p>
          {alternatives}
        </div>
      );
    return (
      <div className="rounded-pane bg-pane p-4">
        <p className="mk-error m-0" role="alert">
          {result.message}
        </p>
        <button type="button" className="mk-btn mk-btn--sm mt-2" onClick={onRetry}>
          Retry
        </button>
        {alternatives}
      </div>
    );
  }
  const { diff } = result;
  const { files, additions, deletions } = diffStats(diff);
  if (files === 0 && diff.commits.length === 0)
    return (
      <div className="rounded-pane bg-pane p-4">
        <p className="m-0 text-body-sm text-ink-muted">
          {result.landed
            ? `Landing brought no file changes onto main in ${repo.owner}/${repo.name}.`
            : mode.kind === "all"
              ? "No changes compared with main yet."
              : mode.kind === "checkpoint"
                ? `Checkpoint #${mode.number} changed nothing in ${repo.owner}/${repo.name}.`
                : `Nothing has changed in ${repo.owner}/${repo.name} since checkpoint #${mode.number}.`}
        </p>
        {alternatives}
      </div>
    );
  const storyLink = (step?: string) =>
    timelinePageUrl(owner, timeline.slug, "story", {
      repo: detail.timeline.repos.length > 1 ? `${repo.owner}/${repo.name}` : null,
      step,
    });
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="m-0 text-body-sm text-ink-muted">
        <strong className="font-semibold text-ink">
          {plural(files, "file")}
          {diff.truncated ? "+" : ""}
        </strong>
        {" · "}
        <span className="mk-mono text-online">+{additions}</span>{" "}
        <span className="mk-mono text-danger-text">−{deletions}</span>
        {!result.landed && (
          <>
            {" · "}
            <strong className="font-semibold text-ink">
              {plural(diff.commits.length, "commit")}
              {diff.commitsTruncated ? "+" : ""}
            </strong>
          </>
        )}
      </p>
      {diff.commits.length > 0 && (
        <details open={diff.commits.length <= 8} className="rounded-pane bg-pane px-4 py-1">
          <summary className="flex min-h-11 cursor-pointer items-center text-body-sm font-semibold text-ink-muted">
            Commits ({diff.commits.length}
            {diff.commitsTruncated ? "+" : ""})
          </summary>
          <ol className="m-0 list-none p-0 pb-2">
            {diff.commits.map((commit) => (
              <li
                key={commit.oid}
                className="flex flex-wrap items-baseline gap-x-3 border-t border-line-soft py-1.5 text-body-sm first:border-t-0"
              >
                <Link
                  className={`${link} min-w-0 flex-1 [overflow-wrap:anywhere]`}
                  to={storyLink(commit.oid)}
                  title="Open this step in the story"
                >
                  {commit.summary || "(no description)"}
                </Link>
                <span className="text-micro text-ink-faint">{commit.authorName}</span>
                <time
                  className="text-micro text-ink-faint tabular-nums"
                  dateTime={new Date(commit.authoredAt * 1000).toISOString()}
                  title={fullDate(commit.authoredAt)}
                >
                  {timeAgo(commit.authoredAt)}
                </time>
                <Link
                  className="mk-mono text-micro text-ink-faint no-underline hover:underline"
                  to={sourceUrl(commitPanelUrl(repo.owner, repo.name, commit.oid), sourceId)}
                  title={`Open commit ${shortOid(commit.oid)} in ${repo.owner}/${repo.name}`}
                >
                  {shortOid(commit.oid)}
                </Link>
              </li>
            ))}
          </ol>
        </details>
      )}
      <DiffView
        files={diff.files}
        truncated={diff.truncated}
        selectedPath={file}
        onSelectPath={onFile}
        idPrefix="changes-diff"
        // A deleted file lives on where the comparison started.
        blobHref={(path) =>
          blobUrl(
            repo.owner,
            repo.name,
            diff.files.find((f) => f.path === path)?.status === "deleted" ? diff.from : diff.head,
            path,
            sourceId,
          )
        }
      />
    </div>
  );
}
