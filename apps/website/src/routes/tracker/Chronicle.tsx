/*
 * DIRECTION (impeccable, extension of throughput-console 49700b21; CORE-251)
 *
 * THESIS       The tracker as footage: scrub a playhead through the issue
 *              stream like DevTools Performance or an editor's timeline, and
 *              every status reads "as of" that moment. Refuses a Gantt chart
 *              of plans: it shows what happened, from the event log.
 * OWN-WORLD    MatrixKit Neo unchanged: charcoal panes, amber only for the
 *              playhead, the brushed window and the selection; status by
 *              shape (lane weight and dash, the ink claim flag, evidence
 *              green); one data hue (teal) for change density in the overview.
 * STORY        Pick a range, scrub, see who held what and what moved; open a
 *              span and follow it to its commit, CI run and release note.
 * FIRST VIEW   Query bar and views as in List; presets, zoom and the "as of"
 *              readout; the overview strip with its brush; the ruler and
 *              lanes filling the height beside a 22rem summary/inspector.
 * FORM         Extension inside the locked world (no new concept round).
 *              Signature: the playhead and range select on the ruler.
 * FINISH       unreviewed and undocumented is unfinished; this build ends with
 *              the finish review, the verdict, DESIGN.md, and every shipping
 *              raster carrying its provenance
 */

import {
  ArrowsInLineHorizontalIcon,
  CaretLeftIcon,
  CaretRightIcon,
  MagnifyingGlassMinusIcon,
  MagnifyingGlassPlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useNavigationType } from "react-router";
import type { ChronicleIssue, WorkSpan } from "../../../shared/chronicle.ts";
import { Tip } from "../../components/ui.tsx";
import { useChronicle } from "./chronicleData.ts";
import {
  groupRows,
  moment,
  PRESETS,
  presetWindow,
  readAddress,
  writeAddress,
  zoom,
  type ChronicleAddress,
} from "./chronicleModel.ts";
import { ChronicleList } from "./ChronicleList.tsx";
import { ChronicleOverview } from "./ChronicleOverview.tsx";
import { Inspector, RangeSummary } from "./ChronicleSide.tsx";
import { ChronicleTimeline } from "./ChronicleTimeline.tsx";

const LABEL_WIDTH = 288;

function usePhone(): boolean {
  const query = "(max-width: 767px)";
  const [phone, setPhone] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const change = () => setPhone(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return phone;
}

export function Chronicle({
  owner,
  base,
  query,
  params,
  setParams,
  selectedIssue,
  serverNow,
}: {
  owner: string;
  base: string;
  query: string;
  params: URLSearchParams;
  setParams: (next: URLSearchParams, options: { replace: boolean; state?: unknown }) => void;
  /** The route's issue (id or key). */
  selectedIssue: string | null;
  serverNow: number;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const navigationId = useId();
  const phone = usePhone();
  const now = serverNow;
  const address = useMemo(() => readAddress(params, now), [params, now]);
  // During a gesture the view runs ahead of the address, which catches up at its end.
  const [live, setLive] = useState<{ from: number; to: number; at: number } | null>(null);
  const view = { from: live?.from ?? address.from, to: live?.to ?? address.to };
  const at = live?.at ?? address.at;
  const range = address.range;
  const { data, loading, error } = useChronicle(owner, query, view, now);
  // A link opened without a range gets the one it shows, so copying it keeps the moment.
  useEffect(() => {
    if (!params.has("from") || !params.has("to") || !params.has("at"))
      setParams(writeAddress(params, address), { replace: true });
  }, [params, address, setParams]);

  // The params last written: navigation settles asynchronously, and a quick
  // second key press must build on the first.
  const latest = useRef(params);
  const revision = useRef(0);
  const acknowledged = useRef({ location: location.key, search: params.toString() });
  useLayoutEffect(() => {
    const search = params.toString();
    if (acknowledged.current.location === location.key && acknowledged.current.search === search)
      return;
    acknowledged.current = { location: location.key, search };
    const receipt = location.state?.chronicleNavigation as
      | { id?: unknown; revision?: unknown }
      | undefined;
    const own =
      navigationType !== "POP" &&
      receipt?.id === navigationId &&
      typeof receipt.revision === "number" &&
      receipt.revision > 0 &&
      receipt.revision <= revision.current;
    // A previous navigation can commit after the next key's gesture starts.
    if (own && receipt.revision !== revision.current) return;
    latest.current = params;
    if (own)
      setLive((current) =>
        current?.from === address.from && current.to === address.to && current.at === address.at
          ? null
          : current,
      );
    else {
      revision.current++;
      setLive(null);
    }
  }, [params, address, location.key, location.state, navigationType, navigationId]);
  const commit = (next: Partial<ChronicleAddress>, push = true) => {
    const base = latest.current;
    const written = writeAddress(base, { ...readAddress(base, now), ...next });
    latest.current = written;
    setParams(written, {
      replace: !push,
      state: { chronicleNavigation: { id: navigationId, revision: ++revision.current } },
    });
  };
  // Wheel bursts settle into one history entry.
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onWindow = (window: { from: number; to: number }, done: boolean) => {
    setLive({ from: window.from, to: window.to, at });
    if (settle.current) clearTimeout(settle.current);
    if (done) commit({ from: window.from, to: window.to });
    else
      settle.current = setTimeout(() => commit({ from: window.from, to: window.to }, false), 400);
  };
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );
  const onPlayhead = (t: number, done: boolean) => {
    // Keep the gesture visible until navigation acknowledges it, including keyup.
    setLive({ ...view, at: t });
    if (done) commit({ ...view, at: t }, true);
  };

  const issues = data?.issues ?? [];
  const selected: ChronicleIssue | null =
    (selectedIssue &&
      issues.find((issue) => issue.id === selectedIssue || issue.key === selectedIssue)) ||
    null;
  const span: WorkSpan | null =
    (address.span && selected?.spans.find((s) => s.id === address.span)) || null;
  const rows = useMemo(
    () => groupRows(issues, address.group, at, data?.teams ?? {}),
    [issues, address.group, at, data?.teams],
  );

  const search = (next: URLSearchParams) => (next.size ? `?${next}` : "");
  const withAddress = (changes: Partial<ChronicleAddress>) =>
    writeAddress(latest.current, {
      ...readAddress(latest.current, now),
      ...live,
      ...changes,
    });
  const issueHref = (id: string) =>
    `${base}/issues/${encodeURIComponent(id)}${search(withAddress({ span: null }))}`;
  const spanHref = (s: WorkSpan) =>
    `${base}/issues/${encodeURIComponent(s.issueId)}${search(withAddress({ span: s.id }))}`;
  const closeHref = `${base}${search(withAddress({ span: null }))}`;
  const openIssueHref = (issue: ChronicleIssue) => {
    const next = new URLSearchParams(latest.current);
    for (const key of ["view", "from", "to", "at", "rs", "re", "span", "group", "layout"])
      next.delete(key);
    return `${base}/issues/${encodeURIComponent(issue.id)}${search(next)}`;
  };
  const list = phone || address.list;

  const preset = (id: (typeof PRESETS)[number]["id"]) => {
    const earliest = data?.history.earliest ? Date.parse(data.history.earliest) : null;
    const window = presetWindow(id, now, earliest);
    setLive(null);
    commit({ ...window, at: Math.min(Math.max(at, window.from), window.to), range: null });
  };
  const activePreset = PRESETS.find(
    (p) =>
      p.ms !== null &&
      Math.abs(view.to - view.from - p.ms) < 60_000 &&
      Math.abs(view.to - now) < 3_600_000,
  )?.id;

  const summaryRange = range ?? { from: view.from, to: Math.min(view.to, now) };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2" data-chronicle>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1.5" role="group" aria-label="Range presets">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              className="mk-chip"
              aria-pressed={activePreset === p.id}
              onClick={() => preset(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex gap-1 max-md:hidden">
          <Tip label="Zoom out (−)">
            <button
              type="button"
              className="mk-btn mk-btn--icon mk-btn--sm"
              aria-label="Zoom out"
              onClick={() => onWindow(zoom(view, 1 / 0.6, at), true)}
            >
              <MagnifyingGlassMinusIcon weight="bold" aria-hidden />
            </button>
          </Tip>
          <Tip label="Zoom in (+)">
            <button
              type="button"
              className="mk-btn mk-btn--icon mk-btn--sm"
              aria-label="Zoom in"
              onClick={() => onWindow(zoom(view, 0.6, at), true)}
            >
              <MagnifyingGlassPlusIcon weight="bold" aria-hidden />
            </button>
          </Tip>
          {range && (
            <Tip label="Zoom to the selected range">
              <button
                type="button"
                className="mk-btn mk-btn--icon mk-btn--sm"
                aria-label="Zoom to the selected range"
                onClick={() => {
                  const pad = (range.to - range.from) * 0.05;
                  setLive(null);
                  commit({ from: range.from - pad, to: range.to + pad });
                }}
              >
                <ArrowsInLineHorizontalIcon weight="bold" aria-hidden />
              </button>
            </Tip>
          )}
        </div>
        <div className="mk-segmented max-md:hidden" role="radiogroup" aria-label="Group rows by">
          {(
            [
              ["status", "Status"],
              ["team", "Team"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={address.group === value}
              className="mk-segment"
              onClick={() => commit({ group: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mk-segmented max-md:hidden" role="radiogroup" aria-label="Show as">
          {(
            [
              [false, "Chart"],
              [true, "List"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={label}
              type="button"
              role="radio"
              aria-checked={address.list === value}
              className="mk-segment"
              onClick={() => commit({ list: value })}
            >
              {label}
            </button>
          ))}
        </div>
        <p
          className="m-0 ml-auto flex items-center gap-1 text-body-sm text-ink-muted tabular-nums max-md:basis-full"
          aria-live="off"
          data-chronicle-playhead={new Date(at).toISOString()}
        >
          <span className="text-ink-faint">As of</span>
          <span className="font-mono text-mono text-ink">{moment(at)}</span>
          {range && (
            <button
              type="button"
              className="mk-btn mk-btn--ghost mk-btn--sm ml-1"
              onClick={() => commit({ range: null })}
            >
              <span className="font-mono text-micro tabular-nums">
                {moment(range.from)} → {moment(range.to)}
              </span>
              <XIcon weight="bold" aria-hidden />
              <span className="sr-only">Clear the selected range</span>
            </button>
          )}
        </p>
      </div>
      {list && (
        <div className="flex items-center gap-2 rounded-pane bg-pane px-3 py-2">
          <Tip label="Earlier">
            <button
              type="button"
              className="mk-btn mk-btn--icon mk-btn--sm"
              aria-label="Move the playhead earlier"
              onClick={() => onPlayhead(Math.max(view.from, at - (view.to - view.from) / 48), true)}
            >
              <CaretLeftIcon weight="bold" aria-hidden />
            </button>
          </Tip>
          <input
            type="range"
            className="min-w-0 flex-1 accent-signal"
            aria-label="Playhead"
            aria-valuetext={`As of ${moment(at)}`}
            min={Math.round(view.from)}
            max={Math.round(Math.min(view.to, now))}
            step={Math.max(60_000, Math.round((view.to - view.from) / 400))}
            value={Math.round(Math.min(Math.max(at, view.from), Math.min(view.to, now)))}
            onChange={(event) => onPlayhead(Number(event.target.value), false)}
            onPointerUp={(event) => onPlayhead(Number(event.currentTarget.value), true)}
            onKeyUp={(event) => onPlayhead(Number(event.currentTarget.value), true)}
            data-chronicle-scrubber
          />
          <Tip label="Later">
            <button
              type="button"
              className="mk-btn mk-btn--icon mk-btn--sm"
              aria-label="Move the playhead later"
              onClick={() =>
                onPlayhead(Math.min(view.to, now, at + (view.to - view.from) / 48), true)
              }
            >
              <CaretRightIcon weight="bold" aria-hidden />
            </button>
          </Tip>
        </div>
      )}
      <ChronicleOverview
        density={data?.density ?? null}
        history={data?.history ?? null}
        window={view}
        at={at}
        now={now}
        onWindow={onWindow}
      />
      {error && (
        <p role="alert" className="m-0 text-body-sm text-danger-text">
          {error}
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-4 max-md:flex-col">
        <div className="flex min-h-[24rem] min-w-0 flex-1 flex-col">
          {!data ? (
            <div
              className="flex flex-1 items-center justify-center rounded-pane bg-pane text-body-sm text-ink-faint"
              aria-busy="true"
            >
              Reading the tracker's history…
            </div>
          ) : !data.issues.length ? (
            <div className="mk-empty">
              No matching issue changed, or was open, in this range.{" "}
              {data.quiet > 0 &&
                `${data.quiet.toLocaleString()} closed earlier and untouched here. `}
              Widen the range with the presets, or change the query above.
            </div>
          ) : list ? (
            <ChronicleList
              data={data}
              rows={rows}
              window={view}
              at={at}
              now={now}
              selection={{ issue: selected?.id ?? null, span: span?.id ?? null }}
              issueHref={issueHref}
              spanHref={spanHref}
            />
          ) : (
            <ChronicleTimeline
              data={data}
              rows={rows}
              window={view}
              at={at}
              range={range}
              now={now}
              selection={{ issue: selected?.id ?? null, span: span?.id ?? null }}
              issueHref={issueHref}
              onWindow={onWindow}
              onPlayhead={onPlayhead}
              onRange={(next, done) => commit({ range: next }, done)}
              onSelectSpan={(s) => void navigate(spanHref(s), { preventScrollReset: true })}
              onOpenIssue={(issue) =>
                void navigate(issueHref(issue.id), { preventScrollReset: true })
              }
              labelWidth={LABEL_WIDTH}
            />
          )}
          {data && (
            <p className="m-0 mt-1.5 flex gap-3 text-micro text-ink-faint" aria-live="polite">
              <span>
                {loading
                  ? "Reading more history…"
                  : `${data.issues.length.toLocaleString()} issues · rows match the query as issues are now`}
              </span>
              {data.truncated && (
                <span>
                  Showing the first {data.issues.length.toLocaleString()}; narrow the query to see
                  the rest.
                </span>
              )}
            </p>
          )}
        </div>
        <aside
          aria-label={selected ? `Issue ${selected.key} over time` : "Range summary"}
          className="flex shrink-0 flex-col overflow-y-auto rounded-pane bg-pane px-4 py-3 md:w-[22rem]"
        >
          {data && selected ? (
            <Inspector
              owner={owner}
              issue={selected}
              span={span}
              data={data}
              at={at}
              now={now}
              closeHref={closeHref}
              spanHref={spanHref}
              openIssueHref={openIssueHref(selected)}
            />
          ) : data ? (
            <RangeSummary data={data} range={summaryRange} now={now} issueHref={issueHref} />
          ) : null}
        </aside>
      </div>
    </div>
  );
}
