// Closed issues ("closed-issues") and tracker activity logs with ended
// timelines ("tracker-activity"), CORE-203: their data lives in each
// account's Tracker Durable Object, which selects and removes it itself
// (worker/tracker/retention.ts) in bounded batches; these adapters drive it
// through RPC. The run's moment travels with every call, so a dry run and a
// run select the same items.

import type { CategoryCleanup, CleanupContext } from "../engine.ts";
import { trackerObject } from "../../tracker/stub.ts";
import type { TrackerCategory } from "../../tracker/retention.ts";

function tracker(ctx: CleanupContext, id: TrackerCategory) {
  if (ctx.target.scope !== "account") throw new Error(`${id} is an account category.`);
  return trackerObject(ctx.env, ctx.target.accountId);
}

function trackerCleanup(id: TrackerCategory): CategoryCleanup<string> {
  return {
    async select(ctx, cursor) {
      return tracker(ctx, id).retentionSelect(
        id,
        ctx.thresholds,
        ctx.now.toISOString(),
        cursor,
        ctx.limit,
      );
    },
    async remove(ctx, items) {
      return tracker(ctx, id).retentionRemove(id, ctx.thresholds, ctx.now.toISOString(), items);
    },
  };
}

export const closedIssues = trackerCleanup("closed-issues");
export const trackerActivity = trackerCleanup("tracker-activity");
