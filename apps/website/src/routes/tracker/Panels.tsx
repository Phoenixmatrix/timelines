// Facet counts beside the log, and the board: status lanes, each its own
// virtualized scroll, closed lanes folded to a count until opened.

import { StarIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { Issue } from "../../../shared/tracker.ts";
import { StateDot } from "./Log.tsx";
import { DoneInTimelineIcon } from "./ui.tsx";
import {
  filterToken,
  tokenize,
  withoutKeys,
  type Facets,
  type FacetValue,
  type IssueIndex,
} from "./query.ts";
import { claimAttribution } from "../../../shared/tracker.ts";
import { Actor } from "./Actor.tsx";
import { RequiresMark } from "./Requirements.tsx";

const FACET_GROUPS: { key: keyof Facets; title: string }[] = [
  { key: "state", title: "State" },
  { key: "team", title: "Team" },
  { key: "ws", title: "Workspace" },
  { key: "assignee", title: "Assignee" },
  { key: "type", title: "Type" },
  { key: "label", title: "Label" },
];

/** The team facet's default: which team key is it, and how to change it. */
interface TeamDefault {
  current: string | null;
  onPick: (key: string | null) => void;
}

function FacetGroup({
  title,
  values,
  query,
  onToggle,
  teamDefault,
}: {
  title: string;
  values: FacetValue[];
  query: string;
  onToggle: (v: FacetValue) => void;
  teamDefault?: TeamDefault;
}) {
  const [all, setAll] = useState(false);
  if (values.length === 0) return null;
  const peak = Math.max(1, ...values.map((v) => v.count));
  const tokens = new Set(tokenize(query).map((t) => t.toLowerCase()));
  const shown = all ? values : values.slice(0, 6);
  return (
    <section aria-label={title}>
      <h3 className="m-0 mb-1 text-label text-ink-faint">{title}</h3>
      <ul className="m-0 flex list-none flex-col p-0">
        {shown.map((v) => (
          <li
            key={`${v.token.key}:${v.token.value}`}
            className="group/row flex items-center gap-0.5"
          >
            <button
              type="button"
              className="group relative flex min-h-7 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-plate border-0 bg-transparent px-2 text-left text-body-sm text-ink hover:bg-raised aria-pressed:bg-signal-wash aria-pressed:font-semibold"
              aria-pressed={tokens.has(filterToken(v.token.key, v.token.value).toLowerCase())}
              onClick={() => onToggle(v)}
            >
              <span
                className="absolute inset-x-2 bottom-0.5 h-0.5 origin-left rounded-full bg-line transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-aria-pressed:bg-signal"
                style={{ transform: `scaleX(${v.count / peak})` }}
                aria-hidden
              />
              <span className="relative min-w-0 flex-1 truncate">{v.label}</span>
              <span className="relative font-mono text-mono text-ink-muted tabular-nums">
                {v.count.toLocaleString()}
              </span>
            </button>
            {teamDefault && <DefaultStar value={v} teamDefault={teamDefault} />}
          </li>
        ))}
      </ul>
      {values.length > 6 && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm mt-0.5"
          onClick={() => setAll(!all)}
        >
          {all ? "Fewer" : `${values.length - 6} more`}
        </button>
      )}
    </section>
  );
}

/**
 * Make a team your default in one click. The label says what that does beyond
 * this page: gm and your agents use it when no team is given.
 */
function DefaultStar({ value, teamDefault }: { value: FacetValue; teamDefault: TeamDefault }) {
  const key = String(value.token.value);
  const isDefault = teamDefault.current === key.toLowerCase();
  const label = isDefault
    ? `${value.label} is your default team (also gm's and your agents' when no team is given). Click to clear it.`
    : `Make ${value.label} your default team, here and for gm and your agents when no team is given`;
  return (
    <button
      type="button"
      aria-pressed={isDefault}
      aria-label={label}
      title={label}
      onClick={() => teamDefault.onPick(isDefault ? null : key)}
      className={`grid size-7 shrink-0 cursor-pointer place-items-center rounded-plate border-0 bg-transparent hover:bg-raised hover:text-ink max-sm:size-11 ${
        isDefault
          ? "text-ink-muted"
          : "text-ink-faint opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 max-sm:opacity-100"
      }`}
    >
      <StarIcon weight={isDefault ? "fill" : "regular"} className="size-3.5" aria-hidden />
    </button>
  );
}

export function FacetColumn({
  facets,
  query,
  onToggle,
  defaultTeam,
  onMakeDefault,
}: {
  facets: Facets;
  query: string;
  onToggle: (v: FacetValue) => void;
  /** The default team's key (lowercase), if any. */
  defaultTeam?: string | null;
  onMakeDefault?: (key: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {FACET_GROUPS.map((g) => (
        <FacetGroup
          key={g.key}
          title={g.title}
          values={facets[g.key]}
          query={query}
          onToggle={onToggle}
          teamDefault={
            g.key === "team" && onMakeDefault
              ? { current: defaultTeam ?? null, onPick: onMakeDefault }
              : undefined
          }
        />
      ))}
    </div>
  );
}

// ── Board ───────────────────────────────────────────────────────────────────

const LANES = [
  { value: "backlog", label: "Backlog" },
  { value: "todo", label: "To do" },
  { value: "in_progress", label: "In progress" },
  { value: "done_in_timeline", label: "Done in a timeline" },
  { value: "done", label: "Done" },
  { value: "canceled", label: "Canceled" },
] as const;
const CARD = 64;

function Lane({
  issues,
  index,
  selected,
  href,
}: {
  issues: Issue[];
  index: IssueIndex;
  selected: string | null;
  href: (id: string) => string;
}) {
  const pane = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ from: 0, to: 30 });
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const measure = () => {
      const from = Math.max(0, Math.floor(el.scrollTop / CARD) - 6);
      const to = Math.min(issues.length, Math.ceil((el.scrollTop + el.clientHeight) / CARD) + 6);
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
  return (
    <div ref={pane} className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
      <div className="relative" style={{ height: issues.length * CARD }}>
        {issues.slice(range.from, range.to).map((issue, k) => {
          const i = range.from + k;
          const state = index.state.get(issue.id) ?? "todo";
          return (
            <Link
              key={issue.id}
              to={href(issue.id)}
              aria-current={issue.id === selected ? "true" : undefined}
              className="absolute inset-x-0 flex h-[58px] flex-col justify-center gap-0.5 rounded-control bg-surface px-2.5 text-ink no-underline hover:bg-raised aria-[current=true]:bg-signal-wash"
              style={{ top: i * CARD }}
            >
              <span className="flex items-center gap-1.5 text-micro text-ink-faint">
                <StateDot state={state} />
                <span className="font-mono">{issue.key}</span>
                <span className="font-mono">P{issue.priority}</span>
                {state === "blocked" && (
                  <span className="text-danger-text">
                    Blocked · {index.openBlockers.get(issue.id)?.length}
                  </span>
                )}
                {state === "claimed" && issue.claim && (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    Claimed ·
                    <Actor who={claimAttribution(index.people, issue.claim)} compact />
                  </span>
                )}
                {state === "ready" && <span>Ready</span>}
              </span>
              <span className="truncate text-body-sm font-semibold">
                <RequiresMark requires={issue.requires} />
                {issue.title}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ── Backlog digest ─────────────────────────────────────────────────────────
// A backlog of thousands is groomed, not read card by card: the lane shows
// what it's made of (grouped by priority, team, label or age, with counts),
// how much of it has gone stale, and the most important issues of a group on
// demand, with the full group one click away in the list.

const DAY = 86_400_000;
const AGES = [
  { label: "This week", max: 7, token: "since:7d" },
  { label: "This month", max: 30, token: "since:30d until:7d" },
  { label: "1–3 months", max: 90, token: "since:90d until:30d" },
  { label: "Older", max: Infinity, token: "until:90d" },
] as const;
type GroupBy = "priority" | "team" | "label" | "age";
const GROUP_BY: { value: GroupBy; label: string }[] = [
  { value: "priority", label: "Priority" },
  { value: "team", label: "Team" },
  { value: "label", label: "Label" },
  { value: "age", label: "Age" },
];
const PRIORITY_NAME = ["Urgent", "High", "Medium", "Low", "Lowest"];

function ageDays(issue: Issue, now: number) {
  return (now - Date.parse(issue.updatedAt)) / DAY;
}

function BacklogLane({
  issues,
  index,
  selected,
  href,
  listHref,
  now,
}: {
  issues: Issue[];
  index: IssueIndex;
  selected: string | null;
  href: (id: string) => string;
  /** The list for these backlog issues narrowed by one more filter (or null for no filter). */
  listHref: (token: string | null) => string;
  now: number;
}) {
  const [by, setBy] = useState<GroupBy>("priority");
  // Undefined opens the first group; null keeps every group folded.
  const [open, setOpen] = useState<string | null | undefined>(undefined);
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { label: string; token: string | null; issues: Issue[]; order: number }
    >();
    const add = (key: string, label: string, token: string | null, order: number, issue: Issue) => {
      const g = map.get(key) ?? { label, token, issues: [], order };
      g.issues.push(issue);
      map.set(key, g);
    };
    for (const issue of issues) {
      if (by === "priority")
        add(
          `p${issue.priority}`,
          `P${issue.priority} · ${PRIORITY_NAME[issue.priority]}`,
          `p:${issue.priority}`,
          issue.priority,
          issue,
        );
      else if (by === "team") {
        const key = index.teamKey.get(issue.teamId) ?? "?";
        add(key, key, `team:${key.toLowerCase()}`, 0, issue);
      } else if (by === "label") {
        if (!issue.labels.length) add("", "No label", null, 1e9, issue);
        for (const l of issue.labels) add(l.toLowerCase(), l, `label:${l.toLowerCase()}`, 0, issue);
      } else {
        const days = ageDays(issue, now);
        const at = AGES.findIndex((a) => days < a.max);
        add(String(at), AGES[at]!.label, AGES[at]!.token, at, issue);
      }
    }
    const sorted = [...map.entries()].sort(([, a], [, b]) =>
      by === "priority" || by === "age"
        ? a.order - b.order
        : a.order - b.order || b.issues.length - a.issues.length,
    );
    // Within a group: most important first, then whatever has waited longest.
    for (const [, g] of sorted)
      g.issues.sort((a, b) => a.priority - b.priority || a.updatedAt.localeCompare(b.updatedAt));
    return sorted;
  }, [issues, by, index, now]);
  const peak = Math.max(1, ...groups.map(([, g]) => g.issues.length));
  const stale = issues.filter((i) => ageDays(i, now) >= 90).length;
  const current = open === undefined ? (groups[0]?.[0] ?? null) : open;

  return (
    <section className="flex w-80 shrink-0 flex-col rounded-pane bg-pane" aria-label="Backlog">
      <header className="flex flex-col gap-2 px-3 pt-2 pb-2">
        <h2 className="m-0 flex items-baseline gap-2 text-body-sm font-semibold">
          Backlog
          <span className="font-mono text-mono font-normal text-ink-faint tabular-nums">
            {issues.length.toLocaleString()}
          </span>
          <Link
            className="ml-auto text-micro font-normal text-ink-muted no-underline hover:text-ink"
            to={listHref(null)}
          >
            Open in the list
          </Link>
        </h2>
        {issues.length > 0 && (
          <p className="m-0 text-micro text-ink-muted">
            {stale
              ? `${Math.round((stale / issues.length) * 100)}% untouched for 90+ days`
              : "Everything here moved in the last 90 days"}
          </p>
        )}
        <div
          className="mk-segmented self-start"
          role="radiogroup"
          aria-label="Group the backlog by"
        >
          {GROUP_BY.map((g) => (
            <button
              key={g.value}
              type="button"
              role="radio"
              aria-checked={by === g.value}
              className="mk-segment"
              onClick={() => {
                setBy(g.value);
                setOpen(undefined);
              }}
            >
              {g.label}
            </button>
          ))}
        </div>
      </header>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto [mask-image:linear-gradient(to_bottom,transparent,black_1.75rem)] px-1.5 pt-1 pb-1.5">
        {groups.map(([key, g]) => {
          const expanded = key === current;
          const shown = g.issues.slice(0, 12);
          return (
            <li key={key} className="border-t border-line-soft first:border-t-0">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={(e) => {
                  setOpen(expanded ? null : key);
                  // Bring the opened group's header to the top, so no row sits half cut above it.
                  const header = e.currentTarget;
                  if (!expanded)
                    requestAnimationFrame(() => header.scrollIntoView({ block: "start" }));
                }}
                className="group sticky top-0 z-[1] flex h-9 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-plate border-0 bg-pane px-2 text-left text-body-sm text-ink hover:bg-raised"
              >
                <span
                  className="absolute inset-x-2 bottom-1 h-0.5 origin-left rounded-full bg-line"
                  style={{ transform: `scaleX(${g.issues.length / peak})` }}
                  aria-hidden
                />
                <span className="relative min-w-0 flex-1 truncate">{g.label}</span>
                <span className="relative font-mono text-mono text-ink-muted tabular-nums">
                  {g.issues.length.toLocaleString()}
                </span>
              </button>
              {expanded && (
                <div className="pb-2">
                  <ul className="m-0 list-none p-0">
                    {shown.map((issue) => (
                      <li key={issue.id}>
                        <Link
                          to={href(issue.id)}
                          aria-current={issue.id === selected ? "true" : undefined}
                          className="grid h-8 grid-cols-[3.75rem_minmax(0,1fr)_auto] items-center gap-x-2 rounded-plate px-2 text-body-sm text-ink no-underline hover:bg-raised aria-[current=true]:bg-signal-wash"
                          title={issue.title}
                        >
                          <span className="truncate font-mono text-micro text-ink-faint">
                            {issue.key}
                          </span>
                          <span className="truncate">{issue.title}</span>
                          <span className="text-micro text-ink-faint tabular-nums">
                            {Math.floor(ageDays(issue, now))}d
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  {g.issues.length > shown.length &&
                    (g.token ? (
                      <Link
                        className="ml-2 text-micro text-ink-muted no-underline hover:text-ink"
                        to={listHref(g.token)}
                      >
                        All {g.issues.length.toLocaleString()} in the list
                      </Link>
                    ) : (
                      <p className="m-0 ml-2 text-micro text-ink-faint">
                        {(g.issues.length - shown.length).toLocaleString()} more; filter the list to
                        see them
                      </p>
                    ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function IssueBoard({
  issues,
  index,
  selected,
  href,
  query,
  listHref,
  now,
}: {
  issues: Issue[];
  index: IssueIndex;
  selected: string | null;
  href: (id: string) => string;
  /** The board's query, so a backlog group opens as the same filter in the list. */
  query: string;
  listHref: (q: string) => string;
  now: number;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const byLane = new Map<string, Issue[]>(LANES.map((l) => [l.value, []]));
  for (const issue of issues) byLane.get(issue.status)?.push(issue);
  return (
    <div
      className="flex min-h-0 flex-1 gap-2 overflow-x-auto max-lg:h-[80dvh] max-lg:flex-none"
      role="region"
      aria-label="Board, one lane per status"
    >
      {LANES.map((lane) => {
        const items = byLane.get(lane.value) ?? [];
        // Only trackers with work waiting in timelines need that lane.
        if (lane.value === "done_in_timeline" && items.length === 0) return null;
        if (lane.value === "backlog" && items.length > 0)
          return (
            <BacklogLane
              key="backlog"
              issues={items}
              index={index}
              selected={selected}
              href={href}
              now={now}
              listHref={(token) =>
                listHref(
                  [withoutKeys(query, ["status", "is"]), "status:backlog", token]
                    .filter(Boolean)
                    .join(" "),
                )
              }
            />
          );
        const closed = lane.value === "done" || lane.value === "canceled";
        const folded = (closed && !open.has(lane.value)) || items.length === 0;
        if (folded) {
          return (
            <button
              key={lane.value}
              type="button"
              disabled={items.length === 0}
              onClick={() => setOpen(new Set([...open, lane.value]))}
              className="flex w-11 shrink-0 cursor-pointer flex-col items-center gap-2 rounded-pane border-0 bg-pane py-3 text-ink-muted hover:bg-raised disabled:cursor-default disabled:hover:bg-pane"
              aria-label={`${lane.label}: ${items.length}. Show this lane.`}
            >
              <span className="font-mono text-mono tabular-nums">
                {items.length.toLocaleString()}
              </span>
              <span className="text-body-sm [writing-mode:vertical-rl]">{lane.label}</span>
            </button>
          );
        }
        return (
          <section
            key={lane.value}
            className="flex w-72 shrink-0 flex-col rounded-pane bg-pane"
            aria-label={lane.label}
          >
            <h2 className="m-0 flex items-center gap-2 px-3 py-2 text-body-sm font-semibold">
              {lane.value === "done_in_timeline" && <DoneInTimelineIcon />}
              {lane.label}
              <span className="font-mono text-mono font-normal text-ink-faint tabular-nums">
                {items.length.toLocaleString()}
              </span>
              {lane.value === "todo" && (
                // To do is a queue: what can be picked up now leads, and the split says how much.
                <span className="text-micro font-normal text-ink-muted tabular-nums">
                  {items.filter((i) => index.state.get(i.id) === "ready").length.toLocaleString()}{" "}
                  ready ·{" "}
                  {items.filter((i) => index.state.get(i.id) === "blocked").length.toLocaleString()}{" "}
                  blocked
                </span>
              )}
              {closed && (
                <button
                  type="button"
                  className="mk-btn mk-btn--ghost mk-btn--sm ml-auto"
                  onClick={() => setOpen(new Set([...open].filter((v) => v !== lane.value)))}
                >
                  Fold
                </button>
              )}
            </h2>
            <Lane issues={items} index={index} selected={selected} href={href} />
          </section>
        );
      })}
    </div>
  );
}
