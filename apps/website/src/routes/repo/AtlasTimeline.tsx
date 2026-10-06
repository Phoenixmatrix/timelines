// A timeline on the Knowledge tab, in Atlas terms (CORE-176): with `?tl=` set,
// the Selection pane says what the timeline changes against main as the
// capabilities and areas it touches, each file placed where main's map puts
// it, where the timeline's regrouping (CORE-186) would put it, and which
// touched capabilities that would split or merge (or, until that's computed,
// a new file placed provisionally), the capabilities its new imports reach,
// and the wiki pages about each; with every repository's bookmark,
// overlay, main base and merge base shown, each known or said not to be.
// Everything is one bounded, paged read (GET /atlas/timeline) of what the
// overlay already stored: nothing here computes an overlay, so an ended
// timeline is read exactly as it was kept (CORE-139). Source, history and
// syntax changes open on the timeline's commit with the timeline scope. The
// capabilities it touches are handed up (`onTouched`) so the map and the
// outline can mark them while `?tl` is set.

import { ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useLiveSearchParams } from "../../lib/searchParams.ts";
import type {
  AtlasCounts,
  AtlasEntitySummary,
  AtlasError,
  AtlasTimelineCaveat,
  AtlasTimelineFile,
  AtlasTimelineRegion,
  AtlasTimelineRepo,
  AtlasTimelineWiki,
} from "../../../shared/atlas.ts";
import {
  atlasApi,
  atlasErrorOf,
  atlasWorkspaceApi,
  type AtlasRepo,
  type AtlasWorkspace,
} from "../../lib/atlas.ts";
import { fullDate, timeAgo } from "../../lib/format.ts";
import { blobUrl, commitsUrl, repoPath, sourceUrl } from "../../lib/refs.ts";
import { withScope } from "../../lib/timelineScope.ts";
import {
  coverageText,
  headText,
  mergeBaseText,
  placementText,
  readTimelineWithin,
  relationText,
  stateText,
  TIMELINE_WITHIN,
  timelineCaveatText,
} from "./atlasTimeline.ts";
import { TimelineWikiPages } from "./TimelineOverlay.tsx";

const short = (oid: string | null | undefined) => (oid ? oid.slice(0, 7) : "unknown");

const ENDED: Record<"landed" | "abandoned" | "ended", string> = {
  landed: "This timeline landed",
  abandoned: "This timeline was abandoned",
  ended: "This timeline ended",
};

const CHANGE: Record<AtlasTimelineFile["change"], string> = {
  added: "New",
  changed: "Changed",
  removed: "Removed",
};

const CLASS: Record<string, string> = {
  source: "Source",
  summary: "Summary only",
  other: "Links only",
  regrouping: "Would move",
};

const PROPOSED: Record<"split" | "merge" | "new", string> = {
  split: "split off",
  merge: "merged",
  new: "new",
};

const share = (n: number) => `${Math.round(n * 100)}%`;

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** A file, from a repository's timeline or (with its repository) a workspace's. */
type Item = AtlasTimelineFile & { repoId?: string };

/** What the panel shows, from either scope's response. */
interface Head {
  repos: AtlasTimelineRepo[];
  regions: (AtlasTimelineRegion & { repoId?: string })[] | null;
  regionCount: number | null;
  within: AtlasEntitySummary | null;
  counts: AtlasCounts;
  /** Each repository's newest timeline wiki set, by repository id. */
  wiki: Record<string, AtlasTimelineWiki | null>;
  caveats: (AtlasTimelineCaveat & { repoId?: string })[];
}

interface Loaded {
  head: Head;
  items: Item[];
  next: string | null;
}

/**
 * A timeline in Atlas terms, for a repository (`repo`) or across a
 * workspace's selected repositories (`workspace`, CORE-186): there each
 * repository's part is its own, files and capabilities say whose they are,
 * and their handoffs open in their own repository.
 */
export function AtlasTimeline({
  repo,
  workspace,
  snapshot,
  timeline,
  selected,
  onSelect,
  onCurrent,
  onTouched,
}: {
  repo?: AtlasRepo;
  workspace?: AtlasWorkspace;
  /** The snapshot on screen (a workspace's composite): placements are read in it. */
  snapshot: { id: string };
  /** The timeline's slug (`?tl=`). */
  timeline: string;
  /** What's selected, offered as a filter. */
  selected: AtlasEntitySummary | null;
  /** Select a capability on the map. */
  onSelect: (id: string) => void;
  /** Leave a snapshot that expired for the current one (the timeline stays). */
  onCurrent: () => void;
  /** The map's capabilities the timeline touches, as read (empty when it's gone). */
  onTouched?: (ids: ReadonlySet<string>) => void;
}) {
  const [params, setParams] = useLiveSearchParams();
  const within = readTimelineWithin(params);
  const ref = `timeline/${timeline}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<AtlasError | null>(null);
  const [more, setMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const latest = useRef(0);
  // By value: the parent passes new objects on every render.
  const scopeKey = workspace
    ? `ws\n${workspace.owner}\n${workspace.repos.join(",")}`
    : `repo\n${repo?.owner ?? ""}\n${repo?.name ?? ""}`;

  const read = useCallback(
    (cursor: string | null, signal?: AbortSignal): Promise<Loaded> => {
      const [kind, owner = "", names = ""] = scopeKey.split("\n");
      const request = { snapshot: snapshot.id, within, cursor, signal };
      if (kind === "ws")
        return atlasWorkspaceApi
          .timeline({ owner, repos: names.split(",") }, ref, request)
          .then((r) => ({ head: r, items: r.items, next: r.next }));
      return atlasApi.timeline({ owner, name: names }, ref, request).then((r) => ({
        head: { ...r, wiki: r.repos[0] ? { [r.repos[0].repoId]: r.wiki } : {} },
        items: r.items,
        next: r.next,
      }));
    },
    [scopeKey, ref, snapshot.id, within],
  );

  const load = useCallback(
    (signal: AbortSignal) => {
      const asked = ++latest.current;
      read(null, signal).then(
        (page) => {
          if (asked !== latest.current) return;
          setLoaded(page);
          setFailed(null);
        },
        (error: unknown) => {
          if (signal.aborted || asked !== latest.current) return;
          setFailed(
            atlasErrorOf(error) ?? {
              code: "bad_request",
              error: error instanceof Error ? error.message : "The timeline couldn't be read.",
            },
          );
        },
      );
    },
    [read],
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    load(controller.signal);
    return () => controller.abort();
  }, [load, attempt]);

  // An overlay being computed lands in seconds to minutes: read it again until it does.
  const busy = loaded?.head.repos.some((r) => r.state === "building" || r.state === "queued");
  useEffect(() => {
    if (!busy) return;
    const controller = new AbortController();
    const timer = setTimeout(() => load(controller.signal), 4000);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [busy, loaded, load]);

  const loadMore = () => {
    if (!loaded?.next || more) return;
    setMore(true);
    read(loaded.next)
      .then(
        (page) =>
          setLoaded((now) =>
            now ? { ...now, items: [...now.items, ...page.items], next: page.next } : now,
          ),
        (error: unknown) => setFailed(atlasErrorOf(error)),
      )
      .finally(() => setMore(false));
  };

  const setWithin = (id: string | null) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (id) next.set(TIMELINE_WITHIN, id);
        else next.delete(TIMELINE_WITHIN);
        return next;
      },
      { preventScrollReset: true },
    );

  const head = loaded?.head;
  // The repositories with the timeline (all of them, for a repository's tab).
  const parts = head?.repos.filter((r) => r.state !== "none") ?? [];
  const part = parts[0] ?? head?.repos[0];
  const many = (head?.repos.length ?? 0) > 1;
  const partOf = (repoId: string | undefined) =>
    head?.repos.find((r) => r.repoId === repoId) ?? part!;
  // The regions on the map it touches: not the unclassified group, not a
  // group only its regrouping proposes.
  const touchedKey = (head?.regions ?? [])
    .filter((r) => !r.proposed && !r.id.endsWith("group:unclassified"))
    .map((r) => r.id)
    .join("\n");
  const report = useRef(onTouched);
  report.current = onTouched;
  useEffect(() => {
    report.current?.(new Set(touchedKey ? touchedKey.split("\n") : []));
  }, [touchedKey]);
  useEffect(() => () => report.current?.(new Set()), []);
  const computed = head?.caveats.some((c) => c.code === "regrouping" && c.state === "computed");
  const offerWithin =
    !within && selected && (selected.kind === "capability" || selected.kind === "area");

  return (
    <section aria-label={`Timeline ${timeline}`} className="mb-3 flex flex-col gap-2">
      <header>
        <h2 className="m-0 text-title break-words">{ref}</h2>
        <span className="block text-micro text-ink-faint">
          {many
            ? "What it changes against main in each selected repository, in its own map's capabilities."
            : "What it changes against main, in this map's capabilities."}
        </span>
      </header>

      {failed && (
        <div role="alert" className="flex flex-col gap-2 text-body-sm">
          <p className="m-0 text-ink">
            {failed.code === "snapshot_expired"
              ? "This map's snapshot has expired. The timeline's overlay is kept apart from it: read it on the current map."
              : failed.code === "timeline_changed"
                ? "The timeline was pushed again while this list was read. Start again to read its new changes."
                : failed.error}
          </p>
          <div className="flex flex-wrap gap-2">
            {failed.code === "snapshot_expired" ? (
              <button type="button" className="mk-btn mk-btn--sm" onClick={onCurrent}>
                Open the current map
              </button>
            ) : (
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm"
                onClick={() => setAttempt((n) => n + 1)}
              >
                <ArrowClockwiseIcon aria-hidden /> Start again
              </button>
            )}
          </div>
        </div>
      )}
      {!failed && !loaded && (
        <p className="m-0 text-body-sm text-ink-faint" role="status">
          Reading the timeline…
        </p>
      )}

      {head && part && (
        <>
          {head.repos.map((r) => (
            <RepoFacts key={r.repoId} part={r} many={many} />
          ))}
          {parts
            .filter((p) => p.ended)
            .map((p) => (
              <p
                key={p.repoId}
                className="m-0 rounded-plate border border-line-soft bg-raised px-2 py-1.5 text-body-sm text-ink-muted"
              >
                {many && `${p.name}: `}
                {ENDED[p.ended!.reason]} {timeAgo(p.ended!.at)}.{" "}
                {p.ended!.removedAt ? (
                  <>
                    Its overlay and wiki pages were removed by retention on{" "}
                    {fullDate(p.ended!.removedAt)}.
                  </>
                ) : (
                  <>
                    This is its last overlay
                    {p.commit && (
                      <>
                        {" "}
                        at <span className="font-mono">{short(p.commit)}</span>
                      </>
                    )}
                    , kept read-only: nothing here computes it again.
                  </>
                )}
              </p>
            ))}

          <Regions
            head={head}
            repoOf={(repoId) => partOf(repoId)}
            many={many}
            timeline={timeline}
            computed={Boolean(computed)}
            onSelect={onSelect}
          />

          {within ? (
            <p className="m-0 flex flex-wrap items-center gap-2 text-body-sm">
              <span className="text-ink-muted">
                Only in{" "}
                <strong className="text-ink">{head.within?.name ?? "this capability"}</strong>:{" "}
                {plural(head.counts.knownTotal ?? 0, "file")}
              </span>
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm"
                onClick={() => setWithin(null)}
              >
                Show every capability
              </button>
            </p>
          ) : (
            offerWithin && (
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm self-start pointer-coarse:min-h-11"
                onClick={() => setWithin(selected.id)}
              >
                Only this timeline's changes in {selected.name}
              </button>
            )
          )}

          <section aria-label="Files it changes" className="border-t border-line-soft pt-2">
            <h3 className="m-0 mb-1 flex items-baseline gap-2 text-body-sm font-semibold">
              Files
              <span className="font-mono text-mono font-normal text-ink-faint tabular-nums">
                {(head.counts.knownTotal ?? 0).toLocaleString()}
              </span>
            </h3>
            {loaded.items.length === 0 ? (
              <p className="m-0 text-body-sm text-ink-muted" role="status">
                {within
                  ? "This timeline changes no file here."
                  : parts.length === 0
                    ? "None of the selected repositories has this timeline."
                    : part.ended?.removedAt
                      ? "Removed by retention."
                      : part.ended
                        ? "This timeline changed no file."
                        : part.commit
                          ? "This timeline changes no file yet."
                          : "No overlay yet. It is computed after the next push."}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {loaded.items.map((file) => (
                  <FileItem
                    key={file.id}
                    file={file}
                    part={partOf(file.repoId)}
                    many={many}
                    timeline={timeline}
                  />
                ))}
              </ul>
            )}
            {loaded.next && (
              <button
                type="button"
                className="mk-btn mk-btn--ghost mk-btn--sm -ml-2 mt-1"
                disabled={more}
                onClick={loadMore}
              >
                {more
                  ? "Loading…"
                  : `More (${loaded.items.length.toLocaleString()} of ${(head.counts.knownTotal ?? 0).toLocaleString()})`}
              </button>
            )}
          </section>

          {parts.map((p) => {
            const at = p.ended ? p.commit : (p.head ?? p.commit);
            const sourceId = p.sourceId;
            return (
              <div key={p.repoId} className="flex flex-col gap-1">
                <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-body-sm">
                  {many && <span className="font-semibold text-ink">{p.name}</span>}
                  {at && sourceId ? (
                    <>
                      <Link
                        to={withScope(
                          sourceUrl(
                            `${repoPath(p.owner, p.name, "changes")}?ref=${encodeURIComponent(at)}`,
                            sourceId,
                          ),
                          timeline,
                        )}
                        className="text-ink underline"
                      >
                        Syntax changes on this timeline
                      </Link>
                      <Link
                        to={withScope(commitsUrl(p.owner, p.name, at, "", sourceId), timeline)}
                        className="text-ink underline"
                      >
                        Its commits
                      </Link>
                    </>
                  ) : (
                    <span className="text-ink-muted">Timeline source unavailable.</span>
                  )}
                </p>
                <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-micro text-ink-faint">
                  <li>{coverageText(p)}</li>
                  {Object.keys(p.graph).length > 0 && (
                    <li>
                      Also in the graph:{" "}
                      {Object.entries(p.graph)
                        .map(
                          ([kind, n]) =>
                            `${kind} ${[
                              n.added && `${n.added} new`,
                              n.changed && `${n.changed} changed`,
                              n.removed && `${n.removed} removed`,
                            ]
                              .filter(Boolean)
                              .join(", ")}`,
                        )
                        .join("; ")}
                      .
                    </li>
                  )}
                  {head.caveats
                    .filter((c) => !c.repoId || c.repoId === p.repoId)
                    .map((c) => (
                      <li key={c.code}>{timelineCaveatText(c)}</li>
                    ))}
                </ul>
                <TimelineWikiPages
                  repo={{ owner: p.owner, name: p.name }}
                  ref={ref}
                  ended={Boolean(p.ended)}
                  removedAt={p.ended?.removedAt ?? null}
                  canAsk={p.head !== null && p.state !== "waiting" && p.state !== "unavailable"}
                  note={
                    head.wiki[p.repoId]
                      ? `Measured against main at ${short(head.wiki[p.repoId]!.baseCommit)}, ${relationText(head.wiki[p.repoId]!.base)}.`
                      : null
                  }
                />
              </div>
            );
          })}
        </>
      )}
    </section>
  );
}

/** One repository's bookmark, overlay, main base and merge base, each as known. */
function RepoFacts({ part, many }: { part: AtlasTimelineRepo; many: boolean }) {
  return (
    <section aria-label={`${part.owner}/${part.name} on ${part.ref}`}>
      {many && (
        <h3 className="m-0 text-body-sm font-semibold">
          {part.owner}/{part.name}
        </h3>
      )}
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-body-sm">
        <dt className="text-ink-faint">Overlay</dt>
        <dd className="m-0 text-ink" title={part.error ?? undefined}>
          {stateText(part.state)}
          {part.updatedAt && <span className="text-ink-faint"> · {timeAgo(part.updatedAt)}</span>}
        </dd>
        {part.state !== "none" && (
          <>
            <dt className="text-ink-faint">Bookmark</dt>
            <dd className="m-0 font-mono text-mono">{headText(part)}</dd>
            <dt className="text-ink-faint">Overlay of</dt>
            <dd className="m-0 font-mono text-mono">
              {part.commit ? short(part.commit) : "none yet"}
            </dd>
            <dt className="text-ink-faint">Main base</dt>
            <dd className="m-0">
              <span className="font-mono text-mono">
                {part.baseCommit ? short(part.baseCommit) : "unknown"}
              </span>
              {part.baseCommit && (
                <span className="text-ink-faint"> · {relationText(part.base)}</span>
              )}
            </dd>
            <dt className="text-ink-faint">Merge base</dt>
            <dd className="m-0 font-mono text-mono">{mergeBaseText(part)}</dd>
            <dt className="text-ink-faint">This map</dt>
            <dd className="m-0 font-mono text-mono">{short(part.projectionCommit)}</dd>
          </>
        )}
      </dl>
    </section>
  );
}

/** The capabilities the timeline touches, most files first. */
function Regions({
  head,
  repoOf,
  many,
  timeline,
  computed,
  onSelect,
}: {
  head: Head;
  /** The repository a region is in. */
  repoOf: (repoId: string | undefined) => AtlasTimelineRepo;
  many: boolean;
  timeline: string;
  /** Its regrouping was computed: what imports reach is already accounted for. */
  computed: boolean;
  onSelect: (id: string) => void;
}) {
  const regions = head.regions ?? [];
  if (!regions.length) return null;
  return (
    <section aria-label="Capabilities it touches" className="border-t border-line-soft pt-2">
      <h3 className="m-0 mb-1 flex items-baseline gap-2 text-body-sm font-semibold">
        Capabilities it touches
        <span className="font-mono text-mono font-normal text-ink-faint tabular-nums">
          {(head.regionCount ?? regions.length).toLocaleString()}
        </span>
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {regions.map((region) => (
          <RegionItem
            key={region.id}
            region={region}
            part={repoOf(region.repoId)}
            many={many}
            timeline={timeline}
            computed={computed}
            onSelect={onSelect}
          />
        ))}
      </ul>
      {(head.regionCount ?? 0) > regions.length && (
        <p className="m-0 mt-1 text-micro text-ink-faint">
          {plural((head.regionCount ?? 0) - regions.length, "more capability", "more capabilities")}{" "}
          with fewer changed files; their files are listed below.
        </p>
      )}
    </section>
  );
}

function RegionItem({
  region,
  part,
  many,
  timeline,
  computed,
  onSelect,
}: {
  region: AtlasTimelineRegion;
  /** The repository it's in. */
  part: AtlasTimelineRepo;
  many: boolean;
  timeline: string;
  computed: boolean;
  onSelect: (id: string) => void;
}) {
  const parts = [
    region.files.added && `${region.files.added} new`,
    region.files.changed && `${region.files.changed} changed`,
    region.files.removed && `${region.files.removed} removed`,
  ].filter(Boolean);
  const named = (r: { name: string | null; proposed?: boolean }) =>
    r.name ? (r.proposed ? `a new ${r.name}` : r.name) : "a capability";
  const fileCount = region.files.added + region.files.changed + region.files.removed;
  const repo = { owner: part.owner, name: part.name };
  return (
    <li className="flex flex-col gap-0.5">
      {many && <span className="text-micro text-ink-faint">{part.name}</span>}
      {region.proposed ? (
        // Not on the map: only the timeline's regrouping makes it.
        <span className="text-body-sm text-ink">
          {region.name}{" "}
          <span className="mk-chip text-micro">
            Would be a {PROPOSED[region.proposed.change]} capability
          </span>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onSelect(region.id)}
          className="min-w-0 cursor-pointer self-start border-0 bg-transparent p-0 text-left text-body-sm text-ink underline-offset-2 hover:underline pointer-coarse:min-h-11"
        >
          {region.name}
        </button>
      )}
      <span className="text-micro text-ink-muted">
        {fileCount === 0
          ? "No changed file here"
          : `${parts.join(", ")} file${fileCount === 1 ? "" : "s"}`}
        {region.classes.regrouping > 0 && `; ${region.classes.regrouping} would move`}
        {region.provisional > 0 && `; ${region.provisional} placed here provisionally`}
        {region.areas.length > 0 &&
          ` · in ${region.areas.map((a) => a.name ?? "an unnamed area").join(", ")}`}
      </span>
      {region.proposed && region.proposed.from.length > 0 && (
        <span className="text-micro text-ink-muted">
          The timeline's regrouping would form it from{" "}
          {region.proposed.from
            .map((f) => `${f.name ?? "a capability"} (${share(f.share)})`)
            .join(", ")}
          .
        </span>
      )}
      {region.regrouping && (
        <span className="text-micro text-ink">
          {region.regrouping.change === "split"
            ? `The timeline's regrouping would split it: ${region.regrouping.into
                .map((t) => `${share(t.share)} to ${named(t)}`)
                .join(", ")}.`
            : region.regrouping.change === "merged"
              ? `The timeline's regrouping would merge it into ${region.regrouping.into
                  .map((t) => named(t))
                  .join(", ")}.`
              : "The timeline's regrouping would leave none of its files grouped here."}
        </span>
      )}
      {region.imports.added.length > 0 && (
        <span className="text-micro text-ink-muted">
          New imports reach {region.imports.added.map((r) => r.name ?? "a capability").join(", ")}
          {computed ? "." : ": it may be regrouped once main builds it."}
        </span>
      )}
      {region.imports.removed.length > 0 && (
        <span className="text-micro text-ink-muted">
          Stops importing from{" "}
          {region.imports.removed.map((r) => r.name ?? "a capability").join(", ")}.
        </span>
      )}
      {(region.pages.length > 0 || region.mainPages.length > 0) && (
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-micro">
          {region.pages.map((page) => (
            <Link
              key={`t:${page.slug}`}
              to={withScope(
                sourceUrl(
                  `${repoPath(repo.owner, repo.name, "wiki", page.slug)}?set=${encodeURIComponent(page.set)}`,
                  part.sourceId,
                ),
                timeline,
              )}
              className="text-ink underline"
            >
              Timeline wiki: {page.title}
            </Link>
          ))}
          {region.mainPages.map((page) => (
            <Link
              key={`m:${page.slug}`}
              to={withScope(repoPath(repo.owner, repo.name, "wiki", page.slug), null)}
              className="text-ink-muted underline"
              title={`Written from main at ${short(page.generatedIn)}, ${relationText(page.relation)}`}
            >
              Main's wiki: {page.title} ({short(page.generatedIn)}, {relationText(page.relation)})
            </Link>
          ))}
        </span>
      )}
    </li>
  );
}

function FileItem({
  file,
  part,
  many,
  timeline,
}: {
  file: AtlasTimelineFile;
  /** The repository it's in. */
  part: AtlasTimelineRepo;
  many: boolean;
  timeline: string;
}) {
  const repo = { owner: part.owner, name: part.name };
  // Keep evidence pinned to its source; never substitute canonical for a missing source.
  const at = part.sourceId ? part.commit : null;
  const scoped = (href: string) => withScope(sourceUrl(href, part.sourceId!), timeline);
  return (
    <li className="flex flex-col gap-0.5 border-b border-line-soft pb-2 last:border-b-0">
      <span className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-mono break-all text-ink">
          {many && `${part.name}: `}
          {file.path}
        </span>
        <span className="mk-chip mk-chip--tag">{CHANGE[file.change]}</span>
        {file.classes
          .filter((c) => c !== "source")
          .map((c) => (
            <span key={c} className="mk-chip text-micro">
              {CLASS[c] ?? c}
            </span>
          ))}
      </span>
      <span className="text-micro text-ink-muted">{placementText(file)}</span>
      {file.imports.added.length > 0 && (
        <span className="text-micro text-ink-muted">
          Now imports from {file.imports.added.map((r) => r.name ?? "a capability").join(", ")}.
        </span>
      )}
      <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-micro">
        {file.change !== "removed" && at && (
          <Link
            to={scoped(blobUrl(repo.owner, repo.name, at, file.path))}
            className="text-ink underline"
          >
            Source at {short(at)}
          </Link>
        )}
        {file.change !== "added" && part.baseCommit && (
          <Link
            to={sourceUrl(
              withScope(blobUrl(repo.owner, repo.name, part.baseCommit, file.path), null),
              "canonical",
            )}
            className="text-ink underline"
          >
            Main's, at {short(part.baseCommit)}
          </Link>
        )}
        {at && (
          <Link
            to={scoped(
              `${repoPath(repo.owner, repo.name, "changes")}?${new URLSearchParams({ ref: at, path: file.path })}`,
            )}
            className="text-ink underline"
          >
            Syntax changes
          </Link>
        )}
        {at && file.change !== "removed" && (
          <Link
            to={scoped(commitsUrl(repo.owner, repo.name, at, file.path))}
            className="text-ink underline"
          >
            History
          </Link>
        )}
      </span>
    </li>
  );
}
