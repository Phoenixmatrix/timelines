import { DurableObject } from "cloudflare:workers";
import { TrackerError, TrackerStore, type Access } from "./store.ts";
import { TimelineStore, type NewTimeline, type PushActivity } from "./timelines.ts";
import type { MutationRequest } from "../../shared/tracker.ts";
import type { SearchQuery } from "../search/query.ts";
import type { TimelineStatus } from "../../shared/timelines.ts";

export type TrackerReply<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      status: 400 | 401 | 403 | 404 | 409 | 413;
      error: string;
      code: string;
      details: TrackerError["details"];
    };
export class Tracker extends DurableObject<Env> {
  private store: TrackerStore;
  private timelines: TimelineStore;
  private transaction: <T>(fn: () => T) => T;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const transaction = <T>(fn: () => T) => ctx.storage.transactionSync(fn);
    this.transaction = transaction;
    this.store = new TrackerStore(ctx.storage.sql, transaction);
    this.timelines = new TimelineStore(ctx.storage.sql, transaction);
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
  openRequests() {
    return this.reply(() => this.store.openRequests());
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
  issuesByKey(keys: string[]) {
    return this.reply(() => this.store.issuesByKey(keys));
  }
  completedBetween(since: string, until: string, limit: number) {
    return this.reply(() => this.store.completedBetween(since, until, limit));
  }
  mutate(access: Access, input: MutationRequest) {
    return this.reply(() => this.store.mutate(access, input));
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
}
