// The Semantic Code Atlas across an account's repositories (CORE-172), at
// /:owner/-/atlas?repos=a,b. Unlinked until the Knowledge cutover (CORE-174).
//
// You pick the account, then the repositories, explicitly; the URL holds the
// selection, so a copied link reproduces it. Every selected repository is
// listed with its own indexed commit and build and its state (ready,
// building, unavailable, not enabled, partial, lagging): there is no common
// HEAD. Selecting a repository without Knowledge says so and starts nothing.
// The map is each repository's own territory in its own column (see
// workspace.ts for why columns). Changing the scope remounts the view, so
// nothing read for the previous scope stays on screen or arrives late.

import { ArrowClockwiseIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
  Link,
  useLoaderData,
  useLocation,
  useNavigate,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import type { AccountPage, RepoSummary } from "../../../shared/api.ts";
import {
  ATLAS_WORKSPACE_MAX_REPOS,
  type AtlasCompositionCoverage,
  type AtlasEntitySummary,
  type AtlasRegion,
} from "../../../shared/atlas.ts";
import type { Snapshot as TrackerSnapshot } from "../../../shared/tracker.ts";
import { Page } from "../../components/AppShell.tsx";
import { SelectField, VisibilityChip, link } from "../../components/ui.tsx";
import { api, ApiError, load } from "../../lib/api.ts";
import { atlasWorkspaceApi } from "../../lib/atlas.ts";
import { timeAgo } from "../../lib/format.ts";
import { useViewer } from "../../lib/session.ts";
import { AtlasTerritory, type MapBand } from "../repo/AtlasTerritory.tsx";
import type { Load, TerritoryCell } from "../repo/territory.ts";
import {
  BAND_HEADER,
  buildWorkspaceTerritory,
  coverageOf,
  initialWorkspaceState,
  parseSelection,
  repoOf,
  scopeKey,
  toggleSelection,
  WorkspaceSession,
  type CompositionView,
  type Coverage,
  type WorkspaceState,
} from "./workspace.ts";

export async function workspaceAtlasLoader({ request, params }: LoaderFunctionArgs) {
  return load<AccountPage>(`/accounts/${encodeURIComponent(params.owner ?? "")}`, request);
}

/** The account's repositories only change with the account: the selection is the view's. */
export function workspaceAtlasShouldRevalidate({
  currentParams,
  nextParams,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return currentParams.owner !== nextParams.owner || formMethod ? defaultShouldRevalidate : false;
}

/** Regions and entities that hold others, and so can be opened. */
const OPENS = new Set(["capability", "area", "group", "component", "directory", "repository"]);

const files = (n: number | undefined) =>
  n === undefined ? "" : `${n.toLocaleString()} file${n === 1 ? "" : "s"}`;
const short = (sha: string) => sha.slice(0, 7);

export function WorkspaceAtlas() {
  const account = useLoaderData<typeof workspaceAtlasLoader>();
  const location = useLocation();
  const navigate = useNavigate();
  const selection = useMemo(
    () => parseSelection(new URLSearchParams(location.search).get("repos"), account.slug),
    [location.search, account.slug],
  );
  const select = (next: string[]) => {
    const params = new URLSearchParams(location.search);
    params.delete("repos");
    const rest = params.toString();
    // Commas stay readable in the URL: names never contain them.
    const repos = next.length ? `repos=${next.map(encodeURIComponent).join(",")}` : "";
    void navigate({ search: [repos, rest].filter(Boolean).join("&") });
  };

  return (
    <Page full>
      <header className="flex flex-col gap-1">
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

function WorkspaceView({
  owner,
  selection,
  accountRepos,
}: {
  owner: string;
  selection: string[];
  accountRepos: RepoSummary[];
}) {
  const [state, setState] = useState<WorkspaceState>(initialWorkspaceState);
  const [session, setSession] = useState<WorkspaceSession | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const selectionKey = selection.join(",");
  useEffect(() => {
    const opened = new WorkspaceSession(
      { owner, repos: selectionKey.split(",") },
      atlasWorkspaceApi,
      setState,
    );
    setSession(opened);
    void opened.open();
    return () => opened.dispose();
  }, [owner, selectionKey]);

  const overview = state.overview;
  const coverage = useMemo(
    () => coverageOf(selection, overview?.snapshot.repos ?? [], state.revoked),
    [selection, overview, state.revoked],
  );
  const expanded = useMemo(() => {
    const ready = new Map<string, AtlasEntitySummary[]>();
    for (const [id, l] of state.loads) if (l.state === "ready") ready.set(id, l.items);
    return ready;
  }, [state.loads]);
  const territory = useMemo(
    () => buildWorkspaceTerritory(coverage, overview?.regions ?? [], expanded),
    [coverage, overview, expanded],
  );
  const loading = useMemo(
    () => new Set([...state.loads].filter(([, l]) => l.state === "loading").map(([id]) => id)),
    [state.loads],
  );
  const nameOf = useMemo(() => {
    const names = new Map<string, string>();
    for (const r of overview?.snapshot.repos ?? []) names.set(r.id, r.name);
    return names;
  }, [overview]);
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

  if (state.status === "loading")
    return (
      <p className="mt-4 text-body-sm text-ink-faint" aria-live="polite">
        Reading {selection.length} repositor{selection.length === 1 ? "y" : "ies"}…
      </p>
    );
  if (state.status === "error")
    return (
      <div className="mt-4 flex items-center gap-2 text-body-sm text-danger-text" role="alert">
        {state.error}
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm"
          onClick={() => void session?.open()}
        >
          <ArrowClockwiseIcon weight="bold" aria-hidden /> Retry
        </button>
      </div>
    );

  const choose = (entity: AtlasEntitySummary) => {
    setSelected(entity.id);
    if (OPENS.has(entity.kind) && !state.loads.has(entity.id)) session?.expand(entity.id);
  };
  const selectedEntity = selected ? territory.byId.get(selected)?.entity : undefined;
  const regions = overview?.regions ?? [];
  const capabilities = regions.filter((r) => !r.structural).length;
  const ready = coverage.filter((c) => c.state === "ready").length;

  return (
    <div className="mt-4 flex flex-col gap-4">
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
          <button
            type="button"
            className="mk-btn mk-btn--sm"
            onClick={() => {
              setSelected(null);
              void session?.open();
            }}
          >
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
        <div className="grid gap-3 lg:h-[max(34rem,calc(100dvh-16rem))] lg:grid-cols-[minmax(0,1fr)_23rem]">
          <div className="h-[62dvh] min-h-[22rem] lg:h-auto lg:min-h-0">
            <AtlasTerritory
              territory={territory}
              bands={bands}
              selected={selected}
              loading={loading}
              onSelect={(cell: TerritoryCell) => choose(cell.entity)}
              origin={(cell) => {
                const name = nameOf.get(repoOf(cell.id));
                return name ? `in ${name}` : null;
              }}
              label={`Capability map of ${territory.bands.length} repositor${
                territory.bands.length === 1 ? "y" : "ies"
              }, one column each in selection order: ${capabilities} capabilities${
                regions.length > capabilities ? " and structural groups" : ""
              }. The list beside it has the same regions.`}
            />
          </div>
          <aside
            aria-label="Regions"
            className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-pane bg-pane p-3"
          >
            {selectedEntity && (
              <Selection
                entity={selectedEntity}
                repo={nameOf.get(repoOf(selectedEntity.id)) ?? ""}
                load={state.loads.get(selectedEntity.id)}
                onPick={choose}
                onRetry={() => session?.expand(selectedEntity.id)}
                onMore={(cursor, items) => session?.expand(selectedEntity.id, cursor, items)}
              />
            )}
            <RegionList coverage={coverage} regions={regions} selected={selected} onPick={choose} />
            {overview && overview.totalRegions > regions.length && (
              <p className="m-0 text-micro text-ink-faint">
                The map shows the {regions.length} largest regions across the selection;{" "}
                {(overview.totalRegions - regions.length).toLocaleString()} smaller ones are in the
                catalogue.
              </p>
            )}
            <Legend />
          </aside>
        </div>
      )}
    </div>
  );
}

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
          const shown = repo ? regions.filter((r) => r.repoId === repo.id).length : 0;
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
                <CoverageDetail entry={entry} pushedAt={pushedAt} shown={shown} empty={empty} />
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
  shown,
  empty,
}: {
  entry: Coverage;
  pushedAt: string | null;
  shown: number;
  empty: boolean;
}) {
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
          {snapshot?.partial && (
            <span className="block">
              Partial: some files aren't analyzed yet, so counts are a floor.
            </span>
          )}
          {entry.repo.building && (
            <span className="block">Lagging: a newer Knowledge build is running.</span>
          )}
          {!entry.repo.building && lagging && (
            <span className="block">
              Lagging: pushed {timeAgo(pushedAt)}, after this Atlas was built.
            </span>
          )}
          {entry.repo.capacityFailure && (
            <span className="block text-danger-text">
              The newest build didn't fit the Atlas storage limit; this is the previous one.
            </span>
          )}
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

function summaryLine(entity: AtlasEntitySummary): string {
  if (entity.summary) return entity.summary;
  switch (entity.summaryState?.status) {
    case "stale":
      return "Summary out of date: it describes an earlier build.";
    case "unavailable":
      return "Summary unavailable for this build.";
    default:
      return "";
  }
}

/** The map's regions, grouped by repository in selection order: the accessible path. */
function RegionList({
  coverage,
  regions,
  selected,
  onPick,
}: {
  coverage: Coverage[];
  regions: readonly AtlasRegion[];
  selected: string | null;
  onPick: (entity: AtlasEntitySummary) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {coverage.map((entry) => {
        const repo = entry.repo;
        const own =
          repo && entry.state === "ready" ? regions.filter((r) => r.repoId === repo.id) : [];
        const seq = repo?.snapshot?.seq ?? 0;
        return (
          <section key={entry.name} aria-label={`Regions in ${entry.name}`}>
            <h3 className="m-0 mb-1 px-2.5 text-micro font-semibold tracking-wide text-ink-faint uppercase">
              <bdi>{entry.name}</bdi>
            </h3>
            {own.length === 0 ? (
              <p className="m-0 px-2.5 text-micro text-ink-faint">
                {entry.state === "ready"
                  ? "None of its regions are among the largest in this selection."
                  : bandNote(entry)}
              </p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {own.map((region) => (
                  <li key={region.id}>
                    <button
                      type="button"
                      aria-current={region.id === selected || undefined}
                      onClick={() => onPick(region)}
                      className="flex w-full cursor-pointer flex-col gap-0.5 rounded-plate border-0 bg-transparent px-2.5 py-2 text-left hover:bg-raised aria-[current]:bg-signal-wash"
                    >
                      <span className="flex w-full items-baseline gap-2">
                        <span
                          className={`min-w-0 flex-1 truncate text-body-sm font-semibold ${region.structural ? "text-ink-muted" : "text-ink"}`}
                        >
                          {region.name}
                        </span>
                        {seq > 1 && region.since === seq && (
                          <span className="text-micro text-ink-faint" title="Changed in this build">
                            changed
                          </span>
                        )}
                        <span className="text-micro text-ink-faint tabular-nums">
                          {region.structural
                            ? `${region.size.members.toLocaleString()} item${region.size.members === 1 ? "" : "s"}`
                            : files(region.size.files)}
                        </span>
                      </span>
                      {summaryLine(region) && (
                        <span className="line-clamp-2 text-micro text-ink-muted">
                          {summaryLine(region)}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function Selection({
  entity,
  repo,
  load: state,
  onPick,
  onRetry,
  onMore,
}: {
  entity: AtlasEntitySummary;
  repo: string;
  load: Load | undefined;
  onPick: (entity: AtlasEntitySummary) => void;
  onRetry: () => void;
  onMore: (cursor: string, items: AtlasEntitySummary[]) => void;
}) {
  return (
    <section
      aria-label={entity.name}
      className="flex flex-col gap-2 border-b border-line-soft pb-3"
    >
      <h2 className="m-0 text-body font-semibold">{entity.name}</h2>
      <p className="m-0 text-micro text-ink-faint">
        In <bdi className="text-ink-muted">{repo}</bdi> ·{" "}
        {entity.structural
          ? "Structural group: not a capability."
          : entity.kind === "capability" || entity.kind === "area"
            ? "Grouped from imports and shared concepts in the code, never folders alone."
            : entity.kind}
      </p>
      {summaryLine(entity) && (
        <p className="m-0 text-body-sm text-ink-muted">{summaryLine(entity)}</p>
      )}
      {state?.state === "loading" && (
        <p className="m-0 text-body-sm text-ink-faint" aria-live="polite">
          Loading what's inside…
        </p>
      )}
      {state?.state === "error" && (
        <div className="flex items-center gap-2 text-body-sm text-danger-text" role="alert">
          Couldn't load what's inside.
          <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={onRetry}>
            <ArrowClockwiseIcon weight="bold" aria-hidden /> Retry
          </button>
        </div>
      )}
      {state?.state === "ready" && (
        <>
          <ul className="m-0 flex list-none flex-col p-0" aria-label={`Inside ${entity.name}`}>
            {state.items.map((child) => (
              <li key={child.id}>
                <button
                  type="button"
                  onClick={() => onPick(child)}
                  className="flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-plate border-0 bg-transparent px-2 text-left text-body-sm hover:bg-raised"
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
            {state.total !== null
              ? `${state.items.length.toLocaleString()} of ${state.total.toLocaleString()}`
              : `${state.items.length.toLocaleString()} loaded`}
          </p>
          {state.next && (
            <button
              type="button"
              className="mk-btn mk-btn--sm self-start"
              onClick={() => onMore(state.next!, state.items)}
            >
              Show more
            </button>
          )}
        </>
      )}
    </section>
  );
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
          <strong className="text-ink">Area</strong> is how many files live there, in power-of-two
          steps: not complexity, importance or quality.
        </li>
        <li>
          <strong className="text-ink">Position</strong> is a stable landmark. Being near another
          region, in the same repository or the next column, doesn't mean they depend on each other.
        </li>
        <li>
          <strong className="text-ink">Boundaries</strong> are primary membership: each file lives
          in exactly one capability.
        </li>
        <li>
          <strong className="text-ink">Dashed regions</strong> are structural groups (unclassified
          files, concepts, dependencies, folders), not capabilities.
        </li>
        <li>
          <span className="mr-1 inline-block size-2 rounded-full bg-data-berry align-middle" />
          Changed in the build its repository's column shows.
        </li>
      </ul>
    </details>
  );
}
