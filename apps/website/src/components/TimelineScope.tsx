// The app-wide timeline switcher and banner (CORE-82). The switcher sits in
// the rail on every page; while a timeline is selected (`?tl=<slug>`, see
// lib/timelineScope.ts) the banner above the page names it and says what the
// scope means where you are, and the rail's switcher carries a dot, so the
// scope is never out of sight (TIMELINES-RESEARCH.md, "Where it wouldn't
// work": mode errors).

import { Popover } from "@base-ui/react/popover";
import { CheckIcon, GitForkIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, useLocation, useRouteLoaderData } from "react-router";
import type { RepoDetail } from "../../shared/api.ts";
import type { Timeline, TimelineList } from "../../shared/timelines.ts";
import type { TrackerList } from "../../shared/tracker.ts";
import { api } from "../lib/api.ts";
import { timeAgo } from "../lib/format.ts";
import { useViewer } from "../lib/session.ts";
import {
  bookmarkIn,
  scopeBookmark,
  scopeHint,
  scopeOf,
  scopeOwner,
  switchScope,
} from "../lib/timelineScope.ts";
import { STATUS_LABEL } from "../routes/tracker/timelineGraph.ts";
import { Tip, popMotion } from "./ui.tsx";

// ---- data ------------------------------------------------------------------

const lists = new Map<string, Promise<Timeline[]>>();
let generation = 0;
const listeners = new Set<() => void>();

/** Drop an account's cached timelines (after a change), so the switcher and banner refetch. */
export function refreshTimelines(owner: string): void {
  lists.delete(owner);
  generation++;
  for (const listener of listeners) listener();
}

function useGeneration(): number {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => generation,
  );
}

function timelinesOf(owner: string): Promise<Timeline[]> {
  let list = lists.get(owner);
  if (!list) {
    list = api<TimelineList>(`/tracker/${encodeURIComponent(owner)}/timelines`).then(
      (reply) => reply.timelines,
    );
    lists.set(owner, list);
    list.catch(() => lists.delete(owner));
  }
  return list;
}

let defaultTracker: Promise<string | null> | null = null;

/** Where /tracker would open: pages outside any account scope to its timelines. */
function defaultOwner(): Promise<string | null> {
  defaultTracker ??= api<TrackerList>("/tracker")
    .then(
      ({ trackers, defaultOwnerId }) =>
        (trackers.find((t) => t.id === defaultOwnerId) ?? trackers[0])?.slug ?? null,
    )
    .catch(() => {
      defaultTracker = null;
      return null;
    });
  return defaultTracker;
}

interface Scope {
  /** The selected timeline's slug; null is main. */
  slug: string | null;
  /** The account whose timelines the switcher lists. */
  owner: string | null;
  /** That account's timelines, once loaded. */
  timelines: Timeline[] | null;
  error: string | null;
  /** The selected timeline's record, when the account has it. */
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
  const fromPath = scopeOwner(location.pathname, location.search);
  const [fallback, setFallback] = useState<string | null>(null);
  useEffect(() => {
    if (fromPath || !needed) return;
    let live = true;
    void defaultOwner().then((owner) => live && setFallback(owner));
    return () => {
      live = false;
    };
  }, [fromPath, needed]);
  const owner = fromPath ?? (viewer ? fallback : null);
  const gen = useGeneration();
  const [loaded, setLoaded] = useState<{
    owner: string;
    timelines: Timeline[] | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    // Signed out, nobody can list timelines; the banner names the slug alone.
    if (!owner || !needed) return;
    let live = true;
    timelinesOf(owner).then(
      (timelines) => live && setLoaded({ owner, timelines, error: null }),
      (error: unknown) =>
        live &&
        setLoaded({
          owner,
          timelines: null,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return () => {
      live = false;
    };
  }, [owner, needed, gen]);
  const current = loaded?.owner === owner ? loaded : null;
  const timelines = current?.timelines ?? null;
  return {
    slug,
    owner,
    timelines,
    error: current?.error ?? null,
    timeline: (slug && timelines?.find((t) => t.slug === slug)) || null,
    repo,
  };
}

const ENDED = new Set(["landed", "abandoned"]);

function lastActive(t: Timeline): string {
  return t.pushedAt && t.pushedAt > t.createdAt ? t.pushedAt : t.createdAt;
}

// ---- switcher ----------------------------------------------------------------

function SwitcherPanel({ scope, close }: { scope: Scope; close: () => void }) {
  const location = useLocation();
  const [search, setSearch] = useState("");
  const [showEnded, setShowEnded] = useState(false);
  const repoRefs = scope.repo
    ? {
        defaultBranch: scope.repo.defaultBranch,
        branches: scope.repo.branches.map((b) => b.shortName),
      }
    : null;
  const { words, open, ended } = useMemo(() => {
    const words = search.toLowerCase().split(/\s+/).filter(Boolean);
    const matching = (scope.timelines ?? [])
      .filter((t) => words.every((w) => `${t.name} ${t.slug}`.toLowerCase().includes(w)))
      .sort((a, b) => lastActive(b).localeCompare(lastActive(a)));
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
          to={switchScope(location, slug, repoRefs)}
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
        <Popover.Title className="m-0 text-title">Timeline</Popover.Title>
        <Popover.Description className="mt-0.5 mb-0 text-body-sm text-ink-muted">
          Scope every page to main plus one line of work
          {scope.owner ? (
            <>
              {" "}
              in <bdi>{scope.owner}</bdi>
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
          row(null, <span className="mk-mono text-body-sm">main</span>, <Meta>default</Meta>)}
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
            <Meta>{t.status === "active" ? timeAgo(lastActive(t)) : STATUS_LABEL[t.status]}</Meta>,
          ),
        )}
      </ul>
      {scope.error ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">
          Couldn't list {scope.owner}'s timelines: {scope.error}
        </p>
      ) : !scope.owner ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">
          Open a repository or a tracker to choose one of its account's timelines.
        </p>
      ) : !scope.timelines ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">Loading timelines…</p>
      ) : scope.timelines.length === 0 ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">
          {scope.owner} has no timelines yet. <span className="mk-mono">gm timeline start</span>{" "}
          forks one.
        </p>
      ) : words.length && !shown.length ? (
        <p className="m-0 px-3 py-2 text-body-sm text-ink-faint">No timeline matches.</p>
      ) : null}
      {scope.owner ? (
        <div className="mt-1 flex items-center gap-2 border-t border-line-soft px-1.5 pt-1.5">
          {ended.length > 0 && !showEnded && !words.length && (
            <button
              type="button"
              className="mk-btn mk-btn--ghost mk-btn--sm"
              onClick={() => setShowEnded(true)}
            >
              Show {ended.length} ended
            </button>
          )}
          <Link
            to={`/tracker/${encodeURIComponent(scope.owner)}/timelines`}
            onClick={close}
            className="mk-btn mk-btn--ghost mk-btn--sm ml-auto no-underline"
          >
            Timeline graph
          </Link>
        </div>
      ) : null}
    </>
  );
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="shrink-0 text-micro text-ink-faint tabular-nums">{children}</span>;
}

/** The switcher: a place in the rail, or the banner's Switch button. */
export function TimelineSwitcher({ variant }: { variant: "rail" | "banner" }) {
  const [open, setOpen] = useState(false);
  const scope = useScope(open);
  const name = scope.timeline?.name ?? scope.slug;
  const label = `Timeline: ${name ?? "main"}`;
  const onOpenChange = (next: boolean) => {
    // Fresh each time it opens: timelines start and end while you work.
    if (next && scope.owner) refreshTimelines(scope.owner);
    setOpen(next);
  };
  const trigger =
    variant === "rail" ? (
      <Popover.Trigger
        className="mk-place relative max-sm:before:hidden"
        aria-label={`${label}. Switch timeline`}
      >
        <GitForkIcon size={22} weight={scope.slug ? "fill" : "regular"} aria-hidden />
        {scope.slug && (
          <span
            className="absolute top-2 right-2 size-2.5 rounded-full bg-signal ring-2 ring-rail"
            aria-hidden
          />
        )}
      </Popover.Trigger>
    ) : (
      <Popover.Trigger className="mk-btn mk-btn--ghost mk-btn--sm shrink-0">Switch</Popover.Trigger>
    );
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {variant === "rail" ? (
        <Tip label={label} side="right">
          {trigger}
        </Tip>
      ) : (
        trigger
      )}
      <Popover.Portal>
        <Popover.Positioner
          side={variant === "rail" ? "right" : "bottom"}
          align={variant === "rail" ? "start" : "end"}
          sideOffset={variant === "rail" ? 12 : 6}
          className="z-50"
        >
          <Popover.Popup className={`mk-popup ${popMotion} w-[min(22rem,calc(100vw-2rem))]`}>
            <SwitcherPanel scope={scope} close={() => setOpen(false)} />
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
    ? { defaultBranch: repo.defaultBranch, branches: repo.branches.map((b) => b.shortName) }
    : null;
  const hint = missing
    ? `${scope.owner} has no timeline ${slug}.`
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
            <span className="mk-mono ml-2 text-ink-faint max-md:hidden">{scopeBookmark(slug)}</span>
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
