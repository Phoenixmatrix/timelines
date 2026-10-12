// Who finished each issue (CORE-220): the tracker stamps `completion` as an
// issue becomes done. Issues finished before that are credited from the event
// log here, once, in bounded batches across Durable Object starts.

import {
  completionBy,
  hasActiveClaim,
  isFinished,
  type Issue,
  type IssueCompletion,
  type TrackerEvent,
} from "../../shared/tracker.ts";
import { all, first, json, run, tracker, type SqlDatabase } from "./sql.ts";
import { sql as raw, type RawBuilder } from "kysely";

const MIGRATION = "completion-v1";
/**
 * Issues looked at per Durable Object start, newest finished first, so recent
 * work is credited soonest. The backfill runs in the constructor, where an
 * overrun of CPU or memory can't be caught and would roll back and repeat on
 * every start, so each start does a small, bounded share.
 */
export const BACKFILL_ISSUES = 100;
/**
 * Events parsed per start, across all its issues: the real cost. A start
 * stops taking issues once this is spent; the first issue may finish its own
 * scan (up to EVENTS_PER_ISSUE) so every start makes progress.
 */
export const BACKFILL_EVENTS = 5_000;
/** Events read per issue, newest first, before it's left uncredited. */
export const EVENTS_PER_ISSUE = 500;
/** Events read per query while scanning one issue's history. */
const EVENT_PAGE = 50;

/**
 * The credit one event gives when it is an issue's finish: it made the issue
 * done (or done in a timeline), and the credit goes to the claim it completed
 * or held, else the actor. A landing never counts: what landed was finished
 * in its timeline, earlier in the log. Undefined for any other event.
 */
export function finishCredit(event: TrackerEvent): IssueCompletion | undefined {
  if (event.kind === "timeline.land") return undefined;
  // Main's change, or the timeline's for an issue only timelines had then.
  const change = event.entity ? { before: event.before, entity: event.entity } : event.view;
  const before = (change?.before ?? null) as Issue | null;
  const after = (change?.entity ?? null) as Issue | null;
  if (!after || !isFinished(after.status) || isFinished(before?.status)) return undefined;
  const claim =
    before?.claim && (event.kind === "issue.complete" || hasActiveClaim(before, event.createdAt))
      ? before.claim
      : null;
  const actor = event.actor;
  const agents =
    actor?.kind === "agent" && actor.accountable
      ? [{ id: actor.id, accountable: actor.accountable }]
      : [];
  return completionBy(claim, { id: event.actorId, accountableId: null }, agents, event.createdAt);
}

/** The credit an issue's history (newest first) gives its latest finish; null when there's none. */
export function completionFromHistory(events: TrackerEvent[]): IssueCompletion | null {
  for (const event of events) {
    const credit = finishCredit(event);
    if (credit) return credit;
  }
  return null;
}

/**
 * Credit done issues finished before completions were stamped. Each start
 * takes at most `issues` issues and parses at most about `events` events.
 * What history can't credit gets an explicit null, so no start sees the same
 * issue twice; an issue left when the budget runs out is taken next start.
 * The migration ends once a start gets through a short batch. Returns how
 * many issues it credited or marked unknown.
 */
export function backfillCompletions(
  sql: SqlDatabase,
  transaction: <T>(fn: () => T) => T,
  budget: { issues?: number; events?: number } = {},
): number {
  const issues = budget.issues ?? BACKFILL_ISSUES;
  let events = budget.events ?? BACKFILL_EVENTS;
  if (
    first(
      sql,
      tracker.selectFrom("tracker_migrations").select("name").where("name", "=", MIGRATION),
    )
  )
    return 0;
  return transaction(() => {
    const rows = all(
      sql,
      tracker
        .selectFrom("issues")
        .select(["id", "data"])
        .where(json("data", "$.status"), "in", ["done", "done_in_timeline"])
        // Absent, not null: null is a verdict already given.
        .where(raw<string | null>`json_type(data, '$.completion')`, "is", null)
        .orderBy(json("data", "$.updatedAt"), "desc")
        .limit(issues + 1),
    );
    let done = 0;
    let stopped = false;
    for (const row of rows.slice(0, issues)) {
      if (events <= 0) {
        stopped = true;
        break;
      }
      const set = (data: string | RawBuilder<string>) =>
        run(sql, tracker.updateTable("issues").set({ data }).where("id", "=", row.id));
      try {
        // Newest first, a page at a time, until the finish turns up.
        let credit: IssueCompletion | undefined;
        let read = 0;
        let before = Number.MAX_SAFE_INTEGER;
        // Whether the scan reached a verdict: found it, ran out of history, or hit the cap.
        let settled = false;
        while (!settled) {
          // Only the first issue of a start may go past the start's budget.
          if (events <= 0 && done > 0) break;
          const page = all(
            sql,
            tracker
              .selectFrom("events")
              .select(["cursor", "data"])
              .where(json("data", "$.entityType"), "=", "issue")
              .where(json("data", "$.entityId"), "=", row.id)
              .where("cursor", "<", before)
              .orderBy("cursor", "desc")
              .limit(Math.min(EVENT_PAGE, EVENTS_PER_ISSUE - read)),
          );
          read += page.length;
          events -= page.length;
          for (const event of page) {
            credit = finishCredit(JSON.parse(event.data) as TrackerEvent);
            if (credit) break;
          }
          settled = !!credit || page.length < EVENT_PAGE || read >= EVENTS_PER_ISSUE;
          before = page[page.length - 1]?.cursor ?? before;
        }
        if (!settled) {
          // Out of budget partway through: this one waits for the next start.
          stopped = true;
          break;
        }
        const issue = JSON.parse(row.data) as Issue;
        issue.completion = credit ?? null;
        set(JSON.stringify(issue));
      } catch (error) {
        // One unreadable record leaves that issue uncredited, never the tracker unable to start.
        console.warn(`completion backfill: issue ${row.id} left uncredited`, error);
        set(raw<string>`json_set(data, '$.completion', json('null'))`);
      }
      done++;
    }
    if (!stopped && rows.length <= issues)
      run(sql, tracker.insertInto("tracker_migrations").values({ name: MIGRATION }));
    return done;
  });
}
