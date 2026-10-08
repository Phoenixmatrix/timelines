// The relationship lens: one issue at the centre, everything it's tied to
// around it, the way people trace work. Blockers fan out to the left, one
// column per step up the chain; what it blocks fans out to the right. Its
// parent trail sits above it, sub-issues and related issues below. Every
// column is a list, so nothing overlaps at any size; connectors only run
// between neighbouring columns, red while a blocker is still open. Clicking a
// card re-centres the lens on it (with a view transition), so you walk the
// graph one hop at a time instead of reading a hairball. With nothing chosen
// it opens on where to start: bottlenecks and the deepest chains.

import { ArrowRightIcon, MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate } from "react-router";
import type { Issue, Snapshot } from "../../../shared/tracker.ts";
import { StateDot, StateLegend } from "./Log.tsx";
import { STATE_LABEL, type IssueIndex, type IssueState } from "./query.ts";
import { attribution } from "../../../shared/tracker.ts";
import { Actor } from "./Actor.tsx";

const PER_COLUMN = 7;

interface Relations {
  /** Every blocks link by direction, done or not. */
  blockers: Map<string, string[]>;
  blocking: Map<string, string[]>;
  related: Map<string, { id: string; kind: "related" | "duplicates" }[]>;
  /** Longest chain of blockers above an issue, and of dependents below it. */
  upDepth: Map<string, number>;
  downDepth: Map<string, number>;
}

function relationsOf(snapshot: Snapshot): Relations {
  const blockers = new Map<string, string[]>();
  const blocking = new Map<string, string[]>();
  const related = new Map<string, { id: string; kind: "related" | "duplicates" }[]>();
  const push = <T,>(map: Map<string, T[]>, key: string, value: T) =>
    map.set(key, [...(map.get(key) ?? []), value]);
  for (const link of snapshot.links) {
    if (link.kind === "blocks") {
      push(blocking, link.fromId, link.toId);
      push(blockers, link.toId, link.fromId);
    } else {
      push(related, link.fromId, { id: link.toId, kind: link.kind });
      push(related, link.toId, { id: link.fromId, kind: link.kind });
    }
  }
  // Longest paths over the blocking DAG (the server refuses cycles): Kahn order
  // forwards gives depth above, the same order backwards gives depth below.
  const indeg = new Map<string, number>();
  for (const [to, from] of blockers) indeg.set(to, from.length);
  const order = snapshot.issues.filter((i) => !indeg.get(i.id)).map((i) => i.id);
  const upDepth = new Map<string, number>();
  for (let q = 0; q < order.length; q++) {
    const id = order[q]!;
    for (const next of blocking.get(id) ?? []) {
      upDepth.set(next, Math.max(upDepth.get(next) ?? 0, (upDepth.get(id) ?? 0) + 1));
      const left = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, left);
      if (left === 0) order.push(next);
    }
  }
  const downDepth = new Map<string, number>();
  for (let q = order.length - 1; q >= 0; q--) {
    const id = order[q]!;
    const below = blocking.get(id) ?? [];
    if (below.length) downDepth.set(id, 1 + Math.max(...below.map((b) => downDepth.get(b) ?? 0)));
  }
  return { blockers, blocking, related, upDepth, downDepth };
}

/** Columns of issues `depth` steps away along one direction, nearest first, each issue once. */
function columnsFrom(
  start: string,
  next: Map<string, string[]>,
  depth: number,
  seen: Set<string>,
): string[][] {
  const columns: string[][] = [];
  let frontier = [start];
  for (let d = 0; d < depth; d++) {
    const column: string[] = [];
    for (const id of frontier)
      for (const n of next.get(id) ?? [])
        if (!seen.has(n)) {
          seen.add(n);
          column.push(n);
        }
    if (!column.length) break;
    columns.push(column);
    frontier = column;
  }
  return columns;
}

const RANK: Record<IssueState, number> = {
  waiting: 0,
  blocked: 1,
  claimed: 2,
  leased: 3,
  in_progress: 4,
  ready: 5,
  todo: 6,
  container: 6,
  human_only: 6,
  not_ready: 7,
  backlog: 7,
  done_in_timeline: 8,
  done: 9,
  canceled: 10,
};

function Card({
  issue,
  index,
  to,
  outside,
  transition,
  meta,
  col,
}: {
  issue: Issue;
  index: IssueIndex;
  to: string;
  /** Not matched by the current query: shown, but quieter. */
  outside: boolean;
  /** Carries the view-transition name, so this card glides when the lens moves. */
  transition: boolean;
  meta?: string;
  /** Lens column (blockers negative, dependents positive); connectors join neighbours. */
  col?: number;
}) {
  const state = index.state.get(issue.id) ?? "todo";
  const closed = state === "done" || state === "canceled";
  return (
    <Link
      to={to}
      viewTransition
      preventScrollReset
      data-lens={issue.id}
      data-col={col}
      title={`${issue.key} · ${STATE_LABEL[state]}${outside ? " · outside the current filter" : ""}`}
      className={`flex flex-col gap-0.5 rounded-control bg-raised px-3 py-2 text-ink no-underline hover:bg-surface focus-visible:bg-surface ${outside ? "opacity-60" : ""}`}
      style={transition ? { viewTransitionName: `lens-${issue.id}` } : undefined}
    >
      <span className="flex items-center gap-1.5 text-micro text-ink-faint">
        <StateDot state={state} />
        <span className="font-mono">{issue.key}</span>
        <span className="sr-only">{STATE_LABEL[state]}</span>
        {meta && <span className="ml-auto truncate">{meta}</span>}
      </span>
      <span className={`line-clamp-2 text-body-sm ${closed ? "text-ink-muted" : ""}`}>
        {issue.title}
      </span>
    </Link>
  );
}

function Column({
  title,
  ids,
  side,
  render,
}: {
  title: string;
  ids: string[];
  side: "up" | "down";
  render: (id: string) => React.ReactNode;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? ids : ids.slice(0, PER_COLUMN);
  return (
    <section aria-label={title} data-side={side} className="flex min-w-0 flex-col gap-2">
      <h3 className="m-0 flex items-baseline gap-2 text-label text-ink-faint">
        {title}
        <span className="font-mono tabular-nums">{ids.length || ""}</span>
      </h3>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {shown.map((id) => (
          <li key={id}>{render(id)}</li>
        ))}
      </ul>
      {ids.length > PER_COLUMN && (
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--sm self-start"
          onClick={() => setAll(!all)}
        >
          {all ? "Fewer" : `${ids.length - PER_COLUMN} more`}
        </button>
      )}
    </section>
  );
}

const UP_TITLES = ["Blocked by", "Which waits on", "Further up"];
const DOWN_TITLES = ["Blocks", "Which then frees", "Further down"];

export function RelationLens({
  focus,
  snapshot,
  index,
  matched,
  href,
  listHref,
  onDetails,
  detailsOpen,
}: {
  focus: Issue | null;
  snapshot: Snapshot;
  index: IssueIndex;
  /** Issues the current query matches; others still appear, dimmed. */
  matched: Issue[];
  href: (id?: string) => string;
  /** The list view for a query, to read everything a column holds. */
  listHref: (q: string) => string;
  onDetails: () => void;
  detailsOpen: boolean;
}) {
  const relations = useMemo(() => relationsOf(snapshot), [snapshot]);
  const inQuery = useMemo(() => new Set(matched.map((i) => i.id)), [matched]);
  const [depthChoice, setDepthChoice] = useState(2);
  const [trail, setTrail] = useState<string[]>([]);
  const lastFocus = useRef<string | null>(null);
  if (focus && lastFocus.current !== focus.id) {
    lastFocus.current = focus.id;
    // Remember the walk; stepping back to an issue on the trail cuts it there.
    const at = trail.indexOf(focus.id);
    setTrail(at >= 0 ? trail.slice(0, at + 1) : [...trail, focus.id].slice(-8));
  }

  // How many steps fit side by side without squeezing a card.
  const box = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(2);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    // The centre takes 21rem; each step needs a column of at least 11rem plus a 3rem gutter.
    const measure = () => setFit(Math.max(1, Math.floor((el.clientWidth - 32 - 336) / (2 * 224))));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [focus]);
  const depth = Math.min(depthChoice, fit, 3);

  if (!focus)
    return (
      <StartHere
        snapshot={snapshot}
        index={index}
        matched={matched}
        relations={relations}
        href={href}
      />
    );

  const issue = (id: string) => index.byId.get(id);
  const seen = new Set([focus.id]);
  const byRank = (ids: string[]) =>
    ids
      .filter((id) => issue(id))
      .sort(
        (a, b) =>
          RANK[index.state.get(a) ?? "todo"] - RANK[index.state.get(b) ?? "todo"] ||
          issue(a)!.priority - issue(b)!.priority,
      );
  const up = columnsFrom(focus.id, relations.blockers, depth, seen).map(byRank);
  const down = columnsFrom(focus.id, relations.blocking, depth, seen).map(byRank);
  const ancestors: Issue[] = [];
  for (
    let p = focus.parentId ? issue(focus.parentId) : undefined;
    p && ancestors.length < 4;
    p = p.parentId ? issue(p.parentId) : undefined
  )
    ancestors.unshift(p);
  const children = byRank(index.children.get(focus.id) ?? []);
  const doneChildren = children.filter((id) => issue(id)!.status === "done").length;
  const related = (relations.related.get(focus.id) ?? []).filter((r) => issue(r.id));
  const openBlockers = (relations.blockers.get(focus.id) ?? []).filter(
    (id) => issue(id)?.status !== "done",
  );
  const state = index.state.get(focus.id) ?? "todo";
  // Each issue carries its view-transition name once, so it can glide when the lens moves.
  const named = new Set<string>([focus.id]);
  const claim = (id: string) => {
    if (named.has(id)) return false;
    named.add(id);
    return true;
  };
  const card = (id: string, col?: number, meta?: string) => (
    <Card
      issue={issue(id)!}
      index={index}
      to={href(id)}
      outside={!inQuery.has(id)}
      transition={claim(id)}
      meta={meta}
      col={col}
    />
  );
  // Only occupied steps take space; dependency direction doesn't need empty columns.
  const upCols = up.toReversed();

  return (
    <section
      aria-label={`Relationships of ${focus.key}`}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-pane bg-pane max-lg:h-auto max-lg:flex-none"
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-3 py-1.5 text-body-sm text-ink-muted">
        <nav
          aria-label="Trail"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none]"
        >
          {trail.map((id, n) => {
            const it = issue(id);
            if (!it) return null;
            const here = id === focus.id;
            return (
              <span key={id} className="flex shrink-0 items-center gap-1">
                {n > 0 && <ArrowRightIcon className="size-3 text-ink-faint" aria-hidden />}
                {here ? (
                  <span aria-current="location" className="font-mono text-mono text-ink">
                    {it.key}
                  </span>
                ) : (
                  <Link
                    viewTransition
                    preventScrollReset
                    to={href(id)}
                    className="font-mono text-mono text-ink-muted no-underline hover:text-ink"
                  >
                    {it.key}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
        <div className="flex items-center gap-2">
          <span className="text-micro text-ink-faint" id="lens-steps">
            Steps each way
          </span>
          <div className="mk-segmented" role="radiogroup" aria-labelledby="lens-steps">
            {[1, 2, 3].map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={depth === d}
                disabled={d > fit}
                title={d > fit ? "Widen the window to show more steps" : undefined}
                className="mk-segment min-w-9 whitespace-nowrap"
                onClick={() => setDepthChoice(d)}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-1">
          <StateLegend />
          <ul className="mk-legend gap-x-3 text-micro max-md:hidden">
            <li>
              <span className="mk-key mk-key--line bg-danger-text" />
              Still blocking
            </li>
            <li>
              <span className="mk-key mk-key--line bg-line" />
              Resolved
            </li>
          </ul>
        </div>
      </header>
      <div
        ref={box}
        tabIndex={-1}
        className="relative min-h-0 flex-1 overflow-auto p-4 outline-none"
        onKeyDown={(e: KeyboardEvent) => {
          const go = (id: string | undefined) => {
            if (!id) return;
            e.preventDefault();
            (box.current?.querySelector(`[data-lens="${id}"]`) as HTMLElement | null)?.click();
          };
          if (e.target !== e.currentTarget) return;
          if (e.key === "ArrowLeft") go(up[0]?.[0]);
          else if (e.key === "ArrowRight") go(down[0]?.[0]);
          else if (e.key === "ArrowUp") go(ancestors.at(-1)?.id);
          else if (e.key === "ArrowDown") go(children[0]);
        }}
      >
        <Connectors focus={focus.id} relations={relations} index={index} depth={depth} />
        <div
          className="relative grid grid-cols-1 items-start gap-y-6 md:justify-start md:[grid-template-columns:var(--lens-columns)] md:gap-x-12"
          style={
            {
              "--lens-columns": [
                ...up.map(() => "minmax(11rem, 18rem)"),
                "minmax(15rem, 24rem)",
                ...down.map(() => "minmax(11rem, 18rem)"),
              ].join(" "),
            } as React.CSSProperties
          }
        >
          {upCols.map((ids, n) => {
            const d = upCols.length - 1 - n;
            return (
              <Column
                key={`u${d}`}
                side="up"
                title={UP_TITLES[d]!}
                ids={ids}
                render={(id) => card(id, -(d + 1))}
              />
            );
          })}
          <div className="flex min-w-0 flex-col gap-3 max-md:order-first">
            {ancestors.length > 0 && (
              <nav aria-label="Parent issues" className="flex flex-col gap-1">
                <h3 className="m-0 text-label text-ink-faint">Parent</h3>
                {ancestors.map((a, n) => (
                  <Link
                    key={a.id}
                    to={href(a.id)}
                    viewTransition
                    preventScrollReset
                    data-lens={a.id}
                    className="flex min-w-0 items-baseline gap-2 text-body-sm text-ink-muted no-underline hover:text-ink"
                    style={{
                      paddingLeft: `${n * 0.75}rem`,
                      ...(claim(a.id) ? { viewTransitionName: `lens-${a.id}` } : {}),
                    }}
                  >
                    <span className="shrink-0 font-mono text-micro text-ink-faint">{a.key}</span>
                    <span className="truncate">{a.title}</span>
                  </Link>
                ))}
              </nav>
            )}
            <article
              data-lens={focus.id}
              data-col={0}
              className="flex flex-col gap-2 rounded-control bg-raised p-4 ring-2 ring-signal-line"
              style={{ viewTransitionName: `lens-${focus.id}` }}
            >
              <span className="flex items-center gap-2 text-micro text-ink-muted">
                <StateDot state={state} />
                <span className="font-mono text-ink">{focus.key}</span>
                {STATE_LABEL[state]}
                {state === "blocked" && ` by ${openBlockers.length}`}
                <span className="ml-auto font-mono">P{focus.priority}</span>
              </span>
              <h2 className="m-0 text-title break-words">{focus.title}</h2>
              <p className="m-0 text-body-sm text-ink-muted">
                {index.teamKey.get(focus.teamId)} ·{" "}
                {focus.assigneeId ? (
                  <Actor who={attribution(index.people, focus.assigneeId)} />
                ) : (
                  "Unassigned"
                )}
                {(relations.upDepth.get(focus.id) ?? 0) > 1 &&
                  ` · ${relations.upDepth.get(focus.id)} blockers deep`}
              </p>
              {!detailsOpen && (
                <button type="button" className="mk-btn mk-btn--sm self-start" onClick={onDetails}>
                  Details
                </button>
              )}
            </article>
            {up.length === 0 && (
              <p className="m-0 text-body-sm text-ink-faint">Nothing blocks this.</p>
            )}
            {down.length === 0 && (
              <p className="m-0 text-body-sm text-ink-faint">Blocks nothing.</p>
            )}
            {children.length > 0 && (
              <section aria-label="Sub-issues" className="flex flex-col gap-2">
                <h3 className="m-0 flex items-center gap-2 text-label text-ink-faint">
                  Sub-issues
                  <span className="font-mono tabular-nums">
                    {doneChildren}/{children.length}
                  </span>
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-sunken" aria-hidden>
                    <span
                      className="block h-full rounded-full bg-online"
                      style={{ width: `${(doneChildren / children.length) * 100}%` }}
                    />
                  </span>
                </h3>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {children.slice(0, PER_COLUMN).map((id) => (
                    <li key={id}>{card(id)}</li>
                  ))}
                </ul>
                {children.length > PER_COLUMN && (
                  <p className="m-0 text-micro text-ink-faint">
                    {children.length - PER_COLUMN} more in the{" "}
                    <Link className="text-ink-muted" to={listHref(`parent:${focus.key}`)}>
                      list
                    </Link>
                  </p>
                )}
              </section>
            )}
            {related.length > 0 && (
              <section aria-label="Related" className="flex flex-col gap-2">
                <h3 className="m-0 text-label text-ink-faint">Related</h3>
                <ul className="m-0 flex list-none flex-col gap-2 p-0">
                  {related.slice(0, PER_COLUMN).map((r) => (
                    <li key={r.id}>
                      {card(r.id, undefined, r.kind === "duplicates" ? "Duplicate" : undefined)}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          {down.map((ids, d) => (
            <Column
              key={`d${d}`}
              side="down"
              title={DOWN_TITLES[d]!}
              ids={ids}
              render={(id) => card(id, d + 1)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

/** SVG connectors between neighbouring columns, measured from the rendered cards. */
function Connectors({
  focus,
  relations,
  index,
  depth,
}: {
  focus: string;
  relations: Relations;
  index: IssueIndex;
  depth: number;
}) {
  const [paths, setPaths] = useState<
    { d: string; open: boolean; key: string; from: string; to: string }[]
  >([]);
  // Measured from the SVG's own parent: a parent's ref isn't attached yet
  // when a child's layout effect first runs.
  const svg = useRef<SVGSVGElement>(null);
  // Hovering a card keeps its own connections bright and lets the rest recede.
  const [hovered, setHovered] = useState<string | null>(null);
  useLayoutEffect(() => {
    const el = svg.current?.parentElement;
    if (!el) return;
    const over = (e: PointerEvent) =>
      setHovered(
        (e.target as HTMLElement).closest<HTMLElement>("[data-col]")?.dataset.lens ?? null,
      );
    const out = () => setHovered(null);
    el.addEventListener("pointerover", over);
    el.addEventListener("pointerleave", out);
    return () => {
      el.removeEventListener("pointerover", over);
      el.removeEventListener("pointerleave", out);
    };
  }, []);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = svg.current?.parentElement;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth < 768) return setPaths([]);
      const origin = el.getBoundingClientRect();
      const rects = new Map<string, { rect: DOMRect; col: number }>();
      for (const node of el.querySelectorAll<HTMLElement>("[data-col]"))
        rects.set(node.dataset.lens!, {
          rect: node.getBoundingClientRect(),
          col: Number(node.dataset.col),
        });
      const next: typeof paths = [];
      for (const [to, froms] of relations.blockers) {
        const target = rects.get(to);
        if (!target) continue;
        const b = target.rect;
        for (const from of froms) {
          const source = rects.get(from);
          // Only neighbours: a blocker sits one column left of what it blocks.
          if (!source || target.col - source.col !== 1) continue;
          const a = source.rect;
          const x0 = a.right - origin.left + el.scrollLeft;
          const y0 = a.top + a.height / 2 - origin.top + el.scrollTop;
          const x1 = b.left - origin.left + el.scrollLeft;
          const y1 = (to === focus ? b.top + 28 : b.top + b.height / 2) - origin.top + el.scrollTop;
          const mid = (x0 + x1) / 2;
          next.push({
            key: `${from}>${to}`,
            from,
            to,
            open: index.byId.get(from)?.status !== "done",
            d: `M${x0},${y0} C${mid},${y0} ${mid},${y1} ${x1 - 4},${y1}`,
          });
        }
      }
      setPaths(next);
      setSize({ w: el.scrollWidth, h: el.scrollHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild?.nextElementSibling)
      observer.observe(el.firstElementChild.nextElementSibling);
    return () => observer.disconnect();
    // Live edits can move cards without resizing the grid or changing focus.
  }, [focus, relations, index, depth]);
  return (
    <svg
      ref={svg}
      aria-hidden
      className="pointer-events-none absolute top-0 left-0 max-md:hidden"
      width={size.w}
      height={size.h}
    >
      <defs>
        <marker
          id="lens-arrow-open"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--danger-text)" />
        </marker>
        <marker
          id="lens-arrow-done"
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="7"
          markerHeight="7"
          orient="auto"
        >
          <path d="M0,0 L8,4 L0,8 z" fill="var(--line)" />
        </marker>
      </defs>
      {paths.map((p) => (
        <path
          key={p.key}
          d={p.d}
          fill="none"
          stroke={p.open ? "var(--danger-text)" : "var(--line)"}
          strokeOpacity={
            hovered && p.from !== hovered && p.to !== hovered ? 0.15 : p.open ? 0.8 : 1
          }
          className="transition-[stroke-opacity] duration-150"
          strokeWidth={1.5}
          markerEnd={`url(#lens-arrow-${p.open ? "open" : "done"})`}
        />
      ))}
    </svg>
  );
}

/** Where to start when nothing is chosen: find an issue, or begin at a bottleneck. */
function StartHere({
  snapshot,
  index,
  matched,
  relations,
  href,
}: {
  snapshot: Snapshot;
  index: IssueIndex;
  matched: Issue[];
  relations: Relations;
  href: (id?: string) => string;
}) {
  const navigate = useNavigate();
  const [term, setTerm] = useState("");
  const t = term.trim().toLowerCase();
  const found = useMemo(() => {
    if (t.length < 2) return [];
    const out: Issue[] = [];
    for (const i of snapshot.issues) {
      if (i.key.toLowerCase().startsWith(t) || i.title.toLowerCase().includes(t)) out.push(i);
      if (out.length >= 8) break;
    }
    return out;
  }, [snapshot.issues, t]);
  const open = matched.filter((i) => i.status !== "done" && i.status !== "canceled");
  const openDependents = (i: Issue) =>
    (relations.blocking.get(i.id) ?? []).filter((d) => {
      const s = index.byId.get(d)?.status;
      return s !== "done" && s !== "canceled";
    }).length;
  const bottlenecks = open
    .map((i) => ({ i, n: openDependents(i), deep: relations.downDepth.get(i.id) ?? 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || b.deep - a.deep)
    .slice(0, 8);
  const deepest = open
    .map((i) => ({ i, deep: relations.upDepth.get(i.id) ?? 0 }))
    .filter((x) => x.deep > 1)
    .sort((a, b) => b.deep - a.deep || a.i.priority - b.i.priority)
    .slice(0, 8);
  const row = (i: Issue, meta: string) => {
    const state = index.state.get(i.id) ?? "todo";
    return (
      <li key={i.id}>
        <Link
          to={href(i.id)}
          viewTransition
          preventScrollReset
          className="grid h-9 grid-cols-[0.5rem_5rem_minmax(0,1fr)_auto] items-center gap-x-3 rounded-plate px-2 text-body-sm text-ink no-underline hover:bg-raised"
        >
          <StateDot state={state} />
          <span className="font-mono text-mono text-ink-faint">{i.key}</span>
          <span className="truncate">{i.title}</span>
          <span className="text-micro text-ink-faint tabular-nums">{meta}</span>
        </Link>
      </li>
    );
  };
  return (
    <section
      aria-label="Start from an issue"
      className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto rounded-pane bg-pane p-4 max-lg:flex-none"
    >
      <div className="flex max-w-[40rem] flex-col gap-2">
        <h2 className="m-0 text-title">Start from an issue</h2>
        <p className="m-0 max-w-[48ch] text-body-sm text-ink-muted">
          Pick an issue to see what blocks it, what it blocks, its parent and its sub-issues. Click
          any of them to move there.
        </p>
        <StateLegend />
        <form
          role="search"
          className="relative mt-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (found[0])
              void navigate(href(found[0].id), { viewTransition: true, preventScrollReset: true });
          }}
        >
          <MagnifyingGlassIcon
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <input
            className="mk-input w-full pl-9"
            aria-label="Find an issue by key or title"
            placeholder="CORE-236 or a few words of the title"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
          />
        </form>
        {found.length > 0 && <ul className="m-0 list-none p-0">{found.map((i) => row(i, ""))}</ul>}
      </div>
      <div className="grid gap-6 xl:grid-cols-2">
        <section aria-label="Bottlenecks" className="min-w-0">
          <h3 className="m-0 mb-1 text-body-sm font-semibold">Bottlenecks</h3>
          <p className="m-0 mb-2 text-micro text-ink-faint">
            Open issues holding up the most open work.
          </p>
          {bottlenecks.length ? (
            <ul className="m-0 list-none p-0">
              {bottlenecks.map((x) =>
                row(x.i, `blocks ${x.n}${x.deep > 1 ? ` · ${x.deep} deep` : ""}`),
              )}
            </ul>
          ) : (
            <p className="m-0 text-body-sm text-ink-muted">
              Nothing in this filter blocks open work.
            </p>
          )}
        </section>
        <section aria-label="Deepest chains" className="min-w-0">
          <h3 className="m-0 mb-1 text-body-sm font-semibold">Furthest from ready</h3>
          <p className="m-0 mb-2 text-micro text-ink-faint">
            Open issues behind the longest chains of blockers.
          </p>
          {deepest.length ? (
            <ul className="m-0 list-none p-0">
              {deepest.map((x) => row(x.i, `${x.deep} blockers deep`))}
            </ul>
          ) : (
            <p className="m-0 text-body-sm text-ink-muted">
              No chains longer than one step in this filter.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
