// The app-wide timeline switcher and banner (CORE-82). The rail's Timelines
// place opens the graph (CORE-402); while a timeline is selected
// (`?tl=<slug>`, see lib/timelineScope.ts) the banner above the page names it,
// says what the scope means where you are and offers the switcher, and the
// rail's place carries a dot, so the scope is never out of sight
// (mode errors).

import { Popover } from "@base-ui/react/popover";
import { CaretDownIcon, CheckIcon, GitForkIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useRouteLoaderData } from "react-router";
import type { RepoDetail } from "../../shared/api.ts";
import { lastPush, type Timeline, type TimelineList } from "../../shared/timelines.ts";
import type { TrackerList } from "../../shared/tracker.ts";
import { api } from "../lib/api.ts";
import { timeAgo } from "../lib/format.ts";
import { onAccessChange, useViewer } from "../lib/session.ts";
import {
  bookmarkIn,
  scopeBookmark,
  scopeHint,
  scopeOf,
  scopeSpace,
  switchScope,
} from "../lib/timelineScope.ts";
import { STATUS_LABEL } from "../routes/tracker/timelineGraph.ts";
import { popMotion } from "./ui.tsx";

// ---- data ------------------------------------------------------------------

// Lists are reused for a short while, so moving between pages with a timeline
// selected doesn't read them again; opening the switcher always does
// (timelines start and end while you work). Entries are per viewer, and every
// one is dropped when who is signed in or what they hold changes.

const FRESH_MS = 15_000;

interface Entry<T> {
  at: number;
  promise: Promise<T>;
}
/** By viewer and Space. */
const lists = new Map<string, Entry<Timeline[]>>();
/** By viewer: the Space /tracker would open. */
const defaults = new Map<string, Entry<string | null>>();
let generation = 0;
const listeners = new Set<() => void>();

/**
 * Drop a Space's cached timelines after a change; without a Space, every
 * Space's and the default selection.
 */
export function refreshTimelines(space?: string): void {
  if (space === undefined) {
    lists.clear();
    defaults.clear();
  } else {
    for (const key of lists.keys()) if (key.endsWith(`\n${space}`)) lists.delete(key);
  }
  generation++;
  for (const listener of listeners) listener();
}

onAccessChange(() => refreshTimelines());

function useGeneration(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => generation,
  );
}

function fresh<T>(entries: Map<string, Entry<T>>, key: string, read: () => Promise<T>) {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < FRESH_MS) return hit.promise;
  const entry = { at: Date.now(), promise: read() };
  entries.set(key, entry);
  entry.promise.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return entry.promise;
}

function timelinesOf(viewerId: string, space: string): Promise<Timeline[]> {
  return fresh(lists, `${viewerId}\n${space}`, () =>
    api<TimelineList>(`/tracker/${encodeURIComponent(space)}/timelines`).then(
      (reply) => reply.timelines,
    ),
  );
}

/** Resolve the persisted default against current grants (reused briefly). */
function defaultSpace(viewerId: string): Promise<string | null> {
  return fresh(defaults, viewerId, () =>
    api<TrackerList>("/tracker").then(
      ({ trackers, defaultSpaceId }) => trackers.find((t) => t.id === defaultSpaceId)?.slug ?? null,
    ),
  ).catch(() => null);
}

interface Scope {
  /** The selected timeline's slug; null is main. */
  slug: string | null;
  /** The Space whose timelines the switcher lists. */
  space: string | null;
  /** That Space's timelines, once loaded. */
  timelines: Timeline[] | null;
  error: string | null;
  /** The selected timeline's record, when the Space has it. */
  timeline: Timeline | null;
  /** The repository page's detail, for following code refs across a switch. */
  repo: RepoDetail | undefined;
}

/** The scope, and the timelines behind it once something needs them (a timeline is selected, or the switcher is open). */
function useScope(open = false): Scope {
  const location = useLocation();
  const viewer = useViewer();
  const repo = useRouteLoaderData("repo") as RepoDetail | undefined;
  const slug = scopeOf(location.search);
  const needed = Boolean(viewer) && (open || slug !== null);
  const fromPath = scopeSpace(location.pathname, location.search);
  const [fallback, setFallback] = useState<{ viewerId: string; space: string | null } | null>(null);
  // A saved default (Preferences) or an access change drops the cached
  // default (refreshTimelines bumps the generation), so it is read again.
  const gen = useGeneration();
  useEffect(() => {
    if (fromPath || !needed || !viewer) return;
    let live = true;
    // /tracker decides the default, but it is usually the session's default
    // Space: read that Space's timelines meanwhile rather than after.
    const likely = viewer.spaces.find((entry) => entry.id === viewer.defaultSpaceId)?.slug;
    if (likely) timelinesOf(viewer.id, likely).catch(() => {});
    void defaultSpace(viewer.id).then(
      (space) => live && setFallback({ viewerId: viewer.id, space }),
    );
    return () => {
      live = false;
    };
  }, [fromPath, needed, viewer, gen, location.key]);
  const space = fromPath ?? (viewer && fallback?.viewerId === viewer.id ? fallback.space : null);
  const requestKey = `${viewer?.id ?? ""}:${space ?? ""}`;
  const [loaded, setLoaded] = useState<{
    space: string;
    requestKey: string;
    timelines: Timeline[] | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    // Signed out, nobody can list timelines; the banner names the slug alone.
    if (!space || !needed || !viewer) return;
    let live = true;
    // Each navigation asks again; within FRESH_MS that is the same read.
    timelinesOf(viewer.id, space).then(
      (timelines) => live && setLoaded({ space, requestKey, timelines, error: null }),
      (error: unknown) =>
        live &&
        setLoaded({
          space,
          requestKey,
          timelines: null,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      live = false;
    };
  }, [space, needed, viewer, gen, requestKey, location.key]);
  const current = needed && loaded?.requestKey === requestKey ? loaded : null;
  const timelines = current?.timelines ?? null;
  return {
    slug,
    space,
    timelines,
    error: current?.error ?? null,
    timeline: (slug && timelines?.find((t) => t.slug === slug)) || null,
    repo,
  };
}

const ENDED = new Set(["landed", "abandoned"]);

// ---- switcher ----------------------------------------------------------------

function SwitcherPanel({
  scope,
  close,
  filter,
}: {
  scope: Scope;
  close: () => void;
  filter: boolean;
}) {
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [showEnded, setShowEnded] = useState(false);
  const repoRefs = scope.repo
    ? {
        defaultBranch: scope.repo.defaultBranch,
        branches: scope.repo.branches.map((b) => b.shortName),
        source: scope.repo.source,
      }
    : null;
  const { words, open, ended } = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = (scope.timelines ?? [])
      .filter((t) => words.every((w) => `${t.name} ${t.slug}`.toLowerCase().includes(w)))
      .sort((a, b) => lastPush(b).localeCompare(lastPush(a)));
    return {
      words,
      open: matching.filter((t) => !ENDED.has(t.status)),
      ended: matching.filter((t) => ENDED.has(t.status)),
    };
  }, [scope.timelines, search]);
  const shown = showEnded || words.length ? [...open, ...ended] : open;
  const row = (slug: string | null, label: React.ReactNode, meta?: React.ReactNode) => {
    const current = scope.slug === slug;
    return (
      <li key={slug ?? "main"}>
        <Link
          to={switchScope(
            location,
            slug,
            repoRefs
              ? {
                  ...repoRefs,
                  targetSource: scope.timelines
                    ?.find((timeline) => timeline.slug === slug)
                    ?.repos.find((repo) => repo.id === scope.repo?.id)?.source,
                }
              : null,
          )}
          onClick={close}
          aria-current={current ? "true" : undefined}
          className="mk-menu-item min-w-0 text-ink no-underline max-sm:min-h-11"
        >
          <CheckIcon
            weight="bold"
            className={`size-4 shrink-0 text-signal-line ${current ? "" : "invisible"}`}
            aria-hidden
          />
          <span className="flex min-w-0 flex-1 items-center gap-2">{label}</span>
          {meta}
        </Link>
      </li>
    );
  };
  return (
    <>
      <div className="px-3 pt-2.5 pb-2">
        <div className="flex items-center gap-2">
          <Popover.Title className="m-0 text-title">Timeline</Popover.Title>
          <Link
            to={
              scope.space ? `/tracker/${encodeURIComponent(scope.space)}/timelines` : "/timelines"
            }
            onClick={close}
            className="mk-btn mk-btn--ghost mk-btn--sm ml-auto no-underline"
          >
            Timeline graph
          </Link>
        </div>
        <Popover.Description className="mt-0.5 mb-0 text-body-sm text-ink-muted">
          {filter
            ? "Filter release notes to landed work from one timeline; main shows all notes"
            : "Scope every page to main plus one line of work"}
          {scope.space ? (
            <>
              {" "}
              in <bdi>{scope.space}</bdi>
            </>
          ) : null}
          .
        </Popover.Description>
      </div>
      {(scope.timelines?.length ?? 0) > 6 && (
        <label className="relative mx-1.5 mb-1 flex items-center">
          <MagnifyingGlassIcon
            className="pointer-events-none absolute left-3 size-4 text-ink-faint"
            aria-hidden
          />
          <input
            className="mk-input h-9 min-w-0 flex-1 pl-9 sm:text-body-sm"
            aria-label="Find a timeline"
            placeholder="Find a timeline"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      )}
      <ul className="m-0 list-none p-0" aria-label="Timelines">
        {!words.length &&
          row(
            null,
            <span className="mk-mono text-body-sm">main</span>,
            <Meta>{filter ? "all notes" : "default"}</Meta>,
          )}
        {shown.map((t) =>
          row(
            t.slug,
            <>
              <span className="min-w-0 truncate" title={`${t.name} (${scopeBookmark(t.slug)})`}>
                {t.name}
              </span>
              {t.experimental && (
                <span className="mk-chip mk-chip--tag shrink-0">Experimental</span>
              )}
            </>,
            <Meta>{t.status === "active" ? timeAgo(lastPush(t)) : STATUS_LABEL[t.status]}</Meta>,
          ),
        )}
      </ul>
      {scope.error ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">
          Couldn't list {scope.space}'s timelines: {scope.error}
        </p>
      ) : !scope.space ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">
          Open a repository or a tracker to choose one of its account's timelines.
        </p>
      ) : !scope.timelines ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">Loading timelines…</p>
      ) : scope.timelines.length === 0 ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">
          {scope.space} has no timelines yet. <span className="mk-mono">gm timeline start</span>{" "}
          forks one.
        </p>
      ) : words.length && !shown.length ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">No timeline matches.</p>
      ) : null}
      {scope.space && ended.length > 0 && !showEnded && !words.length && (
        <div className="sticky bottom-0 mt-1 flex items-center gap-2 border-t border-line-soft bg-rail px-1.5 pt-1.5">
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--sm"
            onClick={() => setShowEnded(true)}
          >
            Show {ended.length} ended
          </button>
        </div>
      )}
    </>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 text-micro text-ink-faint tabular-nums">{children}</span>;
}

/** The shared picker in the scope banner, or an inline filter. (The rail opens the graph.) */
export function TimelineSwitcher({ variant }: { variant: "banner" | "filter" }) {
  const [open, setOpen] = useState(false);
  const scope = useScope(open);
  const name = scope.timeline?.name ?? scope.slug;
  const onOpenChange = (next: boolean) => {
    // Fresh each time it opens: timelines start and end while you work.
    if (next && scope.space) refreshTimelines(scope.space);
    setOpen(next);
  };
  const trigger =
    variant === "filter" ? (
      <Popover.Trigger
        className="mk-btn mk-btn--secondary min-w-0 max-w-full max-sm:min-h-11"
        aria-label={`Filter release notes by timeline: ${name ?? "main (all notes)"}`}
      >
        <GitForkIcon className="size-4 shrink-0" aria-hidden />
        <span className="truncate">Timeline: {name ?? "main (all notes)"}</span>
        <CaretDownIcon className="size-4 shrink-0" aria-hidden />
      </Popover.Trigger>
    ) : (
      <Popover.Trigger className="mk-btn mk-btn--ghost mk-btn--sm shrink-0">Switch</Popover.Trigger>
    );
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {trigger}
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Popover.Popup className={`mk-popup ${popMotion} w-[min(22rem,calc(100vw-2rem))]`}>
            <SwitcherPanel
              scope={scope}
              close={() => setOpen(false)}
              filter={variant === "filter"}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ---- banner ------------------------------------------------------------------

/** Above every page while a timeline is selected: which one, and what that means here. */
export function TimelineBanner() {
  const scope = useScope();
  const location = useLocation();
  const viewer = useViewer();
  if (!scope.slug) return null;
  const { slug, timeline, repo } = scope;
  const missing = Boolean(scope.timelines && !timeline);
  const ended = timeline?.status === "landed" || timeline?.status === "abandoned";
  const repoRefs = repo
    ? {
        defaultBranch: repo.defaultBranch,
        branches: repo.branches.map((b) => b.shortName),
        source: repo.source,
      }
    : null;
  const hint = missing
    ? `${scope.space} has no timeline ${slug}.`
    : scopeHint(
        location.pathname,
        slug,
        repo ? bookmarkIn(repo, slug) !== null : undefined,
        timeline?.status,
      );
  return (
    <div className="z-20 border-b border-line-soft bg-surface sm:sticky sm:top-0">
      <div
        role="region"
        aria-label="Timeline scope"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-signal-wash px-4 py-2 sm:h-[var(--scope-banner)] sm:flex-nowrap sm:px-6 sm:py-0"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3 max-sm:basis-full">
          <GitForkIcon weight="bold" className="size-4 shrink-0 text-signal-line" aria-hidden />
          <p className="m-0 min-w-0 flex-1 text-body-sm sm:truncate">
            <span className="text-ink-muted">Timeline </span>
            <strong className="font-semibold text-ink">{timeline?.name ?? slug}</strong>
            <span className="mk-mono ml-2 text-ink-faint max-md:hidden">
              {repo?.source?.kind === "timeline-work" ? "work" : scopeBookmark(slug)}
            </span>
            {timeline && timeline.status !== "active" && (
              <span className="text-ink-muted"> · {STATUS_LABEL[timeline.status]}</span>
            )}
            {timeline?.experimental && (
              <span className="mk-chip mk-chip--tag ml-2 align-middle">Experimental</span>
            )}
            {/* Read-only and missing timelines say so at every width. */}
            <span className={`text-ink-muted ${missing || ended ? "" : "max-lg:hidden"}`}>
              {" "}
              · {hint}
            </span>
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1 max-sm:-mr-2 max-sm:ml-auto">
          {viewer && <TimelineSwitcher variant="banner" />}
          <Link
            to={switchScope(location, null, repoRefs)}
            className="mk-btn mk-btn--ghost mk-btn--sm no-underline"
          >
            Back to main
          </Link>
        </div>
      </div>
    </div>
  );
}
