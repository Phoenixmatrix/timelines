// The issue log: one 32px line per issue, virtualized inside its own scroll
// pane, so 30,000 rows read like an event log. Columns drop away as the pane
// narrows (container queries), state always leads.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link } from "react-router";
import type { Issue } from "../../../shared/tracker.ts";
import { timeAgo } from "../../lib/format.ts";
import { typeLabel } from "./ui.tsx";
import {
  claimLabel,
  STATE_LABEL,
  type IssueIndex,
  type IssueState,
  type SortKey,
} from "./query.ts";
import { attribution, claimAttribution } from "../../../shared/tracker.ts";
import { Actor } from "./Actor.tsx";

const ROW = 32;
const OVERSCAN = 12;

/**
 * One grid for header and rows; columns join as the log gets room, and the
 * title keeps its width first: team and priority at 42rem, type at 56rem,
 * assignee at 64rem. State is a dot alone on narrow logs, while an issue is
 * open beside the log, or when the query already pins one state.
 */
const GRID_WORDS =
  "grid items-center gap-x-3 px-3 grid-cols-[0.5rem_4.5rem_minmax(0,1fr)_3.5rem] " +
  "@lg:grid-cols-[7.5rem_5.5rem_minmax(0,1fr)_4.5rem] " +
  "@2xl:grid-cols-[7.5rem_5.5rem_minmax(0,1fr)_4rem_2rem_4.5rem] " +
  "@4xl:grid-cols-[7.5rem_5.5rem_minmax(0,1fr)_4rem_4rem_2rem_4.5rem] " +
  "@5xl:grid-cols-[7.5rem_5.5rem_minmax(0,1fr)_4rem_4rem_8rem_2rem_4.5rem]";
const GRID_DOTS =
  "grid items-center gap-x-3 px-3 grid-cols-[0.5rem_4.5rem_minmax(0,1fr)_3.5rem] " +
  "@lg:grid-cols-[0.5rem_5.5rem_minmax(0,1fr)_4.5rem] " +
  "@2xl:grid-cols-[0.5rem_5.5rem_minmax(0,1fr)_4rem_2rem_4.5rem] " +
  "@4xl:grid-cols-[0.5rem_5.5rem_minmax(0,1fr)_4rem_4rem_2rem_4.5rem] " +
  "@5xl:grid-cols-[0.5rem_5.5rem_minmax(0,1fr)_4rem_4rem_8rem_2rem_4.5rem]";
const TEAM = "hidden @2xl:block";
const TYPE = "hidden @4xl:block";
const ASSIGNEE = "hidden @5xl:block";

export const STATE_DOT: Record<IssueState, string> = {
  waiting: "bg-signal",
  ready: "bg-online",
  claimed: "bg-transparent ring-[1.5px] ring-inset ring-ink",
  leased: "bg-transparent ring-[1.5px] ring-inset ring-ink-faint",
  blocked: "bg-danger-text",
  in_progress: "bg-ink",
  todo: "bg-ink-muted",
  backlog: "bg-ink-faint",
  done: "bg-line",
  canceled: "bg-line",
};

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
    "blocked",
    "done",
  ];
  return (
    <ul className={`mk-legend gap-x-3 gap-y-1 text-micro ${className}`} aria-label="Issue states">
      {states.map((state) => (
        <li key={state}>
          <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[state]}`} aria-hidden />
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
      <span className={`size-2 shrink-0 rounded-full ${STATE_DOT[state]}`} aria-hidden />
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

export function IssueLog({
  issues,
  index,
  selected,
  href,
  sort,
  onSort,
  stateWords = true,
}: {
  issues: Issue[];
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

  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const measure = () => {
      const from = Math.max(0, Math.floor(el.scrollTop / ROW) - OVERSCAN);
      const to = Math.min(
        issues.length,
        Math.ceil((el.scrollTop + el.clientHeight) / ROW) + OVERSCAN,
      );
      setRange((r) => (r.from === from && r.to === to ? r : { from, to }));
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [issues.length]);

  // Keep the selected row in view (keyboard j/k, graph clicks).
  useEffect(() => {
    const el = pane.current;
    if (!el || !selected) return;
    const at = issues.findIndex((i) => i.id === selected);
    if (at < 0) return;
    const top = at * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight - 36)
      el.scrollTop = top + ROW - el.clientHeight + 36;
  }, [selected, issues]);

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
      aria-rowcount={issues.length}
    >
      <div
        role="row"
        className={`${grid} sticky top-0 z-[1] h-9 border-b border-line-soft bg-pane text-label text-ink-faint`}
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
      <div className="relative" style={{ height: issues.length * ROW }}>
        {issues.slice(range.from, range.to).map((issue, k) => {
          const i = range.from + k;
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
              <span role="cell" className={`truncate ${closed ? "text-ink-muted" : ""}`}>
                {issue.type === "prd" && (
                  <span className="mk-chip mk-chip--tag mr-1.5 align-[1px]">PRD</span>
                )}
                {issue.title}
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
