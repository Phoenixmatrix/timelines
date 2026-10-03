import type {
  EntityType,
  MutationResult,
  Snapshot,
  TrackerEvent,
} from "../../../shared/tracker.ts";

function updated<T extends NonNullable<TrackerEvent["entity"]>>(
  current: T[],
  type: EntityType,
  events: TrackerEvent[],
  cursor: number,
  timeline: boolean,
): T[] {
  let changes: Map<string, TrackerEvent["entity"]> | undefined;
  for (const event of events) {
    if (event.entityType !== type || event.cursor <= cursor) continue;
    changes ??= new Map();
    changes.set(event.entityId, timeline && event.view ? event.view.entity : event.entity);
  }
  if (!changes) return current;
  const next: T[] = [];
  for (const entity of current) {
    if (!changes.has(entity.id)) next.push(entity);
    else {
      const replacement = changes.get(entity.id);
      if (replacement) next.push(replacement as T);
      changes.delete(entity.id);
    }
  }
  for (const entity of changes.values()) {
    if (entity) next.push(entity as T);
  }
  return next;
}

/**
 * Show the server's committed entities without waiting for another round trip.
 * A full refresh still reconciles other writers and membership changes. Its
 * cursor must include this acknowledgement; an older in-flight read cannot
 * overwrite it. Conversely, a newer snapshot already includes this result.
 */
export function acknowledge(snapshot: Snapshot, result: MutationResult): Snapshot {
  if (result.cursor <= snapshot.cursor) return snapshot;
  const apply = <T extends NonNullable<TrackerEvent["entity"]>>(current: T[], type: EntityType) =>
    updated(current, type, result.events, snapshot.cursor, !!snapshot.timeline);
  return {
    ...snapshot,
    teams: apply(snapshot.teams, "team"),
    workspaces: apply(snapshot.workspaces, "workspace"),
    issues: apply(snapshot.issues, "issue"),
    links: apply(snapshot.links, "link"),
    comments: apply(snapshot.comments, "comment"),
    requests: apply(snapshot.requests, "request"),
    subscriptions: apply(snapshot.subscriptions, "subscription"),
    cursor: result.cursor,
    serverTime: result.serverTime,
  };
}
