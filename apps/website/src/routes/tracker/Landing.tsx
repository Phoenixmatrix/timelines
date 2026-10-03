// A timeline's landing (CORE-77), in the timeline inspector: where its newest
// landing stands per repository (merging into main, testing the merge, main
// advanced), why it stopped, and a Land button that queues the head
// checkpoint or says why it can't land yet.

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { Landing, LandingRepo, LandResult, Timeline } from "../../../shared/timelines.ts";
import { link } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { shortOid } from "../../lib/format.ts";
import { repoPath, treeUrl } from "../../lib/refs.ts";

const STATE: Record<Landing["state"], string> = {
  merging: "Merging into main",
  testing: "Testing the merge",
  advancing: "Advancing main",
  conflict: "Stopped: conflicts with main",
  failed: "Stopped",
  landed: "Landed",
};

const REPO_STATE: Record<LandingRepo["state"], string> = {
  merging: "merging",
  testing: "testing",
  tested: "passed",
  advanced: "main advanced",
  conflict: "conflict",
  failed: "failed",
};

export function LandingPanel({
  owner,
  timeline,
  onChange,
}: {
  owner: string;
  timeline: Timeline;
  /** After a landing was queued: the timeline's status changed. */
  onChange: () => void;
}) {
  const path = `/tracker/${encodeURIComponent(owner)}/timelines/${encodeURIComponent(timeline.slug)}`;
  const [landing, setLanding] = useState<Landing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setLanding((await api<{ landing: Landing | null }>(`${path}/landing`)).landing);
    } catch {
      setLanding(null);
    }
  }, [path]);
  useEffect(() => {
    void load();
  }, [load, timeline.version]);
  const ended = timeline.status === "landed" || timeline.status === "abandoned";
  const active =
    landing?.state === "merging" || landing?.state === "testing" || landing?.state === "advancing";
  const land = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<LandResult>(`${path}/land`, { method: "POST", json: {} });
      setLanding(result.landing);
      onChange();
    } catch (failure) {
      setError(
        failure instanceof ApiError || failure instanceof Error ? failure.message : String(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  if (ended && !landing) return null;
  return (
    <section aria-labelledby={`landing-${timeline.id}`}>
      <div className="mt-4 mb-1 flex items-center gap-2">
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
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void land()}
          >
            {landing && landing.state !== "landed" ? "Land again" : "Land"}
          </button>
        )}
      </div>
      {!landing ? (
        <p className="m-0 text-body-sm text-ink-faint">
          {timeline.policy === "auto"
            ? "Lands once a checkpoint's CI is green: its merge into main is tested before main moves."
            : "Lands once a person approves a checkpoint: its merge into main is tested before main moves."}
        </p>
      ) : (
        <>
          <p className="m-0 text-body-sm">
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
                  <Link className={link} to={treeUrl(repo.owner, repo.name, repo.merge)}>
                    merge <span className="mk-mono">{shortOid(repo.merge)}</span>
                  </Link>
                )}
                {[repo.mergeRun, repo.gateRun].map(
                  (run, i) =>
                    run &&
                    run.number > 0 && (
                      <Link
                        key={i}
                        className={link}
                        to={repoPath(repo.owner, repo.name, "ci", String(run.number))}
                      >
                        {i === 0 ? "Merge" : "Gates"} #{run.number}
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
