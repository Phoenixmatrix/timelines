// Panels the repository Atlas (Atlas.tsx) and the workspace Atlas
// (routes/atlas/WorkspaceAtlas.tsx, CORE-184) share: the catalogue lookup,
// what's inside a region, and the notices for a snapshot that can't be read
// any more. Each takes its scope's reads and its address (`base`, kept with
// the rest of the search string by atlasHref), never a repository of its own.

import { ArrowClockwiseIcon, CaretRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import type { AtlasEntitySummary, AtlasError } from "../../../shared/atlas.ts";
import { timeAgo } from "../../lib/format.ts";
import { CatalogueLookup, OPENS, type LookupFetch, type LookupState } from "./atlasNavigation.ts";
import { KIND_LABEL } from "./AtlasOutline.tsx";
import { atlasHref, LOOKUP_KINDS, type AtlasUrlState } from "./atlasUrl.ts";
import type { Load } from "./territory.ts";

const FILTER_LABEL: Record<string, string> = {
  capability: "Capabilities",
  area: "Areas",
  file: "Files",
  symbol: "Symbols",
};

const files = (n: number | undefined) =>
  n === undefined ? "" : `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;

const RETENTION: Record<NonNullable<AtlasError["expired"]>["reason"], string> = {
  age: "it was older than the 7 days prior snapshots are kept",
  count: "newer builds pushed it past the 20 prior snapshots kept",
  storage: "the repository's Atlas storage limit needed the room",
};

/** A link's snapshot is gone: say why, keep the rest of the link, and let the person choose. */
export function AtlasGone({
  error,
  base,
  noCurrent,
  note = null,
}: {
  error: AtlasError;
  base: string;
  /** Said when there's no current view to offer. */
  noCurrent: string;
  /** What the link keeps that the current view still shows (a timeline's overlay). */
  note?: string | null;
}) {
  const [params] = useSearchParams();
  const current = atlasHref(base, { snapshot: error.current?.id ?? null }, params);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <section
      aria-labelledby="atlas-gone"
      className="mx-auto flex max-w-xl flex-col gap-3 rounded-pane bg-pane p-5"
    >
      <h2 id="atlas-gone" ref={heading} tabIndex={-1} className="m-0 text-body font-semibold">
        {error.code === "snapshot_expired"
          ? "This link's Atlas snapshot has expired"
          : "This link's Atlas snapshot isn't available"}
      </h2>
      <p className="m-0 text-body-sm text-ink-muted">
        {error.code === "snapshot_expired" && error.expired
          ? `It was removed ${timeAgo(error.expired.at)} because ${RETENTION[error.expired.reason]}.`
          : error.error}{" "}
        The link showed the Atlas as it was then; the current one may group things differently, so
        it isn't opened in its place without asking.
      </p>
      {note && <p className="m-0 text-body-sm text-ink-muted">{note}</p>}
      {error.current ? (
        <Link to={current} className="mk-btn self-start">
          Open the current view
        </Link>
      ) : (
        <p className="m-0 text-body-sm text-ink-faint">{noCurrent}</p>
      )}
    </section>
  );
}

/** The snapshot on screen can't be read any more: keep what's shown, offer the current view. */
export function AtlasExpired({ error, base }: { error: AtlasError; base: string }) {
  const [params] = useSearchParams();
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-pane bg-pane px-3 py-2 text-body-sm"
    >
      <span className="min-w-0 flex-1 text-ink-muted">
        {error.error} What's on screen stays as it was read; nothing switches by itself.
      </span>
      {error.current && (
        <Link
          to={atlasHref(base, { snapshot: error.current.id }, params)}
          className="mk-btn mk-btn--sm"
        >
          Open the current view
        </Link>
      )}
    </div>
  );
}

/**
 * Find a capability, area, file or symbol by name or path in the snapshot's
 * catalogue: a lookup, not search. `children` is shown under a query, e.g.
 * the explicit handoff to code and wiki search for one repository.
 */
export function AtlasLookup({
  fetch,
  snapshot,
  base,
  url,
  origin,
  onQuery,
  onKind,
  onPick,
  children,
}: {
  fetch: LookupFetch;
  /** The snapshot it reads: a new one starts a new lookup. */
  snapshot: string;
  base: string;
  url: AtlasUrlState;
  /** Where a match comes from, when the scope has more than one repository. */
  origin?: (item: AtlasEntitySummary) => string | null;
  onQuery: (q: string) => void;
  onKind: (kind: string | null) => void;
  onPick: (entity: AtlasEntitySummary) => void;
  children?: ReactNode;
}) {
  const [text, setText] = useState(url.q);
  const written = useRef(url.q);
  // Addresses this field wrote that haven't arrived yet, oldest first: a late
  // one is the field's own earlier text, never a reason to undo newer typing.
  const pending = useRef<string[]>([]);
  // Back/Forward change the address under the field: follow it.
  useEffect(() => {
    const own = pending.current.indexOf(url.q);
    if (own >= 0) {
      pending.current.splice(0, own + 1);
      return;
    }
    if (url.q === written.current) return;
    pending.current = [];
    written.current = url.q;
    setText(url.q);
  }, [url.q]);

  // Matches fold away once one is chosen, so what it opens is in view; new
  // text or a new filter shows them again.
  const [showMatches, setShowMatches] = useState(!url.select);
  const shownFor = useRef(url.select);
  useEffect(() => {
    if (url.select === shownFor.current) return;
    shownFor.current = url.select;
    setShowMatches(false);
  }, [url.select]);
  const resultsId = useId();

  const [state, setState] = useState<LookupState>({ status: "idle" });
  const lookup = useMemo(
    () => new CatalogueLookup(fetch, setState),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot],
  );
  useEffect(() => () => lookup.dispose(), [lookup]);
  useEffect(() => lookup.lookup(url.q, url.kind), [lookup, url.q, url.kind]);

  const query = url.q.trim();
  const status =
    state.status === "loading"
      ? "Looking up…"
      : state.status === "failed"
        ? `The lookup failed: ${state.message}`
        : state.status === "done"
          ? state.items.length === 0
            ? `Nothing in this snapshot is named or found at a path containing “${state.q}”${
                state.kind ? ` among ${FILTER_LABEL[state.kind]?.toLowerCase()}` : ""
              }.`
            : state.counts.knownTotal !== null
              ? `${state.items.length.toLocaleString()} of ${state.counts.knownTotal.toLocaleString()}${
                  state.counts.unknownTotal ? " or more" : ""
                } match${state.counts.knownTotal === 1 ? "" : "es"}`
              : `${state.items.length.toLocaleString()} loaded`
          : "";

  return (
    <div role="search" aria-label="Find in this Atlas" className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="text-label text-ink-muted">Find a capability, file or symbol</span>
        <span className="relative">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <input
            type="search"
            className="mk-input w-full pl-8"
            value={text}
            placeholder="Name or path"
            autoComplete="off"
            spellCheck={false}
            maxLength={200}
            onChange={(event) => {
              setText(event.target.value);
              written.current = event.target.value;
              pending.current.push(event.target.value);
              setShowMatches(true);
              onQuery(event.target.value);
            }}
          />
        </span>
      </label>
      {/* Narrowing by kind only matters while looking something up (CORE-212). */}
      {(query || url.kind) && (
        <div role="group" aria-label="Kind" className="flex flex-wrap gap-1">
          {[null, ...LOOKUP_KINDS].map((kind) => (
            <button
              key={kind ?? "all"}
              type="button"
              aria-pressed={url.kind === kind}
              className="mk-chip cursor-pointer border-0 aria-pressed:bg-signal-wash aria-pressed:text-ink pointer-coarse:min-h-11"
              onClick={() => {
                setShowMatches(true);
                onKind(kind);
              }}
            >
              {kind ? FILTER_LABEL[kind] : "All"}
            </button>
          ))}
        </div>
      )}
      {query && (
        <div className="flex items-center gap-2">
          <p role="status" className="m-0 min-w-0 flex-1 text-micro text-ink-faint">
            {status}
          </p>
          {state.status === "done" && state.items.length > 0 && (
            <button
              type="button"
              aria-expanded={showMatches}
              aria-controls={resultsId}
              className="mk-btn mk-btn--ghost mk-btn--sm"
              onClick={() => setShowMatches(!showMatches)}
            >
              {showMatches ? "Hide matches" : "Show matches"}
            </button>
          )}
        </div>
      )}
      {state.status === "failed" && state.restart && (
        <AtlasExpired error={state.restart} base={base} />
      )}
      {state.status === "done" && state.items.length > 0 && query && showMatches && (
        <div id={resultsId} className="flex flex-col gap-2">
          <ul className="m-0 flex list-none flex-col p-0" aria-label="Matches">
            {state.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  aria-current={item.id === url.select || undefined}
                  onClick={() => onPick(item)}
                  className="flex min-h-10 w-full cursor-pointer flex-col items-start gap-0.5 rounded-plate border-0 bg-transparent px-2 py-1.5 text-left hover:bg-raised aria-[current]:bg-signal-wash pointer-coarse:min-h-11"
                >
                  <span className="flex w-full items-baseline gap-2">
                    <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                      {item.name}
                    </span>
                    <span className="text-micro text-ink-faint">
                      {KIND_LABEL[item.kind] ?? item.kind}
                    </span>
                  </span>
                  {(item.path || origin?.(item)) && (
                    <span className="w-full truncate font-mono text-micro text-ink-faint">
                      {[origin?.(item), item.path].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          {state.next && (
            <button
              type="button"
              className="mk-btn mk-btn--sm self-start"
              disabled={state.more}
              onClick={() => lookup.more()}
            >
              {state.more ? "Loading…" : "Show more"}
            </button>
          )}
        </div>
      )}
      {query && children}
    </div>
  );
}

/** What's inside a region, as the map loads it: a page at a time. */
export function AtlasContents({
  entity,
  load,
  onPick,
  onRetry,
  onMore,
}: {
  entity: AtlasEntitySummary;
  load: Load | undefined;
  onPick: (entity: AtlasEntitySummary) => void;
  onRetry: () => void;
  onMore: (cursor: string, items: AtlasEntitySummary[]) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="m-0 text-label text-ink-muted">Inside</h3>
      {load?.state === "loading" && (
        <p className="m-0 text-body-sm text-ink-faint" aria-live="polite">
          Loading what's inside…
        </p>
      )}
      {load?.state === "error" && (
        <div className="flex items-center gap-2 text-body-sm text-danger-text" role="alert">
          Couldn't load what's inside.
          <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={onRetry}>
            <ArrowClockwiseIcon weight="bold" aria-hidden /> Retry
          </button>
        </div>
      )}
      {load?.state === "ready" && (
        <>
          <ul className="m-0 flex list-none flex-col p-0" aria-label={`Inside ${entity.name}`}>
            {load.items.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onPick(child)}
                  className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-plate border-0 bg-transparent px-2 text-left text-body-sm hover:bg-raised pointer-coarse:min-h-11"
                >
                  {OPENS.has(child.kind) && (
                    <CaretRightIcon className="size-3 shrink-0 text-ink-faint" aria-hidden />
                  )}
                  <span className="min-w-0 flex-1 truncate">{child.name}</span>
                  <span className="text-micro text-ink-faint tabular-nums">
                    {files(child.counts.files)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <p className="m-0 text-micro text-ink-faint">
            {load.total !== null
              ? `${load.items.length.toLocaleString()} of ${load.total.toLocaleString()}`
              : `${load.items.length.toLocaleString()} loaded`}
          </p>
          {load.next && (
            <button
              type="button"
              className="mk-btn mk-btn--sm self-start"
              onClick={() => onMore(load.next!, load.items)}
            >
              Show more
            </button>
          )}
        </>
      )}
    </div>
  );
}
