import { DurableObject } from "cloudflare:workers";
import { forgetUpstreamTokens, isArtifactsError } from "../artifacts.ts";
import { TrackerError, TrackerStore, type Access } from "./store.ts";
import {
  type TimelineStore,
  type LandingRequest,
  type NewCheckpoint,
  type NewTimeline,
  type PushActivity,
  type SourcePush,
  type SourcePushRecovery,
} from "./timelines.ts";
import type { MutationRequest } from "../../shared/tracker.ts";
import type { ChronicleOptions } from "./chronicle.ts";
import { runChronicleFixture, type ChronicleFixtureOptions } from "./chronicle-fixture.ts";
import type { QueueFailure } from "../../shared/merge-queue.ts";
import type { SearchQuery } from "../search/query.ts";
import type { Checkpoint, Landing, Timeline, TimelineStatus } from "../../shared/timelines.ts";
import type { TimelineRepo } from "../../shared/timelines.ts";
import type { WorkSourceRow } from "../timelines/sources.ts";
import {
  initializeWorkSource,
  type InitializedWorkSource,
  type WorkSourceInput,
} from "../timelines/sources.ts";
import type { RepoRow } from "../db.ts";
import {
  clearStorage,
  pendingRetirement,
  resetSoon,
  scheduleRetirement,
  settleRetirement,
  storageReport,
  type Purgeable,
  type PurgeReport,
} from "../durable/contract.ts";
import {
  removeActivity,
  removeClosedIssues,
  selectActivity,
  selectClosedIssues,
  type TrackerCategory,
  type TrackerRemoval,
  type TrackerSelection,
} from "./retention.ts";

export type TrackerReply<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: TrackerError["status"];
      error: string;
      code: string;
      details: TrackerError["details"];
    };
export class Tracker extends DurableObject<Env> implements Purgeable {
  private store: TrackerStore;
  private timelines: TimelineStore;
  private sourceInitializers = new Map<string, Promise<InitializedWorkSource>>();
  private transaction: <T>(fn: () => T) => T;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const transaction = <T>(fn: () => T) => ctx.storage.transactionSync(fn);
    this.transaction = transaction;
    this.store = new TrackerStore(ctx.storage.sql, transaction);
    // The tracker's own: superseding an approval withdraws its request there.
    this.timelines = this.store.timelines;
  }
  private reply<T>(fn: () => T): TrackerReply<T> {
    try {
      return { ok: true, value: fn() };
    } catch (error) {
      if (error instanceof TrackerError)
        return {
          ok: false,
          status: error.status,
          error: error.message,
          code: error.code,
          details: error.details,
        };
      throw error;
    }
  }
  /** Isolated agent harness only: preserve pre-cutover records without active write fallback. */
  seedLegacySourceFixture(
    agentId: string,
    input: {
      timeline: Timeline;
      checkpoint: Checkpoint | null;
      landing: Landing | null;
      approved?: boolean;
    },
  ): TrackerReply<Timeline> {
    return this.reply(() => {
      if (
        Reflect.get(this.env, "DEV_MODE") !== "true" ||
        !agentId ||
        Reflect.get(this.env, "AGENT_ID") !== agentId
      )
        throw new TrackerError(
          403,
          "forbidden",
          "Legacy fixtures require an isolated agent runtime.",
        );
      const { timeline, checkpoint, landing } = input;
      const prefix = "source-migration-";
      const repos = timeline.repos;
      if (
        !timeline.id.startsWith(prefix) ||
        !timeline.slug.startsWith(prefix) ||
        timeline.id.length > 100 ||
        timeline.slug.length > 64 ||
        repos.length < 1 ||
        repos.length > 2 ||
        new Set(repos.map((repo) => repo.id)).size !== repos.length ||
        repos.some((repo) => repo.source || repo.logicalBase || repo.dependencies) ||
        JSON.stringify(input).length > 50_000 ||
        (checkpoint &&
          (checkpoint.timelineId !== timeline.id ||
            !checkpoint.id.startsWith(prefix) ||
            checkpoint.repos.length !== repos.length ||
            checkpoint.repos.some(
              (repo) =>
                !repos.some((entry) => entry.id === repo.id) ||
                repo.source ||
                repo.logicalBase ||
                repo.dependencies,
            ))) ||
        (landing &&
          (landing.timelineId !== timeline.id ||
            landing.slug !== timeline.slug ||
            !landing.id.startsWith(prefix) ||
            landing.checkpointId !== checkpoint?.id ||
            landing.repos.length !== repos.length ||
            landing.repos.some(
              (repo) =>
                !repos.some((entry) => entry.id === repo.id) ||
                repo.source ||
                repo.logicalBase ||
                repo.dependencies,
            )))
      )
        throw new TrackerError(400, "invalid_input", "Invalid bounded legacy source fixture.");
      return this.transaction(() => {
        const sql = this.ctx.storage.sql;
        if (
          sql
            .exec(
              "SELECT id FROM timelines WHERE id = ? OR json_extract(data, '$.slug') = ?",
              timeline.id,
              timeline.slug,
            )
            .toArray().length ||
          sql
            .exec(
              "SELECT source_id FROM timeline_source_allocations WHERE timeline_id = ?",
              timeline.id,
            )
            .toArray().length ||
          sql
            .exec(
              "SELECT id FROM timeline_reservations WHERE id = ? OR slug = ?",
              timeline.id,
              timeline.slug,
            )
            .toArray().length
        )
          throw new TrackerError(
            409,
            "already_exists",
            "Legacy fixture already exists or owns a source.",
          );
        sql.exec(
          "INSERT INTO timelines (id, data) VALUES (?, ?)",
          timeline.id,
          JSON.stringify(timeline),
        );
        if (checkpoint) {
          sql.exec(
            "INSERT INTO timeline_checkpoints (id, timeline_id, number, data) VALUES (?, ?, ?, ?)",
            checkpoint.id,
            timeline.id,
            checkpoint.number,
            JSON.stringify(checkpoint),
          );
          for (const repo of checkpoint.repos)
            sql.exec(
              "INSERT INTO timeline_heads (timeline_id, repo_id, oid) VALUES (?, ?, ?)",
              timeline.id,
              repo.id,
              repo.commit,
            );
          if (input.approved) {
            const eventId = `${checkpoint.id}-approval`;
            const event = {
              id: eventId,
              timelineId: timeline.id,
              kind: "approval",
              checkpointId: checkpoint.id,
              number: checkpoint.number,
              requestId: `${checkpoint.id}-request`,
              outcome: "approved",
              note: null,
              actorId: timeline.accountableId,
              accountableId: timeline.accountableId,
              createdAt: checkpoint.createdAt,
            };
            const row = sql
              .exec(
                "INSERT INTO timeline_events (id, data) VALUES (?, ?) RETURNING seq",
                eventId,
                JSON.stringify(event),
              )
              .one();
            sql.exec(
              "INSERT INTO timeline_event_index (timeline_id, seq) VALUES (?, ?)",
              timeline.id,
              row.seq,
            );
          }
        }
        if (landing)
          sql.exec(
            "INSERT INTO timeline_landings (id, timeline_id, created_at, data) VALUES (?, ?, ?, ?)",
            landing.id,
            timeline.id,
            landing.createdAt,
            JSON.stringify(landing),
          );
        return timeline;
      });
    });
  }
  snapshot(access: Access, timeline?: string, withTimelines = false) {
    return this.reply(() => this.store.snapshot(access, timeline, withTimelines));
  }
  changes(after: number, limit: number, withTimelines = false) {
    return this.reply(() => this.store.changes(after, limit, withTimelines));
  }
  history(access: Access, issueId: string, before: number | null, limit: number) {
    return this.reply(() => this.store.history(access, issueId, before, limit));
  }
  /** One page of the Chronicle (CORE-250). */
  chronicle(access: Access, options: ChronicleOptions) {
    return this.reply(() => this.store.chronicle(access, options));
  }
  /** An issue's timelines, checkpoints and landings, for its linked work (CORE-250). */
  issueWork(issue: string) {
    return this.reply(() => this.store.issueWork(issue));
  }
  /**
   * DEVELOPMENT ONLY (POST /api/dev/chronicle, CORE-251): a synthetic history
   * made of real mutations, applied in time order under a controlled clock.
   */
  chronicleFixture(people: Access[], agents: Access[], options: ChronicleFixtureOptions) {
    if (Reflect.get(this.env, "DEV_MODE") !== "true")
      throw new Error("The Chronicle fixture is for development only.");
    let clock = Date.now();
    const store = new TrackerStore(this.ctx.storage.sql, this.transaction, () => clock);
    return runChronicleFixture(
      (access, at, request) => {
        clock = at;
        return store.mutate(access, request);
      },
      people,
      agents,
      options,
    );
  }
  openRequests() {
    return this.reply(() => this.store.openRequests());
  }
  /** The tag catalog with usage counts (CORE-271). */
  tagCatalog() {
    return this.reply(() => this.store.tagCatalog());
  }
  teamDirectory() {
    return this.reply(() => this.store.teamDirectory());
  }
  repoReadySummary(repoId: string, timeline?: string) {
    return this.reply(() => this.store.repoReadySummary(repoId, timeline));
  }
  subscribedWorkspaces(repoId: string) {
    return this.reply(() => this.store.subscribedWorkspaces(repoId));
  }
  subscriptionRepoIds(subscriptionIds: string[]) {
    return this.reply(() => this.store.subscriptionRepoIds(subscriptionIds));
  }
  workspaceSlugs() {
    return this.reply(() => this.store.workspaceSlugs());
  }
  searchIssues(query: SearchQuery, limit: number) {
    return this.reply(() => this.store.searchIssues(query, limit));
  }
  issueRefs(refs: string[]) {
    return this.reply(() => this.store.issueRefs(refs));
  }
  issuesByKey(keys: string[]) {
    return this.reply(() => this.store.issuesByKey(keys));
  }
  completedBetween(since: string, until: string, limit: number) {
    return this.reply(() => this.store.completedBetween(since, until, limit));
  }
  mutate(access: Access, input: MutationRequest) {
    return this.reply(() => this.store.mutate(access, input));
  }
  /** Internal Worker RPCs; never routed through client Mutation payloads. */
  validateQueueIssues(access: Access, issueIds: string[]) {
    return this.reply(() => this.store.validateQueueIssues(access, issueIds));
  }
  recordQueueFailure(
    access: Access,
    input: { repoId: string; issueIds: string[]; failure: QueueFailure },
  ) {
    return this.reply(() => this.store.recordQueueFailure(access, input));
  }
  listTimelines(status?: TimelineStatus) {
    return this.reply(() => this.timelines.list(status));
  }
  /** A timeline, its events, and its issues (CORE-74). */
  timeline(slug: string, after: number, limit: number) {
    return this.reply(() => {
      const detail = this.timelines.detail(slug, after, limit);
      const issues = this.store.timelineIssues(detail.timeline.id)[detail.timeline.id] ?? [];
      return { ...detail, issues };
    });
  }
  /** The graph's timelines and events, and each timeline's issues. */
  timelineGraph(limit: number) {
    return this.reply(() => ({
      ...this.timelines.graph(limit),
      issues: this.store.timelineIssues(),
    }));
  }
  timelineById(timelineId: string) {
    return this.reply(() => this.timelines.byId(timelineId));
  }
  reserveTimeline(access: Access, slug: string, parent: string | null, input: string) {
    return this.reply(() => this.timelines.reserveTimeline(access, slug, parent, input));
  }
  async cancelReservedCreation(access: Access, slug: string) {
    const claim = this.reply(() => this.timelines.cancelReservedCreation(access, slug));
    if (!claim.ok) return claim;
    if (claim.value === null) return { ok: true as const, value: null };
    for (const allocation of claim.value) {
      const pending = this.sourceInitializers.get(
        `${allocation.timeline_id}:${allocation.repo_id}`,
      );
      if (pending) await pending.catch(() => undefined);
      let row = this.timelines.getWorkSource(allocation.source_id);
      if (row.state === "creating") {
        // A restarted initializer may still have an outstanding remote fork.
        // Missing by name is not proof that its delayed creation cannot arrive.
        try {
          using provider = await this.env.ARTIFACTS.get(row.artifacts_name);
          await provider.info();
        } catch (error) {
          if (!isArtifactsError(error, "NOT_FOUND")) throw error;
          return this.reply(() => {
            throw new TrackerError(
              409,
              "source_initialization_pending",
              "Creation is cancelled, but an unresolved source allocation still needs reconciliation. Retry cancellation after initialization settles.",
            );
          });
        }
      }
      if (row.state !== "purged") {
        row = this.timelines.transitionWorkSource(row.source_id, row.version, "purging");
        await this.env.DB.prepare(
          "UPDATE timeline_work_sources SET state=?,version=?,updated_at=? WHERE source_id=? AND repo_id=? AND timeline_id=?",
        )
          .bind(row.state, row.version, row.updated_at, row.source_id, row.repo_id, row.timeline_id)
          .run();
        forgetUpstreamTokens(row.artifacts_name);
        try {
          await this.env.ARTIFACTS.delete(row.artifacts_name);
        } catch (error) {
          if (!isArtifactsError(error, "NOT_FOUND")) throw error;
        }
        row = this.timelines.transitionWorkSource(row.source_id, row.version, "purged");
      }
      await this.env.DB.prepare(
        "UPDATE timeline_work_sources SET state=?,version=?,updated_at=? WHERE source_id=? AND repo_id=? AND timeline_id=?",
      )
        .bind(row.state, row.version, row.updated_at, row.source_id, row.repo_id, row.timeline_id)
        .run();
      await this.env.DB.prepare(
        "DELETE FROM timeline_source_roots WHERE repo_id=? AND consumer_kind='dependency' AND consumer_id=?",
      )
        .bind(row.repo_id, row.timeline_id)
        .run();
    }
    return { ok: true as const, value: { cancelled: true as const, slug } };
  }
  async initializeWorkSource(
    repo: RepoRow,
    input: WorkSourceInput,
  ): Promise<TrackerReply<InitializedWorkSource>> {
    const permitted = this.reply(() => this.timelines.assertCreationOpen(input.timelineId));
    if (!permitted.ok) return permitted;
    const key = `${input.timelineId}:${repo.id}`;
    const existing = this.sourceInitializers.get(key);
    const pending = existing ?? initializeWorkSource(this.env, repo, input);
    if (!existing) this.sourceInitializers.set(key, pending);
    try {
      return { ok: true, value: await pending };
    } catch (error) {
      return this.reply(() => {
        throw error;
      });
    } finally {
      if (!existing) this.sourceInitializers.delete(key);
    }
  }
  async reconcileDeletedSource(sourceId: string) {
    let row = this.timelines.getWorkSource(sourceId);
    const pending = this.sourceInitializers.get(`${row.timeline_id}:${row.repo_id}`);
    if (pending) {
      try {
        await pending;
      } catch {
        /* Read the durable allocation after the initializer settled. */
      }
      row = this.timelines.getWorkSource(sourceId);
    }
    const tombstone = await this.env.DB.prepare(
      "SELECT id FROM repos WHERE id=? AND deleted_at IS NOT NULL",
    )
      .bind(row.repo_id)
      .first();
    if (!tombstone)
      return this.reply(() => {
        throw new TrackerError(
          409,
          "source_not_deleted",
          "Canonical repository is not tombstoned.",
        );
      });
    if (row.state === "creating") {
      // A ready capability proves the named provider fork finished. NOT_FOUND
      // cannot prove an ambiguous provider request will never create it.
      using provider = await this.env.ARTIFACTS.get(row.artifacts_name);
      await provider.info();
      row = this.timelines.transitionWorkSource(sourceId, row.version, "failed");
      await this.env.DB.prepare(
        "UPDATE timeline_work_sources SET state=?,version=?,updated_at=? WHERE source_id=? AND state='creating'",
      )
        .bind(row.state, row.version, row.updated_at, row.source_id)
        .run();
    }
    return { ok: true as const, value: row };
  }
  reserveWorkSource(repo: { id: string; owner_id: string }, input: WorkSourceInput) {
    return this.reply(() => this.timelines.reserveWorkSource(repo, input));
  }
  getWorkSource(sourceId: string) {
    return this.reply(() => this.timelines.getWorkSource(sourceId));
  }
  renameWorkSource(sourceId: string, version: number) {
    return this.reply(() => this.timelines.renameWorkSource(sourceId, version));
  }
  async transitionWorkSource(
    sourceId: string,
    version: number,
    state: WorkSourceRow["state"],
    remote?: string,
  ) {
    const result = this.reply(() =>
      this.timelines.transitionWorkSource(sourceId, version, state, remote),
    );
    if (result.ok && state === "archived") {
      const row = result.value;
      await this.env.DB.prepare(`UPDATE timeline_work_sources
        SET state='archived',version=?,updated_at=?,archived_at=?,archive_disposition=?
        WHERE source_id=? AND repo_id=? AND timeline_id=? AND version<=?
          AND state NOT IN ('purging','purged')`)
        .bind(
          row.version,
          row.updated_at,
          row.archived_at,
          row.archive_disposition,
          row.source_id,
          row.repo_id,
          row.timeline_id,
          row.version,
        )
        .run();
    }
    return result;
  }
  async beginSourcePush(input: SourcePush) {
    const admitted = this.reply(() => this.timelines.beginSourcePush(input, true));
    if (!admitted.ok) return admitted;
    const now = new Date().toISOString();
    try {
      const projected = await this.env.DB.prepare(`INSERT INTO source_operations
        (id,owner_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
        SELECT ?,owner_id,?,?,?,'push','admitted',?,?,? FROM repos WHERE id=? AND deleted_at IS NULL
        ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at WHERE source_operations.state='admitted'
        RETURNING id`)
        .bind(
          input.operationId,
          input.timelineId,
          input.repoId,
          input.sourceId,
          JSON.stringify(input),
          now,
          now,
          input.repoId,
        )
        .first();
      if (!projected) {
        this.timelines.finishSourcePush(input.operationId, "rejected");
        return this.reply(() => {
          throw new TrackerError(409, "source_frozen", "Repository deletion fenced this push.");
        });
      }
      this.timelines.activateSourcePush(input.operationId);
      return admitted;
    } catch (error) {
      const operation = this.timelines.sourcePush(input.operationId);
      if (operation.state === "projecting")
        this.timelines.finishSourcePush(input.operationId, "rejected");
      throw error;
    }
  }
  async finishSourcePush(operationId: string, outcome: "accepted" | "rejected" | "ambiguous") {
    const result = this.reply(() => this.timelines.finishSourcePush(operationId, outcome, true));
    if (result.ok) {
      const operation = this.timelines.sourcePush(operationId);
      await this.env.DB.prepare(
        "UPDATE source_operations SET state=?,data=?,updated_at=? WHERE id=? AND repo_id=? AND source_id=? AND (state IN ('admitted','ambiguous') OR state=?)",
      )
        .bind(
          operation.state,
          JSON.stringify(operation),
          new Date().toISOString(),
          operationId,
          operation.repoId,
          operation.sourceId,
          operation.state,
        )
        .run();
      if (operation.state === "accepted" || operation.state === "rejected")
        this.timelines.projectSourcePush(operationId);
    }
    return result;
  }
  reserveSourcePushDelivery(
    operationId: string,
    repoId: string,
    sourceId: string,
    runIds: Partial<Record<"push" | "step", string>>,
  ) {
    return this.reply(() =>
      this.timelines.reserveSourcePushDelivery(operationId, repoId, sourceId, runIds),
    );
  }
  completeSourcePushDelivery(
    operationId: string,
    trigger: "push" | "step",
    runId: string,
    result: { skipped: string } | { runId: string },
  ) {
    return this.reply(() =>
      this.timelines.completeSourcePushDelivery(operationId, trigger, runId, result),
    );
  }
  beginSourcePushRecovery(
    operationId: string,
    repoId: string,
    sourceId: string,
    intent: SourcePushRecovery,
  ) {
    return this.reply(() =>
      this.timelines.beginSourcePushRecovery(operationId, repoId, sourceId, intent),
    );
  }
  async settleSourcePushRecovery(
    operationId: string,
    outcome: "accepted" | "rejected",
    head: string,
  ) {
    const settled = this.reply(() =>
      this.timelines.settleSourcePushRecovery(operationId, outcome, head),
    );
    if (!settled.ok) return settled;
    // The authoritative terminal outcome is immutable, but still holds the
    // timeline fence until its D1 projection has succeeded. Replay repairs it.
    const projected = await this.finishSourcePush(operationId, outcome);
    if (!projected.ok) return projected;
    return this.reply(() => this.timelines.projectSourcePushRecovery(operationId));
  }
  sourcePushes(repoId?: string) {
    return this.reply(() => this.timelines.sourcePushes(repoId));
  }
  sourcePush(operationId: string, repoId: string, sourceId: string) {
    return this.reply(() => this.timelines.sourcePush(operationId, repoId, sourceId));
  }
  async rejectUnprojectedSourcePush(operationId: string, repoId: string, sourceId: string) {
    const operation = this.timelines.sourcePush(operationId, repoId, sourceId);
    if (operation.state !== "projecting") return { ok: true as const, value: false };
    const result = await this.finishSourcePush(operationId, "rejected");
    return result.ok ? { ok: true as const, value: true } : result;
  }
  resolveLegacyLanding(
    timelineId: string,
    expectedVersion: number,
    action: "cancel-unadvanced" | "accept-partial-and-abandon",
    note: string,
  ) {
    return this.reply(() =>
      this.timelines.resolveLegacyLanding(timelineId, expectedVersion, action, note),
    );
  }
  beginLegacyMigration(timelineId: string) {
    return this.reply(() => this.timelines.beginLegacyMigration(timelineId));
  }
  completeLegacyMigration(timelineId: string, repos: TimelineRepo[]) {
    return this.reply(() => this.timelines.completeLegacyMigration(timelineId, repos));
  }
  prepareTimeline(slug: string, parent: string | null) {
    return this.reply(() => this.timelines.prepare(slug, parent));
  }
  createTimeline(access: Access, input: NewTimeline) {
    return this.reply(() => this.timelines.create(access, input));
  }
  updateTimeline(
    slug: string,
    data: Record<string, unknown>,
    expectedVersion?: unknown,
    access?: Access,
  ) {
    return this.reply(() => this.timelines.update(slug, data, expectedVersion, access));
  }
  mayAbandonTimeline(access: Access, slug: string) {
    return this.reply(() => this.timelines.mayAbandon(access, slug));
  }
  /** Abandon it, and return the issues done in it to ready (CORE-74), together. */
  abandonTimeline(access: Access, slug: string, lastCommits: Record<string, string | null>) {
    return this.reply(() =>
      this.transaction(() => {
        const result = this.timelines.abandon(access, slug, lastCommits);
        this.store.timelineAbandoned(access, result.timeline);
        return result;
      }),
    );
  }
  /** A push's timeline activity; work done in a merged timeline is then done in the other. */
  recordTimelinePush(activity: PushActivity) {
    return this.reply(() =>
      this.transaction(() =>
        this.timelines.recordPush(activity, (merge) =>
          this.store.timelineMerged(merge.fromId, merge.intoId, merge.id, activity.actorId),
        ),
      ),
    );
  }
  checkpoints(slug: string) {
    return this.reply(() => this.timelines.checkpoints(slug));
  }
  checkpoint(slug: string, ref: string) {
    return this.reply(() => this.timelines.checkpoint(slug, ref));
  }
  checkpointStates(ids: string[]) {
    return this.reply(() => this.timelines.checkpointStates(ids));
  }
  createCheckpoint(access: Access, slug: string, input: NewCheckpoint) {
    return this.reply(() => this.timelines.createCheckpoint(access, slug, input));
  }
  // ---- landing (CORE-77) -----------------------------------------------------
  landing(slug: string) {
    return this.reply(() => this.timelines.landing(slug));
  }
  landingForCommit(repoId: string, commit: string) {
    return this.reply(() => this.timelines.landingForCommit(repoId, commit));
  }
  landingForRun(slug: string, runId: string) {
    return this.reply(() => this.timelines.landingForRun(slug, runId));
  }
  activeLandings() {
    return this.reply(() => this.timelines.activeLandings());
  }
  beginLanding(access: Access, slug: string, request: LandingRequest) {
    return this.reply(() => this.timelines.beginLanding(access, slug, request));
  }
  saveLanding(next: Landing, expectedVersion: number, actorId: string | null) {
    return this.reply(() => this.timelines.saveLanding(next, expectedVersion, actorId));
  }
  /**
   * Every main advanced: in one transaction, fold the timeline's tracker view
   * into main (its issues done, their retained leases released) and record it
   * landed, before the Worker deletes its bookmarks.
   */
  completeLanding(access: Access, next: Landing, expectedVersion: number) {
    return this.reply(() =>
      this.transaction(() => {
        const timeline = this.timelines.get(next.slug);
        if (timeline.status === "abandoned" || timeline.status === "landed")
          return this.timelines.saveLanding(next, expectedVersion, access.actorId);
        this.store.landTimeline(access, next.slug);
        return this.timelines.saveLanding(
          { ...next, state: "landed" },
          expectedVersion,
          access.actorId,
        );
      }),
    );
  }

  // ---- retention (CORE-203; worker/tracker/retention.ts) ----------------------
  /** One batch of what a retention category selects at `now`, after `cursor`. */
  retentionSelect(
    category: TrackerCategory,
    thresholds: Record<string, number>,
    now: string,
    cursor: string | null,
    limit: number,
  ): TrackerSelection {
    const select = category === "closed-issues" ? selectClosedIssues : selectActivity;
    return select(this.ctx.storage.sql, thresholds, now, cursor, limit);
  }
  /** Remove those items, re-checking each against the policy, in one transaction. */
  retentionRemove(
    category: TrackerCategory,
    thresholds: Record<string, number>,
    now: string,
    items: string[],
  ): TrackerRemoval {
    const remove = category === "closed-issues" ? removeClosedIssues : removeActivity;
    return this.transaction(() =>
      remove(this.ctx.storage.sql, thresholds, now, items, new Date().toISOString()),
    );
  }

  // The purge contract (worker/durable/contract.ts, CORE-197). The tracker
  // holds nothing outside its own storage.
  async purge(reason: string): Promise<PurgeReport> {
    const report = await clearStorage(this.ctx.storage, reason);
    resetSoon(this.ctx);
    return report;
  }
  retire(reason: string, name: string, delayMs?: number): Promise<void> {
    return scheduleRetirement(this.ctx.storage, reason, name, delayMs);
  }
  storageReport() {
    return storageReport(this.ctx.storage);
  }
  override async alarm(): Promise<void> {
    const retirement = await pendingRetirement(this.ctx.storage);
    if (!retirement) return;
    await settleRetirement({
      storage: this.ctx.storage,
      env: this.env,
      className: "Tracker",
      retirement,
      busy: false,
      purge: (reason) => clearStorage(this.ctx.storage, reason),
    });
  }
}
