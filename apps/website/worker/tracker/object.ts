import { DurableObject } from "cloudflare:workers";
import { TrackerError, TrackerStore, type Access } from "./store.ts";
import {
  type TimelineStore,
  type LandingRequest,
  type NewCheckpoint,
  type NewTimeline,
  type PushActivity,
} from "./timelines.ts";
import type { MutationRequest } from "../../shared/tracker.ts";
import type { ChronicleOptions } from "./chronicle.ts";
import { runChronicleFixture, type ChronicleFixtureOptions } from "./chronicle-fixture.ts";
import type { QueueFailure } from "../../shared/merge-queue.ts";
import type { SearchQuery } from "../search/query.ts";
import type { Landing, TimelineStatus } from "../../shared/timelines.ts";
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
      status: 400 | 401 | 403 | 404 | 409 | 410 | 413;
      error: string;
      code: string;
      details: TrackerError["details"];
    };
export class Tracker extends DurableObject<Env> implements Purgeable {
  private store: TrackerStore;
  private timelines: TimelineStore;
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
  retire(reason: string, name: string): Promise<void> {
    return scheduleRetirement(this.ctx.storage, reason, name);
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
