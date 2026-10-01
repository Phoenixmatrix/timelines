/*
 * DIRECTION (impeccable, locked: query-console, seed 19983661)
 *
 * THESIS       Versions are data. A package that publishes on every commit is
 *              read the way a log explorer reads events: one query over the
 *              whole stream, counts beside it, act on what the query selects.
 * OWN-WORLD    MatrixKit Neo, incumbent: warm charcoal panes, one amber signal,
 *              Figtree for words, Geist Mono for versions, hashes and counts.
 * STORY        Find what a change built (source, branch, commit, run on every
 *              row) → trust it (who published, from where, what's tagged) →
 *              clean up (select by query, delete or yank in bulk) → wire it up
 *              (sources, feeds, proxies).
 * FIRST VIEW   Package, format and the pull command; the query bar with saved
 *              views; the publish-rate strip; the version table; facet counts
 *              (source, branch, status) on the right.
 * FORM         query-console: query bar + saved views over a publish-rate
 *              strip over a virtualized table, facets in a side column, a
 *              selection bar for bulk actions.
 * FINISH       Tabular numerals everywhere a number lines up; the rate strip
 *              is the one authored moment (brush a bar to scope the query);
 *              amber only for what's selected or active.
 */

import {
  FunnelSimpleIcon,
  GitBranchIcon,
  GitCommitIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TagIcon,
  TrashIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { Popover } from "@base-ui/react/popover";
import {
  Link,
  useLoaderData,
  useRevalidator,
  useSearchParams,
  type LoaderFunctionArgs,
} from "react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_QUERY,
  filterToken,
  parseQuery,
  toggleFilter,
  tokenize,
  type BulkActionKind,
  type BulkActionResult,
  type Facet,
  type Histogram,
  type PackageDetail,
  type PackageSource,
  type PublishPage,
  type PublishRow,
  type QueryKey,
} from "../../../shared/packages.ts";
import { Page } from "../../components/AppShell.tsx";
import {
  ConfirmDialog,
  CopyField,
  link,
  popMotion,
  quietLink,
  Tip,
  useToast,
} from "../../components/ui.tsx";
import { ApiError, api } from "../../lib/api.ts";
import { bytes, fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import {
  count,
  formatLabel,
  installCommand,
  packageApi,
  packagesPath,
  plural,
} from "../../lib/packages.ts";
import { repoPath, treeUrl } from "../../lib/refs.ts";
import { load } from "../../lib/api.ts";
import type { FormatId } from "@gitmatrix/formats/info";

const PAGE = 100;

// The version table's grid. Desktop: one line per row. Phones: two lines,
// version and age, then source, branch and run.
const ROW =
  "grid items-center gap-x-2.5 border-b border-line-soft pr-3.5 pl-2 " +
  "grid-cols-[36px_minmax(10rem,2fr)_minmax(4.5rem,0.7fr)_5.75rem_minmax(8.5rem,1.3fr)_3.5rem_6.5rem] " +
  "max-md:grid-cols-[28px_auto_minmax(0,1fr)_auto] max-md:grid-rows-[auto_auto] max-md:content-center " +
  "max-md:gap-x-2 max-md:gap-y-0.5 max-md:pr-3 max-md:pl-1.5";
const CELL = "flex min-w-0 items-center gap-1.5";
const CELLS = {
  check: `${CELL} justify-center max-md:col-start-1 max-md:row-span-2 max-md:row-start-1`,
  version: `${CELL} max-md:col-[2/4] max-md:row-start-1`,
  source: `${CELL} max-md:col-start-2 max-md:row-start-2 max-md:max-w-36 max-md:text-mono`,
  commit: `${CELL} max-md:hidden`,
  branch: `${CELL} text-ink-muted max-md:col-start-3 max-md:row-start-2 max-md:text-mono`,
  run: `${CELL} justify-end text-ink-muted tabular-nums whitespace-nowrap max-md:col-start-4 max-md:row-start-2 max-md:text-mono`,
  age: `${CELL} justify-end text-ink-muted tabular-nums whitespace-nowrap max-md:col-start-4 max-md:row-start-1`,
};
const CHECKBOX = "m-0 size-4 cursor-pointer accent-signal";

export async function packageConsoleLoader({ request, params }: LoaderFunctionArgs) {
  const owner = params.owner ?? "";
  const format = params.format as FormatId;
  const name = params["*"] ?? "";
  const query = new URL(request.url).searchParams.get("q") ?? DEFAULT_QUERY;
  const base = packageApi(owner, format, name);
  const detail = load<PackageDetail>(base, request);
  // Awaited below; an abort mid-navigation mustn't surface as unhandled first.
  detail.catch(() => undefined);
  let page: PublishPage | null = null;
  let error: string | null = null;
  try {
    page = await api<PublishPage>(
      `${base}/publishes?q=${encodeURIComponent(query)}&limit=${PAGE}`,
      { signal: request.signal },
    );
  } catch (e) {
    // A query that doesn't parse keeps the page, and says why.
    if (e instanceof ApiError && e.status === 400) error = e.message;
    else throw e;
  }
  return { detail: await detail, page, error, query, base };
}

type LoaderData = Awaited<ReturnType<typeof packageConsoleLoader>>;

// ── Query bar and saved views ──────────────────────────────────────────────

const VIEWS: { label: string; query: string }[] = [
  { label: "Active", query: DEFAULT_QUERY },
  { label: "Last 24 hours", query: "since:24h" },
  { label: "From main", query: "branch:main status:active" },
  { label: "By hand", query: "source:none" },
  { label: "Retired", query: "-status:active" },
  { label: "Everything", query: "" },
];

function QueryBar({
  query,
  onQuery,
  error,
}: {
  query: string;
  onQuery: (q: string) => void;
  error: string | null;
}) {
  const [draft, setDraft] = useState(query);
  useEffect(() => setDraft(query), [query]);
  const submit = (event: { preventDefault(): void }) => {
    event.preventDefault();
    onQuery(draft.trim());
  };
  const parsed = useMemo(() => parseQuery(draft), [draft]);
  return (
    <div className="flex flex-col gap-2">
      <form onSubmit={submit} role="search" className="relative flex items-center gap-2">
        <MagnifyingGlassIcon
          className="pointer-events-none absolute left-3.5 size-4 text-ink-faint"
          aria-hidden
        />
        <input
          className="mk-input mk-input--code h-11 min-w-0 flex-1 pl-10 sm:text-body"
          value={draft}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setDraft(query);
          }}
          placeholder="source:web branch:main since:24h 1.4"
          aria-label="Filter versions"
          aria-invalid={error ? "true" : undefined}
          aria-describedby="gm-query-help"
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
        />
        {draft !== query && (
          <button type="submit" className="mk-btn mk-btn--sm mk-btn--primary absolute right-1.5">
            Run
          </button>
        )}
      </form>
      <p
        id="gm-query-help"
        className={`m-0 text-body-sm ${error ? "text-danger-text" : "text-ink-faint"}`}
      >
        {error ??
          (parsed.unknown.length
            ? `${parsed.unknown[0]} isn't a filter. Try source:, branch:, status:, since:, until:, commit:, run:, by: or tag:.`
            : "Filter with source:, branch:, status:, since:7d, commit:, run:, by:, tag:. Words match versions; - excludes.")}
      </p>
    </div>
  );
}

function SavedViews({ query, onQuery }: { query: string; onQuery: (q: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Saved views">
      {VIEWS.map((view) => (
        <button
          key={view.label}
          type="button"
          className="mk-chip"
          aria-pressed={query.trim() === view.query}
          onClick={() => onQuery(view.query)}
        >
          {view.label}
        </button>
      ))}
    </div>
  );
}

// ── Publish-rate strip ─────────────────────────────────────────────────────

function bucketLabel(start: number, ms: number): string {
  const from = new Date(start);
  const day = ms >= 86_400_000;
  const opts: Intl.DateTimeFormatOptions = day
    ? { month: "short", day: "numeric" }
    : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return from.toLocaleString("en", opts);
}

function span(ms: number): string {
  if (ms >= 86_400_000) return ms === 86_400_000 ? "day" : `${ms / 86_400_000} days`;
  if (ms >= 3_600_000) return ms === 3_600_000 ? "hour" : `${ms / 3_600_000} hours`;
  return `${ms / 60_000} minutes`;
}

/** `2026-09-22T08:00Z`: minutes are as fine as a bucket gets. */
function isoMinute(date: Date): string {
  return `${date.toISOString().slice(0, 16)}Z`;
}

function withRange(query: string, since: Date, until: Date): string {
  const kept = tokenize(query).filter((t) => !/^-?(since|until):/i.test(t));
  return [
    ...kept,
    filterToken("since", isoMinute(since)),
    filterToken("until", isoMinute(until)),
  ].join(" ");
}

/** Day boundaries inside the range, at most `max` of them, for axis ticks. */
function dayTicks(start: number, bucketMs: number, buckets: number, max = 8) {
  const end = start + buckets * bucketMs;
  const ticks: { at: number; label: string }[] = [];
  const day = new Date(start);
  day.setHours(24, 0, 0, 0);
  for (let t = day.getTime(); t < end; t += 86_400_000) {
    ticks.push({
      at: (t - start) / (end - start),
      label: new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" }),
    });
  }
  const step = Math.ceil(ticks.length / max);
  return ticks.filter((_, k) => k % step === 0);
}

/** "Sep 22 → Sep 28, 12 PM" for a query's since:/until:, when both are set. */
function scopedRange(query: string): string | null {
  const parsed = parseQuery(query).filters.filter((f) => !f.negated);
  const since = parsed.find((f) => f.key === "since");
  const until = parsed.find((f) => f.key === "until");
  if (!since || !until) return null;
  const at = (v: string) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return v;
    const midnight = d.getHours() === 0 && d.getMinutes() === 0;
    return d.toLocaleString("en", {
      month: "short",
      day: "numeric",
      ...(midnight ? {} : { hour: "numeric", minute: d.getMinutes() ? "2-digit" : undefined }),
    });
  };
  return `${at(since.value)} → ${at(until.value)}`;
}

function RateStrip({
  histogram,
  total,
  query,
  onQuery,
}: {
  histogram: Histogram;
  total: number;
  query: string;
  onQuery: (q: string) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  // Brushing: press on a bar, drag across others, release to scope the query.
  const [brush, setBrushState] = useState<{ from: number; to: number } | null>(null);
  const brushRef = useRef(brush);
  const setBrush = (next: { from: number; to: number } | null) => {
    brushRef.current = next;
    setBrushState(next);
  };
  const dragging = useRef(false);
  const start = Date.parse(histogram.start);
  const ms = histogram.bucketMs;
  const sums = histogram.active.map((a, i) => a + (histogram.removed[i] ?? 0));
  const peak = Math.max(1, ...sums);
  const lo = brush ? Math.min(brush.from, brush.to) : -1;
  const hi = brush ? Math.max(brush.from, brush.to) : -1;
  const strip = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 600));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const release = () => {
      if (!dragging.current) return;
      dragging.current = false;
      const current = brushRef.current;
      brushRef.current = null;
      setBrushState(null);
      if (!current) return;
      const a = Math.min(current.from, current.to);
      const b = Math.max(current.from, current.to);
      if (sums.slice(a, b + 1).some((n) => n > 0)) {
        onQuery(withRange(query, new Date(start + a * ms), new Date(start + (b + 1) * ms)));
      }
    };
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, [onQuery, query, start, ms, sums]);

  const brushed = brush ? sums.slice(lo, hi + 1).reduce((x, y) => x + y, 0) : 0;
  const caption = brush
    ? `${bucketLabel(start + lo * ms, ms)} → ${bucketLabel(start + (hi + 1) * ms, ms)} · ${plural(brushed, "publish", "publishes")}. Release to show them.`
    : hover !== null
      ? `${bucketLabel(start + hover * ms, ms)} · ${plural(sums[hover] ?? 0, "publish", "publishes")}${
          histogram.removed[hover] ? `, ${count(histogram.removed[hover] ?? 0)} retired since` : ""
        }`
      : `${plural(total, "publish", "publishes")} · busiest ${span(ms)}: ${count(peak)}`;
  const end = start + sums.length * ms;
  const endLabel = end < Date.now() - ms ? bucketLabel(end, ms) : "Now";
  // Room for a date label every ~72px, none running into the end label
  // (about 6.5px per character at this size).
  const ticks =
    ms < 86_400_000
      ? dayTicks(start, ms, sums.length, Math.max(2, Math.floor(width / 72))).filter(
          (t) => t.at * width < width - (endLabel.length * 6.5 + 56),
        )
      : [];
  const range = scopedRange(query);

  return (
    <section
      ref={strip}
      aria-label="Publish rate"
      className="flex flex-col gap-1.5 rounded-pane bg-pane px-3.5 pt-3 pb-2.5"
    >
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p
          className="m-0 min-w-48 flex-1 text-body-sm text-ink-muted tabular-nums"
          aria-live="polite"
        >
          {caption}
          {!brush && hover === null && (
            <span className="max-sm:hidden"> · drag across the bars to zoom in</span>
          )}
        </p>
        {range && (
          <button
            type="button"
            className="mk-btn mk-btn--ghost mk-btn--sm"
            onClick={() =>
              onQuery(
                tokenize(query)
                  .filter((t) => !/^-?(since|until):/i.test(t))
                  .join(" "),
              )
            }
          >
            <span className="tabular-nums">{range}</span>
            <XIcon weight="bold" aria-hidden />
            <span className="sr-only">Show the whole range</span>
          </button>
        )}
      </div>
      <div
        className="flex h-16 touch-none items-end gap-0.5 select-none"
        data-brushing={brush ? "" : undefined}
        onMouseLeave={() => setHover(null)}
      >
        {sums.map((n, i) => {
          const active = histogram.active[i] ?? 0;
          const removed = histogram.removed[i] ?? 0;
          const from = new Date(start + i * ms);
          return (
            <button
              key={i}
              type="button"
              className="group/bar flex h-full min-w-0.5 flex-1 basis-0 cursor-pointer items-end rounded-[2px] border-0 bg-transparent p-0 transition-colors focus-visible:bg-signal-wash data-[brushed]:bg-signal-wash data-[empty]:cursor-default not-data-[empty]:hover:bg-signal-wash"
              data-empty={n === 0 || undefined}
              data-brushed={i >= lo && i <= hi ? "" : undefined}
              aria-label={`${bucketLabel(from.getTime(), ms)}: ${n} publishes. Show only these.`}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                // Touch captures the pointer to this bar; let the others see it.
                e.currentTarget.releasePointerCapture(e.pointerId);
                dragging.current = true;
                setBrush({ from: i, to: i });
              }}
              onPointerEnter={() => {
                setHover(i);
                const current = brushRef.current;
                if (dragging.current && current) setBrush({ ...current, to: i });
              }}
              onFocus={() => setHover(i)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === " ") && n > 0) {
                  e.preventDefault();
                  onQuery(withRange(query, from, new Date(start + (i + 1) * ms)));
                }
              }}
            >
              <span
                className="flex min-h-0 w-full origin-bottom animate-rise flex-col overflow-hidden rounded-t-[2px] rounded-b-[1px] group-data-[empty]/bar:h-0.5! group-data-[empty]/bar:bg-line-soft motion-reduce:animate-none"
                style={{ height: `${(n / peak) * 100}%` }}
              >
                {removed > 0 && (
                  <span
                    className="basis-0 bg-[repeating-linear-gradient(45deg,var(--data-berry)_0_1.5px,var(--data-berry-wash)_1.5px_4px)]"
                    style={{ flexGrow: removed }}
                  />
                )}
                {active > 0 && (
                  <span
                    className="basis-0 bg-ink-faint transition-colors group-hover/bar:bg-signal group-focus-visible/bar:bg-signal group-data-[brushed]/bar:bg-signal"
                    style={{ flexGrow: active }}
                  />
                )}
              </span>
            </button>
          );
        })}
      </div>
      <div className="relative h-4 text-micro text-ink-faint tabular-nums" aria-hidden>
        {ticks.length ? (
          ticks.map((t) => (
            <span
              key={t.label}
              className="absolute top-0 border-l border-line pl-1 whitespace-nowrap"
              style={{ left: `${t.at * 100}%` }}
            >
              {t.label}
            </span>
          ))
        ) : (
          <span>{bucketLabel(start, ms)}</span>
        )}
        <span className="absolute top-0 right-0 bg-pane pl-1.5">{endLabel}</span>
      </div>
      <ul className="mk-legend text-micro">
        <li>
          <span className="mk-key mk-key--bar bg-ink-faint" />
          Active
        </li>
        <li>
          <span className="mk-key mk-key--hatch mk-key--berry" />
          Yanked, deprecated or deleted since
        </li>
      </ul>
    </section>
  );
}

// ── Facets ─────────────────────────────────────────────────────────────────

function FacetGroup({
  title,
  facetKey,
  facets,
  query,
  onQuery,
  none,
  labelOf = (v) => v,
}: {
  title: string;
  facetKey: QueryKey;
  facets: Facet[];
  query: string;
  onQuery: (q: string) => void;
  none: string;
  labelOf?: (value: string) => string;
}) {
  const peak = Math.max(1, ...facets.map((f) => f.count));
  const tokens = new Set(tokenize(query));
  return (
    <section aria-label={title}>
      <h3 className="m-0 mb-1.5 text-label text-ink-muted">{title}</h3>
      {facets.length === 0 ? (
        <p className="m-0 text-body-sm text-ink-faint">Nothing matches.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col p-0">
          {facets.map((facet) => {
            const value = facet.value ?? "none";
            const pressed = tokens.has(filterToken(facetKey, value));
            return (
              <li key={value}>
                <button
                  type="button"
                  className="group relative flex min-h-[30px] w-full cursor-pointer items-center gap-2 overflow-hidden rounded-plate border-0 bg-transparent px-2 py-1 text-left text-body-sm text-ink hover:bg-raised aria-pressed:font-semibold"
                  aria-pressed={pressed}
                  onClick={() => onQuery(toggleFilter(query, facetKey, value))}
                >
                  <span
                    className="absolute inset-x-0 inset-y-[3px] origin-left rounded-plate bg-raised opacity-70 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-aria-pressed:bg-signal-wash group-aria-pressed:opacity-100"
                    style={{ transform: `scaleX(${facet.count / peak})` }}
                    aria-hidden
                  />
                  <span className="relative min-w-0 flex-1 truncate">
                    {facet.value !== null ? (
                      labelOf(facet.value)
                    ) : (
                      <span className="text-ink-faint">{none}</span>
                    )}
                  </span>
                  <span className="relative mk-mono text-mono text-ink-muted">
                    {count(facet.count)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  yanked: "Yanked",
  deprecated: "Deprecated",
  deleted: "Deleted",
};

// ── Version table ──────────────────────────────────────────────────────────

function useRowHeight(): number {
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 767.98px)").matches);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767.98px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return narrow ? 60 : 40;
}

/** Windows of rows fetched on demand as the table scrolls. */
function usePublishWindows(base: string, query: string, first: PublishPage) {
  const [pages, setPages] = useState(() => new Map<number, PublishRow[]>([[0, first.rows]]));
  const pending = useRef(new Set<number>());
  useEffect(() => {
    setPages(new Map([[0, first.rows]]));
    pending.current.clear();
  }, [first]);
  const ensure = useCallback(
    (from: number, to: number) => {
      for (let p = Math.floor(from / PAGE); p <= Math.floor(to / PAGE); p++) {
        if (p * PAGE >= first.total || pages.has(p) || pending.current.has(p)) continue;
        pending.current.add(p);
        void api<PublishPage>(
          `${base}/publishes?q=${encodeURIComponent(query)}&offset=${p * PAGE}&limit=${PAGE}`,
        )
          .then((page) => setPages((current) => new Map(current).set(p, page.rows)))
          .finally(() => pending.current.delete(p));
      }
    },
    [base, query, first.total, pages],
  );
  const row = (i: number) => pages.get(Math.floor(i / PAGE))?.[i % PAGE];
  return { row, ensure };
}

function StatusChip({ status }: { status: PublishRow["status"] }) {
  if (status === "active") return null;
  return (
    <span
      className={`mk-chip mk-chip--tag ${status === "deleted" ? "" : "bg-signal-wash text-ink"}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

function VersionRow({
  row,
  owner,
  selected,
  selectable,
  onSelect,
  onFilter,
}: {
  row: PublishRow;
  owner: string;
  selected: boolean;
  selectable: boolean;
  onSelect: (row: PublishRow, extend: boolean) => void;
  onFilter: (key: QueryKey, value: string) => void;
}) {
  const [repoOwner, repoName] = row.repo?.split("/") ?? [];
  return (
    <div
      role="row"
      className={`${ROW} group/row h-full text-body-sm hover:bg-surface aria-selected:bg-signal-wash`}
      data-status={row.status}
      aria-selected={selected}
    >
      <span role="cell" className={CELLS.check}>
        {selectable && row.status !== "deleted" && (
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={selected}
            onChange={() => undefined}
            onClick={(e) => onSelect(row, e.shiftKey)}
            aria-label={`Select ${row.version}`}
          />
        )}
      </span>
      <span role="cell" className={CELLS.version}>
        <span
          className="mk-mono truncate group-data-[status=deleted]/row:text-ink-faint group-data-[status=deleted]/row:line-through group-data-[status=deleted]/row:decoration-line"
          title={row.size !== null ? `${row.version} · ${bytes(row.size)}` : row.version}
        >
          {row.version}
        </span>
        {row.tags.map((tag) => (
          <button
            key={tag}
            type="button"
            className="h-[18px] flex-none cursor-pointer rounded-full border-0 bg-signal-wash px-1.5 text-micro font-semibold text-ink hover:bg-signal hover:text-signal-ink"
            onClick={() => onFilter("tag", tag)}
            title={`Filter to tag:${tag}`}
          >
            {tag}
          </button>
        ))}
        <StatusChip status={row.status} />
      </span>
      <span role="cell" className={CELLS.source}>
        {row.repo && repoOwner && repoName ? (
          <Link
            to={repoPath(repoOwner, repoName)}
            className={`${quietLink} truncate`}
            title={row.repo}
          >
            {repoOwner === owner ? repoName : row.repo}
          </Link>
        ) : (
          <span
            className="truncate text-ink-muted"
            title={`Published by ${row.actor} (${row.via})`}
          >
            {row.actor}
          </span>
        )}
      </span>
      <span role="cell" className={CELLS.commit}>
        {row.commit && repoOwner && repoName && (
          <Link
            to={treeUrl(repoOwner, repoName, row.commit)}
            className="mk-chip mk-chip--tag mk-mono no-underline"
            title={`Browse ${row.repo} at ${row.commit}`}
          >
            <GitCommitIcon aria-hidden />
            {shortOid(row.commit)}
          </Link>
        )}
      </span>
      <span role="cell" className={CELLS.branch}>
        {row.ref && (
          <button
            type="button"
            className="inline-flex max-w-full min-w-0 cursor-pointer items-center gap-1 truncate border-0 bg-transparent p-0 text-inherit hover:text-ink"
            onClick={() => onFilter("branch", row.ref!)}
            title={`Filter to branch:${row.ref}`}
          >
            <GitBranchIcon aria-hidden className="shrink-0" />
            <span className="truncate">{row.ref}</span>
          </button>
        )}
      </span>
      <span role="cell" className={`${CELLS.run} font-mono`}>
        {row.runNumber !== null && repoOwner && repoName && (
          <Link
            to={repoPath(repoOwner, repoName, "ci", String(row.runNumber))}
            className={quietLink}
          >
            #{row.runNumber}
          </Link>
        )}
      </span>
      <span role="cell" className={CELLS.age} title={fullDate(row.at)}>
        {timeAgo(row.at)}
      </span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div role="row" className={`${ROW} h-full text-body-sm`} aria-busy="true">
      <span role="cell" className={CELLS.check} />
      <span role="cell" className={CELLS.version}>
        <span className="inline-block h-2.5 w-24 animate-pulse rounded-[5px] bg-raised" />
      </span>
    </div>
  );
}

function VersionTable({
  data,
  page,
  selection,
  onSelect,
  onSelectPage,
  onFilter,
  selectable,
}: {
  data: LoaderData;
  page: PublishPage;
  selection: Selection;
  onSelect: (row: PublishRow, extend: boolean, visible: PublishRow[]) => void;
  onSelectPage: (rows: PublishRow[]) => void;
  onFilter: (key: QueryKey, value: string) => void;
  selectable: boolean;
}) {
  const rowHeight = useRowHeight();
  const body = useRef<HTMLDivElement>(null);
  const { row, ensure } = usePublishWindows(data.base, data.query, page);
  const [range, setRange] = useState({ from: 0, to: 40 });

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const el = body.current;
      if (!el) return;
      const top = el.getBoundingClientRect().top;
      const from = Math.max(0, Math.floor(-top / rowHeight) - 10);
      const to = Math.min(page.total, Math.ceil((window.innerHeight - top) / rowHeight) + 10);
      setRange((r) => (r.from === from && r.to === to ? r : { from, to }));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [rowHeight, page.total]);

  useEffect(() => ensure(range.from, range.to), [ensure, range]);

  const visible: PublishRow[] = [];
  for (let i = range.from; i < range.to; i++) {
    const r = row(i);
    if (r) visible.push(r);
  }
  const selectableRows = visible.filter((r) => r.status !== "deleted");
  const allVisibleSelected =
    selectableRows.length > 0 &&
    (selection.all || selectableRows.every((r) => selection.versions.has(r.version)));

  if (page.total === 0) {
    return (
      <div className="mk-empty">
        No publishes match <code className="mk-mono">{data.query || "everything"}</code>.
      </div>
    );
  }
  const onlyDeleted = /(^|\s)status:deleted(\s|$)/.test(data.query);

  return (
    <>
      {onlyDeleted && (
        <p className="m-0 text-body-sm text-ink-faint">
          Deleted versions stay in the history so you can see what was built, but they can't be
          installed, selected or restored.
        </p>
      )}
      <div
        role="table"
        aria-label="Versions"
        aria-rowcount={page.total}
        className="overflow-clip rounded-pane bg-pane"
      >
        <div
          role="row"
          className={`${ROW} sticky top-0 z-[2] h-9 rounded-t-pane bg-pane text-label text-ink-faint max-md:hidden`}
        >
          <span role="columnheader" className={CELLS.check}>
            {selectable && selectableRows.length > 0 && (
              <input
                type="checkbox"
                className={CHECKBOX}
                checked={allVisibleSelected}
                onChange={() => onSelectPage(allVisibleSelected ? [] : selectableRows)}
                aria-label="Select the versions in view"
              />
            )}
          </span>
          <span role="columnheader" className={CELLS.version}>
            Version
          </span>
          <span role="columnheader" className={CELLS.source}>
            Source
          </span>
          <span role="columnheader" className={CELLS.commit}>
            Commit
          </span>
          <span role="columnheader" className={CELLS.branch}>
            Branch
          </span>
          <span role="columnheader" className={CELLS.run}>
            Run
          </span>
          <span role="columnheader" className={CELLS.age}>
            Published
          </span>
        </div>
        <div ref={body} className="relative" style={{ height: page.total * rowHeight }}>
          {Array.from({ length: Math.max(0, range.to - range.from) }, (_, k) => {
            const i = range.from + k;
            const r = row(i);
            return (
              <div
                key={r ? `${r.id}` : `skeleton-${i}`}
                className="absolute inset-x-0"
                style={{ top: i * rowHeight, height: rowHeight }}
                aria-rowindex={i + 2}
              >
                {r ? (
                  <VersionRow
                    row={r}
                    owner={data.detail.owner.slug}
                    selected={selection.all || selection.versions.has(r.version)}
                    selectable={selectable}
                    onSelect={(r, extend) => onSelect(r, extend, selectableRows)}
                    onFilter={onFilter}
                  />
                ) : (
                  <SkeletonRow />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// ── Selection and bulk actions ─────────────────────────────────────────────

interface Selection {
  /** Picked versions and their status (which decides the actions offered). */
  versions: Map<string, PublishRow["status"]>;
  /** Everything the query matches, not just the rows in hand. */
  all: boolean;
}

const ACTION_COPY: Record<BulkActionKind, { label: string; done: string }> = {
  delete: { label: "Delete", done: "deleted" },
  yank: { label: "Yank", done: "yanked" },
  unyank: { label: "Restore", done: "restored" },
  deprecate: { label: "Deprecate", done: "deprecated" },
  tag: { label: "Tag", done: "tagged" },
};

function TagPopover({ onTag, busy }: { onTag: (tag: string) => void; busy: boolean }) {
  const [tag, setTag] = useState("");
  return (
    <Popover.Root>
      <Popover.Trigger className="mk-btn mk-btn--sm" disabled={busy}>
        <TagIcon weight="bold" aria-hidden />
        Tag
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={8} className="z-50">
          <Popover.Popup className={`mk-popup ${popMotion} w-64 p-3`}>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (tag.trim()) onTag(tag.trim());
              }}
            >
              <label className="mk-label" htmlFor="gm-tag-name">
                Point a tag at this version
              </label>
              <input
                id="gm-tag-name"
                className="mk-input mk-input--code"
                value={tag}
                onChange={(e) => setTag(e.currentTarget.value)}
                placeholder="stable"
                autoComplete="off"
              />
              <button
                type="submit"
                className="mk-btn mk-btn--sm mk-btn--primary"
                disabled={!tag.trim()}
              >
                Tag it
              </button>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function DeprecatePopover({
  onDeprecate,
  busy,
}: {
  onDeprecate: (reason: string) => void;
  busy: boolean;
}) {
  const [reason, setReason] = useState("");
  return (
    <Popover.Root>
      <Popover.Trigger className="mk-btn mk-btn--sm" disabled={busy}>
        <WarningIcon weight="bold" aria-hidden />
        Deprecate
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={8} className="z-50">
          <Popover.Popup className={`mk-popup ${popMotion} w-72 p-3`}>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                onDeprecate(reason);
              }}
            >
              <label className="mk-label" htmlFor="gm-deprecate-reason">
                What should people use instead?
              </label>
              <input
                id="gm-deprecate-reason"
                className="mk-input"
                value={reason}
                onChange={(e) => setReason(e.currentTarget.value)}
                placeholder="Use 2.x; 1.x is no longer maintained"
              />
              <button type="submit" className="mk-btn mk-btn--sm mk-btn--primary">
                Deprecate
              </button>
            </form>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SelectionBar({
  selection,
  total,
  query,
  actions,
  onSelectAll,
  onClear,
  onAct,
  busy,
}: {
  selection: Selection;
  total: number;
  query: string;
  actions: BulkActionKind[];
  onSelectAll: () => void;
  onClear: () => void;
  onAct: (action: BulkActionKind, extra?: { tag?: string; reason?: string }) => void;
  busy: boolean;
}) {
  const n = selection.all ? total : selection.versions.size;
  if (n === 0) return null;
  const retiredPicked = selection.all
    ? /(^|\s)status:(yanked|deprecated)(\s|$)/.test(query)
    : [...selection.versions.values()].some((st) => st === "yanked" || st === "deprecated");
  const what = selection.all
    ? `every version matching ${query || "everything"}`
    : plural(n, "version");
  return (
    <div
      className="mk-enter-up sticky bottom-4 z-[5] flex flex-wrap items-center gap-2 rounded-pane bg-rail py-2 pr-2 pl-4 shadow-[var(--shadow-dock),0_0_0_1px_var(--line-soft)] motion-reduce:animate-none"
      role="region"
      aria-label="Selected versions"
    >
      <span className="mk-tabular font-semibold">
        {selection.all ? `All ${count(total)} matching` : `${count(n)} selected`}
      </span>
      {!selection.all && total > selection.versions.size && (
        <button type="button" className="mk-btn mk-btn--ghost mk-btn--sm" onClick={onSelectAll}>
          Select all {count(total)} matching
        </button>
      )}
      <span className="flex-1" />
      <div className="flex flex-wrap gap-2 max-sm:order-1 max-sm:basis-full">
        {actions.includes("tag") && n === 1 && !selection.all && (
          <TagPopover busy={busy} onTag={(tag) => onAct("tag", { tag })} />
        )}
        {actions.includes("deprecate") && (
          <DeprecatePopover busy={busy} onDeprecate={(reason) => onAct("deprecate", { reason })} />
        )}
        {actions.includes("yank") && (
          <button
            type="button"
            className="mk-btn mk-btn--sm"
            disabled={busy}
            onClick={() => onAct("yank")}
          >
            Yank
          </button>
        )}
        {actions.includes("unyank") && retiredPicked && (
          <button
            type="button"
            className="mk-btn mk-btn--sm"
            disabled={busy}
            onClick={() => onAct("unyank")}
          >
            Restore
          </button>
        )}
        {actions.includes("delete") && (
          <ConfirmDialog
            trigger={
              <button
                type="button"
                className="mk-btn mk-btn--sm mk-btn--danger-ghost"
                disabled={busy}
              >
                <TrashIcon weight="bold" aria-hidden />
                Delete
              </button>
            }
            title={`Delete ${what}?`}
            description="Clients can no longer install them. The history keeps a record of each one, marked deleted."
            confirmLabel={`Delete ${selection.all ? count(total) : count(n)}`}
            onConfirm={() => onAct("delete")}
            busy={busy}
          />
        )}
      </div>
      <Tip label="Clear the selection">
        <button
          type="button"
          className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
          onClick={onClear}
          aria-label="Clear the selection"
        >
          <XIcon weight="bold" />
        </button>
      </Tip>
    </div>
  );
}

// ── Sources ────────────────────────────────────────────────────────────────

function Sources({ detail, base }: { detail: PackageDetail; base: string }) {
  const [sources, setSources] = useState<PackageSource[]>(detail.sources);
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => setSources(detail.sources), [detail.sources]);
  const admin = detail.access === "admin";
  const add = async (event: { preventDefault(): void }) => {
    event.preventDefault();
    setError(null);
    try {
      const result = await api<{ sources: PackageSource[] }>(`${base}/sources`, {
        method: "POST",
        json: { repo: repo.trim() },
      });
      setSources(result.sources);
      toast.add({ title: `${repo.trim()} can publish ${detail.package.name}` });
      setRepo("");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work.");
    }
  };
  const revoke = async (source: PackageSource) => {
    const result = await api<{ sources: PackageSource[] }>(`${base}/sources/${source.repoId}`, {
      method: "DELETE",
    });
    setSources(result.sources);
    toast.add({ title: `${source.repo ?? "That repository"} can no longer publish it` });
  };
  return (
    <section aria-labelledby="gm-sources">
      <h3 id="gm-sources" className="m-0 mb-1 text-label text-ink-muted">
        Published from
      </h3>
      {sources.length === 0 ? (
        <p className="m-0 text-body-sm text-ink-faint">
          No repository yet. The first CI job to publish it claims it for its repository.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
          {sources.map((source) => {
            const [o, n] = source.repo?.split("/") ?? [];
            return (
              <li key={source.repoId} className="flex items-center gap-2 py-1">
                <span className="min-w-0 flex-1">
                  {o && n ? (
                    <Link to={repoPath(o, n)} className={`${link} block truncate`}>
                      {source.repo}
                    </Link>
                  ) : (
                    <span className="text-ink-faint">A deleted repository</span>
                  )}
                  <span className="block text-micro text-ink-faint mk-tabular">
                    {source.publishes
                      ? `${plural(source.publishes, "publish", "publishes")}, last ${timeAgo(source.lastPublishedAt!)}`
                      : "Hasn't published yet"}
                  </span>
                </span>
                {admin && (
                  <Tip label={`Stop ${source.repo ?? "it"} publishing`}>
                    <button
                      type="button"
                      className="mk-btn mk-btn--ghost mk-btn--icon mk-btn--sm"
                      aria-label={`Stop ${source.repo ?? "this repository"} publishing`}
                      onClick={() => void revoke(source)}
                    >
                      <XIcon weight="bold" />
                    </button>
                  </Tip>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {admin && (
        <form onSubmit={add} className="mt-2 flex gap-2">
          <input
            className="mk-input mk-input--code min-w-0 flex-1 text-body-sm"
            value={repo}
            onChange={(e) => setRepo(e.currentTarget.value)}
            placeholder={`${detail.owner.slug}/repository`}
            aria-label="Repository to allow"
            aria-invalid={error ? "true" : undefined}
          />
          <Tip label="Allow this repository to publish">
            <button
              type="submit"
              className="mk-btn mk-btn--icon"
              disabled={!repo.trim()}
              aria-label="Allow this repository to publish"
            >
              <PlusIcon weight="bold" />
            </button>
          </Tip>
        </form>
      )}
      {error && (
        <p className="mk-error m-0 mt-1" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ── The page ───────────────────────────────────────────────────────────────

export function PackageConsole() {
  const data = useLoaderData<typeof packageConsoleLoader>();
  const { detail, page, query } = data;
  const [, setParams] = useSearchParams();
  const revalidator = useRevalidator();
  const toast = useToast();
  const [selection, setSelection] = useState<Selection>({ versions: new Map(), all: false });
  const [busy, setBusy] = useState(false);
  const anchor = useRef<string | null>(null);
  const pkg = detail.package;
  const selectable = detail.actions.length > 0;
  // A query that doesn't parse keeps the last results on screen, dimmed.
  const lastPage = useRef(page);
  if (page) lastPage.current = page;
  const shownPage = page ?? lastPage.current;

  useEffect(() => setSelection({ versions: new Map(), all: false }), [query]);

  const onQuery = useCallback(
    (q: string) => setParams(q === DEFAULT_QUERY ? {} : { q }, { preventScrollReset: true }),
    [setParams],
  );
  const onFilter = (key: QueryKey, value: string) => onQuery(toggleFilter(query, key, value));

  const onSelect = (row: PublishRow, extend: boolean, visible: PublishRow[]) => {
    setSelection((current) => {
      const versions = new Map(current.all ? [] : current.versions);
      const at = (v: string | null) => visible.findIndex((r) => r.version === v);
      if (extend && at(anchor.current) !== -1) {
        const [a, b] = [at(anchor.current), at(row.version)].sort((x, y) => x - y);
        for (const r of visible.slice(a, (b ?? a ?? 0) + 1)) versions.set(r.version, r.status);
      } else if (versions.has(row.version)) versions.delete(row.version);
      else versions.set(row.version, row.status);
      anchor.current = row.version;
      return { versions, all: false };
    });
  };

  const act = async (action: BulkActionKind, extra: { tag?: string; reason?: string } = {}) => {
    setBusy(true);
    try {
      const result = await api<BulkActionResult>(`${data.base}/actions`, {
        method: "POST",
        json: selection.all
          ? { action, query, ...extra }
          : { action, versions: [...selection.versions.keys()], ...extra },
      });
      const failed = result.failed.length;
      toast.add({
        title: `${plural(result.done.length, "version")} ${ACTION_COPY[action].done}`,
        description: failed
          ? `${plural(failed, "version")} couldn't be: ${result.failed[0]?.error}`
          : result.remaining
            ? `${count(result.remaining)} more match; run it again to continue.`
            : undefined,
      });
      setSelection({ versions: new Map(), all: false });
      void revalidator.revalidate();
    } catch (e) {
      toast.add({
        title: `Couldn't ${ACTION_COPY[action].label.toLowerCase()} them`,
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  const narrow = (
    <>
      {shownPage?.facets ? (
        <>
          <FacetGroup
            title="Source"
            facetKey="source"
            facets={shownPage.facets.source}
            query={query}
            onQuery={onQuery}
            none="By hand"
          />
          <FacetGroup
            title="Branch"
            facetKey="branch"
            facets={shownPage.facets.branch}
            query={query}
            onQuery={onQuery}
            none="No branch"
          />
          <FacetGroup
            title="Status"
            facetKey="status"
            facets={shownPage.facets.status}
            labelOf={(v) => STATUS_LABEL[v] ?? v}
            query={query}
            onQuery={onQuery}
            none="Unknown"
          />
        </>
      ) : (
        <p className="m-0 text-body-sm text-ink-faint">Fix the query to see counts.</p>
      )}
      <Sources detail={detail} base={data.base} />
    </>
  );

  return (
    <Page wide>
      <header className="flex flex-col gap-3">
        <nav aria-label="Breadcrumb" className="text-body-sm text-ink-muted">
          <Link to={`/${detail.owner.slug}`} className="text-ink-muted no-underline hover:text-ink">
            {detail.owner.slug}
          </Link>
          <span className="px-1.5 text-ink-faint">/</span>
          <Link
            to={packagesPath(detail.owner.slug)}
            className="text-ink-muted no-underline hover:text-ink"
          >
            Packages
          </Link>
        </nav>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="m-0 min-w-0 text-headline break-all">
            <bdi>{pkg.name}</bdi>
          </h1>
          <span className="mk-chip mk-chip--tag">{formatLabel(pkg.format)}</span>
          {detail.feed.visibility !== "public" && (
            <span className="mk-chip mk-chip--tag">
              {detail.feed.visibility === "private" ? "Private" : "Internal"}
            </span>
          )}
        </div>
        <p className="m-0 text-body-sm text-ink-muted mk-tabular">
          {plural(pkg.versions, "active version")}
          {pkg.latest && (
            <>
              {" · latest "}
              <span className="mk-mono text-ink">{pkg.latest}</span>
            </>
          )}
          {` · ${plural(detail.totals.publishes, "publish", "publishes")}`}
          {detail.totals.firstPublishedAt && ` since ${fullDate(detail.totals.firstPublishedAt)}`}
          {pkg.publishes24h > 0 && ` · ${count(pkg.publishes24h)} in the last day`}
        </p>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
          <CopyField label="Install command" value={installCommand(detail.registryUrl, pkg)} />
          {Object.keys(detail.tags).length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Tags">
              {Object.entries(detail.tags).map(([tag, version]) => (
                <li key={tag}>
                  <button
                    type="button"
                    className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-control border-0 bg-pane px-2.5 text-body-sm text-ink-muted hover:bg-raised"
                    onClick={() => onQuery(filterToken("tag", tag))}
                    title={`Show ${tag}`}
                  >
                    <TagIcon weight="bold" aria-hidden />
                    <span>{tag}</span>
                    <span className="mk-mono text-ink">{version}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <QueryBar query={query} onQuery={onQuery} error={data.error} />
          <SavedViews query={query} onQuery={onQuery} />
          {/* Below the two-column layout the facets come first: the table is unending. */}
          <details className="rounded-pane bg-pane px-3.5 py-1 open:pb-3.5 lg:hidden">
            <summary className="flex min-h-10 cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 font-semibold [&::-webkit-details-marker]:hidden">
              <FunnelSimpleIcon weight="bold" aria-hidden />
              Narrow it down
              <span className="text-body-sm font-normal text-ink-faint">
                source, branch, status, who publishes it
              </span>
            </summary>
            <div className="flex flex-col gap-5 pt-4">{narrow}</div>
          </details>
          <div
            className={`flex flex-col gap-4 transition-opacity ${page ? "" : "pointer-events-none opacity-40"}`}
            aria-hidden={page ? undefined : true}
          >
            {shownPage?.histogram && (
              <RateStrip
                histogram={shownPage.histogram}
                total={shownPage.total}
                query={query}
                onQuery={onQuery}
              />
            )}
            {shownPage && (
              <VersionTable
                data={data}
                page={shownPage}
                selection={selection}
                selectable={selectable}
                onSelect={onSelect}
                onSelectPage={(rows) =>
                  setSelection({
                    versions: new Map(rows.map((r) => [r.version, r.status])),
                    all: false,
                  })
                }
                onFilter={onFilter}
              />
            )}
          </div>
          <SelectionBar
            selection={selection}
            total={page?.total ?? 0}
            query={query}
            actions={detail.actions}
            onSelectAll={() => setSelection({ versions: new Map(), all: true })}
            onClear={() => setSelection({ versions: new Map(), all: false })}
            onAct={(action, extra) => void act(action, extra)}
            busy={busy}
          />
        </div>
        <aside
          className="hidden flex-col gap-6 lg:sticky lg:top-6 lg:flex lg:self-start"
          aria-label="Narrow it down"
        >
          <div className="flex items-center gap-2 text-title">
            <FunnelSimpleIcon weight="bold" aria-hidden className="text-ink-faint" />
            <h2 className="m-0 text-title">Narrow it down</h2>
          </div>
          {narrow}
        </aside>
      </div>
    </Page>
  );
}
