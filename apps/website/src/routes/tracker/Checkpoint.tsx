// A timeline checkpoint, as an approval request shows it (CORE-76): what the
// agent says it holds, the commit per repository and the main commit it would
// land on, its CI runs and previews, the timeline's knowledge diff, and the
// wiki pages written for it (CORE-84), pending while they're written. An
// approval only counts while the checkpoint is still the timeline's head.
// Any checkpoint's preview can be revived (CORE-79): a rebuild, marked so.
// Each repository leads with what a reviewer needs (commit, Review changes, a
// diffstat of what this checkpoint added, CI) and keeps the rest under Details
// (CORE-382); repositories this checkpoint left alone collapse to one line.

import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { CompareDiff } from "../../../shared/diff.ts";
import type {
  CheckpointList,
  CheckpointPreview,
  CheckpointRepo,
  CheckpointView,
  PreviewRevival,
} from "../../../shared/timelines.ts";
import type { RequestCheckpoint } from "../../../shared/tracker.ts";
import { CiStatusIcon, ciLabel } from "../../components/CiStatus.tsx";
import { PageSetSummary, pagesPending, useRefreshWhile } from "../../components/TimelinePages.tsx";
import { api } from "../../lib/api.ts";
import { fullDate, shortOid } from "../../lib/format.ts";
import { commitPanelUrl } from "../../lib/commitPanel.ts";
import { commitsUrl, repoPath, treeUrl } from "../../lib/refs.ts";
import { MERGED_IN, timelinePageUrl } from "./TimelineNav.tsx";
import { MarkdownText } from "./ui.tsx";

/** Just the reference, where the checkpoint's details aren't loaded (an issue's requests). */
export function CheckpointRef({ pinned }: { pinned: RequestCheckpoint }) {
  return (
    <p className="m-0 text-body-sm text-ink-muted">
      Approves checkpoint <strong className="text-ink">#{pinned.number}</strong> of timeline{" "}
      <code className="mk-mono">{pinned.timeline}</code>; Needs you shows its commits, CI and
      previews.
    </p>
  );
}

const REBUILT =
  "Rebuilt by reviving this checkpoint's preview, not the original: it can differ if the toolchain or seed changed since.";

/** One preview of a checkpoint: a link while it's up, its state otherwise. */
export function PreviewLink({ preview }: { preview: CheckpointPreview }) {
  const label = preview.revived ? "Preview (rebuilt)" : "Preview";
  const title = [
    preview.revived ? REBUILT : null,
    preview.tornDownAt ? `Expired ${fullDate(preview.tornDownAt)}` : null,
    !preview.tornDownAt && preview.expiresAt ? `Expires ${fullDate(preview.expiresAt)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return preview.url && (preview.status === "active" || preview.status === "sleeping") ? (
    <a href={preview.url} target="_blank" rel="noreferrer" title={title || undefined}>
      {label}
    </a>
  ) : (
    <span className="text-ink-faint" title={title || undefined}>
      {label} {preview.status}
    </span>
  );
}

/**
 * Revive a checkpoint's preview: Gitmatrix starts a preview `create` run in
 * each repository whose ci.yml opts in, at the checkpoint's commits.
 */
export function ReviveButton({
  view,
  tracker,
  onRevived,
}: {
  view: CheckpointView;
  tracker: string;
  onRevived?: (revival: PreviewRevival) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const live = view.previews.some((p) => p.status === "active" || p.status === "sleeping");
  const revive = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const revival = await api<PreviewRevival>(
        `/tracker/${encodeURIComponent(tracker)}/timelines/${encodeURIComponent(view.timeline.slug)}/checkpoints/${encodeURIComponent(view.checkpoint.id)}/revive`,
        { method: "POST" },
      );
      const name = (repoId: string) => {
        const repo = view.checkpoint.repos.find((r) => r.id === repoId);
        return repo ? `${repo.space}/${repo.name}` : repoId;
      };
      const started = revival.runs.filter((run) => "number" in run);
      setMessage({
        error: started.length === 0,
        text: revival.runs
          .map((run) =>
            "number" in run
              ? `${name(run.repoId)}: building in CI #${run.number}`
              : `${name(run.repoId)}: ${run.skipped}`,
          )
          .join(" · "),
      });
      onRevived?.(revival);
    } catch (failure) {
      setMessage({
        error: true,
        text: failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <button
        type="button"
        className="mk-btn mk-btn--ghost mk-btn--sm"
        // Not `disabled`: that would drop keyboard focus while it works.
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        title={
          live
            ? "A preview is up; reviving rebuilds it from this checkpoint's commits."
            : "Rebuild this checkpoint's preview from its commits (migrations plus seed)."
        }
        onClick={() => {
          if (!busy) void revive();
        }}
      >
        {busy ? "Reviving…" : "Revive preview"}
      </button>
      {message && (
        <span
          className={message.error ? "mk-error text-body-sm" : "text-body-sm text-ink-muted"}
          role={message.error ? "alert" : "status"}
        >
          {message.text}
        </span>
      )}
    </span>
  );
}

/**
 * The timeline's checkpoints, once loaded: `null` while loading, and `failed`
 * (with its `error`) when they couldn't be read (callers carry on without
 * them). Reloaded when `version` changes; another timeline's list is never
 * shown for this one (CORE-382).
 */
export function useCheckpoints(
  tracker: string,
  slug: string,
  version?: number | string,
): { checkpoints: CheckpointView[] | null; failed: boolean; error: string | null } {
  const key = `${tracker}/${slug}`;
  const [state, setState] = useState<{
    key: string;
    checkpoints: CheckpointView[] | null;
    error: string | null;
  }>({ key, checkpoints: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    api<CheckpointList>(
      `/tracker/${encodeURIComponent(tracker)}/timelines/${encodeURIComponent(slug)}/checkpoints`,
      { signal: controller.signal },
    )
      .then((loaded) => setState({ key, checkpoints: loaded.checkpoints, error: null }))
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            checkpoints: null,
            error: failure instanceof Error ? failure.message : String(failure),
          });
      });
    return () => controller.abort();
  }, [tracker, slug, key, version]);
  const mine = state.key === key;
  const error = mine ? state.error : null;
  return { checkpoints: mine ? state.checkpoints : null, failed: error !== null, error };
}

/** Where a repository's work in a checkpoint is read: its own source, or canonical history. */
function workSourceOf(repo: CheckpointRepo): string | null {
  return repo.source && repo.source.sourceId !== "canonical" ? repo.source.sourceId : null;
}

type Stat =
  | { state: "loading" }
  | { state: "failed" }
  | {
      state: "done";
      additions: number;
      deletions: number;
      files: number;
      more: boolean;
      /** The compared range holds a merge commit, such as main merged in. */
      merged: boolean;
    };

/**
 * What a checkpoint added in one repository, by the compare API: against the
 * previous checkpoint's commit, else main as the checkpoint saw it. Loads
 * quietly; a failure (413, too large, included) leaves `failed` for the caller
 * to fall back to the commit list.
 */
function useDiffstat(repo: CheckpointRepo, base: string | null, enabled: boolean): Stat {
  const [stat, setStat] = useState<Stat>({ state: "loading" });
  const workSource = workSourceOf(repo);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setStat({ state: "loading" });
    const query = new URLSearchParams({ head: repo.commit });
    if (base) query.set("base", base);
    if (workSource) query.set("source", workSource);
    api<CompareDiff>(
      `/repos/${encodeURIComponent(repo.space)}/${encodeURIComponent(repo.name)}/compare?${query}`,
      { signal: controller.signal },
    )
      .then((diff) =>
        setStat({
          state: "done",
          additions: diff.files.reduce((sum, file) => sum + file.additions, 0),
          deletions: diff.files.reduce((sum, file) => sum + file.deletions, 0),
          files: diff.files.length,
          more: diff.truncated,
          merged: diff.commits.some((commit) => commit.merge),
        }),
      )
      .catch(() => {
        if (!controller.signal.aborted) setStat({ state: "failed" });
      });
    return () => controller.abort();
  }, [repo.space, repo.name, repo.commit, base, workSource, enabled]);
  return stat;
}

/** "+A −D · F files": what this checkpoint added in one repository. */
function Diffstat({
  stat,
  fromCheckpoint,
}: {
  stat: Extract<Stat, { state: "done" }>;
  /** Measured from an earlier timeline commit, not from main. */
  fromCheckpoint: boolean;
}) {
  return (
    <span
      className="mk-tabular text-ink-muted"
      title={stat.merged && fromCheckpoint ? MERGED_IN : undefined}
    >
      <span className="text-online">+{stat.additions}</span>{" "}
      <span className="text-danger-text">
        {"\u2212"}
        {stat.deletions}
      </span>
      {" \u00b7 "}
      {stat.files === 0
        ? "no file changes"
        : `${stat.files}${stat.more ? "+" : ""} ${stat.files === 1 && !stat.more ? "file" : "files"}`}
    </span>
  );
}

/** One repository of a checkpoint: what a reviewer needs first, the rest under Details. */
function CheckpointRepoRow({
  repo,
  view,
  tracker,
  previous,
  ready,
}: {
  repo: CheckpointRepo;
  view: CheckpointView;
  tracker: string;
  /** The same repository in the previous checkpoint, where there is one. */
  previous: CheckpointRepo | null;
  /** The previous checkpoint is known (or there is none): the diffstat can start. */
  ready: boolean;
}) {
  const { checkpoint, timeline } = view;
  const runs = view.runs.filter((run) => run.repoId === repo.id);
  const previews = view.previews.filter((preview) => preview.repoId === repo.id);
  const readableSource =
    repo.source || timeline.status === "landed" || timeline.status === "abandoned";
  // The commit panel reads canonical history; a work source's commit opens in its own source.
  const workSource = workSourceOf(repo);
  const stat = useDiffstat(repo, previous?.commit ?? repo.base, Boolean(readableSource) && ready);
  const commitsLink = workSource
    ? commitsUrl(repo.space, repo.name, repo.commit, "", workSource)
    : commitPanelUrl(repo.space, repo.name, repo.commit);
  const changeCount = repo.changes.length === 1 ? "1 change" : `${repo.changes.length} changes`;
  const commitsLinkEl = (
    <Link
      to={commitsLink}
      className="text-ink-muted"
      title={repo.changes.map((c) => c.changeId).join("\n")}
    >
      {changeCount}
    </Link>
  );
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-semibold">
          {repo.space}/{repo.name}
        </span>
        {!readableSource ? (
          <span className="text-ink-muted">Source migration required</span>
        ) : workSource ? (
          <Link
            to={treeUrl(repo.space, repo.name, repo.commit, "", workSource)}
            className="mk-chip mk-chip--tag mk-mono no-underline"
            title={`Browse files at ${shortOid(repo.commit)}`}
          >
            {shortOid(repo.commit)}
          </Link>
        ) : (
          <Link
            to={commitPanelUrl(repo.space, repo.name, repo.commit)}
            className="mk-chip mk-chip--tag mk-mono no-underline"
            title={`Open commit ${shortOid(repo.commit)}`}
          >
            {shortOid(repo.commit)}
          </Link>
        )}
        {readableSource && (
          <Link
            to={timelinePageUrl(tracker, timeline.slug, "changes", {
              checkpoint: String(checkpoint.number),
              repo: `${repo.space}/${repo.name}`,
            })}
            className="mk-btn mk-btn--sm no-underline"
          >
            Review changes
          </Link>
        )}
        {readableSource &&
          (stat.state === "done" ? (
            <Diffstat stat={stat} fromCheckpoint={previous !== null} />
          ) : (
            // Loading, or compare could not answer (too large, say): the commit list.
            commitsLinkEl
          ))}
        {runs.length === 0 ? (
          <span className="text-ink-faint">No CI run</span>
        ) : (
          runs.map((run) => (
            <Link
              key={run.number}
              to={repoPath(repo.space, repo.name, "ci", String(run.number))}
              className="inline-flex items-center gap-1 no-underline"
              title={`CI run #${run.number}: ${ciLabel(run.status)}`}
            >
              <CiStatusIcon status={run.status} />
              <span>
                CI #{run.number} {ciLabel(run.status).toLowerCase()}
              </span>
            </Link>
          ))
        )}
        {previews.map((preview) => (
          <PreviewLink key={preview.id} preview={preview} />
        ))}
      </div>
      <details className="text-ink-muted">
        <summary className="w-fit cursor-pointer">Details</summary>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          {repo.base && (
            <span>
              onto main{" "}
              <Link
                to={commitPanelUrl(repo.space, repo.name, repo.base)}
                className="mk-mono"
                title="Main when the checkpoint was made"
              >
                {shortOid(repo.base)}
              </Link>
            </span>
          )}
          {repo.source?.kind === "timeline-work" && (
            <span title={repo.source.sourceId}>Work source</span>
          )}
          {repo.logicalBase && (
            <span>
              logical base{" "}
              <Link
                className="mk-mono"
                to={treeUrl(
                  repo.space,
                  repo.name,
                  repo.logicalBase.commit,
                  "",
                  repo.logicalBase.sourceId,
                )}
              >
                {shortOid(repo.logicalBase.commit)}
              </Link>
            </span>
          )}
          {repo.dependencies?.map((dependency) => (
            <span key={`${dependency.source.sourceId}:${dependency.source.commit}`}>
              depends on{" "}
              <Link
                className="mk-mono"
                to={treeUrl(
                  repo.space,
                  repo.name,
                  dependency.source.commit,
                  "",
                  dependency.source.sourceId,
                )}
              >
                {shortOid(dependency.source.commit)}
              </Link>
            </span>
          ))}
          {readableSource && stat.state === "done" && commitsLinkEl}
          <Link
            to={`${repoPath(repo.space, repo.name, "knowledge")}?timeline=${encodeURIComponent(timeline.slug)}`}
          >
            Knowledge diff
          </Link>
        </div>
      </details>
    </li>
  );
}

export function CheckpointPanel({
  view,
  tracker,
  name,
}: {
  view: CheckpointView;
  /** The tracker account's slug, for the timeline link. */
  tracker: string;
  /** How to name a person by id, for who approved it. */
  name?: (id: string) => string;
}) {
  const { checkpoint, timeline } = view;
  // Approved by the approver's own approve-when-green setting (CORE-378).
  const automatic = view.approved && view.approval?.via === "auto-approve";
  const approver = view.approval?.by ? (name?.(view.approval.by) ?? view.approval.by) : "someone";
  const whose = approver === "you" ? "your" : `${approver}\u2019s`;
  useRefreshWhile(view.knowledge.some(pagesPending));
  // What this checkpoint added is measured from the one before it, so a repository
  // is only called unchanged once that is known (or there is none before it).
  const { checkpoints, failed } = useCheckpoints(tracker, timeline.slug);
  const ready = checkpoint.number === 1 || checkpoints !== null || failed;
  const previous =
    checkpoints?.find((other) => other.checkpoint.number === checkpoint.number - 1)?.checkpoint ??
    null;
  const unchangedRepo = (repo: CheckpointRepo) => {
    if (!ready) return false;
    const before = previous?.repos.find((r) => r.id === repo.id);
    return before ? before.commit === repo.commit : !previous && repo.commit === repo.base;
  };
  const changed = checkpoint.repos.filter((repo) => !unchangedRepo(repo));
  const unchanged = checkpoint.repos.filter(unchangedRepo);
  return (
    <section
      className="flex flex-col gap-2 rounded-pane border border-line-soft p-3"
      aria-label={`Checkpoint #${checkpoint.number} of ${timeline.slug}`}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-body-sm">
        <strong>
          Checkpoint{" "}
          <Link
            to={timelinePageUrl(tracker, timeline.slug, "changes", {
              checkpoint: String(checkpoint.number),
            })}
            title={`Review what checkpoint #${checkpoint.number} changed`}
          >
            #{checkpoint.number}
          </Link>
        </strong>
        <span className="text-ink-muted">
          of <Link to={timelinePageUrl(tracker, timeline.slug, "changes")}>{timeline.name}</Link>
        </span>
        {!view.current && (
          <span
            className="mk-chip mk-chip--tag"
            title="New commits since: approve a new checkpoint"
          >
            Superseded
          </span>
        )}
        {view.approved && (
          <span className="mk-chip mk-chip--tag">
            {automatic ? "Approved automatically" : "Approved"}
          </span>
        )}
        <Link
          to={timelinePageUrl(tracker, timeline.slug, "overview")}
          className="ml-auto text-ink-muted"
        >
          Timeline overview
        </Link>
      </header>
      {automatic && (
        <p className="m-0 text-body-sm text-ink-muted">
          Approved automatically: {whose} approve-when-green setting, once its CI was green.
        </p>
      )}
      {!view.current && (
        <p className="m-0 text-body-sm text-ink-muted">
          The timeline has moved past this checkpoint. It can't be approved any more; its agent
          needs to make a new checkpoint and ask again.
        </p>
      )}
      {view.current && !view.approved && (
        <p className="m-0 text-body-sm text-ink-muted">
          {timeline.policy === "approval"
            ? "Approving lands the reviewed result as one compact commit on main, after its gates pass. Progress history stays in the work source."
            : "It lands once CI is green; the compact result is tested before main moves. Progress history stays in the work source."}
        </p>
      )}
      {checkpoint.summary && (
        <div className="max-w-[72ch] text-body">
          <MarkdownText text={checkpoint.summary} />
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-body-sm">
        {changed.map((repo) => (
          <CheckpointRepoRow
            key={repo.id}
            repo={repo}
            view={view}
            tracker={tracker}
            previous={previous?.repos.find((r) => r.id === repo.id) ?? null}
            ready={ready}
          />
        ))}
      </ul>
      {unchanged.length > 0 && (
        <p className="m-0 text-body-sm text-ink-muted">
          Unchanged: {unchanged.map((repo) => `${repo.space}/${repo.name}`).join(", ")}
        </p>
      )}
      <div>
        <ReviveButton view={view} tracker={tracker} />
      </div>
      {view.knowledge.map((set) => {
        const repo = checkpoint.repos.find((r) => r.id === set.repoId);
        if (!repo) return null;
        return (
          <section
            key={set.repoId}
            className="flex flex-col gap-1.5 border-t border-line-soft pt-2"
            aria-label={`Wiki pages in ${repo.space}/${repo.name}`}
          >
            <h4 className="m-0 text-body-sm font-semibold">
              Wiki pages
              {checkpoint.repos.length > 1 && (
                <span className="font-normal text-ink-muted">
                  {" "}
                  in {repo.space}/{repo.name}
                </span>
              )}
            </h4>
            <PageSetSummary set={set} space={repo.space} name={repo.name} />
          </section>
        );
      })}
    </section>
  );
}
