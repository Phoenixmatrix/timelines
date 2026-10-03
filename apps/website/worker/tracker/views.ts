// Timeline views of the tracker (TIMELINES-RESEARCH.md, "Tracker"; CORE-73).
//
// There is one event log. Main's view is the store's tables: main's events,
// and those of landed timelines, folded in when they land (`landingOverlay`).
// A timeline's view is main's with the changes of the timeline, its ancestors
// and the timelines merged into them on top, in event order: an event made in
// a timeline records the entity as that timeline saw it (`view`), and its
// changes to the scoped fields are replayed over main's current state.
//
// Only issues, links and comments differ between views. Everything else, and
// an issue's shared fields (version, claim, assignee, waiting), is the same in
// every view: leases stay unique per issue across timelines.

import {
  TIMELINE_SCOPED_ISSUE_FIELDS,
  TIMELINE_SCOPED_TYPES,
  type EntityType,
  type TimelineScope,
  type TrackerEvent,
} from "../../shared/tracker.ts";
import type { Timeline, TimelineEvent } from "../../shared/timelines.ts";
import { all, first, json, tracker, type SqlDatabase } from "./sql.ts";

type Entity = NonNullable<TrackerEvent["entity"]>;
export type ScopedType = (typeof TIMELINE_SCOPED_TYPES)[number];

const tables = { issue: "issues", link: "links", comment: "comments" } as const;
const scopedFields = new Set<string>(TIMELINE_SCOPED_ISSUE_FIELDS);

export function isScoped(type: EntityType): type is ScopedType {
  return (TIMELINE_SCOPED_TYPES as readonly string[]).includes(type);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * An issue's scoped fields from `scoped`, and everything else from `shared`.
 * Links and comments never change once made, so only their existence differs.
 */
export function combine(type: ScopedType, scoped: Entity, shared: Entity): Entity {
  if (type !== "issue") return scoped;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scoped)) if (scopedFields.has(key)) out[key] = value;
  for (const [key, value] of Object.entries(shared)) if (!scopedFields.has(key)) out[key] = value;
  return out as unknown as Entity;
}

/**
 * Main's entity after a change made in a timeline: only shared fields move.
 * Something that exists only in timelines stays absent from main.
 */
export function mainAfter(
  type: ScopedType,
  main: Entity | null,
  view: Entity | null,
): Entity | null {
  if (!main || !view) return main;
  return combine(type, main, view);
}

/** One event's change, as its timeline saw it, replayed over a view's entity. */
function replay(
  type: ScopedType,
  current: Entity | null,
  change: NonNullable<TrackerEvent["view"]>,
): Entity | null {
  if (!change.entity) return null;
  if (!current) return structuredClone(change.entity);
  if (type !== "issue") return current;
  // A creation sets every scoped field; the shared ones stay the newest known.
  const next = { ...current } as Record<string, unknown>;
  const before = change.before as unknown as Record<string, unknown> | null;
  const after = change.entity as unknown as Record<string, unknown>;
  for (const field of scopedFields)
    if (!before || !same(before[field], after[field])) next[field] = structuredClone(after[field]);
  return next as unknown as Entity;
}

/** A view's entities that differ from main's tables: null where the view has none. */
export class Overlay {
  readonly timeline: Timeline;
  private entities = new Map<string, Entity | null>();
  constructor(timeline: Timeline) {
    this.timeline = timeline;
  }
  has(type: ScopedType, id: string): boolean {
    return this.entities.has(`${type}:${id}`);
  }
  get(type: ScopedType, id: string): Entity | null | undefined {
    return this.entities.get(`${type}:${id}`);
  }
  set(type: ScopedType, id: string, entity: Entity | null) {
    this.entities.set(`${type}:${id}`, entity && structuredClone(entity));
  }
  entries(): [ScopedType, string, Entity | null][] {
    return [...this.entities].map(([key, entity]) => {
      const at = key.indexOf(":");
      return [key.slice(0, at) as ScopedType, key.slice(at + 1), entity];
    });
  }
  /** Main's rows of a type with this view's differences applied, by id. */
  merge<T extends { id: string }>(type: ScopedType, rows: T[]): T[] {
    const out = new Map(rows.map((row) => [row.id, row]));
    for (const [kind, id, entity] of this.entries()) {
      if (kind !== type) continue;
      // Callers change what they read in place: never hand out the overlay's own copy.
      if (entity) out.set(id, structuredClone(entity) as unknown as T);
      else out.delete(id);
    }
    return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  scope(): TimelineScope {
    const { id, slug, name, status } = this.timeline;
    return { id, slug, name, status };
  }
}

/** A timeline by slug or id. */
export function findTimeline(sql: SqlDatabase, ref: string): Timeline | null {
  const row = first(
    sql,
    tracker
      .selectFrom("timelines")
      .select("data")
      .where((eb) => eb.or([eb("id", "=", ref), eb(json("data", "$.slug"), "=", ref)])),
  );
  return row ? (JSON.parse(row.data) as Timeline) : null;
}

/**
 * The timelines whose tracker changes a timeline's view shows: itself, its
 * ancestors, and the timelines merged into any of those. A landed timeline's
 * changes are already main's, so it adds nothing, unless it is the one being
 * landed.
 */
export function viewTimelines(sql: SqlDatabase, root: Timeline, landing = false): string[] {
  const timelines = new Map(
    all(sql, tracker.selectFrom("timelines").select("data")).map((row) => {
      const timeline = JSON.parse(row.data) as Timeline;
      return [timeline.id, timeline];
    }),
  );
  const mergedInto = new Map<string, string[]>();
  for (const row of all(
    sql,
    tracker
      .selectFrom("timeline_events")
      .select("data")
      .where(json("data", "$.kind"), "=", "merge"),
  )) {
    const merge = JSON.parse(row.data) as Extract<TimelineEvent, { kind: "merge" }>;
    if (merge.intoId && merge.fromId)
      mergedInto.set(merge.intoId, [...(mergedInto.get(merge.intoId) ?? []), merge.fromId]);
  }
  const out: string[] = [];
  const queue = [root.id];
  while (queue.length) {
    const id = queue.shift()!;
    const timeline = timelines.get(id);
    if (!timeline || out.includes(id)) continue;
    if (timeline.status === "landed" && !(landing && id === root.id)) continue;
    out.push(id);
    if (timeline.parentId) queue.push(timeline.parentId);
    queue.push(...(mergedInto.get(id) ?? []));
  }
  return out;
}

function mainRow(sql: SqlDatabase, type: ScopedType, id: string): Entity | null {
  const row = first(sql, tracker.selectFrom(tables[type]).select("data").where("id", "=", id));
  return row ? (JSON.parse(row.data) as Entity) : null;
}

/** The newest state any view has of an entity's shared fields: its latest event, in any timeline. */
export function latestEntity(sql: SqlDatabase, type: ScopedType, id: string): Entity | null {
  const row = first(
    sql,
    tracker
      .selectFrom("events")
      .select("data")
      .where(json("data", "$.entityId"), "=", id)
      .where(json("data", "$.entityType"), "=", type)
      .orderBy("cursor", "desc")
      .limit(1),
  );
  if (!row) return null;
  const event = JSON.parse(row.data) as TrackerEvent;
  return event.entity ?? event.view?.entity ?? null;
}

/** A timeline's view, as differences from main's tables. */
export function overlayOf(sql: SqlDatabase, timeline: Timeline, landing = false): Overlay {
  const overlay = new Overlay(timeline);
  const ids = viewTimelines(sql, timeline, landing);
  if (!ids.length) return overlay;
  const rows = all(
    sql,
    tracker
      .selectFrom("events")
      .select("data")
      .where(json("data", "$.timelineId"), "in", ids)
      .orderBy("cursor"),
  );
  const fromMain = new Set<string>();
  for (const row of rows) {
    const event = JSON.parse(row.data) as TrackerEvent;
    if (!event.view || !isScoped(event.entityType)) continue;
    const type = event.entityType;
    let current: Entity | null | undefined = overlay.get(type, event.entityId);
    if (current === undefined) {
      current = mainRow(sql, type, event.entityId);
      if (current) fromMain.add(`${type}:${event.entityId}`);
    }
    overlay.set(type, event.entityId, replay(type, current, event.view));
  }
  // Something only timelines have: its shared fields are wherever it last changed.
  for (const [type, id, entity] of overlay.entries()) {
    if (!entity || fromMain.has(`${type}:${id}`)) continue;
    const latest = latestEntity(sql, type, id);
    if (latest) overlay.set(type, id, combine(type, entity, latest));
  }
  return overlay;
}
