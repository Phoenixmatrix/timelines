// The Chronicle's history by time (CORE-250; shapes in shared/chronicle.ts).
//
// The event log is the authority. For each issue matching the tracker query
// (evaluated against the issues as they are now), its events up to the end
// of the range are read through the `issue_events` index and replayed:
//
// - its state as of `from` is the state after its last event at or before it,
//   and every change in (from, to] is a segment. A change made in a timeline
//   reads as the timeline saw it (`view`), except that main's
//   `done_in_timeline` stays what it is: the work hasn't landed;
// - a work span starts when a claim is granted and runs through renewals
//   (and parking, while it waits on a person) until the claim is released,
//   completed, revoked, taken over, handed off, or cleared by a timeline
//   landing or being abandoned (a retained lease, CORE-75). Expiry is lazy
//   and records nothing: a span whose lease ran out before anything else
//   happened ends at its expiry;
// - comments (checkpoints, evidence), requests, links, landings and the
//   checkpoints and landings of the timelines it was worked in are markers.
//
// Reads are bounded: a page holds at most `limit` issues and stops early
// once it has read CHRONICLE_EVENT_BUDGET events, paging on by issue key.

import {
  CHRONICLE_EVENT_BUDGET,
  type Chronicle,
  type ChronicleDensity,
  type ChronicleHistory,
  type ChronicleIssue,
  type ChronicleMarker,
  type ChronicleState,
  type SpanEnd,
  type WorkSpan,
} from "../../shared/chronicle.ts";
import type {
  AuditActor,
  Comment,
  HumanRequest,
  Issue,
  IssueClaim,
  Link,
  Snapshot,
  TrackerEvent,
} from "../../shared/tracker.ts";
import type { Timeline, TimelineEvent } from "../../shared/timelines.ts";
import { buildIndex, compile } from "../../shared/tracker-query.ts";
import { all, json, tracker, type SqlDatabase } from "./sql.ts";
import { feedFloor } from "./retention.ts";

const ms = (iso: string) => Date.parse(iso);

/** An issue at one event, as the Chronicle reads it. */
interface IssueAt extends ChronicleState {
  claim: IssueClaim | null;
}

/**
 * The issue before or after an event: as a timeline saw it when the change
 * was made in one, except that main's `done_in_timeline` stands, and the
 * shared fields (claim, waiting) are main's.
 */
export function issueAt(event: TrackerEvent, which: "before" | "entity"): IssueAt | null {
  const main = (event[which] ?? null) as Issue | null;
  const seen = (event.view?.[which] ?? null) as Issue | null;
  const shared = main ?? seen;
  if (!shared) return null;
  const status = main?.status === "done_in_timeline" ? main.status : (seen ?? shared).status;
  return { status, waiting: !!shared.waiting, claim: shared.claim ?? null };
}

/** The first line of some text, at most `max` characters. */
function line(text: string, max = 160): string {
  const first =
    text
      .trim()
      .split("\n")
      .find((part) => part.trim()) ?? "";
  const plain = first.replace(/[*_`#>]+/g, "").trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

function ending(event: TrackerEvent, span: WorkSpan): SpanEnd {
  switch (event.kind) {
    case "issue.complete":
      return "complete";
    case "issue.release":
      return event.actorId === span.holder ? "release" : "ended";
    case "issue.revoke":
      return "revoke";
    case "timeline.land":
      return "landed";
    case "timeline.abandon":
      return "abandoned";
    default:
      return "ended";
  }
}

/** Whether a claim held at `at` (a lapsed one stays on the issue until someone claims it). */
function holds(claim: IssueClaim, at: number): boolean {
  return !!claim.retainedIn || !!claim.parkedAt || ms(claim.expiresAt) > at;
}

export interface Replayed {
  row: ChronicleIssue;
  /** Closed before the range, and nothing about it changed or held in it. */
  quiet: boolean;
  /** Timelines it was worked in, for their markers. */
  timelines: Set<string>;
}

/**
 * Replay one issue's events (oldest first, none after `to`) into its row.
 * `events` holds the issue's own events and those about it (comments,
 * requests, links), as `issue_events` indexes them.
 */
export function replay(
  issue: Issue,
  events: TrackerEvent[],
  range: { from: number; to: number; now: number },
  keyOf: (issueId: string) => string | null,
): Replayed {
  const { from, to, now } = range;
  const own = events.filter((e) => e.entityType === "issue" && e.entityId === issue.id);
  const timelines = new Set<string>();
  for (const id of [issue.timelineId, issue.doneIn?.id, issue.claim?.retainedIn?.id])
    if (id) timelines.add(id);

  // Where history begins: its creation, or the oldest event retention left.
  const first = own[0];
  let historyFrom: string | null = null;
  let state: IssueAt | null = null;
  if (first && first.kind !== "issue.create") {
    historyFrom = first.createdAt;
    state = first.before === undefined ? issueAt(first, "entity") : issueAt(first, "before");
  }
  const startState = (): ChronicleState => ({
    status: state?.status ?? null,
    waiting: state?.waiting ?? false,
  });
  let start: ChronicleState = startState();
  const segments: ChronicleIssue["segments"] = [];
  const spans: WorkSpan[] = [];
  let open: WorkSpan | null = null;

  const close = (at: string, why: SpanEnd, by: string | null) => {
    const span = open!;
    span.end = at;
    span.endedBy = why;
    span.endedById = by && by !== span.holder ? by : null;
    const parked = span.parked.at(-1);
    if (parked && parked.to === null) parked.to = at;
    open = null;
  };
  const begin = (claim: IssueClaim, event: TrackerEvent) => {
    open = {
      id: `${issue.id}:${event.cursor}`,
      issueId: issue.id,
      holder: claim.actorId,
      accountableId: claim.accountableId ?? null,
      session: claim.agent,
      start: event.createdAt,
      end: null,
      endedBy: null,
      endedById: null,
      expiresAt: claim.expiresAt,
      renewals: [],
      parked: claim.parkedAt ? [{ from: event.createdAt, to: null }] : [],
      retained: claim.retainedIn ? { at: event.createdAt, timeline: claim.retainedIn } : null,
      delegatedFrom: claim.delegatedFrom ?? null,
      timelineId: event.timelineId ?? null,
    };
    spans.push(open);
  };
  /** A lapsed lease ends at its expiry, before whatever happens next. */
  const lapse = (at: number) => {
    const span = open;
    if (!span || span.retained || span.parked.at(-1)?.to === null) return;
    if (ms(span.expiresAt) < at) close(span.expiresAt, "expiry", null);
  };

  for (const event of own) {
    const at = ms(event.createdAt);
    if (event.timelineId) timelines.add(event.timelineId);
    lapse(at);
    const next = issueAt(event, "entity");
    for (const id of [next?.claim?.retainedIn?.id]) if (id) timelines.add(id);
    const claim = next?.claim ?? null;
    const current = open as WorkSpan | null;
    if (current) {
      const granted = event.kind === "issue.claim" || event.kind === "issue.accept";
      if (!claim) close(event.createdAt, ending(event, current), event.actorId);
      else if (claim.actorId !== current.holder || granted) {
        close(
          event.createdAt,
          event.kind === "issue.accept" ? "handoff" : "takeover",
          event.actorId,
        );
        begin(claim, event);
      } else {
        if (event.kind === "issue.renew" || event.kind === "issue.resume")
          if (at >= from && at <= to) current.renewals.push(event.createdAt);
        current.expiresAt = claim.expiresAt;
        const parked = current.parked.at(-1);
        if (claim.parkedAt && (!parked || parked.to !== null))
          current.parked.push({ from: event.createdAt, to: null });
        else if (!claim.parkedAt && parked && parked.to === null) parked.to = event.createdAt;
        if (claim.retainedIn && !current.retained)
          current.retained = { at: event.createdAt, timeline: claim.retainedIn };
        else if (claim.retainedIn && current.retained) current.retained.timeline = claim.retainedIn;
      }
    } else if (claim && holds(claim, at)) begin(claim, event);

    const was = state;
    state = next;
    if (at <= from) start = startState();
    else if (
      (was?.status ?? null) !== (next?.status ?? null) ||
      (was?.waiting ?? false) !== (next?.waiting ?? false)
    )
      segments.push({
        at: event.createdAt,
        cursor: event.cursor,
        status: next?.status ?? null,
        waiting: next?.waiting ?? false,
      });
  }
  lapse(Math.min(to, now));

  const markers: ChronicleMarker[] = [];
  for (const event of events) {
    const at = ms(event.createdAt);
    if (at < from || at > to) continue;
    const id = `e:${event.cursor}`;
    const base = { id, at: event.createdAt, actorId: event.actorId || null };
    if (event.entityType === "issue") {
      if (event.entityId !== issue.id) continue;
      if (event.kind === "issue.create")
        markers.push({ ...base, kind: "created", text: line(issue.title) });
      else if (event.kind === "timeline.land")
        markers.push({ ...base, kind: "landed", text: "Landed with its timeline" });
    } else if (event.entityType === "comment") {
      const comment = (event.view?.entity ?? event.entity) as Comment | null;
      if (!comment || event.kind !== "comment.add") continue;
      markers.push({ ...base, kind: comment.kind, text: line(comment.body) });
    } else if (event.entityType === "request") {
      const request = event.entity as HumanRequest | null;
      if (!request) continue;
      const kind =
        event.kind === "request.open"
          ? "asked"
          : event.kind === "request.answer"
            ? "answered"
            : event.kind === "request.cancel"
              ? "withdrawn"
              : null;
      if (!kind) continue;
      markers.push({
        ...base,
        kind,
        request: request.kind,
        text: line(kind === "asked" ? request.prompt : (request.answer ?? request.prompt)),
      });
    } else if (event.entityType === "link") {
      const link = (event.view?.entity ??
        event.entity ??
        event.view?.before ??
        event.before) as Link | null;
      if (!link) continue;
      const added = event.kind === "link.add";
      const outgoing = link.fromId === issue.id;
      const other = outgoing ? link.toId : link.fromId;
      const key = keyOf(other) ?? "another issue";
      const relation =
        link.kind === "blocks"
          ? outgoing
            ? `blocks ${key}`
            : `blocked by ${key}`
          : link.kind === "duplicates"
            ? outgoing
              ? `duplicates ${key}`
              : `duplicated by ${key}`
            : `related to ${key}`;
      markers.push({
        ...base,
        kind: added ? "linked" : "unlinked",
        issue: key,
        text: added ? relation : `No longer ${relation}`,
      });
    }
  }

  const overlapping = spans.filter(
    (span) => ms(span.start) <= to && (span.end === null || ms(span.end) >= from),
  );
  const startStatus = start.status;
  const quiet =
    (startStatus === "done" || startStatus === "canceled") &&
    !segments.length &&
    !overlapping.length &&
    !markers.length;
  return {
    row: {
      id: issue.id,
      key: issue.key,
      title: issue.title,
      type: issue.type,
      priority: issue.priority,
      teamId: issue.teamId,
      parentId: issue.parentId,
      createdAt: issue.createdAt,
      start,
      segments,
      spans: overlapping,
      markers,
      blockers: [],
      historyFrom,
    },
    quiet,
    timelines,
  };
}

/** Markers for the checkpoints and landings of the timelines an issue was worked in. */
export function timelineMarkers(
  events: TimelineEvent[],
  timelines: Map<string, Timeline>,
  from: number,
  to: number,
): ChronicleMarker[] {
  const markers: ChronicleMarker[] = [];
  for (const event of events) {
    const at = ms(event.createdAt);
    if (at < from || at > to) continue;
    const slug = timelines.get(event.timelineId)?.slug ?? "a timeline";
    if (event.kind === "checkpoint")
      markers.push({
        id: `t:${event.seq}`,
        at: event.createdAt,
        kind: "timeline-checkpoint",
        actorId: event.actorId,
        timeline: slug,
        checkpoint: event.number,
        text: line(event.summary) || `Checkpoint #${event.number} of ${slug}`,
      });
    else if (event.kind === "landing" && event.outcome !== "queued")
      markers.push({
        id: `t:${event.seq}`,
        at: event.createdAt,
        kind: "timeline-landing",
        actorId: event.actorId,
        timeline: slug,
        checkpoint: event.number,
        outcome: event.outcome,
        text: `${slug} #${event.number}: ${event.outcome.replace("_", " ")}`,
      });
  }
  return markers;
}

/** Bucket sizes the overview strip uses, smallest first. */
const BUCKETS = [
  900_000,
  3_600_000,
  3 * 3_600_000,
  6 * 3_600_000,
  12 * 3_600_000,
  86_400_000,
  2 * 86_400_000,
  7 * 86_400_000,
  30 * 86_400_000,
];
/** At most this many buckets (the largest bucket lifts it for very long histories). */
const MAX_BUCKETS = 240;

/** Event density over [earliest, now]: of every issue's events, or only `issueIds`'. */
export function density(
  sql: SqlDatabase,
  earliest: string | null,
  now: number,
  issueIds: string[] | null,
): ChronicleDensity {
  const first = earliest ? Math.min(ms(earliest), now) : now;
  const span = Math.max(now - first, 3_600_000);
  const bucketMs = BUCKETS.find((b) => span / b <= MAX_BUCKETS) ?? BUCKETS.at(-1)!;
  const start = Math.floor(first / bucketMs) * bucketMs;
  const n = Math.max(1, Math.ceil((now - start) / bucketMs) + 1);
  const counts = Array.from({ length: n }, () => 0);
  const startIso = new Date(start).toISOString();
  const bucket = `CAST((julianday(json_extract(e.data, '$.createdAt')) - julianday(?)) * 86400000.0 / ? AS INTEGER)`;
  const rows =
    issueIds === null
      ? (sql
          .exec(
            `SELECT ${bucket} AS b, count(*) AS n FROM events e
             WHERE json_extract(e.data, '$.entityType') IN ('issue', 'comment', 'request', 'link')
             GROUP BY b`,
            startIso,
            bucketMs,
          )
          .toArray() as { b: number; n: number }[])
      : (sql
          .exec(
            `SELECT ${bucket} AS b, count(*) AS n FROM events e
             WHERE e.cursor IN (SELECT i.cursor FROM issue_events i
               WHERE i.issue_id IN (SELECT value FROM json_each(?)))
             GROUP BY b`,
            startIso,
            bucketMs,
            JSON.stringify(issueIds),
          )
          .toArray() as { b: number; n: number }[]);
  for (const row of rows) {
    const b = Math.min(Math.max(0, row.b), n - 1);
    counts[b]! += row.n;
  }
  return { start: startIso, bucketMs, counts };
}

/** Where the tracker's history begins, and what retention removed of it. */
export function historyOf(sql: SqlDatabase): ChronicleHistory {
  const earliest =
    (
      sql.exec("SELECT min(json_extract(data, '$.createdAt')) AS t FROM events").toArray()[0] as
        | { t: string | null }
        | undefined
    )?.t ?? null;
  const floor = feedFloor(sql);
  let pruned: ChronicleHistory["pruned"] = null;
  if (floor > 0) {
    // The newest event retention removed; older trackers recorded only the
    // cursor, so then the oldest event kept after it stands in.
    const at = sql
      .exec("SELECT value FROM retention_state WHERE key = 'events_floor_at'")
      .toArray()[0] as { value: number } | undefined;
    const row = at
      ? null
      : (sql
          .exec(
            "SELECT json_extract(data, '$.createdAt') AS t FROM events WHERE cursor > ? ORDER BY cursor LIMIT 1",
            floor,
          )
          .toArray()[0] as { t: string } | undefined);
    pruned = {
      before: at ? new Date(at.value).toISOString() : (row?.t ?? new Date().toISOString()),
      cursor: floor,
    };
  }
  const removed = sql
    .exec("SELECT count(*) AS n FROM retention_removed WHERE kind = 'issue'")
    .toArray()[0] as { n: number };
  return { earliest, pruned, removedIssues: removed.n };
}

/** An issue's events up to `to`, oldest first: its own and those about it. */
export function issueEvents(sql: SqlDatabase, issueId: string, to: string): TrackerEvent[] {
  return all(
    sql,
    tracker
      .selectFrom("issue_events as i")
      .innerJoin("events as e", "e.cursor", "i.cursor")
      .select(["e.cursor", "e.data"])
      .where("i.issue_id", "=", issueId)
      .where(json("e.data", "$.createdAt"), "<=", to)
      .orderBy("i.cursor"),
  )
    .map((row) => ({ ...(JSON.parse(row.data) as TrackerEvent), cursor: row.cursor }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.cursor - b.cursor);
}

/** Timeline checkpoint and landing events of these timelines, oldest first. */
export function timelineEvents(sql: SqlDatabase, timelineIds: string[]): TimelineEvent[] {
  if (!timelineIds.length) return [];
  return all(
    sql,
    tracker
      .selectFrom("timeline_event_index as x")
      .innerJoin("timeline_events as e", "e.seq", "x.seq")
      .select(["e.seq", "e.data"])
      .distinct()
      .where("x.timeline_id", "in", timelineIds)
      .where(json("e.data", "$.kind"), "in", ["checkpoint", "landing"])
      .orderBy("e.seq"),
  ).map((row) => ({ ...(JSON.parse(row.data) as TimelineEvent), seq: row.seq }));
}

/** Who each id names: as recorded on the events, else as the tracker knows them now. */
export function actorsOf(
  rows: { events: TrackerEvent[]; row: ChronicleIssue }[],
  known: (id: string) => AuditActor,
): Chronicle["actors"] {
  const actors: Chronicle["actors"] = {};
  for (const { events } of rows)
    for (const event of events)
      if (event.actor && event.actor.id && !actors[event.actor.id])
        actors[event.actor.id] = event.actor;
  for (const { row } of rows) {
    const ids = [
      ...row.spans.flatMap((s) => [s.holder, s.accountableId, s.endedById]),
      ...row.markers.map((m) => m.actorId),
    ];
    for (const id of ids) if (id && !actors[id]) actors[id] = known(id);
  }
  return actors;
}

export interface ChronicleOptions {
  from: string;
  to: string;
  /** A tracker query (shared/tracker-query.ts), matched against the issues as they are now. */
  query: string;
  /** The key of the last issue of the previous page. */
  cursor: string | null;
  limit: number;
  /** Include issues closed before the range and untouched in it. */
  quiet: boolean;
}

const KEY_ORDER = new Intl.Collator("en", { numeric: true });

/** One page of the Chronicle, from main's view of the tracker. */
export function buildChronicle(
  sql: SqlDatabase,
  world: {
    viewerId: string;
    snapshot: Snapshot;
    known: (id: string) => AuditActor;
  },
  options: ChronicleOptions,
  now: number,
): Chronicle {
  const from = ms(options.from);
  const to = ms(options.to);
  const { snapshot } = world;
  const serverTime = new Date(now).toISOString();
  const index = buildIndex(snapshot, serverTime);
  const query = compile(options.query, index, world.viewerId, now);
  const matching = snapshot.issues
    .filter((issue) => ms(issue.createdAt) <= to && query.matches(issue))
    .sort((a, b) => KEY_ORDER.compare(a.key, b.key));
  const startAt = options.cursor
    ? matching.findIndex((issue) => KEY_ORDER.compare(issue.key, options.cursor!) > 0)
    : 0;
  const keyOf = (id: string) => index.byId.get(id)?.key ?? null;
  const blockers = new Map<string, string[]>();
  for (const link of snapshot.links)
    if (link.kind === "blocks")
      blockers.set(link.toId, [...(blockers.get(link.toId) ?? []), link.fromId]);

  const rows: { events: TrackerEvent[]; row: ChronicleIssue; timelines: Set<string> }[] = [];
  let quiet = 0;
  let read = 0;
  let next: string | null = null;
  const page = startAt === -1 ? [] : matching.slice(startAt);
  for (const [position, issue] of page.entries()) {
    const events = issueEvents(sql, issue.id, options.to);
    read += events.length;
    const replayed = replay(issue, events, { from, to, now }, keyOf);
    if (replayed.quiet && !options.quiet) quiet++;
    else {
      replayed.row.blockers = blockers.get(issue.id) ?? [];
      rows.push({ events, row: replayed.row, timelines: replayed.timelines });
    }
    const more = position < page.length - 1;
    if (more && (rows.length >= options.limit || read >= CHRONICLE_EVENT_BUDGET)) {
      next = issue.key;
      break;
    }
  }

  // The checkpoints and landings of the timelines each issue was worked in.
  const touched = [...new Set(rows.flatMap(({ timelines }) => [...timelines]))];
  if (touched.length) {
    const records = new Map(
      all(sql, tracker.selectFrom("timelines").select("data").where("id", "in", touched)).map(
        (row) => {
          const timeline = JSON.parse(row.data) as Timeline;
          return [timeline.id, timeline] as const;
        },
      ),
    );
    const events = timelineEvents(sql, touched);
    for (const { row, timelines } of rows) {
      const mine = events.filter((event) => timelines.has(event.timelineId));
      row.markers.push(...timelineMarkers(mine, records, from, to));
      row.markers.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    }
  }

  const history = historyOf(sql);
  const everything = options.query.trim() === "" || matching.length === snapshot.issues.length;
  return {
    from: options.from,
    to: options.to,
    query: options.query,
    serverTime,
    issues: rows.map(({ row }) => row),
    actors: actorsOf(rows, world.known),
    teams: Object.fromEntries(snapshot.teams.map((team) => [team.id, team.key])),
    next,
    quiet,
    history,
    ...(options.cursor
      ? {}
      : {
          density: density(
            sql,
            history.earliest,
            now,
            everything ? null : matching.map((issue) => issue.id),
          ),
        }),
  };
}
