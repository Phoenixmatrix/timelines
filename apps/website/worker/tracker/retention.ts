// Retention inside the Tracker Durable Object (CORE-203; PRD CORE-195).
//
// Two account categories (worker/retention/categories.ts) whose data lives
// here, driven by the cleanup engine through the Tracker's RPC methods
// `retentionSelect` and `retentionRemove` (worker/retention/cleanups/tracker.ts):
//
// - "closed-issues" (`days`): issues done or canceled with no activity for
//   `days` (their last change, comment, link or request), removed with their
//   comments, links, requests, events, history index rows, leases, offers and
//   the receipts that mention them. Never an open issue, one with a lease,
//   an offer or an open request, one done in an unlanded timeline, one any
//   timeline still on record changed, or one linked to or parent or child of
//   an issue that stays (a component of linked issues goes together or not
//   at all).
// - "tracker-activity" (`eventDays`, `endedTimelineDays`), in three phases,
//   each finished before the next starts so a dry run and a run select the
//   same things: activity log entries (`events`) older than `eventDays`, then
//   mutation receipts older than that, then timelines landed or abandoned
//   `endedTimelineDays` ago with their checkpoints, landings, heads and the
//   timeline events no remaining timeline lists. Never an event in an open
//   issue's history, an open request's, one of a timeline still on record,
//   or the newest event of anything that still exists (views and release
//   notes read it); never an open timeline, one a remaining timeline forked
//   from or merged in, or one an issue or request still points to.
//
// What is removed leaves a tombstone (`retention_removed`): an issue's key or
// a timeline's slug answers 404 "removed by retention" and is never reused
// (issue numbers come from `team_numbers`, which never goes back). Each
// removed entity is logged as a `retention.remove` event with no entity, so
// replicas (gm, `changes`) drop it like any deletion. Pruning the activity
// log raises the feed's floor: a replica whose cursor is below it gets 410
// and fetches a fresh snapshot.
//
// A dry run counts each category against the data as it is: run alone, a
// category removes exactly what its dry run listed. Together in one run,
// "closed-issues" goes first and takes events "tracker-activity" also lists.
//
// Items are short strings: issue ids for "closed-issues"; `e:<cursor>`,
// `r:<operationId>` and `t:<timelineId>` for "tracker-activity". Cursors are
// the last item. Every cutoff comes from the run's `now`.

import type { SqlDatabase } from "./sql.ts";

export const TRACKER_CATEGORIES = ["closed-issues", "tracker-activity"] as const;
export type TrackerCategory = (typeof TRACKER_CATEGORIES)[number];

export interface TrackerSelection {
  items: string[];
  next: string | null;
  count: number;
  bytes: number;
}
export interface TrackerRemoval {
  count: number;
  bytes: number;
}

/** A removed issue or timeline, as a 404 explains it. */
export interface Tombstone {
  id: string;
  kind: "issue" | "timeline";
  /** The issue's key or the timeline's slug. */
  ref: string;
  reason: string;
  removedAt: string;
}

export const RETENTION_TABLES = `CREATE TABLE IF NOT EXISTS retention_removed (id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, reason TEXT NOT NULL, removed_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS retention_removed_refs ON retention_removed(kind, ref);
  CREATE TABLE IF NOT EXISTS retention_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);`;

/** Per-row allowance (key, row header, index entries) on top of the stored text. */
const ROW = 64;
const DAY = 86_400_000;

function rows<T>(sql: SqlDatabase, query: string, ...bindings: SqlStorageValue[]): T[] {
  return sql.exec(query, ...bindings).toArray() as T[];
}

function cutoff(now: string, days: number | undefined, name: string): string {
  if (days === undefined || !Number.isFinite(days) || days < 0)
    throw new Error(`Tracker retention needs its ${name} threshold.`);
  return new Date(Date.parse(now) - days * DAY).toISOString();
}

/** The cursor below which the change feed no longer has every event (0: nothing pruned). */
export function feedFloor(sql: SqlDatabase): number {
  return (
    rows<{ value: number }>(sql, "SELECT value FROM retention_state WHERE key = 'events_floor'")[0]
      ?.value ?? 0
  );
}

/** The tombstone of a removed issue (by id or key) or timeline (by id or slug). */
export function tombstone(
  sql: SqlDatabase,
  kind: Tombstone["kind"],
  ref: string,
): Tombstone | null {
  const row = rows<{ id: string; kind: string; ref: string; reason: string; removed_at: string }>(
    sql,
    `SELECT id, kind, ref, reason, removed_at FROM retention_removed
     WHERE kind = ? AND (id = ? OR ref = ?) LIMIT 1`,
    kind,
    ref,
    kind === "issue" ? ref.toUpperCase() : ref,
  )[0];
  return row
    ? {
        id: row.id,
        kind: row.kind as Tombstone["kind"],
        ref: row.ref,
        reason: row.reason,
        removedAt: row.removed_at,
      }
    : null;
}

/** What a 404 for a removed issue or timeline says. */
export function removedMessage(stone: Tombstone): string {
  const what = stone.kind === "issue" ? `Issue ${stone.ref}` : `Timeline ${stone.ref}`;
  return `${what} was removed by retention on ${stone.removedAt.slice(0, 10)} (${stone.reason}).`;
}

// ---- closed issues ------------------------------------------------------------

/** Issues the policy removes at `cutoff`, sorted by id. */
function removableIssues(sql: SqlDatabase, before: string): string[] {
  const candidates = new Set(
    rows<{ id: string }>(
      sql,
      `SELECT i.id FROM issues i
       WHERE json_extract(i.data, '$.status') IN ('done', 'canceled')
         AND json_extract(i.data, '$.updatedAt') < ?
         AND json_extract(i.data, '$.claim') IS NULL
         AND json_extract(i.data, '$.handoff') IS NULL
         AND json_extract(i.data, '$.doneIn') IS NULL
         AND coalesce(json_extract(i.data, '$.waiting'), 0) = 0
         AND NOT EXISTS (SELECT 1 FROM leases l WHERE l.issue_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM offers o WHERE o.issue_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM requests r
                         WHERE json_extract(r.data, '$.issueId') = i.id
                           AND json_extract(r.data, '$.status') = 'open')
         AND NOT EXISTS (SELECT 1 FROM issue_events ie JOIN events e ON e.cursor = ie.cursor
                         WHERE ie.issue_id = i.id
                           AND (json_extract(e.data, '$.createdAt') >= ?
                                OR json_extract(e.data, '$.timelineId') IN (SELECT id FROM timelines)
                                OR json_extract(e.data, '$.before.doneIn.id') IN (SELECT id FROM timelines)))`,
      before,
      before,
    ).map((row) => row.id),
  );
  // Linked, parent or child: a component goes together or stays. Ends that no
  // longer exist (removed earlier) don't hold anything back.
  const edges = rows<{ a: string; b: string }>(
    sql,
    `SELECT json_extract(l.data, '$.fromId') AS a, json_extract(l.data, '$.toId') AS b FROM links l
     WHERE EXISTS (SELECT 1 FROM issues x WHERE x.id = json_extract(l.data, '$.fromId'))
       AND EXISTS (SELECT 1 FROM issues x WHERE x.id = json_extract(l.data, '$.toId'))
     UNION ALL
     SELECT i.id AS a, json_extract(i.data, '$.parentId') AS b FROM issues i
     WHERE EXISTS (SELECT 1 FROM issues p WHERE p.id = json_extract(i.data, '$.parentId'))`,
  );
  for (let changed = true; changed;) {
    changed = false;
    for (const { a, b } of edges) {
      const [inA, inB] = [candidates.has(a), candidates.has(b)];
      if (inA === inB) continue;
      candidates.delete(inA ? a : b);
      changed = true;
    }
  }
  return [...candidates].sort();
}

/**
 * The rows that go with these issues. A link counts with its lower end (its
 * other end, if it still exists, is removable too and sorts later, in a later
 * batch or this one), so batches never count it twice.
 */
interface Footprint {
  comments: string[];
  requests: string[];
  links: string[];
  /** Links touching these issues, wherever they count. */
  touching: string[];
}

function footprint(sql: SqlDatabase, ids: string[]): Footprint {
  const list = JSON.stringify(ids);
  const ofIssue = (table: string) =>
    rows<{ id: string }>(
      sql,
      `SELECT id FROM ${table} WHERE json_extract(data, '$.issueId') IN (SELECT value FROM json_each(?))`,
      list,
    ).map((row) => row.id);
  const touching = rows<{ id: string; counted: number }>(
    sql,
    `SELECT l.id,
       (CASE WHEN json_extract(l.data, '$.fromId') IN (SELECT value FROM json_each(?))
               AND (json_extract(l.data, '$.fromId') <= json_extract(l.data, '$.toId')
                    OR NOT EXISTS (SELECT 1 FROM issues x WHERE x.id = json_extract(l.data, '$.toId')))
             THEN 1
             WHEN json_extract(l.data, '$.toId') IN (SELECT value FROM json_each(?))
               AND (json_extract(l.data, '$.toId') < json_extract(l.data, '$.fromId')
                    OR NOT EXISTS (SELECT 1 FROM issues x WHERE x.id = json_extract(l.data, '$.fromId')))
             THEN 1 ELSE 0 END) AS counted
     FROM links l
     WHERE json_extract(l.data, '$.fromId') IN (SELECT value FROM json_each(?))
        OR json_extract(l.data, '$.toId') IN (SELECT value FROM json_each(?))`,
    ...Array<string>(4).fill(list),
  );
  return {
    comments: ofIssue("comments"),
    requests: ofIssue("requests"),
    links: touching.filter((row) => row.counted).map((row) => row.id),
    touching: touching.map((row) => row.id),
  };
}

/** Records and bytes: entity rows and their events. */
function measure(
  sql: SqlDatabase,
  entities: { type: string; table: string; ids: string[] }[],
): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const { type, table, ids } of entities) {
    if (!ids.length) continue;
    const list = JSON.stringify(ids);
    const own = rows<{ n: number; size: number }>(
      sql,
      `SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS size FROM ${table}
       WHERE id IN (SELECT value FROM json_each(?))`,
      list,
    )[0]!;
    const logged = rows<{ n: number; size: number }>(
      sql,
      `SELECT count(*) AS n, coalesce(sum(length(data)), 0) AS size FROM events
       WHERE json_extract(data, '$.entityType') = ?
         AND json_extract(data, '$.entityId') IN (SELECT value FROM json_each(?))`,
      type,
      list,
    )[0]!;
    count += own.n + logged.n;
    bytes += own.size + logged.size + (own.n + logged.n) * ROW;
  }
  return { count, bytes };
}

function issueEntities(ids: string[], foot: Footprint, links: string[]) {
  return [
    { type: "issue", table: "issues", ids },
    { type: "comment", table: "comments", ids: foot.comments },
    { type: "request", table: "requests", ids: foot.requests },
    { type: "link", table: "links", ids: links },
  ];
}

export function selectClosedIssues(
  sql: SqlDatabase,
  thresholds: Record<string, number>,
  now: string,
  cursor: string | null,
  limit: number,
): TrackerSelection {
  const before = cutoff(now, thresholds.days, "days");
  const removable = removableIssues(sql, before).filter((id) => cursor === null || id > cursor);
  const items = removable.slice(0, limit);
  const foot = footprint(sql, items);
  const { count, bytes } = measure(sql, issueEntities(items, foot, foot.links));
  return {
    items,
    next: removable.length > limit ? items.at(-1)! : null,
    count,
    bytes,
  };
}

/** Log an entity's removal for replicas: a deletion like any other. */
function logRemoval(
  sql: SqlDatabase,
  entityType: string,
  entityId: string,
  operationId: string,
  at: string,
) {
  sql.exec(
    "INSERT INTO events (data) VALUES (?)",
    JSON.stringify({
      operationId,
      actorId: "gitmatrix",
      actor: { id: "gitmatrix", kind: "unknown", name: "Retention", accountable: null },
      source: "unknown",
      mutationKind: "retention.remove",
      kind: "retention.remove",
      entityType,
      entityId,
      entity: null,
      before: null,
      createdAt: at,
    }),
  );
}

export function removeClosedIssues(
  sql: SqlDatabase,
  thresholds: Record<string, number>,
  now: string,
  items: string[],
  at: string,
): TrackerRemoval {
  const before = cutoff(now, thresholds.days, "days");
  const wanted = new Set(items);
  const ids = removableIssues(sql, before).filter((id) => wanted.has(id));
  if (!ids.length) return { count: 0, bytes: 0 };
  const foot = footprint(sql, ids);
  const measured = measure(sql, issueEntities(ids, foot, foot.links));
  const list = JSON.stringify(ids);
  const entities: [string, string, string[]][] = [
    ["issue", "issues", ids],
    ["comment", "comments", foot.comments],
    ["request", "requests", foot.requests],
    ["link", "links", foot.touching],
  ];
  const keys = rows<{ id: string; key: string }>(
    sql,
    `SELECT id, json_extract(data, '$.key') AS key FROM issues
     WHERE id IN (SELECT value FROM json_each(?))`,
    list,
  );
  const reason = `done or canceled with no activity for ${thresholds.days} days`;
  const operationId = `retention:closed-issues:${now}`;
  for (const [type, table, entityIds] of entities) {
    if (!entityIds.length) continue;
    const of = JSON.stringify(entityIds);
    // Their events, and every history index row pointing at those events.
    sql.exec(
      `DELETE FROM issue_events WHERE cursor IN (
         SELECT cursor FROM events WHERE json_extract(data, '$.entityType') = ?
           AND json_extract(data, '$.entityId') IN (SELECT value FROM json_each(?)))`,
      type,
      of,
    );
    sql.exec(
      `DELETE FROM events WHERE json_extract(data, '$.entityType') = ?
         AND json_extract(data, '$.entityId') IN (SELECT value FROM json_each(?))`,
      type,
      of,
    );
    sql.exec(`DELETE FROM ${table} WHERE id IN (SELECT value FROM json_each(?))`, of);
  }
  sql.exec("DELETE FROM issue_events WHERE issue_id IN (SELECT value FROM json_each(?))", list);
  sql.exec("DELETE FROM leases WHERE issue_id IN (SELECT value FROM json_each(?))", list);
  sql.exec("DELETE FROM offers WHERE issue_id IN (SELECT value FROM json_each(?))", list);
  // Idempotency receipts that carry them (their results hold whole entities).
  // space_migration_receipt_proof and space_migration_checkpoint/records are
  // retained independently: supported pre-cutover replay still relies on the
  // original actor, request digest and result after ordinary receipts expire.
  const gone = JSON.stringify(entities.flatMap(([, , entityIds]) => entityIds));
  sql.exec(
    `DELETE FROM receipts WHERE EXISTS (
       SELECT 1 FROM json_each(receipts.result, '$.events') e
       WHERE json_extract(e.value, '$.entityId') IN (SELECT value FROM json_each(?)))`,
    gone,
  );
  for (const { id, key } of keys)
    sql.exec(
      `INSERT INTO retention_removed (id, kind, ref, reason, removed_at) VALUES (?, 'issue', ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
      id,
      key,
      reason,
      at,
    );
  for (const [type, , entityIds] of entities)
    for (const entityId of entityIds) logRemoval(sql, type, entityId, operationId, at);
  return measured;
}

// ---- activity log, receipts and ended timelines -------------------------------

/**
 * An event the activity policy removes, given its row alias `e` and the
 * cutoff bound once. Kept: open issues' history, open requests', events of a
 * timeline on record (made in it, or returning what was done in it), and the
 * newest event of anything that still exists.
 */
const PRUNABLE_EVENT = `json_extract(e.data, '$.createdAt') < ?
  AND NOT EXISTS (SELECT 1 FROM timelines t
                  WHERE t.id = json_extract(e.data, '$.timelineId')
                     OR t.id = json_extract(e.data, '$.before.doneIn.id'))
  AND NOT EXISTS (SELECT 1 FROM issue_events ie JOIN issues i ON i.id = ie.issue_id
                  WHERE ie.cursor = e.cursor
                    AND json_extract(i.data, '$.status') NOT IN ('done', 'canceled'))
  AND NOT (json_extract(e.data, '$.entityType') = 'request'
           AND EXISTS (SELECT 1 FROM requests r WHERE r.id = json_extract(e.data, '$.entityId')
                         AND json_extract(r.data, '$.status') = 'open'))
  AND NOT (
    NOT EXISTS (SELECT 1 FROM events n
                WHERE json_extract(n.data, '$.entityType') = json_extract(e.data, '$.entityType')
                  AND json_extract(n.data, '$.entityId') = json_extract(e.data, '$.entityId')
                  AND n.cursor > e.cursor)
    AND CASE json_extract(e.data, '$.entityType')
      WHEN 'issue' THEN EXISTS (SELECT 1 FROM issues x WHERE x.id = json_extract(e.data, '$.entityId'))
      WHEN 'link' THEN EXISTS (SELECT 1 FROM links x WHERE x.id = json_extract(e.data, '$.entityId'))
      WHEN 'comment' THEN EXISTS (SELECT 1 FROM comments x WHERE x.id = json_extract(e.data, '$.entityId'))
      WHEN 'request' THEN EXISTS (SELECT 1 FROM requests x WHERE x.id = json_extract(e.data, '$.entityId'))
      WHEN 'team' THEN EXISTS (SELECT 1 FROM teams x WHERE x.id = json_extract(e.data, '$.entityId'))
      WHEN 'project' THEN EXISTS (SELECT 1 FROM projects x WHERE x.id = json_extract(e.data, '$.entityId'))
      WHEN 'subscription' THEN EXISTS (SELECT 1 FROM subscriptions x WHERE x.id = json_extract(e.data, '$.entityId'))
      WHEN 'automation' THEN EXISTS (SELECT 1 FROM approval_automation x WHERE x.person_id = json_extract(e.data, '$.entityId'))
      WHEN 'timeline' THEN EXISTS (SELECT 1 FROM timelines x WHERE x.id = json_extract(e.data, '$.entityId'))
      WHEN 'timelineEvent' THEN EXISTS (SELECT 1 FROM timeline_events x WHERE x.id = json_extract(e.data, '$.entityId'))
      ELSE 0 END)`;

const PRUNABLE_RECEIPT = `json_extract(result, '$.serverTime') < ?`;

/** Timelines the policy removes at `before`, sorted by id. */
function removableTimelines(sql: SqlDatabase, before: string): string[] {
  const all = rows<{ id: string; parent: string | null; ended: number; old: number }>(
    sql,
    `SELECT id, json_extract(data, '$.parentId') AS parent,
       json_extract(data, '$.status') IN ('landed', 'abandoned') AS ended,
       coalesce(json_extract(data, '$.endedAt'), json_extract(data, '$.updatedAt')) < ? AS old
     FROM timelines`,
    before,
  );
  const pinned = new Set(
    rows<{ id: string }>(
      sql,
      `SELECT id FROM (
         SELECT json_extract(data, '$.doneIn.id') AS id FROM issues
         UNION SELECT json_extract(data, '$.claim.retainedIn.id') FROM issues
         UNION SELECT json_extract(data, '$.checkpoint.timelineId') FROM requests)
       WHERE id IS NOT NULL`,
    ).map((row) => row.id),
  );
  const removable = new Set(
    all.filter((t) => t.ended && t.old && !pinned.has(t.id)).map((t) => t.id),
  );
  // A timeline that stays keeps what its view shows: its parent, and what merged into it.
  const holds: [string, string][] = all.flatMap((t) => (t.parent ? [[t.id, t.parent]] : []));
  for (const merge of rows<{ fromId: string | null; intoId: string | null }>(
    sql,
    `SELECT json_extract(data, '$.fromId') AS fromId, json_extract(data, '$.intoId') AS intoId
     FROM timeline_events WHERE json_extract(data, '$.kind') = 'merge'`,
  ))
    if (merge.fromId && merge.intoId) holds.push([merge.intoId, merge.fromId]);
  // Source dependencies need their exact base and admission evidence even if
  // there is no parent/merge event (for example a reviewed cross-timeline sync).
  for (const dependency of rows<{ keeper: string; kept: string | null }>(
    sql,
    `SELECT t.id AS keeper, json_extract(d.value, '$.source.timelineId') AS kept
       FROM timelines t, json_each(t.data, '$.repos') r, json_each(r.value, '$.dependencies') d
     UNION SELECT t.id, json_extract(d.value, '$.base.timelineId')
       FROM timelines t, json_each(t.data, '$.repos') r, json_each(r.value, '$.dependencies') d
     UNION SELECT t.id, json_extract(r.value, '$.logicalBase.timelineId')
       FROM timelines t, json_each(t.data, '$.repos') r`,
  ))
    if (dependency.kept && dependency.kept !== dependency.keeper)
      holds.push([dependency.keeper, dependency.kept]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [keeper, kept] of holds)
      if (!removable.has(keeper) && removable.delete(kept)) changed = true;
  }
  return [...removable].sort();
}

/**
 * A timeline's own records, and the timeline events it takes with it: those
 * every listing timeline of which is removable, counted with the last of
 * them (in id order), so batches never count one twice.
 */
function timelineRecords(sql: SqlDatabase, ids: string[], removable: string[]) {
  const list = JSON.stringify(ids);
  const all = JSON.stringify(removable);
  const sizes = rows<{ n: number; size: number }>(
    sql,
    `SELECT count(*) AS n, coalesce(sum(size), 0) AS size FROM (
       SELECT length(data) AS size FROM timelines WHERE id IN (SELECT value FROM json_each(?))
       UNION ALL SELECT length(data) FROM timeline_checkpoints WHERE timeline_id IN (SELECT value FROM json_each(?))
       UNION ALL SELECT length(data) FROM timeline_landings WHERE timeline_id IN (SELECT value FROM json_each(?))
       UNION ALL SELECT length(repo_id) + coalesce(length(oid), 0) FROM timeline_heads WHERE timeline_id IN (SELECT value FROM json_each(?)))`,
    ...Array<string>(4).fill(list),
  )[0]!;
  const events = rows<{ seq: number; id: string; size: number }>(
    sql,
    `SELECT e.seq, e.id, length(e.data) AS size FROM timeline_events e
     WHERE (SELECT max(i.timeline_id) FROM timeline_event_index i WHERE i.seq = e.seq)
             IN (SELECT value FROM json_each(?))
       AND NOT EXISTS (SELECT 1 FROM timeline_event_index i WHERE i.seq = e.seq
                         AND i.timeline_id NOT IN (SELECT value FROM json_each(?)))`,
    list,
    all,
  );
  return {
    events,
    count: sizes.n + events.length,
    bytes: sizes.size + sizes.n * ROW + events.reduce((sum, event) => sum + event.size + ROW, 0),
  };
}

type Phase = "e" | "r" | "t";
const PHASES: Phase[] = ["e", "r", "t"];

function parse(cursor: string | null): [Phase, string] {
  if (cursor === null) return ["e", ""];
  const phase = cursor.slice(0, 1) as Phase;
  if (!PHASES.includes(phase) || cursor[1] !== ":")
    throw new Error(`Bad tracker-activity cursor: ${cursor}`);
  return [phase, cursor.slice(2)];
}

/** Where the phase after this one starts, or null after the last. */
function after(phase: Phase): string | null {
  const next = PHASES[PHASES.indexOf(phase) + 1];
  return next ? `${next}:` : null;
}

export function selectActivity(
  sql: SqlDatabase,
  thresholds: Record<string, number>,
  now: string,
  cursor: string | null,
  limit: number,
): TrackerSelection {
  const events = cutoff(now, thresholds.eventDays, "eventDays");
  const ended = cutoff(now, thresholds.endedTimelineDays, "endedTimelineDays");
  const [phase, position] = parse(cursor);
  if (phase === "e") {
    const found = rows<{ cursor: number; size: number }>(
      sql,
      `SELECT e.cursor, length(e.data) AS size FROM events e
       WHERE e.cursor > ? AND ${PRUNABLE_EVENT} ORDER BY e.cursor LIMIT ?`,
      Number(position || 0),
      events,
      limit + 1,
    );
    const page = found.slice(0, limit);
    return {
      items: page.map((row) => `e:${row.cursor}`),
      next: found.length > limit ? `e:${page.at(-1)!.cursor}` : after("e"),
      count: page.length,
      bytes: page.reduce((sum, row) => sum + row.size + ROW, 0),
    };
  }
  if (phase === "r") {
    const found = rows<{ id: string; size: number }>(
      sql,
      `SELECT id, length(request) + length(result) AS size FROM receipts
       WHERE id > ? AND ${PRUNABLE_RECEIPT} ORDER BY id LIMIT ?`,
      position,
      events,
      limit + 1,
    );
    const page = found.slice(0, limit);
    return {
      items: page.map((row) => `r:${row.id}`),
      next: found.length > limit ? `r:${page.at(-1)!.id}` : after("r"),
      count: page.length,
      bytes: page.reduce((sum, row) => sum + row.size + ROW, 0),
    };
  }
  const removable = removableTimelines(sql, ended);
  const remaining = removable.filter((id) => id > position);
  const ids = remaining.slice(0, limit);
  const { count, bytes } = timelineRecords(sql, ids, removable);
  return {
    items: ids.map((id) => `t:${id}`),
    next: remaining.length > limit ? `t:${ids.at(-1)!}` : null,
    count,
    bytes,
  };
}

export function removeActivity(
  sql: SqlDatabase,
  thresholds: Record<string, number>,
  now: string,
  items: string[],
  at: string,
): TrackerRemoval {
  const events = cutoff(now, thresholds.eventDays, "eventDays");
  const ended = cutoff(now, thresholds.endedTimelineDays, "endedTimelineDays");
  const of = (phase: Phase) =>
    items.filter((item) => item.startsWith(`${phase}:`)).map((item) => item.slice(2));
  let count = 0;
  let bytes = 0;
  const cursors = of("e").map(Number);
  if (cursors.length) {
    const removed = rows<{ cursor: number; size: number; at: string | null }>(
      sql,
      `DELETE FROM events AS e WHERE e.cursor IN (SELECT value FROM json_each(?)) AND ${PRUNABLE_EVENT}
       RETURNING cursor, length(data) AS size, json_extract(data, '$.createdAt') AS at`,
      JSON.stringify(cursors),
      events,
    );
    if (removed.length) {
      sql.exec(
        "DELETE FROM issue_events WHERE cursor IN (SELECT value FROM json_each(?))",
        JSON.stringify(removed.map((row) => row.cursor)),
      );
      const top = Math.max(...removed.map((row) => row.cursor));
      sql.exec(
        `INSERT INTO retention_state (key, value) VALUES ('events_floor', ?)
         ON CONFLICT (key) DO UPDATE SET value = max(value, excluded.value)`,
        top,
      );
      // And when: the Chronicle says history before then may be missing (CORE-250).
      const latest = Math.max(...removed.map((row) => Date.parse(row.at ?? "") || 0));
      if (latest > 0)
        sql.exec(
          `INSERT INTO retention_state (key, value) VALUES ('events_floor_at', ?)
           ON CONFLICT (key) DO UPDATE SET value = max(value, excluded.value)`,
          latest,
        );
    }
    count += removed.length;
    bytes += removed.reduce((sum, row) => sum + row.size + ROW, 0);
  }
  const receipts = of("r");
  if (receipts.length) {
    const removed = rows<{ size: number }>(
      sql,
      `DELETE FROM receipts WHERE id IN (SELECT value FROM json_each(?)) AND ${PRUNABLE_RECEIPT}
       RETURNING length(request) + length(result) AS size`,
      JSON.stringify(receipts),
      events,
    );
    count += removed.length;
    bytes += removed.reduce((sum, row) => sum + row.size + ROW, 0);
  }
  const wanted = new Set(of("t"));
  if (wanted.size) {
    const removable = removableTimelines(sql, ended);
    const ids = removable.filter((id) => wanted.has(id));
    if (ids.length) {
      const records = timelineRecords(sql, ids, removable);
      const list = JSON.stringify(ids);
      const slugs = rows<{ id: string; slug: string }>(
        sql,
        `SELECT id, json_extract(data, '$.slug') AS slug FROM timelines
         WHERE id IN (SELECT value FROM json_each(?))`,
        list,
      );
      const seqs = JSON.stringify(records.events.map((event) => event.seq));
      // Preserve end evidence with the minimal source ownership inventory before
      // deleting rich Tracker detail. This also upgrades pre-policy allocations.
      sql.exec(
        `UPDATE timeline_source_allocations AS a SET data = json_set(a.data,
           '$.archive_disposition', (SELECT json_extract(t.data, '$.status') FROM timelines t WHERE t.id=a.timeline_id),
           '$.archived_at', (SELECT json_extract(t.data, '$.endedAt') FROM timelines t WHERE t.id=a.timeline_id))
         WHERE a.timeline_id IN (SELECT value FROM json_each(?))
           AND json_extract(a.data, '$.archive_disposition') IS NULL
           AND json_extract(a.data, '$.state') = 'archived'
           AND EXISTS (SELECT 1 FROM timelines t WHERE t.id=a.timeline_id
             AND json_extract(t.data, '$.status') IN ('landed','abandoned')
             AND json_extract(t.data, '$.endedAt') IS NOT NULL)`,
        list,
      );
      sql.exec(
        "DELETE FROM timeline_event_index WHERE seq IN (SELECT value FROM json_each(?))",
        seqs,
      );
      sql.exec(
        "DELETE FROM timeline_event_index WHERE timeline_id IN (SELECT value FROM json_each(?))",
        list,
      );
      sql.exec("DELETE FROM timeline_events WHERE seq IN (SELECT value FROM json_each(?))", seqs);
      for (const table of ["timeline_checkpoints", "timeline_landings", "timeline_heads"])
        sql.exec(
          `DELETE FROM ${table} WHERE timeline_id IN (SELECT value FROM json_each(?))`,
          list,
        );
      sql.exec("DELETE FROM timelines WHERE id IN (SELECT value FROM json_each(?))", list);
      const reason = `landed or abandoned more than ${thresholds.endedTimelineDays} days earlier`;
      const operationId = `retention:tracker-activity:${now}`;
      for (const { id, slug } of slugs) {
        sql.exec(
          `INSERT INTO retention_removed (id, kind, ref, reason, removed_at)
           VALUES (?, 'timeline', ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
          id,
          slug,
          reason,
          at,
        );
        logRemoval(sql, "timeline", id, operationId, at);
      }
      for (const event of records.events)
        logRemoval(sql, "timelineEvent", event.id, operationId, at);
      count += records.count;
      bytes += records.bytes;
    }
  }
  return { count, bytes };
}
