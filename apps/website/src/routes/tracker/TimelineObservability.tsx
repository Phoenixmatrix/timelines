// A timeline as a trace (CORE-396): under the lane graph, the selected
// timeline's vitals, its steps as spans in one lane per author over time
// (health from their checks, a ring where a person steered, checkpoints and
// previews above), new steps arriving from the live feed, and an inspector
// for the span you pick: why, the steering word for word, CI's jobs by
// duration, and the way into Story. Built from the steps, checkpoints and
// live feed APIs; timelineSpans.ts is the model.

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { StepFeedRecord, StepPage } from "../../../shared/steps.ts";
import type { CheckpointList, CheckpointView, Timeline } from "../../../shared/timelines.ts";
import { link } from "../../components/ui.tsx";
import { api, ApiError } from "../../lib/api.ts";
import { fullDate, shortOid, timeAgo } from "../../lib/format.ts";
import {
  domainOf,
  lanesOf,
  mergeSpans,
  spanFromFeed,
  givenAt,
  spanFromStep,
  steeredAt,
  tickLabel,
  ticksOf,
  vitalsOf,
  jobBars,
  type Health,
  type Span,
} from "./timelineSpans.ts";

/** Newest steps read per repository. */
const PAGES = 2;
/** How long a span that just arrived is marked new. */
const FRESH_MS = 15_000;

const HEALTH: Record<Health, { color: string; word: string }> = {
  pass: { color: "var(--online)", word: "checks pass" },
  fail: { color: "var(--danger-text)", word: "a check failed" },
  none: { color: "var(--ink-faint)", word: "no checks recorded" },
};

/** A repository's steps API, by its Space/name. */
const stepsPath = (repo: string, query: URLSearchParams) => {
  const [o, n] = repo.split("/");
  return `/repos/${encodeURIComponent(o!)}/${encodeURIComponent(n!)}/steps?${query}`;
};

/** A repository the viewer can't read: nothing to show, not a failure. */
const unreadable = (failure: unknown) =>
  failure instanceof ApiError && [401, 403, 404].includes(failure.status);

interface Loaded {
  spans: Map<string, Span>;
  /** Steps an admin removed: their feed records stay hidden too. */
  deleted: Set<string>;
  /** Repositories with older steps than were read. */
  truncated: string[];
  /** Repositories whose steps couldn't be read. */
  failed: string[];
  /** Repositories the viewer can't read: left out, not failures. */
  skipped: string[];
}

/**
 * The timeline's steps: the newest pages of each repository, then, for each
 * commit the live feed brings that isn't among them, that commit's step, once.
 */
function useSpans(
  space: string,
  timeline: Timeline,
  feed: StepFeedRecord[],
  removed: ReadonlySet<string>,
) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [checkpoints, setCheckpoints] = useState<CheckpointView[]>([]);
  const repos = timeline.repos.map((r) => `${r.space}/${r.name}`).join(",");
  useEffect(() => {
    const abort = new AbortController();
    const signal = abort.signal;
    void (async () => {
      const out: Loaded = {
        spans: new Map(),
        deleted: new Set(),
        truncated: [],
        failed: [],
        skipped: [],
      };
      for (const repo of repos ? repos.split(",") : []) {
        try {
          let cursor: string | null = null;
          for (let page = 0; page < PAGES; page++) {
            const query = new URLSearchParams({ timeline: timeline.slug, limit: "100" });
            if (cursor) query.set("cursor", cursor);
            const got: StepPage = await api<StepPage>(stepsPath(repo, query), { signal });
            take(out, repo, got);
            cursor = got.cursor;
            if (!cursor) break;
          }
          if (cursor) out.truncated.push(repo);
        } catch (failure) {
          if (signal.aborted) return;
          (unreadable(failure) ? out.skipped : out.failed).push(repo);
        }
      }
      if (!signal.aborted) setLoaded(out);
    })();
    return () => abort.abort();
  }, [timeline.slug, repos]);

  // What the feed brings that isn't loaded: those commits' steps, each asked for once.
  const asked = useRef(new Set<string>());
  const wanted = loaded
    ? feed
        .map((record) => `${record.repo}@${record.commitOid}`)
        .filter((key) => !loaded.spans.has(key) && !loaded.deleted.has(key) && !removed.has(key))
        .join(",")
    : "";
  useEffect(() => {
    const keys = wanted ? wanted.split(",").filter((key) => !asked.current.has(key)) : [];
    if (!keys.length) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      const byRepo = new Map<string, string[]>();
      for (const key of keys) {
        const [repo, oid] = key.split("@") as [string, string];
        byRepo.set(repo, [...(byRepo.get(repo) ?? []), oid]);
      }
      for (const [repo, oids] of byRepo) {
        const query = new URLSearchParams({ commits: oids.join(","), limit: "100" });
        api<StepPage>(stepsPath(repo, query), { signal: abort.signal })
          .then((got) => {
            // An abort can cut off the body: nothing to take.
            if (abort.signal.aborted || !got?.steps) return;
            setLoaded((prev) => {
              if (!prev) return prev;
              const next = { ...prev, spans: new Map(prev.spans), deleted: new Set(prev.deleted) };
              take(next, repo, got);
              return next;
            });
          })
          // Shown from the feed until the page is opened again.
          .catch(() => {})
          .finally(() => {
            // Answered (or failed): never asked again. Cancelled: asked next time.
            if (!abort.signal.aborted) for (const oid of oids) asked.current.add(`${repo}@${oid}`);
          });
      }
    }, 2_000);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [wanted]);

  // Checkpoints: on opening, and again a little after each new step (a checkpoint follows a push).
  // The newest record, not the count: the feed keeps a fixed number.
  const steps = feed[0] ? `${feed[0].repo}#${feed[0].seq}` : "";
  useEffect(() => {
    const abort = new AbortController();
    const timer = setTimeout(
      () => {
        api<CheckpointList>(
          `/tracker/${encodeURIComponent(space)}/timelines/${encodeURIComponent(timeline.slug)}/checkpoints`,
          { signal: abort.signal },
        )
          .then((list) => setCheckpoints(list.checkpoints))
          .catch(() => {});
      },
      steps ? 5_000 : 0,
    );
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [timeline.slug, space, steps]);
  return { loaded, checkpoints };
}

const NONE: ReadonlySet<string> = new Set();

/** Adds a page of steps to what's loaded: the deleted ones as such. */
function take(into: Loaded, repo: string, page: StepPage) {
  for (const step of page.steps) {
    const key = `${repo}@${step.commitOid}`;
    if (step.deleted) {
      into.deleted.add(key);
      into.spans.delete(key);
    } else into.spans.set(key, spanFromStep(repo, step));
  }
}

export function TimelineObservability({
  space,
  timeline,
  feed,
  removed = NONE,
}: {
  space: string;
  timeline: Timeline;
  /** The timeline's live feed records, newest first (useStepFeed). */
  feed: StepFeedRecord[];
  /** Steps the feed said were deleted since the page opened (CORE-399): hidden, even if loaded. */
  removed?: ReadonlySet<string>;
}) {
  const { loaded, checkpoints } = useSpans(space, timeline, feed, removed);
  const spans = useMemo(
    () =>
      loaded
        ? mergeSpans(
            [...loaded.spans.values()].filter((span) => !removed.has(span.key)),
            feed
              .filter((record) => !loaded.deleted.has(`${record.repo}@${record.commitOid}`))
              .map(spanFromFeed),
          )
        : [],
    [loaded, feed, removed],
  );
  // Every repository the viewer can read failed: nothing to show but that.
  const everyRepoFailed =
    !!loaded &&
    loaded.failed.length > 0 &&
    loaded.failed.length + loaded.skipped.length === timeline.repos.length;
  // What arrived after the first load, and when, to mark it new.
  const first = useRef<Set<string> | null>(null);
  const [arrived, setArrived] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!loaded) return;
    if (!first.current) {
      first.current = new Set(spans.map((span) => span.key));
      return;
    }
    const seen = first.current;
    const fresh = spans.filter((span) => !seen.has(span.key));
    if (!fresh.length) return;
    for (const span of fresh) seen.add(span.key);
    const at = Date.now();
    setArrived((prev) => new Map([...prev, ...fresh.map((span) => [span.key, at] as const)]));
  }, [loaded, spans]);
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 5_000);
    return () => clearInterval(timer);
  }, []);
  const [selectedKey, setSelected] = useState<string | null>(null);
  const open = timeline.status !== "landed" && timeline.status !== "abandoned";
  // While open, the trace runs to now, which moves with the tick.
  const domain = domainOf(spans, checkpoints, open ? Date.now() : null);
  const lanes = useMemo(() => lanesOf(spans), [spans]);
  const vitals = useMemo(() => vitalsOf(spans, checkpoints), [spans, checkpoints]);
  const newest = spans.at(-1) ?? null;
  const selected = spans.find((span) => span.key === selectedKey) ?? newest;
  const latestArrival = [...arrived.entries()].sort((a, b) => b[1] - a[1])[0];
  const announce = latestArrival && spans.find((span) => span.key === latestArrival[0]);
  const story = `/tracker/${encodeURIComponent(space)}/timelines/${encodeURIComponent(timeline.slug)}/story`;
  const pos = (at: number) => ((at - domain[0]) / (domain[1] - domain[0])) * 100;
  const x = (at: number) => `${pos(at).toFixed(3)}%`;

  return (
    <section aria-label="Observability" className="flex min-w-0 flex-col gap-4">
      <p className="sr-only" aria-live="polite">
        {announce ? `New step from ${announce.author.name}: ${announce.summary}` : ""}
      </p>
      <dl
        aria-label="Vitals"
        // Hairline separators from the gap, however the cells wrap.
        className="m-0 grid grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))] gap-px overflow-hidden rounded-pane bg-line-soft"
      >
        <Vital label="steps" value={vitals.steps} />
        <Vital
          label={`checks passing${vitals.checks.passed + vitals.checks.failed ? ` (${vitals.checks.passed} of ${vitals.checks.passed + vitals.checks.failed})` : ""}`}
          value={
            vitals.checks.passed + vitals.checks.failed
              ? `${Math.round((vitals.checks.passed / (vitals.checks.passed + vitals.checks.failed)) * 100)}%`
              : "–"
          }
          tone={vitals.checks.failed ? "var(--danger-text)" : undefined}
        />
        <Vital label="times a person steered" value={vitals.steered} />
        <Vital
          label="steps that say why"
          value={vitals.steps ? `${Math.round((vitals.withIntent / vitals.steps) * 100)}%` : "–"}
        />
        <Vital
          label={vitals.previewLive ? "checkpoints, preview live" : "checkpoints"}
          value={vitals.checkpoints}
        />
        <Vital label={vitals.agents === 1 ? "author" : "authors"} value={vitals.agents} />
      </dl>

      <div className="min-w-0 rounded-pane bg-pane p-4">
        <div className="mb-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h3 className="m-0 text-body font-semibold">Spans by author</h3>
          <span className="text-body-sm text-ink-faint">
            Each mark is a step, placed when it was committed.
          </span>
          <ul className="m-0 ml-auto flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-micro text-ink-muted">
            {(["pass", "fail", "none"] as const).map((health) => (
              <li key={health} className="flex items-center gap-1.5">
                <span
                  className="inline-block size-2.5 rounded-full"
                  style={{ background: HEALTH[health].color }}
                />
                {HEALTH[health].word}
              </li>
            ))}
            <li className="flex items-center gap-1.5">
              <span
                className="inline-block size-2.5 rounded-full border-2"
                style={{ borderColor: "var(--timelines-amber)" }}
              />
              a person steered
            </li>
            <li className="flex items-center gap-1.5">
              <span
                className="inline-block h-3 w-[3px] rounded-full"
                style={{ background: "var(--timelines-amber)" }}
              />
              when they did
            </li>
          </ul>
        </div>
        {everyRepoFailed ? (
          <p className="mk-error m-0" role="alert">
            Couldn't read this timeline's steps. Refresh to try again.
          </p>
        ) : !loaded ? (
          <p className="m-0 text-body-sm text-ink-faint">Reading the timeline's steps…</p>
        ) : spans.length === 0 ? (
          <p className="m-0 max-w-[60ch] text-body-sm text-ink-muted">
            No steps on this timeline yet. Each <span className="mk-mono">gm step</span> or{" "}
            <span className="mk-mono">gm commit --context</span> an agent makes here appears as it
            lands, with why it was made and how its checks went.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <div className="grid min-w-[40rem] grid-cols-[8.5rem_minmax(0,1fr)] gap-y-1">
              <span className="self-center text-micro text-ink-faint">Checkpoints</span>
              <div className="relative h-7" aria-label="Checkpoints" role="list">
                {checkpoints.map((view) => {
                  const at = Date.parse(view.checkpoint.createdAt);
                  // Near the end, the label reads leftward so it isn't cut off.
                  const late = (at - domain[0]) / (domain[1] - domain[0]) > 0.8;
                  const preview = view.previews.some((p) => p.status === "active");
                  const asked = view.approval?.state === "pending";
                  const label = `Checkpoint #${view.checkpoint.number}${preview ? ", preview live" : ""}${asked ? ", approval asked" : view.approval?.state === "approved" ? ", approved" : ""}`;
                  return (
                    <span
                      key={view.checkpoint.id}
                      role="listitem"
                      aria-label={label}
                      title={`${label} · ${fullDate(view.checkpoint.createdAt)}`}
                      className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-1 whitespace-nowrap text-micro text-ink-muted ${late ? "-translate-x-[calc(100%-0.3125rem)] flex-row-reverse" : "-translate-x-[0.3125rem]"}`}
                      style={{ left: x(at) }}
                    >
                      <span
                        aria-hidden
                        className="inline-block size-2.5 rotate-45 rounded-[2px]"
                        style={{ background: "var(--signal)" }}
                      />
                      <span>
                        #{view.checkpoint.number}
                        {preview && <span className="text-ink-faint"> preview</span>}
                      </span>
                    </span>
                  );
                })}
              </div>
              {lanes.map((lane) => (
                <Lane
                  key={lane.author.id}
                  name={lane.author.name}
                  kind={lane.author.kind}
                  spans={lane.spans}
                  pos={pos}
                  selected={selected?.key ?? null}
                  fresh={(key) => (arrived.get(key) ?? 0) > Date.now() - FRESH_MS}
                  onSelect={setSelected}
                />
              ))}
              <span />
              <div className="relative h-5" aria-hidden>
                {ticksOf(domain).map((at) => (
                  <span
                    key={at}
                    className="absolute top-0 -translate-x-1/2 whitespace-nowrap font-mono text-micro text-ink-faint"
                    style={{ left: x(at) }}
                  >
                    {tickLabel(at, domain)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {loaded &&
        (loaded.truncated.length > 0 || (loaded.failed.length > 0 && !everyRepoFailed)) && (
          <p className="-mt-2 mb-0 text-micro text-ink-faint">
            {loaded.truncated.length > 0 &&
              `Counting the newest ${PAGES * 100} steps in ${loaded.truncated.join(", ")}; Story has them all. `}
            {loaded.failed.length > 0 &&
              !everyRepoFailed &&
              `Couldn't read the steps in ${loaded.failed.join(", ")}.`}
          </p>
        )}
      {selected && (
        <Inspector span={selected} story={story} multiRepo={timeline.repos.length > 1} />
      )}
    </section>
  );
}

function Vital({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex min-w-0 flex-col-reverse gap-0.5 bg-pane p-3">
      <dt className="text-micro text-ink-faint">{label}</dt>
      <dd
        className="m-0 text-title font-bold tabular-nums"
        style={tone ? { color: tone } : undefined}
      >
        {value}
      </dd>
    </div>
  );
}

function Lane({
  name,
  kind,
  spans,
  pos,
  selected,
  fresh,
  onSelect,
}: {
  name: string;
  kind: "agent" | "person";
  spans: Span[];
  /** Where a time falls across the lane, in percent. */
  pos: (at: number) => number;
  selected: string | null;
  fresh: (key: string) => boolean;
  onSelect: (key: string) => void;
}) {
  // Steps closer than a target's width step up or down a row, so each stays
  // clickable; with every row taken, the one free longest.
  const track = useRef<HTMLOListElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const element = track.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width || 600));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const apart = (26 / width) * 100;
  const rows = [0, -1, 1];
  const last = rows.map(() => -Infinity);
  const placed = spans.map((span) => {
    const at = pos(span.at);
    let r = rows.findIndex((_, i) => at - last[i]! >= apart);
    if (r < 0) r = last.indexOf(Math.min(...last));
    last[r] = at;
    return { span, at, offset: rows[r]! };
  });
  return (
    <>
      <div className="min-w-0 self-center">
        <div className="truncate text-body-sm font-semibold">{name}</div>
        <div className="text-micro text-ink-faint">
          {kind === "agent" ? "agent" : "person"} · {spans.length}{" "}
          {spans.length === 1 ? "step" : "steps"}
        </div>
      </div>
      <ol ref={track} className="relative m-0 h-16 list-none p-0" aria-label={`${name}'s steps`}>
        <li
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-line-soft"
        />
        {spans.flatMap((span) =>
          steeredAt(span).map((moment, n) => (
            <li
              key={`${span.key}#${n}`}
              aria-hidden
              title={`Steered ${clock(moment.at)}: ${moment.text}`}
              className="absolute top-1/2 h-6 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full opacity-80"
              style={{
                left: `${pos(moment.at).toFixed(3)}%`,
                background: "var(--timelines-amber)",
              }}
            />
          )),
        )}
        {placed.map(({ span, at, offset }) => {
          const steered = span.steering.length > 0;
          const isNew = fresh(span.key);
          const moments = steeredAt(span).map((moment) => clock(moment.at));
          const label = `${span.summary}, ${HEALTH[span.health].word}${steered ? `, steered ${span.steering.length === 1 ? "once" : `${span.steering.length} times`}${moments.length ? ` (at ${moments.join(", ")})` : ""}` : ""}, ${timeAgo(new Date(span.at).toISOString())}${isNew ? ", new" : ""}`;
          return (
            <li
              key={span.key}
              className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${at.toFixed(3)}%`, marginTop: `${offset * 1.125}rem` }}
            >
              {/* A 24px target around a 14px mark. */}
              <button
                type="button"
                aria-label={label}
                aria-pressed={selected === span.key}
                title={label}
                onClick={() => onSelect(span.key)}
                className="group relative grid size-6 cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0"
              >
                {isNew && (
                  <span
                    aria-hidden
                    className="absolute inset-1 rounded-full motion-safe:animate-ping"
                    style={{ background: HEALTH[span.health].color, opacity: 0.6 }}
                  />
                )}
                <span
                  aria-hidden
                  className="relative block size-3.5 rounded-full group-aria-pressed:ring-2 group-aria-pressed:ring-ink group-aria-pressed:ring-offset-2 group-aria-pressed:ring-offset-pane"
                  style={{
                    background: HEALTH[span.health].color,
                    boxShadow: steered
                      ? "0 0 0 2px var(--pane), 0 0 0 4px var(--timelines-amber)"
                      : undefined,
                  }}
                />
              </button>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/** The span you picked: why, the steering word for word, CI's jobs, and the way into Story. */
function Inspector({ span, story, multiRepo }: { span: Span; story: string; multiRepo: boolean }) {
  const at = new Date(span.at).toISOString();
  const jobs = span.ci ? jobBars(span.ci.jobs) : [];
  const longest = Math.max(0, ...jobs.map(({ ms }) => ms));
  const params = new URLSearchParams({ step: span.commitOid, repo: span.repo });
  const heading = "mt-3 mb-1 text-body-sm font-semibold text-ink-muted";
  return (
    <section
      aria-label="Span"
      className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
    >
      <div className="min-w-0 rounded-pane bg-pane p-4">
        <h3 className="m-0 text-body font-semibold [overflow-wrap:anywhere]">{span.summary}</h3>
        <p className="mt-1 mb-0 flex flex-wrap gap-x-3 text-body-sm text-ink-faint">
          <span>{span.author.name}</span>
          <time dateTime={at} title={fullDate(at)}>
            {timeAgo(at)}
          </time>
          <span className="mk-mono">{shortOid(span.commitOid)}</span>
          {multiRepo && <span>{span.repo}</span>}
          {(span.harness || span.model) && (
            <span>{[span.harness, span.model].filter(Boolean).join(" running ")}</span>
          )}
          {span.issue && <span className="mk-chip mk-chip--tag">{span.issue}</span>}
        </p>
        <h4 className={heading}>Why</h4>
        <p className="m-0 max-w-[72ch] text-body-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {span.why.trim() || <span className="text-ink-faint">The step doesn't say why.</span>}
        </p>
        {span.instructions.length > 0 && (
          <>
            <h4 className={heading}>Asked to</h4>
            <ul className="m-0 max-w-[72ch] pl-4 text-body-sm">
              {span.instructions.slice(0, 3).map((entry, n) => (
                <li key={n} className="[overflow-wrap:anywhere]">
                  {entry.text} <When at={givenAt(entry)} />
                </li>
              ))}
            </ul>
            {span.instructions.length > 3 && (
              <p className="m-0 text-micro text-ink-faint">
                {span.instructions.length - 3} more in Story.
              </p>
            )}
          </>
        )}
        <h4 className={heading}>Steering</h4>
        {span.steering.length ? (
          <ul className="m-0 flex max-w-[72ch] list-none flex-col gap-1.5 p-0">
            {span.steering.map((entry, n) => (
              <li
                key={n}
                className="border-l-2 pl-3 text-body-sm [overflow-wrap:anywhere]"
                style={{ borderColor: "var(--timelines-amber)" }}
              >
                {entry.source === "agent" ? entry.text : `“${entry.text}”`}{" "}
                <span className="text-micro text-ink-faint">
                  {entry.source === "agent"
                    ? "as the agent recorded it"
                    : entry.source === "hook"
                      ? "captured by the harness"
                      : "from a person"}
                </span>{" "}
                <When at={givenAt(entry)} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-body-sm text-ink-faint">
            {span.partial ? "Loading this step's context…" : "Nobody steered this step."}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Link className="mk-btn mk-btn--primary mk-btn--sm" to={`${story}?${params}`}>
            Open in Story
          </Link>
        </div>
      </div>
      <div className="min-w-0 rounded-pane bg-pane p-4">
        <h3 className="m-0 text-body font-semibold">Health</h3>
        {span.ci ? (
          <>
            <p className="mt-1 mb-2 text-body-sm text-ink-faint">
              CI step run:{" "}
              <span
                style={{
                  color:
                    span.ci.status === "failed"
                      ? "var(--danger-text)"
                      : span.ci.status === "succeeded"
                        ? "var(--online)"
                        : "var(--ink-muted)",
                }}
              >
                {span.ci.status}
              </span>
              {longest > 0 && ` · its longest job took ${duration(longest)}`}
            </p>
            <ol aria-label="CI jobs" className="m-0 flex list-none flex-col gap-1.5 p-0">
              {jobs.map(({ job, ms, share }) => (
                <li
                  key={job.name}
                  className="grid grid-cols-[8.5rem_minmax(0,1fr)_4rem] items-center gap-2 text-body-sm"
                >
                  <span className="truncate font-mono text-micro text-ink-muted">{job.name}</span>
                  <span className="relative h-2.5 rounded bg-sunken" aria-hidden>
                    {ms > 0 && (
                      <span
                        className="absolute inset-y-0 left-0 rounded"
                        style={{
                          width: `${Math.max(share * 100, 1)}%`,
                          background:
                            job.status === "failed"
                              ? "var(--danger-text)"
                              : job.status === "succeeded"
                                ? "var(--online)"
                                : "var(--ink-faint)",
                        }}
                      />
                    )}
                  </span>
                  <span className="text-right font-mono text-micro text-ink-faint tabular-nums">
                    {job.status === "succeeded" || job.status === "failed"
                      ? duration(ms)
                      : job.status}
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="mt-1 mb-0 text-body-sm text-ink-faint">No CI step run for this step.</p>
        )}
        <h4 className={heading}>Checks the agent ran</h4>
        {span.tests.length ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0 text-body-sm">
            {span.tests.map((test, n) => (
              <li key={n} className="[overflow-wrap:anywhere]">
                <span style={{ color: test.exit === 0 ? "var(--online)" : "var(--danger-text)" }}>
                  {test.exit === 0 ? "Passed" : `Failed (exit ${test.exit})`}
                </span>{" "}
                <span className="font-mono text-micro">{test.command}</span>
                {test.summary && <span className="text-ink-faint"> · {test.summary}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-body-sm text-ink-faint">
            {span.partial && span.checks.passed + span.checks.failed
              ? `${span.checks.passed} passed, ${span.checks.failed} failed.`
              : "None recorded. gm step runs them and records the results."}
          </p>
        )}
        {span.challenges.trim() && (
          <>
            <h4 className={heading}>What got in the way</h4>
            <p className="m-0 text-body-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
              {span.challenges}
            </p>
          </>
        )}
        <p className="mt-4 mb-0 text-micro text-ink-faint">
          <Link className={link} to={`${story}?${params}`}>
            The diff and every version
          </Link>{" "}
          are in Story.
        </p>
      </div>
    </section>
  );
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** A time of day, for a moment on the trace. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** When an entry was given (givenAt), if known. */
function When({ at }: { at: number | null }) {
  if (at === null) return null;
  const iso = new Date(at).toISOString();
  return (
    <time className="text-micro text-ink-faint" dateTime={iso} title={fullDate(iso)}>
      {clock(at)}
    </time>
  );
}
