// The Chronicle's side column (CORE-251): with nothing selected, the range
// summary (statuses at its start and end, what completed, who worked how
// long, what waits); with an issue or a work span selected, the inspector:
// its state as of the playhead, its changes, spans and markers in the
// range, and its linked work, each item opening its existing page.

import { XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef } from "react";
import { Link, useLocation } from "react-router";
import {
  actorText,
  MARKER_LABEL,
  SPAN_END_LABEL,
  summarize,
  workedMs,
  type ChronicleIssue,
  type ChronicleMarker,
  type WorkSpan,
} from "../../../shared/chronicle.ts";
import type { AuditActor, IssueStatus } from "../../../shared/tracker.ts";
import { Tip } from "../../components/ui.tsx";
import { Actor } from "./Actor.tsx";
import { LinkedWorkPanel } from "./LinkedWork.tsx";
import type { Loaded } from "./chronicleData.ts";
import {
  checkpointInWindow,
  duration,
  isCheckpoint,
  moment,
  stamp,
  stateAsOf,
  STATUS_ORDER,
  STATUS_WORDS,
} from "./chronicleModel.ts";
import { STATE_LABEL } from "./query.ts";
import { StateDot } from "./Log.tsx";

const time = (iso: string) => Date.parse(iso);

/** An AuditActor as the tracker's Actor shows people and agents. */
function who(actors: Record<string, AuditActor>, id: string) {
  const actor = actors[id];
  if (actor?.kind === "agent")
    return { name: actor.name ?? id, kind: "agent" as const, person: actor.accountable };
  const name = actor?.name ?? id;
  return { name, kind: "person" as const, person: { id, slug: id, displayName: name } };
}

export function RangeSummary({
  data,
  range,
  now,
  issueHref,
}: {
  data: Loaded;
  range: { from: number; to: number };
  now: number;
  issueHref: (id: string) => string;
}) {
  const summary = useMemo(
    () => summarize(data.issues, range.from, range.to, now),
    [data.issues, range.from, range.to, now],
  );
  const byId = useMemo(() => new Map(data.issues.map((i) => [i.id, i])), [data.issues]);
  const statuses = STATUS_ORDER.filter(
    (s) => summary.startCounts[s] !== undefined || summary.endCounts[s] !== undefined,
  );
  const issueLinks = (ids: string[], empty: string) =>
    ids.length ? (
      <ul className="m-0 flex list-none flex-col p-0">
        {ids.slice(0, 12).map((id) => {
          const issue = byId.get(id)!;
          return (
            <li key={id}>
              <Link
                to={issueHref(id)}
                preventScrollReset
                className="flex min-h-8 items-center gap-2 rounded-plate px-2 text-body-sm no-underline hover:bg-raised max-sm:min-h-11"
              >
                <span className="font-mono text-mono text-ink-muted">{issue.key}</span>
                <span className="min-w-0 flex-1 truncate text-ink" title={issue.title}>
                  {issue.title}
                </span>
              </Link>
            </li>
          );
        })}
        {ids.length > 12 && (
          <li className="px-2 text-micro text-ink-faint">and {ids.length - 12} more</li>
        )}
      </ul>
    ) : (
      <p className="m-0 px-2 text-body-sm text-ink-faint">{empty}</p>
    );
  return (
    <section
      aria-labelledby="chronicle-summary"
      className="flex flex-col gap-4"
      data-chronicle-summary
    >
      <header>
        <h2 id="chronicle-summary" className="m-0 text-title">
          Range summary
        </h2>
        <p className="m-0 font-mono text-micro text-ink-faint tabular-nums">
          {moment(range.from)} → {moment(range.to)}
        </p>
      </header>
      <table className="w-full border-collapse text-body-sm" data-chronicle-counts>
        <caption className="sr-only">Issues by status at the range's start and end</caption>
        <thead>
          <tr className="text-label text-ink-faint">
            <th scope="col" className="py-1 text-left font-semibold">
              Status
            </th>
            <th scope="col" className="py-1 text-right font-semibold">
              Start
            </th>
            <th scope="col" className="py-1 text-right font-semibold">
              End
            </th>
          </tr>
        </thead>
        <tbody>
          {statuses.map((status) => {
            const a = summary.startCounts[status] ?? 0;
            const b = summary.endCounts[status] ?? 0;
            return (
              <tr key={status} className="border-t border-line-soft" data-status={status}>
                <th scope="row" className="py-1.5 text-left font-normal text-ink-muted">
                  <span className="inline-flex items-center gap-2">
                    {status === "none" ? (
                      <span className="size-2 rounded-full border border-line" aria-hidden />
                    ) : (
                      <StateDot state={status} />
                    )}
                    {STATUS_WORDS[status]}
                  </span>
                </th>
                <td className="py-1.5 text-right font-mono text-mono tabular-nums">{a}</td>
                <td
                  className={`py-1.5 text-right font-mono text-mono tabular-nums ${b !== a ? "text-ink" : "text-ink-muted"}`}
                >
                  {b}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div>
        <h3 className="m-0 mb-1 text-label text-ink-muted">
          Completed <span className="font-mono text-ink-faint">{summary.completed.length}</span>
        </h3>
        {issueLinks(summary.completed, "Nothing was completed in this range.")}
      </div>
      <div>
        <h3 className="m-0 mb-1 text-label text-ink-muted">Who worked</h3>
        {summary.workers.length ? (
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0" data-chronicle-workers>
            {summary.workers.slice(0, 10).map((worker) => (
              <li key={worker.actorId} className="flex items-center gap-2 px-2 text-body-sm">
                <Actor who={who(data.actors, worker.actorId)} className="min-w-0 flex-1" />
                <span className="shrink-0 font-mono text-mono text-ink-muted tabular-nums">
                  {duration(worker.workedMs)}
                </span>
                <span className="w-16 shrink-0 text-right text-micro text-ink-faint tabular-nums">
                  {worker.issues.length} issue{worker.issues.length === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 px-2 text-body-sm text-ink-faint">Nobody held a claim in this range.</p>
        )}
      </div>
      <div>
        <h3 className="m-0 mb-1 text-label text-ink-muted">
          Waiting on a person at the end{" "}
          <span className="font-mono text-ink-faint">{summary.waiting.length}</span>
        </h3>
        {issueLinks(summary.waiting, "Nothing was waiting.")}
      </div>
      <div>
        <h3 className="m-0 mb-1 text-label text-ink-muted">
          Blocked at the end{" "}
          <span className="font-mono text-ink-faint">{summary.blocked.length}</span>
        </h3>
        {issueLinks(summary.blocked, "Nothing was blocked (by today's links).")}
      </div>
      {data.quiet > 0 && (
        <p className="m-0 text-micro text-ink-faint">
          {data.quiet.toLocaleString()} matching issue{data.quiet === 1 ? " was" : "s were"} closed
          before this and untouched in it, so {data.quiet === 1 ? "it isn't" : "they aren't"} shown.
        </p>
      )}
    </section>
  );
}

export function Inspector({
  space,
  issue,
  span,
  data,
  at,
  now,
  closeHref,
  spanHref,
  openIssueHref,
  checkpointHref,
  window: view,
}: {
  space: string;
  issue: ChronicleIssue;
  span: WorkSpan | null;
  data: Loaded;
  at: number;
  now: number;
  closeHref: string;
  spanHref: (span: WorkSpan) => string;
  openIssueHref: string;
  checkpointHref: (marker: ChronicleMarker) => string;
  window: { from: number; to: number };
}) {
  const state = stateAsOf(issue, at, now);
  const location = useLocation();
  const checkpointSection = useRef<HTMLElement>(null);
  const checkpoints = useMemo(
    () => issue.markers.filter((marker) => checkpointInWindow(marker, view.from, view.to)),
    [issue.markers, view.from, view.to],
  );
  const otherMarkers = useMemo(
    () => issue.markers.filter((marker) => !isCheckpoint(marker)),
    [issue.markers],
  );
  useEffect(() => {
    if (location.hash !== "#chronicle-checkpoints") return;
    checkpointSection.current?.focus({ preventScroll: true });
    checkpointSection.current?.scrollIntoView({ block: "nearest" });
  }, [issue.id, location.hash]);
  return (
    <section
      aria-labelledby="chronicle-inspector"
      className="flex flex-col gap-4"
      data-chronicle-inspector={issue.key}
    >
      <header className="flex items-start gap-2 pr-1">
        <div className="min-w-0 flex-1">
          <p className="m-0 font-mono text-mono text-ink-muted">{issue.key}</p>
          <h2 id="chronicle-inspector" className="m-0 text-title text-balance">
            {issue.title}
          </h2>
        </div>
        <Tip label="Close">
          <Link
            to={closeHref}
            preventScrollReset
            aria-label="Close the inspector"
            className="mk-btn mk-btn--ghost mk-btn--sm size-8 shrink-0 p-0 no-underline max-sm:size-11 [&_svg]:size-[18px]"
          >
            <XIcon aria-hidden />
          </Link>
        </Tip>
      </header>
      <p className="m-0 flex flex-wrap items-center gap-2 text-body-sm" data-chronicle-asof>
        <span className="text-ink-faint">As of {moment(at)}:</span>
        {state ? (
          <span className="inline-flex items-center gap-1.5 text-ink">
            <StateDot state={state} />
            {STATE_LABEL[state]}
          </span>
        ) : (
          <span className="text-ink-muted">not created yet</span>
        )}
        <Link to={openIssueHref} className="gm-link ml-auto text-body-sm">
          Open issue
        </Link>
      </p>
      {issue.historyFrom && (
        <p className="m-0 text-micro text-ink-faint">
          Retention removed this issue's activity before {moment(time(issue.historyFrom))}.
        </p>
      )}
      {span ? <SpanFacts span={span} data={data} now={now} /> : null}
      <div>
        <h3 className="m-0 mb-1 text-label text-ink-muted">Work spans</h3>
        {issue.spans.length ? (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {issue.spans.map((s) => {
              const end = s.end ? time(s.end) : now;
              return (
                <li key={s.id}>
                  <Link
                    to={spanHref(s)}
                    preventScrollReset
                    aria-current={span?.id === s.id ? "true" : undefined}
                    data-chronicle-span={s.id}
                    className="flex min-h-9 flex-wrap items-center gap-x-2 rounded-plate px-2 py-1 text-body-sm no-underline hover:bg-raised aria-[current=true]:bg-signal-wash max-sm:min-h-11"
                  >
                    <Actor who={who(data.actors, s.holder)} compact className="min-w-0 text-ink" />
                    <span className="ml-auto font-mono text-micro text-ink-faint tabular-nums">
                      {stamp(time(s.start))} · {duration(end - time(s.start))}
                    </span>
                    <span className="basis-full text-micro text-ink-muted">
                      {s.endedBy ? SPAN_END_LABEL[s.endedBy] : "Still held"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="m-0 px-2 text-body-sm text-ink-faint">Nobody held a claim in this range.</p>
        )}
      </div>
      {checkpoints.length > 0 && (
        <section
          id="chronicle-checkpoints"
          ref={checkpointSection}
          tabIndex={-1}
          aria-labelledby="chronicle-checkpoints-title"
          className="rounded-plate focus-visible:outline-2 focus-visible:outline-signal-line"
        >
          <h3 id="chronicle-checkpoints-title" className="m-0 mb-1 text-label text-ink-muted">
            Checkpoints <span className="text-ink-faint tabular-nums">{checkpoints.length}</span>
          </h3>
          <ol className="m-0 flex list-none flex-col divide-y divide-line-soft p-0">
            {checkpoints.map((marker) => (
              <li key={marker.id} className="py-2" data-chronicle-marker={marker.kind}>
                <div className="flex flex-wrap items-center justify-between gap-x-2">
                  <time
                    dateTime={marker.at}
                    className="font-mono text-micro text-ink-faint tabular-nums"
                  >
                    {stamp(time(marker.at))}
                  </time>
                  <Link
                    to={checkpointHref(marker)}
                    preventScrollReset
                    aria-label={`Go to ${MARKER_LABEL[marker.kind].toLowerCase()} at ${moment(time(marker.at))}`}
                    className="gm-link flex min-h-8 items-center text-body-sm max-sm:min-h-11"
                  >
                    Go to time
                  </Link>
                </div>
                {marker.kind === "timeline-checkpoint" && (
                  <p className="m-0 text-micro text-ink-muted">Timeline checkpoint</p>
                )}
                <p className="m-0 whitespace-pre-wrap text-body-sm text-ink [overflow-wrap:anywhere]">
                  {marker.text || "No summary recorded."}
                </p>
                {marker.actorId && (
                  <p className="m-0 mt-1 text-micro text-ink-muted">
                    {actorText(data.actors, marker.actorId)}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      <div>
        <h3 className="m-0 mb-1 text-label text-ink-muted">Changes in range</h3>
        <ol className="m-0 flex list-none flex-col gap-1 p-0 text-body-sm">
          <li className="flex gap-2 px-2">
            <span className="w-28 shrink-0 font-mono text-micro text-ink-faint tabular-nums">
              At start
            </span>
            <span className="text-ink-muted">
              {issue.start.status ? statusWords(issue.start.status) : "Not created yet"}
            </span>
          </li>
          {issue.segments.map((segment) => (
            <li key={segment.cursor} className="flex gap-2 px-2">
              <span className="w-28 shrink-0 font-mono text-micro text-ink-faint tabular-nums">
                {stamp(time(segment.at))}
              </span>
              <span className="text-ink">
                {segment.status ? statusWords(segment.status) : "Removed"}
                {segment.waiting && <span className="text-ink-faint"> · waiting on a person</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
      {otherMarkers.length > 0 && (
        <div>
          <h3 className="m-0 mb-1 text-label text-ink-muted">What happened</h3>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-body-sm">
            {otherMarkers.map((m) => (
              <li key={m.id} className="flex gap-2 px-2" data-chronicle-marker={m.kind}>
                <span className="w-28 shrink-0 font-mono text-micro text-ink-faint tabular-nums">
                  {stamp(time(m.at))}
                </span>
                <span className="min-w-0">
                  <span className="text-ink-muted">{MARKER_LABEL[m.kind]}</span>
                  {m.text && <span className="block truncate text-ink">{m.text}</span>}
                  {m.actorId && (
                    <span className="block text-micro text-ink-faint">
                      {actorText(data.actors, m.actorId)}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <LinkedWorkPanel
        space={space}
        issueId={issue.id}
        issueKey={issue.key}
        span={span}
        now={now}
      />
    </section>
  );
}

function statusWords(status: IssueStatus) {
  return STATUS_WORDS[status];
}

function SpanFacts({ span, data, now }: { span: WorkSpan; data: Loaded; now: number }) {
  const start = time(span.start);
  const end = span.end ? time(span.end) : now;
  const worked = workedMs(span, start, end, now);
  return (
    <dl
      className="m-0 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-pane bg-surface p-3 text-body-sm"
      data-chronicle-span-facts={span.id}
    >
      <dt className="text-ink-faint">Held by</dt>
      <dd className="m-0 min-w-0">
        <Actor who={who(data.actors, span.holder)} />
        <span className="ml-1 font-mono text-micro text-ink-faint">{span.session}</span>
      </dd>
      <dt className="text-ink-faint">From</dt>
      <dd className="m-0 font-mono text-mono tabular-nums">{moment(start)}</dd>
      <dt className="text-ink-faint">Until</dt>
      <dd className="m-0 font-mono text-mono tabular-nums">
        {span.end ? moment(end) : "still held"}
      </dd>
      <dt className="text-ink-faint">Ended</dt>
      <dd className="m-0">
        {span.endedBy ? SPAN_END_LABEL[span.endedBy] : "Not yet"}
        {span.endedById && (
          <span className="text-ink-faint"> by {actorText(data.actors, span.endedById)}</span>
        )}
      </dd>
      <dt className="text-ink-faint">Worked</dt>
      <dd className="m-0 font-mono text-mono tabular-nums">
        {duration(worked)}
        {span.renewals.length > 0 && (
          <span className="font-sans text-micro text-ink-faint">
            {" "}
            · {span.renewals.length} renewal{span.renewals.length === 1 ? "" : "s"}
          </span>
        )}
      </dd>
      {span.parked.length > 0 && (
        <>
          <dt className="text-ink-faint">Waited</dt>
          <dd className="m-0">
            {duration(
              span.parked.reduce((sum, p) => sum + ((p.to ? time(p.to) : end) - time(p.from)), 0),
            )}{" "}
            on a person
          </dd>
        </>
      )}
      {span.retained && (
        <>
          <dt className="text-ink-faint">Retained</dt>
          <dd className="m-0">
            from {moment(time(span.retained.at))}, until{" "}
            <span className="font-mono">{span.retained.timeline.slug}</span> landed
          </dd>
        </>
      )}
    </dl>
  );
}
