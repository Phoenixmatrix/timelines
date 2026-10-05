import { timingSafeEqual } from "node:crypto";
import {
  CLOSE_REASONS,
  DEFAULT_ATTEMPT_LIMIT,
  ISSUE_PICKUPS,
  issuePickup,
  SETTABLE_STATUSES,
  TIMELINE_USES,
  hasActiveClaim,
  isOpen,
  isRetained,
  leasedAncestor,
  readiness,
  readinessIndex,
  type Changes,
  type AuditActor,
  type AuditSource,
  type Comment,
  type HumanRequest,
  type IssueClaim,
  type IssueCloseReason,
  type IssueTimelineUse,
  type IssuePickup,
  type EntityType,
  type Issue,
  type Link,
  type Mutation,
  type MutationRequest,
  type MutationResult,
  type Snapshot,
  type Subscription,
  type Team,
  type TrackerAgent,
  TIMELINE_FEED_TYPES,
  type TimelineFeedEvent,
  type TrackerEvent,
  type TrackerIdentity,
  type Workspace,
} from "../../shared/tracker.ts";
import type { ShippedIssue } from "../../shared/release-notes.ts";
import {
  hasRequirements,
  normalizeRequirements,
  RequirementError,
  unmetRequirements,
  unmetText,
  type UnmetRequirement,
} from "../../shared/requirements.ts";
import type { QueueFailure } from "../../shared/merge-queue.ts";
import { sql as raw } from "kysely";
import { all, first, json, one, run, TIMELINE_TABLES, tracker, type SqlDatabase } from "./sql.ts";
import { auditActor, initializeAudit, indexAuditEvent, issueHistory } from "./audit.ts";
import { matchRank, matches, type MatchColumns, type SearchQuery } from "../search/query.ts";
import {
  TIMELINE_POLICIES,
  type CheckpointState,
  type Landing,
  type Timeline,
  type TimelineEvent,
  type TimelineIssue,
} from "../../shared/timelines.ts";
import { TimelineStore } from "./timelines.ts";
import { buildChronicle, type ChronicleOptions } from "./chronicle.ts";
import {
  CHRONICLE_MAX_PAGE,
  CHRONICLE_MAX_RANGE_MS,
  type Chronicle,
} from "../../shared/chronicle.ts";
import { feedFloor, RETENTION_TABLES, removedMessage, tombstone } from "./retention.ts";
import {
  findTimeline,
  isScoped,
  latestEntity,
  mainAfter,
  mergedInto,
  overlayOf,
  type Overlay,
  type ScopedType,
} from "./views.ts";

export type { SqlDatabase } from "./sql.ts";

const closeReasons = Object.keys(CLOSE_REASONS) as IssueCloseReason[];
const timelineUses = Object.keys(TIMELINE_USES) as IssueTimelineUse[];
const pickups = Object.keys(ISSUE_PICKUPS) as IssuePickup[];

export class TrackerError extends Error {
  public status: 400 | 401 | 403 | 404 | 409 | 410 | 413;
  public code: string;
  public details: {
    currentVersion?: number;
    current?: Team | Workspace | Issue;
    /** For requirements_unmet (CORE-32): each requirement the agent doesn't meet. */
    unmet?: UnmetRequirement[];
  };
  constructor(
    status: TrackerError["status"],
    code: string,
    message: string,
    details: TrackerError["details"] = {},
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export interface Access {
  /** Who actions are attributed to: an agent's id, or the person's. */
  actorId: string;
  /** Client-reported transport, not an authentication or permission input. */
  source?: AuditSource;
  /** Whose memberships and permissions apply: the person (an agent's accountable human). */
  principalId: string;
  /** Agents accountable to members: they may hold leases and be assigned work. */
  agents: TrackerAgent[];
  owner: TrackerIdentity;
  canAdmin: boolean;
  members: TrackerIdentity[];
  repos: { id: string; owner: string; name: string }[];
  /** D1-confirmed missing repositories; permits removing their orphan associations only. */
  deletedRepoIds?: string[];
  /** Repositories the person may write to, from D1: checked when approving a checkpoint. */
  writableRepoIds?: string[];
}
type Entity = Team | Workspace | Issue | Link | Comment | HumanRequest | Subscription;
const tables = {
  team: "teams",
  workspace: "workspaces",
  issue: "issues",
  link: "links",
  comment: "comments",
  request: "requests",
  subscription: "subscriptions",
} as const;
export function fail(code: string, message: string, status: TrackerError["status"] = 400): never {
  throw new TrackerError(status, code, message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_input", "Expected an object.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail("invalid_input", `Unknown field: ${key}.`);
}
export function text(value: unknown, name: string, max = 200, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (!empty && !value.trim()) ||
    value.includes("\u0000")
  )
    fail("invalid_input", `${name} must be ${empty ? "0" : "1"}–${max} characters without NUL.`);
  return value;
}
function id(value: unknown): string {
  const out = text(value, "id", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(out))
    fail("invalid_input", "IDs must use letters, digits, dots, underscores, colons or hyphens.");
  return out;
}
function strings(value: unknown, name: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max)
    fail("invalid_input", `${name} must be an array of at most ${max} entries.`);
  const out = value.map((v) => text(v, name, 100));
  if (new Set(out).size !== out.length)
    fail("invalid_input", `${name} must not contain duplicates.`);
  return out;
}
function choice<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (!values.includes(value as T)) fail("invalid_input", `Invalid ${name}.`);
  return value as T;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function validateRequest(value: unknown): MutationRequest {
  const body = object(value);
  keys(body, ["operationId", "mutations", "timeline"]);
  id(body.operationId);
  const timeline = body.timeline === undefined ? undefined : text(body.timeline, "timeline", 100);
  if (!Array.isArray(body.mutations) || body.mutations.length < 1 || body.mutations.length > 100)
    fail("invalid_input", "mutations must contain 1–100 operations.");
  for (const entry of body.mutations) {
    const mutation = object(entry);
    keys(mutation, ["kind", "id", "expectedVersion", "data"]);
    text(mutation.kind, "kind", 40);
    id(mutation.id);
    if (mutation.data !== undefined) object(mutation.data);
    if (
      "expectedVersion" in mutation &&
      (!Number.isSafeInteger(mutation.expectedVersion) || Number(mutation.expectedVersion) < 1)
    )
      fail("invalid_input", "expectedVersion must be a positive integer.");
  }
  return {
    operationId: String(body.operationId),
    mutations: body.mutations as Mutation[],
    ...(timeline === undefined ? {} : { timeline }),
  };
}

/** A finished issue's lease, kept by the timeline it was finished in (CORE-75). */
function retained(claim: IssueClaim, timeline: Timeline): IssueClaim {
  const { parkedAt: _parked, ...rest } = claim;
  return { ...rest, retainedIn: { id: timeline.id, slug: timeline.slug } };
}

/** What the tracker knows of an issue's work: its timelines, checkpoints and landings. */
export interface IssueWork {
  issue: Pick<Issue, "id" | "key" | "title" | "status">;
  timelines: { timeline: Timeline; checkpoints: CheckpointState[]; landings: Landing[] }[];
}
const WORK_TIMELINES = 20;
const WORK_CHECKPOINTS = 20;
const WORK_LANDINGS = 10;

/** After its last request is answered, a parked lease's holder has this long to resume. */
export const RESUME_WINDOW_SECONDS = 3600;

/**
 * Done in a timeline is locked wherever the issue shows it (CORE-74): only the
 * tracker's own transitions (merge, landing, abandoning, a reopen inside the
 * timeline) change it.
 */
export function lockedStatus(issue: Issue): never {
  const slug = issue.doneIn?.slug ?? "its timeline";
  fail(
    "done_in_timeline",
    `${issue.key} is done in timeline ${slug}; it lands with the timeline, or reopen it there with --timeline ${slug}.`,
    409,
  );
}

/** All state and event writes run synchronously inside the caller's SQLite transaction. */
export class TrackerStore {
  private sql: SqlDatabase;
  private transaction: <T>(fn: () => T) => T;
  private clock: () => number;
  /** While reading or changing a timeline's view: how it differs from main's tables. */
  private overlay: Overlay | null = null;
  /**
   * Timelines and the checkpoints approval requests pin (CORE-76), in the same
   * storage; it withdraws superseded approvals through this store.
   */
  readonly timelines: TimelineStore;
  /** While the tracker withdraws a superseded approval: why. */
  private withdrawing: string | null = null;
  constructor(
    sql: SqlDatabase,
    transaction: <T>(fn: () => T) => T,
    clock: () => number = Date.now,
  ) {
    this.sql = sql;
    this.transaction = transaction;
    this.clock = clock;
    sql.exec(TIMELINE_TABLES);
    sql.exec(`CREATE TABLE IF NOT EXISTS teams (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issues (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tracker_labels (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subscriptions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS team_numbers (id TEXT PRIMARY KEY, number INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (issue_id TEXT PRIMARY KEY, token TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS offers (issue_id TEXT PRIMARY KEY, code TEXT NOT NULL, lease_token TEXT NOT NULL, to_actor TEXT, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (cursor INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS team_keys ON teams(json_extract(data, '$.key'));
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_slugs ON workspaces(json_extract(data, '$.slug'));
      CREATE INDEX IF NOT EXISTS blockers ON links(json_extract(data, '$.toId'), json_extract(data, '$.kind'));
      CREATE INDEX IF NOT EXISTS subscriptions_repo ON subscriptions(json_extract(data, '$.repoId'));
      CREATE INDEX IF NOT EXISTS parents ON issues(json_extract(data, '$.parentId'));
      CREATE INDEX IF NOT EXISTS request_issues ON requests(json_extract(data, '$.issueId'));
      CREATE INDEX IF NOT EXISTS issue_keys ON issues(json_extract(data, '$.key'));
      CREATE INDEX IF NOT EXISTS comment_issues ON comments(json_extract(data, '$.issueId'));
      CREATE INDEX IF NOT EXISTS event_entities ON events(json_extract(data, '$.entityId'));
      CREATE INDEX IF NOT EXISTS event_times ON events(json_extract(data, '$.createdAt'));
      CREATE INDEX IF NOT EXISTS event_timelines ON events(json_extract(data, '$.timelineId'));`);
    sql.exec(RETENTION_TABLES);
    initializeAudit(sql, transaction);
    if (
      !first(
        this.sql,
        tracker.selectFrom("tracker_migrations").select("name").where("name", "=", "labels-v1"),
      )
    ) {
      transaction(() => {
        // Timeline-only issues live in the event log. Include both views and
        // history so an already-used definition does not disappear on upgrade.
        sql.exec(`INSERT OR IGNORE INTO tracker_labels (name)
          SELECT label.value FROM issues, json_each(issues.data, '$.labels') AS label
          WHERE label.type = 'text'`);
        sql.exec(`INSERT OR IGNORE INTO tracker_labels (name)
          SELECT label.value FROM events, json_each(events.data, '$.entity.labels') AS label
          WHERE json_extract(events.data, '$.entityType') = 'issue' AND label.type = 'text'`);
        sql.exec(`INSERT OR IGNORE INTO tracker_labels (name)
          SELECT label.value FROM events, json_each(events.data, '$.view.entity.labels') AS label
          WHERE json_extract(events.data, '$.entityType') = 'issue' AND label.type = 'text';`);
        run(sql, tracker.insertInto("tracker_migrations").values({ name: "labels-v1" }));
      });
    }
    this.timelines = new TimelineStore(sql, transaction, clock, (ids, reason, actorId) =>
      this.withdrawSuperseded(ids, reason, actorId),
    );
  }
  /** Admission only: resolve main-view issues and enforce the submitter's team write scope. */
  validateQueueIssues(access: Access, references: string[]): string[] {
    const refs = strings(references, "issues", 20);
    const issues = this.all<Issue>("issue");
    return [
      ...new Set(
        refs.map((ref) => {
          const issue = issues.find((entry) => entry.id === ref || entry.key === ref);
          if (!issue) fail("not_found", `Issue ${ref} not found in main.`, 404);
          const team = this.get<Team>("team", issue.teamId);
          if (team.archived) fail("archived", "Team is archived.", 409);
          if (
            !access.canAdmin &&
            team.memberIds.length &&
            !team.memberIds.includes(access.principalId)
          )
            fail("forbidden", "Only team members may queue this team's work.", 403);
          return issue.id;
        }),
      ),
    ].sort();
  }

  /**
   * Worker-only transition, deliberately absent from Mutation. Admission checked
   * authority; this durable effect still runs if membership or leases change later.
   * A receipt and all issue/link/evidence writes commit together.
   */
  recordQueueFailure(
    access: Access,
    input: { repoId: string; issueIds: string[]; failure: QueueFailure },
  ): { id: string; key: string } {
    const failure = input.failure;
    text(input.repoId, "repoId", 100);
    for (const field of ["queueId", "commit"] as const)
      if (!/^[0-9a-f]{40}$/.test(failure[field])) fail("invalid_input", `Invalid ${field}.`);
    if (!/^[^/\s]+\/[^/\s]+$/.test(text(failure.repo, "repo", 200)))
      fail("invalid_input", "repo must be owner/name.");
    choice(failure.stage, ["merge", "gates", "deployment"], "failure stage");
    choice(
      failure.kind,
      [
        "build_failed",
        "conflict",
        "unsafe_conflict",
        "repair_failed",
        "infrastructure",
        "configuration",
      ],
      "failure kind",
    );
    text(failure.reason, "reason", 4000);
    if (
      failure.runNumber !== null &&
      (!Number.isSafeInteger(failure.runNumber) || failure.runNumber < 1)
    )
      fail("invalid_input", "runNumber must be positive or null.");
    if (
      failure.attempt !== undefined &&
      (!Number.isSafeInteger(failure.attempt) || failure.attempt < 1)
    )
      fail("invalid_input", "attempt must be positive.");
    if (!Number.isFinite(Date.parse(failure.occurredAt)))
      fail("invalid_input", "Invalid failure time.");
    for (const field of ["failedJobs", "conflictPaths"] as const) {
      if (!Array.isArray(failure[field]) || failure[field].length > 100)
        fail("invalid_input", `Invalid ${field}.`);
      failure[field].forEach((value) => text(value, field, 1024));
    }
    for (const field of ["classificationModel", "repairModel"] as const)
      if (failure[field] !== null) text(failure[field], field, 200);
    const issueIds = strings(input.issueIds, "issues", 20).sort();
    const operationId = `queue-failure:${input.repoId}:${failure.queueId}:${failure.attempt ?? 0}:${failure.stage}:${failure.runNumber ?? 0}`;
    const encoded = canonical({ repoId: input.repoId, issueIds, failure });
    return this.transaction(() => {
      const receipt = first(
        this.sql,
        tracker.selectFrom("receipts").selectAll().where("id", "=", operationId),
      );
      if (receipt) {
        if (receipt.request !== encoded)
          fail("operation_conflict", "Queue failure identity already has different evidence.", 409);
        return JSON.parse(receipt.result) as { id: string; key: string };
      }
      // Resolve everything before writes; missing originals must never become a partial effect.
      const originals = issueIds.map((issueId) => this.get<Issue>("issue", issueId));
      const now = new Date(this.clock()).toISOString();
      const actor = auditActor(access);
      const emit = (type: EntityType, entity: Entity, kind: string) => {
        const prior = first(
          this.sql,
          tracker.selectFrom(tables[type]).select("data").where("id", "=", entity.id),
        );
        const before = prior ? (JSON.parse(prior.data) as Entity) : null;
        run(
          this.sql,
          tracker
            .insertInto(tables[type])
            .values({ id: entity.id, data: JSON.stringify(entity) })
            .onConflict((oc) => oc.column("id").doUpdateSet({ data: JSON.stringify(entity) })),
        );
        this.record({
          operationId,
          actorId: access.actorId,
          actor,
          source: "unknown",
          mutationKind: "queue.failure",
          kind,
          entityType: type,
          entityId: entity.id,
          entity,
          before,
          createdAt: now,
        });
      };
      let team = originals.length ? this.get<Team>("team", originals[0]!.teamId) : undefined;
      if (!team || team.archived) {
        team = this.all<Team>("team").find((entry) => entry.key === "MERGE");
        if (!team) {
          team = {
            id: crypto.randomUUID(),
            key: "MERGE",
            name: "Merge remediation",
            description: "Failures reported by the repository merge queue.",
            memberIds: [],
            archived: false,
            version: 1,
            createdAt: now,
            updatedAt: now,
          };
          emit("team", team, "team.create");
        } else if (team.archived) {
          // The dedicated system team must remain available for new failures.
          team = { ...team, archived: false, version: team.version + 1, updatedAt: now };
          emit("team", team, "team.update");
        }
      }
      const number = one(
        this.sql,
        tracker
          .insertInto("team_numbers")
          .values({ id: team.id, number: raw.lit(1) })
          .onConflict((oc) =>
            oc.column("id").doUpdateSet((eb) => ({ number: eb("number", "+", raw.lit(1)) })),
          )
          .returning("number"),
      ).number;
      const remediation: Issue = {
        id: crypto.randomUUID(),
        key: `${team.key}-${number}`,
        teamId: team.id,
        title: `Repair ${failure.repo} queue ${failure.stage} failure`,
        description: failure.reason,
        acceptance: "Push a fix and verify the failed queue stage with real run evidence.",
        type: "remediation",
        status: "todo",
        priority: 0,
        assigneeId: null,
        parentId: null,
        workspaceIds: [],
        labels: [],
        claim: null,
        createdBy: actor,
        version: 1,
        createdAt: now,
        updatedAt: now,
        queueFailure: failure,
      };
      emit("issue", remediation, "issue.create");
      const evidence = `Merge queue failure\n\n${JSON.stringify(failure, null, 2)}`;
      for (const issue of [...originals, remediation]) {
        if (issue.id !== remediation.id) {
          // A delayed earlier callback must not replace a newer failure's summary.
          if (
            !issue.queueFailure ||
            Date.parse(issue.queueFailure.occurredAt) <= Date.parse(failure.occurredAt)
          )
            emit(
              "issue",
              { ...issue, queueFailure: failure, version: issue.version + 1, updatedAt: now },
              "issue.update",
            );
          emit(
            "link",
            { id: crypto.randomUUID(), fromId: remediation.id, toId: issue.id, kind: "related" },
            "link.create",
          );
        }
        emit(
          "comment",
          {
            id: crypto.randomUUID(),
            issueId: issue.id,
            body: evidence,
            kind: "evidence",
            actorId: access.actorId,
            createdAt: now,
          },
          "comment.add",
        );
      }
      const result = { id: remediation.id, key: remediation.key };
      run(
        this.sql,
        tracker.insertInto("receipts").values({
          id: operationId,
          actor_id: access.actorId,
          request: encoded,
          result: JSON.stringify(result),
        }),
      );
      return result;
    });
  }
  /**
   * Withdraw approval requests whose checkpoint the timeline moved past, inside
   * the caller's transaction: each a `request.cancel` in the view it was asked
   * in, so its issue's parked lease unparks as for any withdrawal. The reason
   * becomes the request's answer; the actor is whoever moved the timeline.
   */
  private withdrawSuperseded(ids: string[], reason: string, actorId: string | null) {
    const by = actorId ?? "gitmatrix";
    const access: Access = {
      actorId: by,
      principalId: by,
      source: "unknown",
      agents: [],
      owner: { id: "", slug: "", displayName: "" },
      canAdmin: true,
      members: [],
      repos: [],
    };
    for (const requestId of ids) {
      const opened = first(
        this.sql,
        tracker
          .selectFrom("events")
          .select("data")
          .where(json("data", "$.entityId"), "=", requestId)
          .where(json("data", "$.kind"), "=", "request.open")
          .orderBy("cursor")
          .limit(1),
      );
      const asked = opened ? (JSON.parse(opened.data) as TrackerEvent).timelineId : undefined;
      const timeline = asked ? findTimeline(this.sql, asked) : null;
      const request: MutationRequest = {
        operationId: `superseded:${requestId}`,
        mutations: [{ kind: "request.cancel", id: requestId }],
      };
      this.withdrawing = reason;
      try {
        this.within(timeline, () => this.apply(access, request, canonical(request), timeline));
      } finally {
        this.withdrawing = null;
      }
    }
  }
  private all<T extends Entity>(type: EntityType): T[] {
    const rows = all(this.sql, tracker.selectFrom(tables[type]).select("data").orderBy("id")).map(
      (r) => JSON.parse(r.data) as T,
    );
    return this.overlay && isScoped(type) ? this.overlay.merge(type, rows) : rows;
  }
  private get<T extends Entity>(type: EntityType, entityId: string): T {
    if (this.overlay && isScoped(type) && this.overlay.has(type, entityId)) {
      const entity = this.overlay.get(type, entityId);
      if (!entity) fail("not_found", `${type} ${entityId} not found in this timeline.`, 404);
      return structuredClone(entity) as T;
    }
    const row = first(
      this.sql,
      tracker.selectFrom(tables[type]).select("data").where("id", "=", entityId),
    );
    if (!row) {
      const stone = type === "issue" ? tombstone(this.sql, "issue", entityId) : null;
      if (stone) fail("removed_by_retention", removedMessage(stone), 404);
      fail("not_found", `${type} ${entityId} not found.`, 404);
    }
    return JSON.parse(row.data) as T;
  }
  /** The timeline a request names (slug or id); null for main. */
  private timeline(ref: string | undefined): Timeline | null {
    if (ref === undefined || ref === "main") return null;
    const timeline = findTimeline(this.sql, ref);
    if (!timeline) fail("not_found", `No timeline ${ref}.`, 404);
    return timeline;
  }
  /** Run `fn` against a timeline's view (main's when null). */
  private within<T>(timeline: Timeline | null, fn: () => T): T {
    if (!timeline) return fn();
    const previous = this.overlay;
    this.overlay = overlayOf(this.sql, timeline);
    try {
      return fn();
    } finally {
      this.overlay = previous;
    }
  }
  /** Append an event to the log, indexed for issue history. */
  private record(event: Omit<TrackerEvent, "cursor">): TrackerEvent {
    if (event.entityType === "issue") {
      for (const entity of [event.entity, event.view?.entity]) {
        for (const name of (entity as Issue | null | undefined)?.labels ?? [])
          run(
            this.sql,
            tracker
              .insertInto("tracker_labels")
              .values({ name })
              .onConflict((oc) => oc.doNothing()),
          );
      }
    }
    const cursor = one(
      this.sql,
      tracker
        .insertInto("events")
        .values({ data: JSON.stringify(event) })
        .returning("cursor"),
    ).cursor;
    const recorded = { ...event, cursor } as TrackerEvent;
    indexAuditEvent(this.sql, recorded as Parameters<typeof indexAuditEvent>[1]);
    return recorded;
  }
  /** An issue as whichever view has it: main's, else the timeline it last changed in. */
  private anyIssue(issueId: string): Issue {
    const row = first(
      this.sql,
      tracker.selectFrom("issues").select("data").where("id", "=", issueId),
    );
    if (row) return JSON.parse(row.data) as Issue;
    const latest = latestEntity(this.sql, "issue", issueId);
    if (!latest) {
      const stone = tombstone(this.sql, "issue", issueId);
      if (stone) fail("removed_by_retention", removedMessage(stone), 404);
      fail("not_found", `issue ${issueId} not found.`, 404);
    }
    return latest as Issue;
  }
  private cursor(): number {
    return one(
      this.sql,
      tracker
        .selectFrom("events")
        .select((eb) => eb.fn.coalesce(eb.fn.max("cursor"), eb.lit(0)).as("cursor")),
    ).cursor;
  }
  /**
   * Main's view, or with `timeline` (slug or id) that timeline's. With
   * `withTimelines`, the timeline records and their events too.
   */
  snapshot(access: Access, timeline?: string, withTimelines = false): Snapshot {
    const scope = this.timeline(timeline);
    return this.within(scope, () => ({
      owner: access.owner,
      canAdmin: access.canAdmin,
      members: access.members,
      agents: access.agents,
      teams: this.all("team"),
      workspaces: this.all("workspace"),
      labels: all(this.sql, tracker.selectFrom("tracker_labels").select("name"))
        .map((row) => row.name)
        .sort(),
      issues: this.all("issue"),
      links: this.all("link"),
      comments: this.all("comment"),
      requests: this.all("request"),
      subscriptions: this.all("subscription"),
      cursor: this.cursor(),
      serverTime: new Date(this.clock()).toISOString(),
      ...(this.overlay ? { timeline: this.overlay.scope() } : {}),
      ...(withTimelines ? this.timelineRecords() : {}),
    }));
  }
  /** Every timeline and timeline event, for replicas that keep them. */
  private timelineRecords(): Pick<Snapshot, "timelines" | "timelineEvents"> {
    return {
      timelines: all(this.sql, tracker.selectFrom("timelines").select("data").orderBy("id")).map(
        (row) => JSON.parse(row.data) as Timeline,
      ),
      timelineEvents: all(
        this.sql,
        tracker.selectFrom("timeline_events").select(["seq", "data"]).orderBy("seq"),
      ).map((row) => ({ ...JSON.parse(row.data), seq: row.seq }) as TimelineEvent),
    };
  }
  /** Open requests to people, with the issue each is about. */
  openRequests(): { request: HumanRequest; issue: Pick<Issue, "id" | "key" | "title"> }[] {
    return this.all<HumanRequest>("request")
      .filter((request) => request.status === "open")
      .map((request) => {
        const issue = this.anyIssue(request.issueId);
        return { request, issue: { id: issue.id, key: issue.key, title: issue.title } };
      });
  }
  subscribedWorkspaces(repoId: string): { workspaceId: string; slug: string; name: string }[] {
    id(repoId);
    return all(
      this.sql,
      tracker
        .selectFrom("subscriptions as s")
        .innerJoin("workspaces as w", (join) =>
          join.on("w.id", "=", json<string>("s.data", "$.workspaceId")),
        )
        .select([
          "w.id as workspaceId",
          json<string>("w.data", "$.slug").as("slug"),
          json<string>("w.data", "$.name").as("name"),
        ])
        .distinct()
        .where(json("s.data", "$.repoId"), "=", repoId)
        .where(json("w.data", "$.archived"), "=", raw.lit(0))
        .orderBy("slug"),
    );
  }
  subscriptionRepoIds(subscriptionIds: string[]): string[] {
    if (!subscriptionIds.length) return [];
    return all(
      this.sql,
      tracker
        .selectFrom("subscriptions")
        .select(json<string>("data", "$.repoId").as("repoId"))
        .distinct()
        .where("id", "in", subscriptionIds),
    ).map((row) => row.repoId);
  }
  /** Every workspace's id and slug, archived ones included, for resolving filters. */
  workspaceSlugs(): { id: string; slug: string }[] {
    return this.all<Workspace>("workspace").map(({ id, slug }) => ({ id, slug }));
  }
  /** Issues by key, as release notes see them; unknown keys are skipped. */
  issuesByKey(keys: string[]): ShippedIssue[] {
    if (keys.length > 500) fail("invalid_input", "Look up at most 500 keys at once.");
    if (!keys.length) return [];
    return all(
      this.sql,
      tracker.selectFrom("issues").select("data").where(json("data", "$.key"), "in", keys),
    ).map((row) => this.shipped(JSON.parse(row.data) as Issue));
  }
  /**
   * Issues by key or id, as a reference in text names them (CORE-22,
   * worker/refs): just enough to label a link. Unknown refs are skipped.
   * Every member may read every issue, so the caller authorizes the tracker.
   */
  issueRefs(refs: string[]): Pick<Issue, "id" | "key" | "title" | "status">[] {
    if (refs.length > 500) fail("invalid_input", "Look up at most 500 issues at once.");
    if (!refs.length) return [];
    return all(
      this.sql,
      tracker
        .selectFrom("issues")
        .select("data")
        .where((eb) => eb.or([eb(json("data", "$.key"), "in", refs), eb("id", "in", refs)])),
    ).map((row) => {
      const { id, key, title, status } = JSON.parse(row.data) as Issue;
      return { id, key, title, status };
    });
  }
  /**
   * Issues matching a global search (worker/search), open and closed, best
   * first: by match, then priority, most recently updated, ID. Keys are the
   * exact identifiers; titles rank prefixes and words; descriptions only
   * contain. Every member may read every issue, so the caller authorizes the
   * tracker, not the rows.
   */
  searchIssues(query: SearchQuery, limit: number): { issue: Issue; rank: number }[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
      fail("invalid_input", "limit must be 1–200.");
    const key = json<string>("data", "$.key");
    const title = json<string>("data", "$.title");
    const columns: MatchColumns = {
      identifiers: [key],
      names: [title, key],
      searched: [key, title, json<string>("data", "$.description")],
    };
    return all(
      this.sql,
      tracker
        .selectFrom("issues")
        .select("data")
        .select(matchRank(columns, query).as("rank"))
        .where(matches(columns, query))
        .orderBy("rank")
        .orderBy(json("data", "$.priority"))
        .orderBy(json("data", "$.updatedAt"), "desc")
        .orderBy("id")
        .limit(limit),
    ).map((row) => ({ issue: JSON.parse(row.data) as Issue, rank: row.rank }));
  }
  /** Issues that became done in [since, until) and still are, oldest first. */
  completedBetween(since: string, until: string, limit: number): ShippedIssue[] {
    if (Number.isNaN(Date.parse(since)) || Number.isNaN(Date.parse(until)))
      fail("invalid_input", "since and until must be ISO timestamps.");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500)
      fail("invalid_input", "limit must be 1–500.");
    const ids = all(
      this.sql,
      tracker
        .selectFrom("events")
        .select(json<string>("data", "$.entityId").as("issueId"))
        .distinct()
        .where(json("data", "$.createdAt"), ">=", since)
        .where(json("data", "$.createdAt"), "<", until)
        .where(json("data", "$.entityType"), "=", "issue")
        .where(json("data", "$.entity.status"), "=", "done"),
    ).map((row) => row.issueId);
    return ids
      .flatMap((issueId) => {
        const row = first(
          this.sql,
          tracker.selectFrom("issues").select("data").where("id", "=", issueId),
        );
        return row ? [this.shipped(JSON.parse(row.data) as Issue)] : [];
      })
      .filter((issue) => issue.completedAt! >= since && issue.completedAt! < until)
      .sort((a, b) => a.completedAt!.localeCompare(b.completedAt!) || a.key.localeCompare(b.key))
      .slice(0, limit);
  }
  private shipped(issue: Issue): ShippedIssue {
    const team = this.get<Team>("team", issue.teamId);
    // The issue's own history: it was completed when it last entered done.
    let completedAt: string | null = null;
    let done = false;
    for (const row of all(
      this.sql,
      tracker
        .selectFrom("events")
        .select("data")
        .where(json("data", "$.entityId"), "=", issue.id)
        .where(json("data", "$.entityType"), "=", "issue")
        .orderBy("cursor"),
    )) {
      const event = JSON.parse(row.data) as TrackerEvent;
      const now = (event.entity as Issue | null)?.status === "done";
      if (now && !done) completedAt = event.createdAt;
      done = now;
    }
    const evidence = all(
      this.sql,
      tracker
        .selectFrom("comments")
        .select("data")
        .where(json("data", "$.issueId"), "=", issue.id)
        .where(json("data", "$.kind"), "=", "evidence"),
    )
      .map((row) => JSON.parse(row.data) as Comment)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ body, actorId, createdAt }) => ({ body, actorId, createdAt }));
    return {
      id: issue.id,
      key: issue.key,
      title: issue.title,
      description: issue.description,
      type: issue.type,
      status: issue.status,
      labels: issue.labels,
      workspaceIds: issue.workspaceIds,
      team: { id: team.id, key: team.key, name: team.name },
      completedAt: issue.status === "done" ? completedAt : null,
      evidence,
    };
  }
  /**
   * Events after a cursor. Timeline records and events (`TIMELINE_FEED_TYPES`)
   * are left out unless the replica asks for them with `withTimelines`.
   */
  changes(after: number, limit: number, withTimelines = false): Changes {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 500
    )
      fail("invalid_input", "after must be a nonnegative integer; limit must be 1–500.");
    // Retention pruned events after this cursor: the replica must start over.
    if (after < feedFloor(this.sql))
      fail(
        "cursor_expired",
        "This replica is older than the tracker's retained activity; fetch a fresh snapshot.",
        410,
      );
    let query = tracker
      .selectFrom("events")
      .select(["cursor", "data"])
      .where("cursor", ">", after)
      .orderBy("cursor")
      .limit(limit + 1);
    if (!withTimelines)
      query = query.where(json("data", "$.entityType"), "not in", [...TIMELINE_FEED_TYPES]);
    const rows = all(this.sql, query);
    const events = rows
      .slice(0, limit)
      .map(
        (row) =>
          ({ ...JSON.parse(row.data), cursor: row.cursor }) as TrackerEvent | TimelineFeedEvent,
      );
    return {
      events,
      cursor: events.at(-1)?.cursor ?? after,
      hasMore: rows.length > limit,
      serverTime: new Date(this.clock()).toISOString(),
    };
  }
  history(access: Access, issueId: string, before: number | null, limit: number) {
    id(issueId);
    if (
      (before !== null && (!Number.isSafeInteger(before) || before < 1)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      fail("invalid_input", "before must be a positive integer; limit must be 1–100.");
    const row =
      first(this.sql, tracker.selectFrom("issues").select("data").where("id", "=", issueId)) ??
      first(
        this.sql,
        tracker
          .selectFrom("issues")
          .select("data")
          .where(json("data", "$.key"), "=", issueId.toUpperCase()),
      );
    if (row) return issueHistory(this.sql, access, JSON.parse(row.data) as Issue, before, limit);
    // An issue only timelines have: found through the events that made it.
    const made = first(
      this.sql,
      tracker
        .selectFrom("events")
        .select(json<string>("data", "$.entityId").as("id"))
        .where(json("data", "$.timelineId"), "is not", null)
        .where(json("data", "$.entityType"), "=", "issue")
        .where((eb) =>
          eb.or([
            eb(json("data", "$.entityId"), "=", issueId),
            eb(json("data", "$.view.entity.key"), "=", issueId.toUpperCase()),
          ]),
        )
        .limit(1),
    );
    if (!made) {
      const stone = tombstone(this.sql, "issue", issueId);
      if (stone) fail("removed_by_retention", removedMessage(stone), 404);
      fail("not_found", `Issue ${issueId} not found.`, 404);
    }
    return issueHistory(this.sql, access, this.anyIssue(made.id), before, limit);
  }
  /**
   * One page of the Chronicle (CORE-250, worker/tracker/chronicle.ts): the
   * issues matching `query`, each as of `from` with what changed, who worked
   * it and what happened to it until `to`. Main's view.
   */
  chronicle(access: Access, options: ChronicleOptions): Chronicle {
    const from = Date.parse(options.from);
    const to = Date.parse(options.to);
    if (Number.isNaN(from) || Number.isNaN(to))
      fail("invalid_input", "from and to must be ISO timestamps.");
    if (to <= from) fail("invalid_input", "to must be after from.");
    if (to - from > CHRONICLE_MAX_RANGE_MS)
      fail("invalid_input", "A range covers at most 3 years.");
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > CHRONICLE_MAX_PAGE
    )
      fail("invalid_input", `limit must be 1–${CHRONICLE_MAX_PAGE}.`);
    if (options.query.length > 500) fail("invalid_input", "The query is at most 500 characters.");
    if (options.cursor !== null && (options.cursor.length > 100 || !options.cursor))
      fail("invalid_input", "cursor must be an issue key from a previous page.");
    const snapshot = {
      owner: access.owner,
      canAdmin: access.canAdmin,
      members: access.members,
      agents: access.agents,
      teams: this.all<Team>("team"),
      workspaces: this.all<Workspace>("workspace"),
      labels: all(this.sql, tracker.selectFrom("tracker_labels").select("name"))
        .map((row) => row.name)
        .sort(),
      issues: this.all<Issue>("issue"),
      links: this.all<Link>("link"),
      comments: [],
      requests: [],
      subscriptions: [],
      cursor: 0,
      serverTime: new Date(this.clock()).toISOString(),
    } satisfies Snapshot;
    return buildChronicle(
      this.sql,
      { viewerId: access.actorId, snapshot, known: (id) => auditActor(access, id) },
      {
        ...options,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      },
      this.clock(),
    );
  }
  /**
   * What the tracker knows of an issue's work (CORE-250): the timelines it was
   * worked in (made in, done in, retained by, or changed in), with their
   * checkpoints and landings. The Worker adds what D1 and the registry know.
   */
  issueWork(issueRef: string): IssueWork {
    const ref = text(issueRef, "issue", 200);
    const row =
      first(this.sql, tracker.selectFrom("issues").select("data").where("id", "=", ref)) ??
      first(
        this.sql,
        tracker
          .selectFrom("issues")
          .select("data")
          .where(json("data", "$.key"), "=", ref.toUpperCase()),
      );
    if (!row) {
      const stone = tombstone(this.sql, "issue", ref);
      if (stone) fail("removed_by_retention", removedMessage(stone), 404);
      fail("not_found", `Issue ${ref} not found.`, 404);
    }
    const issue = JSON.parse(row.data) as Issue;
    const ids = new Set<string>();
    for (const id of [issue.timelineId, issue.doneIn?.id, issue.claim?.retainedIn?.id])
      if (id) ids.add(id);
    for (const event of all(
      this.sql,
      tracker
        .selectFrom("issue_events as i")
        .innerJoin("events as e", "e.cursor", "i.cursor")
        .select(json<string | null>("e.data", "$.timelineId").as("timelineId"))
        .distinct()
        .where("i.issue_id", "=", issue.id)
        .where(json("e.data", "$.timelineId"), "is not", null),
    ))
      if (event.timelineId) ids.add(event.timelineId);
    const timelines = ids.size
      ? all(
          this.sql,
          tracker
            .selectFrom("timelines")
            .select("data")
            .where("id", "in", [...ids]),
        )
          .map((r) => JSON.parse(r.data) as Timeline)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, WORK_TIMELINES)
      : [];
    return {
      issue: { id: issue.id, key: issue.key, title: issue.title, status: issue.status },
      timelines: timelines.map((timeline) => ({
        timeline,
        checkpoints: this.timelines.checkpoints(timeline.slug).slice(-WORK_CHECKPOINTS),
        landings: all(
          this.sql,
          tracker
            .selectFrom("timeline_landings")
            .select("data")
            .where("timeline_id", "=", timeline.id)
            .orderBy("created_at", "desc")
            .limit(WORK_LANDINGS),
        ).map((r) => JSON.parse(r.data) as Landing),
      })),
    };
  }
  mutate(access: Access, input: unknown): MutationResult {
    const request = validateRequest(input);
    const encoded = canonical(request);
    if (new TextEncoder().encode(encoded).byteLength > 1_048_576)
      fail("body_too_large", "Mutation body exceeds 1 MiB.", 413);
    return this.transaction(() => {
      const timeline = this.timeline(request.timeline);
      if (timeline && (timeline.status === "landed" || timeline.status === "abandoned"))
        fail(
          "timeline_ended",
          `Timeline ${timeline.slug} is ${timeline.status}: its view is read-only. Work in main instead.`,
          409,
        );
      return this.within(timeline, () => this.apply(access, request, encoded, timeline));
    });
  }
  /**
   * Fold a landing timeline's tracker changes into main's view: each issue,
   * link and comment as the timeline (with its ancestors and what merged into
   * it) has it becomes main's, logged as a `timeline.land` event so replicas
   * of main follow. Landing (CORE-77) calls this in the transaction that marks
   * the timeline landed; views then leave the landed timeline out, since main
   * has its changes. Landing twice changes nothing.
   */
  landTimeline(access: Access, ref: string): TrackerEvent[] {
    return this.transaction(() => {
      const timeline = this.timeline(ref);
      if (!timeline) fail("invalid_input", "Main doesn't land.");
      const now = new Date(this.clock()).toISOString();
      const events: TrackerEvent[] = [];
      const overlay = overlayOf(this.sql, timeline, true);
      // Done in what lands is done (CORE-74), even where the view didn't change
      // it; and what lands done is no longer waiting on another timeline.
      // A lease retained by what lands is released as done (CORE-75).
      const released = new Set<string>();
      const landed = (issue: Issue): Issue => {
        if (overlay.includes(issue.claim?.retainedIn ?? null)) {
          released.add(issue.id);
          issue = { ...issue, claim: null, handoff: null };
        }
        if (overlay.includes(issue.doneIn))
          return {
            ...issue,
            status: issue.status === "done_in_timeline" ? "done" : issue.status,
            doneIn: null,
          };
        return issue.status === "done" && issue.doneIn ? { ...issue, doneIn: null } : issue;
      };
      const changes: [ScopedType, string, Entity | null][] = overlay.entries();
      for (const row of all(
        this.sql,
        tracker
          .selectFrom("issues")
          .select(["id", "data"])
          .where(json("data", "$.doneIn.id"), "in", [...overlay.timelines, ""]),
      ))
        if (!overlay.has("issue", row.id))
          changes.push(["issue", row.id, JSON.parse(row.data) as Issue]);
      for (const [type, entityId, viewed] of changes) {
        let entity = type === "issue" && viewed ? landed(viewed as Issue) : viewed;
        const prior = first(
          this.sql,
          tracker.selectFrom(tables[type]).select("data").where("id", "=", entityId),
        );
        const before = prior ? (JSON.parse(prior.data) as Entity) : null;
        if (JSON.stringify(before) === JSON.stringify(entity)) continue;
        // An issue main already had changes under readers holding its version.
        if (type === "issue" && before && entity)
          entity = { ...entity, version: (before as Issue).version + 1, updatedAt: now } as Issue;
        if (entity)
          run(
            this.sql,
            tracker
              .insertInto(tables[type])
              .values({ id: entityId, data: JSON.stringify(entity) })
              .onConflict((oc) =>
                oc.column("id").doUpdateSet((eb) => ({ data: eb.ref("excluded.data") })),
              ),
          );
        else run(this.sql, tracker.deleteFrom(tables[type]).where("id", "=", entityId));
        events.push(
          this.record({
            operationId: `land:${timeline.id}`,
            actorId: access.actorId,
            actor: auditActor(access),
            source: access.source ?? "unknown",
            mutationKind: "timeline.land",
            before,
            kind: "timeline.land",
            entityType: type,
            entityId,
            entity,
            createdAt: now,
          }),
        );
      }
      for (const issueId of released) {
        run(this.sql, tracker.deleteFrom("leases").where("issue_id", "=", issueId));
        run(this.sql, tracker.deleteFrom("offers").where("issue_id", "=", issueId));
      }
      return events;
    });
  }
  /** Main's issues done in a timeline (CORE-74). */
  private doneIn(timelineId: string): Issue[] {
    return all(
      this.sql,
      tracker
        .selectFrom("issues")
        .select("data")
        .where(json("data", "$.doneIn.id"), "=", timelineId)
        .orderBy("id"),
    ).map((row) => JSON.parse(row.data) as Issue);
  }
  /** Store a change the tracker makes to main's view on its own, and log it. */
  private write(
    meta: {
      operationId: string;
      kind: string;
      actorId: string;
      actor: AuditActor;
      source: AuditSource;
    },
    type: "issue" | "comment",
    entity: Issue | Comment,
  ): TrackerEvent {
    const prior = first(
      this.sql,
      tracker.selectFrom(tables[type]).select("data").where("id", "=", entity.id),
    );
    run(
      this.sql,
      tracker
        .insertInto(tables[type])
        .values({ id: entity.id, data: JSON.stringify(entity) })
        .onConflict((oc) =>
          oc.column("id").doUpdateSet((eb) => ({ data: eb.ref("excluded.data") })),
        ),
    );
    return this.record({
      ...meta,
      mutationKind: meta.kind,
      before: prior ? (JSON.parse(prior.data) as Entity) : null,
      entityType: type,
      entityId: entity.id,
      entity,
      createdAt: new Date(this.clock()).toISOString(),
    });
  }
  /**
   * After timeline `fromId` merged into `intoId` (CORE-74): what was done in
   * the one is done in the other, whose view now has that work. An ended
   * timeline takes nothing.
   */
  timelineMerged(fromId: string, intoId: string, mergeId: string, actorId: string | null) {
    return this.transaction(() => {
      const into = findTimeline(this.sql, intoId);
      if (!into || into.status === "landed" || into.status === "abandoned") return [];
      const now = new Date(this.clock()).toISOString();
      const meta = {
        operationId: mergeId,
        kind: "timeline.merge",
        actorId: actorId ?? "",
        actor: { id: actorId ?? "", kind: "unknown", name: null, accountable: null } as AuditActor,
        source: "unknown" as const,
      };
      const doneIn = { id: into.id, slug: into.slug };
      return this.doneIn(fromId).map((issue) =>
        this.write(meta, "issue", {
          ...issue,
          doneIn,
          // Its retained lease moves with the work (CORE-75).
          ...(issue.claim?.retainedIn?.id === fromId
            ? { claim: { ...issue.claim, retainedIn: doneIn } }
            : {}),
          version: issue.version + 1,
          updatedAt: now,
        }),
      );
    });
  }
  /**
   * After a timeline is abandoned (CORE-74): its finished issues are ready on
   * main again, their leases released, with a note linking the timeline.
   * Work a timeline merged into it still has stays done in that one.
   * Running it again changes nothing.
   */
  timelineAbandoned(access: Access, timeline: Timeline): TrackerEvent[] {
    return this.transaction(() => {
      const issues = this.doneIn(timeline.id);
      if (!issues.length) return [];
      const now = new Date(this.clock()).toISOString();
      const meta = {
        operationId: `abandon:${timeline.id}`,
        kind: "timeline.abandon",
        actorId: access.actorId,
        actor: auditActor(access),
        source: access.source ?? "unknown",
      };
      // The live timelines that merged into it, nearest first, and their views when needed.
      const merged = mergedInto(this.sql, timeline.id)
        .map((id) => findTimeline(this.sql, id))
        .filter((t): t is Timeline => !!t && t.status !== "landed" && t.status !== "abandoned");
      const views = new Map<string, Overlay>();
      const view = (t: Timeline) => {
        if (!views.has(t.id)) views.set(t.id, overlayOf(this.sql, t));
        return views.get(t.id)!;
      };
      const url = `/tracker/${encodeURIComponent(access.owner.slug)}/timelines?tl=${encodeURIComponent(timeline.slug)}`;
      const events: TrackerEvent[] = [];
      for (const issue of issues) {
        const keeper = merged.find(
          (t) => (view(t).get("issue", issue.id) as Issue | null | undefined)?.status === "done",
        );
        const next: Issue = { ...issue, version: issue.version + 1, updatedAt: now };
        if (keeper) {
          next.doneIn = { id: keeper.id, slug: keeper.slug };
          // The timeline that merged the work keeps holding its lease (CORE-75).
          if (next.claim?.retainedIn) next.claim = { ...next.claim, retainedIn: next.doneIn };
        } else {
          next.status = "todo";
          next.doneIn = null;
          next.claim = null;
          next.handoff = null;
          run(this.sql, tracker.deleteFrom("leases").where("issue_id", "=", issue.id));
          run(this.sql, tracker.deleteFrom("offers").where("issue_id", "=", issue.id));
        }
        events.push(this.write(meta, "issue", next));
        const note: Comment = {
          id: crypto.randomUUID(),
          issueId: issue.id,
          body: keeper
            ? `Timeline [\`${timeline.slug}\`](${url}) was abandoned; this is still done in \`${keeper.slug}\`, which merged it.`
            : `Timeline [\`${timeline.slug}\`](${url}), where this was done, was abandoned, so it's ready again.`,
          kind: "comment",
          actorId: access.actorId,
          createdAt: now,
        };
        events.push(this.write(meta, "comment", note));
      }
      return events;
    });
  }
  /**
   * Each timeline's issues (CORE-74), or one timeline's: those it changed or
   * made, and those done in it, with main's status (an issue only timelines
   * have shows its newest). An abandoned timeline's show the status they had
   * in it, done ones included, though main has them back to do.
   */
  timelineIssues(only?: string): Record<string, TimelineIssue[]> {
    const abandoned = new Set(
      all(this.sql, tracker.selectFrom("timelines").select("data"))
        .map((row) => JSON.parse(row.data) as Timeline)
        .filter((timeline) => timeline.status === "abandoned")
        .map((timeline) => timeline.id),
    );
    /** By timeline, then issue: the status it had there (abandoned timelines only). */
    const pairs = new Map<string, Map<string, string | null>>();
    const add = (timelineId: string, issueId: string, status: string | null) => {
      const issues = pairs.get(timelineId) ?? new Map<string, string | null>();
      pairs.set(timelineId, issues);
      if (status !== null || !issues.has(issueId)) issues.set(issueId, status);
    };
    // What it changed, oldest first: its own last word on each issue wins.
    let worked = tracker
      .selectFrom("events")
      .select([
        json<string>("data", "$.timelineId").as("timelineId"),
        json<string>("data", "$.entityId").as("issueId"),
        json<string | null>("data", "$.view.entity.status").as("status"),
      ])
      .where(json("data", "$.entityType"), "=", "issue")
      .orderBy("cursor");
    worked = only
      ? worked.where(json("data", "$.timelineId"), "=", only)
      : worked.where(json("data", "$.timelineId"), "is not", null);
    for (const row of all(this.sql, worked)) add(row.timelineId, row.issueId, row.status);
    // What is done in it now.
    let done = tracker
      .selectFrom("issues")
      .select([json<string>("data", "$.doneIn.id").as("timelineId"), "id as issueId"]);
    done = only
      ? done.where(json("data", "$.doneIn.id"), "=", only)
      : done.where(json("data", "$.doneIn.id"), "is not", null);
    for (const row of all(this.sql, done)) add(row.timelineId, row.issueId, null);
    // What was done in it when it was abandoned, merged-in work included.
    let returned = tracker
      .selectFrom("events")
      .select([
        json<string>("data", "$.before.doneIn.id").as("timelineId"),
        json<string>("data", "$.entityId").as("issueId"),
      ])
      .where(json("data", "$.kind"), "=", "timeline.abandon")
      .where(json("data", "$.entityType"), "=", "issue");
    returned = only
      ? returned.where(json("data", "$.before.doneIn.id"), "=", only)
      : returned.where(json("data", "$.before.doneIn.id"), "is not", null);
    for (const row of all(this.sql, returned)) add(row.timelineId, row.issueId, "done");
    const out: Record<string, TimelineIssue[]> = {};
    for (const [timelineId, issues] of pairs) {
      out[timelineId] = [...issues]
        .map(([issueId, status]) => {
          const { id, key, title, ...issue } = this.anyIssue(issueId);
          return abandoned.has(timelineId) && status
            ? { id, key, title, status: status as Issue["status"], doneIn: null }
            : { id, key, title, status: issue.status, doneIn: issue.doneIn ?? null };
        })
        .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    }
    return out;
  }
  private apply(
    access: Access,
    request: MutationRequest,
    encoded: string,
    timeline: Timeline | null,
  ): MutationResult {
    const receipt = first(
      this.sql,
      tracker
        .selectFrom("receipts")
        .select(["actor_id", "request", "result"])
        .where("id", "=", request.operationId),
    );
    if (receipt) {
      if (receipt.actor_id !== access.actorId || receipt.request !== encoded)
        fail(
          "operation_conflict",
          "operationId was already used with a different actor or payload.",
          409,
        );
      return JSON.parse(receipt.result) as MutationResult;
    }
    const now = new Date(this.clock()).toISOString();
    const events: TrackerEvent[] = [];
    const results: MutationResult["results"] = [];
    const started = new Set<string>();
    const actor = auditActor(access);
    let mutationKind = "";
    /**
     * Store a change and log it. In a timeline, an issue, link or comment
     * changes in the timeline's view; main's copy takes only shared fields.
     */
    const emit = (type: EntityType, entityId: string, changed: Entity | null, kind: string) => {
      const prior = first(
        this.sql,
        tracker.selectFrom(tables[type]).select("data").where("id", "=", entityId),
      );
      const before = prior ? (JSON.parse(prior.data) as Entity) : null;
      const overlay = this.overlay && isScoped(type) ? this.overlay : null;
      let view: TrackerEvent["view"];
      let entity = changed;
      // Whatever the mutation, a status done in another timeline stays as it is.
      if (type === "issue") {
        const shown = (overlay?.has(type, entityId) ? overlay.get(type, entityId) : before) as
          | Issue
          | null
          | undefined;
        if (
          shown?.status === "done_in_timeline" &&
          (changed as Issue | null)?.status !== shown.status
        )
          lockedStatus(shown);
      }
      if (overlay && isScoped(type)) {
        const seen = overlay.has(type, entityId) ? overlay.get(type, entityId)! : before;
        const finish = type === "issue" ? finishing(overlay, seen as Issue | null, changed) : null;
        view = { before: seen, entity: changed };
        entity = mainAfter(type, before, changed);
        if (finish && entity) finish(entity as Issue);
        overlay.set(type, entityId, changed);
      }
      if (entity)
        run(
          this.sql,
          tracker
            .insertInto(tables[type])
            .values({ id: entityId, data: JSON.stringify(entity) })
            .onConflict((oc) =>
              oc.column("id").doUpdateSet((eb) => ({ data: eb.ref("excluded.data") })),
            ),
        );
      else run(this.sql, tracker.deleteFrom(tables[type]).where("id", "=", entityId));
      events.push(
        this.record({
          operationId: request.operationId,
          actorId: access.actorId,
          actor,
          source: access.source ?? "unknown",
          mutationKind,
          before,
          kind,
          entityType: type,
          entityId,
          entity,
          createdAt: now,
          ...(timeline ? { timelineId: timeline.id } : {}),
          ...(view ? { view } : {}),
        }),
      );
    };
    /**
     * An issue changing in a timeline's view (CORE-74). Finished there, it is
     * done in that timeline: main's status says so until the timeline lands.
     * Reopened in the timeline it was done in, it is main's to do again.
     * Returns the change to main's copy, if any.
     */
    const finishing = (overlay: Overlay, seen: Issue | null, changed: Entity | null) => {
      const issue = changed as Issue | null;
      if (!issue) return null;
      if (issue.status === "done" && seen?.status !== "done") {
        const { id, slug } = overlay.timeline;
        issue.doneIn = { id, slug };
        return (main: Issue) => {
          if (main.status !== "done" && main.status !== "canceled")
            main.status = "done_in_timeline";
        };
      }
      if (issue.status !== "done" && seen?.status === "done" && overlay.includes(issue.doneIn)) {
        issue.doneIn = null;
        return (main: Issue) => {
          if (main.status === "done_in_timeline") main.status = "todo";
        };
      }
      return null;
    };
    const admin = () => {
      if (!access.canAdmin)
        fail("forbidden", "Tracker administration requires account ownership.", 403);
    };
    const member = (memberId: string) => {
      if (!access.members.some((m) => m.id === memberId))
        fail("invalid_member", "User is not a current account member.");
    };
    /** A member, or an agent accountable to one: the human who answers for it. */
    const answerable = (actorId: string) => {
      const agent = access.agents.find((a) => a.id === actorId);
      member(agent ? agent.accountable.id : actorId);
      return agent ? agent.accountable.id : actorId;
    };
    const validateAssignee = (assigneeId: string | null, teamId: string) => {
      if (!assigneeId) return;
      // Administration permits writes, not assignment outside team membership.
      // An agent is eligible when its accountable human is.
      const human = answerable(assigneeId);
      const team = this.get<Team>("team", teamId);
      if (team.memberIds.length && !team.memberIds.includes(human))
        fail("invalid_member", "Assignee must belong to the owning team.");
    };
    const unique = (type: EntityType, entityId: string) => {
      if (
        all(this.sql, tracker.selectFrom(tables[type]).select("id").where("id", "=", entityId))
          .length ||
        // Ids are unique across views: something only a timeline has still holds its id.
        (isScoped(type) &&
          first(
            this.sql,
            tracker
              .selectFrom("events")
              .select("cursor")
              .where(json("data", "$.entityId"), "=", entityId)
              .where(json("data", "$.entityType"), "=", type)
              .where(json("data", "$.timelineId"), "is not", null)
              .limit(1),
          )) ||
        // An issue retention removed keeps its id (and key) forever.
        (type === "issue" && tombstone(this.sql, "issue", entityId)?.id === entityId)
      )
        fail("already_exists", `${type} ID already exists.`, 409);
    };
    const version = (entity: Team | Workspace | Issue, expected: unknown) => {
      if (!Number.isSafeInteger(expected) || Number(expected) < 1)
        fail("invalid_input", "expectedVersion is required and must be a positive integer.");
      if (entity.version !== expected)
        throw new TrackerError(409, "version_conflict", "Entity changed since it was read.", {
          currentVersion: entity.version,
          current: entity,
        });
    };
    const teamWritable = (team: Team) => {
      if (team.archived) fail("archived", "Team is archived.", 409);
      if (!access.canAdmin && team.memberIds.length && !team.memberIds.includes(access.principalId))
        fail("forbidden", "Only team members may change this team's work.", 403);
    };
    const unblocked = (issue: Issue) => {
      const blockers = this.overlay
        ? this.all<Link>("link").filter((l) => l.toId === issue.id && l.kind === "blocks")
        : all(
            this.sql,
            tracker
              .selectFrom("links")
              .select("data")
              .where(json("data", "$.toId"), "=", issue.id)
              .where(json("data", "$.kind"), "=", raw.lit("blocks")),
          ).map((row) => JSON.parse(row.data) as Link);
      const blocked = blockers.some(
        (link) => this.get<Issue>("issue", link.fromId).status !== "done",
      );
      if (blocked) fail("blocked", "Resolve all blockers before starting or completing work.", 409);
    };
    /** Constant-time comparison for secrets. */
    const same = (a: string, b: string) => {
      const x = new TextEncoder().encode(a);
      const y = new TextEncoder().encode(b);
      return x.length === y.length && timingSafeEqual(x, y);
    };
    /** A lease that ends or changes its token takes any pending handoff with it. */
    const dropOffer = (issue: Issue) => {
      run(this.sql, tracker.deleteFrom("offers").where("issue_id", "=", issue.id));
      if (issue.handoff) issue.handoff = null;
    };
    /** Whether the caller holds `issue`'s active lease with `token`. */
    const holds = (issue: Issue, token: string) => {
      if (!issue.claim || !hasActiveClaim(issue, now) || issue.claim.actorId !== access.actorId)
        return false;
      const row = first(
        this.sql,
        tracker.selectFrom("leases").select("token").where("issue_id", "=", issue.id),
      );
      const a = new TextEncoder().encode(token);
      const b = new TextEncoder().encode(row?.token ?? "");
      return a.length === b.length && timingSafeEqual(a, b);
    };
    /** The active leases above an issue, nearest first. */
    const leasedAbove = (issue: Issue) => {
      const index = graph();
      const out: Issue[] = [];
      for (
        let above = leasedAncestor(issue, index, now);
        above;
        above = leasedAncestor(above, index, now)
      )
        out.push(above);
      return out;
    };
    /** Who a claim is for: the caller, or one of the caller's own agents. */
    const holderFor = (forActorId: unknown) => {
      if (forActorId === undefined || forActorId === access.actorId)
        return { actorId: access.actorId, accountableId: access.principalId };
      const agent = access.agents.find((a) => a.id === id(forActorId));
      if (!agent || agent.accountable.id !== access.principalId)
        fail("forbidden", "Claims can only be delegated to yourself or your own agents.", 403);
      return { actorId: agent.id, accountableId: agent.accountable.id };
    };
    /** Pickup is authority, not a capability or assignment override. */
    const pickupAllowed = (
      issue: Issue,
      holder = { actorId: access.actorId, accountableId: access.principalId },
    ) => {
      const pickup = issuePickup(issue);
      if (pickup === "not_ready")
        fail(
          "pickup_not_ready",
          `${issue.key} is not ready. A person must change its pickup policy before work can start.`,
          409,
        );
      if (
        pickup === "human_only" &&
        (holder.actorId !== holder.accountableId || access.actorId !== access.principalId)
      )
        fail(
          "pickup_human_only",
          `${issue.key} is human only. A person must do this work or change its pickup policy.`,
          409,
        );
    };
    /**
     * What `holder` misses of `issue`'s requirements (CORE-32): nothing for a
     * person (people can always claim), nor for the agent it's assigned to (an
     * explicit assignment stands, and shows the mismatch). An agent that never
     * reported capabilities meets no requirement.
     */
    const unmetFor = (issue: Issue, holder: { actorId: string; accountableId: string }) => {
      if (holder.actorId === holder.accountableId || !hasRequirements(issue.requires)) return [];
      if (issue.assigneeId === holder.actorId) return [];
      const agent = access.agents.find((a) => a.id === holder.actorId);
      return unmetRequirements(issue.requires, agent?.capabilities ?? null);
    };
    const agentName = (actorId: string) =>
      access.agents.find((a) => a.id === actorId)?.name ?? actorId;
    /** Refuse an agent that doesn't meet `issue`'s requirements, saying which. */
    const eligible = (issue: Issue, holder: { actorId: string; accountableId: string }) => {
      pickupAllowed(issue, holder);
      const unmet = unmetFor(issue, holder);
      if (unmet.length)
        throw new TrackerError(
          409,
          "requirements_unmet",
          unmetText(agentName(holder.actorId), issue.key, unmet),
          { unmet },
        );
    };
    /**
     * Assigning work to an agent that doesn't meet its requirements is a
     * person's explicit call: a tracker owner's, or the agent's accountable
     * person's. The issue then shows the mismatch.
     */
    const assignedAnyway = (issue: Issue) => {
      const agent = access.agents.find((a) => a.id === issue.assigneeId);
      if (!agent) return;
      const unmet = unmetRequirements(issue.requires, agent.capabilities);
      if (!unmet.length) return;
      const person = access.actorId === access.principalId;
      if (person && (access.canAdmin || agent.accountable.id === access.principalId)) return;
      throw new TrackerError(
        409,
        "requirements_unmet",
        `${unmetText(agent.name, issue.key, unmet)} ${
          person
            ? `Only a tracker owner or ${agent.accountable.displayName} can assign it anyway.`
            : "An agent can't assign it to an agent that doesn't meet them; a person can."
        }`,
        { unmet },
      );
    };
    /** What `issue.next` says about ready work it passed over for requirements. */
    const skippedFor = (actorId: string, skipped: Issue[]) => {
      const name = agentName(actorId);
      const keys = skipped.slice(0, 10).map((issue) => issue.key);
      const more = skipped.length > keys.length ? ` and ${skipped.length - keys.length} more` : "";
      const reported = access.agents.find((a) => a.id === actorId)?.capabilities;
      return {
        requirements: skipped.length,
        keys,
        message:
          `Skipped ${skipped.length} ready issue${skipped.length === 1 ? "" : "s"} whose requirements ${name} doesn't meet: ${keys.join(", ")}${more}. ` +
          (reported
            ? "See what each needs with `gm issue show <key>`; `gm agent setup` (with --tag, --model…) updates what it reports."
            : `${name} hasn't reported its capabilities: run \`gm agent setup\` in its checkout to publish them.`),
      };
    };
    /** `issue`'s lease must match `token`; `covered` is the descendant being changed, if any. */
    const lease = (issue: Issue, token: unknown, covered?: Issue) => {
      if (covered && covered.id !== issue.id && typeof token !== "string")
        fail(
          "subtree_leased",
          `${issue.key} is leased by ${issue.claim!.agent}, and its lease covers ${covered.key}; changing its status or parent needs that lease's token.`,
          409,
        );
      const supplied = text(token, "leaseToken", 200);
      const row = first(
        this.sql,
        tracker.selectFrom("leases").select("token").where("issue_id", "=", issue.id),
      );
      const a = new TextEncoder().encode(supplied);
      const b = new TextEncoder().encode(row?.token ?? "");
      if (
        !issue.claim ||
        !hasActiveClaim(issue, now) ||
        issue.claim.actorId !== access.actorId ||
        a.length !== b.length ||
        !timingSafeEqual(a, b)
      )
        fail("lease_lost", "Claim expired, was superseded, or belongs to another agent.", 409);
    };
    // The graph as this transaction sees it so far.
    const graph = () => readinessIndex(this.all<Issue>("issue"), this.all<Link>("link"));
    /**
     * A lease on an issue covers its subtree: its holder speaks for every
     * descendant. A retained lease (CORE-75) holds finished work against
     * claims, not against a reopen in its timeline, which ends it.
     */
    const coveringLease = (issue: Issue) =>
      hasActiveClaim(issue, now) && !isRetained(issue)
        ? issue
        : leasedAncestor(issue, graph(), now);
    // A parent with open sub-issues is never offered as work, but claiming it
    // explicitly is how an orchestrating agent takes its whole subtree.
    const claimable = (issue: Issue, underToken?: unknown) => {
      const above = leasedAncestor(issue, graph(), now);
      if (above && underToken !== undefined) {
        if (!holds(above, text(underToken, "underToken", 200)))
          fail(
            "lease_lost",
            `That token doesn't hold ${above.key}'s lease, which covers ${issue.key}.`,
            409,
          );
        return above;
      }
      if (above)
        fail(
          "subtree_leased",
          `${above.key} is leased by ${above.claim!.agent}, and its lease covers ${issue.key}.`,
          409,
        );
      return null;
    };
    /** Hold `issue` for the caller: a fresh token, or the same one when renewing. */
    const grant = (
      issue: Issue,
      agent: string,
      ttl: number,
      token?: string,
      holder: { actorId: string; accountableId: string } = {
        actorId: access.actorId,
        accountableId: access.principalId,
      },
      delegatedFrom?: Issue | null,
    ) => {
      pickupAllowed(issue, holder);
      const assigneeId = issue.assigneeId ?? holder.actorId;
      validateAssignee(assigneeId, issue.teamId);
      const leaseToken = token ?? crypto.randomUUID() + crypto.randomUUID();
      const expiresAt = new Date(Date.parse(now) + ttl * 1000).toISOString();
      // Renewing or handing off a retained lease (CORE-75) keeps it retained,
      // and the finished issue's status as it is: that status is locked.
      const retainedIn = issue.claim?.retainedIn;
      issue.claim = {
        ...holder,
        agent,
        expiresAt,
        ...(delegatedFrom ? { delegatedFrom: delegatedFrom.id } : {}),
        ...(retainedIn ? { retainedIn } : {}),
      };
      issue.assigneeId = assigneeId;
      if (!retainedIn) issue.status = "in_progress";
      run(
        this.sql,
        tracker
          .insertInto("leases")
          .values({ issue_id: issue.id, token: leaseToken })
          .onConflict((oc) =>
            oc.column("issue_id").doUpdateSet((eb) => ({ token: eb.ref("excluded.token") })),
          ),
      );
      return { leaseToken, expiresAt };
    };
    /**
     * The next issue to take in a scope: ready, not a PRD, unassigned or assigned to
     * the caller; first by priority, then by how much open work it unblocks
     * (critical path first), then by age.
     */
    const pick = (
      scope: {
        teamId?: string;
        workspaceId?: string;
        underId?: string;
        /** The caller holds underId's lease: its own subtree is open to it. */
        own?: Issue;
      },
      holder: { actorId: string; accountableId: string },
    ) => {
      const index = graph();
      const takeable = (issue: Issue) => {
        const why = readiness(
          issue,
          index,
          now,
          holder.actorId === holder.accountableId && access.actorId === access.principalId
            ? "person"
            : "agent",
        );
        return (
          why === "ready" ||
          (why === "leased_above" && leasedAncestor(issue, index, now)?.id === scope.own?.id)
        );
      };
      const writable = (issue: Issue) => {
        const team = this.get<Team>("team", issue.teamId);
        return (
          !team.archived &&
          (access.canAdmin || !team.memberIds.length || team.memberIds.includes(access.principalId))
        );
      };
      const under = (issue: Issue) => {
        const seen = new Set<string>();
        for (
          let id = issue.parentId;
          id && !seen.has(id);
          id = index.byId.get(id)?.parentId ?? null
        ) {
          if (id === scope.underId) return true;
          seen.add(id);
        }
        return false;
      };
      const dependents = new Map<string, string[]>();
      for (const link of this.all<Link>("link"))
        if (link.kind === "blocks")
          dependents.set(link.fromId, [...(dependents.get(link.fromId) ?? []), link.toId]);
      const unblocks = (issue: Issue) => {
        const reached = new Set<string>();
        const queue = [issue.id];
        while (queue.length)
          for (const next of dependents.get(queue.pop()!) ?? [])
            if (!reached.has(next) && index.byId.get(next) && isOpen(index.byId.get(next)!)) {
              reached.add(next);
              queue.push(next);
            }
        return reached.size;
      };
      const ready = [...index.byId.values()].filter(
        (issue) =>
          takeable(issue) &&
          issue.type !== "prd" &&
          (issue.assigneeId === null || issue.assigneeId === access.actorId) &&
          (!scope.teamId || issue.teamId === scope.teamId) &&
          (!scope.workspaceId || issue.workspaceIds.includes(scope.workspaceId)) &&
          (!scope.underId || under(issue)) &&
          writable(issue),
      );
      // Ready work the agent doesn't meet the requirements of is passed over, and counted.
      const candidates = ready.filter((issue) => !unmetFor(issue, holder).length);
      const weight = new Map(ready.map((issue) => [issue.id, unblocks(issue)]));
      const order = (a: Issue, b: Issue) =>
        a.priority - b.priority ||
        weight.get(b.id)! - weight.get(a.id)! ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id);
      return {
        issue: candidates.sort(order)[0] ?? null,
        skipped: ready.filter((issue) => !candidates.includes(issue)).sort(order),
      };
    };
    /**
     * Recount an issue's open requests. When none are left, a parked lease unparks
     * with a window for its holder to resume; after that anyone may claim it.
     */
    const settle = (issue: Issue) => {
      const open = this.all<HumanRequest>("request").filter(
        (r) => r.issueId === issue.id && r.status === "open",
      ).length;
      issue.waiting = open;
      if (!open && issue.claim?.parkedAt) {
        delete issue.claim.parkedAt;
        issue.claim.expiresAt = new Date(
          Date.parse(now) + RESUME_WINDOW_SECONDS * 1000,
        ).toISOString();
      }
      issue.version++;
      issue.updatedAt = now;
      emit("issue", issue.id, issue, "issue.update");
    };
    /**
     * A claim released without completion. At the team's limit, the issue asks the
     * claim's accountable person what the next attempt should do differently, and
     * waits (out of ready) until someone answers.
     */
    const failedAttempt = (issue: Issue, released: IssueClaim) => {
      issue.attempts = (issue.attempts ?? 0) + 1;
      const limit = this.get<Team>("team", issue.teamId).attemptLimit ?? DEFAULT_ATTEMPT_LIMIT;
      const requests = this.all<HumanRequest>("request");
      if (
        !limit ||
        issue.attempts < limit ||
        requests.some((r) => r.issueId === issue.id && r.status === "open" && r.escalation)
      )
        return;
      const checkpoints = this.all<Comment>("comment")
        .filter((c) => c.issueId === issue.id && c.kind === "checkpoint")
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 3);
      const quoted = checkpoints.map((c) => `> ${c.body.split("\n").join("\n> ")}`).join("\n\n");
      const human = released.accountableId ?? access.principalId;
      const requestId = crypto.randomUUID();
      emit(
        "request",
        requestId,
        {
          id: requestId,
          issueId: issue.id,
          kind: "question",
          prompt:
            `Agents have released ${issue.key} ${issue.attempts} times without finishing it. ` +
            `What should the next attempt do differently?` +
            (quoted ? `\n\nLatest checkpoints:\n\n${quoted}` : ""),
          choices: [],
          secret: null,
          status: "open",
          askedBy: access.actorId,
          routeTo: access.members.some((m) => m.id === human) ? human : access.principalId,
          answer: null,
          answeredBy: null,
          answeredAt: null,
          createdAt: now,
          escalation: true,
        },
        "request.open",
      );
      issue.waiting =
        requests.filter((r) => r.issueId === issue.id && r.status === "open").length + 1;
    };
    const childrenClosed = (issue: Issue) => {
      const open = (graph().children.get(issue.id) ?? []).filter(isOpen);
      if (open.length)
        fail(
          "children_open",
          `Close its sub-issues first: ${open.map((child) => child.key).join(", ")}.`,
          409,
        );
    };
    const fields = (data: Record<string, unknown>, issue: Issue, creating: boolean) => {
      const assignedBefore = issue.assigneeId;
      if ("pickup" in data) {
        const pickup = choice(data.pickup, pickups, "pickup");
        const previous = issuePickup(issue);
        if (
          !creating &&
          pickup !== previous &&
          previous !== "anyone" &&
          access.actorId !== access.principalId
        )
          fail("forbidden", "Only a person can change an existing restricted pickup policy.", 403);
        if (pickup !== previous && pickup !== "anyone") {
          const covering = hasActiveClaim(issue, now) ? issue : coveringLease(issue);
          if (
            covering &&
            (pickup === "not_ready" || covering.claim!.actorId !== covering.claim!.accountableId)
          )
            fail(
              "claim_busy",
              `Release ${covering.key}'s active claim before restricting pickup. Retained timeline claims must land or be abandoned first.`,
              409,
            );
        }
        issue.pickup = pickup;
      }
      if ("requires" in data) {
        try {
          const requires = normalizeRequirements(data.requires);
          // No requirements leaves the field off, as on issues from before it.
          if (requires) issue.requires = requires;
          else delete issue.requires;
        } catch (error) {
          if (error instanceof RequirementError) fail("invalid_input", error.message);
          throw error;
        }
      }
      for (const key of ["title", "description", "acceptance"] as const)
        if (key in data)
          issue[key] = text(data[key], key, key === "title" ? 500 : 131072, key !== "title");
      if ("type" in data)
        issue.type = choice(
          data.type,
          ["task", "bug", "prd", "chore", "research", "remediation"],
          "issue type",
        );
      // Done in a timeline is the tracker's to set; leaving it as it is is fine.
      if ("status" in data && !(data.status === "done_in_timeline" && issue.status === data.status))
        issue.status = choice(data.status, SETTABLE_STATUSES, "status");
      if ("closeReason" in data)
        issue.closeReason =
          data.closeReason === null ? null : choice(data.closeReason, closeReasons, "close reason");
      if ("priority" in data) {
        if (
          !Number.isInteger(data.priority) ||
          Number(data.priority) < 0 ||
          Number(data.priority) > 4
        )
          fail("invalid_input", "priority must be 0–4.");
        issue.priority = data.priority as Issue["priority"];
      }
      if ("assigneeId" in data)
        issue.assigneeId = data.assigneeId === null ? null : id(data.assigneeId);
      validateAssignee(issue.assigneeId, issue.teamId);
      if (issue.assigneeId && issue.assigneeId !== assignedBefore) assignedAnyway(issue);
      if ("parentId" in data) {
        issue.parentId = data.parentId === null ? null : id(data.parentId);
        if (issue.parentId) {
          this.get<Issue>("issue", issue.parentId);
          let parent: string | null = issue.parentId;
          const seen = new Set([issue.id]);
          while (parent) {
            if (seen.has(parent)) fail("parent_cycle", "Parent hierarchy must be acyclic.", 409);
            seen.add(parent);
            parent = this.get<Issue>("issue", parent).parentId;
          }
        }
      }
      if ("workspaceIds" in data) {
        const workspaceIds = strings(data.workspaceIds, "workspaceIds");
        for (const workspaceId of workspaceIds) {
          const workspace = this.get<Workspace>("workspace", workspaceId);
          if (workspace.archived && (creating || !issue.workspaceIds.includes(workspaceId)))
            fail("archived", "Cannot add work to an archived workspace.", 409);
        }
        issue.workspaceIds = workspaceIds;
      }
      if ("labels" in data) issue.labels = strings(data.labels, "labels", 50);
      if ("timelineUse" in data) {
        issue.timelineUse = choice(data.timelineUse, timelineUses, "timeline use");
        // A policy belongs to `required` only: leaving it drops the policy.
        if (issue.timelineUse !== "required" && !("timelinePolicy" in data))
          issue.timelinePolicy = null;
      }
      if ("timelinePolicy" in data) {
        issue.timelinePolicy =
          data.timelinePolicy === null
            ? null
            : choice(data.timelinePolicy, TIMELINE_POLICIES, "timeline policy");
        if (issue.timelinePolicy && issue.timelineUse !== "required")
          fail("invalid_input", "A timeline policy needs timelineUse required.");
      }
    };
    for (const mutation of request.mutations) {
      mutationKind = mutation.kind;
      const entityId = mutation.id;
      const data = object("data" in mutation ? mutation.data : {});
      const base = { id: entityId, version: 1, createdAt: now, updatedAt: now };
      let result: MutationResult["results"][number] = { id: entityId };
      switch (mutation.kind) {
        case "team.create": {
          admin();
          keys(data, ["key", "name", "description", "memberIds"]);
          unique("team", entityId);
          const key = text(data.key, "key", 6);
          if (!/^[A-Z][A-Z0-9]{1,5}$/.test(key))
            fail(
              "invalid_input",
              "Team key must be 2–6 uppercase letters/digits starting with a letter.",
            );
          if (this.all<Team>("team").some((t) => t.key === key))
            fail("already_exists", "Team key already exists.", 409);
          const memberIds =
            data.memberIds === undefined ? [] : strings(data.memberIds, "memberIds");
          memberIds.forEach(member);
          emit(
            "team",
            entityId,
            {
              ...base,
              key,
              name: text(data.name, "name"),
              description: text(
                data.description === undefined ? "" : data.description,
                "description",
                16384,
                true,
              ),
              memberIds,
              archived: false,
            },
            mutation.kind,
          );
          break;
        }
        case "workspace.create": {
          admin();
          keys(data, ["slug", "name", "description"]);
          unique("workspace", entityId);
          const slug = text(data.slug, "slug", 80);
          if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
            fail(
              "invalid_input",
              "Workspace slug must be lowercase letters/digits separated by hyphens.",
            );
          if (this.all<Workspace>("workspace").some((w) => w.slug === slug))
            fail("already_exists", "Workspace slug already exists.", 409);
          emit(
            "workspace",
            entityId,
            {
              ...base,
              slug,
              name: text(data.name, "name"),
              description: text(
                data.description === undefined ? "" : data.description,
                "description",
                16384,
                true,
              ),
              archived: false,
            },
            mutation.kind,
          );
          break;
        }
        case "team.update":
        case "workspace.update": {
          admin();
          const type = mutation.kind === "team.update" ? "team" : "workspace";
          keys(
            data,
            type === "team"
              ? ["name", "description", "memberIds", "archived", "attemptLimit"]
              : ["name", "description", "archived"],
          );
          const entity = this.get<Team | Workspace>(type, entityId);
          version(entity, mutation.expectedVersion);
          if ("name" in data) entity.name = text(data.name, "name");
          if ("description" in data)
            entity.description = text(data.description, "description", 16384, true);
          if ("archived" in data) {
            if (typeof data.archived !== "boolean")
              fail("invalid_input", "archived must be boolean.");
            entity.archived = data.archived;
          }
          if ("attemptLimit" in data && "memberIds" in entity) {
            if (
              !Number.isInteger(data.attemptLimit) ||
              Number(data.attemptLimit) < 0 ||
              Number(data.attemptLimit) > 20
            )
              fail("invalid_input", "attemptLimit must be 0 (never ask) to 20.");
            entity.attemptLimit = Number(data.attemptLimit);
          }
          if ("memberIds" in data && "memberIds" in entity) {
            const memberIds = strings(data.memberIds, "memberIds");
            memberIds.forEach(member);
            if (
              memberIds.length &&
              this.all<Issue>("issue").some(
                (i) =>
                  i.teamId === entityId &&
                  i.assigneeId &&
                  !memberIds.includes(answerable(i.assigneeId)),
              )
            )
              fail(
                "invalid_member",
                "Reassign existing issues before removing their assignees from the team.",
                409,
              );
            entity.memberIds = memberIds;
          }
          entity.version++;
          entity.updatedAt = now;
          emit(type, entityId, entity, mutation.kind);
          break;
        }
        case "issue.create":
        case "issue.update": {
          const creating = mutation.kind === "issue.create";
          keys(data, [
            "title",
            "description",
            "acceptance",
            "type",
            "status",
            "closeReason",
            "pickup",
            "timelineUse",
            "timelinePolicy",
            "priority",
            "assigneeId",
            "parentId",
            "workspaceIds",
            "labels",
            "requires",
            ...(creating ? ["teamId"] : ["leaseToken"]),
          ]);
          let issue: Issue;
          if (creating) {
            unique("issue", entityId);
            const team = this.get<Team>("team", id(data.teamId));
            teamWritable(team);
            const number = one(
              this.sql,
              tracker
                .insertInto("team_numbers")
                .values({ id: team.id, number: raw.lit(1) })
                .onConflict((oc) =>
                  oc.column("id").doUpdateSet((eb) => ({ number: eb("number", "+", raw.lit(1)) })),
                )
                .returning("number"),
            ).number;
            issue = {
              ...base,
              ...(timeline ? { timelineId: timeline.id } : {}),
              createdBy: actor,
              teamId: team.id,
              key: `${team.key}-${number}`,
              title: text(data.title, "title", 500),
              description: "",
              acceptance: "",
              type: "task",
              status: "todo",
              pickup: "anyone",
              closeReason: null,
              timelineUse: "agent_decides",
              timelinePolicy: null,
              priority: 2,
              assigneeId: null,
              parentId: null,
              workspaceIds: [],
              labels: [],
              claim: null,
            };
          } else {
            issue = this.get<Issue>("issue", entityId);
            teamWritable(this.get("team", issue.teamId));
            version(issue, mutation.expectedVersion);
            if (
              issue.status === "done_in_timeline" &&
              "status" in data &&
              data.status !== issue.status
            )
              lockedStatus(issue);
            // Text edits do not need the issue/link graph. Resolve coverage only
            // for transitions, using this transaction's current hierarchy.
            if (
              ("status" in data && data.status !== issue.status) ||
              ("parentId" in data && data.parentId !== issue.parentId)
            ) {
              const covering = coveringLease(issue);
              if (covering) lease(covering, data.leaseToken, issue);
            }
          }
          const previous = issue.status;
          fields(data, issue, creating);
          if (issue.status === "canceled") {
            if (
              (creating || previous !== "canceled" || "closeReason" in data) &&
              !issue.closeReason
            )
              fail("invalid_input", "Select a close reason when canceling an issue.");
          } else {
            if (data.closeReason != null)
              fail("invalid_input", "A close reason is only valid for a canceled issue.");
            issue.closeReason = null;
          }
          if (issue.status === "done" && previous !== "done") childrenClosed(issue);
          if (
            (creating || issue.status !== previous) &&
            ["in_progress", "done"].includes(issue.status)
          ) {
            pickupAllowed(issue);
            unblocked(issue);
            started.add(entityId);
          }
          if ("status" in data && issue.status !== previous) {
            // Finished in a timeline, its own working lease is retained (CORE-75).
            const retain =
              timeline &&
              issue.status === "done" &&
              hasActiveClaim(issue, now) &&
              !isRetained(issue);
            dropOffer(issue);
            if (retain) issue.claim = retained(issue.claim!, timeline);
            else {
              issue.claim = null;
              run(this.sql, tracker.deleteFrom("leases").where("issue_id", "=", entityId));
            }
          }
          if (!creating) {
            issue.version++;
            issue.updatedAt = now;
          }
          emit("issue", entityId, issue, mutation.kind);
          break;
        }
        case "link.add": {
          keys(data, ["fromId", "toId", "kind"]);
          unique("link", entityId);
          const fromId = id(data.fromId);
          const toId = id(data.toId);
          const kind = choice(data.kind, ["blocks", "related", "duplicates"], "link kind");
          const from = this.get<Issue>("issue", fromId);
          const to = this.get<Issue>("issue", toId);
          teamWritable(this.get("team", from.teamId));
          teamWritable(this.get("team", to.teamId));
          if (fromId === toId) fail("graph_cycle", "An issue cannot link to itself.", 409);
          const links = this.all<Link>("link");
          if (links.some((l) => l.kind === kind && l.fromId === fromId && l.toId === toId))
            fail("already_exists", "This relationship already exists.", 409);
          if (kind === "blocks") {
            const seen = new Set<string>();
            const queue = [toId];
            while (queue.length) {
              const next = queue.pop()!;
              if (next === fromId) fail("graph_cycle", "Blocker graph must be acyclic.", 409);
              if (seen.has(next)) continue;
              seen.add(next);
              for (const link of links)
                if (link.kind === "blocks" && link.fromId === next) queue.push(link.toId);
            }
            if (from.status !== "done" && to.status === "done")
              fail("blocked", "Reopen completed work before adding an unresolved blocker.", 409);
          }
          emit("link", entityId, { id: entityId, fromId, toId, kind }, mutation.kind);
          break;
        }
        case "link.remove": {
          keys(data, []);
          const link = this.get<Link>("link", entityId);
          teamWritable(this.get("team", this.get<Issue>("issue", link.fromId).teamId));
          teamWritable(this.get("team", this.get<Issue>("issue", link.toId).teamId));
          emit("link", entityId, null, mutation.kind);
          break;
        }
        case "comment.add": {
          keys(data, ["issueId", "body", "kind"]);
          unique("comment", entityId);
          const issueId = id(data.issueId);
          teamWritable(this.get("team", this.get<Issue>("issue", issueId).teamId));
          emit(
            "comment",
            entityId,
            {
              id: entityId,
              issueId,
              body: text(data.body, "body", 131072),
              kind: choice(
                data.kind === undefined ? "comment" : data.kind,
                ["comment", "checkpoint", "evidence"],
                "comment kind",
              ),
              actorId: access.actorId,
              createdAt: now,
            },
            mutation.kind,
          );
          break;
        }
        case "subscription.add": {
          admin();
          keys(data, ["workspaceId", "repoId"]);
          unique("subscription", entityId);
          const workspaceId = id(data.workspaceId);
          if (this.get<Workspace>("workspace", workspaceId).archived)
            fail("archived", "Cannot subscribe to an archived workspace.", 409);
          const repoId = id(data.repoId);
          const repo = access.repos.find((r) => r.id === repoId);
          if (!repo) fail("forbidden", "Repository administration is required.", 403);
          if (
            this.all<Subscription>("subscription").some(
              (s) => s.workspaceId === workspaceId && s.repoId === repoId,
            )
          )
            fail("already_exists", "Repository already subscribes to this workspace.", 409);
          emit(
            "subscription",
            entityId,
            { id: entityId, workspaceId, repoId, owner: repo.owner, name: repo.name },
            mutation.kind,
          );
          break;
        }
        case "subscription.remove": {
          admin();
          keys(data, []);
          const subscription = this.get<Subscription>("subscription", entityId);
          if (
            !access.repos.some((r) => r.id === subscription.repoId) &&
            !access.deletedRepoIds?.includes(subscription.repoId)
          )
            fail("forbidden", "Repository administration is required.", 403);
          emit("subscription", entityId, null, mutation.kind);
          break;
        }
        case "issue.next": {
          keys(data, [
            "agent",
            "ttlSeconds",
            "teamId",
            "workspaceId",
            "underId",
            "underToken",
            "forActorId",
          ]);
          const ttl = data.ttlSeconds === undefined ? 900 : data.ttlSeconds;
          if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 86400)
            fail("invalid_input", "ttlSeconds must be an integer from 30 to 86400.");
          const agent = text(data.agent, "agent", 200);
          const scope = {
            ...(data.teamId === undefined ? {} : { teamId: id(data.teamId) }),
            ...(data.workspaceId === undefined ? {} : { workspaceId: id(data.workspaceId) }),
            ...(data.underId === undefined ? {} : { underId: id(data.underId) }),
          };
          if (scope.teamId) this.get<Team>("team", scope.teamId);
          if (scope.workspaceId) this.get<Workspace>("workspace", scope.workspaceId);
          let own: Issue | null = null;
          if (scope.underId) {
            const under = this.get<Issue>("issue", scope.underId);
            if (data.underToken !== undefined) {
              if (!holds(under, text(data.underToken, "underToken", 200)))
                fail("lease_lost", `That token doesn't hold ${under.key}'s lease.`, 409);
              own = under;
            }
          } else if (data.underToken !== undefined)
            fail("invalid_input", "underToken needs underId: the issue whose lease it is.");
          const holder = holderFor(data.forActorId);
          const { issue, skipped } = pick({ ...scope, ...(own ? { own } : {}) }, holder);
          const passed = skipped.length ? { skipped: skippedFor(holder.actorId, skipped) } : {};
          // Nothing ready is an answer, not an error: the agent can stop or wait.
          if (!issue) {
            result = { id: entityId, ...passed };
            break;
          }
          result = {
            id: entityId,
            issueId: issue.id,
            key: issue.key,
            ...grant(issue, agent, Number(ttl), undefined, holder, own),
            ...passed,
          };
          issue.version++;
          issue.updatedAt = now;
          emit("issue", issue.id, issue, "issue.claim");
          break;
        }
        case "request.open": {
          keys(data, [
            "issueId",
            "kind",
            "prompt",
            "choices",
            "secret",
            "routeTo",
            "leaseToken",
            "checkpoint",
          ]);
          unique("request", entityId);
          const issue = this.get<Issue>("issue", id(data.issueId));
          teamWritable(this.get("team", issue.teamId));
          const kind = choice(
            data.kind,
            ["question", "approval", "decision", "credential"] as const,
            "request kind",
          );
          const choices = kind === "decision" ? strings(data.choices ?? [], "choices", 20) : [];
          if (kind === "decision" && choices.length < 2)
            fail("invalid_input", "A decision needs at least two choices.");
          if (kind !== "decision" && data.choices !== undefined)
            fail("invalid_input", "Only decisions have choices.");
          let secret: HumanRequest["secret"] = null;
          if (kind === "credential") {
            const target = object(data.secret);
            keys(target, ["repo", "name"]);
            const repo = text(target.repo, "secret.repo", 200);
            const name = text(target.name, "secret.name", 100);
            if (!/^[^/\s]+\/[^/\s]+$/.test(repo))
              fail("invalid_input", "secret.repo must be owner/name.");
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
              fail("invalid_input", "secret.name must be letters, digits and underscores.");
            secret = { repo, name };
          } else if (data.secret !== undefined)
            fail("invalid_input", "Only credential requests name a secret.");
          // An approval may pin a timeline checkpoint: it must be the timeline's head.
          if (data.checkpoint !== undefined && kind !== "approval")
            fail("invalid_input", "Only approval requests name a checkpoint.");
          const checkpoint =
            data.checkpoint === undefined
              ? undefined
              : this.timelines.approvalTarget(id(data.checkpoint));
          const routeTo = data.routeTo === undefined ? access.principalId : id(data.routeTo);
          member(routeTo);
          // Asking with the issue's own lease parks it: it holds while the agent waits.
          if (data.leaseToken !== undefined) {
            lease(issue, data.leaseToken);
            issue.claim!.parkedAt = now;
          }
          emit(
            "request",
            entityId,
            {
              id: entityId,
              issueId: issue.id,
              kind,
              prompt: text(data.prompt, "prompt", 20000),
              choices,
              secret,
              status: "open",
              askedBy: access.actorId,
              routeTo,
              answer: null,
              answeredBy: null,
              answeredAt: null,
              createdAt: now,
              ...(checkpoint ? { checkpoint } : {}),
            },
            mutation.kind,
          );
          settle(issue);
          if (checkpoint) this.timelines.settle(checkpoint.timelineId, access.actorId);
          break;
        }
        case "request.answer":
        case "request.cancel": {
          const request = this.get<HumanRequest>("request", entityId);
          const issue = this.get<Issue>("issue", request.issueId);
          teamWritable(this.get("team", issue.teamId));
          if (request.status !== "open")
            fail("not_open", `This request was already ${request.status}.`, 409);
          if (mutation.kind === "request.cancel") {
            keys(data, []);
            if (request.askedBy !== access.actorId && !access.canAdmin)
              fail("forbidden", "Only whoever asked can cancel a request.", 403);
            request.status = "canceled";
            // Superseded by new commits: say why (the timeline settles its own status).
            if (this.withdrawing !== null) request.answer = this.withdrawing;
          } else {
            keys(data, ["answer", "choice", "approved", "stored"]);
            // Requests are for people: an agent can't answer its own (or another's) question.
            if (access.actorId !== access.principalId)
              fail("forbidden", "Agents can't answer requests; a person has to.", 403);
            if (request.kind === "question") request.answer = text(data.answer, "answer", 20000);
            else if (request.kind === "decision") {
              const picked = text(data.choice, "choice", 100);
              if (!request.choices.includes(picked))
                fail("invalid_input", `Choose one of: ${request.choices.join(", ")}.`);
              request.answer = picked;
            } else if (request.kind === "approval") {
              if (typeof data.approved !== "boolean")
                fail("invalid_input", "Approve or reject: approved must be true or false.");
              const note = data.answer === undefined ? null : text(data.answer, "answer", 20000);
              request.answer = `${data.approved ? "approved" : "rejected"}${note === null ? "" : ` · ${note}`}`;
              if (request.checkpoint)
                this.timelines.answerApproval(
                  access,
                  request,
                  data.approved,
                  note,
                  access.writableRepoIds,
                );
            } else {
              // The value went to the secret store; the tracker only records where.
              if (data.stored !== true || data.answer !== undefined)
                fail(
                  "invalid_input",
                  "Store the credential as its secret, then answer with stored: true and no value.",
                );
              request.answer = `Stored as ${request.secret!.name} on ${request.secret!.repo}`;
            }
            request.status = "answered";
            request.answeredBy = access.actorId;
            request.answeredAt = now;
            // The person said what to try next: the attempts start over.
            if (request.escalation) issue.attempts = 0;
          }
          emit("request", entityId, request, mutation.kind);
          settle(issue);
          if (request.checkpoint && this.withdrawing === null)
            this.timelines.settle(request.checkpoint.timelineId, access.actorId);
          break;
        }
        case "issue.offer":
        case "issue.withdraw": {
          keys(
            data,
            mutation.kind === "issue.offer"
              ? ["leaseToken", "toActorId", "ttlSeconds"]
              : ["leaseToken"],
          );
          const issue = this.get<Issue>("issue", entityId);
          teamWritable(this.get("team", issue.teamId));
          lease(issue, data.leaseToken);
          if (mutation.kind === "issue.withdraw") dropOffer(issue);
          else {
            const ttl = data.ttlSeconds === undefined ? 600 : data.ttlSeconds;
            if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 3600)
              fail("invalid_input", "An offer lasts 30 to 3600 seconds.");
            // To a member or a member's agent; anyone with the code when unset.
            const to = data.toActorId === undefined ? null : id(data.toActorId);
            if (to) eligible(issue, { actorId: to, accountableId: answerable(to) });
            const random = () => crypto.randomUUID().replaceAll("-", "");
            const code = `${issue.key}.${random()}${random()}`;
            const expiresAt = new Date(Date.parse(now) + Number(ttl) * 1000).toISOString();
            const values = {
              issue_id: issue.id,
              code,
              lease_token: String(data.leaseToken),
              to_actor: to,
              expires_at: expiresAt,
            };
            run(
              this.sql,
              tracker
                .insertInto("offers")
                .values(values)
                .onConflict((oc) => oc.column("issue_id").doUpdateSet(values)),
            );
            issue.handoff = { to, expiresAt };
            result = { id: entityId, offerCode: code, expiresAt };
          }
          issue.version++;
          issue.updatedAt = now;
          emit("issue", entityId, issue, mutation.kind);
          break;
        }
        case "issue.accept": {
          keys(data, ["code", "agent", "ttlSeconds"]);
          const issue = this.get<Issue>("issue", entityId);
          teamWritable(this.get("team", issue.teamId));
          const ttl = data.ttlSeconds === undefined ? 900 : data.ttlSeconds;
          if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 86400)
            fail("invalid_input", "ttlSeconds must be an integer from 30 to 86400.");
          const code = text(data.code, "code", 300);
          const offer = first(
            this.sql,
            tracker.selectFrom("offers").selectAll().where("issue_id", "=", issue.id),
          );
          const current = first(
            this.sql,
            tracker.selectFrom("leases").select("token").where("issue_id", "=", issue.id),
          );
          // The offer only stands while the lease it was made under does.
          if (
            !offer ||
            !same(offer.code, code) ||
            offer.expires_at <= now ||
            !current ||
            !same(current.token, offer.lease_token) ||
            !hasActiveClaim(issue, now) ||
            (offer.to_actor !== null && offer.to_actor !== access.actorId)
          )
            fail(
              "offer_invalid",
              "That handoff code is expired, used, withdrawn, or for someone else.",
              409,
            );
          eligible(issue, { actorId: access.actorId, accountableId: access.principalId });
          const previous = issue.claim!;
          result = {
            id: entityId,
            ...grant(
              issue,
              data.agent === undefined ? previous.agent : text(data.agent, "agent", 200),
              Number(ttl),
              undefined,
              { actorId: access.actorId, accountableId: access.principalId },
              previous.delegatedFrom ? this.get<Issue>("issue", previous.delegatedFrom) : null,
            ),
          };
          dropOffer(issue);
          issue.version++;
          issue.updatedAt = now;
          emit("issue", entityId, issue, "issue.accept");
          break;
        }
        case "issue.resume": {
          keys(data, ["ttlSeconds"]);
          const issue = this.get<Issue>("issue", entityId);
          teamWritable(this.get("team", issue.teamId));
          const ttl = data.ttlSeconds === undefined ? 900 : data.ttlSeconds;
          if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 86400)
            fail("invalid_input", "ttlSeconds must be an integer from 30 to 86400.");
          if (!issue.claim || issue.claim.actorId !== access.actorId)
            fail("not_holder", `Only ${issue.key}'s lease holder can resume it.`, 409);
          if (issue.waiting) fail("waiting", `${issue.key} still has open requests.`, 409);
          const claim = issue.claim;
          dropOffer(issue);
          result = {
            id: entityId,
            ...grant(
              issue,
              claim.agent,
              Number(ttl),
              undefined,
              {
                actorId: claim.actorId,
                accountableId: claim.accountableId ?? access.principalId,
              },
              claim.delegatedFrom ? this.get<Issue>("issue", claim.delegatedFrom) : null,
            ),
          };
          issue.version++;
          issue.updatedAt = now;
          emit("issue", entityId, issue, "issue.resume");
          break;
        }
        case "issue.revoke": {
          keys(data, ["underToken"]);
          const issue = this.get<Issue>("issue", entityId);
          teamWritable(this.get("team", issue.teamId));
          if (!issue.claim || !hasActiveClaim(issue, now))
            fail("not_claimed", `${issue.key} has no active claim to revoke.`, 409);
          const token = text(data.underToken, "underToken", 200);
          // Any lease above the issue may take it back, not just the nearest.
          if (!leasedAbove(issue).some((above) => holds(above, token)))
            fail(
              "lease_lost",
              `Only the holder of a lease above ${issue.key} can revoke its claim.`,
              409,
            );
          issue.claim = null;
          issue.status = "todo";
          run(this.sql, tracker.deleteFrom("leases").where("issue_id", "=", entityId));
          dropOffer(issue);
          issue.version++;
          issue.updatedAt = now;
          emit("issue", entityId, issue, "issue.revoke");
          break;
        }
        case "issue.claim":
        case "issue.renew":
        case "issue.release":
        case "issue.complete": {
          const kind = mutation.kind;
          keys(
            data,
            kind === "issue.claim"
              ? ["agent", "ttlSeconds", "underToken", "forActorId", "force"]
              : kind === "issue.renew"
                ? ["leaseToken", "ttlSeconds"]
                : kind === "issue.complete"
                  ? ["leaseToken", "evidence"]
                  : ["leaseToken", "force"],
          );
          const issue = this.get<Issue>("issue", entityId);
          teamWritable(this.get("team", issue.teamId));
          // Claiming, completing or releasing would move a status that's locked here.
          if (issue.status === "done_in_timeline" && kind !== "issue.renew") lockedStatus(issue);
          if ((kind === "issue.release" || kind === "issue.complete") && issue.claim?.retainedIn)
            fail(
              "lease_retained",
              `${issue.key} is done in timeline ${issue.claim.retainedIn.slug}, and its lease is held until that timeline lands or is abandoned.`,
              409,
            );
          let delegator: Issue | null = null;
          if (kind === "issue.claim" || kind === "issue.renew") {
            const ttl = data.ttlSeconds === undefined ? 900 : data.ttlSeconds;
            if (!Number.isInteger(ttl) || Number(ttl) < 30 || Number(ttl) > 86400)
              fail("invalid_input", "ttlSeconds must be an integer from 30 to 86400.");
            if (kind === "issue.claim") {
              const force = data.force === true;
              if (data.force !== undefined && typeof data.force !== "boolean")
                fail("invalid_input", "force must be true or false.");
              if (force && (!access.canAdmin || access.actorId !== access.principalId))
                fail(
                  "forbidden",
                  "Only a tracker owner, acting as themselves rather than through an agent, can take over a claim.",
                  403,
                );
              const taken = force && hasActiveClaim(issue, now) ? issue.claim : null;
              if (hasActiveClaim(issue, now) && !force)
                fail("claim_busy", "Issue already has an active claim.", 409);
              if (issue.waiting)
                fail(
                  "waiting",
                  `${issue.key} is waiting on a person; answer its requests first.`,
                  409,
                );
              if (
                issue.status !== "todo" &&
                !(
                  issue.status === "in_progress" &&
                  issue.claim &&
                  (!hasActiveClaim(issue, now) || taken)
                )
              )
                fail("not_ready", "Only todo or expired claimed work may be claimed.", 409);
              if (taken) {
                // On the record: who took it from whom. The holder's token dies with the
                // new grant below; a pending handoff of the old lease goes too.
                dropOffer(issue);
                const commentId = crypto.randomUUID();
                emit(
                  "comment",
                  commentId,
                  {
                    id: commentId,
                    issueId: entityId,
                    body: `Took over the claim held by \`${taken.agent}\` (until ${taken.expiresAt}).`,
                    kind: "comment",
                    actorId: access.actorId,
                    createdAt: now,
                  },
                  "comment.add",
                );
              }
              unblocked(issue);
              delegator = claimable(issue, data.underToken);
              if (!delegator && data.forActorId !== undefined)
                fail(
                  "invalid_input",
                  "forActorId delegates inside your leased subtree; pass that lease's underToken.",
                );
              eligible(issue, holderFor(data.forActorId));
            } else lease(issue, data.leaseToken);
            result = {
              id: entityId,
              ...grant(
                issue,
                kind === "issue.claim" ? text(data.agent, "agent", 200) : issue.claim!.agent,
                Number(ttl),
                kind === "issue.claim" ? undefined : String(data.leaseToken),
                kind === "issue.claim"
                  ? holderFor(data.forActorId)
                  : {
                      actorId: issue.claim!.actorId,
                      accountableId: issue.claim!.accountableId ?? access.principalId,
                    },
                kind === "issue.claim"
                  ? delegator
                  : issue.claim?.delegatedFrom
                    ? this.get<Issue>("issue", issue.claim.delegatedFrom)
                    : null,
              ),
            };
          } else {
            const forced = kind === "issue.release" && data.force === true;
            const ended = forced ? issue.claim : null;
            if (forced) {
              if (!access.canAdmin || access.actorId !== access.principalId)
                fail(
                  "forbidden",
                  "Only a tracker owner, acting as themselves rather than through an agent, can end someone else's claim.",
                  403,
                );
              if (!ended || !hasActiveClaim(issue, now))
                fail("not_claimed", "Nobody holds a claim on it.", 409);
              const commentId = crypto.randomUUID();
              emit(
                "comment",
                commentId,
                {
                  id: commentId,
                  issueId: entityId,
                  body: `Ended the claim held by \`${ended!.agent}\` (until ${ended!.expiresAt}).`,
                  kind: "comment",
                  actorId: access.actorId,
                  createdAt: now,
                },
                "comment.add",
              );
            } else lease(issue, data.leaseToken);
            if (kind === "issue.complete") {
              pickupAllowed(issue);
              unblocked(issue);
              childrenClosed(issue);
              const body = text(data.evidence, "evidence", 131072);
              const commentId = crypto.randomUUID();
              emit(
                "comment",
                commentId,
                {
                  id: commentId,
                  issueId: entityId,
                  body,
                  kind: "evidence",
                  actorId: access.actorId,
                  createdAt: now,
                },
                "comment.add",
              );
            }
            const released = issue.claim!;
            issue.status = kind === "issue.complete" ? "done" : "todo";
            issue.closeReason = null;
            dropOffer(issue);
            // Finished in a timeline, the lease is retained until the timeline
            // lands or is abandoned (CORE-75); anywhere else it ends here.
            if (kind === "issue.complete" && timeline && released)
              issue.claim = retained(released, timeline);
            else {
              issue.claim = null;
              run(this.sql, tracker.deleteFrom("leases").where("issue_id", "=", entityId));
            }
            // Ending a claim by force isn't the holder failing.
            if (kind === "issue.release" && !forced) failedAttempt(issue, released);
          }
          issue.version++;
          issue.updatedAt = now;
          emit("issue", entityId, issue, kind);
          break;
        }
        default:
          fail("invalid_input", "Unknown mutation kind.");
      }
      results.push(result);
    }
    // Later mutations must not invalidate work started/completed earlier in the batch.
    for (const event of events) {
      if (event.kind === "issue.claim" || event.kind === "issue.complete")
        started.add(event.entityId);
    }
    for (const issueId of started) {
      const issue = this.get<Issue>("issue", issueId);
      if (issue.status === "in_progress" || issue.status === "done") unblocked(issue);
      if (issue.status === "done") childrenClosed(issue);
    }
    const result: MutationResult = { cursor: this.cursor(), events, results, serverTime: now };
    run(
      this.sql,
      tracker.insertInto("receipts").values({
        id: request.operationId,
        actor_id: access.actorId,
        request: encoded,
        result: JSON.stringify(result),
      }),
    );
    return result;
  }
}
