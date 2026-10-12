import { describe, expect, it } from "vite-plus/test";
import type { Issue, MutationResult, Snapshot, TrackerEvent } from "../../../shared/tracker.ts";
import { acknowledge } from "./snapshot.ts";

const now = "2026-10-03T12:00:00Z";
const issue = (id: string, fields: Partial<Issue> = {}): Issue => ({
  id,
  key: `CORE-${id}`,
  title: id,
  description: "Original description",
  acceptance: "",
  version: 1,
  createdAt: now,
  updatedAt: now,
  teamId: "core",
  type: "task",
  status: "todo",
  priority: 2,
  assigneeId: null,
  parentId: null,
  workspaceIds: [],
  labels: [],
  claim: null,
  ...fields,
});
const snapshot = (issues: Issue[]): Snapshot => ({
  owner: { id: "owner", slug: "owner", displayName: "Owner" },
  canAdmin: true,
  members: [],
  agents: [],
  teams: [],
  workspaces: [],
  labels: [],
  issues,
  links: [],
  comments: [],
  requests: [],
  subscriptions: [],
  cursor: 10,
  serverTime: now,
});
const event = (
  cursor: number,
  entityId: string,
  entity: TrackerEvent["entity"],
  fields: Partial<TrackerEvent> = {},
): TrackerEvent => ({
  cursor,
  operationId: "save",
  actorId: "person",
  kind: "issue.update",
  entityType: "issue",
  entityId,
  entity,
  createdAt: now,
  ...fields,
});
const result = (events: TrackerEvent[]): MutationResult => ({
  cursor: events.at(-1)!.cursor,
  events,
  results: [],
  serverTime: "2026-10-03T12:00:01Z",
});

describe("committed mutation acknowledgements", () => {
  it("keeps definitions after removal and learns tags from timeline-only events on main", () => {
    const before = snapshot([]);
    before.labels = ["existing"];
    const next = acknowledge(
      before,
      result([
        event(11, "1", null, { view: { before: null, entity: issue("1", { labels: ["new"] }) } }),
        event(12, "1", null, { view: { before: null, entity: issue("1", { labels: [] }) } }),
      ]),
    );
    expect(next.labels).toEqual(["existing", "new"]);
    expect(next.issues).toEqual([]);
    expect(before.labels).toEqual(["existing"]);
  });
  it("applies a batch's final issue state without losing unrelated issues or mutating the prior view", () => {
    const before = snapshot([issue("1"), issue("2")]);
    const saved = issue("1", { version: 2, description: "Server-confirmed description" });
    const next = acknowledge(
      before,
      result([
        event(11, "1", saved),
        event(12, "3", issue("3"), { kind: "issue.create" }),
        event(13, "3", null, { kind: "issue.delete" }),
        event(14, "1", { ...saved, version: 3, status: "in_progress" }),
      ]),
    );
    expect(next.issues).toEqual([{ ...saved, version: 3, status: "in_progress" }, issue("2")]);
    expect(next.cursor).toBe(14);
    expect(before.issues[0]!.description).toBe("Original description");
    expect(before.cursor).toBe(10);
  });

  it("does not roll back a newer snapshot when an old receipt arrives late or is retried", () => {
    const fresh = snapshot([
      issue("1", { version: 4, description: "Another writer's newer edit" }),
    ]);
    fresh.cursor = 15;
    const receipt = result([event(11, "1", issue("1", { version: 2, description: "Older save" }))]);
    expect(acknowledge(fresh, receipt).issues[0]).toEqual(fresh.issues[0]);
    expect(acknowledge(fresh, receipt).cursor).toBe(15);
  });

  it("applies timeline-local entities, including an issue that does not exist on main", () => {
    const before = snapshot([]);
    before.timeline = { id: "timeline", slug: "work", name: "Work", status: "active" };
    const created = issue("1", { status: "in_progress" });
    const receipt = result([
      event(11, "1", null, {
        kind: "issue.create",
        timelineId: "timeline",
        view: { before: null, entity: created },
      }),
    ]);
    expect(acknowledge(before, receipt).issues).toEqual([created]);
    expect(acknowledge(snapshot([]), receipt).issues).toEqual([]);
  });

  it("removes a timeline-local entity without resurrecting its surviving main version", () => {
    const main = issue("1");
    const before = snapshot([main]);
    before.timeline = { id: "timeline", slug: "work", name: "Work", status: "active" };
    const receipt = result([
      event(11, "1", main, {
        kind: "issue.delete",
        timelineId: "timeline",
        view: { before: main, entity: null },
      }),
    ]);
    expect(acknowledge(before, receipt).issues).toEqual([]);
    expect(acknowledge(snapshot([main]), receipt).issues).toEqual([main]);
  });
});

describe("approve-when-green (CORE-378)", () => {
  it("follows the setting's own events, without a refresh", () => {
    const setting = (cursor: number, id: string, on: boolean) =>
      event(
        cursor,
        id,
        { id, approveWhenGreen: on, enabledAt: on ? now : null },
        { entityType: "automation", kind: "automation.approveWhenGreen" },
      );
    const before = { ...snapshot([]), approveWhenGreen: ["ann"] };
    const on = acknowledge(before, result([setting(11, "ben", true)]));
    expect(on.approveWhenGreen).toEqual(["ann", "ben"]);
    expect(acknowledge(on, result([setting(12, "ann", false)])).approveWhenGreen).toEqual(["ben"]);
    // Already seen: nothing changes.
    expect(acknowledge(on, result([setting(9, "ben", false)]))).toBe(on);
  });
});
