// Timelines on the Knowledge tab: the picker that scopes the app to one
// (CORE-82/83), and the wiki pages written for it at its checkpoints or on
// demand (CORE-84), which an ended timeline keeps read-only (CORE-139). What
// the timeline changes is read in Atlas terms by AtlasTimeline.tsx (CORE-176).

import { useCallback, useEffect, useState } from "react";
import type {
  KnowledgeOverlaySummary,
  KnowledgePageSet,
  KnowledgePageSets,
} from "../../../shared/api.ts";
import { PageSetSummary, pagesPending, setLabel } from "../../components/TimelinePages.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { timeAgo } from "../../lib/format.ts";

/** Main, or one of the repository's timelines. */
export function TimelinePicker({
  overlays,
  value,
  onChange,
}: {
  overlays: KnowledgeOverlaySummary[];
  value: string | null;
  onChange: (timeline: string | null) => void;
}) {
  const live = overlays.filter((o) => !o.ended);
  const ended = overlays.filter((o) => o.ended);
  return (
    <label className="flex items-center gap-2 text-body-sm text-ink-muted">
      <span className="max-sm:sr-only">Timeline</span>
      <select
        className="mk-input"
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Main</option>
        {live.map((o) => (
          <option key={o.ref} value={o.timeline}>
            {o.ref}
          </option>
        ))}
        {ended.length > 0 && (
          <optgroup label="Ended">
            {ended.map((o) => (
              <option key={o.ref} value={o.timeline}>
                {o.ref} ({o.ended!.reason})
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </label>
  );
}

/**
 * The wiki pages written for a timeline: the newest set, earlier ones folded
 * away, each with the commit it describes and the main it was measured
 * against, relative to the map on screen. An ended timeline's are read-only;
 * a live one's can be asked for at the bookmark's tip (that writes pages with
 * a model, so only on a click). Browsing never writes any.
 */
export function TimelineWikiPages({
  repo,
  ref,
  canAsk,
  ended,
  note,
}: {
  repo: { owner: string; name: string };
  /** `timeline/<slug>`. */
  ref: string;
  /** The bookmark is there and its overlay has a main to compare with. */
  canAsk: boolean;
  ended: boolean;
  /** The newest set's main against the map on screen, in words. */
  note: string | null;
}) {
  const path = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/knowledge/overlay/pages?ref=${encodeURIComponent(ref)}`;
  const [sets, setSets] = useState<KnowledgePageSet[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    (signal?: AbortSignal) =>
      api<KnowledgePageSets>(path, { signal }).then(
        (r) => setSets(r.sets),
        (e: unknown) => {
          if (signal?.aborted) return;
          setError(e instanceof ApiError ? e.message : "Couldn't read the wiki pages.");
        },
      ),
    [path],
  );
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const pending = sets?.some(pagesPending) ?? false;
  // Look again every few seconds while pages are being written.
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => void load(), 5000);
    return () => clearTimeout(timer);
  }, [pending, sets, load]);
  const [newest, ...earlier] = sets ?? [];
  const ask = async () => {
    setAsking(true);
    setError(null);
    try {
      await api<KnowledgePageSet>(path, { method: "POST" });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't ask for the pages.");
    } finally {
      setAsking(false);
    }
  };
  const heading = (set: KnowledgePageSet) => (
    <span className="block text-micro text-ink-faint">
      At {setLabel(set)} · {timeAgo(set.finishedAt ?? set.requestedAt)}
    </span>
  );
  return (
    <section className="border-t border-line-soft py-3" aria-label="Timeline wiki pages">
      <h3 className="m-0 mb-1 text-body-sm font-semibold">Wiki pages</h3>
      {sets === null && !error ? (
        <p className="m-0 text-body-sm text-ink-faint" role="status">
          Reading the wiki pages…
        </p>
      ) : newest ? (
        <div className="flex flex-col gap-1.5">
          {heading(newest)}
          {note && <span className="block text-micro text-ink-faint">{note}</span>}
          <PageSetSummary set={newest} owner={repo.owner} name={repo.name} />
        </div>
      ) : (
        sets !== null && (
          <p className="m-0 text-body-sm text-ink-muted">
            {ended
              ? "None were written before this timeline ended."
              : "Written at each checkpoint, or when asked."}
          </p>
        )
      )}
      {earlier.length > 0 && (
        <details className="mt-2 text-body-sm">
          <summary className="cursor-pointer text-ink-muted">
            {earlier.length === 1 ? "1 earlier set" : `${earlier.length} earlier sets`}
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {earlier.map((set) => (
              <div key={set.key} className="flex flex-col gap-1.5">
                {heading(set)}
                <PageSetSummary set={set} owner={repo.owner} name={repo.name} />
              </div>
            ))}
          </div>
        </details>
      )}
      {canAsk && !ended && !(newest && newest.state !== "failed" && pagesPending(newest)) && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm -ml-2 mt-1"
          disabled={asking}
          onClick={() => void ask()}
          title="Write the pages this timeline affects at its bookmark's tip (uses AI)"
        >
          {asking ? "Asking…" : "Write pages now"}
        </button>
      )}
      {error && <p className="m-0 text-micro text-ink-faint">{error}</p>}
    </section>
  );
}
