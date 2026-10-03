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

import type { HumanRequest, RequestCheckpoint, TimelineFeedEvent } from "../../shared/tracker.ts";
import {
  CHECKPOINT_CHANGES,
  LANDING_ACTIVE,
  TIMELINE_POLICIES,
  timelineBookmark,
  type Checkpoint,
  type CheckpointApproval,
  type CheckpointRepo,
  type CheckpointState,
  type Landing,
  type LandingOutcome,
  type LandingRepo,
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

/** A checkpoint as the Worker measured it: each repository's commits now. */
export interface NewCheckpoint {
  summary?: unknown;
  repos: CheckpointRepo[];
}

/**
 * Withdraw open requests (by id) as superseded, with the reason, inside the
 * caller's transaction: the tracker's own `request.cancel`, which unparks the
 * issue's lease once nothing else is open. Given by TrackerStore.
 */
export type WithdrawRequests = (ids: string[], reason: string, actorId: string | null) => void;

/** How a landing is being queued (CORE-77), as the Worker found things. */
export interface LandingRequest {
  trigger: Landing["trigger"];
  /**
   * For an `auto` timeline: whether the head checkpoint is green (its CI runs
   * succeeded), and why not. The Worker reads that from D1.
   */
  green: { ok: boolean; why: string | null };
  /** The agent asking, when an agent asks (the access's actor otherwise). */
  agentId: string | null;
}

/** Statuses a checkpoint's approval moves a timeline between; the rest belong to landing. */
const SETTLED: readonly TimelineStatus[] = ["active", "idle", "waiting"];
const OID = /^[0-9a-f]{40}$/;

/** What one push did to timelines, worked out from the push log (timelines/merges.ts). */
export interface PushActivity {
  repo: { id: string; owner: string; name: string };
  /** Who pushed: an agent's id, or the person's; and the person. */
  actorId: string | null;
  accountableId: string | null;
  /** Slugs of the timeline bookmarks the push created or moved. */
  pushed: string[];
  /** Where each timeline bookmark it moved now points (null: deleted); omitted by older callers. */
  heads?: { slug: string; commit: string | null }[];
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
  private withdraw: WithdrawRequests | null;
  constructor(
    sql: SqlDatabase,
    transaction: <T>(fn: () => T) => T,
    clock: () => number = Date.now,
    withdraw: WithdrawRequests | null = null,
  ) {
    this.sql = sql;
    this.transaction = transaction;
    this.clock = clock;
    this.withdraw = withdraw;
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
   * Every timeline and the newest `limit` events across all of them, oldest
   * first, each once: what the timeline graph draws (CORE-81).
   */
  graph(limit: number): { timelines: Timeline[]; events: TimelineEvent[]; truncated: boolean } {
    if (!Number.isSafeInteger(limit) || limit < 1)
      fail("invalid_input", "limit must be a positive integer.");
    const rows = all(
      this.sql,
      tracker
        .selectFrom("timeline_events")
        .select(["seq", "data"])
        .orderBy("seq", "desc")
        .limit(limit + 1),
    );
    const events = rows
      .slice(0, limit)
      .reverse()
      .map((row) => ({ ...JSON.parse(row.data), seq: row.seq }) as TimelineEvent);
    return { timelines: this.list(), events, truncated: rows.length > limit };
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
      timeline.endedAt = now;
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
   * Returns the merge events recorded; `onMerge` hears of each new one
   * between two timelines, inside the same transaction.
   */
  recordPush(
    activity: PushActivity,
    onMerge?: (merge: { fromId: string; intoId: string; id: string }) => void,
  ): number {
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
        const id = `merge:${activity.repo.id}:${merge.commit}:${merge.parent}`;
        if (
          this.append(
            {
              id,
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
        ) {
          recorded++;
          if (from && into) onMerge?.({ fromId: from.id, intoId: into.id, id });
        }
      }
      // Each bookmark's new tip: a push past a checkpoint makes it no longer the head.
      const moved = new Set<Timeline>();
      for (const head of activity.heads ?? []) {
        const timeline = lookup(head.slug);
        if (!timeline || !timeline.repos.some((repo) => repo.id === activity.repo.id)) continue;
        this.setHead(timeline.id, activity.repo.id, head.commit);
        moved.add(timeline);
      }
      for (const timeline of moved) {
        this.supersede(
          timeline,
          `Superseded by new commits on ${timelineBookmark(timeline.slug)}; make a new checkpoint and ask again.`,
          activity.actorId,
          activity.accountableId,
        );
        if (this.status(timeline) && !pushed.has(timeline)) pushed.add(timeline);
      }
      for (const timeline of pushed) {
        timeline.version++;
        timeline.updatedAt = now;
        this.save(timeline, "timeline.push", activity.actorId);
      }
      return recorded;
    });
  }

  // ---- checkpoints (CORE-76) -------------------------------------------------

  private byId(timelineId: string): Timeline {
    const row = first(
      this.sql,
      tracker.selectFrom("timelines").select("data").where("id", "=", timelineId),
    );
    if (!row) fail("not_found", `No timeline ${timelineId}.`, 404);
    return JSON.parse(row.data) as Timeline;
  }
  private setHead(timelineId: string, repoId: string, oid: string | null) {
    run(
      this.sql,
      tracker
        .insertInto("timeline_heads")
        .values({ timeline_id: timelineId, repo_id: repoId, oid })
        .onConflict((oc) =>
          oc
            .columns(["timeline_id", "repo_id"])
            .doUpdateSet((eb) => ({ oid: eb.ref("excluded.oid") })),
        ),
    );
  }
  private latest(timelineId: string): Checkpoint | null {
    const row = first(
      this.sql,
      tracker
        .selectFrom("timeline_checkpoints")
        .select("data")
        .where("timeline_id", "=", timelineId)
        .orderBy("number", "desc")
        .limit(1),
    );
    return row ? (JSON.parse(row.data) as Checkpoint) : null;
  }
  /**
   * Still its timeline's head: the newest checkpoint, and every bookmark tip
   * known since is the commit it pins. A push recorded after it (even of a
   * repository it doesn't have) moves the head past it.
   */
  private isCurrent(checkpoint: Checkpoint): boolean {
    if (this.latest(checkpoint.timelineId)?.id !== checkpoint.id) return false;
    const heads = all(
      this.sql,
      tracker
        .selectFrom("timeline_heads")
        .select(["repo_id", "oid"])
        .where("timeline_id", "=", checkpoint.timelineId),
    );
    return heads.every(
      (head) => checkpoint.repos.find((repo) => repo.id === head.repo_id)?.commit === head.oid,
    );
  }
  /** Open approval requests that pin this checkpoint. */
  private openApprovals(checkpointId: string): HumanRequest[] {
    return all(
      this.sql,
      tracker
        .selectFrom("requests")
        .select("data")
        .where(json("data", "$.checkpoint.id"), "=", checkpointId)
        .where(json("data", "$.status"), "=", "open"),
    ).map((row) => JSON.parse(row.data) as HumanRequest);
  }
  /**
   * A timeline is `waiting` while its head checkpoint has an open approval
   * request, and back to `active` once it hasn't (answered, withdrawn, or new
   * commits pushed past it). Landing's statuses aren't this one's to change.
   * Returns whether it changed; the caller saves it.
   */
  private status(timeline: Timeline): boolean {
    if (!SETTLED.includes(timeline.status)) return false;
    const head = this.latest(timeline.id);
    const awaiting = !!head && this.isCurrent(head) && this.openApprovals(head.id).length > 0;
    const next: TimelineStatus = awaiting
      ? "waiting"
      : timeline.status === "waiting"
        ? "active"
        : timeline.status;
    if (next === timeline.status) return false;
    timeline.status = next;
    return true;
  }
  /** Settle a timeline's status inside the caller's transaction (a request opened or answered). */
  settle(timelineId: string, actorId: string | null) {
    const timeline = this.byId(timelineId);
    if (!this.status(timeline)) return;
    timeline.version++;
    timeline.updatedAt = this.now();
    this.save(timeline, "timeline.status", actorId);
  }
  /**
   * Withdraw the timeline's open approval requests whose checkpoint is no
   * longer its head, each with an approval event (outcome `superseded`),
   * inside the caller's transaction. The caller settles the status after.
   */
  private supersede(
    timeline: Timeline,
    reason: string,
    actorId: string | null,
    accountableId: string | null,
  ) {
    if (!this.withdraw) return;
    const stale = all(
      this.sql,
      tracker
        .selectFrom("requests")
        .select("data")
        .where(json("data", "$.checkpoint.timelineId"), "=", timeline.id)
        .where(json("data", "$.status"), "=", "open"),
    )
      .map((row) => JSON.parse(row.data) as HumanRequest)
      .filter((request) => {
        const checkpoint = this.findCheckpoint(request.checkpoint!.id);
        return !checkpoint || !this.isCurrent(checkpoint);
      });
    if (!stale.length) return;
    const now = this.now();
    for (const request of stale)
      this.append(
        {
          id: `approval:${request.id}`,
          timelineId: timeline.id,
          kind: "approval",
          checkpointId: request.checkpoint!.id,
          number: request.checkpoint!.number,
          requestId: request.id,
          outcome: "superseded",
          note: reason,
          actorId,
          accountableId,
          createdAt: now,
        },
        [timeline.id],
      );
    this.withdraw(
      stale.map((request) => request.id),
      reason,
      actorId,
    );
  }
  private approval(checkpoint: Checkpoint): CheckpointApproval | null {
    const answered = all(
      this.sql,
      tracker
        .selectFrom("timeline_event_index as i")
        .innerJoin("timeline_events as e", "e.seq", "i.seq")
        .select("e.data")
        .where("i.timeline_id", "=", checkpoint.timelineId)
        .where(json("e.data", "$.kind"), "=", "approval")
        .where(json("e.data", "$.checkpointId"), "=", checkpoint.id)
        .orderBy("i.seq", "desc")
        .limit(1),
    ).map((row) => JSON.parse(row.data) as Extract<TimelineEvent, { kind: "approval" }>)[0];
    const pending = this.openApprovals(checkpoint.id).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    )[0];
    if (pending && (!answered || pending.createdAt >= answered.createdAt))
      return { requestId: pending.id, state: "pending", by: null, at: null, note: null };
    if (!answered) return null;
    return {
      requestId: answered.requestId,
      state: answered.outcome,
      by: answered.actorId,
      at: answered.createdAt,
      note: answered.note,
    };
  }
  private state(checkpoint: Checkpoint): CheckpointState {
    const current = this.isCurrent(checkpoint);
    const approval = this.approval(checkpoint);
    return { checkpoint, current, approval, approved: current && approval?.state === "approved" };
  }
  /** A timeline's checkpoints, newest first. */
  checkpoints(slug: string): CheckpointState[] {
    const timeline = this.get(slug);
    return all(
      this.sql,
      tracker
        .selectFrom("timeline_checkpoints")
        .select("data")
        .where("timeline_id", "=", timeline.id)
        .orderBy("number", "desc"),
    ).map((row) => this.state(JSON.parse(row.data) as Checkpoint));
  }
  private findCheckpoint(id: string): Checkpoint | null {
    const row = first(
      this.sql,
      tracker.selectFrom("timeline_checkpoints").select("data").where("id", "=", id),
    );
    return row ? (JSON.parse(row.data) as Checkpoint) : null;
  }
  /** One checkpoint, by id or by its number in the timeline. */
  checkpoint(slug: string, ref: string): CheckpointState {
    const timeline = this.get(slug);
    const row = /^\d+$/.test(ref)
      ? first(
          this.sql,
          tracker
            .selectFrom("timeline_checkpoints")
            .select("data")
            .where("timeline_id", "=", timeline.id)
            .where("number", "=", Number(ref)),
        )
      : first(
          this.sql,
          tracker
            .selectFrom("timeline_checkpoints")
            .select("data")
            .where("id", "=", ref)
            .where("timeline_id", "=", timeline.id),
        );
    if (!row) fail("not_found", `${timeline.slug} has no checkpoint ${ref}.`, 404);
    return this.state(JSON.parse(row.data) as Checkpoint);
  }
  /** Checkpoints by id, each with its timeline: what the request inbox shows. */
  checkpointStates(ids: string[]): { state: CheckpointState; timeline: Timeline }[] {
    return [...new Set(ids)].flatMap((id) => {
      const checkpoint = this.findCheckpoint(id);
      if (!checkpoint) return [];
      return [{ state: this.state(checkpoint), timeline: this.byId(checkpoint.timelineId) }];
    });
  }
  /**
   * Record a checkpoint of a timeline's bookmarks as the Worker just read them.
   * Any writer may; it needs work since the fork, and something new since the
   * last checkpoint. The record never changes afterwards.
   */
  createCheckpoint(access: Access, slug: string, input: NewCheckpoint): CheckpointState {
    return this.transaction(() => {
      const timeline = this.get(slug);
      if (ENDED.includes(timeline.status))
        fail("timeline_ended", `${timeline.slug} is ${timeline.status}.`, 409);
      const summary =
        input.summary === undefined || input.summary === ""
          ? ""
          : text(input.summary, "summary", 20000);
      const ids = new Set(input.repos.map((repo) => repo.id));
      if (
        ids.size !== input.repos.length ||
        ids.size !== timeline.repos.length ||
        timeline.repos.some((repo) => !ids.has(repo.id))
      )
        fail("timeline_changed", `${timeline.slug}'s repositories changed; try again.`, 409);
      for (const repo of input.repos) {
        if (!OID.test(repo.commit) || (repo.base !== null && !OID.test(repo.base)))
          fail("invalid_input", `Commits for ${repo.owner}/${repo.name} must be full commit ids.`);
        if (repo.changes.length > CHECKPOINT_CHANGES)
          fail("invalid_input", `At most ${CHECKPOINT_CHANGES} changes per repository.`);
      }
      const commits = Object.fromEntries(input.repos.map((repo) => [repo.id, repo.commit]));
      const previous = this.latest(timeline.id);
      const same = (pinned: Record<string, string>) =>
        input.repos.every((repo) => pinned[repo.id] === repo.commit);
      if (previous && same(Object.fromEntries(previous.repos.map((r) => [r.id, r.commit]))))
        fail(
          "unchanged",
          `Checkpoint #${previous.number} already pins these commits; push new work first.`,
          409,
        );
      if (!previous && same(timeline.forkPoint.commits))
        fail("no_work", `${timeline.slug} has no commits since it forked; push work first.`, 409);
      const now = this.now();
      const checkpoint: Checkpoint = {
        id: `cp_${crypto.randomUUID()}`,
        timelineId: timeline.id,
        number: (previous?.number ?? 0) + 1,
        repos: input.repos.map((repo) => ({
          id: repo.id,
          owner: repo.owner,
          name: repo.name,
          commit: repo.commit,
          base: repo.base,
          changes: repo.changes.map((c) => ({ changeId: c.changeId, commit: c.commit })),
        })),
        summary,
        actorId: access.actorId,
        accountableId: access.principalId,
        createdAt: now,
      };
      run(
        this.sql,
        tracker.insertInto("timeline_checkpoints").values({
          id: checkpoint.id,
          timeline_id: timeline.id,
          number: checkpoint.number,
          data: JSON.stringify(checkpoint),
        }),
      );
      // The checkpoint measured the bookmarks: those are the heads now.
      run(this.sql, tracker.deleteFrom("timeline_heads").where("timeline_id", "=", timeline.id));
      for (const repo of checkpoint.repos) this.setHead(timeline.id, repo.id, repo.commit);
      this.append(
        {
          id: `checkpoint:${checkpoint.id}`,
          timelineId: timeline.id,
          kind: "checkpoint",
          checkpointId: checkpoint.id,
          number: checkpoint.number,
          commits,
          summary,
          actorId: access.actorId,
          accountableId: access.principalId,
          createdAt: now,
        },
        [timeline.id],
      );
      // A new head leaves any approval of the old one behind.
      this.supersede(
        timeline,
        `Superseded by checkpoint #${checkpoint.number} on ${timelineBookmark(timeline.slug)}; ask about that one instead.`,
        access.actorId,
        access.principalId,
      );
      if (this.status(timeline)) {
        timeline.version++;
        timeline.updatedAt = now;
        this.save(timeline, "timeline.status", access.actorId);
      }
      return this.state(checkpoint);
    });
  }
  /**
   * The checkpoint an approval request will pin, inside the caller's
   * transaction: it must be its timeline's head, and the timeline still open.
   */
  approvalTarget(checkpointId: string): RequestCheckpoint {
    const checkpoint = this.findCheckpoint(checkpointId);
    if (!checkpoint) fail("not_found", `No checkpoint ${checkpointId}.`, 404);
    const timeline = this.byId(checkpoint.timelineId);
    if (ENDED.includes(timeline.status))
      fail("timeline_ended", `${timeline.slug} is ${timeline.status}.`, 409);
    if (!this.isCurrent(checkpoint))
      fail(
        "checkpoint_stale",
        `Checkpoint #${checkpoint.number} of ${timeline.slug} isn't its head any more; make a new checkpoint and ask about that.`,
        409,
      );
    return {
      id: checkpoint.id,
      number: checkpoint.number,
      timelineId: timeline.id,
      timeline: timeline.slug,
    };
  }
  /**
   * A person answers a checkpoint's approval request, inside the caller's
   * transaction. Approving needs write access to each of its repositories
   * (`writableRepoIds`, from D1) and only works while it is still the head:
   * new commits need a new checkpoint and a new approval. Records the
   * approval event; the caller settles the status once the request is saved.
   */
  answerApproval(
    access: Access,
    request: HumanRequest,
    approved: boolean,
    note: string | null,
    writableRepoIds: string[] | undefined,
  ) {
    const pinned = request.checkpoint!;
    const checkpoint = this.findCheckpoint(pinned.id);
    if (!checkpoint) fail("not_found", `No checkpoint ${pinned.id}.`, 404);
    for (const repo of checkpoint.repos)
      if (!writableRepoIds?.includes(repo.id))
        fail(
          "forbidden",
          `Approving a checkpoint needs write access to ${repo.owner}/${repo.name}.`,
          403,
        );
    const timeline = this.byId(checkpoint.timelineId);
    if (approved && ENDED.includes(timeline.status))
      fail("timeline_ended", `${timeline.slug} is ${timeline.status}.`, 409);
    if (approved && !this.isCurrent(checkpoint))
      fail(
        "checkpoint_stale",
        `${timeline.slug} has moved past checkpoint #${checkpoint.number}: it needs a new checkpoint and a new approval.`,
        409,
      );
    this.append(
      {
        id: `approval:${request.id}`,
        timelineId: timeline.id,
        kind: "approval",
        checkpointId: checkpoint.id,
        number: checkpoint.number,
        requestId: request.id,
        outcome: approved ? "approved" : "rejected",
        note,
        actorId: access.actorId,
        accountableId: access.principalId,
        createdAt: this.now(),
      },
      [timeline.id],
    );
  }

  // ---- landing (CORE-77) -----------------------------------------------------

  /** A timeline's newest landing, if it was ever queued. */
  landing(slug: string): Landing | null {
    const timeline = this.get(slug);
    const row = first(
      this.sql,
      tracker
        .selectFrom("timeline_landings")
        .select("data")
        .where("timeline_id", "=", timeline.id)
        .orderBy("created_at", "desc")
        .orderBy("id", "desc")
        .limit(1),
    );
    return row ? (JSON.parse(row.data) as Landing) : null;
  }
  private landingById(id: string): Landing {
    const row = first(
      this.sql,
      tracker.selectFrom("timeline_landings").select("data").where("id", "=", id),
    );
    if (!row) fail("not_found", `No landing ${id}.`, 404);
    return JSON.parse(row.data) as Landing;
  }
  /** Every landing still at work, oldest first: what a sweep moves on. */
  activeLandings(): Landing[] {
    return all(
      this.sql,
      tracker.selectFrom("timeline_landings").select("data").orderBy("created_at"),
    )
      .map((row) => JSON.parse(row.data) as Landing)
      .filter((landing) => LANDING_ACTIVE.includes(landing.state));
  }
  /** The landing a CI run belongs to: a merge or the gates of one of its repositories. */
  landingForRun(slug: string, runId: string): Landing | null {
    const landing = this.find(slug) ? this.landing(slug) : null;
    if (!landing) return null;
    return landing.repos.some((r) => r.mergeRun?.id === runId || r.gateRun?.id === runId)
      ? landing
      : null;
  }
  /**
   * Queue a landing of the timeline's head checkpoint, or say why not
   * (TIMELINES-RESEARCH.md, "Landing"): an `approval` timeline needs that
   * checkpoint approved while it is still the head, an `auto` one needs it
   * green. The experimental flag doesn't matter. A landing already under way
   * is returned as it is (`queued: false`). After a landing of the same
   * checkpoint stopped partway, mains that advanced stay advanced.
   */
  beginLanding(
    access: Access,
    slug: string,
    request: LandingRequest,
  ): { landing: Landing; queued: boolean } {
    return this.transaction(() => {
      const timeline = this.get(slug);
      if (ENDED.includes(timeline.status))
        fail("timeline_ended", `${timeline.slug} is ${timeline.status}.`, 409);
      const previous = this.landing(slug);
      if (previous && LANDING_ACTIVE.includes(previous.state))
        return { landing: previous, queued: false };
      const head = this.latest(timeline.id);
      if (!head)
        fail(
          "no_checkpoint",
          `${timeline.slug} has no checkpoint to land; make one with gm timeline checkpoint.`,
          409,
        );
      const state = this.state(head);
      if (!state.current)
        fail(
          "checkpoint_stale",
          `${timeline.slug} has commits since checkpoint #${head.number}; make a new checkpoint to land them.`,
          409,
        );
      if (timeline.policy === "approval" && !state.approved)
        fail(
          "needs_approval",
          state.approval?.state === "pending"
            ? `Checkpoint #${head.number} of ${timeline.slug} is waiting for a person's approval; it lands once approved.`
            : state.approval?.state === "rejected"
              ? `Checkpoint #${head.number} of ${timeline.slug} was rejected; push fixes, make a new checkpoint and ask again.`
              : `Checkpoint #${head.number} of ${timeline.slug} needs a person's approval to land; ask for it with gm issue ask --kind approval --checkpoint ${head.id}.`,
          409,
        );
      if (timeline.policy === "auto" && !request.green.ok)
        fail(
          "not_green",
          request.green.why ??
            `Checkpoint #${head.number} of ${timeline.slug} isn't green yet; it lands once its CI runs succeed.`,
          409,
        );
      // A green checkpoint doesn't retry on its own a landing that stopped.
      if (
        request.trigger === "auto" &&
        previous?.checkpointId === head.id &&
        (previous.state === "conflict" || previous.state === "failed")
      )
        fail(
          "landing_stopped",
          `Landing checkpoint #${head.number} of ${timeline.slug} stopped: ${previous.reason ?? previous.state}.`,
          409,
        );
      const now = this.now();
      // Mains an earlier landing of this checkpoint advanced stay advanced.
      const advanced = new Map(
        (previous?.checkpointId === head.id ? previous.repos : [])
          .filter((repo) => repo.state === "advanced")
          .map((repo) => [repo.id, repo]),
      );
      const landing: Landing = {
        id: `ld_${crypto.randomUUID()}`,
        timelineId: timeline.id,
        slug: timeline.slug,
        checkpointId: head.id,
        checkpointNumber: head.number,
        state: "merging",
        repos: head.repos.map(
          (repo): LandingRepo =>
            advanced.get(repo.id) ?? {
              id: repo.id,
              owner: repo.owner,
              name: repo.name,
              commit: repo.commit,
              base: null,
              merge: null,
              attempt: 0,
              state: "merging",
              mergeRun: null,
              gateRun: null,
              reason: null,
            },
        ),
        reason: null,
        trigger: request.trigger,
        requestedBy: {
          actorId: access.actorId,
          accountableId: access.principalId,
          agentId: request.agentId,
        },
        version: 1,
        createdAt: now,
        updatedAt: now,
      };
      run(
        this.sql,
        tracker.insertInto("timeline_landings").values({
          id: landing.id,
          timeline_id: timeline.id,
          created_at: now,
          data: JSON.stringify(landing),
        }),
      );
      this.landingEvent(landing, "queued", null);
      this.landingStatus(timeline, landing, access.actorId);
      return { landing, queued: true };
    });
  }
  /**
   * Store a landing's next state (the Worker moves it on as its CI runs end
   * and mains advance), if nobody moved it since `expectedVersion`. The
   * timeline's status follows, and its events record a stop or an advance.
   * Moving to `advancing` needs the checkpoint to still be the head.
   */
  saveLanding(next: Landing, expectedVersion: number, actorId: string | null): Landing {
    return this.transaction(() => {
      const current = this.landingById(next.id);
      if (current.version !== expectedVersion)
        fail("version_conflict", "The landing changed since it was read.", 409);
      if (!LANDING_ACTIVE.includes(current.state))
        fail(
          "landing_ended",
          `That landing already ${current.state === "landed" ? "landed" : "stopped"}.`,
          409,
        );
      const timeline = this.byId(current.timelineId);
      // Abandoned while it was landing: it stops, and the timeline stays abandoned.
      if (timeline.status === "abandoned")
        next = {
          ...next,
          state: "failed",
          reason: `${timeline.slug} was abandoned while it was landing.`,
        };
      else if (next.state === "advancing" && current.state !== "advancing") {
        const checkpoint = this.findCheckpoint(current.checkpointId);
        if (!checkpoint || !this.isCurrent(checkpoint))
          fail(
            "checkpoint_stale",
            `${timeline.slug} has commits since checkpoint #${current.checkpointNumber}; make a new checkpoint to land them.`,
            409,
          );
      }
      const saved: Landing = {
        ...next,
        // What the landing is stays as it was queued.
        timelineId: current.timelineId,
        slug: current.slug,
        checkpointId: current.checkpointId,
        checkpointNumber: current.checkpointNumber,
        trigger: current.trigger,
        requestedBy: current.requestedBy,
        createdAt: current.createdAt,
        version: current.version + 1,
        updatedAt: this.now(),
      };
      run(
        this.sql,
        tracker
          .updateTable("timeline_landings")
          .set({ data: JSON.stringify(saved) })
          .where("id", "=", saved.id),
      );
      const advanced = (l: Landing) => l.repos.filter((r) => r.state === "advanced").length;
      const outcome: LandingOutcome | null =
        saved.state === "landed"
          ? "landed"
          : saved.state === "conflict" || saved.state === "failed"
            ? saved.state
            : advanced(saved) > advanced(current) && advanced(saved) < saved.repos.length
              ? "partly_landed"
              : null;
      if (outcome) this.landingEvent(saved, outcome, saved.reason);
      if (timeline.status !== "abandoned") this.landingStatus(timeline, saved, actorId);
      return saved;
    });
  }
  private landingEvent(landing: Landing, outcome: LandingOutcome, note: string | null) {
    const by = landing.requestedBy;
    this.append(
      {
        id: `landing:${landing.id}:${outcome}:${landing.version}`,
        timelineId: landing.timelineId,
        kind: "landing",
        landingId: landing.id,
        checkpointId: landing.checkpointId,
        number: landing.checkpointNumber,
        outcome,
        merges: Object.fromEntries(
          landing.repos
            .filter((r) => r.state === "advanced" && r.merge)
            .map((r) => [r.id, r.merge!]),
        ),
        note,
        actorId: by.agentId ?? by.actorId,
        accountableId: by.accountableId,
        createdAt: this.now(),
      },
      [landing.timelineId],
    );
  }
  /**
   * The timeline's status as its landing stands: `landing` while it works,
   * `partly_landed` once some main advanced and others haven't, `landed` at
   * the end; a stop with nothing advanced hands it back to its own statuses.
   */
  private landingStatus(timeline: Timeline, landing: Landing, actorId: string | null) {
    const advanced = landing.repos.filter((r) => r.state === "advanced").length;
    const partly = advanced > 0 && advanced < landing.repos.length;
    const next: TimelineStatus =
      landing.state === "landed"
        ? "landed"
        : partly
          ? "partly_landed"
          : LANDING_ACTIVE.includes(landing.state)
            ? "landing"
            : "active";
    if (next === timeline.status) return;
    timeline.status = next;
    // Back to its own statuses: waiting again if its head still awaits a person.
    if (next === "active") this.status(timeline);
    if (next === "landed") timeline.endedAt = this.now();
    timeline.version++;
    timeline.updatedAt = this.now();
    this.save(timeline, "timeline.status", actorId);
  }
}
