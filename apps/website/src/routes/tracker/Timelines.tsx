// The timeline graph (CORE-81): forks, merges between timelines, landings on
// main, abandoned and experimental lanes, around the selected timeline: the
// app-wide scope (`?tl=`, lib/timelineScope.ts). The layout is in
// timelineGraph.ts and the drawing in TimelineLanes.tsx.

import { ArrowClockwiseIcon, CaretRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import {
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  data as routeData,
  Link,
  redirect,
  useLoaderData,
  useNavigate,
  useRevalidator,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import type { TimelineGraphData } from "../../../shared/timeline-graph.ts";
import {
  DEFAULT_IDLE_DAYS,
  isStalled,
  type CheckpointView,
  type Timeline,
  type TimelineEvent,
  type TimelineStatus,
} from "../../../shared/timelines.ts";
import { refreshTimelines } from "../../components/TimelineScope.tsx";
import { SelectField, Tip, link } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { commitsUrl, treeUrl } from "../../lib/refs.ts";
import { commitPanelUrl } from "../../lib/commitPanel.ts";
import { withScope } from "../../lib/timelineScope.ts";
import {
  DEFAULT_FILTERS,
  STATUS_LABEL,
  involves,
  lastActivity,
  layoutGraph,
  lineState,
  type GraphFilters,
  type GroupBy,
  type LineState,
  type Row,
} from "./timelineGraph.ts";
import {
  LaneDrawing,
  ROW_HEIGHT,
  eventRepo,
  graphWidth,
  type RowGeometry,
} from "./TimelineLanes.tsx";
import { RowDetails, summarize } from "./TimelineRows.tsx";
import { DoneInTimelineIcon, statusLabel } from "./ui.tsx";
import { PreviewLink, ReviveButton, useCheckpoints } from "./Checkpoint.tsx";
import { LandingPanel } from "./Landing.tsx";
import { useRememberPlace } from "../../lib/recentPlaces.ts";
import { LiveNow, useStepFeed } from "./LiveNow.tsx";
import { TimelineObservability } from "./TimelineObservability.tsx";
import { PersonLink } from "../../components/PersonLink.tsx";
import { RecentAgents } from "../../components/RecentAgents.tsx";
import { diffStats, landedMerge, useCompares, workHead } from "./Changes.tsx";
import { timelinePageUrl } from "./TimelineNav.tsx";

export async function trackerTimelinesLoader({ request, params }: LoaderFunctionArgs) {
  try {
    return await api<TimelineGraphData>(
      `/tracker/${encodeURIComponent(params.space!)}/timeline-graph`,
      { signal: request.signal },
    );
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 401) {
        const url = new URL(request.url);
        throw redirect(`/signin?next=${encodeURIComponent(url.pathname + url.search)}`);
      }
      throw routeData({ message: error.message }, { status: error.status });
    }
    throw error;
  }
}

const GROUP_BY: { value: GroupBy; label: string }[] = [
  { value: "status", label: "Status" },
  { value: "project", label: "Project" },
  { value: "agent", label: "Agent" },
  { value: "person", label: "Person" },
];

const FILTER_LABEL: Record<LineState | "experimental", string> = {
  open: "Open",
  landed: "Landed",
  abandoned: "Abandoned",
  experimental: "Experimental",
};

/** Status by shape (DESIGN.md): filled while working, a ring while waiting on something. */
const STATUS_DOT: Record<TimelineStatus, string> = {
  active: "bg-ink",
  waiting: "bg-ink-faint",
  idle: "bg-transparent ring-[1.5px] ring-inset ring-ink-faint",
  landing: "bg-transparent ring-2 ring-inset ring-online",
  partly_landed: "bg-transparent ring-2 ring-inset ring-online",
  landed: "bg-online",
  abandoned: "bg-transparent ring-[1.5px] ring-inset ring-line",
};

/** A section heading in the selected timeline's panel. */
const SECTION = "mt-4 mb-1 text-body-sm font-semibold text-ink-muted";

function StatusDot({ status }: { status: TimelineStatus }) {
  return <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden />;
}

/** No timeline selected: a feed with nothing to read. */
const NO_TIMELINE: Pick<Timeline, "slug" | "repos" | "status"> = {
  slug: "",
  repos: [],
  status: "landed",
};

export function TrackerTimelines() {
  const data = useLoaderData<typeof trackerTimelinesLoader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  // Rows opened to show what's behind them (CORE-402), and where each row sits,
  // so the lanes run on through an opened one.
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<string>>(new Set());
  const toggleRow = (key: string) =>
    setExpandedRows((open) => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const rowsRef = useRef<HTMLOListElement>(null);
  const [geometry, setGeometry] = useState<RowGeometry | null>(null);
  const space = data.space.slug;
  const base = `/tracker/${encodeURIComponent(space)}/timelines`;
  const slug = params.get("tl");
  const selected = slug ? (data.timelines.find((t) => t.slug === slug) ?? null) : null;
  // One live feed for the selected timeline: Live now and its observability view share it.
  const feed = useStepFeed(selected ?? NO_TIMELINE);
  const byId = useMemo(() => new Map(data.timelines.map((t) => [t.id, t])), [data.timelines]);
  useRememberPlace(
    selected
      ? {
          kind: "timeline",
          title: selected.name,
          detail: `timeline/${selected.slug} · ${space}`,
          to: `${base}?tl=${encodeURIComponent(selected.slug)}`,
        }
      : null,
  );

  // Stalled: open, and no push for the account's idle period. The data's time
  // stands in for now, so a refresh moves it on.
  const now = useMemo(() => Date.now(), [data]);
  const graph = useMemo(
    () =>
      layoutGraph(data, {
        selected: selected?.id ?? null,
        filters,
        expanded,
        groupBy,
        now,
        idleDays: data.idleDays,
      }),
    [data, selected, filters, expanded, groupBy, now],
  );
  const counts = useMemo(() => {
    const c = { open: 0, landed: 0, abandoned: 0, experimental: 0, stalled: 0 };
    for (const t of data.timelines) {
      c[lineState(t, data.events)]++;
      if (t.experimental) c.experimental++;
      if (isStalled(t, now, data.idleDays)) c.stalled++;
    }
    return c;
  }, [data, now]);

  /**
   * The page with a timeline selected (null: main), keeping other parameters.
   * Selecting one here scopes the whole app to it, as the switcher does.
   */
  const select = (timeline: Timeline | null) =>
    withScope(`${base}?${params}`, timeline?.slug ?? null);
  const name = (timeline: Timeline | null, strong = false): ReactNode => (
    <Link
      to={select(timeline)}
      className={`relative z-10 pointer-events-auto underline decoration-line underline-offset-2 hover:decoration-signal ${strong ? "font-semibold text-ink" : "text-ink"} ${timeline ? "" : "font-mono"}`}
      title={timeline ? `${timeline.name} (${timeline.slug})` : "main"}
      onClick={(event) => event.stopPropagation()}
    >
      {timeline ? timeline.name : "main"}
    </Link>
  );
  const toggleExpanded = (id: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Below xl the panel is under the graph: after a selection, bring it into view and
  // read its heading (CORE-382). A page opened on a timeline stays where it is.
  const heading = useRef<HTMLHeadingElement>(null);
  const chosen = useRef(slug);
  useEffect(() => {
    if (chosen.current === slug) return;
    chosen.current = slug;
    if (!slug || window.matchMedia("(min-width: 80rem)").matches) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    heading.current?.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    heading.current?.focus({ preventScroll: true });
  }, [slug]);

  const width = graphWidth(graph);
  useLayoutEffect(() => {
    const list = rowsRef.current;
    if (!list) return;
    const measure = () => {
      const rows = [...list.querySelectorAll<HTMLElement>(":scope > li")];
      const tops = rows.map((row) => row.offsetTop);
      const last = rows.at(-1);
      const total = last ? last.offsetTop + last.offsetHeight : 0;
      setGeometry((prev) =>
        prev && prev.total === total && prev.tops.join() === tops.join() ? prev : { tops, total },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [graph]);
  const selectedRow = selected
    ? graph.rows.findIndex(
        (r) =>
          r.timeline?.id === selected.id &&
          (r.kind === "head" ||
            r.kind === "abandon" ||
            r.kind === "landing" ||
            r.kind === "landed"),
      )
    : 0;

  const rowMeta = (row: Row) => {
    const repo = eventRepo(row.event, [row.timeline, row.peer]);
    const merge = row.event?.kind === "merge" ? row.event : null;
    const commit =
      merge && repo ? (
        <Link
          className="relative z-10 pointer-events-auto mk-mono text-micro text-ink-faint underline underline-offset-2 max-sm:hidden"
          to={
            repo.source && repo.source.sourceId !== "canonical"
              ? commitsUrl(repo.space, repo.name, merge.commit, "", repo.source.sourceId)
              : commitPanelUrl(repo.space, repo.name, merge.commit)
          }
          title={`${repo.space}/${repo.name} at ${merge.commit}`}
          onClick={(event) => event.stopPropagation()}
        >
          {repo.name}@{shortOid(merge.commit)}
        </Link>
      ) : null;
    return commit;
  };

  return (
    <div className="flex min-h-dvh flex-col gap-3 px-4 py-3">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="m-0 text-title-lg">Timelines</h1>
        <SelectField
          ariaLabel="Tracker space"
          value={space}
          className="w-44"
          options={data.trackers.map((tracker) => ({
            value: tracker.slug,
            label: tracker.displayName,
          }))}
          onChange={(value) => navigate(`/tracker/${encodeURIComponent(value)}/timelines`)}
        />
        <div className="ml-auto flex items-center gap-1">
          <Tip label={revalidator.state !== "idle" ? "Refreshing" : "Refresh now"}>
            <button
              type="button"
              className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
              aria-label="Refresh now"
              disabled={revalidator.state !== "idle"}
              onClick={() => void revalidator.revalidate()}
            >
              <ArrowClockwiseIcon
                weight="bold"
                className={revalidator.state !== "idle" ? "animate-spin" : ""}
              />
            </button>
          </Tip>
        </div>
      </header>

      {data.timelines.length === 0 ? (
        <section className="mk-card max-w-[44rem]">
          <h2 className="mk-card-title">No timelines yet</h2>
          <p className="mk-card-desc max-w-[48ch]">
            A timeline is a line of work that lands on main when it is reviewed. Forks, merges,
            landings and abandoned timelines in {data.space.displayName}'s tracker will appear here.
            Any writer can start one from a checkout:
          </p>
          <pre className="mk-mono mt-3 mb-0 overflow-x-auto rounded-control bg-sunken p-3 text-mono">
            {"gm timeline start <slug>"}
          </pre>
          <p className="mt-3 mb-0 max-w-[48ch] text-body-sm text-ink-faint">
            Or over the API:{" "}
            <code className="mk-mono">{`POST /api/tracker/${space}/timelines`}</code> with{" "}
            <code className="mk-mono">{`{ "slug": "search-rewrite", "repos": ["${space}/<repository>"] }`}</code>
          </p>
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative flex min-w-0 basis-60 items-center">
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
                value={filters.search}
                onChange={(event) => setFilters({ ...filters, search: event.target.value })}
              />
            </label>
            <button
              type="button"
              className="mk-chip"
              aria-pressed={filters.stalled}
              aria-describedby="timelines-stalled-help"
              onClick={() => setFilters({ ...filters, stalled: !filters.stalled })}
            >
              Stalled
              <span className="font-mono text-micro tabular-nums opacity-70">{counts.stalled}</span>
            </button>
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Show">
              {(["open", "landed", "abandoned", "experimental"] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  className="mk-chip"
                  aria-pressed={filters[key]}
                  onClick={() => setFilters({ ...filters, [key]: !filters[key] })}
                >
                  {FILTER_LABEL[key]}
                  <span className="font-mono text-micro tabular-nums opacity-70">
                    {counts[key]}
                  </span>
                </button>
              ))}
            </div>
            <p
              id="timelines-stalled-help"
              className="m-0 text-micro text-ink-faint"
              aria-live="polite"
            >
              {[
                filters.stalled
                  ? `Stalled: no push for ${data.idleDays ?? DEFAULT_IDLE_DAYS} days. Experimental timelines are left out; stalling is expected of them.`
                  : "",
                graph.overflow
                  ? `The ${graph.overflow} least recently active are listed under Not drawn.`
                  : "",
                graph.filtered ? `${graph.filtered} hidden by filters.` : "",
                data.truncated ? "Only the newest events are drawn." : "",
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
          </div>

          <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem] xl:grid-rows-[auto_1fr]">
            <section
              className="min-w-0 overflow-x-auto rounded-pane bg-pane xl:col-start-1 xl:row-start-1"
              aria-label="Timeline graph"
            >
              <p className="m-0 border-b border-line-soft px-3 py-2 text-body-sm text-ink-muted">
                Select a timeline's row to view it and use it across the app. Details opens what a
                row has behind it.
              </p>
              <ol
                ref={rowsRef}
                className="relative m-0 list-none p-0"
                style={{ minWidth: width + 360 }}
                onMouseLeave={() => setHovered(null)}
              >
                <LaneDrawing
                  graph={graph}
                  selected={selected?.id ?? null}
                  hovered={hovered}
                  geometry={geometry}
                />
                {graph.rows.map((row, r) => {
                  const t = row.timeline;
                  const isSelected = r === selectedRow && (selected ? true : row.kind === "main");
                  const selectable =
                    row.kind === "main" ||
                    row.kind === "head" ||
                    row.kind === "abandon" ||
                    row.kind === "landing" ||
                    row.kind === "landed";
                  const said = summarize(row, {
                    data,
                    name: (timeline) =>
                      selectable && timeline?.id === t?.id ? (
                        <span className="font-semibold text-ink">{timeline?.name}</span>
                      ) : (
                        name(timeline, row.kind === "head")
                      ),
                    commit: rowMeta(row),
                  });
                  const isOpen = said.expandable && expandedRows.has(row.key);
                  const detailsId = `row-details-${r}`;
                  return (
                    <li
                      key={row.key}
                      data-kind={row.kind}
                      className={`relative border-t border-line-soft text-body-sm first:border-t-0 ${isSelected ? "bg-signal-wash" : "hover:bg-raised"}`}
                      style={{ minHeight: ROW_HEIGHT, paddingLeft: width + 8 }}
                      onMouseEnter={() => setHovered(t?.id ?? null)}
                    >
                      {selectable && (
                        <Link
                          to={select(t)}
                          aria-label={`Select ${t?.name ?? "main"}`}
                          aria-current={isSelected ? "true" : undefined}
                          className="absolute inset-0 z-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
                          title={t ? `${t.name} (${t.slug})` : "main"}
                        />
                      )}
                      <div
                        className="flex items-center gap-2 pr-3"
                        style={{ minHeight: ROW_HEIGHT }}
                      >
                        <div
                          className={`min-w-0 flex-1 py-1.5 ${selectable ? "pointer-events-none" : ""}`}
                        >
                          <div className="flex min-w-0 items-baseline gap-x-2">
                            <span className="min-w-0 truncate">{said.title}</span>
                            {said.chips && (
                              <span className="flex shrink-0 flex-wrap gap-1 max-md:hidden">
                                {said.chips}
                              </span>
                            )}
                            {said.detail && (
                              <span className="min-w-0 flex-1 truncate text-ink-muted">
                                {said.detail}
                              </span>
                            )}
                          </div>
                          {said.by && (
                            <div className="truncate text-micro text-ink-faint">{said.by}</div>
                          )}
                        </div>
                        {said.expandable && (
                          <button
                            type="button"
                            className="mk-btn mk-btn--ghost mk-btn--sm relative z-10 min-h-11 shrink-0"
                            aria-expanded={isOpen}
                            aria-controls={isOpen ? detailsId : undefined}
                            aria-label={`Details: ${row.event?.kind === "checkpoint" ? `checkpoint #${row.event.number}` : row.event?.kind === "landing" ? `landing #${row.event.number}` : row.event?.kind === "approval" ? `approval of #${row.event.number}` : "event"}${t ? ` of ${t.name}` : ""}`}
                            onClick={() => toggleRow(row.key)}
                          >
                            Details
                            <CaretRightIcon
                              aria-hidden
                              className={`size-3.5 transition-transform motion-reduce:transition-none ${isOpen ? "rotate-90" : ""}`}
                            />
                          </button>
                        )}
                        {selectable && (
                          <span
                            className={`pointer-events-none shrink-0 text-micro ${isSelected ? "font-semibold text-signal" : "text-ink-muted"}`}
                          >
                            {isSelected ? "Selected" : "Select"}
                          </span>
                        )}
                        {t && row.kind === "landed" && (
                          <button
                            type="button"
                            className="mk-btn mk-btn--ghost mk-btn--sm relative z-10 min-h-11 shrink-0"
                            aria-label={`Draw ${t.name}'s lane`}
                            onClick={() => toggleExpanded(t.id)}
                          >
                            Show lane
                          </button>
                        )}
                        {t && row.kind === "landing" && expanded.has(t.id) && (
                          <button
                            type="button"
                            className="mk-btn mk-btn--ghost mk-btn--sm relative z-10 min-h-11 shrink-0"
                            aria-label={`Fold ${t.name} onto main`}
                            onClick={() => toggleExpanded(t.id)}
                          >
                            Fold
                          </button>
                        )}
                        {row.at && (
                          <time
                            className="pointer-events-none shrink-0 text-micro text-ink-faint tabular-nums max-sm:hidden"
                            dateTime={row.at}
                            title={fullDate(row.at)}
                          >
                            {timeAgo(row.at)}
                          </time>
                        )}
                      </div>
                      {isOpen && (
                        <div
                          id={detailsId}
                          className="relative z-10 mr-3 mb-3 min-w-0 rounded-md bg-sunken p-3"
                        >
                          <RowDetails
                            row={row}
                            space={space}
                            name={(id) => data.actors[id]?.name ?? "someone outside the tracker"}
                            revision={data}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>

            <aside className="flex min-w-0 flex-col gap-4 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:sticky xl:top-[calc(var(--scope-banner)+0.75rem)] xl:max-h-[calc(100dvh-var(--scope-banner)-1.5rem)] xl:overflow-y-auto">
              <section className="rounded-pane bg-pane p-4" aria-label="Selected timeline">
                {selected ? (
                  <TimelineDetails
                    timeline={selected}
                    feed={feed}
                    data={data}
                    byId={byId}
                    name={name}
                    clear={select(null)}
                    headingRef={heading}
                    onChange={() => {
                      refreshTimelines(space);
                      void revalidator.revalidate();
                    }}
                  />
                ) : (
                  <MainSummary data={data} counts={counts} />
                )}
              </section>

              <section className="rounded-pane bg-pane" aria-labelledby="not-drawn">
                <header className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
                  <h2 id="not-drawn" className="m-0 text-title">
                    Not drawn
                  </h2>
                  <span className="font-mono text-micro text-ink-faint tabular-nums">
                    {graph.groups.reduce((n, g) => n + g.timelines.length, 0)}
                  </span>
                  <div className="mk-segmented ml-auto" role="radiogroup" aria-label="Group by">
                    {GROUP_BY.map((g) => (
                      <button
                        key={g.value}
                        type="button"
                        role="radio"
                        aria-checked={groupBy === g.value}
                        className="mk-segment"
                        onClick={() => setGroupBy(g.value)}
                      >
                        {g.label}
                      </button>
                    ))}
                  </div>
                </header>
                {graph.groups.length === 0 ? (
                  <p className="m-0 px-4 py-3 text-body-sm text-ink-faint">
                    Every timeline that matches is in the graph.
                  </p>
                ) : (
                  <div>
                    {graph.groups.map((group, index) => (
                      <details
                        key={`${groupBy}:${group.key}`}
                        className="border-t border-line-soft first:border-t-0"
                        open={index === 0 || graph.groups.length <= 3}
                      >
                        <summary className="flex cursor-pointer items-center gap-2 px-4 py-2 text-body-sm font-semibold text-ink-muted hover:bg-raised">
                          <span className="min-w-0 flex-1 truncate">{group.label}</span>
                          <span className="font-mono text-micro text-ink-faint tabular-nums">
                            {group.timelines.length}
                          </span>
                        </summary>
                        <ul className="m-0 list-none p-0 pb-1">
                          {group.timelines.map((t) => (
                            <li key={t.id}>
                              <Link
                                to={select(t)}
                                className="flex min-h-11 items-center gap-2 px-4 py-1.5 text-body-sm text-ink no-underline hover:bg-raised"
                              >
                                <StatusDot status={t.status} />
                                <span className="min-w-0 flex-1 truncate">{t.name}</span>
                                {t.experimental && (
                                  <span className="mk-chip mk-chip--tag">Experimental</span>
                                )}
                                <span
                                  className="shrink-0 text-micro text-ink-faint"
                                  title={fullDate(lastActivity(t, data.events))}
                                >
                                  {timeAgo(lastActivity(t, data.events))}
                                </span>
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </details>
                    ))}
                  </div>
                )}
              </section>
            </aside>
            {/* After the selected timeline on phones, below the graph on wide screens (CORE-382). */}
            {selected && (
              <div className="min-w-0 xl:col-start-1 xl:row-start-2">
                <TimelineObservability
                  key={selected.slug}
                  space={space}
                  timeline={selected}
                  feed={feed.records}
                  removed={feed.removed}
                />
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function MainSummary({
  data,
  counts,
}: {
  data: TimelineGraphData;
  counts: Record<LineState | "experimental" | "stalled", number>;
}) {
  return (
    <>
      <h2 className="m-0 font-mono text-title-lg">main</h2>
      <p className="mt-1 mb-0 text-body-sm text-ink-muted">
        {counts.open} open, {counts.landed} landed and {counts.abandoned} abandoned timelines in{" "}
        {data.space.displayName}'s tracker
        {counts.stalled ? `, ${counts.stalled} of them stalled` : ""}. Select one to review its
        changes and see it with the timelines it came from and what depends on it.
      </p>
      <dl className="mt-3 mb-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
        <Legend shape={<span className="size-2 rounded-full bg-ink" />} label="Active" />
        <Legend
          shape={<span className="size-2 rounded-full ring-[1.5px] ring-ink-faint ring-inset" />}
          label="Idle"
        />
        <Legend shape={<span className="size-2 rounded-full bg-ink-faint" />} label="Waiting" />
        <Legend
          shape={<span className="size-2.5 rounded-[2px] bg-online" />}
          label="Landed, folded onto main"
        />
        <Legend shape={<span className="font-mono text-ink-muted">×</span>} label="Abandoned" />
        <Legend
          shape={<span className="w-3 border-t-[1.5px] border-dashed border-ink-faint" />}
          label="Experimental lane"
        />
      </dl>
    </>
  );
}

function Legend({ shape, label }: { shape: ReactNode; label: string }) {
  return (
    <>
      <dt className="flex h-5 w-4 items-center justify-center" aria-hidden>
        {shape}
      </dt>
      <dd className="m-0 text-ink-muted">{label}</dd>
    </>
  );
}

/**
 * The issues a timeline worked on or has done (CORE-74), linked into its view,
 * which stays readable after it ends. An abandoned timeline's show the status
 * they had in it.
 */
function TimelineIssues({ timeline, data }: { timeline: Timeline; data: TimelineGraphData }) {
  if (!data.issues) return null;
  const issues = data.issues[timeline.id] ?? [];
  const base = `/tracker/${encodeURIComponent(data.space.slug)}/issues/`;
  const view = `?tl=${encodeURIComponent(timeline.slug)}`;
  const label = (issue: (typeof issues)[number]) => {
    if (issue.status === "done_in_timeline" && issue.doneIn?.id === timeline.id)
      return "Done here, not landed";
    if (timeline.status === "abandoned" && issue.status === "done") return "Done here, abandoned";
    return statusLabel(issue);
  };
  return (
    <>
      <h3 className={SECTION}>Issues</h3>
      {issues.length === 0 ? (
        <p className="m-0 text-body-sm text-ink-faint">None worked on here yet.</p>
      ) : (
        <ul className="m-0 list-none p-0">
          {issues.map((issue) => (
            <li key={issue.id} className="flex items-baseline gap-2 py-0.5 text-body-sm">
              <Link
                className={`${link} shrink-0`}
                to={`${base}${encodeURIComponent(issue.key)}${view}`}
              >
                <span className="mk-mono">{issue.key}</span>
              </Link>
              <span className="min-w-0 flex-1 truncate" title={issue.title}>
                {issue.title}
              </span>
              <span className="inline-flex shrink-0 items-center gap-1 text-micro text-ink-faint">
                {issue.status === "done_in_timeline" && <DoneInTimelineIcon />}
                {label(issue)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * Where to look at what a timeline changes (CORE-382): the Changes and Story
 * pages, and per repository how much it differs from main, read when the
 * panel opens so a person sees the size of the review before choosing.
 */
function ReviewBlock({
  space,
  timeline,
  events,
}: {
  space: string;
  timeline: Timeline;
  events: TimelineEvent[];
}) {
  const entries = useMemo(
    () =>
      timeline.repos.map((repo) => {
        const head = workHead(timeline, events, repo);
        const landed = landedMerge(timeline, events, repo);
        return [repo, landed ? { head, landed } : { head }] as const;
      }),
    [timeline, events],
  );
  const results = useCompares(
    entries.map(([repo, request]) => [repo, request]),
    0,
  );
  const many = timeline.repos.length > 1;
  const query = (repo: Timeline["repos"][number]) =>
    many ? { repo: `${repo.space}/${repo.name}` } : undefined;
  const button = "mk-btn no-underline max-xl:min-h-11";
  return (
    <section aria-labelledby={`review-${timeline.id}`}>
      <h3 id={`review-${timeline.id}`} className={SECTION}>
        Review
      </h3>
      <div className="flex flex-wrap gap-2">
        <Link
          className={`${button} mk-btn--primary`}
          to={timelinePageUrl(space, timeline.slug, "changes")}
        >
          Changes
        </Link>
        <Link className={button} to={timelinePageUrl(space, timeline.slug, "story")}>
          Story
        </Link>
      </div>
      <ul className="m-0 mt-2 list-none p-0 text-body-sm">
        {entries.map(([repo]) => {
          const result = results[repo.id];
          return (
            <li key={repo.id} className="py-0.5">
              <Link
                className={`${link} mk-mono`}
                to={timelinePageUrl(space, timeline.slug, "changes", query(repo))}
              >
                {repo.space}/{repo.name}
              </Link>{" "}
              <span className="text-ink-muted" aria-live="polite">
                {!result ? (
                  "· comparing with main…"
                ) : result.state === "ok" ? (
                  <ReviewStat diff={result.diff} landed={result.landed} />
                ) : result.status === 413 ? (
                  "· too large to summarise"
                ) : result.status === 404 ? (
                  "· nothing to compare"
                ) : (
                  "· couldn't compare"
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ReviewStat({
  diff,
  landed,
}: {
  diff: Parameters<typeof diffStats>[0];
  /** What the landing brought onto main, not a comparison with it. */
  landed?: boolean;
}) {
  const { files, additions, deletions } = diffStats(diff);
  if (files === 0) return <>{landed ? "· landed, no file changes" : "· no changes vs main"}</>;
  return (
    <>
      · {files}
      {diff.truncated ? "+" : ""} {files === 1 ? "file" : "files"} ·{" "}
      <span className="mk-mono text-online">+{additions}</span>{" "}
      <span className="mk-mono text-danger-text">−{deletions}</span> {landed ? "landed" : "vs main"}
    </>
  );
}

function TimelineDetails({
  timeline,
  feed,
  data,
  byId,
  name,
  clear,
  headingRef,
  onChange,
}: {
  timeline: Timeline;
  feed: ReturnType<typeof useStepFeed>;
  data: TimelineGraphData;
  byId: Map<string, Timeline>;
  name: (timeline: Timeline | null) => ReactNode;
  clear: string;
  /** Where focus goes after a selection on a narrow screen. */
  headingRef: RefObject<HTMLHeadingElement | null>;
  /** After the timeline itself changed (its experimental flag). */
  onChange: () => void;
}) {
  const space = data.space.slug;
  // Every event touching this timeline, merges into and out of it included:
  // where its work is and whether it landed (CORE-382).
  const involved = data.events.filter((e) => involves(e, timeline.id));
  const abandoned = involved.findLast((e) => e.kind === "abandon");
  const lastCommits = abandoned?.kind === "abandon" ? abandoned.lastCommits : {};
  const parent = timeline.parentId ? (byId.get(timeline.parentId) ?? null) : null;
  const actor = (id: string) => data.actors[id]?.name ?? "someone outside the tracker";
  /** The same, with a person linked to their profile; agents stay text. */
  const actorLink = (id: string) => {
    const known = data.actors[id];
    return known?.slug && known.accountableId === null ? (
      <PersonLink slug={known.slug} prose>
        {known.name}
      </PersonLink>
    ) : (
      actor(id)
    );
  };
  const own = data.events.filter((e) => e.timelineId === timeline.id);
  // Numbered from 1, so the newest number counts them even when the oldest
  // events weren't read (data.truncated).
  const checkpointCount = own.reduce(
    (n, e) => (e.kind === "checkpoint" ? Math.max(n, e.number) : n),
    0,
  );
  // Forked from this one: drawn only when their lanes are, so named here.
  const forks = data.timelines.filter((t) => t.parentId === timeline.id);
  const lastApproval = own.findLast((e) => e.kind === "approval");
  const lastLanding = own.findLast((e) => e.kind === "landing");
  const issues = data.issues?.[timeline.id] ?? [];
  const ended = timeline.status === "landed" || timeline.status === "abandoned";
  const latestStep = feed.records[0];
  const many = timeline.repos.length > 1;
  // One read of the checkpoints for the list and the landing panel (CORE-382).
  const [reloads, setReloads] = useState(0);
  const loadedCheckpoints = useCheckpoints(space, timeline.slug, `${timeline.version}.${reloads}`);
  return (
    <>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="m-0 min-w-0 scroll-mt-4 text-title-lg [overflow-wrap:anywhere] focus:outline-none"
        >
          {timeline.name}
        </h2>
        <span className="inline-flex items-center gap-1.5 text-body-sm text-ink-muted">
          <StatusDot status={timeline.status} />
          {STATUS_LABEL[timeline.status]}
        </span>
      </div>

      <ReviewBlock space={space} timeline={timeline} events={involved} />

      <dl className="mt-3 mb-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
        <dt className="text-ink-faint">Slug</dt>
        <dd className="m-0 min-w-0 truncate font-mono text-ink-muted">{timeline.slug}</dd>
        <dt className="text-ink-faint">Lands</dt>
        <dd className="m-0">
          {timeline.policy === "auto" ? "automatically" : "after approval"}
          {timeline.experimental && <span className="mk-chip mk-chip--tag ml-2">Experimental</span>}
        </dd>
        <dt className="text-ink-faint">Forked</dt>
        <dd className="m-0 min-w-0" title={fullDate(timeline.createdAt)}>
          from {name(parent)}, {timeAgo(timeline.createdAt)} by {actorLink(timeline.startedBy)}
        </dd>
        {forks.length > 0 && (
          <>
            <dt className="text-ink-faint">Forks</dt>
            <dd className="m-0 min-w-0">
              {forks.map((fork, i) => (
                <Fragment key={fork.id}>
                  {i > 0 && ", "}
                  {name(fork)}
                  {(fork.status === "landed" || fork.status === "abandoned") &&
                    ` (${STATUS_LABEL[fork.status].toLowerCase()})`}
                </Fragment>
              ))}
            </dd>
          </>
        )}
        <dt className="text-ink-faint">Accountable</dt>
        <dd className="m-0">{actorLink(timeline.accountableId)}</dd>
        {timeline.agentIds.length > 0 && (
          <>
            <dt className="text-ink-faint">Agents</dt>
            <dd className="m-0">{timeline.agentIds.map(actor).join(", ")}</dd>
          </>
        )}
        <dt className="text-ink-faint">Last push</dt>
        <dd className="m-0">
          {timeline.pushedAt ? (
            <span title={fullDate(timeline.pushedAt)}>{timeAgo(timeline.pushedAt)}</span>
          ) : (
            "none yet"
          )}
        </dd>
      </dl>
      {/* The same exit as the scope banner's Back to main, labelled for what it does here. */}
      <Link
        className="mt-1 inline-flex min-h-11 items-center text-body-sm text-ink-muted underline decoration-line underline-offset-2 hover:text-ink xl:min-h-8"
        to={clear}
      >
        Show main instead
      </Link>

      <PanelSection
        id="checkpoints"
        title="Checkpoints"
        hint={
          checkpointCount
            ? `${checkpointCount}${lastApproval?.kind === "approval" ? ` · #${lastApproval.number} ${lastApproval.outcome}` : ""}`
            : data.truncated
              ? undefined
              : "none yet"
        }
        defaultOpen
      >
        <TimelineCheckpoints
          space={space}
          timeline={timeline}
          checkpoints={loadedCheckpoints.checkpoints}
          error={loadedCheckpoints.error}
          actor={actor}
          onRevived={() => setReloads((n) => n + 1)}
        />
      </PanelSection>

      <PanelSection
        id="landing"
        title="Landing"
        hint={
          lastLanding?.kind === "landing"
            ? `#${lastLanding.number} · ${timeline.status === "landing" ? "landing now" : lastLanding.outcome.replaceAll("_", " ")}`
            : timeline.policy === "auto"
              ? "lands when checks pass"
              : "lands after approval"
        }
        defaultOpen
      >
        <LandingPanel
          space={space}
          timeline={timeline}
          checkpoints={loadedCheckpoints.checkpoints}
          failed={loadedCheckpoints.failed}
          onChange={onChange}
        />
      </PanelSection>

      {!ended && (
        <PanelSection
          id="live"
          title="Live now"
          hint={
            latestStep ? `${latestStep.author.name} · ${timeAgo(latestStep.at)}` : "no steps yet"
          }
          defaultOpen
        >
          <LiveNow space={space} timeline={timeline} feed={feed} />
        </PanelSection>
      )}

      {data.issues && (
        <PanelSection
          id="issues"
          title="Issues"
          hint={issues.length ? `${issues.length} · ${issues[0]!.key}` : "none"}
          defaultOpen={issues.length > 0}
        >
          <TimelineIssues timeline={timeline} data={data} />
        </PanelSection>
      )}

      <PanelSection
        id="code"
        title="Code"
        hint={`${timeline.repos.length} ${timeline.repos.length === 1 ? "repository" : "repositories"}`}
      >
        <h3 className={SECTION}>Code</h3>
        <ul className="m-0 list-none p-0">
          {timeline.repos.map((repo) => {
            const last = lastCommits[repo.id];
            const query = many ? { repo: `${repo.space}/${repo.name}` } : undefined;
            return (
              <li
                key={repo.id}
                className="flex flex-wrap items-baseline gap-x-3 py-0.5 text-body-sm"
              >
                <span className="min-w-0 truncate text-ink">
                  {repo.space}/{repo.name}
                </span>
                {!repo.source && !ended ? (
                  <span className="text-ink-muted">Source migration required</span>
                ) : (
                  <span className="flex flex-wrap items-baseline gap-x-3">
                    <Link
                      className={link}
                      to={timelinePageUrl(space, timeline.slug, "changes", query)}
                    >
                      Changes
                    </Link>
                    <Link
                      className={link}
                      to={timelinePageUrl(space, timeline.slug, "story", query)}
                    >
                      Steps
                    </Link>
                    {ended ? (
                      last ? (
                        <Link
                          className={link}
                          to={
                            repo.source && repo.source.sourceId !== "canonical"
                              ? treeUrl(repo.space, repo.name, last, "", repo.source.sourceId)
                              : commitPanelUrl(repo.space, repo.name, last)
                          }
                        >
                          Last commit <span className="mk-mono">{shortOid(last)}</span>
                        </Link>
                      ) : repo.source?.kind === "timeline-work" ? (
                        <Link
                          className={link}
                          to={commitsUrl(
                            repo.space,
                            repo.name,
                            repo.bookmark,
                            "",
                            repo.source.sourceId,
                          )}
                        >
                          Archived progress history
                        </Link>
                      ) : (
                        <span className="text-ink-faint">Historical bookmark deleted</span>
                      )
                    ) : (
                      <>
                        <Link
                          className={link}
                          to={treeUrl(
                            repo.space,
                            repo.name,
                            repo.bookmark,
                            "",
                            repo.source?.sourceId,
                          )}
                        >
                          Browse files
                        </Link>
                        <Link
                          className={link}
                          to={commitsUrl(
                            repo.space,
                            repo.name,
                            repo.bookmark,
                            "",
                            repo.source?.sourceId,
                          )}
                        >
                          Commits
                        </Link>
                      </>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </PanelSection>

      <PanelSection id="agents" title="Agents seen" hint="in the last 10 minutes">
        <RecentAgents
          endpoint={`/tracker/${encodeURIComponent(space)}/timelines/${encodeURIComponent(timeline.slug)}/presence`}
        />
      </PanelSection>

      {!ended && (
        <PanelSection
          id="settings"
          title="Settings"
          hint={timeline.experimental ? "experimental" : "not experimental"}
        >
          <ExperimentalSwitch space={space} timeline={timeline} onChange={onChange} />
        </PanelSection>
      )}
    </>
  );
}

/**
 * A part of a timeline's panel that opens and closes (CORE-402), with a line
 * that still says something when closed. Its open state is remembered, per
 * part, across timelines. Its children's own headings stay for screen readers;
 * the summary is the visible one.
 */
function PanelSection({
  id,
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  id: string;
  title: string;
  hint?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const key = `gitmatrix:timeline-panel:${id}`;
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(key);
      return saved === null ? defaultOpen : saved === "1";
    } catch {
      return defaultOpen;
    }
  });
  return (
    <details
      className="group mt-3 border-t border-line-soft pt-2"
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next === open) return;
        setOpen(next);
        try {
          localStorage.setItem(key, next ? "1" : "0");
        } catch {
          // Remembering is a convenience.
        }
      }}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded py-1 text-body-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
        <CaretRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-ink-faint transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        {title}
        {hint && (
          <span className="ml-auto min-w-0 truncate text-micro font-normal text-ink-faint">
            {hint}
          </span>
        )}
      </summary>
      <div className="pt-1 pb-1 pl-5.5 [&_h3]:sr-only [&>*>*:first-child]:mt-0">{children}</div>
    </details>
  );
}

/**
 * The timeline's checkpoints with their previews (CORE-79): any checkpoint's
 * preview can be revived from here, landed and abandoned timelines included.
 */
function TimelineCheckpoints({
  space,
  timeline,
  checkpoints: list,
  error,
  actor,
  onRevived,
}: {
  space: string;
  timeline: Timeline;
  /** `null` while loading or when they couldn't be read. */
  checkpoints: CheckpointView[] | null;
  error: string | null;
  /** A person's or agent's name, for who approved a checkpoint. */
  actor: (id: string) => string;
  /** After a preview was revived: read the checkpoints again. */
  onRevived: () => void;
}) {
  const checkpoints = list ?? [];
  return (
    <>
      <h3 className={SECTION}>Checkpoints</h3>
      {error ? (
        <p className="mk-error m-0 text-body-sm" role="alert">
          {error}
        </p>
      ) : !list ? (
        <p className="m-0 text-body-sm text-ink-faint">Loading…</p>
      ) : checkpoints.length === 0 ? (
        <p className="m-0 text-body-sm text-ink-faint">None yet.</p>
      ) : (
        <ol className="m-0 max-h-72 list-none overflow-y-auto p-0">
          {checkpoints.map((view) => (
            <li
              key={view.checkpoint.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-t border-line-soft py-1.5 text-body-sm first:border-t-0"
            >
              <Link
                className={`${link} font-semibold`}
                to={timelinePageUrl(space, timeline.slug, "changes", {
                  checkpoint: String(view.checkpoint.number),
                })}
                title={`What checkpoint #${view.checkpoint.number} added`}
              >
                #{view.checkpoint.number}
              </Link>
              <time
                className="text-micro text-ink-faint tabular-nums"
                dateTime={view.checkpoint.createdAt}
                title={fullDate(view.checkpoint.createdAt)}
              >
                {timeAgo(view.checkpoint.createdAt)}
              </time>
              {view.approved &&
                (view.approval?.via === "auto-approve" ? (
                  <span
                    className="mk-chip mk-chip--tag"
                    title={`Approved automatically: ${view.approval.by ? actor(view.approval.by) : "someone"}\u2019s approve-when-green setting`}
                  >
                    Approved automatically
                  </span>
                ) : (
                  <span className="mk-chip mk-chip--tag">Approved</span>
                ))}
              {view.previews.length === 0 ? (
                <span className="text-ink-faint">No preview</span>
              ) : (
                view.previews.map((preview) => <PreviewLink key={preview.id} preview={preview} />)
              )}
              <Link
                className={link}
                to={timelinePageUrl(space, timeline.slug, "changes", {
                  checkpoint: String(view.checkpoint.number),
                })}
              >
                Review changes
              </Link>
              <ReviveButton view={view} tracker={space} onRevived={onRevived} />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

/**
 * The experimental flag (CORE-86): a marker for a timeline not expected to
 * land, which stalled views leave out. It restricts nothing; any writer sets
 * or clears it, and its work merges anywhere.
 */
function ExperimentalSwitch({
  space,
  timeline,
  onChange,
}: {
  space: string;
  timeline: Timeline;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `experimental-${timeline.id}`;
  const flag = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<Timeline>(
        `/tracker/${encodeURIComponent(space)}/timelines/${encodeURIComponent(timeline.slug)}`,
        {
          method: "PATCH",
          json: { experimental: !timeline.experimental, expectedVersion: timeline.version },
        },
      );
      onChange();
    } catch (failure) {
      setError(
        failure instanceof ApiError && failure.code === "version_conflict"
          ? "Someone changed this timeline since the page loaded. Refresh and try again."
          : failure instanceof Error
            ? failure.message
            : String(failure),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-3 flex items-start gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={timeline.experimental}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        aria-busy={busy || undefined}
        disabled={busy}
        className="mk-switch mt-0.5 shrink-0"
        onClick={() => void flag()}
      />
      <div className="min-w-0">
        <div id={`${id}-label`} className="text-body-sm font-semibold text-ink">
          Experimental
        </div>
        <p id={`${id}-help`} className="m-0 text-body-sm text-ink-faint">
          Not expected to land, so stalled views leave it out. Its work still merges into any
          timeline, and it can still land.
        </p>
        {error && (
          <p className="mk-error m-0 mt-1" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
