// The Semantic Code Atlas for a repository (CORE-168): capability territory
// from the bounded Atlas API, never the whole graph. Since the Knowledge
// cutover (CORE-174) it is the Knowledge tab, /:owner/:repo/knowledge (the
// old /atlas address and `?node=` links redirect here), with the timeline
// overlay, the wiki and an explicit whole-graph export around it.
//
// The address holds the view (CORE-171, atlasUrl.ts): the selection, the
// snapshot it was read from, the relationship lens and the catalogue lookup,
// alongside the app-wide `?tl`. Back/Forward and copied links come back to
// the same place: a selection the map doesn't draw yet is reached by reading
// its ancestors and opening the path to it, a page of children per level.
// A link to a snapshot that has since expired says so and offers the current
// view; it never switches silently.

import { ArrowClockwiseIcon, CaretRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Link,
  redirect,
  useLoaderData,
  useNavigationType,
  useSearchParams,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type {
  KnowledgeOverlay,
  KnowledgeOverlaySummary,
  KnowledgeStatus,
  WikiCatalog,
} from "../../../shared/api.ts";
import type {
  AtlasEntitySummary,
  AtlasError,
  AtlasOverview,
  AtlasRegion,
  AtlasSnapshotRef,
} from "../../../shared/atlas.ts";
import { useKnowledgeStatus } from "../../components/KnowledgeStatus.tsx";
import { api } from "../../lib/api.ts";
import { atlasApi, atlasErrorOf, atlasNeedsRestart, type AtlasRepo } from "../../lib/atlas.ts";
import { timeAgo } from "../../lib/format.ts";
import { scopeOf } from "../../lib/timelineScope.ts";
import { useViewer } from "../../lib/session.ts";
import { usePalette } from "../../palette/Palette.tsx";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import { AtlasInspector } from "./AtlasInspector.tsx";
import { AtlasOutline } from "./AtlasOutline.tsx";
import {
  CatalogueLookup,
  FocusResolver,
  OPENS,
  type Focus,
  type LookupState,
} from "./atlasNavigation.ts";
import {
  atlasHref,
  LOOKUP_KINDS,
  readAtlasUrl,
  writeAtlasUrl,
  type AtlasLens,
  type AtlasUrlState,
  type AtlasView,
} from "./atlasUrl.ts";
import { scopeNotices, type AtlasNotice } from "./atlasStates.ts";
import { AtlasTerritory } from "./AtlasTerritory.tsx";
import { KnowledgeBar } from "./KnowledgeBar.tsx";
import { useRepo } from "./RepoLayout.tsx";
import { OverlayPanel } from "./TimelineOverlay.tsx";
import { buildTerritory, ChildLoader, type Load, type TerritoryCell } from "./territory.ts";

export async function atlasLoader({ params, request }: LoaderFunctionArgs) {
  const repo = { owner: params.owner ?? "", name: params.repo ?? "" };
  const url = new URL(request.url);
  // Links from the old Knowledge map named a graph node: the Atlas entity has
  // the same id.
  if (url.searchParams.has("node")) {
    const node = url.searchParams.get("node");
    url.searchParams.delete("node");
    if (node && node !== "repo" && !url.searchParams.has("select"))
      url.searchParams.set("select", node);
    throw redirect(`${url.pathname}${url.search}`);
  }
  const snapshot = readAtlasUrl(url.search).snapshot ?? undefined;
  const base = `/repos/${repo.owner}/${repo.name}/knowledge`;
  const quiet = <T,>(path: string, fallback: T) =>
    api<T>(path, { signal: request.signal }).catch(() => fallback);
  // Build state says whether the map is behind, rebuilding or failed; the
  // map still renders without it. The wiki catalog links entities to their
  // pages; timelines' overlays (CORE-83) are what the timeline picker offers.
  const timeline = scopeOf(url.search);
  const around = Promise.all([
    quiet<KnowledgeStatus | null>(`${base}/status`, null),
    quiet<WikiCatalog | null>(`${base}/wiki`, null).then((w) => w?.pages ?? []),
    quiet<{ overlays: KnowledgeOverlaySummary[] }>(`${base}/overlays`, { overlays: [] }).then(
      (r) => r.overlays,
    ),
    timeline
      ? quiet<KnowledgeOverlay | null>(
          `${base}/overlay?ref=${encodeURIComponent(`timeline/${timeline}`)}`,
          null,
        )
      : null,
  ]).then(([status, wiki, overlays, overlay]) => ({ status, wiki, overlays, overlay }));
  try {
    return {
      overview: await atlasApi.overview(repo, { snapshot, signal: request.signal }),
      pinned: null,
      ...(await around),
    };
  } catch (error) {
    const atlasError = atlasErrorOf(error);
    if (atlasError?.code === "atlas_unavailable")
      return { overview: null, pinned: null, ...(await around) };
    // A link to a snapshot that's gone: explain, and offer the current one.
    if (atlasError && snapshot && atlasNeedsRestart(error))
      return { overview: null, pinned: atlasError, ...(await around), status: null };
    throw error;
  }
}

export type AtlasLoaderData = Awaited<ReturnType<typeof atlasLoader>>;

/**
 * Only a different snapshot (or repository) reads the overview again; the rest
 * is the view's. An explicit revalidation (the same address, as when a
 * Knowledge build lands) reads it again too: an unpinned view moves to the new
 * map, a pinned one re-reads its own snapshot.
 */
export function atlasShouldRevalidate({
  currentUrl,
  nextUrl,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod || currentUrl.pathname !== nextUrl.pathname) return defaultShouldRevalidate;
  if (currentUrl.href === nextUrl.href) return defaultShouldRevalidate;
  return (
    currentUrl.searchParams.get("snapshot") !== nextUrl.searchParams.get("snapshot") ||
    scopeOf(currentUrl.search) !== scopeOf(nextUrl.search)
  );
}

const KIND_LABEL: Record<string, string> = {
  capability: "Capability",
  area: "Area",
  group: "Group",
  component: "Component",
  directory: "Folder",
  file: "File",
  symbol: "Symbol",
  concept: "Concept",
  package: "Package",
  repository: "Repository",
};
const FILTER_LABEL: Record<string, string> = {
  capability: "Capabilities",
  area: "Areas",
  file: "Files",
  symbol: "Symbols",
};

/** Below this, the outline is the default and the inspector reads in line. */
const NARROW = "(max-width: 1023.98px)";

const files = (n: number | undefined) =>
  n === undefined ? "" : `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;

const RETENTION: Record<NonNullable<AtlasError["expired"]>["reason"], string> = {
  age: "it was older than the 7 days prior snapshots are kept",
  count: "newer builds pushed it past the 20 prior snapshots kept",
  storage: "the repository's Atlas storage limit needed the room",
};

function useAtlasBase() {
  const repo = useRepo();
  return {
    ref: { owner: repo.owner.slug, name: repo.name } satisfies AtlasRepo,
    base: `/${repo.owner.slug}/${repo.name}/knowledge`,
    repo,
  };
}

export function Atlas() {
  const data = useLoaderData<typeof atlasLoader>();
  const { overview, pinned, status } = data;
  if (pinned) return <PinnedGone error={pinned} />;
  if (!overview) return <NotBuilt status={status} overlays={data.overlays} />;
  return <Territory key={overview.snapshot.id} overview={overview} data={data} />;
}

/** Polls a running build; the hook revalidates, and so reloads the map, when it lands. */
function useBuildStatus(initial: KnowledgeStatus | null): KnowledgeStatus | null {
  const repo = useRepo();
  const fallback = useMemo(() => initial ?? IDLE, [initial]);
  const status = useKnowledgeStatus(repo.owner.slug, repo.name, fallback);
  return initial ? status : null;
}
const IDLE = { state: "empty" } as KnowledgeStatus;

function NotBuilt({
  status: initial,
  overlays,
}: {
  status: KnowledgeStatus | null;
  overlays: KnowledgeOverlaySummary[];
}) {
  const status = useBuildStatus(initial);
  const { ref, base } = useAtlasBase();
  const busy = status?.state === "building" || status?.state === "queued";
  return (
    <div className="flex flex-col gap-3">
      <KnowledgeBar repo={ref} base={base} status={status} overlays={overlays} />
      <div className="mk-empty" role="status">
        The Atlas for this repository isn't built yet.
        <br />
        <span className="text-body-sm text-ink-faint">
          {busy
            ? `The first Knowledge build is ${status?.state === "queued" ? "queued" : "running"}; the map appears here when it lands.`
            : status?.state === "failed"
              ? "The last Knowledge build failed. It retries on the next push; the code, tree and history are all still available."
              : "It's made by the next Knowledge build, after a push."}
        </span>
      </div>
    </div>
  );
}

const TONE: Record<AtlasNotice["tone"], string> = {
  info: "text-ink-muted",
  warn: "text-ink",
  error: "text-danger-text",
};

/** A link's snapshot is gone: say why, keep the rest of the link, and let the person choose. */
function PinnedGone({ error }: { error: AtlasError }) {
  const { base } = useAtlasBase();
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
      {error.current ? (
        <Link to={current} className="mk-btn self-start">
          Open the current view
        </Link>
      ) : (
        <p className="m-0 text-body-sm text-ink-faint">
          This repository has no current Atlas to open instead.
        </p>
      )}
    </section>
  );
}

function Territory({ overview, data }: { overview: AtlasOverview; data: AtlasLoaderData }) {
  const status = useBuildStatus(data.status);
  const notices = useMemo(() => scopeNotices(status, overview), [status, overview]);
  const { ref, base } = useAtlasBase();
  const snapshot = overview.snapshot;
  const [params, setParams] = useSearchParams();
  const url = readAtlasUrl(params);
  const navigationType = useNavigationType();

  const navigate = (patch: Partial<AtlasUrlState>, replace = false) =>
    setParams((current) => writeAtlasUrl(current, patch), { replace, preventScrollReset: true });

  // ---- regions opened on the map ------------------------------------------------
  const [loads, setLoads] = useState<ReadonlyMap<string, Load>>(new Map());
  const requested = useRef(new Set<string>());
  const loader = useMemo(
    () =>
      new ChildLoader(
        snapshot.id,
        async (id, cursor, signal) => {
          const page = await atlasApi.children(ref, id, {
            snapshot: snapshot.id,
            cursor,
            signal,
            limit: 100,
          });
          return { items: page.items, next: page.next, total: page.counts.knownTotal };
        },
        (id, load) => setLoads((current) => new Map(current).set(id, load)),
      ),
    // One loader per snapshot: a new snapshot remounts this component anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.id],
  );
  useEffect(() => () => loader.reset(""), [loader]);
  /** Open a region once; a failed one is retried explicitly. */
  const open = (id: string) => {
    if (requested.current.has(id)) return;
    requested.current.add(id);
    void loader.load(id);
  };

  const expanded = useMemo(() => {
    const ready = new Map<string, AtlasEntitySummary[]>();
    for (const [id, load] of loads) if (load.state === "ready") ready.set(id, load.items);
    return ready;
  }, [loads]);
  const territory = useMemo(
    () => buildTerritory(overview.regions, expanded, snapshot.seq),
    [overview.regions, expanded, snapshot.seq],
  );
  const territoryRef = useRef(territory);
  territoryRef.current = territory;
  const loading = useMemo(
    () => new Set([...loads].filter(([, l]) => l.state === "loading").map(([id]) => id)),
    [loads],
  );

  // ---- the selection, from the address ------------------------------------------
  const [focus, setFocus] = useState<Focus>({ state: "none" });
  const [focusOnShow, setFocusOnShow] = useState<string | null>(null);
  const resolver = useMemo(
    () =>
      new FocusResolver(
        (id, signal) => atlasApi.ancestors(ref, id, { snapshot: snapshot.id, signal }),
        (id) => open(id),
        setFocus,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.id],
  );
  useEffect(() => () => resolver.dispose(), [resolver]);
  const narrowNow = useRef(false);
  useEffect(() => {
    // A restored link, Back or Forward moves focus to what it shows. A click
    // in the page leaves focus where it is, except on a narrow screen, where
    // what's selected is read in line, so focus goes to it.
    setFocusOnShow(navigationType === "POP" || narrowNow.current ? url.select : null);
    void resolver.focus(
      url.select,
      url.select ? territoryRef.current.byId.get(url.select)?.entity : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.select, resolver]);

  const select = (entity: AtlasEntitySummary) => {
    if (entity.id === url.select) return;
    navigate({ select: entity.id, snapshot: snapshot.id });
  };
  const setLens = (lens: AtlasLens) => navigate({ lens, snapshot: snapshot.id });

  const selected = focus.state === "ready" ? focus.entity : null;
  // The map shows the selection, or the deepest open region on the way to it.
  const mapFocus = useMemo(() => {
    if (focus.state !== "ready") return null;
    if (territory.byId.has(focus.id)) return focus.id;
    for (const a of [...(focus.ancestors ?? [])].reverse())
      if (territory.byId.has(a.id)) return a.id;
    return null;
  }, [focus, territory]);

  // ---- a pinned snapshot that stopped being readable mid-view --------------------
  const [restart, setRestart] = useState<AtlasError | null>(null);
  const loadRestart = useMemo(() => {
    for (const load of loads.values())
      if (load.state === "error" && atlasNeedsRestart(load.cause)) return atlasErrorOf(load.cause);
    return null;
  }, [loads]);
  const gone = restart ?? (focus.state === "restart" ? focus.error : null) ?? loadRestart;

  const commit = snapshot.vector[0]?.commit ?? null;
  const capabilities = overview.regions.filter((r) => !r.structural).length;

  // ---- the outline's top level: the overview's regions, then the catalogue ----------
  const [catalogue, setCatalogue] = useState<{
    items: AtlasRegion[];
    next: string | null;
    loading: boolean;
    error: string | null;
  }>({
    items: overview.catalogue.items,
    next: overview.catalogue.next,
    loading: false,
    error: null,
  });
  const moreRegions = () => {
    if (!catalogue.next || catalogue.loading) return;
    setCatalogue({ ...catalogue, loading: true, error: null });
    atlasApi.regions(ref, { snapshot: snapshot.id, cursor: catalogue.next, limit: 50 }).then(
      (page) =>
        setCatalogue((now) => ({
          items: [...now.items, ...page.items],
          next: page.next,
          loading: false,
          error: null,
        })),
      (error: unknown) => {
        const atlasError = atlasErrorOf(error);
        if (atlasError && atlasNeedsRestart(error)) setRestart(atlasError);
        setCatalogue((now) => ({
          ...now,
          loading: false,
          error: error instanceof Error ? error.message : "Couldn't load more regions.",
        }));
      },
    );
  };
  const roots = useMemo(
    () => [...overview.regions, ...catalogue.items],
    [overview.regions, catalogue.items],
  );
  // The outline opens the way to the selection: its ancestors, read or drawn.
  const path = useMemo(() => {
    if (focus.state !== "ready") return [];
    if (focus.ancestors) return focus.ancestors.filter((a) => a.parentId !== null).map((a) => a.id);
    const up: string[] = [];
    for (let cell = territory.byId.get(focus.id); cell?.parent;) {
      up.unshift(cell.parent);
      cell = territory.byId.get(cell.parent);
    }
    return up;
  }, [focus, territory]);

  // Where the selection is, in words, for the live announcement.
  const where = useMemo(
    () =>
      focus.state !== "ready"
        ? []
        : focus.ancestors
          ? focus.ancestors.slice(1).map((a) => a.name)
          : path.flatMap((id) => {
              const name = territory.byId.get(id)?.entity.name;
              return name ? [name] : [];
            }),
    [focus, path, territory],
  );

  // ---- the view: the map, or the outline (the default on narrow screens) --------------
  const narrow = useMediaQuery(NARROW);
  narrowNow.current = narrow;
  const view: AtlasView = url.view ?? (narrow ? "outline" : "map");
  const tree = useRef<HTMLDivElement>(null);
  const backToOutline = () => {
    const items = tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
    const target =
      tree.current?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]') ??
      items?.[0];
    target?.focus();
  };

  const outline = (
    <AtlasOutline
      treeRef={tree}
      label={`Outline of ${ref.owner}/${ref.name}`}
      roots={roots}
      rootsMore={catalogue.next !== null}
      rootsCount={overview.totalRegions}
      rootsState={catalogue.loading ? "loading" : catalogue.error ? "error" : null}
      loads={loads}
      selected={url.select}
      path={path}
      seq={snapshot.seq}
      onOpen={open}
      onRetry={(id) => void loader.load(id)}
      onMore={(id) => {
        const load = loads.get(id);
        if (load?.state === "ready" && load.next) void loader.load(id, load.next, load.items);
      }}
      onMoreRoots={moreRegions}
      onSelect={select}
    />
  );
  const lookup = (
    <Lookup
      atlas={ref}
      base={base}
      snapshot={snapshot}
      commit={commit}
      url={url}
      onQuery={(q) => navigate({ q }, true)}
      onKind={(kind) => navigate({ kind }, true)}
      onPick={select}
    />
  );
  const selection = (
    <>
      {data.overlay && (
        <OverlayPanel
          overlay={data.overlay}
          href={(id) => atlasHref(base, { select: id }, params)}
          inMap={() => true}
        />
      )}
      {focus.state === "resolving" && (
        <p className="m-0 text-body-sm text-ink-faint">Opening the selection…</p>
      )}
      {(focus.state === "missing" || focus.state === "error") && (
        <Missing
          focus={focus}
          atlas={ref}
          base={base}
          snapshot={snapshot}
          onRetry={() => void resolver.focus(focus.id)}
        />
      )}
      {selected && (
        <AtlasInspector
          key={selected.id}
          repo={ref}
          wiki={wikiPageFor(data.wiki, selected)}
          snapshot={snapshot}
          entity={selected}
          lens={url.lens}
          autoFocus={focusOnShow === selected.id}
          onPick={select}
          onLens={setLens}
          onRestart={setRestart}
          contents={
            OPENS.has(selected.kind) ? (
              <Contents
                entity={selected}
                load={loads.get(selected.id)}
                onPick={select}
                onRetry={() => void loader.load(selected.id)}
                onMore={(cursor, items) => void loader.load(selected.id, cursor, items)}
              />
            ) : null
          }
        />
      )}
      {selected && view === "outline" && narrow && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm self-start pointer-coarse:min-h-11"
          onClick={backToOutline}
        >
          Back to the outline
        </button>
      )}
    </>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <SnapshotLine overview={overview} pinned={url.snapshot !== null} />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Link
            to={`/${encodeURIComponent(ref.owner)}/-/atlas?repos=${encodeURIComponent(ref.name)}`}
            className="mk-btn mk-btn--ghost mk-btn--sm pointer-coarse:min-h-11"
          >
            Across repositories
          </Link>
          <div role="group" aria-label="View" className="flex gap-1">
            {(["map", "outline"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                className="mk-btn mk-btn--ghost mk-btn--sm aria-pressed:bg-signal-wash aria-pressed:text-ink pointer-coarse:min-h-11"
                onClick={() => navigate({ view: v })}
              >
                {v === "map" ? "Map" : "Outline"}
              </button>
            ))}
          </div>
          <KnowledgeBar repo={ref} base={base} status={status} overlays={data.overlays} />
        </div>
      </div>
      {notices.length > 0 && (
        <ul aria-label="Map state" className="m-0 flex list-none flex-col gap-0.5 p-0 text-body-sm">
          {notices.map((n) => (
            <li key={n.id} className={TONE[n.tone]} role={n.tone === "error" ? "alert" : undefined}>
              {n.text}
              {n.current && (
                <>
                  {" "}
                  <Link
                    to={atlasHref(base, { snapshot: null }, params)}
                    className="text-ink underline"
                  >
                    Open the current view
                  </Link>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {gone && <Expired error={gone} base={base} />}
      <p role="status" className="sr-only">
        {focus.state === "resolving"
          ? "Opening the selection…"
          : focus.state === "ready"
            ? `Selected ${focus.entity.name}, ${KIND_LABEL[focus.entity.kind] ?? focus.entity.kind}${
                where.length ? `, in ${where.join(" › ")}` : ""
              }.`
            : focus.state === "missing" || focus.state === "error"
              ? "The selection couldn't be shown."
              : ""}
      </p>

      {view === "map" ? (
        <div className="grid gap-3 lg:h-[max(34rem,calc(100dvh-16rem))] lg:grid-cols-[minmax(0,1fr)_23rem]">
          <div className="h-[62dvh] min-h-[22rem] lg:h-auto lg:min-h-0">
            <AtlasTerritory
              territory={territory}
              selected={mapFocus}
              loading={loading}
              onSelect={(cell: TerritoryCell) => select(cell.entity)}
              label={`Capability map: ${capabilities} capabilities${
                overview.regions.length > capabilities ? " and structural groups" : ""
              }. The outline beside it has the same regions, and more.`}
            />
          </div>
          <aside
            aria-label="Regions"
            className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto rounded-pane bg-pane p-3"
          >
            {lookup}
            {selection}
            {outline}
            <Legend />
          </aside>
        </div>
      ) : narrow ? (
        // A phone reads top to bottom: find, what's selected, then the outline.
        <div className="flex min-w-0 flex-col gap-3 rounded-pane bg-pane p-3">
          {lookup}
          {selection}
          {outline}
          <Legend />
        </div>
      ) : (
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_23rem]">
          <section
            aria-label="Outline"
            className="flex min-w-0 flex-col gap-3 rounded-pane bg-pane p-3"
          >
            {lookup}
            {outline}
            <Legend />
          </section>
          <aside
            aria-label="Selection"
            className="flex min-w-0 flex-col gap-3 rounded-pane bg-pane p-3 lg:sticky lg:top-3 lg:max-h-[calc(100dvh-1.5rem)] lg:overflow-y-auto"
          >
            {selection}
            {!selected && focus.state === "none" && (
              <p className="m-0 text-body-sm text-ink-faint">
                Choose an entry in the outline to read about it here.
              </p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function SnapshotLine({ overview, pinned }: { overview: AtlasOverview; pinned: boolean }) {
  const snapshot = overview.snapshot;
  const commit = snapshot.vector[0]?.commit.slice(0, 7);
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-body-sm text-ink-muted">
      <span className="tabular-nums">
        {overview.totalRegions.toLocaleString()} region{overview.totalRegions === 1 ? "" : "s"}
        {overview.totalRegions > overview.regions.length &&
          ` · showing the ${overview.regions.length} largest`}
      </span>
      <span className="text-ink-faint">
        Built from {commit ? <span className="font-mono">{commit}</span> : "the indexed commit"}
        {snapshot.publishedAt && ` · ${timeAgo(snapshot.publishedAt)}`}
      </span>
      {snapshot.expiresAt && (
        <span className="text-ink-faint">
          {pinned ? "A linked earlier snapshot" : "An earlier snapshot"}, kept until{" "}
          {new Date(snapshot.expiresAt).toLocaleDateString()}
        </span>
      )}
    </div>
  );
}

/** The snapshot on screen can't be read any more: keep what's shown, offer the current view. */
function Expired({ error, base }: { error: AtlasError; base: string }) {
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

/** A selection this snapshot doesn't have: where it went, or why it can't be shown. */
function Missing({
  focus,
  atlas,
  base,
  snapshot,
  onRetry,
}: {
  focus: Extract<Focus, { state: "missing" | "error" }>;
  atlas: AtlasRepo;
  base: string;
  snapshot: AtlasSnapshotRef;
  onRetry: () => void;
}) {
  const [params] = useSearchParams();
  const lineage = focus.state === "missing" ? focus.error.lineage : undefined;
  const successors = useSuccessorNames(atlas, snapshot, lineage?.successors ?? []);
  if (focus.state === "error")
    return (
      <div className="flex items-center gap-2 text-body-sm text-danger-text" role="alert">
        Couldn't open the selection: {focus.message}
        <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={onRetry}>
          <ArrowClockwiseIcon weight="bold" aria-hidden /> Retry
        </button>
      </div>
    );
  return (
    <section aria-label="Not in this snapshot" className="flex flex-col gap-2 text-body-sm">
      {lineage ? (
        <>
          <p className="m-0 text-ink">
            “{lineage.name}” was{" "}
            {lineage.change === "removed"
              ? "removed"
              : lineage.change === "split"
                ? "split"
                : "merged"}{" "}
            in a later build (#{lineage.retiredSeq}).
          </p>
          {lineage.successors.length > 0 ? (
            <>
              <p className="m-0 text-ink-muted">
                Its files are now in{lineage.successors.length > 1 ? " these" : ""}:
              </p>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {lineage.successors.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={atlasHref(base, { select: s.id, snapshot: snapshot.id }, params)}
                      className="text-ink underline-offset-2 hover:underline"
                    >
                      {successors.get(s.id) ?? "A successor"}
                    </Link>{" "}
                    <span className="text-micro text-ink-faint">
                      ({Math.round(s.share * 100)}% of its files)
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="m-0 text-ink-muted">
              Its files went to no single successor: look them up by name.
            </p>
          )}
        </>
      ) : (
        <p className="m-0 text-ink-muted">
          {focus.error.error} The link may be from another build, or what it named was removed.
        </p>
      )}
      {snapshot.expiresAt && (
        <Link
          to={atlasHref(base, { snapshot: null }, params)}
          className="mk-btn mk-btn--sm self-start"
        >
          Open the current view
        </Link>
      )}
    </section>
  );
}

/** Names for a retired capability's successors: one ancestors read each, at most six. */
function useSuccessorNames(
  atlas: AtlasRepo,
  snapshot: AtlasSnapshotRef,
  successors: { id: string }[],
): Map<string, string> {
  const [names, setNames] = useState(new Map<string, string>());
  const key = successors
    .slice(0, 6)
    .map((s) => s.id)
    .join("\n");
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    void Promise.all(
      key.split("\n").map((id) =>
        atlasApi
          .ancestors(atlas, id, { snapshot: snapshot.id, signal: controller.signal })
          .then((chain) => [id, chain.entity.name] as const)
          .catch(() => null),
      ),
    ).then((found) => {
      if (controller.signal.aborted) return;
      setNames(new Map(found.filter((entry) => entry !== null)));
    });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, snapshot.id]);
  return names;
}

/**
 * Find a capability, area, file or symbol by name or path in this snapshot's
 * catalogue: a lookup, not search. Code and wiki search is a separate,
 * explicit step into the palette, for this repository only.
 */
function Lookup({
  atlas,
  base,
  snapshot,
  commit,
  url,
  onQuery,
  onKind,
  onPick,
}: {
  atlas: AtlasRepo;
  base: string;
  snapshot: AtlasSnapshotRef;
  commit: string | null;
  url: AtlasUrlState;
  onQuery: (q: string) => void;
  onKind: (kind: string | null) => void;
  onPick: (entity: AtlasEntitySummary) => void;
}) {
  const { repo } = useAtlasBase();
  const viewer = useViewer();
  const palette = usePalette();
  const [text, setText] = useState(url.q);
  const written = useRef(url.q);
  // Back/Forward change the address under the field: follow it.
  useEffect(() => {
    if (url.q === written.current) return;
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
    () =>
      new CatalogueLookup(
        (q, kind, cursor, signal) =>
          atlasApi.catalogue(atlas, q, {
            kind: kind ?? undefined,
            snapshot: snapshot.id,
            cursor,
            signal,
            limit: 20,
          }),
        setState,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.id],
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
              setShowMatches(true);
              onQuery(event.target.value);
            }}
          />
        </span>
      </label>
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
      {state.status === "failed" && state.restart && <Expired error={state.restart} base={base} />}
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
                  {item.path && (
                    <span className="w-full truncate font-mono text-micro text-ink-faint">
                      {item.path}
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
      {query && viewer && (
        <div className="flex flex-col gap-1 border-t border-line-soft pt-2">
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--sm h-auto min-h-8 max-w-full self-start py-1 text-left whitespace-normal pointer-coarse:min-h-11"
            onClick={() =>
              palette.open({
                repo: {
                  owner: repo.owner.slug,
                  name: repo.name,
                  defaultBranch: repo.defaultBranch,
                },
                query,
                submit: true,
                atlas: { href: base, commit },
              })
            }
          >
            <MagnifyingGlassIcon aria-hidden /> Search code and wiki in {repo.owner.slug}/
            {repo.name}
          </button>
          <p className="m-0 text-micro text-ink-faint">
            The lookup above reads only this Atlas snapshot. Code and wiki search uses this
            repository's search index, and runs only when you ask.
          </p>
        </div>
      )}
    </div>
  );
}

/** What's inside a region, as the map loads it: a page at a time. */
function Contents({
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

/** What the map's shapes mean, and what they don't. */
function Legend() {
  return (
    <details className="text-micro text-ink-muted">
      <summary className="cursor-pointer text-ink-faint">Reading the map</summary>
      <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
        <li>
          <strong className="text-ink">Area</strong> is how many files live there, in power-of-two
          steps: not complexity, importance or quality.
        </li>
        <li>
          <strong className="text-ink">Position</strong> is a stable landmark: a capability keeps
          its place while it continues. Being near another doesn't mean they depend on each other.
        </li>
        <li>
          <strong className="text-ink">Boundaries</strong> are primary membership: each file lives
          in exactly one capability; ties to others are listed as references, not drawn twice.
        </li>
        <li>
          <strong className="text-ink">Dashed regions</strong> are structural groups (unclassified
          files, concepts, dependencies, folders), not capabilities; the outline says “Structural
          group”.
        </li>
        <li>
          <span
            aria-hidden
            className="mr-1 inline-block size-2 rounded-full bg-data-berry align-middle"
          />
          <strong className="text-ink">A dot in a region's corner</strong>: it changed in the build
          this map shows; the outline says “changed in this build”.
        </li>
        <li>
          <strong className="text-ink">The outline</strong> holds everything the map draws, and
          more: use the arrow keys to move, Right to open, Left to close, Enter to select.
        </li>
      </ul>
    </details>
  );
}

/** The wiki page written for an entity, if any; the repository's is the wiki's first page. */
function wikiPageFor(pages: WikiCatalog["pages"], entity: AtlasEntitySummary) {
  return (
    pages.find((p) => p.nodeId === entity.id) ??
    (entity.kind === "repository" ? pages[0] : undefined) ??
    null
  );
}
