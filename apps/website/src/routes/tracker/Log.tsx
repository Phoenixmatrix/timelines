// The issue log: one 32px line per issue, virtualized inside its own scroll
// pane, so 30,000 rows read like an event log. Columns drop away as the pane
// narrows (container queries), state always leads. Progress groups (CORE-295)
// are rows of the same height under the one column header; the group being
// read stays pinned below it until the next group's row pushes it away.

import { CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Issue } from "../../../shared/tracker.ts";
import { timeAgo } from "../../lib/format.ts";
import { ClaimIcon, DoneInTimelineIcon, typeLabel } from "./ui.tsx";
import {
  claimLabel,
  STATE_LABEL,
  type GroupKey,
  type IssueGroup,
  type IssueIndex,
  type IssueState,
  type SortKey,
} from "./query.ts";
import { attribution, claimAttribution } from "../../../shared/tracker.ts";
import { Actor } from "./Actor.tsx";
import { RequiresMark } from "./Requirements.tsx";
import { IssueTagsInline } from "../../components/Chips.tsx";

const ROW = 32;
const OVERSCAN = 12;

/**
 * One grid for header and rows; columns join as the log gets room, and the
 * title keeps its width first: team and priority at 42rem, type at 56rem,
 * assignee at 64rem. State is a mark alone on narrow logs, while an issue is
 * open beside the log, or when the query already pins one state.
 */
const GRID_WORDS =
  "grid items-center gap-x-3 px-3 grid-cols-[0.75rem_4.5rem_minmax(0,1fr)_3.5rem] " +
  "@lg:grid-cols-[7.5rem_5.5rem_minmax(0,1fr)_4.5rem] " +
  "@2xl:grid-cols-[7.5rem_5.5rem_minmax(0,1fr)_4rem_2rem_4.5rem] " +
  "@4xl:grid-cols-[7.5rem_5.5rem_minmax(0,1fr)_4rem_4rem_2rem_4.5rem] " +
  "@5xl:grid-cols-[7.5rem_5.5rem_minmax(0,1fr)_4rem_4rem_8rem_2rem_4.5rem]";
const GRID_DOTS =
  "grid items-center gap-x-3 px-3 grid-cols-[0.75rem_4.5rem_minmax(0,1fr)_3.5rem] " +
  "@lg:grid-cols-[0.75rem_5.5rem_minmax(0,1fr)_4.5rem] " +
  "@2xl:grid-cols-[0.75rem_5.5rem_minmax(0,1fr)_4rem_2rem_4.5rem] " +
  "@4xl:grid-cols-[0.75rem_5.5rem_minmax(0,1fr)_4rem_4rem_2rem_4.5rem] " +
  "@5xl:grid-cols-[0.75rem_5.5rem_minmax(0,1fr)_4rem_4rem_8rem_2rem_4.5rem]";
const TEAM = "hidden @2xl:block";
const TYPE = "hidden @4xl:block";
const ASSIGNEE = "hidden @5xl:block";

const STATE_DOT: Record<Exclude<IssueState, "claimed" | "leased" | "done_in_timeline">, string> = {
  waiting: "bg-signal",
  ready: "bg-online",
  blocked: "bg-danger-text",
  in_progress: "bg-ink",
  todo: "bg-ink-muted",
  human_only: "bg-ink-muted",
  not_ready: "bg-ink-faint",
  backlog: "bg-ink-faint",
  done: "bg-line",
  canceled: "bg-line",
};

/** Ordinary states use dots; ownership and done-in-timeline have distinct icons. */
export function StateDot({ state, className = "" }: { state: IssueState; className?: string }) {
  if (state === "done_in_timeline") return <DoneInTimelineIcon className={`size-3 ${className}`} />;
  if (state === "claimed" || state === "leased")
    return <ClaimIcon inherited={state === "leased"} className={`size-3 ${className}`} />;
  return (
    <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[state]} ${className}`} aria-hidden />
  );
}

/** What the state dots mean, wherever dots appear without their words. */
export function StateLegend({ className = "" }: { className?: string }) {
  const states: IssueState[] = [
    "waiting",
    "ready",
    "in_progress",
    "claimed",
    "leased",
    "todo",
    "backlog",
    "human_only",
    "not_ready",
    "blocked",
    "done_in_timeline",
    "done",
  ];
  return (
    <ul className={`mk-legend gap-x-3 gap-y-1 text-micro ${className}`} aria-label="Issue states">
      {states.map((state) => (
        <li key={state}>
          <StateDot state={state} />
          {STATE_LABEL[state]}
        </li>
      ))}
    </ul>
  );
}

export function StateLabel({
  issue,
  index,
  words = true,
}: {
  issue: Issue;
  index: IssueIndex;
  /** False shows the dot alone; the state stays in the tooltip and for screen readers. */
  words?: boolean;
}) {
  const state = index.state.get(issue.id) ?? "todo";
  const blockers = index.openBlockers.get(issue.id)?.length ?? 0;
  const holder = state === "claimed" && issue.claim ? issue.claim : null;
  const detail =
    state === "blocked"
      ? ` · ${blockers}`
      : holder
        ? ` · ${claimLabel(index, holder)}`
        : state === "leased"
          ? ` · ${index.leasedBy.get(issue.id)?.key}`
          : state === "done_in_timeline" && issue.doneIn
            ? ` · ${issue.doneIn.slug}`
            : "";
  return (
    <span
      className="inline-flex max-w-full min-w-0 items-center gap-1.5"
      title={
        state === "blocked"
          ? index.openBlockers
              .get(issue.id)
              ?.map((b) => b.key)
              .join(", ")
          : `${STATE_LABEL[state]}${detail}`
      }
    >
      <StateDot state={state} />
      <span
        className={`truncate ${words ? "@max-lg:sr-only" : "sr-only"} ${state === "done" || state === "canceled" ? "text-ink-faint" : "text-ink-muted"}`}
      >
        {STATE_LABEL[state]}
        {holder ? "" : detail}
      </span>
      {holder && words && (
        <Actor
          who={claimAttribution(index.people, holder)}
          face
          className="shrink-0 @max-lg:hidden"
        />
      )}
    </span>
  );
}

type Row = { kind: "group"; group: IssueGroup; folded: boolean } | { kind: "issue"; issue: Issue };

/** A group's row: what it holds and how much, and a fold toggle. */
function GroupRow({
  row,
  onFold,
  pinned = false,
}: {
  row: Extract<Row, { kind: "group" }>;
  onFold: () => void;
  pinned?: boolean;
}) {
  const { group, folded } = row;
  return (
    <button
      type="button"
      aria-expanded={!folded}
      // The pinned copy repeats the row in view; keyboards and screen readers use the row.
      tabIndex={pinned ? -1 : undefined}
      onClick={onFold}
      className="flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 border-0 border-b border-solid border-line-soft bg-surface px-3 text-left text-body-sm text-ink hover:bg-raised focus-visible:-outline-offset-2"
    >
      <CaretRightIcon
        weight="bold"
        aria-hidden
        className={`size-3 shrink-0 text-ink-faint transition-transform duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none ${folded ? "" : "rotate-90"}`}
      />
      <span className="truncate font-semibold">{group.label}</span>
      <span className="font-mono text-mono text-ink-faint tabular-nums">
        {group.issues.length.toLocaleString()}
      </span>
      {group.states.length > 1 && (
        <span className="ml-2 hidden min-w-0 items-center gap-3 overflow-hidden text-micro whitespace-nowrap text-ink-faint @lg:flex">
          {group.states.map(({ state, count }) => (
            <span key={state} className="inline-flex items-center gap-1.5">
              <StateDot state={state} />
              {count.toLocaleString()} {STATE_LABEL[state].toLowerCase()}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

export function IssueLog({
  issues,
  groups = null,
  folded,
  onFold,
  index,
  selected,
  href,
  sort,
  onSort,
  stateWords = true,
}: {
  issues: Issue[];
  /** Progress groups to show as sections; null lists the issues flat. */
  groups?: IssueGroup[] | null;
  folded?: ReadonlySet<GroupKey>;
  onFold?: (key: GroupKey) => void;
  index: IssueIndex;
  selected: string | null;
  href: (id: string) => string;
  sort: SortKey;
  onSort: (sort: SortKey) => void;
  stateWords?: boolean;
}) {
  const grid = stateWords ? GRID_WORDS : GRID_DOTS;
  const pane = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ from: 0, to: 60 });
  const rows = useMemo<Row[]>(
    () =>
      groups
        ? groups.flatMap((group): Row[] => {
            const shut = folded?.has(group.key) ?? false;
            return [
              { kind: "group", group, folded: shut },
              ...(shut ? [] : group.issues.map((issue): Row => ({ kind: "issue", issue }))),
            ];
          })
        : issues.map((issue) => ({ kind: "issue", issue })),
    [groups, folded, issues],
  );
  // Where each group's row sits, to pin the one being read.
  const heads = useMemo(() => rows.flatMap((row, i) => (row.kind === "group" ? [i] : [])), [rows]);
  const [pinned, setPinned] = useState<{ at: number; shift: number } | null>(null);

  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const measure = () => {
      const top = el.scrollTop;
      const from = Math.max(0, Math.floor(top / ROW) - OVERSCAN);
      const to = Math.min(rows.length, Math.ceil((top + el.clientHeight) / ROW) + OVERSCAN);
      setRange((r) => (r.from === from && r.to === to ? r : { from, to }));
      // Pin the group whose row has scrolled under the column header; the next
      // group's row slides it up and out rather than overlapping it.
      let at: number | null = null;
      let next: number | null = null;
      for (const head of heads) {
        if (head * ROW < top) at = head;
        else {
          next = head;
          break;
        }
      }
      const shift = next === null ? 0 : Math.min(0, next * ROW - top - ROW);
      setPinned((p) =>
        at === null ? null : p?.at === at && p.shift === shift ? p : { at, shift },
      );
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [rows.length, heads]);

  // Keep the selected row in view (keyboard j/k, graph clicks), clear of the
  // column header and, in groups, of the pinned group above it.
  useEffect(() => {
    const el = pane.current;
    if (!el || !selected) return;
    const at = rows.findIndex((row) => row.kind === "issue" && row.issue.id === selected);
    if (at < 0) return;
    const top = at * ROW - (groups ? ROW : 0);
    if (top < el.scrollTop) el.scrollTop = Math.max(0, top);
    else if (at * ROW + ROW > el.scrollTop + el.clientHeight - 36)
      el.scrollTop = at * ROW + ROW - el.clientHeight + 36;
  }, [selected, rows, groups]);

  const fold = (key: GroupKey, at: number) => {
    onFold?.(key);
    // Folding from the pinned row brings that group's row back to the top.
    const el = pane.current;
    if (el && el.scrollTop > at * ROW) el.scrollTop = at * ROW;
  };
  const pinnedRow = pinned ? rows[pinned.at] : undefined;

  const header = (
    label: string,
    key: SortKey | null,
    className = "",
    narrowHidden = false,
    hidden = false,
  ) =>
    key ? (
      <button
        type="button"
        className={`cursor-pointer truncate border-0 bg-transparent p-0 text-left text-inherit hover:text-ink aria-pressed:text-ink ${className}`}
        aria-pressed={sort === key}
        onClick={() => onSort(sort === key ? "rank" : key)}
      >
        {/* Narrow logs keep the cell (it holds the grid) but hide its words. */}
        <span className={hidden ? "sr-only" : narrowHidden ? "@max-lg:sr-only" : ""}>{label}</span>
        {sort === key && <span className="sr-only"> (sorted)</span>}
      </button>
    ) : (
      <span className={`truncate ${className}`}>{label}</span>
    );

  return (
    <div
      ref={pane}
      className="@container relative min-h-0 flex-1 overflow-auto rounded-pane bg-pane max-lg:h-[80dvh] max-lg:flex-none"
      role="table"
      aria-label="Issues"
      aria-rowcount={rows.length + 1}
    >
      <div
        role="row"
        className={`${grid} sticky top-0 z-[2] h-9 border-b border-line-soft bg-pane text-label text-ink-faint`}
      >
        {header("State", "rank", "", true, !stateWords)}
        {header("Key", "key")}
        {header("Title", null)}
        {header("Type", null, TYPE)}
        {header("Team", null, TEAM)}
        {header("Assignee", null, ASSIGNEE)}
        {header("P", "priority", TEAM)}
        {header("Updated", "updated", "text-right")}
      </div>
      {pinnedRow?.kind === "group" && (
        <div
          aria-hidden
          className="sticky top-9 z-[1] -mb-8 h-8"
          style={{ transform: `translateY(${pinned!.shift}px)` }}
        >
          <GroupRow row={pinnedRow} pinned onFold={() => fold(pinnedRow.group.key, pinned!.at)} />
        </div>
      )}
      <div className="relative" style={{ height: rows.length * ROW }}>
        {rows.slice(range.from, range.to).map((row, k) => {
          const i = range.from + k;
          if (row.kind === "group")
            return (
              <div
                key={`group:${row.group.key}`}
                role="row"
                aria-rowindex={i + 2}
                className="absolute inset-x-0 h-8"
                style={{ top: i * ROW }}
              >
                <div role="cell" className="h-full">
                  <GroupRow row={row} onFold={() => fold(row.group.key, i)} />
                </div>
              </div>
            );
          const issue = row.issue;
          const state = index.state.get(issue.id);
          const closed = state === "done" || state === "canceled";
          return (
            <Link
              key={issue.id}
              role="row"
              aria-rowindex={i + 2}
              aria-current={issue.id === selected ? "true" : undefined}
              to={href(issue.id)}
              className={`${grid} absolute inset-x-0 h-8 border-b border-line-soft text-body-sm text-ink no-underline hover:bg-surface aria-[current=true]:bg-signal-wash`}
              style={{ top: i * ROW }}
            >
              <span role="cell" className="min-w-0">
                <StateLabel issue={issue} index={index} words={stateWords} />
              </span>
              <span role="cell" className="truncate font-mono text-mono text-ink-faint">
                {issue.key}
              </span>
              <span
                role="cell"
                className={`flex min-w-0 items-center ${closed ? "text-ink-muted" : ""}`}
              >
                {issue.type === "prd" && (
                  <span className="mk-chip mk-chip--tag mr-1.5 shrink-0">PRD</span>
                )}
                <RequiresMark requires={issue.requires} />
                <span className="min-w-0 truncate">{issue.title}</span>
                <IssueTagsInline tags={issue.labels} className="ml-2 hidden @xl:inline-flex" />
              </span>
              <span role="cell" className={`truncate text-ink-faint ${TYPE}`}>
                {typeLabel(issue.type)}
              </span>
              <span role="cell" className={`truncate font-mono text-mono text-ink-faint ${TEAM}`}>
                {index.teamKey.get(issue.teamId)}
              </span>
              <span role="cell" className={`truncate text-ink-muted ${ASSIGNEE}`}>
                {issue.assigneeId ? (
                  <Actor who={attribution(index.people, issue.assigneeId)} compact />
                ) : (
                  <span className="text-ink-faint">Unassigned</span>
                )}
              </span>
              <span
                role="cell"
                className={`font-mono text-mono ${issue.priority <= 1 ? "text-ink" : "text-ink-faint"} ${TEAM}`}
              >
                P{issue.priority}
              </span>
              <span
                role="cell"
                className="truncate text-right text-micro text-ink-faint tabular-nums"
                title={new Date(issue.updatedAt).toLocaleString()}
              >
                {timeAgo(issue.updatedAt).replace(" ago", "")}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
