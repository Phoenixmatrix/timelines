// The timeline graph (CORE-81): forks, merges between timelines, landings on
// main, abandoned and experimental lanes, around the selected timeline: the
// app-wide scope (`?tl=`, lib/timelineScope.ts). The layout is in
// timelineGraph.ts and the drawing in TimelineLanes.tsx.

import { ArrowClockwiseIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  type CheckpointList,
  type Timeline,
  type TimelineEvent,
  type TimelineStatus,
} from "../../../shared/timelines.ts";
import { refreshTimelines } from "../../components/TimelineScope.tsx";
import { SelectField, Tip, link } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import { commitsUrl, treeUrl } from "../../lib/refs.ts";
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
import { LaneDrawing, ROW_HEIGHT, RowText, eventRepo, graphWidth } from "./TimelineLanes.tsx";
import { DoneInTimelineIcon, statusLabel } from "./ui.tsx";
import { PreviewLink, ReviveButton } from "./Checkpoint.tsx";
import { LandingPanel } from "./Landing.tsx";
import { LiveNow } from "./LiveNow.tsx";

export async function trackerTimelinesLoader({ request, params }: LoaderFunctionArgs) {
  try {
    return await api<TimelineGraphData>(
      `/tracker/${encodeURIComponent(params.owner!)}/timeline-graph`,
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
  { value: "workspace", label: "Workspace" },
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

function StatusDot({ status }: { status: TimelineStatus }) {
  return <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden />;
}

export function TrackerTimelines() {
  const data = useLoaderData<typeof trackerTimelinesLoader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [params] = useSearchParams();
  const [filters, setFilters] = useState<GraphFilters>(DEFAULT_FILTERS);
  const [groupBy, setGroupBy] = useState<GroupBy>("status");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [hovered, setHovered] = useState<string | null>(null);
  const owner = data.owner.slug;
  const base = `/tracker/${encodeURIComponent(owner)}/timelines`;
  const slug = params.get("tl");
  const selected = slug ? (data.timelines.find((t) => t.slug === slug) ?? null) : null;
  const byId = useMemo(() => new Map(data.timelines.map((t) => [t.id, t])), [data.timelines]);

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
      className={`no-underline hover:underline ${strong ? "font-semibold text-ink" : "text-ink"} ${timeline ? "" : "font-mono"}`}
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

  const width = graphWidth(graph);
  const selectedRow = selected
    ? graph.rows.findIndex(
        (r) =>
          r.timeline?.id === selected.id &&
          (r.kind === "head" || r.kind === "abandon" || r.kind === "landing"),
      )
    : 0;

  const rowMeta = (row: Row) => {
    const repo = eventRepo(row.event, [row.timeline, row.peer]);
    const merge = row.event?.kind === "merge" ? row.event : null;
    const commit =
      merge && repo ? (
        <Link
          className="mk-mono text-micro text-ink-faint no-underline hover:underline max-sm:hidden"
          to={commitsUrl(repo.owner, repo.name, merge.commit)}
          title={`${repo.owner}/${repo.name} at ${merge.commit}`}
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
          ariaLabel="Tracker owner"
          value={owner}
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
            A timeline is a line of work that forks from main into a bookmark{" "}
            <code className="mk-mono">timeline/&lt;slug&gt;</code> in each repository it touches,
            merges with other timelines and lands on main. Forks, merges, landings and abandoned
            timelines in {data.owner.displayName}'s tracker are drawn here. Any writer can fork one:
          </p>
          <pre className="mk-mono mt-3 mb-0 overflow-x-auto rounded-control bg-sunken p-3 text-mono">
            {`POST /api/tracker/${owner}/timelines
{ "slug": "search-rewrite", "repos": ["${owner}/<repository>"] }`}
          </pre>
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

          <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <section
              className="min-w-0 overflow-x-auto rounded-pane bg-pane"
              aria-label="Timeline graph"
            >
              <ol
                className="relative m-0 list-none p-0"
                style={{ minWidth: width + 240 }}
                onMouseLeave={() => setHovered(null)}
              >
                <LaneDrawing graph={graph} selected={selected?.id ?? null} hovered={hovered} />
                {graph.rows.map((row, r) => {
                  const t = row.timeline;
                  const isSelected = r === selectedRow && (selected ? true : row.kind === "main");
                  return (
                    <li
                      key={row.key}
                      data-kind={row.kind}
                      className={`flex items-center gap-2 border-t border-line-soft pr-3 text-body-sm first:border-t-0 ${isSelected ? "bg-signal-wash" : "hover:bg-raised"}`}
                      style={{ height: ROW_HEIGHT, paddingLeft: width + 4 }}
                      onMouseEnter={() => setHovered(t?.id ?? null)}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {row.kind === "main" ? (
                          <>
                            {name(null, true)}
                            <span className="text-ink-faint"> where every timeline lands</span>
                          </>
                        ) : (
                          <RowText
                            row={row}
                            name={(timeline) => name(timeline, row.kind === "head")}
                            commit={rowMeta(row)}
                          />
                        )}
                        {t?.experimental && row.kind === "head" && (
                          <span className="mk-chip mk-chip--tag ml-2">Experimental</span>
                        )}
                      </span>
                      {t && row.kind === "landed" && (
                        <button
                          type="button"
                          className="mk-btn mk-btn--ghost mk-btn--sm shrink-0"
                          aria-label={`Draw ${t.name}'s lane`}
                          onClick={() => toggleExpanded(t.id)}
                        >
                          Show lane
                        </button>
                      )}
                      {t && row.kind === "landing" && expanded.has(t.id) && (
                        <button
                          type="button"
                          className="mk-btn mk-btn--ghost mk-btn--sm shrink-0"
                          aria-label={`Fold ${t.name} onto main`}
                          onClick={() => toggleExpanded(t.id)}
                        >
                          Fold
                        </button>
                      )}
                      {row.at && (
                        <time
                          className="shrink-0 text-micro text-ink-faint tabular-nums max-sm:hidden"
                          dateTime={row.at}
                          title={fullDate(row.at)}
                        >
                          {timeAgo(row.at)}
                        </time>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>

            <aside className="flex min-w-0 flex-col gap-4 xl:sticky xl:top-[calc(var(--scope-banner)+0.75rem)]">
              <section className="rounded-pane bg-pane p-4" aria-label="Selected timeline">
                {selected ? (
                  <TimelineDetails
                    timeline={selected}
                    data={data}
                    byId={byId}
                    name={name}
                    clear={select(null)}
                    onChange={() => {
                      refreshTimelines(owner);
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
                  <div className="max-h-[32rem] overflow-y-auto">
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
                                className="flex items-center gap-2 px-4 py-1.5 text-body-sm text-ink no-underline hover:bg-raised"
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
        {data.owner.displayName}'s tracker
        {counts.stalled ? `, ${counts.stalled} of them stalled` : ""}. Select one to draw it with
        the timelines it came from and everything that depends on it.
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

function describe(
  event: TimelineEvent,
  self: Timeline,
  byId: Map<string, Timeline>,
): { verb: string; other: Timeline | null | undefined } {
  const of = (id: string | null) => (id === null ? null : byId.get(id));
  switch (event.kind) {
    case "fork":
      return event.timelineId === self.id
        ? { verb: "Forked from", other: of(event.parentId) }
        : { verb: "Forked into", other: of(event.timelineId) };
    case "merge":
      if (event.intoId === self.id) return { verb: "Merged in from", other: of(event.fromId) };
      return { verb: event.intoId === null ? "Landed on" : "Merged into", other: of(event.intoId) };
    case "abandon":
      return { verb: "Abandoned", other: undefined };
    default:
      return { verb: event.kind[0]!.toUpperCase() + event.kind.slice(1), other: undefined };
  }
}

/**
 * The issues a timeline worked on or has done (CORE-74), linked into its view,
 * which stays readable after it ends. An abandoned timeline's show the status
 * they had in it.
 */
function TimelineIssues({ timeline, data }: { timeline: Timeline; data: TimelineGraphData }) {
  if (!data.issues) return null;
  const issues = data.issues[timeline.id] ?? [];
  const base = `/tracker/${encodeURIComponent(data.owner.slug)}/issues/`;
  const view = `?tl=${encodeURIComponent(timeline.slug)}`;
  const label = (issue: (typeof issues)[number]) => {
    if (issue.status === "done_in_timeline" && issue.doneIn?.id === timeline.id)
      return "Done here, not landed";
    if (timeline.status === "abandoned" && issue.status === "done") return "Done here, abandoned";
    return statusLabel(issue);
  };
  return (
    <>
      <h3 className="mt-4 mb-1 text-body-sm font-semibold text-ink-muted">Issues</h3>
      {issues.length === 0 ? (
        <p className="m-0 text-body-sm text-ink-faint">None worked on here yet.</p>
      ) : (
        <ul className="m-0 max-h-60 list-none overflow-y-auto p-0">
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

function TimelineDetails({
  timeline,
  data,
  byId,
  name,
  clear,
  onChange,
}: {
  timeline: Timeline;
  data: TimelineGraphData;
  byId: Map<string, Timeline>;
  name: (timeline: Timeline | null) => ReactNode;
  clear: string;
  /** After the timeline itself changed (its experimental flag). */
  onChange: () => void;
}) {
  const events = data.events.filter((e) => involves(e, timeline.id)).reverse();
  const abandoned = events.find((e) => e.kind === "abandon");
  const lastCommits = abandoned?.kind === "abandon" ? abandoned.lastCommits : {};
  const parent = timeline.parentId ? (byId.get(timeline.parentId) ?? null) : null;
  const actor = (id: string) => data.actors[id]?.name ?? "someone outside the tracker";
  return (
    <>
      <div className="flex items-start gap-2">
        <h2 className="m-0 min-w-0 flex-1 text-title-lg [overflow-wrap:anywhere]">
          {timeline.name}
        </h2>
        <Link
          className="mk-btn mk-btn--ghost mk-btn--sm shrink-0 no-underline"
          to={`/tracker/${encodeURIComponent(data.owner.slug)}/timelines/${encodeURIComponent(timeline.slug)}/story`}
        >
          Story
        </Link>
        <Link className="mk-btn mk-btn--ghost mk-btn--sm shrink-0 no-underline" to={clear}>
          Back to main
        </Link>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-body-sm text-ink-muted">
        <span className="mk-mono text-ink-faint">{timeline.slug}</span>
        <span className="inline-flex items-center gap-1.5">
          <StatusDot status={timeline.status} />
          {STATUS_LABEL[timeline.status]}
        </span>
        <span>{timeline.policy === "auto" ? "Lands automatically" : "Lands after approval"}</span>
        {timeline.experimental && <span className="mk-chip mk-chip--tag">Experimental</span>}
      </div>
      <dl className="mt-3 mb-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-body-sm">
        <dt className="text-ink-faint">Forked from</dt>
        <dd className="m-0 min-w-0 truncate">{name(parent)}</dd>
        <dt className="text-ink-faint">Started</dt>
        <dd className="m-0" title={fullDate(timeline.createdAt)}>
          {timeAgo(timeline.createdAt)} by {actor(timeline.startedBy)}
        </dd>
        <dt className="text-ink-faint">Accountable</dt>
        <dd className="m-0">{actor(timeline.accountableId)}</dd>
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

      {timeline.status !== "landed" && timeline.status !== "abandoned" && (
        <ExperimentalSwitch owner={data.owner.slug} timeline={timeline} onChange={onChange} />
      )}

      <h3 className="mt-4 mb-1 text-body-sm font-semibold text-ink-muted">Code</h3>
      <ul className="m-0 list-none p-0">
        {timeline.repos.map((repo) => {
          const gone = timeline.status === "abandoned";
          const last = lastCommits[repo.id];
          return (
            <li key={repo.id} className="flex flex-wrap items-baseline gap-x-3 py-0.5 text-body-sm">
              <span className="min-w-0 truncate text-ink">
                {repo.owner}/{repo.name}
              </span>
              {gone ? (
                last ? (
                  <Link className={link} to={treeUrl(repo.owner, repo.name, last)}>
                    last commit <span className="mk-mono">{shortOid(last)}</span>
                  </Link>
                ) : (
                  <span className="text-ink-faint">bookmark deleted</span>
                )
              ) : (
                <>
                  <Link className={link} to={treeUrl(repo.owner, repo.name, repo.bookmark)}>
                    <span className="mk-mono">{repo.bookmark}</span>
                  </Link>
                  <Link className={link} to={commitsUrl(repo.owner, repo.name, repo.bookmark)}>
                    Commits
                  </Link>
                </>
              )}
            </li>
          );
        })}
      </ul>

      <LiveNow owner={data.owner.slug} timeline={timeline} />

      <TimelineCheckpoints owner={data.owner.slug} timeline={timeline} />

      <LandingPanel owner={data.owner.slug} timeline={timeline} onChange={onChange} />

      <TimelineIssues timeline={timeline} data={data} />

      <h3 id="events" className="mt-4 mb-1 text-body-sm font-semibold text-ink-muted">
        Events
      </h3>
      {events.length === 0 ? (
        <p className="m-0 text-body-sm text-ink-faint">
          {data.truncated ? "Older than the events drawn here." : "None recorded yet."}
        </p>
      ) : (
        <ol className="m-0 max-h-72 list-none overflow-y-auto p-0">
          {events.map((event) => {
            const { verb, other } = describe(event, timeline, byId);
            const repo = eventRepo(event, [timeline, other]);
            return (
              <li
                key={event.id}
                className="flex items-baseline gap-2 border-t border-line-soft py-1.5 text-body-sm first:border-t-0"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-ink-muted">{verb}</span>
                  {other !== undefined && <> {name(other)}</>}
                  {event.kind === "merge" && repo && (
                    <>
                      {" "}
                      <Link
                        className="mk-mono text-micro text-ink-faint no-underline hover:underline"
                        to={commitsUrl(repo.owner, repo.name, event.commit)}
                      >
                        {shortOid(event.commit)}
                      </Link>
                    </>
                  )}
                </span>
                <time
                  className="ml-auto shrink-0 text-micro text-ink-faint tabular-nums"
                  dateTime={event.createdAt}
                  title={`${fullDate(event.createdAt)}${event.actorId ? ` by ${actor(event.actorId)}` : ""}`}
                >
                  {timeAgo(event.createdAt)}
                </time>
              </li>
            );
          })}
        </ol>
      )}
    </>
  );
}

/**
 * The timeline's checkpoints with their previews (CORE-79): any checkpoint's
 * preview can be revived from here, landed and abandoned timelines included.
 */
function TimelineCheckpoints({ owner, timeline }: { owner: string; timeline: Timeline }) {
  const [list, setList] = useState<CheckpointList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    api<CheckpointList>(
      `/tracker/${encodeURIComponent(owner)}/timelines/${encodeURIComponent(timeline.slug)}/checkpoints`,
      { signal: controller.signal },
    )
      .then((loaded) => {
        setList(loaded);
        setError(null);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : String(failure));
      });
    return () => controller.abort();
  }, [owner, timeline.slug, version]);
  const checkpoints = list?.checkpoints ?? [];
  return (
    <>
      <h3 className="mt-4 mb-1 text-body-sm font-semibold text-ink-muted">Checkpoints</h3>
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
              <span className="font-semibold">#{view.checkpoint.number}</span>
              <time
                className="text-micro text-ink-faint tabular-nums"
                dateTime={view.checkpoint.createdAt}
                title={fullDate(view.checkpoint.createdAt)}
              >
                {timeAgo(view.checkpoint.createdAt)}
              </time>
              {view.previews.length === 0 ? (
                <span className="text-ink-faint">No preview</span>
              ) : (
                view.previews.map((preview) => <PreviewLink key={preview.id} preview={preview} />)
              )}
              <ReviveButton
                view={view}
                tracker={owner}
                onRevived={() => setVersion((v) => v + 1)}
              />
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
  owner,
  timeline,
  onChange,
}: {
  owner: string;
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
        `/tracker/${encodeURIComponent(owner)}/timelines/${encodeURIComponent(timeline.slug)}`,
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
