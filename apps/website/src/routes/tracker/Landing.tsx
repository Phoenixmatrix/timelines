// A timeline's landing (CORE-77), in the timeline inspector: where its newest
// landing stands per repository (merging into main, testing the merge, main
// advanced), why it stopped, and a Land button that queues the head
// checkpoint (named on the button) or says why it can't land yet.

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type {
  CheckpointView,
  Landing,
  LandingRepo,
  LandResult,
  Timeline,
} from "../../../shared/timelines.ts";
import { link } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { shortOid } from "../../lib/format.ts";
import { repoPath, treeUrl } from "../../lib/refs.ts";
import { commitPanelUrl } from "../../lib/commitPanel.ts";
import { timelinePageUrl } from "./TimelineNav.tsx";

const STATE: Record<Landing["state"], string> = {
  merging: "Preparing the result on main",
  testing: "Testing the result",
  advancing: "Advancing main",
  conflict: "Stopped: conflicts with main",
  failed: "Stopped",
  blocked_dependency: "Blocked: dependency needs integration",
  landed: "Landed",
};

const REPO_STATE: Record<LandingRepo["state"], string> = {
  merging: "merging",
  testing: "testing",
  tested: "passed",
  advanced: "main advanced",
  conflict: "conflict",
  failed: "failed",
  blocked_dependency: "blocked dependency",
};

export function LandingPanel({
  owner,
  timeline,
  checkpoints,
  failed,
  onChange,
}: {
  owner: string;
  timeline: Timeline;
  /** The timeline's checkpoints: `null` while loading or when they failed. */
  checkpoints: CheckpointView[] | null;
  failed: boolean;
  /** After a landing was queued: the timeline's status changed. */
  onChange: () => void;
}) {
  const path = `/tracker/${encodeURIComponent(owner)}/timelines/${encodeURIComponent(timeline.slug)}`;
  const [landing, setLanding] = useState<Landing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Queuing hides the Land button: focus goes to where the landing stands.
  const [queued, setQueued] = useState(false);
  const status = useRef<HTMLParagraphElement>(null);
  const load = useCallback(async () => {
    try {
      setLanding((await api<{ landing: Landing | null }>(`${path}/landing`)).landing);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load, timeline.version]);
  // The head checkpoint is what Land queues; with none there is nothing to land (CORE-382).
  const head = checkpoints?.reduce<number | null>(
    (newest, view) => Math.max(newest ?? 0, view.checkpoint.number),
    null,
  );
  const empty = checkpoints !== null && checkpoints.length === 0;
  const checking = checkpoints === null && !failed;
  const ended = timeline.status === "landed" || timeline.status === "abandoned";
  const active =
    landing?.state === "merging" || landing?.state === "testing" || landing?.state === "advancing";
  useEffect(() => {
    if (!queued) return;
    setQueued(false);
    const lost = !document.activeElement || document.activeElement === document.body;
    if (active && lost) status.current?.focus();
  }, [queued, active]);
  const land = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<LandResult>(`${path}/land`, { method: "POST", json: {} });
      setLanding(result.landing);
      setQueued(true);
      onChange();
    } catch (failure) {
      setError(
        failure instanceof ApiError || failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  if (ended && !landing && !error) return null;
  return (
    <section aria-labelledby={`landing-${timeline.id}`}>
      <div className="mt-4 mb-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3
          id={`landing-${timeline.id}`}
          className="m-0 flex-1 text-body-sm font-semibold text-ink-muted"
        >
          Landing
        </h3>
        {!ended && !active && (
          <button
            type="button"
            className="mk-btn mk-btn--sm"
            // A real `disabled` where there is nothing to land; while it works the
            // button stays focusable, so only `aria-disabled`.
            disabled={empty || checking}
            aria-describedby={empty ? `land-why-${timeline.id}` : undefined}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            onClick={() => {
              if (!busy) void land();
            }}
          >
            {`Land${head ? ` checkpoint #${head}` : ""}${landing && landing.state !== "landed" ? " again" : ""}`}
          </button>
        )}
      </div>
      {!ended && !active && empty && (
        <p id={`land-why-${timeline.id}`} className="m-0 mb-1 text-body-sm text-ink-muted">
          Needs a checkpoint first: push, then{" "}
          <code className="mk-mono">gm timeline checkpoint</code>.
        </p>
      )}
      {!landing ? (
        <p className="m-0 text-body-sm text-ink-faint">
          {timeline.policy === "auto"
            ? "Lands once a checkpoint's CI is green: its compact result is tested before main moves."
            : "Lands once a person approves a checkpoint: its compact result is tested before main moves."}
        </p>
      ) : (
        <>
          <p ref={status} tabIndex={-1} className="m-0 text-body-sm">
            Checkpoint #{landing.checkpointNumber}: <strong>{STATE[landing.state]}</strong>
          </p>
          <ul className="m-0 mt-1 list-none p-0">
            {landing.repos.map((repo) => (
              <li
                key={repo.id}
                className="flex flex-wrap items-baseline gap-x-3 py-0.5 text-body-sm text-ink-muted"
              >
                <span className="min-w-0 truncate text-ink">
                  {repo.owner}/{repo.name}
                </span>
                <span>{REPO_STATE[repo.state]}</span>
                {repo.merge && (
                  <Link className={link} to={commitPanelUrl(repo.owner, repo.name, repo.merge)}>
                    {repo.source?.kind === "timeline-work"
                      ? repo.state === "advanced"
                        ? repo.noop
                          ? "no-op receipt"
                          : "Landed commit"
                        : "compact candidate"
                      : "historical merge"}{" "}
                    <span className="mk-mono">{shortOid(repo.merge)}</span>
                  </Link>
                )}
                {repo.source && (
                  <Link
                    className={link}
                    to={treeUrl(repo.owner, repo.name, repo.commit, "", repo.source.sourceId)}
                  >
                    approved source <span className="mk-mono">{shortOid(repo.commit)}</span>
                  </Link>
                )}
                <Link
                  className={link}
                  to={timelinePageUrl(owner, timeline.slug, "changes", {
                    checkpoint: String(landing.checkpointNumber),
                    repo: `${repo.owner}/${repo.name}`,
                  })}
                >
                  Changes in #{landing.checkpointNumber}
                </Link>
                {repo.reason && <span className="basis-full break-words">{repo.reason}</span>}
                {repo.dependencies?.map((dependency) => (
                  <Link
                    key={`${dependency.source.sourceId}:${dependency.source.commit}`}
                    className={link}
                    to={treeUrl(
                      repo.owner,
                      repo.name,
                      dependency.source.commit,
                      "",
                      dependency.source.sourceId,
                    )}
                  >
                    dependency <span className="mk-mono">{shortOid(dependency.source.commit)}</span>
                  </Link>
                ))}
                {[repo.mergeRun, repo.gateRun].map(
                  (run, i) =>
                    run &&
                    run.number > 0 && (
                      <Link
                        key={i}
                        className={link}
                        to={repoPath(repo.owner, repo.name, "ci", String(run.number))}
                      >
                        {i === 0 ? "Preparation" : "Gates"} #{run.number}
                      </Link>
                    ),
                )}
              </li>
            ))}
          </ul>
          {landing.reason && (
            <p className="m-0 mt-1 text-body-sm text-ink-muted [overflow-wrap:anywhere]">
              {landing.reason}
            </p>
          )}
        </>
      )}
      {error && (
        <p className="mk-error m-0 mt-1" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
