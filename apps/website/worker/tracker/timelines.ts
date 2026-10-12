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

import { sql } from "kysely";
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
import { RETENTION_TABLES, removedMessage, tombstone } from "./retention.ts";
import type { WorkSourceRow, WorkSourceInput } from "../timelines/sources.ts";
import type { SourceSnapshot } from "../../shared/code-source.ts";

function sameSnapshot(a: SourceSnapshot | undefined, b: SourceSnapshot | undefined): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.repoId === b.repoId &&
      a.sourceId === b.sourceId &&
      a.kind === b.kind &&
      a.timelineId === b.timelineId &&
      a.ref === b.ref &&
      a.commit === b.commit &&
      a.tree === b.tree)
  );
}

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
  id?: string;
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
  /**
   * Retrying an approval's landing (CORE-390): land only this checkpoint, and
   * only if it never had a landing in any state. Otherwise refused with
   * `landing_exists` (or `checkpoint_moved`), in the same transaction.
   */
  onlyIfUnlanded?: string;
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

export interface SourcePush {
  operationId: string;
  timelineId: string;
  repoId: string;
  sourceId: string;
  commands: { ref: string; old: string | null; new: string | null }[];
  actorId: string | null;
  accountableId: string | null;
  recovery?: SourcePushRecovery;
  projectionPending?: boolean;
  delivery?: {
    head: string;
    runs: Record<
      "push" | "step",
      {
        id: string;
        state: "pending" | "started" | "skipped";
        reason?: string;
      }
    >;
  };
}

export interface SourcePushRecovery {
  id: string;
  base: string;
  tree: string;
  commit: string;
  content: string;
  actorId: string;
  accountableId: string;
  createdAt: string;
  priorState: string;
  outcome?: "accepted" | "rejected";
  head?: string;
  projected?: boolean;
}

/** An event before it's stored: the store numbers it. */
type EventInput = TimelineEvent extends infer E
  ? E extends unknown
    ? Omit<E, "seq">
    : never
  : never;

function decodeTimeline(data: string): Timeline {
  const timeline = JSON.parse(data) as Timeline;
  if (ENDED.includes(timeline.status))
    for (const repo of timeline.repos) {
      repo.source ??= {
        sourceId: "canonical",
        repoId: repo.id,
        kind: "canonical-historical",
        timelineId: timeline.id,
        ref: `refs/heads/${repo.bookmark}`,
      };
    }
  return timeline;
}

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
    sql.exec(RETENTION_TABLES);
  }
  reserveTimeline(access: Access, slug: string, parent: string | null, input: string): string {
    return this.transaction(() => {
      const found = first(
        this.sql,
        tracker.selectFrom("timeline_reservations").selectAll().where("slug", "=", slug),
      );
      if (found) {
        this.assertCreationOpen(found.id);
        if (found.actor_id !== access.actorId || found.input !== input)
          fail("already_exists", "This timeline name is reserved for another creation.", 409);
        return found.id;
      }
      this.prepare(slug, parent);
      const id = `tl_${crypto.randomUUID()}`;
      run(
        this.sql,
        tracker
          .insertInto("timeline_reservations")
          .values({ slug, id, actor_id: access.actorId, input }),
      );
      return id;
    });
  }
  assertCreationOpen(timelineId: string): void {
    if (
      first(
        this.sql,
        tracker
          .selectFrom("timeline_creation_cancellations")
          .select("timeline_id")
          .where("timeline_id", "=", timelineId),
      )
    )
      fail("creation_cancelled", "This timeline creation was cancelled; choose a new name.", 409);
  }
  cancelReservedCreation(access: Access, slug: string): WorkSourceRow[] | null {
    return this.transaction(() => {
      if (this.find(slug)) return null;
      const reservation = first(
        this.sql,
        tracker.selectFrom("timeline_reservations").selectAll().where("slug", "=", slug),
      );
      if (!reservation) fail("not_found", "No timeline or reserved creation.", 404);
      if (reservation.actor_id !== access.actorId)
        fail("forbidden", "Only the actor who reserved this creation may cancel it.", 403);
      run(
        this.sql,
        tracker
          .insertInto("timeline_creation_cancellations")
          .values({ timeline_id: reservation.id })
          .onConflict((oc) => oc.doNothing()),
      );
      return all(
        this.sql,
        tracker
          .selectFrom("timeline_source_allocations")
          .select("data")
          .where("timeline_id", "=", reservation.id),
      ).map((row) => JSON.parse(row.data) as WorkSourceRow);
    });
  }
  reserveWorkSource(repo: { id: string; owner_id: string }, input: WorkSourceInput): WorkSourceRow {
    return this.transaction(() => {
      this.assertCreationOpen(input.timelineId);
      const found = first(
        this.sql,
        tracker
          .selectFrom("timeline_source_allocations")
          .select("data")
          .where("timeline_id", "=", input.timelineId)
          .where("repo_id", "=", repo.id),
      );
      if (found) return JSON.parse(found.data) as WorkSourceRow;
      const initial = input.initialHead ?? input.base;
      const row: WorkSourceRow = {
        source_id: `work_${crypto.randomUUID()}`,
        repo_id: repo.id,
        owner_id: repo.owner_id,
        timeline_id: input.timelineId,
        timeline_slug: input.timelineSlug,
        artifacts_name: `w-${crypto.randomUUID().replaceAll("-", "")}`,
        artifacts_remote: null,
        state: "reserved",
        version: 1,
        allocation_operation_id: `alloc_${crypto.randomUUID()}`,
        fork_source_id: input.base.sourceId,
        fork_commit: input.base.commit,
        fork_tree: input.base.tree,
        fork_ref: input.base.ref,
        work_ref: "refs/heads/work",
        initial_source_id: initial.sourceId,
        initial_commit: initial.commit,
        initial_tree: initial.tree,
        initial_ref: initial.ref,
        initial_token_revoked: 0,
        created_at: this.now(),
        updated_at: this.now(),
        archived_at: null,
        archive_disposition: null,
        error: null,
      };
      run(
        this.sql,
        tracker.insertInto("timeline_source_allocations").values({
          source_id: row.source_id,
          timeline_id: row.timeline_id,
          repo_id: row.repo_id,
          data: JSON.stringify(row),
        }),
      );
      return row;
    });
  }
  getWorkSource(sourceId: string): WorkSourceRow {
    const row = first(
      this.sql,
      tracker
        .selectFrom("timeline_source_allocations")
        .select("data")
        .where("source_id", "=", sourceId),
    );
    if (!row) fail("not_found", "No source allocation.", 404);
    const source = JSON.parse(row.data) as WorkSourceRow;
    if (source.state === "archived" && !source.archive_disposition) {
      const timeline = this.find(source.timeline_slug);
      if (
        timeline?.id === source.timeline_id &&
        timeline.endedAt &&
        (timeline.status === "landed" || timeline.status === "abandoned")
      ) {
        source.archive_disposition = timeline.status;
        source.archived_at = timeline.endedAt;
      }
    }
    return source;
  }
  /**
   * A fresh provider name for a source still being created (CORE-108). A fork
   * whose connection dropped can stay "in progress" for good, so its creator
   * forks again under a new name; the old one is then an ordinary orphan (no
   * row names it), which the orphan sweep deletes once it can.
   */
  renameWorkSource(sourceId: string, expectedVersion: number): WorkSourceRow {
    return this.transaction(() => {
      const row = this.getWorkSource(sourceId);
      this.assertCreationOpen(row.timeline_id);
      if (row.state !== "creating")
        fail("invalid_state", "Only a source being created can take a new name.", 409);
      if (row.version !== expectedVersion)
        fail("version_conflict", "Source allocation changed.", 409);
      row.artifacts_name = `w-${crypto.randomUUID().replaceAll("-", "")}`;
      row.artifacts_remote = null;
      row.version++;
      row.updated_at = this.now();
      run(
        this.sql,
        tracker
          .updateTable("timeline_source_allocations")
          .set({ data: JSON.stringify(row) })
          .where("source_id", "=", sourceId),
      );
      return row;
    });
  }
  transitionWorkSource(
    sourceId: string,
    expectedVersion: number,
    state: WorkSourceRow["state"],
    remote?: string,
  ): WorkSourceRow {
    return this.transaction(() => {
      const row = this.getWorkSource(sourceId);
      if (state === "creating" || state === "ready") this.assertCreationOpen(row.timeline_id);
      if (
        row.state === "creating" &&
        state === "purging" &&
        !first(
          this.sql,
          tracker
            .selectFrom("timeline_creation_cancellations")
            .select("timeline_id")
            .where("timeline_id", "=", row.timeline_id),
        )
      )
        fail("source_busy", "Drain initialization before purging this source.", 409);
      if (row.state === state) return row;
      if (row.version !== expectedVersion)
        fail("version_conflict", "Source allocation changed.", 409);
      const allowed: Record<WorkSourceRow["state"], WorkSourceRow["state"][]> = {
        reserved: ["creating", "purging"],
        creating: ["ready", "failed", "purging"],
        ready: ["archived", "purging"],
        archived: ["purging"],
        purging: ["purged"],
        purged: [],
        failed: ["creating", "purging"],
      };
      if (!allowed[row.state].includes(state))
        fail("invalid_state", "Invalid source lifecycle transition.", 409);
      row.state = state;
      row.version++;
      row.updated_at = this.now();
      if (remote) row.artifacts_remote = remote;
      if (state === "ready") row.initial_token_revoked = 1;
      if (state === "archived") {
        const timeline = this.find(row.timeline_slug);
        if (
          !timeline ||
          timeline.id !== row.timeline_id ||
          (timeline.status !== "landed" && timeline.status !== "abandoned") ||
          !timeline.endedAt
        )
          fail("invalid_state", "Only an ended timeline can archive its source.", 409);
        row.archived_at = timeline.endedAt;
        row.archive_disposition = timeline.status;
      }
      run(
        this.sql,
        tracker
          .updateTable("timeline_source_allocations")
          .set({ data: JSON.stringify(row) })
          .where("source_id", "=", sourceId),
      );
      return row;
    });
  }
  sourcePushes(repoId?: string): (SourcePush & { state: string })[] {
    let query = tracker
      .selectFrom("timeline_source_operations")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("state", "in", ["projecting", "admitted", "ambiguous"]),
          sql<boolean>`json_extract(data, '$.recovery.projected') = 0`,
          sql<boolean>`json_extract(data, '$.projectionPending') = 1`,
        ]),
      );
    if (repoId) query = query.where("repo_id", "=", repoId);
    return all(this.sql, query).map((row) => ({
      ...(JSON.parse(row.data) as SourcePush),
      state: row.state,
    }));
  }
  sourcePush(
    operationId: string,
    repoId?: string,
    sourceId?: string,
  ): SourcePush & { state: string } {
    const row = first(
      this.sql,
      tracker.selectFrom("timeline_source_operations").selectAll().where("id", "=", operationId),
    );
    if (!row || (repoId && row.repo_id !== repoId) || (sourceId && row.source_id !== sourceId))
      fail("not_found", "No matching source operation.", 404);
    return { ...(JSON.parse(row.data) as SourcePush), state: row.state };
  }
  activateSourcePush(operationId: string): void {
    const operation = this.sourcePush(operationId);
    if (operation.state !== "projecting")
      fail("operation_settled", "Push admission was interrupted.", 409);
    run(
      this.sql,
      tracker
        .updateTable("timeline_source_operations")
        .set({ state: "admitted" })
        .where("id", "=", operationId),
    );
  }
  private writableSourceTimeline(timeline: Timeline) {
    if (ENDED.includes(timeline.status))
      fail(
        "timeline_ended",
        "This timeline has ended; select a new timeline or main explicitly.",
        409,
      );
    if (timeline.migrationState === "frozen" || timeline.repos.some((repo) => !repo.source))
      fail("migration_required", "This timeline requires source migration.", 409);
    const landing = this.landing(timeline.slug);
    if (
      landing &&
      (LANDING_ACTIVE.includes(landing.state) ||
        landing.repos.some((repo) => repo.state === "advanced" || repo.casIntent))
    )
      fail("source_frozen", "Landing holds this timeline's source mutation fence.", 409);
  }
  beginSourcePush(input: SourcePush, projecting = false): { operationId: string } {
    return this.transaction(() => {
      const existing = first(
        this.sql,
        tracker
          .selectFrom("timeline_source_operations")
          .selectAll()
          .where("id", "=", input.operationId),
      );
      if (existing) {
        if (existing.data !== JSON.stringify(input))
          fail("operation_conflict", "Push operation identity was reused.", 409);
        if (existing.state !== (projecting ? "projecting" : "admitted"))
          fail("operation_settled", "Push operation is already settled or ambiguous.", 409);
        return { operationId: input.operationId };
      }
      const timeline = this.byId(input.timelineId);
      this.writableSourceTimeline(timeline);
      const repo = timeline.repos.find(
        (entry) => entry.id === input.repoId && entry.source?.sourceId === input.sourceId,
      );
      if (!repo) fail("not_found", "Source does not belong to this timeline.", 404);
      if (
        !input.commands.length ||
        input.commands.some(
          (command) =>
            command.ref !== repo.source!.ref ||
            !command.new ||
            !OID.test(command.new) ||
            (command.old !== null && !OID.test(command.old)),
        )
      )
        fail("invalid_ref", "Only the owned work ref may be updated; it cannot be deleted.", 409);
      if (this.sourcePushes().some((operation) => operation.timelineId === timeline.id))
        fail("source_busy", "A source mutation awaits reconciliation.", 409);
      // Never permit ABA after recovery: an outstanding original or recovery
      // CAS could become live again if a later force rewrite restored its base.
      for (const command of input.commands) {
        const fenced = first(
          this.sql,
          tracker
            .selectFrom("timeline_source_operations")
            .select("id")
            .where("repo_id", "=", input.repoId)
            .where("source_id", "=", input.sourceId)
            .where(json<string>("data", "$.recovery.base"), "=", command.new!),
        );
        if (fenced)
          fail(
            "recovery_fence",
            "This commit is a fenced recovery base; sync and preserve the recovery history.",
            409,
          );
      }
      run(
        this.sql,
        tracker.insertInto("timeline_source_operations").values({
          id: input.operationId,
          timeline_id: input.timelineId,
          repo_id: input.repoId,
          source_id: input.sourceId,
          state: projecting ? "projecting" : "admitted",
          data: JSON.stringify(input),
        }),
      );
      // Admission invalidates approval before provider I/O can become visible.
      this.supersede(
        timeline,
        "Superseded by new source work.",
        input.actorId,
        input.accountableId,
      );
      return { operationId: input.operationId };
    });
  }
  beginSourcePushRecovery(
    operationId: string,
    repoId: string,
    sourceId: string,
    intent: SourcePushRecovery,
  ): SourcePush & { state: string } {
    return this.transaction(() => {
      const operation = this.sourcePush(operationId, repoId, sourceId);
      if (operation.state === "accepted" || operation.state === "rejected") return operation;
      const timeline = this.byId(operation.timelineId);
      this.writableSourceTimeline(timeline);
      const source = this.getWorkSource(sourceId);
      if (
        source.state !== "ready" ||
        source.repo_id !== repoId ||
        source.timeline_id !== timeline.id ||
        !timeline.repos.some((repo) => repo.id === repoId && repo.source?.sourceId === sourceId)
      )
        fail("source_expired", "Recovery requires the active owned source.", 409);
      if (operation.recovery) return operation;
      if (operation.state === "projecting")
        fail("source_busy", "Admission must be reconciled before recovery.", 409);
      const [command] = operation.commands;
      if (
        operation.commands.length !== 1 ||
        !command ||
        command.ref !== source.work_ref ||
        command.old !== intent.base ||
        command.old === command.new ||
        !OID.test(intent.base) ||
        !OID.test(intent.tree) ||
        !OID.test(intent.commit)
      )
        fail("recovery_conflict", "Recovery does not match the admitted command.", 409);
      operation.recovery = { ...intent, priorState: operation.state, projected: false };
      const { state: _state, ...data } = operation;
      run(
        this.sql,
        tracker
          .updateTable("timeline_source_operations")
          .set({ data: JSON.stringify(data) })
          .where("id", "=", operationId),
      );
      timeline.updatedAt = this.now();
      timeline.version++;
      this.save(timeline, "timeline.push.recovery.started", intent.actorId);
      return operation;
    });
  }

  settleSourcePushRecovery(operationId: string, outcome: "accepted" | "rejected", head: string) {
    return this.transaction(() => {
      const operation = this.sourcePush(operationId);
      const recovery = operation.recovery;
      if (!recovery) fail("recovery_conflict", "No durable recovery intent.", 409);
      if (operation.state === "accepted" || operation.state === "rejected") {
        if (operation.state !== outcome || recovery.head !== head)
          fail("operation_settled", "Push already settled.", 409);
        return;
      }
      const [command] = operation.commands;
      if (
        operation.commands.length !== 1 ||
        !command ||
        head !== (outcome === "accepted" ? command.new : recovery.commit)
      )
        fail("recovery_conflict", "Recovery proof does not match its outcome.", 409);
      recovery.outcome = outcome;
      recovery.head = head;
      const timeline = this.byId(operation.timelineId);
      this.setHead(timeline.id, operation.repoId, head);
      timeline.pushedAt = this.now();
      timeline.updatedAt = this.now();
      timeline.version++;
      const actorId = outcome === "accepted" ? operation.actorId : recovery.actorId;
      const accountableId =
        outcome === "accepted" ? operation.accountableId : recovery.accountableId;
      if (actorId && actorId !== accountableId && !timeline.agentIds.includes(actorId))
        timeline.agentIds.push(actorId);
      this.status(timeline);
      this.save(timeline, "timeline.push.recovery", recovery.actorId);
      const { state: _state, ...data } = operation;
      run(
        this.sql,
        tracker
          .updateTable("timeline_source_operations")
          .set({ state: outcome, data: JSON.stringify(data) })
          .where("id", "=", operationId),
      );
    });
  }

  projectSourcePushRecovery(operationId: string) {
    const operation = this.sourcePush(operationId);
    if (!operation.recovery?.outcome) fail("source_busy", "Recovery is not proven.", 409);
    operation.recovery.projected = true;
    const { state: _state, ...data } = operation;
    run(
      this.sql,
      tracker
        .updateTable("timeline_source_operations")
        .set({ data: JSON.stringify(data) })
        .where("id", "=", operationId),
    );
  }

  finishSourcePush(
    operationId: string,
    outcome: "accepted" | "rejected" | "ambiguous",
    projecting = false,
  ): void {
    this.transaction(() => {
      const row = first(
        this.sql,
        tracker.selectFrom("timeline_source_operations").selectAll().where("id", "=", operationId),
      );
      if (!row) fail("not_found", "No admitted push operation.", 404);
      if (row.state === outcome) return;
      if (row.state === "accepted" || row.state === "rejected")
        fail("operation_settled", "Push already settled.", 409);
      const input = JSON.parse(row.data) as SourcePush;
      if (input.recovery && outcome !== "ambiguous")
        fail("recovery_active", "Complete the durable recovery before settling this push.", 409);
      if (outcome === "accepted") {
        const timeline = this.byId(input.timelineId);
        for (const command of input.commands) this.setHead(timeline.id, input.repoId, command.new);
        timeline.pushedAt = this.now();
        timeline.updatedAt = this.now();
        timeline.version++;
        if (
          input.actorId &&
          input.actorId !== input.accountableId &&
          !timeline.agentIds.includes(input.actorId)
        )
          timeline.agentIds.push(input.actorId);
        this.status(timeline);
        this.save(timeline, "timeline.push", input.actorId);
      }
      input.projectionPending = projecting && outcome !== "ambiguous";
      run(
        this.sql,
        tracker
          .updateTable("timeline_source_operations")
          .set({ state: outcome, data: JSON.stringify(input) })
          .where("id", "=", operationId),
      );
    });
  }
  projectSourcePush(operationId: string) {
    const operation = this.sourcePush(operationId);
    if (operation.state !== "accepted" && operation.state !== "rejected") return;
    operation.projectionPending = false;
    const { state: _state, ...data } = operation;
    run(
      this.sql,
      tracker
        .updateTable("timeline_source_operations")
        .set({ data: JSON.stringify(data) })
        .where("id", "=", operationId),
    );
  }
  reserveSourcePushDelivery(
    operationId: string,
    repoId: string,
    sourceId: string,
    runIds: Partial<Record<"push" | "step", string>>,
  ) {
    return this.transaction(() => {
      const operation = this.sourcePush(operationId, repoId, sourceId);
      if (operation.delivery) return operation.delivery;
      if (operation.state !== "accepted" && operation.state !== "rejected")
        fail("source_busy", "Push outcome must be proven before CI delivery.", 409);
      const head =
        operation.recovery?.head ??
        (operation.state === "accepted" ? operation.commands[0]?.new : null);
      if (!head) fail("invalid_state", "A rejected push without a marker has no CI delivery.", 409);
      const source = this.getWorkSource(sourceId);
      if (source.state !== "ready" || source.repo_id !== repoId)
        fail("source_expired", "CI delivery requires the active owned source.", 409);
      operation.delivery = {
        head,
        runs: {
          push: { id: runIds.push ?? crypto.randomUUID().replaceAll("-", ""), state: "pending" },
          step: { id: runIds.step ?? crypto.randomUUID().replaceAll("-", ""), state: "pending" },
        },
      };
      const { state: _state, ...data } = operation;
      run(
        this.sql,
        tracker
          .updateTable("timeline_source_operations")
          .set({ data: JSON.stringify(data) })
          .where("id", "=", operationId),
      );
      return operation.delivery;
    });
  }

  completeSourcePushDelivery(
    operationId: string,
    trigger: "push" | "step",
    runId: string,
    result: { skipped: string } | { runId: string },
  ) {
    const operation = this.sourcePush(operationId);
    const deliveryRun = operation.delivery?.runs[trigger];
    if (!deliveryRun || deliveryRun.id !== runId || ("runId" in result && result.runId !== runId))
      fail("operation_conflict", "CI delivery does not match the persisted recovery run.", 409);
    if (deliveryRun.state !== "pending") return;
    deliveryRun.state = "skipped" in result ? "skipped" : "started";
    if ("skipped" in result) deliveryRun.reason = result.skipped;
    const { state: _state, ...data } = operation;
    run(
      this.sql,
      tracker
        .updateTable("timeline_source_operations")
        .set({ data: JSON.stringify(data) })
        .where("id", "=", operationId),
    );
  }
  resolveLegacyLanding(
    timelineId: string,
    expectedVersion: number,
    action: "cancel-unadvanced" | "accept-partial-and-abandon",
    note: string,
  ): Timeline {
    return this.transaction(() => {
      const timeline = this.byId(timelineId);
      if (timeline.repos.some((repo) => repo.source?.kind === "timeline-work"))
        fail("invalid_input", "This resolution is only for legacy canonical timelines.", 409);
      const landing = this.landing(timeline.slug);
      if (!landing || landing.version !== expectedVersion)
        fail("version_conflict", "Legacy landing changed.", 409);
      if (landing.state === "advancing" || landing.repos.some((repo) => repo.casIntent))
        fail(
          "landing_unresolved",
          "Reconcile the canonical CAS outcome before resolving this landing.",
          409,
        );
      const advanced = landing.repos.some((repo) => repo.state === "advanced");
      if (advanced && action !== "accept-partial-and-abandon")
        fail(
          "landing_unresolved",
          "Partial canonical success cannot be canceled or replayed.",
          409,
        );
      text(note, "note");
      const resolved: Landing = {
        ...landing,
        state: "failed",
        reason: note,
        version: landing.version + 1,
        updatedAt: this.now(),
      };
      run(
        this.sql,
        tracker
          .updateTable("timeline_landings")
          .set({ data: JSON.stringify(resolved) })
          .where("id", "=", landing.id),
      );
      timeline.status = action === "accept-partial-and-abandon" ? "abandoned" : "active";
      if (timeline.status === "abandoned") timeline.endedAt = this.now();
      timeline.version++;
      timeline.updatedAt = this.now();
      this.supersede(
        timeline,
        "Legacy landing explicitly resolved; migration needs fresh approval.",
        null,
        null,
      );
      this.landingEvent(resolved, "failed", note);
      this.save(timeline, "timeline.migration.resolve", null);
      return timeline;
    });
  }
  beginLegacyMigration(timelineId: string): Timeline {
    return this.transaction(() => {
      const timeline = this.byId(timelineId);
      if (timeline.migrationState === "ready") return timeline;
      const landing = this.landing(timeline.slug);
      if (
        landing &&
        landing.state !== "landed" &&
        (LANDING_ACTIVE.includes(landing.state) ||
          (!ENDED.includes(timeline.status) &&
            landing.repos.some((repo) => repo.state === "advanced" || repo.casIntent)))
      )
        fail("landing_unresolved", "Resolve the legacy landing before migration.", 409);
      if (this.sourcePushes().some((operation) => operation.timelineId === timeline.id))
        fail("source_busy", "Resolve source operations before migration.", 409);
      if (timeline.migrationState === "frozen") return timeline;
      timeline.migrationState = "frozen";
      timeline.version++;
      timeline.updatedAt = this.now();
      this.supersede(
        timeline,
        "Source migration requires a fresh checkpoint and approval.",
        null,
        null,
      );
      this.save(timeline, "timeline.migration", null);
      return timeline;
    });
  }
  completeLegacyMigration(timelineId: string, repos: TimelineRepo[]): Timeline {
    return this.transaction(() => {
      const timeline = this.byId(timelineId);
      if (timeline.migrationState === "ready") return timeline;
      if (timeline.migrationState !== "frozen")
        fail("migration_not_frozen", "Freeze migration before replacing sources.", 409);
      const historical = ENDED.includes(timeline.status);
      if (
        repos.length !== timeline.repos.length ||
        timeline.repos.some(
          (old) =>
            !repos.some(
              (repo) =>
                repo.id === old.id &&
                (historical
                  ? repo.source?.kind === "canonical-historical"
                  : repo.source?.kind === "timeline-work" &&
                    repo.source.timelineId === timeline.id) &&
                repo.logicalBase,
            ),
        )
      )
        fail("invalid_source", "Migration requires every ready owned source.", 409);
      if (!historical)
        for (const repo of repos) {
          const allocation = first(
            this.sql,
            tracker
              .selectFrom("timeline_source_allocations")
              .select("data")
              .where("source_id", "=", repo.source!.sourceId),
          );
          if (!allocation || (JSON.parse(allocation.data) as WorkSourceRow).state !== "ready")
            fail(
              "source_not_ready",
              "Migration requires a ready allocation for every source.",
              409,
            );
        }
      timeline.repos = repos;
      timeline.migrationState = "ready";
      timeline.version++;
      timeline.updatedAt = this.now();
      for (const repo of repos) this.setHead(timeline.id, repo.id, null);
      this.save(timeline, "timeline.migration", null);
      return timeline;
    });
  }
  /** Not found: removed by retention (and why), or never there. */
  private missing(ref: string): never {
    const stone = tombstone(this.sql, "timeline", ref);
    if (stone) fail("removed_by_retention", removedMessage(stone), 404);
    fail("not_found", `No timeline ${ref}.`, 404);
  }
  private now() {
    return new Date(this.clock()).toISOString();
  }
  private find(slug: string): Timeline | null {
    const row = first(
      this.sql,
      tracker.selectFrom("timelines").select("data").where(json("data", "$.slug"), "=", slug),
    );
    return row ? decodeTimeline(row.data) : null;
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
      .map((row) => decodeTimeline(row.data))
      .filter((timeline) => !status || timeline.status === status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug));
  }
  get(slug: string): Timeline {
    const timeline = this.find(timelineSlug(slug));
    if (!timeline) this.missing(slug);
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
    // Slugs name bookmarks, previews and runs: one retention removed stays taken.
    if (tombstone(this.sql, "timeline", timelineSlug(slug)))
      fail(
        "already_exists",
        `A timeline named ${slug} existed and was removed by retention; choose another name.`,
        409,
      );
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
      const existing = this.find(slug);
      if (existing && existing.id === input.id && existing.startedBy === access.actorId)
        return existing;
      const parent = this.prepare(slug, input.parent);
      if (!input.repos.length) fail("invalid_input", "A timeline touches at least one repository.");
      for (const repo of input.repos)
        if (!/^[0-9a-f]{40}$/.test(input.commits[repo.id] ?? ""))
          fail("invalid_input", `No fork commit for ${repo.owner}/${repo.name}.`);
      if (input.id) {
        this.assertCreationOpen(input.id);
        const reservation = first(
          this.sql,
          tracker.selectFrom("timeline_reservations").selectAll().where("id", "=", input.id),
        );
        if (!reservation || reservation.slug !== slug || reservation.actor_id !== access.actorId)
          fail("invalid_source", "Creation must use its reserved timeline identity.", 409);
        for (const repo of input.repos) {
          if (!repo.source || repo.source.timelineId !== input.id || !repo.logicalBase)
            fail("invalid_source", "Every new timeline repository needs its owned source.", 409);
          const source = this.getWorkSource(repo.source.sourceId);
          if (
            source.state !== "ready" ||
            source.repo_id !== repo.id ||
            source.fork_commit !== input.commits[repo.id]
          )
            fail(
              "source_not_ready",
              "All pinned owned sources must be ready before creation.",
              409,
            );
        }
      }
      const now = this.now();
      const trackerCursor = one(
        this.sql,
        tracker
          .selectFrom("events")
          .select((eb) => eb.fn.coalesce(eb.fn.max("cursor"), eb.lit(0)).as("cursor")),
      ).cursor;
      const agent = access.actorId !== access.principalId;
      const timeline: Timeline = {
        id: input.id ?? `tl_${crypto.randomUUID()}`,
        slug,
        name: input.name === undefined ? slug : text(input.name, "name"),
        policy: this.policy(input.policy),
        experimental: this.flag(input.experimental, "experimental") ?? false,
        parentId: parent?.id ?? null,
        forkPoint: { commits: input.commits, trackerCursor },
        repos: input.repos.map((repo) => ({
          ...repo,
          bookmark: repo.source ? "work" : timelineBookmark(slug),
        })),
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
    if (this.sourcePushes().some((operation) => operation.timelineId === timeline.id))
      fail("source_busy", "Reconcile pending source writes before abandoning.", 409);
    const landing = this.landing(timeline.slug);
    // Settled partial success is immutable evidence, not an outstanding write.
    // Legacy partials use their explicit migration-resolution operation instead.
    const settledOwnedPartial =
      landing &&
      timeline.repos.every((repo) => repo.source?.kind === "timeline-work") &&
      landing.repos.some((repo) => repo.state === "advanced") &&
      landing.repos.some((repo) => repo.state !== "advanced");
    if (
      landing &&
      (LANDING_ACTIVE.includes(landing.state) ||
        landing.repos.some((repo) => repo.state !== "advanced" && repo.casIntent) ||
        (!settledOwnedPartial && landing.repos.some((repo) => repo.state === "advanced")))
    )
      fail("landing_unresolved", "Resolve the landing before abandoning.", 409);
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
   * End a timeline with each source's last commit. A settled partial landing's
   * successful receipts remain intact; abandonment never rolls canonical back.
   * Repeating abandonment changes nothing (`abandoned` is false).
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
        // Canonical bookmark observations can arrive after their migration cleanup.
        // Only admitted source operations may update owned timeline heads or activity.
        if (
          timeline &&
          (timeline.migrationState === "frozen" ||
            timeline.repos.some((repo) => repo.source?.kind === "timeline-work"))
        )
          return null;
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

  byId(timelineId: string): Timeline {
    const row = first(
      this.sql,
      tracker.selectFrom("timelines").select("data").where("id", "=", timelineId),
    );
    if (!row) this.missing(timelineId);
    return decodeTimeline(row.data);
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
    const timeline = this.byId(checkpoint.timelineId);
    if (timeline.migrationState === "frozen") return false;
    if (this.sourcePushes().some((operation) => operation.timelineId === timeline.id)) return false;
    if (
      timeline.migrationState === "ready" &&
      checkpoint.repos.some(
        (repo) =>
          !repo.source ||
          repo.source.sourceId !==
            timeline.repos.find((entry) => entry.id === repo.id)?.source?.sourceId,
      )
    )
      return false;
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
      ...(answered.via ? { via: answered.via } : {}),
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
      this.writableSourceTimeline(timeline);
      if (this.sourcePushes().some((operation) => operation.timelineId === timeline.id))
        fail("source_busy", "A source push is not reconciled.", 409);
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
        const owner = timeline.repos.find((entry) => entry.id === repo.id);
        if (
          !repo.source ||
          !repo.logicalBase ||
          !repo.dependencies ||
          repo.source.sourceId !== owner?.source?.sourceId ||
          repo.source.commit !== repo.commit ||
          repo.source.repoId !== repo.id ||
          !OID.test(repo.source.tree)
        )
          fail(
            "invalid_source",
            "Checkpoint must pin its exact owned source and logical base.",
            409,
          );
        if (!OID.test(repo.commit) || (repo.base !== null && !OID.test(repo.base)))
          fail("invalid_input", `Commits for ${repo.owner}/${repo.name} must be full commit ids.`);
        if (repo.changes.length > CHECKPOINT_CHANGES)
          fail("invalid_input", `At most ${CHECKPOINT_CHANGES} changes per repository.`);
      }
      const commits = Object.fromEntries(input.repos.map((repo) => [repo.id, repo.commit]));
      const previous = this.latest(timeline.id);
      const same = (pinned: Record<string, string>) =>
        input.repos.every((repo) => pinned[repo.id] === repo.commit);
      // Source identity and reviewed dependency proof can change without a new work OID.
      if (
        previous &&
        previous.repos.length === input.repos.length &&
        input.repos.every((repo) => {
          const pinned = previous.repos.find((entry) => entry.id === repo.id);
          const dependencies = repo.dependencies ?? [];
          const previousDependencies = pinned?.dependencies ?? [];
          const sameDependency = (
            a: (typeof dependencies)[number],
            b: (typeof dependencies)[number],
          ) => sameSnapshot(a.source, b.source) && sameSnapshot(a.base, b.base);
          return (
            pinned?.commit === repo.commit &&
            sameSnapshot(pinned.source, repo.source) &&
            sameSnapshot(pinned.logicalBase, repo.logicalBase) &&
            dependencies.every((edge) =>
              previousDependencies.some((other) => sameDependency(edge, other)),
            ) &&
            previousDependencies.every((edge) =>
              dependencies.some((other) => sameDependency(edge, other)),
            )
          );
        })
      )
        fail(
          "unchanged",
          `Checkpoint #${previous.number} already pins this source and dependency proof.`,
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
          source: repo.source,
          logicalBase: repo.logicalBase,
          dependencies: repo.dependencies,
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
    via?: "auto-approve",
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
        ...(via ? { via } : {}),
        actorId: access.actorId,
        accountableId: access.principalId,
        createdAt: this.now(),
      },
      [timeline.id],
    );
  }

  // ---- landing (CORE-77) -----------------------------------------------------

  /** Whether any landing of this checkpoint was ever begun, in any state. */
  private everLanded(timelineId: string, checkpointId: string): boolean {
    return !!first(
      this.sql,
      tracker
        .selectFrom("timeline_landings")
        .select("id")
        .where("timeline_id", "=", timelineId)
        .where(json("data", "$.checkpointId"), "=", checkpointId)
        .limit(1),
    );
  }
  /**
   * What retrying an approval's landing reads (CORE-390): the timeline's
   * policy and status, its head checkpoint's state (null without one), and
   * whether that head ever had a landing.
   */
  headCheckpoint(slug: string): {
    timeline: Pick<Timeline, "id" | "slug" | "policy" | "status">;
    head: CheckpointState | null;
    everLanded: boolean;
  } {
    const timeline = this.get(slug);
    const head = this.latest(timeline.id);
    return {
      timeline: {
        id: timeline.id,
        slug: timeline.slug,
        policy: timeline.policy,
        status: timeline.status,
      },
      head: head ? this.state(head) : null,
      everLanded: head ? this.everLanded(timeline.id, head.id) : false,
    };
  }
  /**
   * Approval timelines whose head checkpoint was approved since `since` and
   * is still current, but never began landing (CORE-390): what an approval
   * should have queued when its first try failed. A head with any landing,
   * running, landed or stopped, is the landing's to finish or a person's to
   * retry; so is one beginLanding would refuse for now (a source write being
   * reconciled, an earlier landing left partly advanced). Newest first, at
   * most `limit`, each with who approved it and when.
   */
  approvedUnlanded(
    limit: number,
    since: string,
  ): { slug: string; checkpointId: string; approverId: string; approvedAt: string }[] {
    const found: { slug: string; checkpointId: string; approverId: string; approvedAt: string }[] =
      [];
    if (limit <= 0) return found;
    const candidates = all(
      this.sql,
      tracker
        .selectFrom("timelines")
        .select("data")
        .where(json("data", "$.policy"), "=", "approval")
        .where(json("data", "$.status"), "not in", ENDED),
    )
      .map((row) => decodeTimeline(row.data))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.slug.localeCompare(b.slug));
    const busy = new Set(this.sourcePushes().map((operation) => operation.timelineId));
    for (const timeline of candidates) {
      if (found.length >= limit) break;
      if (busy.has(timeline.id) || timeline.migrationState === "frozen") continue;
      const head = this.latest(timeline.id);
      if (!head || this.everLanded(timeline.id, head.id)) continue;
      const previous = this.landing(timeline.slug);
      if (previous?.repos.some((repo) => repo.state === "advanced" || repo.casIntent)) continue;
      const state = this.state(head);
      const approval = state.approval;
      if (!state.approved || !approval?.by || !approval.at || approval.at < since) continue;
      found.push({
        slug: timeline.slug,
        checkpointId: head.id,
        approverId: approval.by,
        approvedAt: approval.at,
      });
    }
    return found;
  }
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
  /** Exact repository advance, including older attempts of a partly landed timeline. */
  landingForCommit(repoId: string, commit: string): Landing | null {
    const row = first(
      this.sql,
      tracker
        .selectFrom("timeline_landings")
        .select("data")
        .where(sql<boolean>`exists (
          select 1 from json_each(timeline_landings.data, '$.repos') as repo
          where json_extract(repo.value, '$.id') = ${repoId}
            and json_extract(repo.value, '$.merge') = ${commit}
            and json_extract(repo.value, '$.state') = 'advanced'
        )`)
        .orderBy("created_at")
        .orderBy("id")
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
      if (timeline.migrationState === "frozen" || timeline.repos.some((repo) => !repo.source))
        fail("migration_required", "Migrate the legacy timeline before landing.", 409);
      if (this.sourcePushes().some((operation) => operation.timelineId === timeline.id))
        fail("source_busy", "A source mutation awaits reconciliation.", 409);
      if (ENDED.includes(timeline.status))
        fail("timeline_ended", `${timeline.slug} is ${timeline.status}.`, 409);
      // A retry lands only a checkpoint that never had a landing (CORE-390).
      if (request.onlyIfUnlanded !== undefined) {
        if (timeline.policy !== "approval")
          fail("invalid_input", "Only an approval timeline's landing is retried.", 409);
        if (this.latest(timeline.id)?.id !== request.onlyIfUnlanded)
          fail(
            "checkpoint_moved",
            `${timeline.slug} has a newer checkpoint than the one to retry.`,
            409,
          );
        if (this.everLanded(timeline.id, request.onlyIfUnlanded))
          fail(
            "landing_exists",
            `That checkpoint of ${timeline.slug} already has a landing; it isn't retried.`,
            409,
          );
      }
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
      if (
        previous &&
        previous.checkpointId !== head.id &&
        previous.repos.some((repo) => repo.state === "advanced" || repo.casIntent)
      )
        fail(
          "landing_unresolved",
          "Resolve the previous landing before selecting another checkpoint.",
          409,
        );
      const retry = previous?.checkpointId === head.id ? previous : null;
      // Preserve published outcomes, unresolved CAS intents and tested siblings.
      // The Worker rechecks every unadvanced main before using a retained candidate.
      const advanced = new Map(
        (previous?.checkpointId === head.id ? previous.repos : [])
          .filter((repo) => repo.state === "advanced" || repo.state === "tested" || repo.casIntent)
          .map((repo) => [
            repo.id,
            repo.state === "advanced" ? repo : { ...repo, state: "tested" as const },
          ]),
      );
      const landing: Landing = {
        id: retry?.id ?? `ld_${crypto.randomUUID()}`,
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
              source: repo.source,
              logicalBase: repo.logicalBase,
              dependencies: repo.dependencies,
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
        version: (retry?.version ?? 0) + 1,
        createdAt: retry?.createdAt ?? now,
        updatedAt: now,
      };
      run(
        this.sql,
        tracker
          .insertInto("timeline_landings")
          .values({
            id: landing.id,
            timeline_id: timeline.id,
            created_at: now,
            data: JSON.stringify(landing),
          })
          .onConflict((oc) => oc.column("id").doUpdateSet({ data: JSON.stringify(landing) })),
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
          : saved.state === "conflict" ||
              saved.state === "failed" ||
              saved.state === "blocked_dependency"
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
