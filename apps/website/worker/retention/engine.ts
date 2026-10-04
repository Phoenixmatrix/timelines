// The retention cleanup engine (CORE-198; PRD CORE-195, principles 3 to 5).
//
// A category's cleanup implements `CategoryCleanup` (below) and is registered
// in worker/retention/cleanups/index.ts under its id from categories.ts. The
// engine does the rest: runs, dry runs, batching, resuming and the audit
// record (`cleanup_runs`, `cleanup_run_categories`; worker/retention/runs.ts).
//
// The contract a cleanup keeps:
// - `select(ctx, cursor)` returns at most `ctx.limit` items the policy selects
//   after `cursor` (null: from the start), in a stable order, with `next` (the
//   cursor after the last item; null when nothing is left), a `count` of the
//   records they stand for (rows across tables; defaults to items.length) and
//   their estimated `bytes`. Compute every cutoff from `ctx.now` and
//   `ctx.thresholds`, never the clock: a run keeps the same `now` through every
//   batch and resume, so a dry run and a run at the same moment select the
//   same items.
// - Cursors are keyset positions (e.g. the last id), not offsets: deleting the
//   items of one batch must not shift the next one. They are stored between
//   batches, so keep them short strings.
// - `remove(ctx, items)` deletes those items, re-checking in the same
//   statement that each still matches the policy (a row that changed since
//   select is left alone), and returns what it actually removed. Removing
//   something already gone is not an error: runs repeat a batch after an
//   interruption, so removal must be idempotent.
// - Never select current state or anything a retained record refers to; say
//   what the category never deletes in its registry entry (`never`).
// - Do bounded work per call (one batch); the engine loops.
//
// A dry run calls only `select`, page after page; a run calls `select` then
// `remove` for each page. Both are recorded the same way.

import type { RetentionTarget } from "./policies.ts";

export interface CleanupContext {
  env: Env;
  /** Whose data: one account's (account categories) or the site's. */
  target: RetentionTarget;
  /** The category's effective thresholds for this run, every key present. */
  thresholds: Record<string, number>;
  /** The run's moment; derive every cutoff from it. */
  now: Date;
  /** The most items one `select` may return. */
  limit: number;
}

export interface Selection<Item> {
  items: Item[];
  /** Where the next batch starts; null when this is the last one. */
  next: string | null;
  /** Records these items stand for; items.length when omitted. */
  count?: number;
  /** Estimated bytes they take up. */
  bytes: number;
}

export interface Removal {
  /** Records actually removed. */
  count: number;
  /** Estimated bytes actually removed. */
  bytes: number;
}

export interface CategoryCleanup<Item = unknown> {
  select(ctx: CleanupContext, cursor: string | null): Promise<Selection<Item>>;
  remove(ctx: CleanupContext, items: Item[]): Promise<Removal>;
}

/** Days before `now`, as an ISO timestamp (the column format D1 stores). */
export function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}
