// Main snapshot comparisons in the Knowledge tab (CORE-175): pick an older
// retained snapshot and read what changed between it and the snapshot on
// screen, with source changes, regrouping and summary-only changes kept apart
// and filterable by class and by capability. Everything is a bounded, paged
// request (GET /atlas/snapshots, GET /atlas/compare); the state is in the
// address (atlasCompare.ts), so Back from a source, history or syntax-change
// handoff comes back to the same comparison.
//
// A comparison names both snapshots. One past retention makes it
// unavailable, said as such, never "no changes".

import { ArrowClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  ATLAS_CHANGE_CLASSES,
  type AtlasChange,
  type AtlasChangeClass,
  type AtlasComparison,
  type AtlasEntitySummary,
  type AtlasError,
  type AtlasSnapshotList,
  type AtlasSnapshotListing,
  type AtlasSnapshotRef,
} from "../../../shared/atlas.ts";
import { atlasApi, atlasErrorOf, type AtlasRepo } from "../../lib/atlas.ts";
import { timeAgo } from "../../lib/format.ts";
import { blobUrl, commitsUrl, repoPath } from "../../lib/refs.ts";
import {
  caveatText,
  changeKind,
  CLASS_LABEL,
  CLASS_MEANING,
  describeChange,
  readCompareUrl,
  stateOf,
  unavailableText,
  writeCompareUrl,
  type CompareUrlState,
} from "./atlasCompare.ts";
import { writeAtlasUrl } from "./atlasUrl.ts";

const short = (commit: string | null | undefined) => (commit ? commit.slice(0, 7) : "unknown");
const commitOf = (snapshot: AtlasSnapshotRef) => snapshot.vector[0]?.commit ?? null;

/**
 * The comparison for the view's snapshot: a picker for the older side, or,
 * once one is chosen, the comparison itself.
 */
export function AtlasCompare({
  repo,
  base,
  snapshot,
  selected,
  onPick,
}: {
  repo: AtlasRepo;
  /** The Knowledge tab's path. */
  base: string;
  /** The snapshot on screen: the newer side. */
  snapshot: AtlasSnapshotRef;
  /** What's selected, offered as a capability filter. */
  selected: AtlasEntitySummary | null;
  onPick: (entity: AtlasEntitySummary) => void;
}) {
  const [params, setParams] = useSearchParams();
  const url = readCompareUrl(params);
  const navigate = (patch: Partial<CompareUrlState>, extra?: { snapshot: string }) =>
    setParams(
      (current) => {
        const next = writeCompareUrl(current, patch);
        return extra ? writeAtlasUrl(next, extra) : next;
      },
      { preventScrollReset: true },
    );
  if (!url.compare)
    return (
      <Picker
        repo={repo}
        snapshot={snapshot}
        // The newer side is the view's snapshot: pin it, so the address names both.
        onChoose={(id) => navigate({ compare: id }, { snapshot: snapshot.id })}
      />
    );
  return (
    <Comparison
      key={`${url.compare}|${snapshot.id}`}
      repo={repo}
      base={base}
      from={url.compare}
      to={snapshot}
      url={url}
      selected={selected}
      onPick={onPick}
      navigate={navigate}
    />
  );
}

/** The retained snapshots older than the one on screen, newest first. */
function Picker({
  repo,
  snapshot,
  onChoose,
}: {
  repo: AtlasRepo;
  snapshot: AtlasSnapshotRef;
  onChoose: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{
    items: AtlasSnapshotListing[];
    next: string | null;
    status: "loading" | "ready" | "error";
    error?: string;
  }>({ items: [], next: null, status: "loading" });
  const load = (cursor: string | null, previous: AtlasSnapshotListing[]) => {
    const controller = new AbortController();
    setState({ items: previous, next: null, status: "loading" });
    atlasApi.snapshots(repo, { cursor, limit: 25, signal: controller.signal }).then(
      (page: AtlasSnapshotList) =>
        setState({ items: [...previous, ...page.items], next: page.next, status: "ready" }),
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          items: previous,
          next: null,
          status: "error",
          error: error instanceof Error ? error.message : "Couldn't list the snapshots.",
        });
      },
    );
    return () => controller.abort();
  };
  useEffect(() => (open ? load(null, []) : undefined), [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const older = state.items.filter((s) => s.seq < snapshot.seq);
  return (
    <details
      className="text-body-sm"
      open={open}
      onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-ink-muted pointer-coarse:min-h-11">
        Compare with an earlier snapshot
      </summary>
      <div className="mt-2 flex flex-col gap-2">
        <p className="m-0 text-micro text-ink-faint">
          What changed between an earlier build and this one (#{snapshot.seq}, from{" "}
          <span className="font-mono">{short(commitOf(snapshot))}</span>): code, grouping and
          wording, kept apart.
        </p>
        {state.status === "loading" && (
          <p className="m-0 text-micro text-ink-faint" role="status">
            Listing snapshots…
          </p>
        )}
        {state.status === "error" && (
          <p className="m-0 text-micro text-danger-text" role="alert">
            {state.error}
          </p>
        )}
        {state.status === "ready" && older.length === 0 && !state.next && (
          <p className="m-0 text-micro text-ink-faint">
            No earlier snapshot is kept, so there's nothing to compare this one with.
          </p>
        )}
        {older.length > 0 && (
          <ul aria-label="Earlier snapshots" className="m-0 flex list-none flex-col gap-1 p-0">
            {older.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={s.state === "expired"}
                  onClick={() => onChoose(s.id)}
                  className="flex min-h-8 w-full cursor-pointer flex-wrap items-baseline gap-x-2 rounded-plate border-0 bg-transparent px-2 py-1 text-left hover:bg-raised disabled:cursor-default disabled:text-ink-faint disabled:hover:bg-transparent pointer-coarse:min-h-11"
                >
                  <span className="text-ink tabular-nums">#{s.seq}</span>{" "}
                  <span className="font-mono text-micro">{short(commitOf(s))}</span>{" "}
                  <span className="text-micro text-ink-faint">
                    {s.publishedAt ? `built ${timeAgo(s.publishedAt)}` : ""}
                    {s.state === "expired"
                      ? " · expired: can't be compared"
                      : s.expiresAt
                        ? ` · kept until ${new Date(s.expiresAt).toLocaleDateString()}`
                        : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {state.next && state.status === "ready" && (
          <button
            type="button"
            className="mk-btn mk-btn--sm self-start"
            onClick={() => load(state.next, state.items)}
          >
            Show more
          </button>
        )}
      </div>
    </details>
  );
}

interface Loaded {
  key: string;
  /** The first page's: who, what, and the counts. */
  head: AtlasComparison;
  items: AtlasChange[];
  next: string | null;
  loaded: number;
  more: "idle" | "loading" | "error";
}

function Comparison({
  repo,
  base,
  from,
  to,
  url,
  selected,
  onPick,
  navigate,
}: {
  repo: AtlasRepo;
  base: string;
  from: string;
  to: AtlasSnapshotRef;
  url: CompareUrlState;
  selected: AtlasEntitySummary | null;
  onPick: (entity: AtlasEntitySummary) => void;
  navigate: (patch: Partial<CompareUrlState>) => void;
}) {
  const [params] = useSearchParams();
  const key = `${from}|${to.id}|${url.changes ?? ""}|${url.within ?? ""}`;
  const [state, setState] = useState<Loaded | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: AtlasError } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const mine = ++generation.current;
    const controller = new AbortController();
    atlasApi
      .compare(repo, from, to.id, {
        class: url.changes,
        within: url.within,
        limit: 50,
        signal: controller.signal,
      })
      .then((head) => {
        if (mine !== generation.current) return;
        setFailure(null);
        setState({
          key,
          head,
          items: head.items,
          next: head.next,
          loaded: head.counts.loaded,
          more: "idle",
        });
      })
      .catch((error: unknown) => {
        if (mine !== generation.current || controller.signal.aborted) return;
        setFailure({
          key,
          error: atlasErrorOf(error) ?? {
            code: "bad_request",
            error: error instanceof Error ? error.message : "Couldn't load the comparison.",
          },
        });
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  const more = () => {
    if (!state?.next || state.more === "loading") return;
    const mine = generation.current;
    setState({ ...state, more: "loading" });
    atlasApi
      .compare(repo, from, to.id, {
        class: url.changes,
        within: url.within,
        cursor: state.next,
        limit: 50,
      })
      .then((page) => {
        if (mine !== generation.current) return;
        setState((now) =>
          now && now.key === key
            ? {
                ...now,
                items: [...now.items, ...page.items],
                next: page.next,
                loaded: page.counts.loaded,
                more: "idle",
              }
            : now,
        );
      })
      .catch((error: unknown) => {
        if (mine !== generation.current) return;
        const atlasError = atlasErrorOf(error);
        if (atlasError) setFailure({ key, error: atlasError });
        setState((now) => (now && now.key === key ? { ...now, more: "error" } : now));
      });
  };

  const current = state?.key === key ? state : null;
  const failed = failure?.key === key ? failure.error : null;
  const head = current?.head;
  const summary = head?.summary;
  const fromRef = head?.from.snapshot;
  const fromCommit = fromRef ? commitOf(fromRef) : null;
  const toCommit = commitOf(to);
  const changesHref = (path?: string) => {
    const query = new URLSearchParams();
    if (toCommit) query.set("ref", toCommit);
    if (path) query.set("path", path);
    return `${repoPath(repo.owner, repo.name, "changes")}?${query}`;
  };
  // A region the newer snapshot doesn't have opens in the older one, without the comparison.
  const inOlder = (id: string) => {
    const next = writeAtlasUrl(
      writeCompareUrl(params, { compare: null, changes: null, within: null }),
      {
        select: id,
        snapshot: from,
      },
    );
    return `${base}?${next}`;
  };
  const withinName = head?.within?.name ?? null;
  const offerWithin =
    !url.within &&
    selected &&
    (selected.kind === "capability" || selected.kind === "area") &&
    !selected.structural;

  return (
    <section
      aria-labelledby="atlas-compare-heading"
      className="flex flex-col gap-2 border-b border-line-soft pb-3"
    >
      <div className="flex items-start gap-2">
        <h2
          id="atlas-compare-heading"
          ref={heading}
          tabIndex={-1}
          className="m-0 min-w-0 flex-1 text-body font-semibold"
        >
          Changes between snapshots
        </h2>
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm pointer-coarse:min-h-11"
          onClick={() => navigate({ compare: null, changes: null, within: null })}
        >
          <XIcon aria-hidden /> Stop comparing
        </button>
      </div>
      <p className="m-0 text-body-sm text-ink-muted">
        From{" "}
        <strong className="font-semibold text-ink">
          {fromRef ? `#${fromRef.seq}` : "the older snapshot"}
        </strong>
        {fromRef && (
          <>
            {" "}
            (<span className="font-mono">{short(fromCommit)}</span>
            {fromRef.publishedAt && `, built ${timeAgo(fromRef.publishedAt)}`})
          </>
        )}{" "}
        to <strong className="font-semibold text-ink">#{to.seq}</strong> (
        <span className="font-mono">{short(toCommit)}</span>
        {to.publishedAt && `, built ${timeAgo(to.publishedAt)}`}, on screen).
      </p>

      {failed && (
        <div role="alert" className="flex flex-col gap-2 text-body-sm">
          <p className="m-0 text-ink">{unavailableText(failed)}</p>
          <div className="flex flex-wrap gap-2">
            {(failed.code === "cursor_expired" || failed.code === "cursor_invalid") && (
              <button
                type="button"
                className="mk-btn mk-btn--sm"
                onClick={() => setAttempt((n) => n + 1)}
              >
                <ArrowClockwiseIcon aria-hidden /> Start again
              </button>
            )}
            <button
              type="button"
              className="mk-btn mk-btn--ghost mk-btn--sm"
              onClick={() => navigate({ compare: null, changes: null, within: null })}
            >
              Choose another snapshot
            </button>
          </div>
        </div>
      )}
      {!failed && !current && (
        <p className="m-0 text-body-sm text-ink-faint" role="status">
          Comparing…
        </p>
      )}

      {head && summary && !failed && (
        <>
          <div role="group" aria-label="Kind of change" className="flex flex-wrap gap-1">
            {[null, ...ATLAS_CHANGE_CLASSES].map((cls: AtlasChangeClass | null) => (
              <button
                key={cls ?? "all"}
                type="button"
                aria-pressed={url.changes === cls}
                title={cls ? CLASS_MEANING[cls] : "Every change"}
                className="mk-chip cursor-pointer border-0 aria-pressed:bg-signal-wash aria-pressed:text-ink pointer-coarse:min-h-11"
                onClick={() => navigate({ changes: cls })}
              >
                {cls ? CLASS_LABEL[cls] : "All"}{" "}
                <span className="tabular-nums">
                  {(cls ? summary.classes[cls] : summary.total).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
          <p className="m-0 text-micro text-ink-faint">
            {url.changes
              ? `${CLASS_LABEL[url.changes]}: ${CLASS_MEANING[url.changes]}.`
              : "A change can be more than one kind: a file can change source and move."}
          </p>
          {url.within ? (
            <p className="m-0 flex flex-wrap items-center gap-2 text-body-sm">
              <span className="text-ink-muted">
                Only in <strong className="text-ink">{withinName ?? "this capability"}</strong>
              </span>
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm"
                onClick={() => navigate({ within: null })}
              >
                Show every capability
              </button>
            </p>
          ) : (
            offerWithin && (
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm self-start pointer-coarse:min-h-11"
                onClick={() => navigate({ within: selected.id })}
              >
                Only changes in {selected.name}
              </button>
            )
          )}
          <p className="m-0 text-body-sm text-ink-muted">
            Source:{" "}
            {summary.files.added + summary.files.removed + summary.files.modified === 0
              ? "no file was added, removed or edited"
              : [
                  summary.files.modified && `${summary.files.modified.toLocaleString()} edited`,
                  summary.files.added && `${summary.files.added.toLocaleString()} added`,
                  summary.files.removed && `${summary.files.removed.toLocaleString()} removed`,
                ]
                  .filter(Boolean)
                  .join(", ")
                  .concat(
                    ` file${summary.files.added + summary.files.removed + summary.files.modified === 1 ? "" : "s"}`,
                  )}
            {url.within ? " here" : ""}, between{" "}
            <span className="font-mono">{short(fromCommit)}</span> and{" "}
            <span className="font-mono">{short(toCommit)}</span>.
          </p>
          <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-body-sm">
            {toCommit && (
              <Link to={commitsUrl(repo.owner, repo.name, toCommit)} className="text-ink underline">
                Commits up to {short(toCommit)}
              </Link>
            )}
            {toCommit && (
              <Link to={changesHref()} className="text-ink underline">
                Syntax changes
              </Link>
            )}
          </p>
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-micro text-ink-faint">
            {head.caveats.map((c) => (
              <li key={c.code + ("side" in c ? c.side : "")}>{caveatText(c)}</li>
            ))}
            {toCommit && (
              <li>
                Syntax changes start at {short(toCommit)} and go back through history; those before{" "}
                {short(fromCommit)} predate this comparison.
              </li>
            )}
            {summary.others !== null && summary.others > 0 && (
              <li>
                Up to {summary.others.toLocaleString()} other entit
                {summary.others === 1 ? "y" : "ies"} (symbols, folders, concepts, packages) were
                rewritten between these builds; capabilities, areas and files are itemized here.
              </li>
            )}
          </ul>

          {current.items.length === 0 ? (
            <p className="m-0 text-body-sm text-ink-muted" role="status">
              {summary.total === 0
                ? `Nothing ${url.within ? "here " : ""}changed between these two snapshots.`
                : `No ${url.changes ? CLASS_LABEL[url.changes].toLowerCase() : ""} changes${url.within ? " here" : ""}.`}
            </p>
          ) : (
            <ul aria-label="Changes" className="m-0 flex list-none flex-col gap-2 p-0">
              {current.items.map((change) => (
                <ChangeItem
                  key={change.id}
                  change={change}
                  repo={repo}
                  fromCommit={fromCommit}
                  toCommit={toCommit}
                  changesHref={changesHref}
                  olderHref={inOlder(change.id)}
                  onPick={onPick}
                />
              ))}
            </ul>
          )}
          <p className="m-0 text-micro text-ink-faint" role="status">
            {current.items.length > 0 &&
              (head.counts.knownTotal !== null
                ? `${current.loaded.toLocaleString()} of ${head.counts.knownTotal.toLocaleString()}${
                    head.counts.unknownTotal ? " or more" : ""
                  } change${head.counts.knownTotal === 1 ? "" : "s"}`
                : `${current.loaded.toLocaleString()} loaded`)}
            {current.more === "error" && " · couldn't load more"}
          </p>
          {current.next && (
            <button
              type="button"
              className="mk-btn mk-btn--sm self-start"
              disabled={current.more === "loading"}
              onClick={more}
            >
              {current.more === "loading" ? "Loading…" : "Show more changes"}
            </button>
          )}
        </>
      )}
    </section>
  );
}

function ChangeItem({
  change,
  repo,
  fromCommit,
  toCommit,
  changesHref,
  olderHref,
  onPick,
}: {
  change: AtlasChange;
  repo: AtlasRepo;
  fromCommit: string | null;
  toCommit: string | null;
  changesHref: (path?: string) => string;
  olderHref: string;
  onPick: (entity: AtlasEntitySummary) => void;
}) {
  const side = change.to ?? change.from!;
  const lines = describeChange(change);
  const path = change.kind === "file" ? (side.path ?? null) : null;
  const pick = () =>
    onPick({
      id: change.id,
      kind: change.kind,
      parentId: side.parentId,
      name: side.name,
      path: side.path,
      summary: "",
      counts: {},
      structural: false,
    });
  const proseChanged = change.fields.includes("summary") || change.fields.includes("description");
  return (
    <li className="flex flex-col gap-1 border-t border-line-soft pt-2">
      <div className="flex flex-wrap items-baseline gap-x-2">
        {change.to ? (
          <button
            type="button"
            onClick={pick}
            className="min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left text-body-sm text-ink underline-offset-2 hover:underline pointer-coarse:min-h-11"
          >
            {side.name}
          </button>
        ) : (
          <span className="text-body-sm text-ink">{side.name}</span>
        )}
        <span className="text-micro text-ink-faint">
          {changeKind(change)} ·{" "}
          {change.presence === "added" ? "new" : change.presence === "removed" ? "gone" : "changed"}
        </span>
      </div>
      {path && <span className="font-mono text-micro break-all text-ink-faint">{path}</span>}
      <ul aria-label="Kind of change" className="m-0 flex list-none flex-wrap gap-1 p-0">
        {change.classes.map((cls) => (
          <li key={cls} className="mk-chip text-micro">
            {CLASS_LABEL[cls]}
          </li>
        ))}
      </ul>
      {lines.map((line) => (
        <p key={line} className="m-0 text-body-sm text-ink-muted">
          {line}
        </p>
      ))}
      {proseChanged && change.from && change.to && (
        <details className="text-micro text-ink-muted">
          <summary className="cursor-pointer text-ink-faint">Before and after</summary>
          <dl className="m-0 mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
            <dt className="text-ink-faint">Before</dt>
            <dd className="m-0">
              {change.from.summary || `No summary (${stateOf(change.from) ?? "none recorded"})`}
              {change.from.summaryTruncated && "…"}
            </dd>
            <dt className="text-ink-faint">After</dt>
            <dd className="m-0">
              {change.to.summary || `No summary (${stateOf(change.to) ?? "none recorded"})`}
              {change.to.summaryTruncated && "…"}
            </dd>
          </dl>
          <p className="m-0 mt-1 text-ink-faint">
            Summaries are a model's reading of the code, not verified behavior.
          </p>
        </details>
      )}
      <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-micro">
        {!change.to && (
          <Link to={olderHref} className="text-ink underline">
            Open in the older snapshot
          </Link>
        )}
        {path && change.to && toCommit && (
          <Link to={blobUrl(repo.owner, repo.name, toCommit, path)} className="text-ink underline">
            Source at {short(toCommit)}
          </Link>
        )}
        {path && change.from && fromCommit && change.fields.includes("source") && (
          <Link
            to={blobUrl(repo.owner, repo.name, fromCommit, path)}
            className="text-ink underline"
          >
            Before, at {short(fromCommit)}
          </Link>
        )}
        {path && !change.to && fromCommit && (
          <Link
            to={blobUrl(repo.owner, repo.name, fromCommit, path)}
            className="text-ink underline"
          >
            Last source, at {short(fromCommit)}
          </Link>
        )}
        {path && change.classes.includes("source") && (change.to ? toCommit : fromCommit) && (
          <Link
            to={commitsUrl(repo.owner, repo.name, (change.to ? toCommit : fromCommit)!, path)}
            className="text-ink underline"
          >
            History
          </Link>
        )}
        {path && toCommit && change.classes.includes("source") && (
          <Link to={changesHref(path)} className="text-ink underline">
            Syntax changes
          </Link>
        )}
      </p>
    </li>
  );
}
