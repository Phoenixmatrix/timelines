// The Chronicle's side column (CORE-251): with nothing selected, the range
// summary (statuses at its start and end, what completed, who worked how
// long, what waits); with an issue or a work span selected, the inspector:
// its state as of the playhead, its changes, spans and markers in the
// range, and its linked work, each item opening its existing page.

import { ArrowSquareOutIcon, XIcon } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import {
  actorText,
  MARKER_LABEL,
  SPAN_END_LABEL,
  summarize,
  workedMs,
  type ChronicleIssue,
  type LinkedWork,
  type WorkSpan,
} from "../../../shared/chronicle.ts";
import type { AuditActor, IssueStatus } from "../../../shared/tracker.ts";
import { Tip } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { Actor } from "./Actor.tsx";
import type { Loaded } from "./chronicleData.ts";
import {
  duration,
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
                <span className="min-w-0 flex-1 truncate text-ink">{issue.title}</span>
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
  owner,
  issue,
  span,
  data,
  at,
  now,
  closeHref,
  spanHref,
  openIssueHref,
}: {
  owner: string;
  issue: ChronicleIssue;
  span: WorkSpan | null;
  data: Loaded;
  at: number;
  now: number;
  closeHref: string;
  spanHref: (span: WorkSpan) => string;
  openIssueHref: string;
}) {
  const state = stateAsOf(issue, at, now);
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
      {issue.markers.length > 0 && (
        <div>
          <h3 className="m-0 mb-1 text-label text-ink-muted">What happened</h3>
          <ol className="m-0 flex list-none flex-col gap-1.5 p-0 text-body-sm">
            {issue.markers.map((m) => (
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
      <LinkedWorkPanel owner={owner} issue={issue} span={span} now={now} />
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

type WorkState =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; work: LinkedWork };

/** Linked work, loaded when an issue opens; with a span, what falls inside it first. */
function LinkedWorkPanel({
  owner,
  issue,
  span,
  now,
}: {
  owner: string;
  issue: ChronicleIssue;
  span: WorkSpan | null;
  now: number;
}) {
  const [work, setWork] = useState<WorkState>({ state: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    setWork({ state: "loading" });
    api<LinkedWork>(
      `/tracker/${encodeURIComponent(owner)}/issues/${encodeURIComponent(issue.id)}/work`,
      { signal: controller.signal },
    )
      .then((value) => setWork({ state: "ready", work: value }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setWork({
          state: "error",
          message:
            cause instanceof ApiError ? cause.message : "Couldn't load this issue's linked work.",
        });
      });
    return () => controller.abort();
  }, [owner, issue.id]);

  if (work.state === "loading")
    return (
      <div aria-busy="true" className="flex flex-col gap-2">
        <h3 className="m-0 text-label text-ink-muted">Linked work</h3>
        <div className="h-16 animate-pulse rounded-plate bg-surface motion-reduce:animate-none" />
      </div>
    );
  if (work.state === "error")
    return (
      <div>
        <h3 className="m-0 mb-1 text-label text-ink-muted">Linked work</h3>
        <p className="m-0 text-body-sm text-danger-text">{work.message}</p>
      </div>
    );
  const w = work.work;
  // With a span: what was made while it held (and shortly after), first.
  const during = (at: string | null) => {
    if (!span || !at) return true;
    const t = time(at);
    const end = span.end ? time(span.end) : now;
    return t >= time(span.start) - 5 * 60_000 && t <= end + 60 * 60_000;
  };
  const items: {
    group: string;
    key: string;
    label: string;
    meta: string;
    href: string;
    at: string | null;
    external?: boolean;
  }[] = [
    ...w.steps.map((s) => ({
      group: "Agent work",
      key: `step:${s.repo.id}:${s.commitOid}`,
      label: s.summary || s.commitOid.slice(0, 10),
      meta: `${s.repo.owner}/${s.repo.name} · ${s.commitOid.slice(0, 7)} · ${s.author.name ?? s.author.id}${s.verified ? "" : " · unverified"}`,
      href: s.href,
      at: s.committedAt,
    })),
    ...w.commits.map((c) => ({
      group: "Commits",
      key: `commit:${c.repo.id}:${c.oid}`,
      label: c.summary ?? `Commit ${c.oid.slice(0, 7)}`,
      meta: `${c.repo.owner}/${c.repo.name} · ${c.oid.slice(0, 7)} · ${c.sources.join(", ")}`,
      href: c.href,
      at: c.at,
    })),
    ...w.runs.map((r) => ({
      group: "CI runs",
      key: `run:${r.repo.id}:${r.number}`,
      label: `Run #${r.number} ${r.title ? `· ${r.title}` : ""}`,
      meta: `${r.repo.owner}/${r.repo.name} · ${r.status} · ${r.kind}`,
      href: r.href,
      at: r.createdAt,
    })),
    ...w.deployments.map((d) => ({
      group: "Deployments",
      key: `deploy:${d.id}`,
      label: d.environment,
      meta: `${d.repo.owner}/${d.repo.name} · ${d.status} · ${d.commit.slice(0, 7)}`,
      href: d.href,
      at: d.createdAt,
      external: /^https?:/.test(d.href),
    })),
    ...w.packages.map((p) => ({
      group: "Packages",
      key: `package:${p.format}:${p.name}:${p.version}`,
      label: `${p.name}@${p.version}`,
      meta: `${p.format} · from ${p.commit.slice(0, 7)}`,
      href: p.href,
      at: p.at,
    })),
    ...w.timelines.flatMap((t) => [
      ...t.checkpoints.map((cp) => ({
        group: "Timelines",
        key: `cp:${cp.id}`,
        label: `${t.slug} · checkpoint #${cp.number}`,
        meta: `${cp.approval ?? "no approval"}${cp.summary ? ` · ${cp.summary}` : ""}`,
        href: cp.href,
        at: cp.createdAt,
      })),
      ...t.landings.map((l) => ({
        group: "Timelines",
        key: `landing:${l.id}`,
        label: `${t.slug} · landing of #${l.checkpointNumber}`,
        meta: l.state,
        href: l.href,
        at: l.updatedAt,
      })),
      ...(t.checkpoints.length || t.landings.length
        ? []
        : [
            {
              group: "Timelines",
              key: `timeline:${t.id}`,
              label: t.name || t.slug,
              meta: t.status,
              href: t.href,
              at: null,
            },
          ]),
    ]),
    ...w.releaseNotes.map((n) => ({
      group: "Release notes",
      key: `note:${n.repo.id}:${n.release}:${n.title}`,
      label: n.title,
      meta: `${n.repo.owner}/${n.repo.name} · ${n.label} · ${n.category}`,
      href: n.href,
      at: n.shippedAt,
    })),
  ];
  const groups = [
    "Agent work",
    "Commits",
    "CI runs",
    "Deployments",
    "Packages",
    "Timelines",
    "Release notes",
  ];
  const list = (subset: typeof items) =>
    groups
      .map((group) => ({ group, entries: subset.filter((item) => item.group === group) }))
      .filter((g) => g.entries.length);
  const inSpan = span ? items.filter((item) => during(item.at)) : items;
  const rest = span ? items.filter((item) => !during(item.at)) : [];
  const render = (subset: typeof items, heading: string) => (
    <div className="flex flex-col gap-3">
      <h3 className="m-0 text-label text-ink-muted">{heading}</h3>
      {list(subset).map(({ group, entries }) => (
        <div key={group}>
          <h4 className="m-0 mb-0.5 px-2 text-micro font-semibold text-ink-faint">{group}</h4>
          <ul className="m-0 flex list-none flex-col p-0">
            {entries.map((item) => {
              const body = (
                <>
                  <span className="flex items-center gap-1 truncate text-ink">
                    {item.label}
                    {item.external && (
                      <ArrowSquareOutIcon
                        className="size-3.5 shrink-0 text-ink-faint"
                        aria-hidden
                      />
                    )}
                  </span>
                  <span className="block truncate text-micro text-ink-faint">{item.meta}</span>
                </>
              );
              const cls =
                "block rounded-plate px-2 py-1 text-body-sm no-underline hover:bg-raised max-sm:py-2";
              return (
                <li key={item.key} data-linked-work={item.group}>
                  {item.external ? (
                    <a href={item.href} target="_blank" rel="noreferrer" className={cls}>
                      {body}
                    </a>
                  ) : (
                    <Link to={item.href} className={cls}>
                      {body}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
  if (!items.length)
    return (
      <div>
        <h3 className="m-0 mb-1 text-label text-ink-muted">Linked work</h3>
        <p className="m-0 max-w-[44ch] px-2 text-body-sm text-ink-faint">
          Nothing names {issue.key} yet: no step context, release-note entry or timeline that worked
          it. Steps link to an issue when <code className="mk-mono">gm</code> records the commit's
          context with the issue it was for.
        </p>
      </div>
    );
  return (
    <div className="flex flex-col gap-4" data-chronicle-linked-work>
      {span ? (
        <>
          {inSpan.length > 0 ? (
            render(inSpan, "Linked work during this span")
          ) : (
            <p className="m-0 px-2 text-body-sm text-ink-faint">
              Nothing linked was made during this span.
            </p>
          )}
          {rest.length > 0 && render(rest, "Other linked work")}
        </>
      ) : (
        render(items, "Linked work")
      )}
      {w.truncated && (
        <p className="m-0 px-2 text-micro text-ink-faint">Showing the newest of each kind.</p>
      )}
    </div>
  );
}
