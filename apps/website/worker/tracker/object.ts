import {
  assertTrackerSpaceOpen,
  convertTrackerSpaceJson,
  initializeFreshTrackerSpace,
  TrackerSpaceMigration,
} from "./space-migration.ts";
import { initializeLegacyTrackerForMigration } from "./legacy-initializer.ts";
import type { LegacySourceFixtureInput, LegacyTimeline } from "./legacy-source-fixture.ts";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { accessFor } from "./access.ts";
import { findSpaceById, resolveSpaceAccess } from "../spaces/access.ts";
import { isActorCredentialLive } from "../auth.ts";
import { resolveWorkAuthority, WorkAuthorizationError } from "../ci/admission.ts";
import { visibleRepos, type Actor } from "../db.ts";
import type {
  SpaceMigrationContext,
  SpaceParticipantOperation,
} from "../../shared/space-cutover.ts";
import { DurableObject } from "cloudflare:workers";
import {
  cachedAdmission,
  cutoverControl,
  withCutoverAlarmAdmission,
  withSteadyAdmission,
} from "../durable/cutover-admission.ts";
import { reportCutoverRuntime } from "../durable/cutover-runtime.ts";
import { forgetUpstreamTokens, isArtifactsError } from "../artifacts.ts";
import { UPSTREAM_TIMEOUT_MS, withTimeout } from "../retry.ts";
import { TrackerError, TrackerStore, type Access } from "./store.ts";
import { SUBSCRIBED_PROJECTS_BATCH } from "./stub.ts";
import {
  type TimelineStore,
  type LandingRequest,
  type NewCheckpoint,
  type NewTimeline,
  type PushActivity,
  type SourcePush,
  type SourcePushRecovery,
} from "./timelines.ts";
import type { MutationRequest, TrackerScope } from "../../shared/tracker.ts";
import type { ChronicleOptions } from "./chronicle.ts";
import { runChronicleFixture, type ChronicleFixtureOptions } from "./chronicle-fixture.ts";
import type { QueueFailure } from "../../shared/merge-queue.ts";
import type { SearchQuery } from "../search/query.ts";
import type { Landing, TimelineStatus } from "../../shared/timelines.ts";
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
function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") throw result.reason;
  return result.value;
}

export class Tracker extends DurableObject<Env> implements Purgeable {
  private activeStore: TrackerStore | undefined;
  get #store(): TrackerStore {
    assertTrackerSpaceOpen(this.ctx.storage.sql);
    return (this.activeStore ??= new TrackerStore(this.ctx.storage.sql, this.transaction));
  }
  get #timelines(): TimelineStore {
    return this.#store.timelines;
  }
  private sourceInitializers = new Map<string, Promise<InitializedWorkSource>>();
  /** The scope this instance last initialized or confirmed, for #initialized. */
  #scope: Readonly<TrackerScope> | undefined;
  /**
   * initializeFreshTrackerSpace for an authorized call (reply with a Space):
   * once this instance has confirmed its scope under the current admission
   * epoch, it skips the controller's Space read and the schema scan. Every
   * such call then re-resolves the caller's grant (#authorize, accessFor),
   * whose query admits only a Space that isn't archived. Retention and other
   * unauthorized callers keep the full check.
   */
  async #initialized(spaceId: string): Promise<Readonly<TrackerScope>> {
    const known = this.#scope;
    if (known?.spaceId === spaceId) {
      const admission = await cachedAdmission(this.env);
      try {
        const scope = assertTrackerSpaceOpen(this.ctx.storage.sql);
        if (
          admission.allowed &&
          known.migrationEpoch === admission.epoch &&
          scope.spaceId === spaceId &&
          scope.migrationEpoch === admission.epoch
        )
          return scope;
      } catch {
        // Purged or never converted: initialize from scratch below.
      }
      this.#scope = undefined;
    }
    const scope = await initializeFreshTrackerSpace(this.env, this.ctx, spaceId);
    this.#scope = scope;
    return scope;
  }
  private transaction: <T>(fn: () => T) => T;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const transaction = <T>(fn: () => T) => ctx.storage.transactionSync(fn);
    this.transaction = transaction;
    // Do not initialize legacy tables on a transformed object's cold wake.
  }
  cutoverRuntime(runId: string) {
    return reportCutoverRuntime(this.env, runId, "tracker");
  }
  private async migration(context: SpaceMigrationContext, operation: SpaceParticipantOperation) {
    const mapping = await cutoverControl(this.env).assertParticipant(context, operation);
    if (!this.ctx.id.equals(this.env.TRACKER.idFromName(context.legacyOwnerId)))
      throw new Error("space_migration_fenced: Tracker DO identity mismatch");
    // Records may still name this owner's own repositories deleted since: those
    // references move with the owner's Space too (CORE-341: a smoke-test repo).
    // An unreadable deletion log allows none: stricter, never looser.
    const deleted = await this.env.DB.prepare(
      "SELECT repo_id FROM repo_deletions WHERE owner_id=? AND phase='done'",
    )
      .bind(context.legacyOwnerId)
      .all<{ repo_id: string }>()
      .catch(() => ({ results: [] as { repo_id: string }[] }));
    return new TrackerSpaceMigration(
      this.ctx.storage.sql,
      this.transaction,
      context.legacyOwnerId,
      [
        ...mapping.repositories.map((repo) => repo.id),
        ...deleted.results.map((row) => row.repo_id),
      ],
    );
  }
  async spaceMigrationInventory(context: SpaceMigrationContext) {
    if (await pendingRetirement(this.ctx.storage))
      throw new Error(
        "space_migration_fenced: Cancel pending Tracker retirement before checkpointing",
      );
    const migration = await this.migration(context, "inventory");
    // Initialize a genuinely empty legacy object before capturing its complete schema.
    if (
      !this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='teams'").toArray()
        .length
    )
      initializeLegacyTrackerForMigration(this.ctx.storage.sql, this.transaction);
    return migration.inventory(context);
  }
  async spaceMigrationExport(context: SpaceMigrationContext, cursor: string | null) {
    return (await this.migration(context, "export")).export(context, cursor);
  }
  async spaceMigrationMigrate(context: SpaceMigrationContext) {
    return (await this.migration(context, "migrate")).migrate(context);
  }
  async spaceMigrationReconcile(context: SpaceMigrationContext) {
    return (await this.migration(context, "reconcile")).reconcile(context);
  }
  async spaceMigrationRestore(context: SpaceMigrationContext) {
    const migration = await this.migration(context, "restore");
    if (
      !this.ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='teams'").toArray()
        .length
    )
      initializeLegacyTrackerForMigration(this.ctx.storage.sql, this.transaction);
    return migration.restore(context);
  }
  async spaceMigrationReleaseLegacy(context: SpaceMigrationContext) {
    return (await this.migration(context, "release-legacy")).releaseLegacy(context);
  }
  async spaceMigrationReconcileOperation(
    context: SpaceMigrationContext,
    input: { operationId: string; actorId: string; originalRequest: unknown },
  ) {
    return (await this.migration(context, "reconcile")).reconcileOperation(context, input);
  }
  /** Re-resolve `access` against current Space grants and credentials. */
  async #authorize(access: Access, write = false): Promise<Access> {
    if (!access || access.contractVersion !== 4)
      throw new TrackerError(
        409,
        "client_upgrade_required",
        "Tracker requires content contract version 4.",
      );
    if (
      access.spaceId !== access.space?.id ||
      !this.ctx.id.equals(this.env.TRACKER.idFromName(access.spaceId))
    )
      throw new TrackerError(403, "forbidden", "Tracker Space identity mismatch.");
    if (access.actorId !== (access.agentId ?? access.principalId))
      throw new TrackerError(403, "forbidden", "Tracker actor identity mismatch.");
    const actor: Actor = {
      id: access.principalId,
      slug: "",
      displayName: "",
      isSiteAdmin: false,
      ...(access.agentId ? { agent: { id: access.agentId, name: "" } } : {}),
      ...(access.credential ? { credential: access.credential } : {}),
    };
    // Independent reads run together; their failures still decide in this order:
    // the credential, the current grant and admission (accessFor), the epoch,
    // the authorization version, then the repository read. Members stay loaded:
    // approval automation needs every principal in them (store.ts eligibleApproval).
    const [live, resolved, visible] = await Promise.allSettled([
      isActorCredentialLive(this.env.DB, actor, write ? "write" : "read"),
      accessFor(
        this.env,
        access.space,
        access.principalId,
        access.agentId,
        true,
        access.credential,
      ),
      visibleRepos(this.env.DB, actor, access.spaceId),
    ]);
    if (!settledValue(live))
      throw new TrackerError(
        403,
        "forbidden",
        "Tracker credential is expired, revoked or insufficiently scoped.",
      );
    const current = settledValue(resolved);
    if (current.migrationEpoch !== access.migrationEpoch)
      throw new TrackerError(
        409,
        "migration_epoch_mismatch",
        "Refresh the Tracker snapshot before continuing.",
      );
    if (current.authorizationVersion !== access.authorizationVersion)
      throw new TrackerError(
        409,
        "authorization_changed",
        "Space grants changed; refresh before continuing.",
      );
    const repos = settledValue(visible);
    current.repos = repos
      .filter((repo) => repo.viewerRole === "admin")
      .map((repo) => ({
        id: repo.id,
        spaceId: repo.space.id,
        space: repo.space.slug,
        name: repo.name,
      }));
    current.writableRepoIds = repos
      .filter((repo) => repo.viewerRole === "admin" || repo.viewerRole === "write")
      .map((repo) => repo.id);
    current.source = access.source;
    if (access.deletedRepoIds?.length) {
      const ids: string[] = [];
      for (const id of access.deletedRepoIds) {
        const repo = await this.env.DB.prepare("SELECT space_id,deleted_at FROM repos WHERE id=?")
          .bind(id)
          .first<{ space_id: string; deleted_at: string | null }>();
        if (!repo || (repo.space_id === access.spaceId && repo.deleted_at !== null)) ids.push(id);
      }
      current.deletedRepoIds = ids;
    }
    return current;
  }
  #authorized<T>(
    access: Access,
    fn: (current: Access) => T | Promise<T>,
    write = false,
  ): Promise<TrackerReply<T>> {
    return this.reply(async () => fn(await this.#authorize(access, write)), access?.spaceId);
  }
  async #assertRepoScope(spaceId: string, repoId: string) {
    if (!spaceId || !this.ctx.id.equals(this.env.TRACKER.idFromName(spaceId)))
      throw new TrackerError(403, "forbidden", "Tracker physical Space identity mismatch.");
    const repo = await this.env.DB.prepare("SELECT space_id FROM repos WHERE id=?")
      .bind(repoId)
      .first<{ space_id: string }>();
    if (!repo || repo.space_id !== spaceId)
      throw new TrackerError(403, "forbidden", "Repository is outside this Tracker Space.");
  }
  timelineLifecycle(input: { spaceId: string; repoId: string; timelineSlug: string }) {
    return this.reply(async () => {
      await this.#assertRepoScope(input.spaceId, input.repoId);
      const timeline = this.#timelines.list().find((entry) => entry.slug === input.timelineSlug);
      if (!timeline) return null;
      if (!timeline.repos.some((repo) => repo.id === input.repoId))
        throw new TrackerError(
          403,
          "forbidden",
          "Timeline does not own this repository lifecycle.",
        );
      return { status: timeline.status };
    });
  }
  sourcePushesForSettlement(input: { spaceId: string; repoId: string }) {
    return this.reply(async () => {
      await this.#assertRepoScope(input.spaceId, input.repoId);
      return this.#timelines.sourcePushes(input.repoId);
    });
  }
  sourcePushForSettlement(input: {
    spaceId: string;
    repoId: string;
    sourceId: string;
    operationId: string;
  }) {
    return this.reply(async () => {
      await this.#assertRepoScope(input.spaceId, input.repoId);
      return this.#timelines.sourcePush(input.operationId, input.repoId, input.sourceId);
    });
  }
  landingForSettlement(input: { spaceId: string; landingId: string; slug: string }) {
    return this.reply(async () => {
      const landing = this.#timelines.landing(input.slug);
      if (!landing) return null;
      if (
        landing.id !== input.landingId ||
        assertTrackerSpaceOpen(this.ctx.storage.sql).spaceId !== input.spaceId ||
        (landing.authority && landing.authority.spaceId !== input.spaceId)
      )
        throw new TrackerError(403, "forbidden", "Landing settlement identity mismatch.");
      for (const repo of landing.repos) await this.#assertRepoScope(input.spaceId, repo.id);
      return landing;
    });
  }
  landingForRunForSettlement(input: { spaceId: string; slug: string; runId: string }) {
    return this.reply(async () => {
      const run = await this.env.DB.prepare("SELECT repo_id,space_id FROM ci_runs WHERE id=?")
        .bind(input.runId)
        .first<{ repo_id: string; space_id: string }>();
      if (!run || run.space_id !== input.spaceId)
        throw new TrackerError(403, "forbidden", "Landing run settlement Space mismatch.");
      await this.#assertRepoScope(input.spaceId, run.repo_id);
      const landing = this.#timelines.landingForRun(input.slug, input.runId);
      if (landing && !landing.repos.some((repo) => repo.id === run.repo_id))
        throw new TrackerError(403, "forbidden", "Landing run belongs to another repository.");
      return landing;
    });
  }
  private reply<T>(fn: () => T | Promise<T>, spaceId?: string): Promise<TrackerReply<T>> {
    return withSteadyAdmission(this.env, "tracker", async (): Promise<TrackerReply<T>> => {
      try {
        if (spaceId) {
          if (!this.env.TRACKER.idFromName(spaceId).equals(this.ctx.id))
            throw new TrackerError(403, "forbidden", "Tracker physical Space identity mismatch.");
          await this.#initialized(spaceId);
        }
        assertTrackerSpaceOpen(this.ctx.storage.sql);
        return { ok: true, value: await fn() };
      } catch (error) {
        if (error instanceof TrackerError)
          return {
            ok: false,
            status: error.status,
            error: error.message,
            code: error.code,
            details: error.details,
          };
        if (error instanceof WorkAuthorizationError)
          return {
            ok: false,
            status: 403,
            error: error.message,
            code: "work_authorization_revoked",
            details: {},
          };
        if (
          error instanceof Error &&
          (error.message === "migration_epoch_mismatch" || error.message === "space_cutover_fenced")
        )
          return {
            ok: false,
            status: 409,
            error: "Refresh after Space migration admission is restored.",
            code: error.message,
            details: {},
          };
        throw error;
      }
    });
  }
  /** Isolated agent harness only: preserve pre-cutover records without active write fallback. */
  seedLegacySourceFixture(
    agentId: string,
    input: LegacySourceFixtureInput,
    access: Access,
  ): Promise<TrackerReply<LegacyTimeline>> {
    return this.#authorized(access, (current) => {
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
        !current.canAdmin ||
        repos.some(
          (repo) =>
            repo.owner !== current.space.slug ||
            !current.repos.some((entry) => entry.id === repo.id),
        ) ||
        checkpoint?.repos.some((repo) => repo.owner !== current.space.slug) ||
        landing?.repos.some((repo) => repo.owner !== current.space.slug)
      )
        throw new TrackerError(
          403,
          "forbidden",
          "Legacy fixtures require current Space admin and repository access.",
        );
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
    return this.#authorized(access, (current) =>
      this.#store.snapshot(current, timeline, withTimelines),
    );
  }
  changes(access: Access, after: number, limit: number, withTimelines = false) {
    return this.#authorized(access, (current) =>
      this.#store.changes(current, after, limit, withTimelines),
    );
  }
  history(access: Access, issueId: string, before: number | null, limit: number) {
    return this.#authorized(access, (current) =>
      this.#store.history(current, issueId, before, limit),
    );
  }
  /** One page of the Chronicle (CORE-250). */
  chronicle(access: Access, options: ChronicleOptions) {
    return this.#authorized(access, (current) => this.#store.chronicle(current, options));
  }
  issueWork(access: Access, issue: string) {
    return this.#authorized(access, () => this.#store.issueWork(issue));
  }
  /**
   * DEVELOPMENT ONLY (POST /api/dev/chronicle, CORE-251): a synthetic history
   * made of real mutations, applied in time order under a controlled clock.
   */
  chronicleFixture(people: Access[], agents: Access[], options: ChronicleFixtureOptions) {
    return withSteadyAdmission(this.env, "tracker", async () => {
      if (Reflect.get(this.env, "DEV_MODE") !== "true")
        throw new Error("The Chronicle fixture is for development only.");
      if (!people.length)
        throw new TrackerError(
          400,
          "invalid_input",
          "Chronicle fixture requires authenticated people.",
        );
      const currentPeople = await Promise.all(
        people.map((access) => this.#authorize(access, true)),
      );
      const currentAgents = await Promise.all(
        agents.map((access) => this.#authorize(access, true)),
      );
      await initializeFreshTrackerSpace(this.env, this.ctx, currentPeople[0]!.spaceId);
      let clock = Date.now();
      const store = new TrackerStore(this.ctx.storage.sql, this.transaction, () => clock);
      return runChronicleFixture(
        (access, at, request) => {
          clock = at;
          return store.mutate(access, request);
        },
        currentPeople,
        currentAgents,
        options,
      );
    });
  }
  openRequests(access: Access) {
    return this.#authorized(access, () => this.#store.openRequests());
  }
  /** Requests for Needs you with their work's context (CORE-386, CORE-387). */
  neededRequests(
    access: Access,
    filter: { open: true } | { open: false; before: string | null; limit: number },
  ) {
    return this.#authorized(access, () => this.#store.neededRequests(filter));
  }
  /** Finished work credited to a person's agents (CORE-220). */
  completedWork(
    access: Access,
    filter: { since: string; accountableId: string; actorIds: string[] | null },
  ) {
    return this.#authorized(access, () => this.#store.completedWork(filter));
  }
  /** The tag catalog with usage counts (CORE-271). */
  tagCatalog(access: Access) {
    return this.#authorized(access, () => this.#store.tagCatalog());
  }
  teamDirectory(access: Access) {
    return this.#authorized(access, () => this.#store.teamDirectory());
  }
  repoReadySummary(access: Access, repoId: string, timeline?: string) {
    return this.#authorized(access, () => this.#store.repoReadySummary(repoId, timeline));
  }
  subscribedProjects(access: Access, repoId: string) {
    return this.#authorized(access, () => this.#store.subscribedProjects(repoId));
  }
  /**
   * subscribedProjects for several repositories under one authorization, by
   * repository id. Callers fall back to subscribedProjects, unchanged, while an
   * object still runs the previous release (durable/rpc-compat.ts), until a
   * later release removes that fallback (expand, then contract).
   */
  subscribedProjectsFor(access: Access, repoIds: string[]) {
    return this.#authorized(access, () => {
      if (repoIds.length > SUBSCRIBED_PROJECTS_BATCH)
        throw new TrackerError(
          400,
          "invalid_input",
          `Ask for at most ${SUBSCRIBED_PROJECTS_BATCH} repositories at once.`,
        );
      const projects: Record<string, { projectId: string; slug: string; name: string }[]> = {};
      for (const repoId of repoIds) projects[repoId] = this.#store.subscribedProjects(repoId);
      return projects;
    });
  }
  completionEvidence(access: Access, repoId: string, query: SearchQuery, limit = 30) {
    return this.#authorized(access, () => this.#store.completionEvidence(repoId, query, limit));
  }
  subscriptionRepoIds(access: Access, subscriptionIds: string[]) {
    return this.#authorized(access, () => this.#store.subscriptionRepoIds(subscriptionIds));
  }
  projectSlugs(access: Access) {
    return this.#authorized(access, () => this.#store.projectSlugs());
  }
  teamNames(access: Access) {
    return this.#authorized(access, () => this.#store.teamNames());
  }
  searchIssues(access: Access, query: SearchQuery, limit: number) {
    return this.#authorized(access, () => this.#store.searchIssues(query, limit));
  }
  issueRefs(access: Access, refs: string[]) {
    return this.#authorized(access, () => this.#store.issueRefs(refs));
  }
  issuesByKey(access: Access, keys: string[]) {
    return this.#authorized(access, () => this.#store.issuesByKey(keys));
  }
  completedBetween(access: Access, since: string, until: string, limit: number) {
    return this.#authorized(access, () => this.#store.completedBetween(since, until, limit));
  }
  mutate(access: Access, input: MutationRequest) {
    return this.#authorized(access, (current) => this.#store.mutate(current, input), true);
  }
  recoverOperations(access: Access, operations: unknown[]) {
    return this.#authorized(access, (current) => {
      if (!Array.isArray(operations) || operations.length > 100)
        throw new TrackerError(
          400,
          "invalid_input",
          "Recover at most 100 ordered operations per request.",
        );
      const seen = new Set<string>();
      const results = operations.map((originalRequest) => {
        if (
          !originalRequest ||
          typeof originalRequest !== "object" ||
          Array.isArray(originalRequest)
        )
          throw new TrackerError(400, "invalid_input", "Original operation request is required.");
        const operationId = Reflect.get(originalRequest, "operationId");
        if (typeof operationId !== "string" || !operationId || seen.has(operationId))
          throw new TrackerError(
            400,
            "invalid_input",
            "Original operation IDs must be unique and nonempty.",
          );
        seen.add(operationId);
        const proof = this.ctx.storage.sql
          .exec<{
            id: string;
            actor_id: string;
            request: string;
            result: string;
            source_epoch: number;
            request_digest: string | null;
            result_digest: string | null;
          }>("SELECT * FROM space_migration_receipt_proof WHERE id=?", operationId)
          .toArray()[0];
        if (!proof) return { state: "export_required" as const, operationId };
        if (
          proof.actor_id !== current.actorId ||
          !isDeepStrictEqual(JSON.parse(proof.request), originalRequest)
        )
          throw new TrackerError(
            409,
            "export_required",
            "Original operation actor or intent does not match retained evidence.",
          );
        if (
          proof.request_digest !== createHash("sha256").update(proof.request).digest("hex") ||
          proof.result_digest !== createHash("sha256").update(proof.result).digest("hex")
        )
          throw new TrackerError(
            409,
            "export_required",
            "Original operation proof is incomplete; export the original intent for reconciliation.",
          );
        let result: unknown;
        try {
          result = convertTrackerSpaceJson(JSON.parse(proof.result), current.spaceId);
        } catch {
          throw new TrackerError(
            409,
            "export_required",
            "The original committed result has an unsupported schema; export intent and proof for explicit reconciliation.",
          );
        }
        return {
          state: "committed" as const,
          operationId,
          actorId: proof.actor_id,
          sourceEpoch: proof.source_epoch,
          requestDigest: proof.request_digest,
          originalRequest: proof.request,
          originalResult: proof.result,
          result,
        };
      });
      return {
        contractVersion: 4 as const,
        spaceId: current.spaceId,
        migrationEpoch: current.migrationEpoch,
        operations: results,
      };
    });
  }
  validateQueueIssues(access: Access, issueIds: string[]) {
    return this.#authorized(access, (current) =>
      this.#store.validateQueueIssues(current, issueIds),
    );
  }
  /**
   * Approve an open checkpoint approval on its person's approve-when-green
   * setting (CORE-378). `access` is that person's, built from the work
   * authority they turned it on with: its credential is checked live like any
   * other request. Null when it no longer applies.
   */
  autoApprove(access: Access, requestId: string, checkpointId: string) {
    return this.#authorized(
      access,
      (current) => this.#store.autoApprove(current, requestId, checkpointId),
      true,
    );
  }
  /** Why approve-when-green left an approval to its person (CORE-378). */
  noteAutoApproveSkipped(access: Access, requestId: string, checkpointId: string, reason: string) {
    return this.#authorized(
      access,
      (current) => this.#store.noteAutoApproveSkipped(current, requestId, checkpointId, reason),
      true,
    );
  }
  /** People with approve-when-green on in this tracker (CORE-378): ids only, no content. */
  approvingWhenGreen() {
    return this.reply(() => this.#store.approvingWhenGreen());
  }
  /**
   * The work authority a person's consent was given with (CORE-378,
   * CORE-390), for the Worker to re-resolve before acting; null without one.
   * Internal Worker RPC only: it names a credential id, never its secret.
   */
  workAuthority(key: string) {
    return this.reply(() => {
      if (!/^(automation|approval):[^:]+$/.test(key))
        throw new TrackerError(400, "invalid_input", "Unknown work authority key.");
      return this.#store.workAuthority(key);
    });
  }
  /**
   * Turn off approve-when-green whose consent can no longer act (CORE-378):
   * only after checking here that the person's Space grant is gone, their
   * credential is no longer live, or the migration epoch it was given in has
   * passed. It can only take the setting away. True when it did.
   */
  retireApprovalAutomation(input: { spaceId: string; personId: string }) {
    return this.reply(async () => {
      if (!input.spaceId || !this.ctx.id.equals(this.env.TRACKER.idFromName(input.spaceId)))
        throw new TrackerError(403, "forbidden", "Tracker physical Space identity mismatch.");
      const authority = this.#store.workAuthority(`automation:${input.personId}`);
      if (!authority) return false;
      const actor: Actor = {
        id: authority.personId,
        slug: "",
        displayName: "",
        isSiteAdmin: false,
        credential: authority.credential,
      };
      const admission = await cachedAdmission(this.env);
      let why: string | null = null;
      if (authority.personId !== input.personId || authority.spaceId !== input.spaceId)
        why = "its consent doesn't match this person";
      else if (!admission.allowed) return false;
      else if (authority.migrationEpoch !== admission.epoch)
        why = "the Space was migrated since it was turned on";
      else if (!(await resolveSpaceAccess(this.env.DB, actor, input.spaceId)))
        why = "no longer has access to this Space";
      else if (!(await isActorCredentialLive(this.env.DB, actor, "write")))
        why = "the credential it was turned on with is no longer valid";
      if (!why) return false;
      return this.#store.retireApprovalAutomation(input.personId, why);
    });
  }
  recordQueueFailure(
    access: Access,
    input: { repoId: string; issueIds: string[]; failure: QueueFailure },
  ) {
    return this.#authorized(
      access,
      (current) => this.#store.recordQueueFailure(current, input),
      true,
    );
  }
  listTimelines(access: Access, status?: TimelineStatus) {
    return this.#authorized(access, () => this.#timelines.list(status));
  }
  /** A timeline, its events, and its issues (CORE-74). */
  timeline(access: Access, slug: string, after: number, limit: number) {
    return this.#authorized(access, () => {
      const detail = this.#timelines.detail(slug, after, limit);
      const issues = this.#store.timelineIssues(detail.timeline.id)[detail.timeline.id] ?? [];
      return { ...detail, issues };
    });
  }
  /** The graph's timelines and events, and each timeline's issues. */
  timelineGraph(access: Access, limit: number) {
    return this.#authorized(access, () => ({
      ...this.#timelines.graph(limit),
      issues: this.#store.timelineIssues(),
    }));
  }
  timelineById(access: Access, timelineId: string) {
    return this.#authorized(access, () => this.#timelines.byId(timelineId));
  }
  reserveTimeline(access: Access, slug: string, parent: string | null, input: string) {
    return this.#authorized(
      access,
      (current) => this.#timelines.reserveTimeline(current, slug, parent, input),
      true,
    );
  }
  async cancelReservedCreation(access: Access, slug: string) {
    return withSteadyAdmission(this.env, "tracker", async () => {
      const claim = await this.#authorized(
        access,
        (current) => this.#timelines.cancelReservedCreation(current, slug),
        true,
      );
      if (!claim.ok) return claim;
      if (claim.value === null) return { ok: true as const, value: null };
      for (const allocation of claim.value) {
        const pending = this.sourceInitializers.get(
          `${allocation.timeline_id}:${allocation.repo_id}`,
        );
        if (pending) await pending.catch(() => undefined);
        let row = this.#timelines.getWorkSource(allocation.source_id);
        if (row.state === "creating") {
          // A restarted initializer may still have an outstanding remote fork.
          // Missing by name is not proof that its delayed creation cannot arrive.
          try {
            using provider = await withTimeout(
              this.env.ARTIFACTS.get(row.artifacts_name),
              UPSTREAM_TIMEOUT_MS,
            );
            await withTimeout(provider.info(), UPSTREAM_TIMEOUT_MS);
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
          row = this.#timelines.transitionWorkSource(row.source_id, row.version, "purging");
          await this.env.DB.prepare(
            "UPDATE timeline_work_sources SET state=?,version=?,updated_at=? WHERE source_id=? AND repo_id=? AND timeline_id=?",
          )
            .bind(
              row.state,
              row.version,
              row.updated_at,
              row.source_id,
              row.repo_id,
              row.timeline_id,
            )
            .run();
          forgetUpstreamTokens(row.artifacts_name);
          try {
            await this.env.ARTIFACTS.delete(row.artifacts_name);
          } catch (error) {
            if (!isArtifactsError(error, "NOT_FOUND")) throw error;
          }
          row = this.#timelines.transitionWorkSource(row.source_id, row.version, "purged");
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
    });
  }
  async initializeWorkSource(
    access: Access,
    repo: RepoRow,
    input: WorkSourceInput,
  ): Promise<TrackerReply<InitializedWorkSource>> {
    return withSteadyAdmission(
      this.env,
      "tracker",
      async (): Promise<TrackerReply<InitializedWorkSource>> => {
        const permitted = await this.#authorized(
          access,
          async (current) => {
            if (repo.space_id !== current.spaceId)
              throw new TrackerError(403, "forbidden", "Repository belongs to another Space.");
            await this.#assertRepoScope(current.spaceId, repo.id);
            if (!current.writableRepoIds?.includes(repo.id))
              throw new TrackerError(
                403,
                "forbidden",
                "Source creation requires current repository write access.",
              );
            this.#timelines.assertCreationOpen(input.timelineId);
          },
          true,
        );
        if (!permitted.ok) return permitted;
        const key = `${input.timelineId}:${repo.id}`;
        const existing = this.sourceInitializers.get(key);
        const pending = existing ?? initializeWorkSource(this.env, access, repo, input);
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
      },
    );
  }
  async reconcileDeletedSource(sourceId: string) {
    return withSteadyAdmission(this.env, "tracker", async () => {
      let row = this.#timelines.getWorkSource(sourceId);
      const pending = this.sourceInitializers.get(`${row.timeline_id}:${row.repo_id}`);
      if (pending) {
        try {
          await pending;
        } catch {
          /* Read the durable allocation after the initializer settled. */
        }
        row = this.#timelines.getWorkSource(sourceId);
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
        using provider = await withTimeout(
          this.env.ARTIFACTS.get(row.artifacts_name),
          UPSTREAM_TIMEOUT_MS,
        );
        await withTimeout(provider.info(), UPSTREAM_TIMEOUT_MS);
        row = this.#timelines.transitionWorkSource(sourceId, row.version, "failed");
        await this.env.DB.prepare(
          "UPDATE timeline_work_sources SET state=?,version=?,updated_at=? WHERE source_id=? AND state='creating'",
        )
          .bind(row.state, row.version, row.updated_at, row.source_id)
          .run();
      }
      return { ok: true as const, value: row };
    });
  }
  reserveWorkSource(
    access: Access,
    repo: { id: string; space_id: string },
    input: WorkSourceInput,
  ) {
    return this.#authorized(
      access,
      async (current) => {
        if (repo.space_id !== current.spaceId)
          throw new TrackerError(403, "forbidden", "Repository belongs to another Space.");
        await this.#assertRepoScope(current.spaceId, repo.id);
        if (
          !current.writableRepoIds?.includes(repo.id) ||
          !isDeepStrictEqual(input.authority, {
            spaceId: current.spaceId,
            migrationEpoch: current.migrationEpoch,
            personId: current.principalId,
            agentId: current.agentId,
            credential: current.credential,
          })
        )
          throw new TrackerError(
            403,
            "forbidden",
            "Source reservation requires exact current write authority.",
          );
        return this.#timelines.reserveWorkSource(repo, input);
      },
      true,
    );
  }
  getWorkSource(sourceId: string) {
    return this.reply(() => this.#timelines.getWorkSource(sourceId));
  }
  renameWorkSource(sourceId: string, version: number) {
    return this.reply(() => this.#timelines.renameWorkSource(sourceId, version));
  }
  async transitionWorkSource(
    sourceId: string,
    version: number,
    state: WorkSourceRow["state"],
    remote?: string,
  ) {
    return withSteadyAdmission(this.env, "tracker", async () => {
      const result = await this.reply(() =>
        this.#timelines.transitionWorkSource(sourceId, version, state, remote),
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
    });
  }
  /**
   * A work-source push is a repository write. The pusher's live credential and
   * current write right on that repository authorize it (an explicit repository
   * collaborator has them), never a Tracker grant; nothing here reads or
   * returns Tracker content to the pusher.
   */
  async beginSourcePush(input: SourcePush) {
    return withSteadyAdmission(this.env, "tracker", async () => {
      const authority = input.authority;
      const admitted = await this.reply(async () => {
        if (!authority) throw new TrackerError(403, "forbidden", "Source push authority mismatch.");
        await this.#assertRepoScope(authority.spaceId, input.repoId);
        await resolveWorkAuthority(this.env, authority, input.repoId);
        if (
          input.actorId !== (authority.agentId ?? authority.personId) ||
          input.accountableId !== authority.personId
        )
          throw new TrackerError(403, "forbidden", "Source push authority mismatch.");
        return this.#timelines.beginSourcePush(input, true);
      }, authority?.spaceId);
      if (!admitted.ok) return admitted;
      const now = new Date().toISOString();
      try {
        const projected = await this.env.DB.prepare(`INSERT INTO source_operations
        (id,space_id,timeline_id,repo_id,source_id,kind,state,data,created_at,updated_at)
        SELECT ?,space_id,?,?,?,'push','admitted',?,?,? FROM repos WHERE id=? AND deleted_at IS NULL
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
          this.#timelines.finishSourcePush(input.operationId, "rejected");
          return this.reply(() => {
            throw new TrackerError(409, "source_frozen", "Repository deletion fenced this push.");
          });
        }
        this.#timelines.activateSourcePush(input.operationId);
        return admitted;
      } catch (error) {
        const operation = this.#timelines.sourcePush(input.operationId);
        if (operation.state === "projecting")
          this.#timelines.finishSourcePush(input.operationId, "rejected");
        throw error;
      }
    });
  }
  async finishSourcePushForSettlement(
    scope: { spaceId: string; repoId: string; sourceId: string; operationId: string },
    outcome: "accepted" | "rejected" | "ambiguous",
  ) {
    const operationId = scope.operationId;
    return withSteadyAdmission(this.env, "tracker", async () => {
      await this.#assertRepoScope(scope.spaceId, scope.repoId);
      const stored = this.#timelines.sourcePush(operationId, scope.repoId, scope.sourceId);
      if (
        assertTrackerSpaceOpen(this.ctx.storage.sql).spaceId !== scope.spaceId ||
        (stored.authority && stored.authority.spaceId !== scope.spaceId)
      )
        throw new TrackerError(403, "forbidden", "Source push settlement Space mismatch.");
      const result = await this.reply(() =>
        this.#timelines.finishSourcePush(operationId, outcome, true),
      );
      if (result.ok) {
        const operation = this.#timelines.sourcePush(operationId);
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
          this.#timelines.projectSourcePush(operationId);
      }
      return result;
    });
  }
  reserveSourcePushDelivery(
    operationId: string,
    repoId: string,
    sourceId: string,
    runIds: Partial<Record<"push" | "step", string>>,
  ) {
    return this.reply(async () => {
      const operation = this.#timelines.sourcePush(operationId, repoId, sourceId);
      const scope = assertTrackerSpaceOpen(this.ctx.storage.sql);
      await this.#assertRepoScope(scope.spaceId, repoId);
      if (!operation.delivery) {
        const authority = operation.authority;
        if (
          !authority ||
          authority.spaceId !== scope.spaceId ||
          authority.migrationEpoch !== scope.migrationEpoch
        )
          throw new TrackerError(
            409,
            "migration_epoch_mismatch",
            "Legacy source delivery requires explicit reconciliation before creating new work.",
          );
        const space = await findSpaceById(this.env.DB, scope.spaceId);
        if (!space) throw new TrackerError(403, "forbidden", "Space is unavailable.");
        const access = await accessFor(
          this.env,
          space,
          authority.personId,
          authority.agentId,
          false,
          authority.credential,
        );
        const current = await this.#authorize(access, true);
        if (!current.writableRepoIds?.includes(repoId))
          throw new TrackerError(
            403,
            "forbidden",
            "Source delivery requires current repository write access.",
          );
      }
      return this.#timelines.reserveSourcePushDelivery(operationId, repoId, sourceId, runIds);
    });
  }
  completeSourcePushDelivery(
    operationId: string,
    trigger: "push" | "step",
    runId: string,
    result: { skipped: string } | { runId: string },
  ) {
    return this.reply(() =>
      this.#timelines.completeSourcePushDelivery(operationId, trigger, runId, result),
    );
  }
  beginSourcePushRecovery(
    access: Access,
    operationId: string,
    repoId: string,
    sourceId: string,
    intent: SourcePushRecovery,
  ) {
    return this.#authorized(
      access,
      async (current) => {
        await this.#assertRepoScope(current.spaceId, repoId);
        if (
          !intent.authority ||
          intent.authority.spaceId !== current.spaceId ||
          intent.authority.migrationEpoch !== current.migrationEpoch ||
          intent.authority.personId !== current.principalId ||
          intent.authority.agentId !== current.agentId ||
          !isDeepStrictEqual(intent.authority.credential, current.credential)
        )
          throw new TrackerError(403, "forbidden", "Source recovery authority mismatch.");
        return this.#timelines.beginSourcePushRecovery(operationId, repoId, sourceId, intent);
      },
      true,
    );
  }
  async settleSourcePushRecovery(
    operationId: string,
    outcome: "accepted" | "rejected",
    head: string,
  ) {
    return withSteadyAdmission(this.env, "tracker", async () => {
      const settled = await this.reply(() =>
        this.#timelines.settleSourcePushRecovery(operationId, outcome, head),
      );
      if (!settled.ok) return settled;
      // The authoritative terminal outcome is immutable, but still holds the
      // timeline fence until its D1 projection has succeeded. Replay repairs it.
      const operation = this.#timelines.sourcePush(operationId);
      const projected = await this.finishSourcePushForSettlement(
        {
          spaceId: assertTrackerSpaceOpen(this.ctx.storage.sql).spaceId,
          repoId: operation.repoId,
          sourceId: operation.sourceId,
          operationId,
        },
        outcome,
      );
      if (!projected.ok) return projected;
      return this.reply(() => this.#timelines.projectSourcePushRecovery(operationId));
    });
  }
  sourcePushes(access: Access, repoId?: string) {
    return this.#authorized(access, () => this.#timelines.sourcePushes(repoId));
  }
  sourcePush(access: Access, operationId: string, repoId: string, sourceId: string) {
    return this.#authorized(access, () =>
      this.#timelines.sourcePush(operationId, repoId, sourceId),
    );
  }
  async rejectUnprojectedSourcePush(operationId: string, repoId: string, sourceId: string) {
    return withSteadyAdmission(this.env, "tracker", async () => {
      const operation = this.#timelines.sourcePush(operationId, repoId, sourceId);
      if (operation.state !== "projecting") return { ok: true as const, value: false };
      const result = await this.finishSourcePushForSettlement(
        {
          spaceId: assertTrackerSpaceOpen(this.ctx.storage.sql).spaceId,
          repoId,
          sourceId,
          operationId,
        },
        "rejected",
      );
      return result.ok ? { ok: true as const, value: true } : result;
    });
  }
  resolveLegacyLanding(
    access: Access,
    timelineId: string,
    expectedVersion: number,
    action: "cancel-unadvanced" | "accept-partial-and-abandon",
    note: string,
  ) {
    return this.#authorized(
      access,
      (current) => {
        if (!current.canAdmin)
          throw new TrackerError(403, "forbidden", "Space administration is required.");
        return this.#timelines.resolveLegacyLanding(timelineId, expectedVersion, action, note);
      },
      true,
    );
  }
  beginLegacyMigration(access: Access, timelineId: string) {
    return this.#authorized(
      access,
      (current) => {
        if (!current.canAdmin)
          throw new TrackerError(403, "forbidden", "Space administration is required.");
        return this.#timelines.beginLegacyMigration(timelineId);
      },
      true,
    );
  }
  completeLegacyMigration(access: Access, timelineId: string, repos: TimelineRepo[]) {
    return this.#authorized(
      access,
      async (current) => {
        if (!current.canAdmin)
          throw new TrackerError(403, "forbidden", "Space administration is required.");
        for (const repo of repos) await this.#assertRepoScope(current.spaceId, repo.id);
        return this.#timelines.completeLegacyMigration(timelineId, repos);
      },
      true,
    );
  }
  prepareTimeline(access: Access, slug: string, parent: string | null) {
    return this.#authorized(access, () => this.#timelines.prepare(slug, parent), true);
  }
  createTimeline(access: Access, input: NewTimeline) {
    return this.#authorized(
      access,
      async (current) => {
        for (const repo of input.repos) {
          await this.#assertRepoScope(current.spaceId, repo.id);
          if (!current.writableRepoIds?.includes(repo.id))
            throw new TrackerError(
              403,
              "forbidden",
              "Timeline creation requires current repository write access.",
            );
        }
        return this.#timelines.create(current, input);
      },
      true,
    );
  }
  updateTimeline(
    access: Access,
    slug: string,
    data: Record<string, unknown>,
    expectedVersion?: unknown,
  ) {
    return this.#authorized(
      access,
      (current) => this.#timelines.update(slug, data, expectedVersion, current),
      true,
    );
  }
  mayAbandonTimeline(access: Access, slug: string) {
    return this.#authorized(access, (current) => this.#timelines.mayAbandon(current, slug), true);
  }
  /** Abandon it, and return the issues done in it to ready (CORE-74), together. */
  abandonTimeline(access: Access, slug: string, lastCommits: Record<string, string | null>) {
    return this.#authorized(
      access,
      (access) =>
        this.transaction(() => {
          const result = this.#timelines.abandon(access, slug, lastCommits);
          this.#store.timelineAbandoned(access, result.timeline);
          return result;
        }),
      true,
    );
  }
  /** A push's timeline activity; work done in a merged timeline is then done in the other. */
  recordTimelinePush(activity: PushActivity) {
    return this.reply(async () => {
      await this.#assertRepoScope(activity.repo.spaceId, activity.repo.id);
      return this.transaction(() =>
        this.#timelines.recordPush(activity, (merge) =>
          this.#store.timelineMerged(merge.fromId, merge.intoId, merge.id, activity.actorId),
        ),
      );
    });
  }
  checkpoints(access: Access, slug: string) {
    return this.#authorized(access, () => this.#timelines.checkpoints(slug));
  }
  checkpoint(access: Access, slug: string, ref: string) {
    return this.#authorized(access, () => this.#timelines.checkpoint(slug, ref));
  }
  checkpointStates(access: Access, ids: string[]) {
    return this.#authorized(access, () => this.#timelines.checkpointStates(ids));
  }
  createCheckpoint(access: Access, slug: string, input: NewCheckpoint) {
    return this.#authorized(
      access,
      async (current) => {
        for (const repo of input.repos) {
          await this.#assertRepoScope(current.spaceId, repo.id);
          if (!current.writableRepoIds?.includes(repo.id))
            throw new TrackerError(
              403,
              "forbidden",
              "Checkpoint creation requires current repository write access.",
            );
        }
        return this.#timelines.createCheckpoint(current, slug, input);
      },
      true,
    );
  }
  // ---- landing (CORE-77) -----------------------------------------------------
  landing(access: Access, slug: string) {
    return this.#authorized(access, () => this.#timelines.landing(slug));
  }
  landingForCommit(access: Access, repoId: string, commit: string) {
    return this.#authorized(access, () => this.#timelines.landingForCommit(repoId, commit));
  }
  landingForRun(access: Access, slug: string, runId: string) {
    return this.#authorized(access, () => this.#timelines.landingForRun(slug, runId));
  }
  activeLandings() {
    return this.reply(async () => {
      const landings = this.#timelines.activeLandings();
      for (const landing of landings)
        for (const repo of landing.repos)
          await this.#assertRepoScope(
            assertTrackerSpaceOpen(this.ctx.storage.sql).spaceId,
            repo.id,
          );
      return landings;
    });
  }
  /** Merging or testing landings last moved between `since` and `before` (CORE-391). */
  stalledLandings(since: string, before: string, limit: number) {
    return this.reply(() => this.#timelines.stalledLandings(since, before, limit));
  }
  /** Approved (since `since`), current heads that never began landing (CORE-390). */
  approvedUnlanded(limit: number, since: string) {
    return this.reply(() => this.#timelines.approvedUnlanded(limit, since));
  }
  /** A timeline's policy, head checkpoint state and whether it ever landed (CORE-390). */
  headCheckpoint(slug: string) {
    return this.reply(() => this.#timelines.headCheckpoint(slug));
  }
  beginLanding(access: Access, slug: string, request: LandingRequest) {
    return this.#authorized(
      access,
      async (current) => {
        if (
          !request.authority ||
          !isDeepStrictEqual(request.authority.credential, current.credential)
        )
          throw new TrackerError(403, "forbidden", "Landing initiating credential mismatch.");
        for (const repo of this.#timelines.get(slug).repos) {
          await this.#assertRepoScope(current.spaceId, repo.id);
          if (!current.writableRepoIds?.includes(repo.id))
            throw new TrackerError(
              403,
              "forbidden",
              "Landing requires current repository write access.",
            );
        }
        return this.#timelines.beginLanding(current, slug, request);
      },
      true,
    );
  }
  saveLanding(next: Landing, expectedVersion: number, actorId: string | null) {
    return this.reply(async () => {
      const current = this.#timelines.landing(next.slug);
      if (!current || current.id !== next.id)
        throw new TrackerError(
          409,
          "conflict",
          "Landing settlement requires an existing operation.",
        );
      for (const repo of current.repos)
        await this.#assertRepoScope(assertTrackerSpaceOpen(this.ctx.storage.sql).spaceId, repo.id);
      return this.#timelines.saveLanding(next, expectedVersion, actorId);
    });
  }
  /**
   * Every main advanced: in one transaction, fold the timeline's tracker view
   * into main (its issues done, their retained leases released) and record it
   * landed, before the Worker deletes its bookmarks.
   */
  completeLanding(access: Access, next: Landing, expectedVersion: number) {
    return this.#authorized(
      access,
      (access) =>
        this.transaction(() => {
          const timeline = this.#timelines.get(next.slug);
          if (timeline.status === "abandoned" || timeline.status === "landed")
            return this.#timelines.saveLanding(next, expectedVersion, access.actorId);
          this.#store.landTimeline(access, next.slug);
          return this.#timelines.saveLanding(
            { ...next, state: "landed" },
            expectedVersion,
            access.actorId,
          );
        }),
      true,
    );
  }
  completeLandingForSettlement(
    scope: { spaceId: string; landingId: string },
    next: Landing,
    expectedVersion: number,
  ) {
    return this.reply(async () => {
      const current = this.#timelines.landing(next.slug);
      if (!current || current.id !== scope.landingId || !current.repos.length)
        throw new TrackerError(
          409,
          "conflict",
          "Landing settlement requires its original persisted record.",
        );
      for (const repo of current.repos) {
        await this.#assertRepoScope(scope.spaceId, repo.id);
        const proof = await this.env.DB.prepare(`SELECT r.canonical_commit,r.status,s.space_id
          FROM source_integration_receipts r JOIN timeline_work_sources s ON s.source_id=r.source_id AND s.repo_id=r.repo_id
          WHERE r.landing_id=? AND r.checkpoint_id=? AND r.repo_id=? AND r.source_id=?`)
          .bind(current.id, current.checkpointId, repo.id, repo.source?.sourceId ?? "")
          .first<{ canonical_commit: string; status: string; space_id: string }>();
        if (
          !proof ||
          proof.space_id !== scope.spaceId ||
          proof.canonical_commit !== repo.merge ||
          !["integrated", "complete"].includes(proof.status)
        )
          throw new TrackerError(
            409,
            "conflict",
            "Landing settlement requires completed canonical integration receipts.",
          );
      }
      return this.transaction(() => {
        const result = this.#timelines.saveLandingForSettlement(scope, next, expectedVersion);
        const timeline = this.#timelines.get(next.slug);
        if (timeline.status !== "abandoned")
          this.#store.landTimeline(
            { actorId: current.requestedBy.actorId, members: [], agents: [], source: "api" },
            next.slug,
          );
        return result;
      });
    });
  }

  // ---- retention (CORE-203; worker/tracker/retention.ts) ----------------------
  /** One batch of what a retention category selects at `now`, after `cursor`. */
  retentionSelect(
    spaceId: string,
    category: TrackerCategory,
    thresholds: Record<string, number>,
    now: string,
    cursor: string | null,
    limit: number,
  ): Promise<TrackerSelection> {
    return withSteadyAdmission(this.env, "tracker", async () => {
      await initializeFreshTrackerSpace(this.env, this.ctx, spaceId);
      assertTrackerSpaceOpen(this.ctx.storage.sql);
      void this.#store;
      const select = category === "closed-issues" ? selectClosedIssues : selectActivity;
      return select(this.ctx.storage.sql, thresholds, now, cursor, limit);
    });
  }
  /** Remove those items, re-checking each against the policy, in one transaction. */
  retentionRemove(
    spaceId: string,
    category: TrackerCategory,
    thresholds: Record<string, number>,
    now: string,
    items: string[],
  ): Promise<TrackerRemoval> {
    return withSteadyAdmission(this.env, "tracker", async () => {
      await initializeFreshTrackerSpace(this.env, this.ctx, spaceId);
      assertTrackerSpaceOpen(this.ctx.storage.sql);
      void this.#store;
      const remove = category === "closed-issues" ? removeClosedIssues : removeActivity;
      return this.transaction(() =>
        remove(this.ctx.storage.sql, thresholds, now, items, new Date().toISOString()),
      );
    });
  }

  // The purge contract (worker/durable/contract.ts, CORE-197). The tracker
  // holds nothing outside its own storage.
  private assertLifecycleScope(): void {
    // Empty instances (including already purged ones) have no tenant data.
    // Every nonempty Tracker still needs its admitted, converted local scope.
    const nonempty = this.ctx.storage.sql
      .exec(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' AND name NOT GLOB '__miniflare_*' AND name <> 'sqlite_sequence' LIMIT 1",
      )
      .toArray().length;
    if (nonempty) assertTrackerSpaceOpen(this.ctx.storage.sql);
  }
  async purge(reason: string): Promise<PurgeReport> {
    const report = await withSteadyAdmission(this.env, "tracker", async () => {
      this.assertLifecycleScope();
      this.#scope = undefined;
      return clearStorage(this.ctx.storage, reason);
    });
    resetSoon(this.ctx);
    return report;
  }
  retire(reason: string, name: string, delayMs?: number): Promise<void> {
    return withSteadyAdmission(this.env, "tracker", async () => {
      this.assertLifecycleScope();
      return scheduleRetirement(this.ctx.storage, reason, name, delayMs);
    });
  }
  storageReport() {
    return withSteadyAdmission(this.env, "tracker", async () => {
      this.assertLifecycleScope();
      return storageReport(this.ctx.storage);
    });
  }
  override async alarm(): Promise<void> {
    return withCutoverAlarmAdmission(this.env, "tracker", this.ctx.storage, async () => {
      this.assertLifecycleScope();
      const retirement = await pendingRetirement(this.ctx.storage);
      if (!retirement) return;
      await settleRetirement({
        storage: this.ctx.storage,
        env: this.env,
        className: "Tracker",
        retirement,
        busy: false,
        purge: (reason) => {
          this.#scope = undefined;
          return clearStorage(this.ctx.storage, reason);
        },
      });
    });
  }
}
