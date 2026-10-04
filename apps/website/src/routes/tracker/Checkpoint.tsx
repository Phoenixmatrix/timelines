// A timeline checkpoint, as an approval request shows it (CORE-76): what the
// agent says it holds, the commit per repository and the main commit it would
// land on, its CI runs and previews, the timeline's knowledge diff, and the
// wiki pages written for it (CORE-84), pending while they're written. An
// approval only counts while the checkpoint is still the timeline's head.
// Any checkpoint's preview can be revived (CORE-79): a rebuild, marked so.

import { useState } from "react";
import { Link } from "react-router";
import type {
  CheckpointPreview,
  CheckpointView,
  PreviewRevival,
} from "../../../shared/timelines.ts";
import type { RequestCheckpoint } from "../../../shared/tracker.ts";
import { CiStatusIcon, ciLabel } from "../../components/CiStatus.tsx";
import { PageSetSummary, pagesPending, useRefreshWhile } from "../../components/TimelinePages.tsx";
import { api } from "../../lib/api.ts";
import { fullDate, shortOid } from "../../lib/format.ts";
import { commitsUrl, repoPath, treeUrl } from "../../lib/refs.ts";
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
    preview.tornDownAt ? `Torn down ${fullDate(preview.tornDownAt)}` : null,
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
        return repo ? `${repo.owner}/${repo.name}` : repoId;
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

export function CheckpointPanel({
  view,
  tracker,
}: {
  view: CheckpointView;
  /** The tracker account's slug, for the timeline link. */
  tracker: string;
}) {
  const { checkpoint, timeline } = view;
  useRefreshWhile(view.knowledge.some(pagesPending));
  return (
    <section
      className="flex flex-col gap-2 rounded-pane border border-line-soft p-3"
      aria-label={`Checkpoint #${checkpoint.number} of ${timeline.slug}`}
    >
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-body-sm">
        <strong>Checkpoint #{checkpoint.number}</strong>
        <span className="text-ink-muted">
          of{" "}
          <Link
            to={`/tracker/${encodeURIComponent(tracker)}/timelines?tl=${encodeURIComponent(timeline.slug)}`}
          >
            {timeline.name}
          </Link>
        </span>
        {!view.current && (
          <span
            className="mk-chip mk-chip--tag"
            title="New commits since: approve a new checkpoint"
          >
            Superseded
          </span>
        )}
        {view.approved && <span className="mk-chip mk-chip--tag">Approved</span>}
      </header>
      {!view.current && (
        <p className="m-0 text-body-sm text-ink-muted">
          The timeline has moved past this checkpoint. It can't be approved any more; its agent
          needs to make a new checkpoint and ask again.
        </p>
      )}
      {view.current && !view.approved && (
        <p className="m-0 text-body-sm text-ink-muted">
          {timeline.policy === "approval"
            ? "Approving lands it: the checkpoint is merged into main and tested, and main moves only if that passes."
            : "It lands once its CI is green; the merge into main is tested before main moves."}
        </p>
      )}
      {checkpoint.summary && (
        <div className="max-w-[72ch] text-body">
          <MarkdownText text={checkpoint.summary} />
        </div>
      )}
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-body-sm">
        {checkpoint.repos.map((repo) => {
          const runs = view.runs.filter((run) => run.repoId === repo.id);
          const previews = view.previews.filter((preview) => preview.repoId === repo.id);
          return (
            <li key={repo.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold">
                {repo.owner}/{repo.name}
              </span>
              <Link
                to={treeUrl(repo.owner, repo.name, repo.commit)}
                className="mk-chip mk-chip--tag mk-mono no-underline"
                title="Browse files at this commit"
              >
                {shortOid(repo.commit)}
              </Link>
              {repo.base && (
                <span className="text-ink-muted">
                  onto main{" "}
                  <Link
                    to={treeUrl(repo.owner, repo.name, repo.base)}
                    className="mk-mono"
                    title="Main when the checkpoint was made"
                  >
                    {shortOid(repo.base)}
                  </Link>
                </span>
              )}
              <Link
                to={commitsUrl(repo.owner, repo.name, repo.commit)}
                className="text-ink-muted"
                title={repo.changes.map((c) => c.changeId).join("\n")}
              >
                {repo.changes.length === 1 ? "1 change" : `${repo.changes.length} changes`}
              </Link>
              {runs.length === 0 ? (
                <span className="text-ink-faint">No CI run</span>
              ) : (
                runs.map((run) => (
                  <Link
                    key={run.number}
                    to={repoPath(repo.owner, repo.name, "ci", String(run.number))}
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
              <Link
                to={`${repoPath(repo.owner, repo.name, "knowledge")}?timeline=${encodeURIComponent(timeline.slug)}`}
                className="text-ink-muted"
              >
                Knowledge diff
              </Link>
            </li>
          );
        })}
      </ul>
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
            aria-label={`Wiki pages in ${repo.owner}/${repo.name}`}
          >
            <h4 className="m-0 text-body-sm font-semibold">
              Wiki pages
              {checkpoint.repos.length > 1 && (
                <span className="font-normal text-ink-muted">
                  {" "}
                  in {repo.owner}/{repo.name}
                </span>
              )}
            </h4>
            <PageSetSummary set={set} owner={repo.owner} name={repo.name} />
          </section>
        );
      })}
    </section>
  );
}
