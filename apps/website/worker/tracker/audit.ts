import type {
  AuditActor,
  Issue,
  IssueAuditEvent,
  IssueHistory,
  TrackerEvent,
} from "../../shared/tracker.ts";
import { all, first, json, run, tracker, type SqlDatabase } from "./sql.ts";
import type { Access } from "./store.ts";

export function auditActor(access: Access, id = access.actorId): AuditActor {
  const agent = access.agents.find((candidate) => candidate.id === id);
  if (agent) return { id, kind: "agent", name: agent.name, accountable: agent.accountable };
  const person = access.members.find((candidate) => candidate.id === id);
  return {
    id,
    kind: person ? "person" : "unknown",
    name: person?.displayName ?? null,
    accountable: null,
  };
}

/** The event log remains the authority; this table only indexes affected tickets. */
export function initializeAudit(sql: SqlDatabase, transaction: <T>(fn: () => T) => T) {
  sql.exec(`CREATE TABLE IF NOT EXISTS issue_events (
    issue_id TEXT NOT NULL, cursor INTEGER NOT NULL, PRIMARY KEY (issue_id, cursor));
    CREATE TABLE IF NOT EXISTS tracker_migrations (name TEXT PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS event_entity_history ON events(
      json_extract(data, '$.entityType'), json_extract(data, '$.entityId'), cursor);`);
  if (
    first(
      sql,
      tracker.selectFrom("tracker_migrations").select("name").where("name", "=", "issue-audit-v1"),
    )
  )
    return;
  transaction(() => {
    // Recover removed links and both sides of parent moves from the preceding
    // state, not today's links/issues. No historical actor or source is invented.
    sql.exec(`WITH history AS (
      SELECT cursor, data, lag(data) OVER (
        PARTITION BY json_extract(data, '$.entityType'), json_extract(data, '$.entityId')
        ORDER BY cursor
      ) AS previous FROM events
    )
    INSERT OR IGNORE INTO issue_events(issue_id, cursor)
    SELECT affected.value, h.cursor FROM history h, json_each(
      CASE json_extract(h.data, '$.entityType')
        WHEN 'issue' THEN json_array(
          json_extract(h.data, '$.entityId'),
          CASE WHEN json_extract(h.data, '$.entity.parentId') IS NOT json_extract(h.previous, '$.entity.parentId')
            THEN json_extract(h.data, '$.entity.parentId') END,
          CASE WHEN json_extract(h.data, '$.entity.parentId') IS NOT json_extract(h.previous, '$.entity.parentId')
            THEN json_extract(h.previous, '$.entity.parentId') END)
        WHEN 'link' THEN json_array(
          coalesce(json_extract(h.data, '$.entity.fromId'), json_extract(h.previous, '$.entity.fromId')),
          coalesce(json_extract(h.data, '$.entity.toId'), json_extract(h.previous, '$.entity.toId')))
        WHEN 'comment' THEN json_array(json_extract(h.data, '$.entity.issueId'))
        WHEN 'request' THEN json_array(json_extract(h.data, '$.entity.issueId'))
        ELSE '[]' END
    ) affected WHERE affected.value IS NOT NULL`);
    sql.exec(`UPDATE issues SET data = json_set(data, '$.createdBy', json(coalesce((
      SELECT coalesce(json_extract(e.data, '$.actor'), json_object(
        'id', json_extract(e.data, '$.actorId'), 'kind', 'unknown', 'name', NULL, 'accountable', NULL))
      FROM events e WHERE json_extract(e.data, '$.entityType') = 'issue'
        AND json_extract(e.data, '$.entityId') = issues.id
        AND json_extract(e.data, '$.kind') = 'issue.create'
      ORDER BY e.cursor LIMIT 1
    ), 'null'))) WHERE json_type(data, '$.createdBy') IS NULL`);
    run(sql, tracker.insertInto("tracker_migrations").values({ name: "issue-audit-v1" }));
  });
}

export function indexAuditEvent(sql: SqlDatabase, event: IssueAuditEvent) {
  const ids = new Set<string>();
  // A change made in a timeline is about what that timeline saw.
  const { before: seen, entity: made } = event.view ?? event;
  if (event.entityType === "issue") {
    ids.add(event.entityId);
    const before = seen as Issue | null;
    const after = made as Issue | null;
    if (before?.parentId !== after?.parentId) {
      if (before?.parentId) ids.add(before.parentId);
      if (after?.parentId) ids.add(after.parentId);
    }
  } else {
    for (const entity of [seen, made]) {
      if (!entity) continue;
      if ("issueId" in entity) ids.add(entity.issueId);
      if ("fromId" in entity) {
        ids.add(entity.fromId);
        ids.add(entity.toId);
      }
    }
  }
  if (ids.size)
    run(
      sql,
      tracker
        .insertInto("issue_events")
        .values([...ids].map((issue_id) => ({ issue_id, cursor: event.cursor }))),
    );
}

export function issueHistory(
  sql: SqlDatabase,
  access: Access,
  issue: Issue,
  before: number | null,
  limit: number,
): IssueHistory {
  let query = tracker
    .selectFrom("issue_events as i")
    .innerJoin("events as e", "e.cursor", "i.cursor")
    .select(["e.cursor", "e.data"])
    .where("i.issue_id", "=", issue.id);
  if (before !== null) query = query.where("i.cursor", "<", before);
  const rows = all(sql, query.orderBy("i.cursor", "desc").limit(limit + 1));
  const events = rows.slice(0, limit).map((row): IssueAuditEvent => {
    const logged = JSON.parse(row.data) as TrackerEvent;
    // In a timeline, history shows the change as the timeline saw it.
    const event = logged.view
      ? { ...logged, before: logged.view.before, entity: logged.view.entity }
      : logged;
    let previous = event.before;
    if (previous === undefined) {
      const prior = first(
        sql,
        tracker
          .selectFrom("events")
          .select("data")
          .where(json("data", "$.entityType"), "=", event.entityType)
          .where(json("data", "$.entityId"), "=", event.entityId)
          .where("cursor", "<", row.cursor)
          .orderBy("cursor", "desc")
          .limit(1),
      );
      previous = prior ? (JSON.parse(prior.data) as TrackerEvent).entity : null;
    }
    return {
      ...event,
      cursor: row.cursor,
      before: previous,
      actor: event.actor ?? auditActor(access, event.actorId),
      source: event.source ?? "unknown",
      mutationKind: event.mutationKind ?? event.kind,
    };
  });
  const creator = issue.createdBy;
  return {
    issueId: issue.id,
    creator: creator?.name ? creator : creator ? auditActor(access, creator.id) : null,
    events,
    hasMore: rows.length > limit,
    nextBefore: rows.length > limit ? events.at(-1)!.cursor : null,
  };
}
