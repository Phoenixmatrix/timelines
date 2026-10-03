// Timeline records and their events, in the tracker's Durable Object next to
// the issues and leases that landing and abandoning will change with them in
// one transaction. Each change to either also goes into the tracker's event
// log (entity types `timeline` and `timelineEvent`), which the change feed
// and snapshot give only to replicas that ask for them: older gm binaries
// reject entity types they don't know.
//
// Permissions (TIMELINES-RESEARCH.md, Decisions): any writer, person or agent,
// creates a timeline, merges into one and sets its experimental flag; only its
// accountable person and the agent that started it may abandon it. The bookmarks
// themselves are written by the Worker (timelines/api.ts), which asks here first.

import type { TimelineFeedEvent } from "../../shared/tracker.ts";
import {
  TIMELINE_POLICIES,
  timelineBookmark,
  type Timeline,
  type TimelineDetail,
  type TimelineEvent,
  type TimelinePolicy,
  type TimelineRepo,
  type TimelineStatus,
} from "../../shared/timelines.ts";
import { all, first, json, one, run, TIMELINE_TABLES, tracker, type SqlDatabase } from "./sql.ts";
import { fail, text, type Access } from "./store.ts";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STATUSES: readonly TimelineStatus[] = [
  "active",
  "idle",
  "waiting",
  "landing",
  "partly_landed",
  "landed",
  "abandoned",
];
/** Ended timelines take no new work: no forks from them, no repositories added. */
const ENDED: readonly TimelineStatus[] = ["landed", "abandoned"];

/** A timeline's slug: lowercase words joined by hyphens; `main` names main. */
export function timelineSlug(value: unknown): string {
  const slug = text(value, "slug", 64);
  if (!SLUG.test(slug))
    fail("invalid_input", "A timeline slug is lowercase letters and digits joined by hyphens.");
  if (slug === "main") fail("invalid_input", "`main` names main, not a timeline.");
  return slug;
}

export function timelineStatus(value: unknown): TimelineStatus {
  if (!STATUSES.includes(value as TimelineStatus))
    fail("invalid_input", `status must be one of: ${STATUSES.join(", ")}.`);
  return value as TimelineStatus;
}

export interface NewTimeline {
  slug: string;
  name?: string;
  policy?: unknown;
  experimental?: unknown;
  /** The parent's slug; null for main. */
  parent: string | null;
  repos: Omit<TimelineRepo, "bookmark">[];
  /** The fork commit per repository id. */
  commits: Record<string, string>;
}

/** What one push did to timelines, worked out from the push log (timelines/merges.ts). */
export interface PushActivity {
  repo: { id: string; owner: string; name: string };
  /** Who pushed: an agent's id, or the person's; and the person. */
  actorId: string | null;
  accountableId: string | null;
  /** Slugs of the timeline bookmarks the push created or moved. */
  pushed: string[];
  /** Merge commits it brought onto main or a bookmark. Each side is a slug, or null for main. */
  merges: {
    into: string | null;
    from: string | null;
    commit: string;
    parent: string;
    refUpdateId: number | null;
  }[];
}

/** An event before it's stored: the store numbers it. */
type EventInput = TimelineEvent extends infer E
  ? E extends unknown
    ? Omit<E, "seq">
    : never
  : never;

export class TimelineStore {
  private sql: SqlDatabase;
  private transaction: <T>(fn: () => T) => T;
  private clock: () => number;
  constructor(
    sql: SqlDatabase,
    transaction: <T>(fn: () => T) => T,
    clock: () => number = Date.now,
  ) {
    this.sql = sql;
    this.transaction = transaction;
    this.clock = clock;
    sql.exec(TIMELINE_TABLES);
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private find(slug: string): Timeline | null {
    const row = first(
      this.sql,
      tracker.selectFrom("timelines").select("data").where(json("data", "$.slug"), "=", slug),
    );
    return row ? (JSON.parse(row.data) as Timeline) : null;
  }
  private save(timeline: Timeline, kind: string, actorId: string | null) {
    this.feed(`timeline:${timeline.id}:v${timeline.version}`, kind, "timeline", timeline, actorId);
    run(
      this.sql,
      tracker
        .insertInto("timelines")
        .values({ id: timeline.id, data: JSON.stringify(timeline) })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({ data: eb.ref("excluded.data") })),
        ),
    );
  }
  /** Log a record or event in the tracker's change feed (`timelines=1`). */
  private feed(
    operationId: string,
    kind: string,
    entityType: TimelineFeedEvent["entityType"],
    entity: Timeline | TimelineEvent,
    actorId: string | null,
  ) {
    const event: Omit<TimelineFeedEvent, "cursor"> = {
      operationId,
      actorId,
      kind,
      entityType,
      entityId: entity.id,
      entity,
      createdAt: "updatedAt" in entity ? entity.updatedAt : entity.createdAt,
    };
    run(this.sql, tracker.insertInto("events").values({ data: JSON.stringify(event) }));
  }
  /** Append an event, listed by each of `timelineIds`; an id already recorded is skipped. */
  private append(event: EventInput, timelineIds: string[]): boolean {
    const row = first(
      this.sql,
      tracker
        .insertInto("timeline_events")
        .values({ id: event.id, data: JSON.stringify(event) })
        .onConflict((oc) => oc.column("id").doNothing())
        .returning("seq"),
    );
    if (!row) return false;
    run(
      this.sql,
      tracker
        .insertInto("timeline_event_index")
        .values([...new Set(timelineIds)].map((timeline_id) => ({ timeline_id, seq: row.seq }))),
    );
    const recorded = { ...event, seq: row.seq } as TimelineEvent;
    this.feed(`timelineEvent:${event.id}`, event.kind, "timelineEvent", recorded, event.actorId);
    return true;
  }
  /** Every timeline, newest first; ended ones included unless a status is asked for. */
  list(status?: TimelineStatus): Timeline[] {
    return all(this.sql, tracker.selectFrom("timelines").select("data"))
      .map((row) => JSON.parse(row.data) as Timeline)
      .filter((timeline) => !status || timeline.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug));
  }
  get(slug: string): Timeline {
    const timeline = this.find(timelineSlug(slug));
    if (!timeline) fail("not_found", `No timeline ${slug}.`, 404);
    return timeline;
  }
  /** A timeline and its events after `after`, oldest first. */
  detail(slug: string, after: number, limit: number): TimelineDetail {
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1)
      fail("invalid_input", "after must be a nonnegative integer; limit must be positive.");
    limit = Math.min(limit, 500);
    const timeline = this.get(slug);
    const rows = all(
      this.sql,
      tracker
        .selectFrom("timeline_event_index as i")
        .innerJoin("timeline_events as e", "e.seq", "i.seq")
        .select(["e.seq", "e.data"])
        .where("i.timeline_id", "=", timeline.id)
        .where("i.seq", ">", after)
        .orderBy("i.seq")
        .limit(limit + 1),
    );
    const events = rows
      .slice(0, limit)
      .map((row) => ({ ...JSON.parse(row.data), seq: row.seq }) as TimelineEvent);
    return { timeline, events, next: rows.length > limit ? events.at(-1)!.seq : null };
  }
  /**
   * Check a fork before its bookmarks are written: the slug is free and the
   * parent can be forked. Returns the parent (null for main).
   */
  prepare(slug: string, parent: string | null): Timeline | null {
    if (this.find(timelineSlug(slug)))
      fail("already_exists", `A timeline named ${slug} already exists.`, 409);
    if (parent === null) return null;
    const found = this.get(parent);
    if (ENDED.includes(found.status))
      fail("timeline_ended", `${found.slug} is ${found.status}; fork from main instead.`, 409);
    return found;
  }
  /** Record a fork whose bookmarks exist: the timeline, and a fork event for it and its parent. */
  create(access: Access, input: NewTimeline): Timeline {
    return this.transaction(() => {
      const slug = timelineSlug(input.slug);
      const parent = this.prepare(slug, input.parent);
      if (!input.repos.length) fail("invalid_input", "A timeline touches at least one repository.");
      for (const repo of input.repos)
        if (!/^[0-9a-f]{40}$/.test(input.commits[repo.id] ?? ""))
          fail("invalid_input", `No fork commit for ${repo.owner}/${repo.name}.`);
      const now = this.now();
      const trackerCursor = one(
        this.sql,
        tracker
          .selectFrom("events")
          .select((eb) => eb.fn.coalesce(eb.fn.max("cursor"), eb.lit(0)).as("cursor")),
      ).cursor;
      const agent = access.actorId !== access.principalId;
      const timeline: Timeline = {
        id: `tl_${crypto.randomUUID()}`,
        slug,
        name: input.name === undefined ? slug : text(input.name, "name"),
        policy: this.policy(input.policy),
        experimental: this.flag(input.experimental, "experimental") ?? false,
        parentId: parent?.id ?? null,
        forkPoint: { commits: input.commits, trackerCursor },
        repos: input.repos.map((repo) => ({ ...repo, bookmark: timelineBookmark(slug) })),
        status: "active",
        accountableId: access.principalId,
        startedBy: access.actorId,
        agentIds: agent ? [access.actorId] : [],
        version: 1,
        createdAt: now,
        updatedAt: now,
        pushedAt: null,
      };
      this.save(timeline, "timeline.create", access.actorId);
      this.append(
        {
          id: `fork:${timeline.id}`,
          timelineId: timeline.id,
          kind: "fork",
          parentId: timeline.parentId,
          commits: input.commits,
          trackerCursor,
          actorId: access.actorId,
          accountableId: access.principalId,
          createdAt: now,
        },
        [timeline.id, ...(parent ? [parent.id] : [])],
      );
      return timeline;
    });
  }
  private policy(value: unknown): TimelinePolicy {
    if (value === undefined) return "approval";
    if (!TIMELINE_POLICIES.includes(value as TimelinePolicy))
      fail("invalid_input", "policy must be auto or approval.");
    return value as TimelinePolicy;
  }
  private flag(value: unknown, name: string): boolean | undefined {
    if (value !== undefined && typeof value !== "boolean")
      fail("invalid_input", `${name} must be true or false.`);
    return value as boolean | undefined;
  }
  /** Rename it, or set or clear its experimental flag: any writer may. */
  update(
    slug: string,
    data: Record<string, unknown>,
    expectedVersion?: unknown,
    access?: Access,
  ): Timeline {
    for (const key of Object.keys(data))
      if (key !== "name" && key !== "experimental") fail("invalid_input", `Unknown field: ${key}.`);
    return this.transaction(() => {
      const timeline = this.get(slug);
      if (expectedVersion !== undefined && expectedVersion !== timeline.version)
        fail("version_conflict", "The timeline changed since it was read.", 409);
      if ("name" in data) timeline.name = text(data.name, "name");
      const experimental = this.flag(data.experimental, "experimental");
      if (experimental !== undefined) timeline.experimental = experimental;
      timeline.version++;
      timeline.updatedAt = this.now();
      this.save(timeline, "timeline.update", access?.actorId ?? null);
      return timeline;
    });
  }
  /** Only its accountable person, acting as themselves, or the agent that started it. */
  mayAbandon(access: Access, slug: string): Timeline {
    const timeline = this.get(slug);
    if (access.actorId !== timeline.accountableId && access.actorId !== timeline.startedBy)
      fail(
        "forbidden",
        "Only the timeline's accountable person or the agent that started it can abandon it.",
        403,
      );
    if (timeline.status === "landed") fail("timeline_ended", `${timeline.slug} has landed.`, 409);
    return timeline;
  }
  /**
   * End a timeline: its status, and an abandon event with each bookmark's last
   * commit. Abandoning it again changes nothing (`abandoned` is false), so the
   * caller can retry deleting bookmarks.
   */
  abandon(
    access: Access,
    slug: string,
    lastCommits: Record<string, string | null>,
  ): { timeline: Timeline; abandoned: boolean } {
    return this.transaction(() => {
      const timeline = this.mayAbandon(access, slug);
      if (timeline.status === "abandoned") return { timeline, abandoned: false };
      const now = this.now();
      timeline.status = "abandoned";
      timeline.version++;
      timeline.updatedAt = now;
      this.save(timeline, "timeline.abandon", access.actorId);
      this.append(
        {
          id: `abandon:${timeline.id}`,
          timelineId: timeline.id,
          kind: "abandon",
          lastCommits,
          actorId: access.actorId,
          accountableId: access.principalId,
          createdAt: now,
        },
        [timeline.id],
      );
      return { timeline, abandoned: true };
    });
  }
  /**
   * Note a push: who worked in each timeline it moved, and the merges it
   * brought between timelines and main. Bookmarks of unknown slugs are someone's
   * own branches and are ignored. Recording the same push again adds nothing.
   * Returns the merge events recorded.
   */
  recordPush(activity: PushActivity): number {
    return this.transaction(() => {
      const now = this.now();
      const seen = new Map<string, Timeline>();
      const lookup = (slug: string) => {
        const timeline = seen.get(slug) ?? this.find(slug);
        if (timeline) seen.set(slug, timeline);
        return timeline;
      };
      const pushed = new Set<Timeline>();
      for (const slug of activity.pushed) {
        const timeline = lookup(slug);
        if (!timeline) continue;
        pushed.add(timeline);
        timeline.pushedAt = now;
        const agent = activity.actorId !== activity.accountableId ? activity.actorId : null;
        if (agent && !timeline.agentIds.includes(agent)) timeline.agentIds.push(agent);
        // A bookmark pushed in another of the account's repositories: it touches that one too.
        if (
          !ENDED.includes(timeline.status) &&
          !timeline.repos.some((repo) => repo.id === activity.repo.id)
        )
          timeline.repos.push({ ...activity.repo, bookmark: timelineBookmark(slug) });
      }
      let recorded = 0;
      for (const merge of activity.merges) {
        const into = merge.into === null ? null : lookup(merge.into);
        const from = merge.from === null ? null : lookup(merge.from);
        // Main into main can't happen; a side that isn't a known timeline isn't tracked.
        if ((merge.into !== null && !into) || (merge.from !== null && !from) || (!into && !from))
          continue;
        if (into && from && into.id === from.id) continue;
        const ids = [into?.id, from?.id].filter((id): id is string => !!id);
        if (
          this.append(
            {
              id: `merge:${activity.repo.id}:${merge.commit}:${merge.parent}`,
              timelineId: ids[0]!,
              kind: "merge",
              fromId: from?.id ?? null,
              intoId: into?.id ?? null,
              repoId: activity.repo.id,
              commit: merge.commit,
              parent: merge.parent,
              refUpdateId: merge.refUpdateId,
              actorId: activity.actorId,
              accountableId: activity.accountableId,
              createdAt: now,
            },
            ids,
          )
        )
          recorded++;
      }
      for (const timeline of pushed) {
        timeline.version++;
        timeline.updatedAt = now;
        this.save(timeline, "timeline.push", activity.actorId);
      }
      return recorded;
    });
  }
}
