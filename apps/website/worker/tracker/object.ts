import { DurableObject } from "cloudflare:workers";
import { TrackerError, TrackerStore, type Access } from "./store.ts";
import type { MutationRequest } from "../../shared/tracker.ts";

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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new TrackerStore(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
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
  snapshot(access: Access) {
    return this.reply(() => this.store.snapshot(access));
  }
  changes(after: number, limit: number) {
    return this.reply(() => this.store.changes(after, limit));
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
  issuesByKey(keys: string[]) {
    return this.reply(() => this.store.issuesByKey(keys));
  }
  completedBetween(since: string, until: string, limit: number) {
    return this.reply(() => this.store.completedBetween(since, until, limit));
  }
  mutate(access: Access, input: MutationRequest) {
    return this.reply(() => this.store.mutate(access, input));
  }
}
