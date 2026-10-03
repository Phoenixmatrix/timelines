// A timeline's knowledge overlay on the atlas (CORE-83): what the timeline
// adds, changes and removes compared with main's graph. Main's map stays as
// it is; the nodes the timeline touches are outlined on it and listed here.
// A landed or abandoned timeline keeps its last overlay, read-only (CORE-139).
// Below the diff, the wiki pages written for the timeline at its checkpoints
// or on demand (CORE-84); an ended timeline keeps those read-only too.

import { useEffect, useState } from "react";
import { Link, useRevalidator } from "react-router";
import type {
  KnowledgeOverlay,
  KnowledgeOverlayChange,
  KnowledgeOverlaySummary,
  KnowledgePageSet,
} from "../../../shared/api.ts";
import {
  PageSetSummary,
  pagesPending,
  setLabel,
  useRefreshWhile,
} from "../../components/TimelinePages.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { timeAgo } from "../../lib/format.ts";
import { blobUrl } from "../../lib/refs.ts";
import { KIND_LABEL } from "./AtlasMap.tsx";
import { useRepo } from "./RepoLayout.tsx";

const STATE: Record<KnowledgeOverlaySummary["state"], string> = {
  "up-to-date": "Up to date",
  building: "Updating",
  queued: "Update queued",
  failed: "Last update failed",
  waiting: "Waits for main's first graph",
  ended: "Ended",
};

const ENDED: Record<NonNullable<KnowledgeOverlay["ended"]>["reason"], string> = {
  landed: "This timeline landed",
  abandoned: "This timeline was abandoned",
  ended: "This timeline ended",
};

const FIELD: Record<string, string> = {
  blob: "content",
  links: "links",
  summary: "description",
  name: "name",
  responsibilities: "responsibilities",
  files: "size",
  exported: "visibility",
};

const SECTIONS: [KnowledgeOverlayChange["change"], string][] = [
  ["added", "Adds"],
  ["changed", "Changes"],
  ["removed", "Removes"],
];

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

function ChangeRow({
  change,
  overlay,
  href,
  inMap,
}: {
  change: KnowledgeOverlayChange;
  overlay: KnowledgeOverlay;
  href: (id: string) => string;
  inMap: (id: string) => boolean;
}) {
  const repo = useRepo();
  const label = (
    <>
      <span className="w-[4.5rem] shrink-0 truncate text-micro text-ink-faint">
        {KIND_LABEL[change.kind] ?? change.kind}
      </span>
      <span className="min-w-0 flex-1 truncate">{change.name}</span>
      {change.change === "changed" && change.fields.length > 0 && (
        <span className="shrink-0 text-micro text-ink-faint">
          {change.fields
            .map((f) => FIELD[f] ?? f)
            .slice(0, 2)
            .join(", ")}
        </span>
      )}
    </>
  );
  const row =
    "-mx-2 flex h-8 items-center gap-2 rounded-plate px-2 text-body-sm text-ink no-underline";
  const title = change.summary || change.path || change.name;
  // Nodes main has open in the inspector; new files open at the timeline's
  // bookmark, or at its last overlay's commit once the bookmark is gone.
  const at = overlay.ended ? overlay.commit : overlay.head ? overlay.ref : null;
  if (change.change !== "added" && inMap(change.id))
    return (
      <Link to={href(change.id)} className={`${row} hover:bg-raised`} title={title}>
        {label}
      </Link>
    );
  if (change.path && (change.kind === "file" || change.kind === "symbol") && at)
    return (
      <Link
        to={blobUrl(repo.owner.slug, repo.name, at, change.path)}
        className={`${row} hover:bg-raised`}
        title={title}
      >
        {label}
      </Link>
    );
  return (
    <div className={row} title={title}>
      {label}
    </div>
  );
}

function Section({
  title,
  changes,
  ...rest
}: {
  title: string;
  changes: KnowledgeOverlayChange[];
  overlay: KnowledgeOverlay;
  href: (id: string) => string;
  inMap: (id: string) => boolean;
}) {
  const [all, setAll] = useState(false);
  if (!changes.length) return null;
  const shown = all ? changes : changes.slice(0, 12);
  return (
    <section className="border-t border-line-soft py-3">
      <h3 className="m-0 mb-1 flex items-baseline gap-2 text-body-sm font-semibold">
        {title}
        <span className="font-mono text-mono font-normal text-ink-faint tabular-nums">
          {changes.length}
        </span>
      </h3>
      <ul className="m-0 list-none p-0">
        {shown.map((change) => (
          <li key={change.id}>
            <ChangeRow change={change} {...rest} />
          </li>
        ))}
      </ul>
      {changes.length > 12 && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm -ml-2"
          onClick={() => setAll(!all)}
        >
          {all ? "Fewer" : `${changes.length - 12} more`}
        </button>
      )}
    </section>
  );
}

/** The wiki pages written for the timeline: the newest set, earlier ones folded away. */
function TimelinePages({ overlay }: { overlay: KnowledgeOverlay }) {
  const repo = useRepo();
  const revalidator = useRevalidator();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newest, ...earlier] = overlay.pageSets;
  useRefreshWhile(overlay.pageSets.some(pagesPending));
  // Pages are written at checkpoints; someone may ask for the bookmark's tip now.
  const canAsk =
    !overlay.ended &&
    overlay.head !== null &&
    overlay.state !== "waiting" &&
    !(newest && newest.commit === overlay.head && newest.state !== "failed");
  const ask = async () => {
    setAsking(true);
    setError(null);
    try {
      await api<KnowledgePageSet>(
        `/repos/${repo.owner.slug}/${repo.name}/knowledge/overlay/pages?ref=${encodeURIComponent(overlay.ref)}`,
        { method: "POST" },
      );
      void revalidator.revalidate();
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
      {newest ? (
        <div className="flex flex-col gap-1.5">
          {heading(newest)}
          <PageSetSummary set={newest} owner={repo.owner.slug} name={repo.name} />
        </div>
      ) : (
        <p className="m-0 text-body-sm text-ink-muted">
          {overlay.ended
            ? "None were written before this timeline ended."
            : "Written at each checkpoint, or when asked."}
        </p>
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
                <PageSetSummary set={set} owner={repo.owner.slug} name={repo.name} />
              </div>
            ))}
          </div>
        </details>
      )}
      {canAsk && (
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

/** The selected timeline's diff against main, above the inspector. */
export function OverlayPanel({
  overlay,
  href,
  inMap,
}: {
  overlay: KnowledgeOverlay;
  href: (id: string) => string;
  inMap: (id: string) => boolean;
}) {
  const revalidator = useRevalidator();
  const busy = overlay.state === "building" || overlay.state === "queued";
  // Each push updates the overlay in seconds to minutes: show it when it lands.
  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => void revalidator.revalidate(), 4000);
    return () => clearTimeout(timer);
  }, [busy, overlay, revalidator]);
  const total = overlay.changes.length;
  return (
    <section aria-label={`Timeline ${overlay.timeline}`} className="mb-3">
      <header className="pb-2">
        <h2 className="m-0 text-title break-words">{overlay.ref}</h2>
        <span className="block text-micro text-ink-faint">
          Compared with main
          {overlay.baseCommit && (
            <>
              {" "}
              at <span className="font-mono">{overlay.baseCommit.slice(0, 7)}</span>
            </>
          )}
          {" · "}
          <span title={overlay.error ?? undefined}>{STATE[overlay.state]}</span>
          {overlay.updatedAt && <> · {timeAgo(overlay.updatedAt)}</>}
        </span>
      </header>
      {overlay.ended && (
        <p className="m-0 mb-2 rounded-plate border border-line-soft bg-raised px-2 py-1.5 text-body-sm text-ink-muted">
          {ENDED[overlay.ended.reason]} {timeAgo(overlay.ended.at)}. This is its last overlay
          {overlay.commit && (
            <>
              {" "}
              at <span className="font-mono">{overlay.commit.slice(0, 7)}</span>
            </>
          )}
          , kept read-only.
        </p>
      )}
      {!overlay.ended && overlay.commit && overlay.head && overlay.commit !== overlay.head && (
        <p className="m-0 mb-2 text-micro text-ink-faint">
          Showing <span className="font-mono">{overlay.commit.slice(0, 7)}</span>; the bookmark is
          now at <span className="font-mono">{overlay.head.slice(0, 7)}</span>.
        </p>
      )}
      {total === 0 ? (
        <p className="m-0 text-body-sm text-ink-muted">
          {overlay.ended
            ? "This timeline changed nothing in the graph."
            : overlay.commit
              ? "This timeline changes nothing in the graph yet."
              : "No overlay yet. It is computed after the next push."}
        </p>
      ) : (
        SECTIONS.map(([change, title]) => (
          <Section
            key={change}
            title={title}
            changes={overlay.changes.filter((c) => c.change === change)}
            overlay={overlay}
            href={href}
            inMap={inMap}
          />
        ))
      )}
      {overlay.truncated && (
        <p className="m-0 text-micro text-ink-faint">
          Showing the first {total.toLocaleString()} changes.
        </p>
      )}
      <TimelinePages overlay={overlay} />
    </section>
  );
}
