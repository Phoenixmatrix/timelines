// The Chronicle as a list (CORE-251): the same rows as the timeline, in
// words. It is the phone layout and the accessible equivalent of the canvas:
// each issue's state at the range's start, as of the playhead and at the
// end, a mini bar of its work spans, and every span as a link.

import { Link } from "react-router";
import { SPAN_END_LABEL, actorText, type WorkSpan } from "../../../shared/chronicle.ts";
import type { Loaded } from "./chronicleData.ts";
import { duration, stamp, stateAsOf, type Row } from "./chronicleModel.ts";
import { STATE_LABEL } from "./query.ts";
import { StateDot } from "./Log.tsx";

const time = (iso: string) => Date.parse(iso);

export function ChronicleList({
  data,
  rows,
  window: view,
  at,
  now,
  selection,
  issueHref,
  spanHref,
}: {
  data: Loaded;
  rows: Row[];
  window: { from: number; to: number };
  at: number;
  now: number;
  selection: { issue: string | null; span: string | null };
  issueHref: (id: string) => string;
  spanHref: (span: WorkSpan) => string;
}) {
  const end = Math.min(view.to, now);
  const pct = (t: number) =>
    `${(Math.max(0, Math.min(1, (t - view.from) / (view.to - view.from))) * 100).toFixed(2)}%`;
  const word = (state: ReturnType<typeof stateAsOf>) =>
    state ? STATE_LABEL[state] : "Not created";
  const out: React.ReactNode[] = [];
  let group: { label: string; items: React.ReactNode[] } | null = null;
  const flush = () => {
    if (!group) return;
    out.push(
      <section key={group.label} aria-label={group.label} className="flex flex-col">
        <h3 className="sticky top-0 z-[1] m-0 bg-surface px-3 py-1.5 text-label text-ink-muted">
          {group.label}
        </h3>
        <ul className="m-0 flex list-none flex-col p-0">{group.items}</ul>
      </section>,
    );
  };
  for (const row of rows) {
    if (row.kind === "group") {
      flush();
      group = { label: `${row.label} · ${row.count}`, items: [] };
      continue;
    }
    const issue = row.issue;
    const atState = stateAsOf(issue, at, now);
    const startState = stateAsOf(issue, view.from, now);
    const endState = stateAsOf(issue, end, now);
    const selected = selection.issue === issue.id;
    group?.items.push(
      <li
        key={issue.id}
        className={`flex flex-col gap-1.5 border-b border-line-soft px-3 py-2.5 ${selected ? "bg-signal-wash" : ""}`}
        data-chronicle-item={issue.key}
        data-state={atState ?? "none"}
      >
        <Link
          to={issueHref(issue.id)}
          preventScrollReset
          aria-current={selected ? "true" : undefined}
          className="flex min-h-8 items-center gap-2 no-underline max-sm:min-h-11"
        >
          {atState ? (
            <StateDot state={atState} />
          ) : (
            <span className="size-2 rounded-full border border-line" aria-hidden />
          )}
          <span className="font-mono text-mono text-ink-muted">{issue.key}</span>
          <span className="min-w-0 flex-1 truncate text-body-sm font-semibold text-ink">
            {issue.title}
          </span>
        </Link>
        <p className="m-0 flex flex-wrap gap-x-3 text-micro text-ink-faint">
          <span>
            Start <span className="text-ink-muted">{word(startState)}</span>
          </span>
          <span>
            As of playhead <span className="text-ink">{word(atState)}</span>
          </span>
          <span>
            End <span className="text-ink-muted">{word(endState)}</span>
          </span>
        </p>
        {/* A picture of the spans across the window; the links below say the same. */}
        <div className="relative h-2 rounded-full bg-sunken" aria-hidden>
          {issue.spans.map((span) => {
            const a = time(span.start);
            const b = span.end ? time(span.end) : now;
            return (
              <span
                key={span.id}
                className={`absolute top-0 h-2 min-w-1 rounded-full ${span.id === selection.span ? "bg-signal" : span.retained ? "bg-line" : "bg-ink-muted"}`}
                style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }}
              />
            );
          })}
          {at >= view.from && at <= view.to && (
            <span
              className="absolute -top-0.5 h-3 w-0.5 bg-signal-line"
              style={{ left: pct(at) }}
            />
          )}
        </div>
        {issue.spans.length > 0 && (
          <ul className="m-0 flex list-none flex-col p-0" aria-label={`${issue.key} work spans`}>
            {issue.spans.map((span) => {
              const b = span.end ? time(span.end) : now;
              return (
                <li key={span.id}>
                  <Link
                    to={spanHref(span)}
                    preventScrollReset
                    aria-current={span.id === selection.span ? "true" : undefined}
                    data-chronicle-span={span.id}
                    className="flex min-h-8 flex-wrap items-center gap-x-2 rounded-plate px-1 text-body-sm no-underline hover:bg-raised aria-[current=true]:bg-signal-wash max-sm:min-h-11"
                  >
                    <span className="min-w-0 truncate text-ink">
                      {actorText(data.actors, span.holder)}
                    </span>
                    <span className="font-mono text-micro text-ink-faint tabular-nums">
                      {stamp(time(span.start))} · {duration(b - time(span.start))}
                    </span>
                    <span className="text-micro text-ink-muted">
                      {span.endedBy ? SPAN_END_LABEL[span.endedBy] : "Still held"}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {issue.markers.length > 0 && (
          <p className="m-0 text-micro text-ink-faint">
            {issue.markers.length} event{issue.markers.length === 1 ? "" : "s"} in range
          </p>
        )}
      </li>,
    );
  }
  flush();
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto rounded-pane bg-pane"
      role="region"
      aria-label="Issues over time, as a list"
      data-chronicle-list
    >
      {out}
    </div>
  );
}
