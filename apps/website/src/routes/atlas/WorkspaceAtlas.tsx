// The Semantic Code Atlas across an account's repositories (CORE-172), at
// /:owner/-/atlas?repos=a,b, linked as Knowledge from the account page.
//
// You pick the account, then the repositories, explicitly; the URL holds the
// selection, so a copied link reproduces it. Every selected repository is
// listed with its own indexed commit and build and its state (ready,
// building, unavailable, not enabled, partial, lagging): there is no common
// HEAD. Selecting a repository without Knowledge says so and starts nothing.
// The map is each repository's own territory in its own column (see
// workspace.ts for why columns). Changing the scope remounts the view, so
// nothing read for the previous scope stays on screen or arrives late.
//
// Since CORE-184 it works like a repository's Knowledge tab (repo/Atlas.tsx),
// with the same parts over the workspace API: the inspector, relationship lens
// and evidence (AtlasInspector through an AtlasReader), the outline, the
// lookup, and the address as its state (select, composite snapshot, lens,
// lookup, view; copied links and Back/Forward come back to the same place,
// an expired link explains and offers the current view). Capabilities spanning
// repositories (CORE-167) are drawn as lines joining their members' regions,
// listed first in the outline, and inspected with their cross-repository
// evidence at immutable commits. Every read is a bounded page under
// /api/accounts/:owner/atlas, re-authorized by the server each time.

import { ArrowClockwiseIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigationType,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import { useLiveSearchParams } from "../../lib/searchParams.ts";
import type { AccountPage, RepoSummary } from "../../../shared/api.ts";
import {
  ATLAS_WORKSPACE_MAX_REPOS,
  type AtlasCompositeCapability,
  type AtlasCompositionCoverage,
  type AtlasEntitySummary,
  type AtlasRegion,
} from "../../../shared/atlas.ts";
import type { Snapshot as TrackerSnapshot } from "../../../shared/tracker.ts";
import { Page } from "../../components/AppShell.tsx";
import { SelectField, VisibilityChip, link } from "../../components/ui.tsx";
import { api, ApiError, load } from "../../lib/api.ts";
import { atlasWorkspaceApi, workspaceReader, type AtlasWorkspace } from "../../lib/atlas.ts";
import { timeAgo } from "../../lib/format.ts";
import { useMediaQuery } from "../../lib/useMediaQuery.ts";
import { useViewer } from "../../lib/session.ts";
import { AtlasInspector } from "../repo/AtlasInspector.tsx";
import { AtlasTimeline } from "../repo/AtlasTimeline.tsx";
import { scopeOf } from "../../lib/timelineScope.ts";
import { AtlasOutline, KIND_LABEL } from "../repo/AtlasOutline.tsx";
import { AtlasContents, AtlasGone, AtlasLookup } from "../repo/AtlasPanels.tsx";
import { FocusResolver, OPENS, type Focus } from "../repo/atlasNavigation.ts";
import { scopeNotices } from "../repo/atlasStates.ts";
import {
  atlasHref,
  readAtlasUrl,
  writeAtlasUrl,
  type AtlasUrlState,
  type AtlasView,
} from "../repo/atlasUrl.ts";
import { AtlasTerritory, type MapBand } from "../repo/AtlasTerritory.tsx";
import type { TerritoryCell } from "../repo/territory.ts";
import { useMapRoutes } from "../repo/useMapRoutes.ts";
import {
  BAND_HEADER,
  buildWorkspaceTerritory,
  compositeSummary,
  coverageOf,
  initialWorkspaceState,
  isComposite,
  parseLinkState,
  parseSelection,
  repoOf,
  rescopeSearch,
  scopeKey,
  tiesOf,
  toggleSelection,
  WorkspaceSession,
  type CompositionView,
  type Coverage,
  type WorkspaceState,
} from "./workspace.ts";
import { CompositeInspector, CrossLinks } from "./WorkspaceInspector.tsx";

export async function workspaceAtlasLoader({ request, params }: LoaderFunctionArgs) {
  return load<AccountPage>(`/accounts/${encodeURIComponent(params.owner ?? "")}`, request);
}

/** The account's repositories only change with the account: the selection and view state are the view's. */
export function workspaceAtlasShouldRevalidate({
  currentParams,
  nextParams,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return currentParams.owner !== nextParams.owner || formMethod ? defaultShouldRevalidate : false;
}

const short = (sha: string) => sha.slice(0, 7);

export function WorkspaceAtlas() {
  const account = useLoaderData<typeof workspaceAtlasLoader>();
  const location = useLocation();
  const navigate = useNavigate();
  const selection = useMemo(
    () => parseSelection(new URLSearchParams(location.search).get("repos"), account.slug),
    [location.search, account.slug],
  );
  // A new selection is a new scope: what was selected, pinned or looked up stays behind.
  const select = (next: string[]) =>
    void navigate({ search: rescopeSearch(location.search, next) });

  return (
    <Page full>
      <header className="flex flex-col gap-1">
        <nav aria-label="Breadcrumb" className="text-body-sm text-ink-muted">
          <Link
            to={`/${encodeURIComponent(account.slug)}`}
            className="text-ink-muted no-underline hover:text-ink"
          >
            <bdi>{account.slug}</bdi>
          </Link>
          <span className="px-1.5 text-ink-faint">/</span>
          <span aria-current="page">Atlas</span>
        </nav>
        <h1 className="m-0 text-headline">Atlas</h1>
        <p className="m-0 max-w-[70ch] text-ink-muted">
          Capabilities across the repositories you pick from <bdi>{account.displayName}</bdi>. Each
          repository is read at its own indexed commit: there's no shared head.
        </p>
      </header>
      <ScopePicker account={account} selection={selection} onSelect={select} />
      {selection.length === 0 ? (
        <div className="mk-empty mt-4">
          Pick one or more repositories above to see their capabilities together.
        </div>
      ) : (
        <WorkspaceView
          key={scopeKey(account.slug, selection)}
          owner={account.slug}
          selection={selection}
          accountRepos={account.repos}
        />
      )}
    </Page>
  );
}

// ---- choosing the scope --------------------------------------------------------------

function ScopePicker({
  account,
  selection,
  onSelect,
}: {
  account: AccountPage;
  selection: string[];
  onSelect: (next: string[]) => void;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [filter, setFilter] = useState("");
  const accounts = useMemo(() => {
    const list = [...(viewer?.canCreateIn ?? [])];
    if (!list.some((a) => a.slug === account.slug)) list.unshift(account);
    return list.map((a) => ({ value: a.slug, label: `${a.displayName} (@${a.slug})` }));
  }, [viewer, account]);
  const shown = account.repos.filter((r) =>
    r.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const full = selection.length >= ATLAS_WORKSPACE_MAX_REPOS;

  return (
    <section
      aria-label="Scope"
      className="mt-5 flex flex-col gap-3 rounded-pane bg-pane p-3 sm:p-4"
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-body-sm text-ink-muted">
          Account
          <SelectField
            value={account.slug}
            options={accounts}
            ariaLabel="Account"
            className="min-w-56"
            // Another account is another scope: start with nothing selected.
            onChange={(slug) => {
              if (slug !== account.slug) void navigate(`/${slug}/-/atlas`);
            }}
          />
        </label>
        {account.repos.length > 8 && (
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-body-sm text-ink-muted">
            Find a repository
            <input
              type="search"
              className="mk-input"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Name"
            />
          </label>
        )}
        <TrackerSeed owner={account.slug} repos={account.repos} onSeed={onSelect} />
      </div>

      <fieldset className="m-0 min-w-0 border-0 p-0">
        <legend className="mb-1.5 p-0 text-body-sm text-ink-muted">
          Repositories you can read ·{" "}
          <span className="tabular-nums">
            {selection.length} of at most {ATLAS_WORKSPACE_MAX_REPOS} selected
          </span>
        </legend>
        {account.repos.length === 0 ? (
          <p className="m-0 text-body-sm text-ink-faint">
            This account has no repositories you can read.
          </p>
        ) : (
          <ul className="m-0 grid max-h-56 list-none grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-x-3 overflow-y-auto p-0">
            {shown.map((repo) => {
              const checked = selection.includes(repo.name);
              return (
                <li key={repo.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-plate px-2 hover:bg-raised">
                    <input
                      type="checkbox"
                      className="m-0 size-4 shrink-0 cursor-pointer accent-signal"
                      checked={checked}
                      disabled={!checked && full}
                      onChange={() => onSelect(toggleSelection(selection, repo.name))}
                    />
                    <span className="min-w-0 flex-1 truncate text-body-sm">
                      <bdi>{repo.name}</bdi>
                    </span>
                    {repo.visibility === "private" && <VisibilityChip visibility="private" />}
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      {selection.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-body-sm text-ink-muted">Selected, in map order:</span>
          {selection.map((name) => (
            <span key={name} className="mk-chip mk-chip--removable">
              <bdi>{name}</bdi>
              <button
                type="button"
                className="mk-chip-remove"
                aria-label={`Remove ${name}`}
                onClick={() => onSelect(selection.filter((n) => n !== name))}
              >
                <XIcon weight="bold" className="size-3" aria-hidden />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--sm"
            onClick={() => onSelect([])}
          >
            Clear
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Start from a tracker workspace's subscribed repositories: read once, only
 * when asked, and only to fill the selection. Nothing is subscribed or saved.
 */
function TrackerSeed({
  owner,
  repos,
  onSeed,
}: {
  owner: string;
  repos: RepoSummary[];
  onSeed: (names: string[]) => void;
}) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ready"; workspaces: { id: string; name: string; repos: string[] }[] }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  useEffect(() => {
    if (state.kind !== "loading") return;
    const controller = new AbortController();
    api<TrackerSnapshot>(`/tracker/${encodeURIComponent(owner)}/snapshot`, {
      signal: controller.signal,
    })
      .then((snapshot) => {
        const readable = new Set(repos.map((r) => r.name));
        const workspaces = snapshot.workspaces
          .filter((w) => !w.archived)
          .map((w) => ({
            id: w.id,
            name: w.name,
            repos: snapshot.subscriptions
              .filter((s) => s.workspaceId === w.id && s.owner === owner && readable.has(s.name))
              .map((s) => s.name)
              .filter((name, i, all) => all.indexOf(name) === i)
              .slice(0, ATLAS_WORKSPACE_MAX_REPOS),
          }))
          .filter((w) => w.repos.length > 0);
        setState({ kind: "ready", workspaces });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          kind: "error",
          message:
            error instanceof ApiError && (error.status === 403 || error.status === 401)
              ? "Tracker workspaces are visible to this account's members."
              : "Couldn't read this account's tracker workspaces.",
        });
      });
    return () => controller.abort();
  }, [state.kind, owner, repos]);

  return (
    <details
      className="relative text-body-sm"
      onToggle={(event) => {
        if (event.currentTarget.open && state.kind === "idle") setState({ kind: "loading" });
      }}
    >
      <summary className="mk-btn mk-btn--sm cursor-pointer list-none">
        From a tracker workspace…
      </summary>
      <div className="mt-2 flex max-w-80 flex-col gap-1 rounded-plate bg-raised p-2">
        {state.kind === "loading" && <p className="m-0 p-1 text-ink-faint">Loading workspaces…</p>}
        {state.kind === "error" && <p className="m-0 p-1 text-ink-muted">{state.message}</p>}
        {state.kind === "ready" && state.workspaces.length === 0 && (
          <p className="m-0 p-1 text-ink-muted">
            No workspace here subscribes to repositories of this account you can read.
          </p>
        )}
        {state.kind === "ready" &&
          state.workspaces.map((w) => (
            <button
              key={w.id}
              type="button"
              className="flex min-h-9 cursor-pointer items-center gap-2 rounded-plate border-0 bg-transparent px-2 text-left hover:bg-pressed"
              onClick={() => onSeed(w.repos)}
            >
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              <span className="text-micro text-ink-faint tabular-nums">
                {w.repos.length} repo{w.repos.length === 1 ? "" : "s"}
              </span>
            </button>
          ))}
        <p className="m-0 p-1 text-micro text-ink-faint">
          Fills the selection with its repositories. Nothing is subscribed or saved.
        </p>
      </div>
    </details>
  );
}

// ---- the view of one scope -----------------------------------------------------------

/** Below this, the outline is the default and the inspector reads in line. */
const NARROW = "(max-width: 1023.98px)";

type CompositeFocus =
  | { state: "none" }
  | { state: "resolving"; id: string }
  | { state: "ready"; id: string; composite: AtlasCompositeCapability }
  | { state: "missing"; id: string }
  | { state: "error"; id: string; message: string };

function WorkspaceView({
  owner,
  selection,
  accountRepos,
}: {
  owner: string;
  selection: string[];
  accountRepos: RepoSummary[];
}) {
  const base = `/${encodeURIComponent(owner)}/-/atlas`;
  const [params, setParams] = useLiveSearchParams();
  const url = readAtlasUrl(params);
  const links = parseLinkState(params.get("links"));
  const navigationType = useNavigationType();
  const navigate = (
    patch: Partial<AtlasUrlState>,
    replace = false,
    extra: Record<string, string | null> = {},
  ) =>
    setParams(
      (current) => {
        const next = writeAtlasUrl(current, patch);
        for (const [key, value] of Object.entries(extra))
          if (value === null) next.delete(key);
          else next.set(key, value);
        return next;
      },
      { replace, preventScrollReset: true },
    );

  // ---- the session: one per scope, opened at the address's composite ----------------
  const selectionKey = selection.join(",");
  const workspace = useMemo<AtlasWorkspace>(
    () => ({ owner, repos: selectionKey.split(",") }),
    [owner, selectionKey],
  );
  const reader = useMemo(() => workspaceReader(workspace), [workspace]);
  const [state, setState] = useState<WorkspaceState>(initialWorkspaceState);
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  /** The composite last asked for: the address's, or null for the current one. */
  const asked = useRef<string | null>(url.snapshot);
  useEffect(() => {
    const opened = new WorkspaceSession(workspace, atlasWorkspaceApi, setState);
    setSession(opened);
    void opened.open(asked.current);
    return () => opened.dispose();
  }, [workspace]);
  // A link to another composite (e.g. "Open the current view") reads it.
  useEffect(() => {
    if (!session || !url.snapshot) return;
    if (url.snapshot === asked.current || url.snapshot === state.overview?.snapshot.id) return;
    asked.current = url.snapshot;
    void session.open(url.snapshot);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.snapshot, session]);
  const openCurrent = () => {
    asked.current = null;
    void session?.open();
    navigate({ snapshot: null }, true);
  };

  const overview = state.overview;
  const snapshotId = overview?.snapshot.id ?? "";
  const coverage = useMemo(
    () => coverageOf(selection, overview?.snapshot.repos ?? [], state.revoked),
    [selection, overview, state.revoked],
  );
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const r of overview?.snapshot.repos ?? []) names.set(r.id, r.name);
    return names;
  }, [overview]);
  const repoSnapshot = (repoId: string | undefined) =>
    overview?.snapshot.repos.find((r) => r.id === repoId)?.snapshot ?? null;

  // ---- regions opened, on the map and in the outline ---------------------------------
  const expanded = useMemo(() => {
    const ready = new Map<string, AtlasEntitySummary[]>();
    for (const [id, l] of state.loads) if (l.state === "ready") ready.set(id, l.items);
    return ready;
  }, [state.loads]);
  const territory = useMemo(
    () => buildWorkspaceTerritory(coverage, overview?.regions ?? [], expanded, overview?.links),
    [coverage, overview, expanded],
  );
  const territoryRef = useRef(territory);
  territoryRef.current = territory;
  const loading = useMemo(
    () => new Set([...state.loads].filter(([, l]) => l.state === "loading").map(([id]) => id)),
    [state.loads],
  );
  const bands = useMemo(
    () =>
      territory.bands.map((band): MapBand => ({
        id: band.name,
        x: band.x,
        y: band.y,
        w: band.w,
        h: band.h,
        header: BAND_HEADER,
        label: band.name,
        note: bandNote(band.coverage),
      })),
    [territory],
  );
  const composites = state.composition?.status === "ready" ? state.composition.items : NONE;

  // ---- the selection, from the address ---------------------------------------------
  const [focus, setFocus] = useState<Focus>({ state: "none" });
  const [compositeFocus, setCompositeFocus] = useState<CompositeFocus>({ state: "none" });
  const [focusOnShow, setFocusOnShow] = useState<string | null>(null);
  const resolver = useMemo(
    () =>
      session && snapshotId
        ? new FocusResolver(
            (id, signal) => reader.ancestors(id, { snapshot: snapshotId, signal }),
            (id) => session.ensure(id),
            setFocus,
          )
        : null,
    [session, snapshotId, reader],
  );
  useEffect(() => () => resolver?.dispose(), [resolver]);
  const narrowNow = useRef(false);
  useEffect(() => {
    if (!resolver || !session) return;
    setFocusOnShow(navigationType === "POP" || narrowNow.current ? url.select : null);
    if (isComposite(url.select)) {
      void resolver.focus(null);
      const id = url.select;
      const controller = new AbortController();
      setCompositeFocus({ state: "resolving", id });
      session.composite(id, controller.signal).then(
        (composite) => {
          if (controller.signal.aborted) return;
          setCompositeFocus(
            composite ? { state: "ready", id, composite } : { state: "missing", id },
          );
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setCompositeFocus({
            state: "error",
            id,
            message: error instanceof Error ? error.message : "Couldn't open it.",
          });
        },
      );
      return () => controller.abort();
    }
    setCompositeFocus({ state: "none" });
    void resolver.focus(
      url.select,
      url.select ? territoryRef.current.byId.get(url.select)?.entity : undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url.select, resolver]);
  // A pinned read that can't continue: the session re-checks access or offers the current view.
  useEffect(() => {
    if (focus.state === "restart") session?.failed(focus.error);
  }, [focus, session]);

  const select = (entity: AtlasEntitySummary) => {
    if (entity.id === url.select) return;
    navigate({ select: entity.id, snapshot: snapshotId || null });
  };
  const selected = focus.state === "ready" ? focus.entity : null;
  // A timeline (`?tl`) across the selection (CORE-186): its panel, and the
  // capabilities it touches marked on the map and in the outline.
  const timeline = scopeOf(params);
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set());
  const touchedNote = timeline && touched.size ? `touched by timeline ${timeline}` : null;
  const mapFocus = useMemo(() => {
    if (focus.state !== "ready") return null;
    if (territory.byId.has(focus.id)) return focus.id;
    for (const a of [...(focus.ancestors ?? [])].reverse())
      if (territory.byId.has(a.id)) return a.id;
    return null;
  }, [focus, territory]);
  const ties = useMemo(() => tiesOf(composites, url.select), [composites, url.select]);

  // ---- the outline's top level: composites, the overview's regions, then the catalogue -
  const [catalogue, setCatalogue] = useState<{
    snapshot: string;
    items: AtlasRegion[];
    next: string | null;
    loading: boolean;
    error: string | null;
  } | null>(null);
  const shownCatalogue =
    catalogue?.snapshot === snapshotId
      ? catalogue
      : {
          snapshot: snapshotId,
          items: overview?.catalogue.items ?? [],
          next: overview?.catalogue.next ?? null,
          loading: false,
          error: null,
        };
  const moreRegions = () => {
    const now = shownCatalogue;
    if (!now.next || now.loading) return;
    setCatalogue({ ...now, loading: true, error: null });
    atlasWorkspaceApi
      .regions(workspace, { snapshot: snapshotId, cursor: now.next, limit: 50 })
      .then(
        (page) =>
          setCatalogue((c) =>
            c?.snapshot === now.snapshot
              ? {
                  ...c,
                  items: [...c.items, ...page.items],
                  next: page.next,
                  loading: false,
                  error: null,
                }
              : c,
          ),
        (error: unknown) => {
          session?.failed(error);
          setCatalogue((c) =>
            c?.snapshot === now.snapshot
              ? {
                  ...c,
                  loading: false,
                  error: error instanceof Error ? error.message : "Couldn't load more regions.",
                }
              : c,
          );
        },
      );
  };
  const readable = useMemo(
    () => new Set((overview?.snapshot.repos ?? []).map((r) => r.id)),
    [overview],
  );
  const roots = useMemo(
    () => [
      ...composites.map(compositeSummary),
      ...(overview?.regions ?? []),
      ...shownCatalogue.items.filter((r) => readable.has(r.repoId ?? "")),
    ],
    [composites, overview, shownCatalogue.items, readable],
  );
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
  const where = useMemo(() => {
    if (focus.state !== "ready") return [];
    const repo = nameOf.get(focus.entity.repoId ?? "");
    const trail = focus.ancestors
      ? focus.ancestors.slice(1).map((a) => a.name)
      : path.flatMap((id) => {
          const name = territory.byId.get(id)?.entity.name;
          return name ? [name] : [];
        });
    return repo ? [repo, ...trail] : trail;
  }, [focus, path, territory, nameOf]);

  // ---- the view: the map, or the outline (the default on narrow screens) --------------
  const narrow = useMediaQuery(NARROW);
  narrowNow.current = narrow;
  const view: AtlasView = url.view ?? (narrow ? "outline" : "map");
  const routes = useMapRoutes(
    reader,
    view === "map" && selected && mapFocus === selected.id ? selected : null,
    snapshotId || null,
  );
  const tree = useRef<HTMLDivElement>(null);
  const backToOutline = () => {
    const target =
      tree.current?.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]') ??
      tree.current?.querySelector<HTMLElement>('[role="treeitem"]');
    target?.focus();
  };

  if (state.status === "loading")
    return (
      <p className="mt-4 text-body-sm text-ink-faint" aria-live="polite">
        Reading {selection.length} repositor{selection.length === 1 ? "y" : "ies"}…
      </p>
    );
  if (state.status === "gone" && state.gone)
    return (
      <div className="mt-4">
        <AtlasGone
          error={state.gone}
          base={base}
          noCurrent="None of the selected repositories has a current Atlas to open instead."
        />
      </div>
    );
  if (state.status === "error" || state.status === "gone")
    return (
      <div className="mt-4 flex items-center gap-2 text-body-sm text-danger-text" role="alert">
        {state.error}
        <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={openCurrent}>
          <ArrowClockwiseIcon weight="bold" aria-hidden /> Retry
        </button>
      </div>
    );

  const regions = overview?.regions ?? [];
  const capabilities = regions.filter((r) => !r.structural).length;
  const ready = coverage.filter((c) => c.state === "ready").length;
  const seqOf = (entity: AtlasEntitySummary) => repoSnapshot(entity.repoId)?.seq ?? 0;
  const noteOf = (entity: AtlasEntitySummary) => {
    if (isComposite(entity.id)) {
      const composite = composites.find((x) => x.id === entity.id);
      return composite
        ? `spans ${composite.repos.map((id) => nameOf.get(id) ?? "?").join(", ")}`
        : null;
    }
    const repo = nameOf.get(entity.repoId ?? "");
    return repo && entity.parentId === `${entity.repoId}/repo` ? `in ${repo}` : null;
  };
  const selectedSnapshot = selected ? repoSnapshot(selected.repoId) : null;
  const selectedRepo = selected ? nameOf.get(selected.repoId ?? "") : undefined;
  const crossLinks =
    selected && (selected.kind === "capability" || selected.id.endsWith("/group:unclassified"))
      ? "out"
      : selected?.kind === "repository"
        ? "in"
        : null;

  const outline = (
    <AtlasOutline
      treeRef={tree}
      label={`Outline of ${selection.join(", ")}`}
      roots={roots}
      rootsMore={shownCatalogue.next !== null}
      rootsCount={(overview?.totalRegions ?? 0) + composites.length}
      rootsState={shownCatalogue.loading ? "loading" : shownCatalogue.error ? "error" : null}
      loads={state.loads}
      selected={url.select}
      path={path}
      seq={seqOf}
      note={noteOf}
      emphasis={touched}
      emphasisNote={touchedNote}
      onOpen={(id) => session?.ensure(id)}
      onRetry={(id) => session?.expand(id)}
      onMore={(id) => {
        const load = state.loads.get(id);
        if (load?.state === "ready" && load.next) session?.expand(id, load.next, load.items);
      }}
      onMoreRoots={moreRegions}
      onSelect={select}
    />
  );
  const lookup = (
    <AtlasLookup
      fetch={(q, kind, cursor, signal) =>
        reader.catalogue(q, {
          kind: kind ?? undefined,
          snapshot: snapshotId,
          cursor,
          signal,
          limit: 20,
        })
      }
      snapshot={snapshotId}
      base={base}
      url={url}
      origin={(item) => nameOf.get(item.repoId ?? "") ?? null}
      onQuery={(q) => navigate({ q }, true)}
      onKind={(kind) => navigate({ kind }, true)}
      onPick={select}
    >
      <p className="m-0 border-t border-line-soft pt-2 text-micro text-ink-faint">
        The lookup reads only the selected repositories' Atlas snapshots. Code and wiki search runs
        for one repository at a time, from its Knowledge tab, and only when you ask.
      </p>
    </AtlasLookup>
  );
  const inspector = (
    <>
      {timeline && overview && (
        <AtlasTimeline
          key={timeline}
          workspace={workspace}
          snapshot={{ id: snapshotId }}
          timeline={timeline}
          selected={selected}
          onSelect={(id) => navigate({ select: id, snapshot: snapshotId || null })}
          onCurrent={openCurrent}
          onTouched={setTouched}
        />
      )}
      {(focus.state === "resolving" || compositeFocus.state === "resolving") && (
        <p className="m-0 text-body-sm text-ink-faint">Opening the selection…</p>
      )}
      {(focus.state === "missing" ||
        focus.state === "error" ||
        compositeFocus.state === "missing" ||
        compositeFocus.state === "error") && (
        <section aria-label="Not in this snapshot" className="flex flex-col gap-2 text-body-sm">
          <p className="m-0 text-ink-muted">
            {compositeFocus.state === "error"
              ? `Couldn't open the selection: ${compositeFocus.message}`
              : focus.state === "error"
                ? `Couldn't open the selection: ${focus.message}`
                : compositeFocus.state === "missing"
                  ? "No capability spans these repositories under that name in this snapshot. The link may be from another selection or build."
                  : "That isn't in this Atlas snapshot. The link may be from another selection or build, or what it named was removed."}
          </p>
          {url.snapshot && (
            <Link
              to={atlasHref(base, { snapshot: null }, params)}
              className="mk-btn mk-btn--sm self-start"
            >
              Open the current view
            </Link>
          )}
        </section>
      )}
      {compositeFocus.state === "ready" && (
        <CompositeInspector
          key={compositeFocus.id}
          workspace={workspace}
          snapshot={snapshotId}
          composite={compositeFocus.composite}
          names={nameOf}
          autoFocus={focusOnShow === compositeFocus.id}
          onPick={select}
          onFailed={(error) => session?.failed(error)}
        />
      )}
      {selected && selectedSnapshot && selectedRepo && (
        <>
          <AtlasInspector
            key={selected.id}
            repo={{ owner, name: selectedRepo }}
            reader={reader}
            snapshot={{ ...selectedSnapshot, id: snapshotId }}
            entity={selected}
            lens={url.lens}
            autoFocus={focusOnShow === selected.id}
            onPick={select}
            onLens={(lens) => navigate({ lens, snapshot: snapshotId })}
            onRestart={(error) => session?.failed(error)}
            contents={
              OPENS.has(selected.kind) ? (
                <AtlasContents
                  entity={selected}
                  load={state.loads.get(selected.id)}
                  onPick={select}
                  onRetry={() => session?.expand(selected.id)}
                  onMore={(cursor, items) => session?.expand(selected.id, cursor, items)}
                />
              ) : null
            }
          />
          {crossLinks && (
            <CrossLinks
              key={`${selected.id}|${crossLinks}`}
              workspace={workspace}
              snapshot={snapshotId}
              entity={selected}
              names={nameOf}
              state={crossLinks === "in" ? "resolved" : links}
              direction={crossLinks}
              heading={crossLinks === "in" ? "Depended on across repositories" : undefined}
              onState={
                crossLinks === "out"
                  ? (next) =>
                      navigate({ snapshot: snapshotId }, false, {
                        links: next === "resolved" ? null : next,
                      })
                  : undefined
              }
              onPick={select}
              onFailed={(error) => session?.failed(error)}
            />
          )}
        </>
      )}
      {(selected || compositeFocus.state === "ready") && view === "outline" && narrow && (
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
  const moreComposites =
    state.composition?.status === "ready" && state.composition.next ? (
      <button
        type="button"
        className="mk-btn mk-btn--ghost mk-btn--sm self-start"
        disabled={state.composition.more === "loading"}
        onClick={() => void session?.moreComposites()}
      >
        {state.composition.more === "loading"
          ? "Loading…"
          : state.composition.more === "error"
            ? "Couldn't load more capabilities across repositories. Retry"
            : "More capabilities across repositories"}
      </button>
    ) : null;

  return (
    <div className="mt-4 flex min-w-0 flex-col gap-4">
      {state.notice && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-pane bg-danger-wash px-3 py-2 text-body-sm"
        >
          <span className="min-w-0 flex-1">
            {state.notice.kind === "access"
              ? `You can no longer read ${state.notice.lost.join(", ")}. Everything from ${
                  state.notice.lost.length === 1 ? "it" : "them"
                } was removed from this view.`
              : state.notice.message}
          </span>
          <button type="button" className="mk-btn mk-btn--sm" onClick={openCurrent}>
            Open the current view
          </button>
        </div>
      )}

      <CoverageList
        coverage={coverage}
        regions={regions}
        accountRepos={accountRepos}
        owner={owner}
        empty={state.status === "empty"}
        composition={state.composition}
      />

      {ready === 0 ? (
        <div className="mk-empty">
          {state.status === "empty"
            ? "None of the selected repositories is one you can read."
            : "None of the selected repositories has an Atlas yet, so there's no map to draw."}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-body-sm text-ink-muted tabular-nums">
              {(overview?.totalRegions ?? 0).toLocaleString()} regions
              {composites.length > 0 &&
                ` · ${composites.length.toLocaleString()} ${
                  composites.length === 1 ? "capability spans" : "capabilities span"
                } repositories`}
              {url.snapshot && " · a linked snapshot"}
            </span>
            <div role="group" aria-label="View" className="ml-auto flex gap-1">
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
          </div>
          <p role="status" className="sr-only">
            {focus.state === "resolving" || compositeFocus.state === "resolving"
              ? "Opening the selection…"
              : compositeFocus.state === "ready"
                ? `Selected ${compositeFocus.composite.name}, a capability across repositories.`
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
                  bands={bands}
                  ties={ties}
                  routes={routes}
                  selected={mapFocus}
                  loading={loading}
                  emphasis={timeline ? touched : undefined}
                  emphasisNote={touchedNote}
                  onSelect={(cell: TerritoryCell) => select(cell.entity)}
                  origin={(cell) => {
                    const name = nameOf.get(repoOf(cell.id));
                    return name ? `in ${name}` : null;
                  }}
                  label={`Capability map of ${territory.bands.length} repositor${
                    territory.bands.length === 1 ? "y" : "ies"
                  }, one column each in selection order: ${capabilities} capabilities${
                    regions.length > capabilities ? " and structural groups" : ""
                  }${
                    composites.length
                      ? `, with lines joining the ${composites.length} that span repositories`
                      : ""
                  }.${
                    touchedNote
                      ? ` ${touched.size} outlined with a dashed line: ${touchedNote}.`
                      : ""
                  } The outline beside it has the same regions, and more.`}
                />
              </div>
              <aside
                aria-label="Regions"
                className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto rounded-pane bg-pane p-3"
              >
                {lookup}
                {inspector}
                {outline}
                {moreComposites}
                <Legend />
              </aside>
            </div>
          ) : narrow ? (
            <div className="flex min-w-0 flex-col gap-3 rounded-pane bg-pane p-3">
              {lookup}
              {inspector}
              {outline}
              {moreComposites}
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
                {moreComposites}
                <Legend />
              </section>
              <aside
                aria-label="Selection"
                className="flex min-w-0 flex-col gap-3 rounded-pane bg-pane p-3 lg:sticky lg:top-3 lg:max-h-[calc(100dvh-1.5rem)] lg:overflow-y-auto"
              >
                {inspector}
                {!selected && compositeFocus.state === "none" && focus.state === "none" && (
                  <p className="m-0 text-body-sm text-ink-faint">
                    Choose an entry in the outline to read about it here.
                  </p>
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const NONE: readonly AtlasCompositeCapability[] = [];

/** The band's second line on the map: its own commit, or why there's nothing. */
function bandNote(entry: Coverage): string {
  switch (entry.state) {
    case "ready": {
      const snapshot = entry.repo.snapshot;
      const commit = snapshot?.vector.find((v) => v.repoId === entry.repo.id)?.commit;
      return [
        commit ? `at ${short(commit)}` : "indexed",
        snapshot?.partial ? "partial" : null,
        entry.repo.building ? "newer build running" : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "building":
      return "Building: no Atlas yet";
    case "unavailable":
      return "No Atlas published";
    case "not-enabled":
      return "Knowledge not enabled";
    case "denied":
      return "Not available";
    case "revoked":
      return "Access removed";
  }
}

const STATE_LABEL: Record<Coverage["state"], string> = {
  ready: "Ready",
  building: "Building",
  unavailable: "Unavailable",
  "not-enabled": "Not enabled",
  denied: "Unavailable",
  revoked: "Access removed",
};

/** Every selected repository with its own vector and state, in selection order. */
function CoverageList({
  coverage,
  regions,
  accountRepos,
  owner,
  empty,
  composition,
}: {
  coverage: Coverage[];
  regions: readonly AtlasRegion[];
  accountRepos: RepoSummary[];
  owner: string;
  empty: boolean;
  composition: CompositionView | null;
}) {
  return (
    <section aria-labelledby="atlas-coverage">
      <h2 id="atlas-coverage" className="m-0 mb-2 text-title">
        Coverage
      </h2>
      <p className="m-0 mb-2 text-body-sm text-ink-faint">
        Each repository is read at its own indexed commit and build. They aren't aligned to a common
        point in time.
      </p>
      <CompositionSummary composition={composition} />
      <ul className="m-0 flex list-none flex-col divide-y divide-line-soft rounded-pane bg-pane p-0">
        {coverage.map((entry) => {
          const repo = entry.repo;
          const pushedAt = accountRepos.find((r) => r.name === entry.name)?.pushedAt ?? null;
          const own = repo ? regions.filter((r) => r.repoId === repo.id) : [];
          return (
            <li
              key={entry.name}
              className="grid gap-x-4 gap-y-1 px-3 py-2.5 sm:grid-cols-[minmax(10rem,14rem)_minmax(0,1fr)]"
            >
              <span className="flex min-w-0 items-center gap-2">
                {repo ? (
                  <Link
                    to={`/${encodeURIComponent(owner)}/${encodeURIComponent(entry.name)}`}
                    className={`${link} min-w-0 truncate font-semibold`}
                  >
                    <bdi>{entry.name}</bdi>
                  </Link>
                ) : (
                  <span className="min-w-0 truncate font-semibold text-ink-muted">
                    <bdi>{entry.name}</bdi>
                  </span>
                )}
                <span
                  className={`mk-chip mk-chip--tag ${entry.state === "ready" ? "" : "text-ink-faint"}`}
                >
                  {STATE_LABEL[entry.state]}
                </span>
              </span>
              <span className="min-w-0 text-body-sm text-ink-muted">
                <CoverageDetail entry={entry} pushedAt={pushedAt} own={own} empty={empty} />
                {repo && composition?.status === "ready" && (
                  <PackagesLine
                    packages={composition.coverage.find((c) => c.repoId === repo.id)?.packages}
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Capabilities spanning repositories (CORE-167), counted across the scope. */
function CompositionSummary({ composition }: { composition: CompositionView | null }) {
  if (!composition) return null;
  if (composition.status === "loading")
    return <p className="m-0 mb-2 text-body-sm text-ink-faint">Reading cross-repository links…</p>;
  if (composition.status === "error")
    return (
      <p className="m-0 mb-2 text-body-sm text-ink-faint">
        Cross-repository links couldn't be read: {composition.message}
      </p>
    );
  if (composition.composites === null || composition.resolved === null) return null;
  return (
    <p className="m-0 mb-2 text-body-sm text-ink-muted tabular-nums">
      {`${composition.composites.toLocaleString()} ${
        composition.composites === 1 ? "capability spans" : "capabilities span"
      } repositories here, with ${composition.resolved.toLocaleString()} resolved cross-repository ${
        composition.resolved === 1 ? "dependency" : "dependencies"
      }. Resolution depends on this selection: a dependency on a repository you leave out shows as unresolved.`}
    </p>
  );
}

/** Whether another selected repository's imports can resolve to this one's packages. */
function PackagesLine({
  packages,
}: {
  packages: AtlasCompositionCoverage["packages"] | undefined;
}) {
  switch (packages) {
    case "recorded":
      return (
        <span className="block">
          Published packages recorded: imports of them from the other selected repositories can
          resolve as dependencies.
        </span>
      );
    case "unrecorded":
      return (
        <span className="block">
          Published packages not recorded (built before they were): dependencies on it can't be
          resolved yet.
        </span>
      );
    case "error":
      return (
        <span className="block">
          The registry couldn't be read when it was built: dependencies on it can't be resolved.
        </span>
      );
    default:
      return null;
  }
}

function CoverageDetail({
  entry,
  pushedAt,
  own,
  empty,
}: {
  entry: Coverage;
  pushedAt: string | null;
  /** Its regions on the map. */
  own: readonly AtlasRegion[];
  empty: boolean;
}) {
  const shown = own.length;
  switch (entry.state) {
    case "ready": {
      const snapshot = entry.repo.snapshot;
      const vector = snapshot?.vector.find((v) => v.repoId === entry.repo.id);
      const lagging =
        pushedAt &&
        snapshot?.publishedAt &&
        Date.parse(pushedAt) > Date.parse(snapshot.publishedAt);
      return (
        <>
          Indexed at{" "}
          {vector ? (
            <span className="font-mono text-ink">{short(vector.commit)}</span>
          ) : (
            "its commit"
          )}
          {vector && (
            <>
              {" "}
              · build <span className="font-mono">{vector.buildId.slice(0, 8)}</span>
            </>
          )}
          {snapshot?.publishedAt && ` · ${timeAgo(snapshot.publishedAt)}`}
          {` · ${shown ? `${shown} region${shown === 1 ? "" : "s"} on the map` : "none of its regions are among the largest here"}`}
          {entry.repo.building && (
            <span className="block">Lagging: a newer Knowledge build is running.</span>
          )}
          {!entry.repo.building && lagging && (
            <span className="block">
              Lagging: pushed {timeAgo(pushedAt)}, after this Atlas was built.
            </span>
          )}
          {snapshot &&
            scopeNotices(null, {
              snapshot,
              capacityFailure: entry.repo.capacityFailure ?? null,
              regions: [...own],
            }).map((n) => (
              <span
                key={n.id}
                className={`block ${n.tone === "error" || n.id === "capacity" ? "text-danger-text" : ""}`}
              >
                {n.text}
              </span>
            ))}
        </>
      );
    }
    case "building":
      return <>No Atlas yet: a Knowledge build is running.</>;
    case "unavailable":
      return <>Knowledge has run, but no Atlas was published for it.</>;
    case "not-enabled":
      return (
        <>
          Knowledge isn't enabled for this repository. Selecting it here doesn't start a build;
          that's done from the repository.
        </>
      );
    case "denied":
      return (
        <>
          {empty
            ? "Not available to you."
            : "Not available: it doesn't exist here, or you can't read it."}
        </>
      );
    case "revoked":
      return <>You lost access while viewing; everything from it was removed.</>;
  }
}

/** What the map's shapes mean, and what they don't. */
function Legend() {
  return (
    <details className="text-micro text-ink-muted">
      <summary className="cursor-pointer text-ink-faint">Reading the map</summary>
      <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0">
        <li>
          <strong className="text-ink">Columns</strong> are repositories, in the order you picked
          them. Each is read at its own commit, and its regions keep their own places: adding a
          repository never moves another's.
        </li>
        <li>
          <strong className="text-ink">Countries</strong> are capabilities. Their area is how many
          files live there, in power-of-two steps: not complexity, importance or quality. Colours
          only tell neighbours apart.
        </li>
        <li>
          <strong className="text-ink">Position</strong> is a stable landmark. Being near another
          region, in the same repository or the next column, doesn't mean they depend on each other.
        </li>
        <li>
          <strong className="text-ink">Borders</strong> are primary membership: each file lives in
          exactly one capability. Opened capabilities show their areas as fainter lines inside.
        </li>
        <li>
          <strong className="text-ink">Islands</strong> with a dashed coast are structural groups
          (unclassified files, concepts, dependencies, folders), not capabilities.
        </li>
        <li>
          <span className="mr-1 inline-block h-0.5 w-3 rounded-full bg-data-teal align-middle" />
          <span className="mr-1 inline-block h-0.5 w-3 rounded-full bg-data-violet align-middle" />
          <strong className="text-ink">Routes</strong>, with a capability selected: teal to what it
          uses, violet from what uses it, thicker for more imports. Static imports only, one hop.
        </li>
        <li>
          <span
            aria-hidden
            className="mr-1 inline-block size-2.5 rounded-sm border-2 border-dashed align-middle"
            style={{ borderColor: "var(--data-teal)" }}
          />
          <strong className="text-ink">A dashed outline</strong>, with a timeline selected: the
          capabilities it touches in each repository; the outline says “touched by timeline …”.
        </li>
        <li>
          <strong className="text-ink">Lines between columns</strong> join the capabilities of one
          capability spanning repositories: one imports a package the other repository publishes,
          and they share concepts. Its files stay in their own regions and are counted once. The
          outline lists these first.
        </li>
        <li>
          <strong className="text-ink">The outline</strong> holds everything the map draws, and
          more: use the arrow keys to move, Right to open, Left to close, Enter to select.
        </li>
        <li>
          <span className="mr-1 inline-block size-2 rounded-full bg-data-berry align-middle" />
          Changed in the build its repository's column shows.
        </li>
      </ul>
    </details>
  );
}
