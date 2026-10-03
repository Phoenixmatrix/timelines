// A timeline checkpoint, as an approval request shows it (CORE-76): what the
// agent says it holds, the commit per repository and the main commit it would
// land on, its CI runs and previews, and the timeline's knowledge diff. An
// approval only counts while the checkpoint is still the timeline's head.

import { Link } from "react-router";
import type { CheckpointView } from "../../../shared/timelines.ts";
import type { RequestCheckpoint } from "../../../shared/tracker.ts";
import { CiStatusIcon, ciLabel } from "../../components/CiStatus.tsx";
import { shortOid } from "../../lib/format.ts";
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

export function CheckpointPanel({
  view,
  tracker,
}: {
  view: CheckpointView;
  /** The tracker account's slug, for the timeline link. */
  tracker: string;
}) {
  const { checkpoint, timeline } = view;
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
              {previews.map((preview) =>
                preview.url && preview.status === "active" ? (
                  <a key={preview.id} href={preview.url} target="_blank" rel="noreferrer">
                    Preview
                  </a>
                ) : (
                  <span key={preview.id} className="text-ink-faint">
                    Preview {preview.status}
                  </span>
                ),
              )}
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
    </section>
  );
}
